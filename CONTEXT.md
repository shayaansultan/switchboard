# Switchboard: the language

The words the window, the CLI and the docs use for the same things. When a
label or a sentence needs one of these, use this word and no other.

## Vendor

Claude or Codex: a desktop app together with its command-line tool. The
window groups profiles by vendor. A vendor may be "not installed" on this Mac.

## Profile

One isolated home for a vendor: its own desktop window session and its own
CLI home, under a name and a colour of the person's choosing. A profile can
be launched, quit, opened in a terminal, renamed, reordered, removed, and, for
Codex, routed through a proxy bucket. Every vendor has a Default profile,
which uses the vendor's normal locations and cannot be removed or reordered.
A profile holds at most one account, and may hold none.

## App state

What a profile's desktop app is doing: **Off**, **Running**, or on its way,
**Starting…** after Launch and **Quitting…** after Quit. A quit the app has
not honoured after ten seconds is **Won't quit**, and offers **Force quit**.
With closed windows noticed, an app running with its window closed is
**No window**, and offers **Show**.
Use these words for the desktop app. "Stopped" is a proxy bucket's word, and a
window is a rate limit, so say "the app", not "its window".

## Account

A sign-in: the email address and the plan it carries. An account lives either
inside a profile (the CLI is signed in there) or inside a proxy bucket. The
same account may be signed in to several places at once. "Native account" on
a Codex profile means the profile's own sign-in, as opposed to a bucket.

## Connection

Where a Codex profile sends its model requests: its native account, or one
proxy bucket. Set from the profile's menu.

## Proxy bucket

A pool of accounts behind a local proxy. A Codex desktop profile, or
OpenCode, can route its model requests through a bucket, which picks the
account with the most headroom for each request. An account in a bucket can
be disabled: it stays signed in but takes no traffic.

## Window

A rate-limit window of an account: the 5-hour or 7-day allowance, sometimes
scoped to one model. A window has a percentage used and a time at which it
resets. The ring on a profile shows its fullest window.

## Session

One agent conversation: a Claude Code session or a Codex thread, in a
terminal or inside a desktop app. Not a window: a session counts against
whichever windows were open while it ran. Subagents belong to the session
that started them.

## Usage history

What Switchboard keeps so the Usage tab can look back: the **window history**
(every reading of every window, from the day recording began) and the **token
ledger** (tokens, models, folders and sessions read from each profile's own
agent logs). Say "recorded since", never "lifetime": Claude Code deletes its
logs after 30 days, so nothing older than the ledger exists.

## API-equivalent value

What an account's tokens would cost at API list prices, in dollars. An
estimate, and not a bill: a subscription does not charge per token. Always
labelled as such; never added to a window percentage.

## Pace

How far a window is ahead of or behind an even burn across it, in points: a
5-hour window 60% used halfway through is 10 ahead. Shown once 3% of the
window has passed.

## Plan

The subscription tier of an account, with its capacity relative to the
vendor's base plan: Max 20x, Pro 20x, Business 5x, Team. Capacity sizes an
account's share of a pooled bar and of a bucket's routing.
