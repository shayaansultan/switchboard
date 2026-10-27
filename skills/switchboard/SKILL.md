---
name: switchboard
description: Operate Switchboard from the terminal. It keeps Claude and Codex accounts signed in side by side as profiles, tracks each one's rate-limit headroom, and runs commands inside a chosen account. Use when a task needs a particular Claude or Codex account, asks which account has quota left, runs `claude` or `codex` for a specific account, opens or quits a profile's desktop window, or touches a proxy bucket.
---

# Switchboard

A **profile** is one signed-in Claude or Codex account with its own isolated home under
`~/.switchboard`. The `switchboard` command is the agent surface for all of it; `switchboard
--help` lists every command, so this file only carries what `--help` cannot tell you. OpenCode
profiles are a separate thing with their own `oc` command.

## Reading results

A command that succeeds prints its result as JSON on stdout and exits 0. One that fails prints
nothing on stdout and one JSON object on stderr, `{"error": CODE, "message": …, "hint": …}`, and
exits 2 (usage), 3 (not found), 4 (refused by a safety rule) or 1 (ran and failed). Branch on the
code, not the message; the hint is usually the command that unblocks. `exec` and `cli` exit with
the child's own status. `guide` prints this skill as Markdown. `--human` prints tables for the list commands when the user is reading.

Per-profile usage is data inside a successful result, never an exit code, with a `status` of
`ok`, `stale` (numbers present but old or from a failed refresh), `not-signed-in`, `error` or
`none` (nothing known yet).

## Naming a profile

By id (`claude-work`), by vendor alone (`claude` is that vendor's Default profile), by
`vendor/name`, or by a name only one profile has. An ambiguous name fails with the candidates;
`switchboard list` shows what exists.

## Choosing an account

`switchboard pick claude` answers "which Claude account should this job run on": the signed-in
profile whose tightest rate-limit window has the most left, with the ranked candidates and the
excluded ones with reasons. `--window 7d` judges by one window; `--min-headroom 30` drops profiles
below a floor. Numbers come from the app's cache, which it refreshes on its own; add
`--max-age 15m` to fetch live only for entries older than that. `--refresh` hits the vendors'
usage endpoints for every profile, so use it once when freshness matters, never in a loop.

## Usage history

The app keeps every window reading and indexes each profile's Claude Code and Codex logs.
`switchboard tokens [--days 30] [--by account|model|project|day]` reads what it recorded;
`switchboard digest` is last week, Monday to Sunday, with each account's value against its plan
price. Dollars are API-equivalent estimates, not a bill. `switchboard plan-price PROFILE 200`
sets what a plan costs a month (`none` clears it); never set one the user did not give you.
Both read only what the app last wrote: `no-usage-history` means the app has not run since an
update.

## Running inside an account

`switchboard exec PROFILE -- claude -p "…"` runs any command with that profile's home in its
environment; `switchboard cli PROFILE …` is the same with the vendor's own CLI prefixed, and
everything after the profile belongs to that CLI. `eval "$(switchboard env PROFILE)"` moves the
current shell into the profile. The Default profile clears the variable, so a nested call from
another profile's shell cannot leak.

## Windows and buckets

`launch` and `quit` open and close a profile's desktop window. A profile's first sign-in needs
every other window of that app closed (`quit-others`), because macOS delivers the sign-in link to
whichever window it picks. Buckets are pools of accounts behind a local proxy that a Codex desktop
profile can route through: `bucket list` shows each account's headroom, `assign` routes a profile
and takes effect on its next launch.

`focus PROFILE` shows that profile's existing window and refuses when it is
not running; it never launches another profile. `quit PROFILE --force --yes`
uses the same force quit as the window, waits, and reports `quit` and `stopped`.
It loses unsaved work, so use it only after authorization. A false `stopped`
is not a successful shutdown. Ordinary quit remains available without the app.

`caffeinate status|start [--minutes N] [--lid]|extend [--minutes N]|stop|dismiss|cancel|clear`
shares the running app's Caffeinate. `start` keeps the Mac awake N minutes
(default 60; 0 until `stop`) with the screen on, and `--lid`
keeps a closed laptop awake through the system helper, ending by itself below
20% battery or in serious heat. `--lid` may need the user to allow the helper
in Login Items (`notice: needs-approval`, `queued: true`); leave that to the
user. `clear` turns system sleep back on when something outside Caffeinate
left it off (`sleepDisabledElsewhere`); it may ask for a password. Read
`active`, `endsAt`, `lid`, `stop` and `notice` in the result, not just exit 0.
`fans status|set LEVEL [--minutes N]|extend [--minutes N]|system|cancel|dismiss|install|remove`
shares the running app's fan control. `set` boosts every fan to LEVEL% (0-100,
steps of 5) for N minutes (default 15; 0 runs until `system`); `extend` adds
minutes to a timed boost. The helper ends a boost on sleep, restart, quit,
heat or the time limit, and the result's `stop` says why. A first `set` or
`install` needs the user to allow the helper in Login Items (`notice:
needs-approval`, `queued: true`; the boost starts once allowed, and `cancel`
drops it); leave the approval to the user. Read `status`, `level`, `endsAt`, `stop` and `notice` in the result,
and `unavailable` with its `reason` (`no-fans`, `unsigned`, `not-packaged`).
`accessibility status` reports permission under the running Electron app's
identity. `accessibility open` opens the macOS pane when the user asks to
change permission. These commands, focus and forced quit need the matching
running app; `app-unavailable` means open it or update an older app.

`export PROFILE --format t3` outputs a credential-free `providerInstances`
fragment: driver `claudeAgent` for Claude or `codex`, display name, accent
colour and the actual home path. It never writes T3 settings. Proxy-routed
Codex export refuses rather than exporting the native account. Use a native
profile for export or `routed` for requests through a bucket.

`oc remove PROFILE --keep-bucket|--delete-bucket --dry-run` previews removal.
Either mode deletes OpenCode settings, sessions, history and connections, so
both need confirmation or `--yes`. Keep preserves the bucket's accounts,
keys, upstream settings and Codex routing as a standalone bucket; it stops
the worker and clients must reconnect. Delete also removes the bucket and
unassigns its routed profiles. External homes and sign-ins referenced by
connections are untouched. Quit OpenCode tools and routed desktop apps first.

## Phone access

`switchboard remote sessions --working` lists the sessions in progress across every profile
(desktop sessions only unless `--all`); `remote session PROFILE ID` returns one transcript. Both
read session files and need no running app. `remote on|off`, `pair`, `devices` and `unpair`
manage what paired phones can see. Pairing codes and unpairing are the user's to ask for; do not
hand a code to anyone else. `remote publish` publishes the hub on the user's tailnet with
`tailscale serve`, which changes their Tailscale setup, so run it only when they ask; when Tailscale
wants Serve allowed first it refuses with the link to open. Replying and approving happen on the
phone itself; with phone access on, launch desktop profiles from Switchboard (`switchboard launch`)
so the phone can reach their sessions. `remote status` lists running apps the phone can only watch
(`unreachable`); `remote relaunch PROFILE` quits one and reopens it with the hook, which stops what
it is running, so it is the user's to ask for. `settings set phoneDefaultClaude true` lets Default
Claude take replies however it was opened, by adding two entries to `~/.claude/settings.json`; it
is the user's choice, not a fix to apply for them. `remote notifications` lists what each phone is notified
about; `remote notifications DEVICE_ID --kinds needs,finished,errored,limits`, `--sessions desktop|all`
(whether terminal, IDE and scripted sessions notify; desktop only by default), `--off` and `--test`
change one phone. A phone turns notifications on from its own Settings; changing or testing them is
the user's to ask for.

## Usage reset grants

`switchboard resets PROFILE` lists vendor-issued reset grants for the native account,
even when that profile routes through a proxy. `switchboard bucket resets BUCKET ACCOUNT`
lists grants for the selected proxy account (exact name or unambiguous email).
Listing is read-only. To spend a specific grant, add `--redeem GRANT_ID`; use `--yes`
only after the user explicitly authorizes spending that reset. A quota problem by itself
is not authorization. Preserve credits during verification unless spending is requested.

Read JSON `outcome`, not just exit 0: `reset` confirms redemption; other outcomes describe
why no reset occurred. `proxyRecovery` is `not-needed`, `refreshed`, `deferred` or
`unconfirmed`. A confirmed vendor reset clears that proxy account's local cooldown,
then refreshes usage and routing weight. A delayed or failed refresh is not a reason
to spend another reset. Older running workers need a restart before redemption;
get approval before interrupting routed clients. For an uncertain write, check the
vendor's Usage page before retrying; Switchboard retains its pending request ID.

## What stays with the user

- `remove`, `quit-others` and `bucket stop` refuse without `--yes`: remove deletes the profile's
  directory tree, and the other two interrupt windows and clients that may be mid-work. Pass
  `--yes` only when the user asked for exactly that action.
- `login` and `bucket login` open a terminal with the vendor's sign-in; the user completes the OAuth
  step. Report the profile as `not-signed-in` and stop rather than retrying sign-in yourself.
- `profiles.json` under `~/.switchboard` is written only through the command, which takes the
  same lock the app takes; the app reloads within a second. Editing it by hand races both.

## API upstream buckets

An API bucket uses one Responses-compatible service and a credential-file reference,
with its own loopback API key. It has no subscription accounts or provider fallback.
Use `bucket create-api` with the exact upstream URL, literal credential variable,
and an advertised model ID; `--opencode` creates the dedicated isolated OpenCode
profile at the same time. `bucket inspect-api` refreshes the full model catalogue
and key-specific accounting without starting a worker. The UI can create API
buckets and refresh their observations, and never asks for the key itself.

Credentials stay outside Git. The credential file must be private (mode 600) and
contain exactly one literal assignment for the named variable, optionally with
`export`. It is parsed, never executed. Generated worker configuration is mode
600 and removed on a clean stop. API workers suppress request/error-body logging.

`bucket credential BUCKET PATH VARIABLE` changes the reference only while the
bucket is stopped. To rotate the key at the same path, replace the file securely,
then stop and start only that bucket after approval. Workers hold their key and
routing catalogue until restart. Refresh updates observations; it does not rotate
keys or reload routing. A missing key or failed discovery prevents a fresh start.
Existing clients must relaunch after a restart because the loopback port changes.
If a bucket's original default model is retired, stop the bucket and use
`bucket model BUCKET ID` to set an advertised replacement. The OpenCode default
is selected separately with `oc model PROFILE ID`; neither needs state-file edits.

Model IDs are opaque. Preserve colons, slashes and aliases exactly. Discovery keeps
all service metadata; coding clients list chat models. Capability metadata is not
a guarantee of every client's tools, reasoning, vision or context handling.
Mutable aliases retain their names. `x-test-1` is experimental/mutable, never a
stable model identity; use an explicit per-run selection instead of a default for
reproducible experiments. A mutable default requires `--allow-mutable-default`.

An API bucket's configured allowances and equivalent usage are reporting or
fair-use settings, not subscription headroom or cash credits. Whether a service
enforces them is unknown; handle HTTP 429 normally.

Codex routing remains explicit: `assign PROFILE BUCKET` affects that profile's next
desktop launch and `routed PROFILE`; `cli PROFILE` retains the native provider.
Create a separate profile with `add codex NAME` when isolation is requested;
it imports no other profile by default.
Use `unassign PROFILE` to restore native desktop routing. Neither operation replaces
Codex's auth.json. Check installed Codex profile syntax before writing configuration:
CLI 0.162.1 uses `--profile NAME` with `$CODEX_HOME/NAME.config.toml`, not the old
nested `[profiles.NAME]` table. Switchboard's launch overrides need no profile-file
edit. Preserve existing logins and default routing unless explicitly asked.

API profile rows report API health, not the native OAuth login. Missing accounting
limits mean “not reported”, never zero usage or unlimited access.
The API adapter currently advertises no reasoning-effort choices; `oc effort`
rejects API profiles. A generic Codex “Medium” label is not evidence of upstream
thinking control. Verify capabilities before adding choices.
