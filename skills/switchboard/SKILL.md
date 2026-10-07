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
