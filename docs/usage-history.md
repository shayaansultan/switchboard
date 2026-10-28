# Usage history

The Usage tab and `switchboard tokens` show what Switchboard has recorded about
each account: every reading of its rate-limit windows, and the tokens its agent
sessions used. This note says where that comes from, how it is kept, and where
it can be wrong.

## Two sources

**Window history.** Each time Switchboard polls a profile (see "Usage requests"
in the README), the windows it gets back are appended to
`~/.switchboard/usage/windows-YYYY-MM.jsonl`, but only when they differ from the
last reading. A window instance is one window between resets: readings that
share a label and a reset time. From these the tab works out when a window ran
out and how long the account waited (from the reading that first said 100% to
the reset, counting once the time two of its windows were full together).

Pace is the one Switchboard shows everywhere, from `src/shared/usage.ts`: the
profile band, the phone and this tab all ask whether a window lasts to its
reset at the rate it has been used since it opened, and say nothing in its
first tenth. The tab adds how many points ahead of or behind an even burn
that is, and its warning appears exactly when that pace says a window runs
out before it resets, naming when.

A notification comes when a window reaches 90% (naming the day of the reset
when it is not today, and the profile of the same vendor with the most room,
on another account) and when a window that was at 90% or more resets. An
account signed in to several profiles is told once per window.

Window history starts the day you update. There is nothing to backfill it from.

**Token ledger.** Claude Code and Codex log every response with its token
counts, in the profile's own home:

| Vendor | Files                                                                                        | What each response carries                                                                                                                                       |
| ------ | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude | `<CLAUDE_CONFIG_DIR>/projects/<folder>/<session>.jsonl`, subagents in `<session>/subagents/` | `message.usage` (input, output, cache read, cache write with its 5-minute and 1-hour parts), model, timestamp, session, folder, entry point                      |
| Codex  | `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl` and `archived_sessions/`                  | `token_usage_record` per response on newer builds; running `token_count` totals on older ones; the model from `turn_context`; the folder from the session header |

Because every profile has its own home, every log is already the right
account's. The desktop apps' own agents write to the same homes, so their
coding sessions are counted too. Ordinary chats in the desktop apps, on the web
or on a phone leave no local log: they show in the windows and nowhere else.

## Reading the logs

`src/history/ledger.ts` reads only what each file gained since the last pass,
a few megabytes at a time with a pause in between, so the first pass over a
large history does not stall the app. It runs after each poll and when the
Usage tab opens (at most once a minute), and the tab is told when there is
something new.

- Claude Code writes a response once per content block, each copy carrying the
  same usage, and copies the earlier conversation into a new file when a
  session is resumed. Responses are counted once per message and request id,
  and prompts, tools and edited files once per line id, across all of a
  profile's files. These ids are kept for as long as a log that could hold
  them is (down to the earliest line of the oldest log present, and at most
  90 days, as long as sessions are kept), so a session resumed weeks later is
  still not counted twice.
  Files are read oldest first, so a line counts in the session that first
  wrote it. Tool results, the bulk of a transcript, are skipped unread, and an
  interruption ("[Request interrupted by user]") is not a prompt.
- Codex moves old rollouts into `archived_sessions/`; files are known by name,
  so a moved file is not read twice, and its sessions' transcript follows it.
  Running totals are counted by how much they rose. A prompt is a user
  message, less the context Codex adds (AGENTS.md, the environment). A
  subagent's rollout names itself, then replays its parent's history
  (parent's header included), which is skipped; its usage counts toward the
  root session as subagent work.
- A line still being written is left for the next pass. A file that cannot
  be read (removed since it was listed, or not readable by you) is left where
  it stopped and tried again next pass; the rest are read regardless.
- Agent time is the time from each prompt or response to the next response
  in a session: the agent thinking, running tools, waiting on a subagent. The
  time before a prompt is not counted, and no single step counts for more
  than half an hour, so a permission prompt left overnight is not a night's
  work.

What is kept, in `~/.switchboard/usage/ledger.json`: totals per day, model and
folder for 400 days, and per session (title from its first prompt, folder,
tools used, files edited, value per five-minute slot) for 90 days, plus how
far each log has been read and the ids above. Claude Code deletes its own logs
after 30 days by default, so the ledger is the only record of anything older.
The tab says "recorded since", never "lifetime".

For the same reason nothing in the ledger is thrown away lightly:

- A ledger the app cannot use (from another version, or damaged) is copied to
  `ledger.json.unreadable-<time>` before a new one is started from whatever
  logs remain. `switchboard tokens` reports no history until the app has
  written one it can read.
- A profile that is removed keeps its totals, which stay in the Usage tab's
  figures; its sessions go. Should it come back, its logs are not counted
  again. A profile whose home moves keeps its totals and starts reading the
  new home, without counting again logs that moved with it.

## Value

Prices are list prices per million tokens from models.dev. Once a day the app
fetches its catalogue (`https://models.dev/api.json`, a public file; nothing is
sent) and keeps Anthropic's and OpenAI's part in
`~/.switchboard/usage/prices.json`, which the CLI reads too. Until that has
worked once, `src/history/prices.ts` has a bundled table from 26 September 2026. Tokens recorded while their model had no price are valued as soon as it
has one. `SWITCHBOARD_PRICES=bundled` keeps to the bundled table.

Claude's one-hour cache writes are charged at twice the input price; OpenAI
charges nothing for cache writes. Long-context surcharges and fast-mode prices
are not applied, so very long requests read low. A model neither list knows
(an internal model such as `codex-auto-review`) is counted as unpriced tokens
rather than guessed.

The value is what the same tokens would cost on the API. Subscriptions are not
billed that way; it is a way to compare accounts and weeks, not a bill.

Each profile can carry its plan's price, in dollars a month, set from the
Overview's account list or `switchboard plan-price PROFILE 200` (`none` clears it). The
Overview spreads it over the range (a 30-day range is 30 / 30.44 of a
month) and shows the account's value as a multiple of it. No price is filled
in for you: team and business seats vary, and a stale list price would make
every multiple wrong.

## The overview

The Overview counts the sessions that started in the range, so its four
measures (value, tokens, agent hours, sessions) describe the same work; the
`switchboard tokens` totals count tokens on the day they were used, so the two
can differ a little at the edges of a range. A session is yours when it began
in a desktop app, a terminal or an editor, and an automation's when the logs
say a headless run started it (Claude Code's `sdk-*` entry points, Codex's
`exec`). Its repository is the folder holding the nearest `.git` above its
folder; a worktree's `.git` file names the checkout it belongs to. Folders in
`/tmp`, `/private/tmp` and `/var/folders` group as Scratch, and a folder
outside any repository is named by where it sits under your home folder.
Only the names reach the window.

## Weekly digest

Last week, Monday to Sunday, from the same report as the tab: value, agent
time, sessions, each limit hit and the time waited, the busiest day, the top
project and model, and each account against its plan. `switchboard digest`
prints it; the **Weekly digest** setting sends it as a notification from 9:00
on Monday (or when the Mac next polls that week), once two weeks are recorded
so the first is not a partial week. Which week was last handled is kept in
`~/.switchboard/usage/digest.json`.

## Sessions and windows

The Sessions view groups each profile's sessions by the window they spent most
of their time in, using the profile's shortest window (the 5-hour one where
there is one). A session's share of its window is the window's peak split among
its sessions by their value inside it: an estimate, since the vendors do not
say how a window's percentage is made up. Sessions no window history covers are
grouped by day.

## What crosses to the window

The report the renderer receives holds counts, dollar estimates, model names,
session titles, tool names, edited file names (relative to the session's
folder, or the bare name for a file outside it), and folder names (with the
parent added where two share a name). Full paths,
transcripts and the ledger itself stay in the main process; Resume, Show folder
and Show transcript ask the main process by session id. Show folder and Show
transcript reveal the path in Finder and never open it: the path comes from a
log file, and opening an app bundle or installer package would run it.
