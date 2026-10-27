# Fan control

**Fans**, beside Caffeinate in the title bar, boosts every fan to one speed for
a short while, then hands them back to macOS. A boost is an action, not a
mode: the popover changes nothing until Boost is pressed, and a running boost
shows as a countdown with Stop. Nothing in Switchboard keeps a boost beyond
its time limit, after sleep, or across a restart.

## Pieces

| Piece                                      | Runs as                               | Job                                                                                         |
| ------------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/native/system/helper` (system helper) | root, started by launchd              | Writes the SMC. Decides when manual control ends.                                           |
| `src/native/system/bridge` (system bridge) | the user, a child of the main process | Reads fans and CPU temperature (no root needed), installs the helper, talks to it over XPC. |
| `src/fans.ts`, `src/system-bridge.ts`      | Electron main process                 | Runs the bridge, keeps the state the window, tray and CLI read.                             |
| `src/renderer/fans.tsx`                    | the window                            | The button and popover.                                                                     |

The bridge lives in `Contents/MacOS`, beside the app's executable, so
`SMAppService` finds the helper's launchd plist in
`Contents/Library/LaunchDaemons`. `build/sign.sh` signs the helper and bridge
with fixed identifiers after signing the bundle.

## Trust

A first boost asked for before the helper is allowed is remembered: the
window says to allow Switchboard in Login Items, and the boost starts on the
next refresh after it is allowed, unless it was cancelled.

Neither side hard-codes a signing team. Each reads its own team from its
signature and requires the other to carry the same team and identifier:
the helper with `NSXPCListener.setConnectionCodeSigningRequirement`, the
bridge with `NSXPCConnection.setCodeSigningRequirement`. An ad-hoc build has
no team, so the bridge reports `unsigned` and never contacts the helper, and
the window hides Fans. Install with `SWITCHBOARD_SIGN_IDENTITY` (see the
README) to use it.

The helper accepts only a level from 0 to 100 in steps of 5, a time limit up
to a day, System, and a heartbeat. It never writes any other SMC key. If the
fans are already in manual mode when no session of its own holds them, it
refuses: another app has them, and two controllers would fight.

The boundary is the signed-in user, the same as for the `switchboard` CLI:
any program they run can ask Switchboard, or start the bridge itself, for a
boost or a lid-closed hold. That is why the helper offers only those bounded
requests, each of which ends on its own, and nothing else root could do.

## When a boost ends

The helper hands the fans back and records why, matching Vorssaint's
behaviour with its resume option off:

| Reason             | Trigger                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `time-limit`       | The chosen 15, 30 or 60 minutes, or a custom length, ran out.                                                                          |
| `sleep`            | The Mac is about to sleep (`kIOMessageSystemWillSleep`), checked again on wake.                                                        |
| `helper-stopped`   | launchd sent SIGTERM, as at restart, shutdown or an update.                                                                            |
| `recovery`         | The helper started and found fans in manual mode, as after a crash. It runs at boot (`RunAtLoad`), so a restart always ends on System. |
| `app-closed`       | The bridge's connection ended: Switchboard quit or crashed.                                                                            |
| `heartbeat-lost`   | No heartbeat for 7 seconds: Switchboard hung.                                                                                          |
| `system-took-over` | Three checks in a row found a fan out of manual mode or off its target. The helper does not fight macOS for the fans.                  |
| `thermal-pressure` | `ProcessInfo.thermalState` is serious or critical.                                                                                     |
| `control-failed`   | The fans did not take the requested speed.                                                                                             |

A Mac with fans spinning takes manual mode directly: mode and target are
written back to back so the thermal controller has no gap to reclaim them. A
stopped fan on Apple silicon can refuse; the helper then sets the `Ftst`
unlock key, a protective maximum target, waits for manual mode to stick, and
applies the requested level. Every restore clears `Ftst` again.

A restore counts only once every fan reads automatic again. If the SMC
refuses or cannot be read, the session still ends and the helper tries again
every second for 30 seconds; after that another app may have taken the fans
on purpose, so it stops. It stays resident while retrying.

The helper exits after a minute with nothing held and nobody connected;
launchd starts it again on the next connection.

## Verified

On a two-fan Apple silicon MacBook Pro running macOS 26:
registration after one Login Items approval; a differently signed bridge
refused; 50% settling near 5,070 rpm within 3 seconds; and a return to System
after the bridge exited, was force-quit, stopped sending heartbeats, and after
the helper was stopped or killed. Not yet observed on hardware: the `Ftst`
path (the fans never stopped), thermal pressure, and a closed-lid sleep.
