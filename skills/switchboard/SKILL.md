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

## Phone access

`switchboard remote sessions --working` lists the sessions in progress across every profile
(desktop sessions only unless `--all`); `remote session PROFILE ID` returns one transcript. Both
read session files and need no running app. `remote on|off`, `pair`, `devices` and `unpair`
manage what paired phones can see. Pairing codes and unpairing are the user's to ask for; do not
hand a code to anyone else. Publishing on the tailnet is the user's `tailscale serve` command,
which `remote status` prints; do not run it for them.

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

For SoCLaaS, configured allowances and equivalent usage are reporting/fair-use
settings, not subscription headroom or cash credits. The operators reported quotas
were not enforced on October 11, 2026: https://t.me/c/4345150434/6. Display that date
and attribution separately from refreshed `/api-key/budget` values. Continue to
handle HTTP 429 normally. The mutable-model announcement is
https://t.me/c/4345150434/7.

Codex routing remains explicit: `assign PROFILE BUCKET` affects that profile's next
desktop launch and `routed PROFILE`; `cli PROFILE` retains the native provider.
Create a separate profile with `add codex NAME` when isolation is requested;
it imports no other profile by default.
Use `unassign PROFILE` to restore native desktop routing. Neither operation replaces
Codex's auth.json. Check installed Codex profile syntax before writing configuration:
CLI 0.162.1 uses `--profile NAME` with `$CODEX_HOME/NAME.config.toml`, not the old
nested `[profiles.NAME]` table. Switchboard's launch overrides need no profile-file
edit. Preserve education logins and default routing unless explicitly asked.

API profile rows report API health, not the native OAuth login. Missing accounting
limits mean “not reported”, never zero usage or unlimited access. SoCLaaS's dated
non-enforcement report stays separate from configured allowances and HTTP 429.
The API adapter currently advertises no reasoning-effort choices; `oc effort`
rejects API profiles. A generic Codex “Medium” label is not evidence of upstream
thinking control. Verify capabilities before adding choices.
