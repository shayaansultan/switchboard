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
- `src/buckets/`: proxy buckets, the local proxy and its worker.
- `src/opencode/`: the `oc` CLI for OpenCode profiles; runs without Electron.
- `src/remote/`: phone access. `model.ts` is the shared session model,
  `claude.ts` and `codex.ts` read each app's session files into it,
  `sessions.ts` lists, pages and watches them, `api.ts` is the tRPC router,
  `hub.ts` serves it and the phone app, `media.ts` signs and serves session
  pictures and files, `control.ts` is the socket the Claude plugin and the
  Codex tap (`codex-tap.ts`) reply and approve through, `push.ts` and
  `notify.ts` send notifications, `pairing.ts` and `status.ts` hold
  paired phones and what the CLI reports.
- `plugins/`: Claude Code plugins Switchboard loads into the Claude profiles
  it launches: `profile-band` (the coloured band) and `switchboard-remote`
  (replies and approvals from the phone).
- `src/phone/`: the phone app, React with TanStack Query, tRPC and Tailwind;
  `components/ui/` are shadcn components on Switchboard's tokens.
- `src/design/`: `tokens.css` (every colour and font, light and dark) and the
  font files, shared by the window and the phone app.
- `src/shared/`: time words and usage arithmetic shared by the window, the
  menu bar and the phone; the profile band keeps a tested copy of `pace`.
- `src/renderer/`: `app.tsx` (the window), `profiles.tsx`, `buckets.tsx`,
  `dialogs.tsx`, `ui/` (primitives, overlays, menus), one `style.css`.
- `test/`: Bun tests, one file per module. `demo/`: the fixture, the
  screenshot capture and the Playwright end-to-end scripts. `docs/`: design
  notes and the README images. `build/`: icons and packaging assets.

## The repository is public

Everything tracked, including tests, fixtures, docs and the app-owned agent
guide in `skills/`, ships to everyone. Never commit links into private chats,
real email addresses, home folders, client or employer names, signing
identities, or notes about one person's own setup (their accounts, their
school's services, what someone said in a private group). Fixtures use
example domains (`you@example.com`) and placeholder people (`me`, `someone`).
`test/public-repo.test.ts` fails on the common patterns; private names that
cannot be written down here go in `~/.config/switchboard/private-words`,
which that test also reads.

## Conventions the tools do not enforce

- Every colour is a token in `src/design/tokens.css`, shared by the window
  and the phone app, written `light-dark(light, dark)` so both values sit
  on one line. Never write a literal colour in a rule; add a token.
- The renderer only ever receives percentages, reset times, email, plan,
  the proxy's reason an account is unavailable, and usage-reset offers (id,
  title, count, expiry). A reset session stays in the main process; the
  window holds only the token that names it.
  Tokens and credentials are read in the main process, used once, dropped.
- Renderer buttons call the main process through `act()` in
  `src/renderer/lib.ts`, which handles the pending state and errors. Do not
  call `window.sb` from a click handler directly. The one exception is a
  dialog step that shows its own pending state and puts the error on screen,
  as the usage-reset dialog does when a reset is spent.
- Menus, tooltips and dialogs go through `src/renderer/ui/overlays.tsx`; do
  not add another positioning scheme.
- Files open with a comment saying what the module is for and why it is
  shaped as it is. Keep that comment true when you change the module.
- A change a user can see gets a README or `docs/` update in the same
  change. A new or changed term goes in `CONTEXT.md`.
- User-facing configuration and lifecycle features must also be available
  through a supported CLI command. Share the underlying operations between
  IPC and CLI callers, update CLI help and the app-owned agent guide, and
  verify the CLI path. Do not require agents to edit generated configuration
  or internal state files to perform an action the app supports.

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
- Those scripts start the app with `SWITCHBOARD_BACKGROUND=1`: the window is
  never shown, and the app stays out of the Dock and the menu bar and never
  becomes the active app, so a run does not take the screen or the Space
  someone is working in. Playwright still clicks, screenshots and records
  it. Set `SWITCHBOARD_BACKGROUND=0` to watch a run. A new script that
  launches the app passes the same variable.

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
