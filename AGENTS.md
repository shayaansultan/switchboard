# Working on Switchboard

Switchboard is a macOS Electron app plus a `switchboard` CLI that keeps
several Claude and Codex sign-ins apart, each in its own profile with its own
desktop session and CLI home, and shows their rate limits. TypeScript
throughout: the main process is compiled by `tsc` into `out/`; the window is a
Preact app under `src/renderer/` bundled by `bun build`. The words for things
(profile, account, connection, proxy bucket, vendor) are defined in
[CONTEXT.md](CONTEXT.md); use those and no others in code, UI text and docs.

## Before you push

```bash
bun run check
```

This is exactly what CI runs on Ubuntu and macOS: `oxfmt --check`, then
`oxlint`, the type check, the unit tests, then a build. The formatter runs
first, so an unformatted file fails CI before any test executes, and
`bun run test` alone will not catch it. `bun run format` fixes formatting in
place. Push only when `bun run check` exits clean.

## Commands

```bash
bun install --frozen-lockfile   # once
bun run check                   # everything CI runs
bun test                        # unit tests only, fastest loop
bun run typecheck               # tsc for main and renderer
bun run build                   # out/ for Electron
bunx electron .                 # run from the checkout (see below)
bun run test:buckets-ui         # Playwright against the real window, buckets tab
bun run test:awake-ui           # same, keep-awake control
bun run test:usage-ui           # same, Usage tab against invented agent logs
bun run demo                    # regenerate docs/screenshot.png and the social card
bun run cli -- list --human     # the CLI straight from source
```

## Layout

- `src/main.ts`: the Electron main process, window, tray and IPC.
- `src/store.ts`, `src/profiles.ts`, `src/setup.ts`: which profiles exist,
  where their directories live under `~/.switchboard`, and bringing files from
  one profile into another. The app and the CLI both write this store, so go
  through it rather than touching files.
- `src/usage.ts`, `src/usage-parsers.ts`, `src/plans.ts`: identity and
  rate-limit lookups. Runs only in the main process.
- `src/launch.ts`, `src/shell.ts`: launching and quitting desktop apps and
  opening terminals.
- `src/app-state.ts`, `src/desktop-watch.ts`, `src/native/`: what each
  desktop app is doing (off, starting, running, no window, quitting, won't
  quit) and when to look. `src/native/app-events.swift` is a helper that
  reports app launches and quits, counts windows and reopens them;
  `bun run build` compiles it on macOS and skips it elsewhere, and the app
  falls back to polling (and no window counts) without it.
- `src/cli.ts` and `src/cli/`: the `switchboard` command. JSON on stdout by
  default, `--human` for prose; `src/cli/output.ts` is the contract.
- `src/history/`: usage history. `logs.ts` reads Claude Code and Codex logs,
  `ledger.ts` indexes them incrementally per profile, `windows.ts` keeps every
  window reading, `report.ts` builds what the Usage tab and `switchboard
tokens` show, `alerts.ts` decides notifications. Main process and CLI only.
- `src/buckets/`: proxy buckets, the local proxy and its worker.
- `src/opencode/`: the `oc` CLI for OpenCode profiles; runs without Electron.
- `src/renderer/`: `app.tsx` (the window), `profiles.tsx`, `usage.tsx`, `buckets.tsx`,
  `dialogs.tsx`, `ui/` (primitives, overlays, menus), one `style.css`.
- `test/`: Bun tests, one file per module. `demo/`: the fixture, the
  screenshot capture and the Playwright end-to-end scripts. `docs/`: design
  notes and the README images. `build/`: icons and packaging assets.

## Conventions the tools do not enforce

- Every colour in `style.css` is a token with a light value in `:root` and a
  dark value in the `prefers-color-scheme: dark` block. Never write a literal
  colour in a rule; add a token to both sets.
- The renderer only ever receives percentages, reset times, email and plan,
  and from the usage history token counts, dollar estimates, model names,
  session titles and folder names. Never a full path, a transcript or a
  credential: tokens and credentials are read in the main process, used once,
  dropped.
- Renderer buttons call the main process through `act()` in
  `src/renderer/lib.ts`, which handles the pending state and errors. Do not
  call `window.sb` from a click handler directly.
- Menus, tooltips and dialogs go through `src/renderer/ui/overlays.tsx`; do
  not add another positioning scheme.
- Files open with a comment saying what the module is for and why it is
  shaped as it is. Keep that comment true when you change the module.
- A change a user can see gets a README or `docs/` update in the same
  change. A new or changed term goes in `CONTEXT.md`.

## Testing

- `bun test` runs under a sandbox `HOME` (see `test/setup.ts`), so it never
  reads or writes the real `~/.switchboard`. Keep it that way: tests that
  need a store create one in the sandbox.
- Tests named `*-live.test.ts` need real CLIs and sign-ins. They are skipped
  unless `SWITCHBOARD_LIVE_TESTS=1`.
- `test/claude-pty.node.cjs` runs under Node on macOS
  (`bun run test:claude-pty`) because it drives a real PTY.
- For UI work, run the Playwright scripts in `demo/` against the built
  window rather than trusting a screenshot of one state.

## Running from a checkout

- The app holds a single-instance lock. If `/Applications/Switchboard.app` is
  running, `bunx electron .` exits at once: quit the installed app first with
  `osascript -e 'tell application "Switchboard" to quit'`.
- Renderer changes need `bun run build` and a restart of the dev instance.
- `SWITCHBOARD_ROOT` points the store somewhere other than `~/.switchboard`
  for experiments.

## Commits and pull requests

- Commit messages say why, not only what; the diff already says what.
- CI must be green before merge. If it is red on formatting, run
  `bun run format` and push a formatting-only commit.
- Keep a PR to one change a reviewer can hold in their head. Design
  exploration happens elsewhere; the PR carries the decision.
