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
be disabled: it stays signed in but takes no traffic, or removed: the
bucket's sign-in for it is deleted. Removing a bucket stops its worker,
deletes its accounts' sign-ins and moves the profiles routed through it back
to their own sign-in. A bucket stored with an OpenCode profile is that
profile, so removing the bucket removes both. Removing the OpenCode profile
instead asks what happens to its bucket: kept, the bucket's accounts, keys
and upstream settings become a standalone bucket of the same name and the
profiles routed through it stay routed; deleted, it goes as above. Either way
the profile's settings, sessions, history and connections are deleted, and
the Codex homes and native sign-ins its connections point at are not. An account is unavailable when the proxy
reports an error it will not retry by itself, such as a token that expired
and could not be renewed; the proxy's reason is shown with it. An account
out of quota is not unavailable in this sense: its bars show why it rests.

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

## Plan price

What an account's plan costs a month, in dollars, as its owner set it. Never
filled in from a list: the Usage tab sets API-equivalent value against it and
says nothing where it is not set.

## Weekly digest

Last week, Monday to Sunday, summed up from the usage history: in
`switchboard digest`, and as a Monday notification once two weeks are
recorded.

## Pace

How far a window is ahead of or behind an even burn across it, in points: a
5-hour window 60% used halfway through is 10 ahead, and on course to run out
before it resets. Every surface takes it from `src/shared/usage.ts` and says
nothing in a window's first tenth.

## Profile band

The bar in a profile's colour that Switchboard has every Code session of a
Claude profile's app draw above the prompt: the profile's name, its plan, the
session's context fill and cost, and for each window how much is left, when it
resets and whether it will last until then (its pace). The Default profile's
app has none. Call it the profile band, not a banner or a header.

## Plan

The subscription tier of an account, with its capacity relative to the
vendor's base plan: Max 20x, Pro 20x, Business 5x, Team. Capacity sizes an
account's share of a pooled bar and of a bucket's routing.

## Usage reset

A grant or credit issued by a vendor that restores usage before a window’s
normal reset time. It belongs to an account, can expire, and is spent only
after confirmation. It is separate from the time displayed beside a usage bar.

A usage reset can target a native profile account or a proxy bucket account.
After a confirmed reset of a bucket account, the proxy clears its local
cooldown and Switchboard refreshes its routing weight. Clearing a proxy
cooldown alone never restores a vendor's usage allowance.

An **API upstream bucket** holds one external Responses API configuration and a
credential-file reference instead of OAuth accounts. Its configured accounting
allowances and equivalent usage are separate from subscription headroom. A
**mutable model alias** is a service ID whose underlying model may change; it
retains its exact ID and advertised metadata without claiming a stable identity.

## Session

One conversation with an agent in a profile: a Claude session or a Codex
thread, started in the desktop app, a terminal or a script. A session is
**working** while its latest turn has not ended, and **idle** otherwise.
Phone access lists sessions and can reply in them; it does not start or own them.

## Phone access

Seeing a Mac's sessions from a phone. The **hub** is the part of Switchboard
that serves the phone app on this Mac, published on the person's tailnet by
`tailscale serve`. A phone is **paired** once with a one-time **pairing
code**, and **unpaired** to shut it out. A **pending request** is an approval
or a question a session is waiting on that the phone can answer; the **control
socket** is how the Claude plugin and the Codex tap reach the hub. An app the
phone can **reach** was launched with that hook; one opened from the Dock is
**relaunched for phone control**, which quits it and opens it again from
Switchboard. Say "phone access", not "remote" or
"mobile", in the window and the docs; `switchboard remote` is the command.

## Fan control

Boosting the Mac's fans for a short while. A **boost** holds every fan at a
**speed** (a percentage of each fan's range) for a **time limit**, or until
stopped; otherwise **macOS controls the fans**. The **system helper** is the
root process that writes the speed, installed once after the person allows it
in Login Items; the **system bridge** is the child process the app talks to it
through. When the helper ends a boost on its own, the window says why the
**boost ended**. Say "boost", "fans" and "speed" in the window, not
"manual", "RPM control" or "cooling".

## Caffeinate

Keeping the Mac awake for a while. **Caffeinated** is a running session;
**Decaf** is the resting state, when the Mac sleeps as usual, and **Decaf
now** ends a session. A session keeps the screen on, and may keep the Mac
awake **also with the lid closed**, which is the system helper's **lid-closed hold** on
macOS's sleep setting. Say "Caffeinate" and "Decaf" in the window, not "Keep
awake" or "Amphetamine".
