# Keep awake

The header control immediately before Refresh reads and changes macOS's
system-wide `SleepDisabled` setting. It uses `/usr/bin/pmset -g` for reads and
`/usr/bin/osascript` to request administrator authorization for one of two fixed
commands: `pmset disablesleep 1` or `pmset disablesleep 0`.

There is no native helper, daemon, duration-based shutoff, auto-start policy,
or new dependency. The observation timer only reads the current setting.
The setting stays enabled when Switchboard closes or crashes. Reopening the app
reads the actual setting and offers Turn off. Normal quitting also leaves it as
set; quitting is not a second, implicit toggle.

## Implementation

- `src/awake.ts` contains the strict state types, macOS adapter and controller.
- Reads happen on startup, window focus, resume, opening the control, every
  15 seconds, and after every attempted write, including cancellation/failure.
- Reads and writes share one operation slot, so polling cannot overwrite a
  pending change and double-clicking does not open multiple authorization prompts.
- Unchanged observations are silent. Changed awake state uses a dedicated IPC
  event, leaving account cards alone. Explicit rechecks clear prior notices.
- A failed read is unknown, never off. The last known value is labeled as such,
  with Check again and a recovery Turn off action.
- The renderer sends only literal `on` or `off` values. Main validates the
  sender and value; no supplied text is evaluated by a shell.
- macOS receives the administrator password directly. It is not stored by
  Switchboard. The authorization request times out after two minutes.

`SleepDisabled` is different from the `sleep` idle timer and from `caffeinate`.
macOS can omit the key before it has first been set. The parser accepts that as
off only within structurally valid `pmset -g` output.

## Verification

1. Run `bun run test` for parser, authorization-result and controller checks.
2. Run `bun run test:awake-ui`. It passes only after the real renderer's
   transitions, minimum-width layout and keyboard dismissal succeed, and the
   real Electron/preload/IPC path reads macOS and rejects invalid input.
   The browser uses invented accounts and a simulated system boundary. The
   Electron smoke test uses an empty profile store and a minimal environment
   so account credentials are not involved. Its macOS access is read-only.
3. For hardware acceptance, have the user authorize Turn on. Run an agent or
   timestamp/network heartbeat, close the lid briefly, then verify uninterrupted
   progress after reopening it. Reopen Switchboard and confirm it reads On;
   authorize Turn off and verify `SleepDisabled 0`.

Report the hardware step separately until performed. Readback proves the setting
changed; it does not prove closed-lid execution. The recorded demo is labeled as
simulated and illustrates only the UI interactions.
