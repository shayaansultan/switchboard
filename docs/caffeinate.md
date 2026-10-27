# Caffeinate

**Decaf**, first in the title bar, means the Mac sleeps as usual. Its popover
starts a **Caffeinate** session: 1, 2 or 4 hours, Until I stop, or a custom
number of minutes. A running session reads **Caffeinated · 1h** in the title
bar and is a green countdown in the popover with **+1 hour** and **Decaf now**.
It replaces Keep awake, which switched macOS's system-wide sleep setting and
left it that way when Switchboard closed.

## Two ways to stay awake

| Option                   | Mechanism                                                                                                                                | Needs                                                                                                | Ends when                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Default (lid open)       | A power assertion through Electron's `powerSaveBlocker` (`prevent-display-sleep`), which keeps the system and the screen from idle sleep | Nothing                                                                                              | The time is up, Decaf now, or Switchboard quits (macOS drops the assertion with the process) |
| Also with the lid closed | macOS's `SleepDisabled` (`pmset disablesleep 1`), held by the root system helper                                                         | The system helper, allowed once in Login Items, in a certificate-signed install, on a Mac with a lid | Any of the above, or the helper's own checks below                                           |

Only `SleepDisabled` keeps a closed MacBook awake; a power assertion does not.
It is also the setting that can leave a closed laptop running in a bag, so the
helper treats it like a fan boost: a hold for one session that ends when there
is any doubt.

## When a lid-closed session ends on its own

| Reason             | Trigger                                                                      |
| ------------------ | ---------------------------------------------------------------------------- |
| `time-limit`       | The session's time ran out (the helper keeps its own timer).                 |
| `battery-low`      | On battery below 20%. A session can't start below it either.                 |
| `thermal-pressure` | `ProcessInfo.thermalState` is serious or critical.                           |
| `app-closed`       | Switchboard quit or crashed, so the bridge's connection ended.               |
| `heartbeat-lost`   | No heartbeat from the bridge for 7 seconds.                                  |
| `sleep`            | The Mac was put to sleep anyway, so someone chose to.                        |
| `helper-stopped`   | launchd stopped the helper, as at restart, shutdown or an update.            |
| `recovery`         | The helper started and found its marker file, as after a crash or a restart. |

The helper writes `/Library/Application Support/Switchboard/sleep-disabled`
when it turns sleep off and removes it only once `pmset` has really turned
sleep back on; until then it retries every second and stays resident. On
start (`RunAtLoad`, so at every boot), before it touches the SMC, a marker
means a hold was cut short, so it turns sleep back on. A `SleepDisabled` set some other way, such as by the old
Keep awake or `pmset`, has no marker and is left alone; the popover reports it
and offers **Turn sleep on**, through the helper if it is installed or a macOS
password prompt if not.

## Implementation

- `src/caffeinate.ts`: the controller. It owns the power assertion and the
  lid-open timer, asks the system bridge (`src/system-bridge.ts`) for the
  lid-closed hold, and learns from bridge events when the helper ended one.
- `src/shared/caffeinate.ts`: the state, lengths and wording, shared with the
  window and the CLI.
- `src/renderer/caffeinate.tsx`: the button and popover.
- `src/native/system/helper/main.swift` (`AwakeHold`) and
  `src/native/system/bridge/main.swift` (`awake-hold`, `awake-release`,
  `sleep-clear`, and the lid, battery and sleep facts in `state`).
- `switchboard caffeinate status|start [--minutes N] [--lid]|extend
[--minutes N]|stop|dismiss|cancel|clear` drives the same controller through
  the running app.

## Verification

1. `bun test` covers the controller against a fake bridge, power assertion and
   timers: lid-open sessions, the time limit, the lid-closed hold and its
   release, the helper ending a hold, approval, low battery, Macs where the lid
   option can't work, and clearing a leftover `SleepDisabled`.
2. `bun run test:caffeinate-ui` drives the real renderer through every state
   with a simulated bridge, then launches the real Electron main process with
   an empty store and checks the IPC rejects invalid input. Neither keeps this
   Mac awake or changes its sleep setting.
3. On hardware: start a lid-open session and see Switchboard's assertion in
   `pmset -g assertions`; start a lid-closed one and see `SleepDisabled 1` in
   `pmset -g`; Decaf and see it go back to 0; quit Switchboard mid-session and
   see it go back within a few seconds.
