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

## Plan

The subscription tier of an account, with its capacity relative to the
vendor's base plan: Max 20x, Pro 20x, Business 5x, Team. Capacity sizes an
account's share of a pooled bar and of a bucket's routing.
