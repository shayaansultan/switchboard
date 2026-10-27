// The fan helper: the one piece of fan control that runs as root, because
// only root may write the SMC. macOS installs it from inside the app with
// SMAppService, and launchd starts it at boot and whenever the fan bridge
// connects. It accepts only the bridge signed by its own team, and only a
// level in 5% steps or System.
//
// Manual control is meant to be a short boost, so the helper hands the fans
// back to macOS whenever there is any doubt, matching what Vorssaint does:
// the bridge disconnects (Switchboard quit or crashed), heartbeats stop for
// 7 s (Switchboard hung), the time limit ends, the Mac goes to sleep, macOS
// takes the fans back itself (three failed checks in a row; the helper never
// fights it), the Mac reports serious thermal pressure, or launchd stops the
// helper (restart, shutdown, update). On start it hands back any fan it
// finds in manual mode, so a crash or a restart always ends on System.
import Foundation
import IOKit
import IOKit.pwr_mgt
import os

let log = Logger(subsystem: FanNames.helper, category: "fans")

final class Controller {
  private let smc: SMC
  private let temperature: CPUTemperature
  private(set) var level: Int?
  private var owner: ObjectIdentifier?
  private var endsAt: TimeInterval?
  private var targets: [Double] = []
  private var lastHeartbeat: TimeInterval = 0
  private var misses = 0
  private(set) var stop: String?
  /// What went wrong in the last failed set, for `switchboard fans status`.
  private(set) var detail: String?
  var connections = 0
  private var idleSince = uptime()

  init(smc: SMC) {
    self.smc = smc
    temperature = CPUTemperature(smc: smc)
  }

  static func uptime() -> TimeInterval { ProcessInfo.processInfo.systemUptime }
  private func uptime() -> TimeInterval { Controller.uptime() }

  func status(error: String? = nil) -> FanStatus {
    let fans = (try? smc.readings()) ?? []
    return FanStatus(
      fans: fans, temperature: temperature.hottest(), controlling: level != nil, level: level,
      endsIn: endsAt.map { max(0, Int(($0 - uptime()).rounded(.up))) }, stop: stop, error: error,
      detail: detail)
  }

  func heartbeat(from session: ObjectIdentifier) {
    if owner == session { lastHeartbeat = uptime() }
  }

  /// Nil on success, else the reason it was refused.
  func set(level newLevel: Int, seconds: Int, session: ObjectIdentifier) -> String? {
    guard validLevel(newLevel), (0...86_400).contains(seconds) else { return "invalid-request" }
    if let owner, owner != session { return "already-controlled" }
    do {
      let fans = try smc.readings()
      guard !fans.isEmpty else { return "no-fans" }
      // Fans already in manual mode with no session of ours belong to
      // another app. Two controllers would fight, so leave them alone.
      if level == nil, fans.contains(where: { $0.manual }) { return "already-controlled" }
      targets = try apply(newLevel, fans: fans)
      level = newLevel
      owner = session
      endsAt = seconds > 0 ? uptime() + TimeInterval(seconds) : nil
      lastHeartbeat = uptime()
      misses = 0
      stop = nil
      detail = nil
      log.info("manual \(newLevel)% for \(seconds) s")
      return nil
    } catch {
      detail = String(describing: error)
      log.error("set failed: \(String(describing: error), privacy: .public)")
      restore(reason: "control-failed")
      return "control-failed"
    }
  }

  // Mode and target go in back to back: the thermal controller can take
  // automatic mode back between two separate writes. A fan that refuses
  // manual mode (a stopped fan on Apple silicon) gets the Ftst unlock and a
  // protective maximum first, then the requested level.
  private func apply(_ level: Int, fans: [FanReading]) throws -> [Double] {
    let targets = fans.map { targetRPM(minimum: $0.minimum, maximum: $0.maximum, level: level) }
    for (index, target) in targets.enumerated() {
      if let mode = smc.modeKey(index) { try? smc.writeNumber(mode, 1) }
      try? smc.writeNumber("F\(index)Tg", target)
    }
    Thread.sleep(forTimeInterval: 0.25)
    if try smc.readings().allSatisfy({ $0.manual }), settle(targets) { return targets }

    guard smc.exists("Ftst") else { throw SMCError.call("manual mode refused, no Ftst") }
    log.info("manual mode refused; using the Ftst unlock")
    try retry(20) { try self.smc.writeNumber("Ftst", 1) }
    for (index, fan) in fans.enumerated() {
      try retry(10) { try self.smc.writeNumber("F\(index)Tg", fan.maximum) }
    }
    Thread.sleep(forTimeInterval: 3)
    let deadline = uptime() + 10
    for index in fans.indices {
      guard let mode = smc.modeKey(index) else { continue }
      while (try? smc.readNumber(mode)) != 1 {
        guard uptime() < deadline else { throw SMCError.call("fan \(index) refused manual mode") }
        try? smc.writeNumber(mode, 1)
        Thread.sleep(forTimeInterval: 0.2)
      }
    }
    for (index, target) in targets.enumerated() where !hold(index, at: target) {
      throw SMCError.call("fan \(index) did not take \(Int(target)) rpm after the unlock")
    }
    guard settle(targets) else { throw SMCError.call("fans left the requested speed after the unlock") }
    return targets
  }

  /// Writes mode and target together until both read back, up to ten times:
  /// a fan that has just been unlocked can drop either for a moment.
  private func hold(_ index: Int, at target: Double) -> Bool {
    guard let mode = smc.modeKey(index) else { return false }
    for attempt in 0..<10 {
      try? smc.writeNumber(mode, 1)
      try? smc.writeNumber("F\(index)Tg", target)
      if (try? smc.readNumber(mode)) == 1, let read = try? smc.readNumber("F\(index)Tg"), abs(read - target) <= 2 {
        return true
      }
      if attempt < 9 { Thread.sleep(forTimeInterval: 0.05) }
    }
    return false
  }

  /// True once every fan reads manual at its target, checked up to ten times.
  private func settle(_ targets: [Double]) -> Bool {
    for attempt in 0..<10 {
      if intact(targets) { return true }
      if attempt < 9 { Thread.sleep(forTimeInterval: 0.05) }
    }
    return false
  }

  private func intact(_ targets: [Double]) -> Bool {
    guard let fans = try? smc.readings(), fans.count == targets.count else { return false }
    return zip(fans, targets).allSatisfy { fan, target in fan.manual && abs(fan.target - target) <= 2 }
  }

  private func retry(_ attempts: Int, _ body: () throws -> Void) throws {
    var lastError: Error?
    for _ in 0..<attempts {
      do { return try body() } catch {
        lastError = error
        Thread.sleep(forTimeInterval: 0.1)
      }
    }
    throw lastError ?? SMCError.call("retry")
  }

  /// Hands every fan back to macOS. `reason` is nil when someone asked for
  /// System; otherwise it is reported once, so the app can say why.
  @discardableResult
  func restore(reason: String?) -> Bool {
    let count = (try? smc.fanCount()) ?? 0
    for index in 0..<count {
      guard let mode = smc.modeKey(index) else { continue }
      for _ in 0..<20 {
        try? smc.writeNumber(mode, 0)
        if (try? smc.readNumber(mode)) == 0 { break }
        Thread.sleep(forTimeInterval: 0.1)
      }
    }
    if smc.exists("Ftst") {
      for _ in 0..<20 {
        try? smc.writeNumber("Ftst", 0)
        if (try? smc.readNumber("Ftst")) == 0 { break }
        Thread.sleep(forTimeInterval: 0.1)
      }
    }
    let automatic = ((try? smc.readings()) ?? []).allSatisfy { !$0.manual }
    if level != nil || reason == "recovery" { stop = reason }
    level = nil
    owner = nil
    endsAt = nil
    targets = []
    idleSince = uptime()
    log.info("System (\(reason ?? "asked", privacy: .public)) automatic=\(automatic)")
    return automatic
  }

  func disconnected(_ session: ObjectIdentifier) {
    connections = max(0, connections - 1)
    if connections == 0 { idleSince = uptime() }
    if owner == session { restore(reason: "app-closed") }
  }

  func handBackIfManual(reason: String) {
    if level != nil || ((try? smc.readings()) ?? []).contains(where: { $0.manual }) {
      restore(reason: reason)
    }
  }

  // Runs every second.
  func tick() {
    guard level != nil else {
      // Nothing to watch and nobody connected: launchd starts us again on
      // the next connection, so there is no reason to stay resident.
      if connections == 0, uptime() - idleSince > 60 {
        log.info("idle; exiting")
        exit(0)
      }
      return
    }
    let thermal = ProcessInfo.processInfo.thermalState
    misses = intact(targets) ? 0 : misses + 1
    if let endsAt, uptime() >= endsAt {
      restore(reason: "time-limit")
    } else if uptime() - lastHeartbeat > FanNames.heartbeatLimit {
      restore(reason: "heartbeat-lost")
    } else if thermal == .serious || thermal == .critical {
      restore(reason: "thermal-pressure")
    } else if misses >= FanNames.takeoverLimit {
      restore(reason: "system-took-over")
    }
  }
}

final class Session: NSObject, FanHelperProtocol {
  let controller: Controller
  init(controller: Controller) { self.controller = controller }
  var id: ObjectIdentifier { ObjectIdentifier(self) }

  func status(reply: @escaping (Data) -> Void) {
    DispatchQueue.main.async { reply(encode(self.controller.status())) }
  }
  func setLevel(_ level: Int, seconds: Int, reply: @escaping (Data) -> Void) {
    DispatchQueue.main.async {
      let refused = self.controller.set(level: level, seconds: seconds, session: self.id)
      reply(encode(self.controller.status(error: refused)))
    }
  }
  func restoreSystem(reply: @escaping (Data) -> Void) {
    DispatchQueue.main.async {
      if self.controller.level != nil { self.controller.restore(reason: nil) }
      reply(encode(self.controller.status()))
    }
  }
  func heartbeat(reply: @escaping (Data) -> Void) {
    DispatchQueue.main.async {
      self.controller.heartbeat(from: self.id)
      reply(encode(self.controller.status()))
    }
  }
}

final class Listener: NSObject, NSXPCListenerDelegate {
  let controller: Controller
  init(controller: Controller) { self.controller = controller }

  func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
    let session = Session(controller: controller)
    let id = session.id
    connection.exportedInterface = NSXPCInterface(with: FanHelperProtocol.self)
    connection.exportedObject = session
    connection.invalidationHandler = { [controller] in
      DispatchQueue.main.async { controller.disconnected(id) }
    }
    DispatchQueue.main.async { self.controller.connections += 1 }
    connection.resume()
    return true
  }
}

guard let team = ownSigningTeam() else {
  log.error("the fan helper is not signed with a team; refusing to start")
  exit(1)
}
let smc: SMC
do { smc = try SMC() } catch {
  log.error("cannot open the SMC")
  exit(1)
}
let controller = Controller(smc: smc)
controller.handBackIfManual(reason: "recovery")

// Sleep and wake. On Apple silicon the SMC can keep a manual target across
// sleep, so hand the fans back before sleeping and check again on wake.
var powerConnection: io_connect_t = 0
var powerPort: IONotificationPortRef?
var powerNotifier: io_object_t = 0
let canSleep: UInt32 = 0xe000_0270
let willSleep: UInt32 = 0xe000_0280
let poweredOn: UInt32 = 0xe000_0300
powerConnection = IORegisterForSystemPower(nil, &powerPort, { _, _, type, argument in
  switch type {
  case willSleep:
    controller.handBackIfManual(reason: "sleep")
    IOAllowPowerChange(powerConnection, Int(bitPattern: argument))
  case canSleep:
    IOAllowPowerChange(powerConnection, Int(bitPattern: argument))
  case poweredOn:
    controller.handBackIfManual(reason: "sleep")
  default:
    break
  }
}, &powerNotifier)
if let powerPort { IONotificationPortSetDispatchQueue(powerPort, .main) }

let delegate = Listener(controller: controller)
let listener = NSXPCListener(machServiceName: FanNames.helper)
// macOS refuses any client that doesn't meet this before the delegate sees it.
listener.setConnectionCodeSigningRequirement(FanNames.requirement(identifier: FanNames.bridge, team: team))
listener.delegate = delegate
listener.resume()

let timer = DispatchSource.makeTimerSource(queue: .main)
timer.schedule(deadline: .now() + 1, repeating: 1, leeway: .milliseconds(100))
timer.setEventHandler { controller.tick() }
timer.resume()

signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
var signalSources: [DispatchSourceSignal] = []
for number in [SIGTERM, SIGINT] {
  let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
  source.setEventHandler {
    controller.handBackIfManual(reason: "helper-stopped")
    exit(0)
  }
  source.resume()
  signalSources.append(source)
}
dispatchMain()
