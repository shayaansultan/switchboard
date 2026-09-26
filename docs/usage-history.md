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
the reset), and how fast the current window is filling (over its last hour, or
since it opened). A forecast appears when a window at 50% or more is on course
to reach 100% more than ten minutes before it resets.

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
  same usage, and copies responses into a new file when a session is resumed.
  Responses are counted once per message and request id, across all of a
  profile's files.
- Codex moves old rollouts into `archived_sessions/`; files are known by name,
  so a moved file is not read twice. Running totals are counted by how much
  they rose. A subagent's rollout starts by replaying its parent's history,
  which is skipped.
- A line still being written is left for the next pass.
- Agent time is the time from each prompt or response to the next response
  in a session. A gap longer than five minutes is a pause, not work, and is
  not counted.

What is kept, in `~/.switchboard/usage/ledger.json`: totals per day, model and
folder for 400 days, and per session (title from its first prompt, folder,
tools used, files edited, value per five-minute slot) for 90 days. Claude Code
deletes its own logs after 30 days by default, so the ledger is the only record
of anything older. The tab says "recorded since", never "lifetime".

## Value

`src/history/prices.ts` holds list prices per million tokens for the current
Claude and OpenAI coding models, from models.dev as of 24 September 2026.
Claude's one-hour cache writes are charged at twice the input price; OpenAI
charges nothing for cache writes. Long-context surcharges and fast-mode prices
are not applied, so very long requests read low. A model the table does not
know is counted as unpriced tokens rather than guessed.

The value is what the same tokens would cost on the API. Subscriptions are not
billed that way; it is a way to compare accounts and weeks, not a bill.

## Sessions and windows

The Sessions view groups each profile's sessions by the window they spent most
of their time in, using the profile's shortest window (the 5-hour one where
there is one). A session's share of its window is the window's peak split among
its sessions by their value inside it: an estimate, since the vendors do not
say how a window's percentage is made up. Sessions no window history covers are
grouped by day.

## What crosses to the window

The report the renderer receives holds counts, dollar estimates, model names,
session titles, tool names, edited file names relative to their folder, and
folder names (with the parent added where two share a name). Full paths,
transcripts and the ledger itself stay in the main process; Resume, Open folder
and Show transcript ask the main process by session id.
