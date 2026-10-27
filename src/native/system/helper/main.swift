// The system helper: the one part of Switchboard that runs as root, because
// only root may write the SMC (fan speeds) or turn off system sleep. macOS
// installs it from inside the app with SMAppService, and launchd starts it at
// boot and whenever the system bridge connects. It accepts only the bridge
// signed by its own team, and only these requests: a fan level in 5% steps
// or System, and a lid-closed hold on sleep or its release.
//
// Both are short holds, so the helper gives control back to macOS whenever
// there is any doubt. A fan boost ends, matching Vorssaint, when the bridge
// disconnects (Switchboard quit or crashed), heartbeats stop for 7 s
// (Switchboard hung), the time limit ends, the Mac goes to sleep, macOS takes
// the fans back itself (three failed checks in a row; the helper never fights
// it), the Mac reports serious thermal pressure, or launchd stops the helper
// (restart, shutdown, update). A lid-closed hold ends on the same, except
// sleep, plus the battery falling below 20%. On start the helper hands back
// any fan it finds in manual mode and any sleep setting a hold left behind,
// so a crash or a restart always ends on macOS's own settings, and a
// hand-back the SMC or pmset refuses is tried again every second.
//
// The trust boundary is the signed-in user, as for the `switchboard` CLI:
// any program they run can ask Switchboard for a boost or a hold. That is
// why the helper offers only these bounded requests, each of which ends on
// its own, and nothing else that root could do.
import Foundation
import IOKit
import IOKit.pwr_mgt
import os

let log = Logger(subsystem: SystemNames.helper, category: "helper")

func uptime() -> TimeInterval { ProcessInfo.processInfo.systemUptime }

func seriouslyHot() -> Bool {
  let thermal = ProcessInfo.processInfo.thermalState
  return thermal == .serious || thermal == .critical
}

/// Who is connected, and when each last sent a heartbeat.
final class Sessions {
  private var beats: [ObjectIdentifier: TimeInterval] = [:]
  private(set) var count = 0
  private var idleSince = uptime()

  func connected(_ session: ObjectIdentifier) {
    count += 1
    beats[session] = uptime()
  }

  func disconnected(_ session: ObjectIdentifier) {
    count = max(0, count - 1)
    beats[session] = nil
    if count == 0 { idleSince = uptime() }
  }

  func beat(_ session: ObjectIdentifier) { beats[session] = uptime() }

  /// True when the session has gone quiet for longer than the limit.
  func lost(_ session: ObjectIdentifier) -> Bool {
    uptime() - (beats[session] ?? 0) > SystemNames.heartbeatLimit
  }

  /// Nobody connected for a minute.
  var idle: Bool { count == 0 && uptime() - idleSince > 60 }
}

/// A fan boost: every fan held at one level for one session.
final class Fans {
  private let smc: SMC
  private let temperature: CPUTemperature
  private(set) var level: Int?
  private(set) var owner: ObjectIdentifier?
  private var endsAt: TimeInterval?
  private var targets: [Double] = []
  private var misses = 0
  /// Seconds left to keep retrying a hand-back the SMC refused.
  private(set) var retrying = 0
  private(set) var stop: String?
  /// What went wrong in the last failed set, for `switchboard fans status`.
  private(set) var detail: String?

  init(smc: SMC) {
    self.smc = smc
    temperature = CPUTemperature(smc: smc)
  }

  func status(error: String?, awake: AwakeStatus) -> FanStatus {
    FanStatus(
      fans: (try? smc.readings()) ?? [], temperature: temperature.hottest(), controlling: level != nil,
      level: level, endsIn: endsAt.map { max(0, Int(($0 - uptime()).rounded(.up))) }, stop: stop, error: error,
      detail: detail, awake: awake)
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
      misses = 0
      stop = nil
      detail = nil
      log.info("fans at \(newLevel)% for \(seconds) s")
      return nil
    } catch {
      detail = String(describing: error)
      log.error("fan set failed: \(String(describing: error), privacy: .public)")
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
    for index in 0..<max(count, 0) {
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
    // An unreadable SMC is not proof the fans are back on automatic.
    let automatic = count > 0 && ((try? smc.readings())?.allSatisfy { !$0.manual } ?? false)
    if level != nil || reason == "recovery" { stop = reason }
    level = nil
    owner = nil
    endsAt = nil
    targets = []
    // The session is over either way, but a refused write is tried again
    // every second for a while. Not for ever: by then another app may have
    // taken the fans on purpose.
    if automatic { retrying = 0 } else if retrying == 0 { retrying = 30 }
    log.info("System (\(reason ?? "asked", privacy: .public)) automatic=\(automatic)")
    return automatic
  }

  func handBackIfManual(reason: String) {
    if level != nil || ((try? smc.readings()) ?? []).contains(where: { $0.manual }) {
      restore(reason: reason)
    }
  }

  // Runs every second.
  func check(_ sessions: Sessions) {
    if level == nil, retrying > 0 {
      let left = retrying - 1
      if restore(reason: nil) { log.info("fans handed back on a retry") }
      retrying = retrying == 0 ? 0 : left
      return
    }
    guard level != nil, let owner else { return }
    misses = intact(targets) ? 0 : misses + 1
    if let endsAt, uptime() >= endsAt {
      restore(reason: "time-limit")
    } else if sessions.lost(owner) {
      restore(reason: "heartbeat-lost")
    } else if seriouslyHot() {
      restore(reason: "thermal-pressure")
    } else if misses >= SystemNames.takeoverLimit {
      restore(reason: "system-took-over")
    }
  }
}

/// A lid-closed hold: macOS's SleepDisabled turned on for one session. A
/// marker file records that the helper turned it on, so a crash or restart
/// turns it off again, while a SleepDisabled someone set by hand is left
/// alone unless they ask for it to be cleared.
final class AwakeHold {
  private let marker = URL(fileURLWithPath: "/Library/Application Support/Switchboard/sleep-disabled")
  private(set) var owner: ObjectIdentifier?
  private var endsAt: TimeInterval?
  private(set) var stop: String?

  func status() -> AwakeStatus {
    AwakeStatus(
      held: owner != nil, endsIn: endsAt.map { max(0, Int(($0 - uptime()).rounded(.up))) }, stop: stop,
      sleepDisabled: sleepDisabled())
  }

  private func pmset(_ value: Int) -> Bool {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/pmset")
    process.arguments = ["-a", "disablesleep", String(value)]
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    guard (try? process.run()) != nil else { return false }
    process.waitUntilExit()
    return process.terminationStatus == 0 && sleepDisabled() == (value == 1)
  }

  /// Nil on success, else the reason it was refused.
  func hold(seconds: Int, session: ObjectIdentifier) -> String? {
    guard (0...86_400).contains(seconds) else { return "invalid-request" }
    if let owner, owner != session { return "already-controlled" }
    if let battery = battery(), battery.onBattery, battery.percent < SystemNames.batteryFloor {
      return "battery-low"
    }
    try? FileManager.default.createDirectory(
      at: marker.deletingLastPathComponent(), withIntermediateDirectories: true)
    guard FileManager.default.createFile(atPath: marker.path, contents: Data("v1\n".utf8)), pmset(1) else {
      release(reason: "control-failed")
      return "control-failed"
    }
    owner = session
    endsAt = seconds > 0 ? uptime() + TimeInterval(seconds) : nil
    stop = nil
    log.info("sleep disabled for \(seconds) s")
    return nil
  }

  /// True while sleep this helper turned off is still off: the marker goes
  /// only once pmset has really turned it back on, so a failure is retried
  /// every second and survives a restart.
  var pending: Bool { owner == nil && FileManager.default.fileExists(atPath: marker.path) }

  /// Turns sleep back on. `reason` is nil when someone asked.
  func release(reason: String?) {
    let held = owner != nil
    if held || FileManager.default.fileExists(atPath: marker.path) {
      if pmset(0) { try? FileManager.default.removeItem(at: marker) } else { log.error("sleep not re-enabled; will retry") }
    }
    if held || reason == "recovery" { stop = reason }
    owner = nil
    endsAt = nil
    log.info("sleep enabled (\(reason ?? "asked", privacy: .public))")
  }

  /// A SleepDisabled this helper did not set, as an old Keep awake left it.
  func clear() -> String? {
    guard owner == nil else { return "already-controlled" }
    return pmset(0) ? nil : "control-failed"
  }

  func recover() {
    if FileManager.default.fileExists(atPath: marker.path) { release(reason: "recovery") }
  }

  // Runs every second.
  func check(_ sessions: Sessions) {
    if pending, pmset(0) {
      try? FileManager.default.removeItem(at: marker)
      log.info("sleep re-enabled on a retry")
    }
    guard let owner else { return }
    if let endsAt, uptime() >= endsAt {
      release(reason: "time-limit")
    } else if sessions.lost(owner) {
      release(reason: "heartbeat-lost")
    } else if seriouslyHot() {
      release(reason: "thermal-pressure")
    } else if let battery = battery(), battery.onBattery, battery.percent < SystemNames.batteryFloor {
      release(reason: "battery-low")
    }
  }
}

final class Session: NSObject, SystemHelperProtocol {
  let fans: Fans
  let awake: AwakeHold
  let sessions: Sessions
  init(fans: Fans, awake: AwakeHold, sessions: Sessions) {
    self.fans = fans
    self.awake = awake
    self.sessions = sessions
  }
  var id: ObjectIdentifier { ObjectIdentifier(self) }

  private func answer(_ reply: @escaping (Data) -> Void, _ work: () -> String?) {
    let error = work()
    // A request is proof of life too. Unlocking a stopped fan can block for
    // seconds, longer than the heartbeat limit, while heartbeats wait behind
    // it; without this the first check afterwards would end the new boost.
    sessions.beat(id)
    reply(encode(fans.status(error: error, awake: awake.status())))
  }

  func status(reply: @escaping (Data) -> Void) {
    DispatchQueue.main.async { self.answer(reply) { nil } }
  }
  func setLevel(_ level: Int, seconds: Int, reply: @escaping (Data) -> Void) {
    DispatchQueue.main.async { self.answer(reply) { self.fans.set(level: level, seconds: seconds, session: self.id) } }
  }
  func restoreSystem(reply: @escaping (Data) -> Void) {
    DispatchQueue.main.async {
      self.answer(reply) {
        if self.fans.owner == self.id { self.fans.restore(reason: nil) }
        return nil
      }
    }
  }
  func holdAwake(seconds: Int, reply: @escaping (Data) -> Void) {
    DispatchQueue.main.async { self.answer(reply) { self.awake.hold(seconds: seconds, session: self.id) } }
  }
  func releaseAwake(reply: @escaping (Data) -> Void) {
    DispatchQueue.main.async {
      self.answer(reply) {
        if self.awake.owner == self.id { self.awake.release(reason: nil) }
        return nil
      }
    }
  }
  func clearSleepDisabled(reply: @escaping (Data) -> Void) {
    DispatchQueue.main.async { self.answer(reply) { self.awake.clear() } }
  }
  func heartbeat(reply: @escaping (Data) -> Void) {
    DispatchQueue.main.async { self.answer(reply) { nil } }
  }
}

final class Listener: NSObject, NSXPCListenerDelegate {
  let fans: Fans
  let awake: AwakeHold
  let sessions: Sessions
  init(fans: Fans, awake: AwakeHold, sessions: Sessions) {
    self.fans = fans
    self.awake = awake
    self.sessions = sessions
  }

  func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
    let session = Session(fans: fans, awake: awake, sessions: sessions)
    let id = session.id
    connection.exportedInterface = NSXPCInterface(with: SystemHelperProtocol.self)
    connection.exportedObject = session
    connection.invalidationHandler = { [fans, awake, sessions] in
      DispatchQueue.main.async {
        sessions.disconnected(id)
        if fans.owner == id { fans.restore(reason: "app-closed") }
        if awake.owner == id { awake.release(reason: "app-closed") }
      }
    }
    DispatchQueue.main.async { self.sessions.connected(id) }
    connection.resume()
    return true
  }
}

guard let team = ownSigningTeam() else {
  log.error("the system helper is not signed with a team; refusing to start")
  exit(1)
}
// Sleep first: it needs no SMC, so a Mac whose SMC will not open still gets
// back a sleep setting a crashed hold left off.
let awake = AwakeHold()
awake.recover()
let smc: SMC
do { smc = try SMC() } catch {
  log.error("cannot open the SMC")
  // Stay up while the retry needs us; launchd would not start us again.
  while awake.pending {
    awake.release(reason: nil)
    Thread.sleep(forTimeInterval: 1)
  }
  exit(1)
}
let fans = Fans(smc: smc)
let sessions = Sessions()
fans.handBackIfManual(reason: "recovery")

// Sleep and wake. On Apple silicon the SMC can keep a manual target across
// sleep, so hand the fans back before sleeping and check again on wake. A
// lid-closed hold keeps the Mac from sleeping on its own; if it sleeps
// anyway, someone chose to, so the hold ends too.
var powerConnection: io_connect_t = 0
var powerPort: IONotificationPortRef?
var powerNotifier: io_object_t = 0
let canSleep: UInt32 = 0xe000_0270
let willSleep: UInt32 = 0xe000_0280
let poweredOn: UInt32 = 0xe000_0300
powerConnection = IORegisterForSystemPower(nil, &powerPort, { _, _, type, argument in
  switch type {
  case willSleep:
    fans.handBackIfManual(reason: "sleep")
    if awake.owner != nil { awake.release(reason: "sleep") }
    IOAllowPowerChange(powerConnection, Int(bitPattern: argument))
  case canSleep:
    IOAllowPowerChange(powerConnection, Int(bitPattern: argument))
  case poweredOn:
    fans.handBackIfManual(reason: "sleep")
  default:
    break
  }
}, &powerNotifier)
if let powerPort { IONotificationPortSetDispatchQueue(powerPort, .main) }

let delegate = Listener(fans: fans, awake: awake, sessions: sessions)
let listener = NSXPCListener(machServiceName: SystemNames.helper)
// macOS refuses any client that doesn't meet this before the delegate sees it.
listener.setConnectionCodeSigningRequirement(SystemNames.requirement(identifier: SystemNames.bridge, team: team))
listener.delegate = delegate
listener.resume()

let timer = DispatchSource.makeTimerSource(queue: .main)
timer.schedule(deadline: .now() + 1, repeating: 1, leeway: .milliseconds(100))
timer.setEventHandler {
  fans.check(sessions)
  awake.check(sessions)
  // Nothing held and nobody connected: launchd starts the helper again on
  // the next connection, so there is no reason to stay resident.
  if fans.level == nil, fans.retrying == 0, awake.owner == nil, !awake.pending, sessions.idle {
    log.info("idle; exiting")
    exit(0)
  }
}
timer.resume()

signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
var signalSources: [DispatchSourceSignal] = []
for number in [SIGTERM, SIGINT] {
  let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
  source.setEventHandler {
    fans.handBackIfManual(reason: "helper-stopped")
    if awake.owner != nil { awake.release(reason: "helper-stopped") }
    exit(0)
  }
  source.resume()
  signalSources.append(source)
}
dispatchMain()
