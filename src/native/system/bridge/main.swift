// The system bridge: the process Switchboard's main process starts to reach
// the system helper, the same way it starts app-events. It lives in
// Contents/MacOS so Bundle.main is the app and SMAppService finds the
// helper's plist there.
//
// It speaks JSON lines on stdin and stdout: each request carries an `id`,
// and its reply carries the same id. Fan readings, the sleep setting, the
// battery and whether there is a lid need no root, so they come straight
// from the bridge and the window can show them before the helper is
// installed. Holds go through the helper: a fan boost and a lid-closed sleep
// hold. While either is held, the bridge sends a heartbeat every second;
// when stdin closes (Switchboard quit or crashed) the bridge exits, the
// connection ends, and the helper gives both back to macOS.
import Foundation
import ServiceManagement

let output = DispatchQueue(label: "output")
func send(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
  output.sync { FileHandle.standardOutput.write(data + Data("\n".utf8)) }
}
func object(_ data: Data) -> [String: Any] {
  (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
}

let team = ownSigningTeam()
let service = SMAppService.daemon(plistName: SystemNames.plist)
let smc = try? SMC()
let temperature = smc.map(CPUTemperature.init)

// A plist that has never been registered also reads as notFound, so only a
// bundle without the plist (a checkout run) is "not packaged".
let packaged = FileManager.default.fileExists(
  atPath: Bundle.main.bundleURL.appendingPathComponent("Contents/Library/LaunchDaemons/\(SystemNames.plist)").path)

func serviceName() -> String {
  switch service.status {
  case .notRegistered: return "not-installed"
  case .enabled: return "installed"
  case .requiresApproval: return "needs-approval"
  case .notFound: return packaged ? "not-installed" : "not-packaged"
  @unknown default: return "unknown"
  }
}

/// The helper connection, made on first use and dropped once the helper is
/// no longer holding a speed, so the idle helper can exit.
final class Helper {
  private var connection: NSXPCConnection?
  private var holding = false
  private let lock = NSLock()

  private func proxy(_ failed: @escaping (Error) -> Void) -> SystemHelperProtocol? {
    lock.lock()
    defer { lock.unlock() }
    guard let team else { return nil }
    if connection == nil {
      let next = NSXPCConnection(machServiceName: SystemNames.helper, options: .privileged)
      next.remoteObjectInterface = NSXPCInterface(with: SystemHelperProtocol.self)
      // Talk only to our own helper, never to something squatting on the name.
      next.setCodeSigningRequirement(SystemNames.requirement(identifier: SystemNames.helper, team: team))
      next.interruptionHandler = { [weak self] in self?.lost() }
      next.invalidationHandler = { [weak self] in self?.lost() }
      next.resume()
      connection = next
    }
    return connection?.remoteObjectProxyWithErrorHandler(failed) as? SystemHelperProtocol
  }

  private func lost() {
    lock.lock()
    let wasHolding = holding
    connection = nil
    holding = false
    lock.unlock()
    if wasHolding { send(["event": "helper-lost"]) }
  }

  /// One round trip, bounded, failing fast when the helper can't be reached.
  func call(_ body: (SystemHelperProtocol, @escaping (Data) -> Void) -> Void) -> [String: Any] {
    let done = DispatchSemaphore(value: 0)
    var result: [String: Any] = ["error": "helper-unavailable"]
    let finish: ([String: Any]) -> Void = { value in
      result = value
      done.signal()
    }
    guard let helper = proxy({ _ in finish(["error": "helper-unavailable"]) }) else {
      return ["error": "unsigned"]
    }
    body(helper) { data in finish(object(data)) }
    if done.wait(timeout: .now() + 20) == .timedOut { return ["error": "helper-timeout"] }
    track(result)
    return result
  }

  private func track(_ status: [String: Any]) {
    guard status["error"] as? String != "helper-unavailable" else { return }
    lock.lock()
    let awake = status["awake"] as? [String: Any]
    holding = (status["controlling"] as? Bool ?? false) || (awake?["held"] as? Bool ?? false)
    let drop = !holding ? connection : nil
    if drop != nil { connection = nil }
    lock.unlock()
    drop?.invalidate()
  }

  func beat() {
    lock.lock()
    let active = holding
    lock.unlock()
    guard active else { return }
    let status = call { helper, reply in helper.heartbeat(reply: reply) }
    // A hold the helper ended on its own: say so, so the app asks why.
    let awake = status["awake"] as? [String: Any]
    if status["controlling"] as? Bool == false || awake?["held"] as? Bool == false {
      send(["event": "status"])
    }
  }
}

let helper = Helper()
let beats = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "heartbeat"))
beats.schedule(deadline: .now() + 1, repeating: 1, leeway: .milliseconds(100))
beats.setEventHandler { helper.beat() }
beats.resume()

func readings() -> [String: Any] {
  let fans = (try? smc?.readings()) ?? []
  var result: [String: Any] = ["fans": (try? JSONSerialization.jsonObject(with: encode(fans))) ?? []]
  if let value = temperature?.hottest() { result["temperature"] = value }
  return result
}

func handle(_ request: [String: Any]) -> [String: Any] {
  switch request["op"] as? String {
  case "state":
    var reply = readings()
    reply["helper"] = team == nil ? "unsigned" : serviceName()
    reply["lid"] = hasLid()
    reply["sleepDisabled"] = sleepDisabled()
    if let power = battery() { reply["battery"] = ["percent": power.percent, "onBattery": power.onBattery] }
    return reply
  case "install":
    do { try service.register() } catch {
      // Error 1 is the expected first answer: macOS wants approval in
      // Login Items. The state that follows says so.
      let code = (error as NSError).code
      if service.status != .requiresApproval { return ["error": "install-failed", "code": code] }
    }
    return ["helper": serviceName()]
  case "remove":
    do { try service.unregister() } catch { return ["error": "remove-failed"] }
    return ["helper": serviceName()]
  case "open-login-items":
    SMAppService.openSystemSettingsLoginItems()
    return [:]
  case "status":
    return helper.call { helper, reply in helper.status(reply: reply) }
  case "set":
    guard let level = request["level"] as? Int, let seconds = request["seconds"] as? Int else {
      return ["error": "invalid-request"]
    }
    return helper.call { helper, reply in helper.setLevel(level, seconds: seconds, reply: reply) }
  case "system":
    return helper.call { helper, reply in helper.restoreSystem(reply: reply) }
  case "awake-hold":
    guard let seconds = request["seconds"] as? Int else { return ["error": "invalid-request"] }
    return helper.call { helper, reply in helper.holdAwake(seconds: seconds, reply: reply) }
  case "awake-release":
    return helper.call { helper, reply in helper.releaseAwake(reply: reply) }
  case "sleep-clear":
    return helper.call { helper, reply in helper.clearSleepDisabled(reply: reply) }
  default:
    return ["error": "invalid-request"]
  }
}

if CommandLine.arguments.dropFirst().first == "probe" {
  send(handle(["op": "state"]))
  exit(0)
}

while let line = readLine() {
  let request = object(Data(line.utf8))
  var reply = handle(request)
  reply["id"] = request["id"] ?? NSNull()
  send(reply)
}
exit(0)
