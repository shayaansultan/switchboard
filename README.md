# Switchboard

**Run multiple Claude accounts at the same time on one Mac, and multiple
ChatGPT or Codex accounts too.** Two, or as many as you have memory for. Keep a
personal account and a work account both signed in, in their own desktop windows
and their own terminals, instead of logging out and back in every time you
switch. Each account also gets a live rate-limit bar, so you can see which one
has headroom left before you start.

![Switchboard showing four accounts, each with its own usage bars](docs/screenshot.png)

It is for accounts you own. Native profiles use their own account. Codex desktop
profiles can also use a shared proxy bucket, which selects accounts and handles
inference quota failover. See [Proxy buckets](docs/proxy-buckets.md).

## Can you run two Claude accounts at once? Or more?

Yes to both, and the same goes for Codex. There is no limit built in. Both
desktop apps are Chromium-based, so each account gets its own user-data
directory and runs as a genuinely separate window with its own session. The
command-line tools are separated the same way, with an environment variable per
account.

Each profile is isolated twice over, because the two halves hold different
state. Both desktop apps embed an agent that reads the same config-home
variable the command-line tool does, so the flag alone is not enough.

| App    | Signed-in session             | Agent home: sessions, plugins, config |
| ------ | ----------------------------- | ------------------------------------- |
| Claude | `--user-data-dir=<…>/desktop` | `CLAUDE_CONFIG_DIR=<…>/home`          |
| Codex  | `--user-data-dir=<…>/desktop` | `CODEX_HOME=<…>/home`                 |

Every account is a profile owning an isolated directory tree under
`~/.switchboard/<vendor>/<profile>/`. Profiles never share cookies, tokens,
chat history or session state, and you can run as many at once as you have
memory for.

The "Default" profiles point at the normal locations, `~/.claude`, `~/.codex`
and `~/Library/Application Support/{Claude,Codex}`. Switchboard never writes to
them itself.

## Does it work with Claude Code and the Codex CLI?

Yes. Each profile gets its own CLI login, and the **Terminal** button opens a
shell already inside that account, so `claude` or `codex` in that window uses
it. The copy icon on each profile copies the one-line command, which can go into an alias.

Profiles show as a list or as cards; pick either with the toggle above them.
Drag a profile to reorder it within its app; the Default profile stays first.

Signing a profile's CLI in is also what enables its usage bars.

## What are the rate-limit bars?

Every window the account has: the 5-hour and 7-day windows for Claude,
including model-scoped ones such as a separate Opus pool, and the weekly and
model-specific pools for Codex. Each shows how much is used, or how much is
left if you prefer, with the time until it resets. They turn amber and then red
as a window runs out.

You can read them in the menu bar without opening the window.

## Is the app running?

Each profile shows whether its desktop app is running: a green dot in the list,
a pill on a card, and "(not running)" after its line in the menu bar. It keeps
up on its own. Launching or quitting an app from anywhere, the Dock, Cmd+Q or
the `switchboard` command, shows up within about a second, so there is no need
to press Refresh, which is for the usage numbers.

Launch is the black play button and Quit the red power button. While one is on
its way the button spins and the profile reads **Starting…** or **Quitting…**.
An app still running ten seconds after Quit reads **Won't quit**, usually
because it is asking you to confirm; switch to the app and answer it, or use
**Force quit**, which loses anything unsaved in it.

Closing an app's window with its red button leaves the app running. Turn on
**Notice closed windows** in Settings and such a profile reads **No window**,
with a hollow dot, instead of Running. This needs Accessibility permission,
which Switchboard asks for when you turn it on; because the app is ad-hoc
signed, macOS forgets it after each rebuild, and the setting then shows a
Grant access link. A window that is minimised, hidden or on another desktop
still counts as open. Whether or not the setting is on, **Show window** (a
button on a No window row, and in each running profile's menu) brings that
profile's window back, as clicking its Dock icon would.

## Keep the Mac awake

Use **Keep awake** beside Refresh to turn macOS's system sleep setting on or
off. macOS handles administrator authorization. The control reads the actual
setting, including after you reopen Switchboard; closing or crashing the app
leaves the setting as you chose it.

For implementation details and closed-lid hardware verification, read
[Keep awake](docs/keep-awake.md).

## Requirements

- A macOS whose `open` supports `--env`, which is how a profile's config home
  reaches the app. Confirmed on macOS 26; I have not established the earliest
  version that carries the flag, so check with `man open` if you are on
  something older.
- Claude Desktop, the ChatGPT app, or both, installed in `/Applications`.
  Other locations are not detected yet.
- The `claude` or `codex` CLI for the usage bars. Switchboard asks your login
  shell for its environment, so a version manager such as nvm, fnm, volta or
  mise is fine, and so is fish or bash rather than zsh.
- Apple Silicon has been tested. Intel should build, but has not been tried.

## What it reads, and what leaves your Mac

Worth knowing before you run an unsigned app that touches your accounts.

- **Your keychain.** To show Claude usage, Switchboard runs `security
find-generic-password` for the entry the Claude Code CLI already created.
  macOS will ask for your password the first time. It asks again after each
  rebuild, because ad-hoc signing produces a new code hash and the keychain
  entry's permission no longer recognises the app. Codex tokens are read from a file
  instead, so they produce no prompt.
- **App launches and quits.** A small helper bundled with the app listens for
  macOS's notice that some app started or stopped, so the window can show a
  profile's app opening or closing at once. It reports only the process and
  its path, to Switchboard alone, and exits with it.
- **Other apps' windows, only if you turn on Notice closed windows.** The
  helper then counts the Claude and ChatGPT windows each profile has open,
  through the Accessibility API and an undocumented macOS call that says which
  desktop a window is on. It reads counts, not window contents.
- **Usage requests per signed-in profile, on a timer.** Normally one call to the same endpoints
  the two CLIs use for their own usage screens, authorised with that profile's
  existing CLI token. The interval in Settings is the rate while you are using
  Switchboard; left alone it slows to every 15 and then 30 minutes, never
  polls faster than the setting on battery, and stops while the Mac is asleep
  or locked. Who is signed in is only re-checked hourly, on a manual refresh,
  or when a usage call says the token is gone. Codex tries a second URL only if the first answers 404.
  Neither endpoint is documented by its vendor, so both can change without
  notice and the bars can go blank. Claude usage may retry once after a token
  change. Switchboard has no telemetry; the Claude CLI has its own network
  behaviour when started for session renewal.
- **Tokens never leave the main process.** They are read, used for that one
  request, and dropped. What the window receives is the profile's own name and
  colour, its directory paths and the CLI command to enter it, whether the app
  is running, and from the account: the email address, plan name, organisation
  name, and the usage percentages with their reset times.
- **Never credentials.** Switchboard does not write logins, and it will not copy
  API keys or credential helpers between profiles. When a Claude subscription
  token expires, Switchboard briefly starts Claude Code in an isolated empty
  directory so the CLI can renew that profile's OAuth session, then rereads the
  credential and fetches usage. The hidden terminal uses macOS `/usr/bin/expect`,
  safe mode, no tools or MCP servers, and no model prompt. Only the trust menu
  for that empty directory is accepted. Recovery has a 20-second deadline plus
  bounded process cleanup; failed attempts have a one-minute cooldown.
  If Claude requires interactive sign-in, renewal stops and the profile must
  be opened in Terminal. A rejected token that has not expired also requires
  sign-in, unless another CLI has already replaced it.

## Install

```bash
bun install
bun run install-app
```

That builds `Switchboard.app`, copies it to `/Applications`, ad-hoc signs it and
opens it. Launch it like any other app afterwards. Re-run the same command after
changing the source. For a dev run without installing, use `bun start`.

The app is not signed with a Developer ID and not notarised, so macOS may warn
about it. Building it yourself, as above, is the intended path.

It also lives in the menu bar with launch, quit and usage per profile, so you
can close the window and leave it running. Settings has an "Open at login"
switch; started that way it stays in the menu bar until you click it.

## Adding an account

1. Click **+ Profile** in the Claude or Codex panel and name it, then choose
   which existing profile to start from and what to bring over.
2. Click the launch button (the filled play icon on the row). A fresh window
   opens with no session. Quit the other windows of that app first, using the
   "Quit others now" link on the card. The sign-in link is delivered to
   whichever window macOS picks.
3. Click **Sign in CLI** on the card's warning line (or in its **⋯** menu). A
   terminal opens running `claude auth login` or
   `codex login` inside that profile. This is what enables the usage bars.
4. The terminal icon opens a shell already inside the profile, in whichever terminal
   you choose in Settings. Terminal.app, iTerm2, Ghostty, Warp, kitty, Alacritty
   and WezTerm are supported, and only the installed ones are listed.

**Remove** on a card deletes the profile and everything under its directory:
the CLI login, the desktop session, history and settings. There is no way to
remove a profile and keep its data. The Default profiles cannot be removed.

### Keep in sync, or copy once

Items you bring over can be linked or copied, and the difference matters.

**Keep in sync** makes the new profile's file a symlink to the source profile's.
One edit then applies to both, which is the point for skills you maintain in one
place. It also means the reverse: if the second account's agent rewrites a file,
for example when it updates `CLAUDE.md` or `AGENTS.md` from a memory shortcut,
that write lands in the source profile too. Choose **Copy once** for anything you
want the two accounts to be able to change independently.

Chat history is always copied, never linked, because two accounts writing into
one session folder would corrupt each other's resume lists. For Codex it also
carries the sidebar's project list and which project each thread sits in, since
the app keeps that separately from the sessions and would otherwise show the
threads unplaced or, for ones run in worktrees, not at all.

Logins, memories and session state are never brought over at all. Connectors and
plugins are offered but off by default, because they reach the source account's
Slack, Notion and so on.

## Driving Switchboard from a terminal or an agent

Everything the window does is also a `switchboard` command, with results as
JSON so an agent can read them and a person can pipe them into `jq`. The
common questions have one-line answers:

```bash
switchboard list                      # profiles, running state, signed-in account
switchboard usage --max-age 15m       # rate-limit windows, refreshed if older than 15 minutes
switchboard pick claude               # the Claude profile with the most quota left
switchboard exec work -- claude -p "…"   # run anything inside a profile's account
eval "$(switchboard env work)"        # put the current shell into a profile
switchboard launch work               # open its desktop window
switchboard add codex Client --from codex   # a new profile, set up like the Default
```

Install it from the **CLI** tab in the window, or once with
`switchboard install-cli` (or `node out/cli.js install-cli` from this checkout)
after `bun run install-app`. The command runs on the
installed app's own runtime and code, so it is always the same version as the
app, and `bun run install-app` updates both. `bun run cli -- list` runs it from
source without installing.

Profiles are addressed by id (`claude-work`), by vendor (`claude` means that
vendor's Default), by `vendor/name`, or by a name that only one profile has.
`switchboard --help` lists every command.

The contract, for anything that parses the output: a successful command prints
its result as JSON on stdout and exits 0. A failed one prints nothing on stdout,
one JSON object on stderr with a stable `error` code, a `message` and usually a
`hint`, and exits 1 (it ran and failed), 2 (usage), 3 (not found) or 4 (refused
by a safety rule, such as removing a profile whose window is open, or
`--yes` missing). `exec` and `cli` exit with the child's own status. Per-profile
usage errors are data inside a successful result, with a `status` of `ok`,
`stale`, `not-signed-in`, `error` or `none`.

The CLI reads the app's cached usage numbers by default and fetches live only
with `--max-age` or `--refresh`; it never polls. It writes `profiles.json`
directly, and a running app notices and reloads within about a second, so the
window and the command line never disagree about which profiles exist.

## Caveats

- Neither vendor supports any of this. An update to either app could break the
  `--user-data-dir` flag or the usage endpoints. The Default profiles keep
  working regardless.
- Launch extra profiles from Switchboard rather than from the Dock. A Dock
  launch carries neither the flag nor the variable, so it opens the Default
  profile regardless of which window you meant.
- Codex and ChatGPT are the same `ChatGPT.app` bundle, and every profile
  launches that one bundle, so an update to it applies to all of them. macOS
  registers each instance separately, which means one Dock icon per running
  profile rather than one for the app.
- Claude token renewal depends on the installed CLI's interactive startup
  behaviour and may break after a CLI update. If automatic renewal reports that
  sign-in is required, open that profile in Terminal and sign in there.
  Organisation-managed Claude policies can still affect this isolated startup.
- `ANTHROPIC_API_KEY` in your shell makes Claude Code bill the API instead of
  your subscription. Switchboard never sets it; check your own shell config.

## Development

The source is TypeScript. The main process is compiled by `tsc` into `out/`,
which is what Electron runs. The window is a small Preact app under
`src/renderer/`, bundled by `bun build` into `out/renderer/main.js`; its
styling is one stylesheet of tokens and primitives modelled on Wispr Flow, with
Figtree and EB Garamond bundled. Tests import the `.ts` files directly.

```bash
bun test          # profile isolation, setup logic and the usage parsers
bun run test      # the same, after oxlint and a type check
bun run test:claude-pty # compiled PTY integration checks under Node, on macOS
bun run typecheck # tsc --noEmit
bun run lint      # oxlint
bun format        # oxfmt; bun run fmt is also supported (CSS/HTML excluded by config)
bun start         # build, then run without installing
bun run demo      # regenerate the screenshot and social card from invented accounts
bun run icons     # re-render the icon PNGs from build/icon.svg
```

The screenshot is produced by rendering the app's own UI against
[`demo/fixture.js`](demo/fixture.js), so it never contains anyone's real
accounts and stays current when the interface changes.

## OpenCode terminal profiles

The terminal-first `oc` CLI adds isolated OpenCode profiles with separate service
connections and per-profile ChatGPT account pools. It runs without the Electron
app. See [OpenCode profiles](docs/opencode-profiles.md) for installation, selective
imports, the six service adapters, routing behaviour, and verification.

MIT licensed. See [LICENSE](LICENSE).
