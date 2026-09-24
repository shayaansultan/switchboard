// Tells Switchboard the moment any app launches or quits, so a desktop app
// opened from the Dock or quit with Cmd+Q shows up without waiting for a poll.
// Electron has no access to these NSWorkspace notifications, hence a helper.
//
// One JSON object per line on stdout: {"event":"launch"|"terminate","pid":N,
// "exe":"/path/to/binary"}. Each instance of an app started with `open -n`
// gets its own event and pid. The helper exits when stdin closes, so it never
// outlives the app that spawned it.

import AppKit

let out = FileHandle.standardOutput

func emit(_ event: String, _ note: Notification) {
  guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
  let line: [String: Any] = [
    "event": event,
    "pid": Int(app.processIdentifier),
    "exe": app.executableURL?.path ?? "",
  ]
  guard var data = try? JSONSerialization.data(withJSONObject: line) else { return }
  data.append(0x0A)
  out.write(data)
}

let center = NSWorkspace.shared.notificationCenter
center.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) {
  emit("launch", $0)
}
center.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) {
  emit("terminate", $0)
}

// The parent closing our stdin, or dying, ends the helper.
Thread.detachNewThread {
  while !FileHandle.standardInput.availableData.isEmpty {}
  exit(0)
}

out.write(Data("{\"event\":\"ready\"}\n".utf8))
RunLoop.main.run()
