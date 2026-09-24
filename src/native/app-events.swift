// Switchboard's native helper, for what Electron cannot reach.
//
//   app-events                 Stream app launches, quits and activations.
//   app-events windows PID...  How many windows each process has open.
//   app-events reopen PID      Bring back that process's window.
//
// Asking for Accessibility is Switchboard's own job (Electron's
// systemPreferences); this helper inherits the answer as its child.
//
// The stream prints one JSON object per line: {"event":"launch"|"terminate"|
// "activate"|"deactivate","pid":N,"exe":"/path"}. Each instance of an app
// started with `open -n` gets its own events and pid. It exits when stdin
// closes, so it never outlives the app that spawned it.
//
// Window counts: the apps hide a window closed with its red button rather
// than destroy it, so the public window list shows it exactly like a
// minimised one or one on another Space. The Accessibility API does tell a
// closed window from a minimised one, but only sees windows on the current
// Space. So a process counts as windowless only when Accessibility sees
// nothing, it is not hidden (Cmd+H), and it has no window on any other Space,
// which the private CGSCopySpacesForWindows reports (the Space lookup that
// window managers such as yabai and AltTab rely on). If that lookup is
// missing, windows elsewhere are assumed: the answer errs towards "has a
// window", never towards a false "no window". Without Accessibility,
// `windows` answers {"trusted":false} and Switchboard does not guess.
// Reopen sends the event a Dock click sends, to one process, which needs no
// permission.

import AppKit
import ApplicationServices
import Darwin

let out = FileHandle.standardOutput

func print(json: [String: Any]) {
  guard var data = try? JSONSerialization.data(withJSONObject: json) else { return }
  data.append(0x0A)
  out.write(data)
}

func stream() -> Never {
  func emit(_ event: String, _ note: Notification) {
    guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
    print(json: ["event": event, "pid": Int(app.processIdentifier), "exe": app.executableURL?.path ?? ""])
  }
  let center = NSWorkspace.shared.notificationCenter
  let names: [(NSNotification.Name, String)] = [
    (NSWorkspace.didLaunchApplicationNotification, "launch"),
    (NSWorkspace.didTerminateApplicationNotification, "terminate"),
    (NSWorkspace.didActivateApplicationNotification, "activate"),
    (NSWorkspace.didDeactivateApplicationNotification, "deactivate"),
  ]
  for (name, event) in names {
    center.addObserver(forName: name, object: nil, queue: .main) { emit(event, $0) }
  }
  // The parent closing our stdin, or dying, ends the helper.
  Thread.detachNewThread {
    while !FileHandle.standardInput.availableData.isEmpty {}
    exit(0)
  }
  print(json: ["event": "ready"])
  RunLoop.main.run()
  exit(0)
}

// Standard windows and dialogs, minimised ones included: a minimised window
// is still a window the person can get back to from the Dock.
func windowCount(_ pid: pid_t) -> Int {
  var value: CFTypeRef?
  let app = AXUIElementCreateApplication(pid)
  guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success,
    let windows = value as? [AXUIElement]
  else { return 0 }
  return windows.filter { w in
    var sub: CFTypeRef?
    AXUIElementCopyAttributeValue(w, kAXSubroleAttribute as CFString, &sub)
    let s = sub as? String
    return s == kAXStandardWindowSubrole || s == kAXDialogSubrole
  }.count
}

// Private CoreGraphics Space calls, looked up at run time so a macOS that
// drops them degrades to "assume a window" rather than failing to load.
typealias MainConnection = @convention(c) () -> UInt32
typealias ActiveSpace = @convention(c) (UInt32) -> UInt64
typealias SpacesForWindows = @convention(c) (UInt32, Int32, CFArray) -> Unmanaged<CFArray>?
let rtld = UnsafeMutableRawPointer(bitPattern: -2)  // RTLD_DEFAULT
func lookup<T>(_ name: String, _: T.Type) -> T? {
  dlsym(rtld, name).map { unsafeBitCast($0, to: T.self) }
}
let cgsConnection = lookup("CGSMainConnectionID", MainConnection.self)
let cgsActiveSpace = lookup("CGSGetActiveSpace", ActiveSpace.self)
let cgsSpaces = lookup("CGSCopySpacesForWindows", SpacesForWindows.self)

// Ordinary (layer 0) windows of the process that sit on some Space other than
// the one on screen. The apps' invisible helper windows are on no Space.
func windowsElsewhere(_ pid: pid_t) -> Int? {
  guard let cgsConnection, let cgsActiveSpace, let cgsSpaces else { return nil }
  let cid = cgsConnection()
  let active = cgsActiveSpace(cid)
  let all = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
  return all.filter { w in
    guard (w[kCGWindowOwnerPID as String] as? Int32) == pid, (w[kCGWindowLayer as String] as? Int) == 0,
      let wid = w[kCGWindowNumber as String] as? UInt32
    else { return false }
    let spaces = cgsSpaces(cid, 7, [NSNumber(value: wid)] as CFArray)?.takeRetainedValue() as? [NSNumber] ?? []
    return spaces.contains { $0.uint64Value != active }
  }.count
}

// What Switchboard should believe: Accessibility's count when it sees any,
// otherwise at least one if the app is hidden or has a window elsewhere.
func believedWindows(_ pid: pid_t) -> Int {
  let seen = windowCount(pid)
  if seen > 0 { return seen }
  if NSRunningApplication(processIdentifier: pid)?.isHidden == true { return 1 }
  return windowsElsewhere(pid) ?? 1
}

func reopen(_ pid: pid_t) -> Bool {
  NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateAllWindows])
  let event = NSAppleEventDescriptor(
    eventClass: AEEventClass(kCoreEventClass), eventID: AEEventID(kAEReopenApplication),
    targetDescriptor: NSAppleEventDescriptor(processIdentifier: pid),
    returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
  return AESendMessage(event.aeDesc, nil, AESendMode(kAENoReply), kAEDefaultTimeout) == noErr
}

let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case nil:
  stream()
case "windows":
  guard AXIsProcessTrusted() else {
    print(json: ["trusted": false])
    break
  }
  var counts: [String: Int] = [:]
  for p in args.dropFirst() { if let pid = pid_t(p) { counts[p] = believedWindows(pid) } }
  print(json: ["trusted": true, "windows": counts])
case "reopen":
  guard args.count > 1, let pid = pid_t(args[1]) else { exit(2) }
  print(json: ["ok": reopen(pid)])
default:
  exit(2)
}
