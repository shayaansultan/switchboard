# Phone access

Phone access lets you see, from your phone, what every Claude and Codex
profile on this Mac is working on. It covers sessions started in the desktop
apps, in a terminal or by a script. From the phone you can also reply in a
session, answer its questions and approve what it wants to run, and get a
notification when one needs you or finishes.

## How it fits together

```
Claude and Codex apps ──write──▶ session files in each profile's home
                                        │ read
                                        ▼
                     Switchboard's hub (127.0.0.1:47821, in the app)
                                        │ tailscale serve (HTTPS, tailnet only)
                                        ▼
                         phone app (a PWA) on a paired phone
```

- **Session files.** Claude writes one file per session under
  `<home>/projects/`, and Codex one rollout per thread under
  `<home>/sessions/`, with an index of its threads in `state_5.sqlite`. Two
  readers (`src/remote/claude.ts`, `src/remote/codex.ts`) turn these into one
  shared model (`src/remote/model.ts`): a session's state (working, needs
  you, waiting, finished, stopped, errored) and a transcript of prompts,
  replies, tool steps with their output and diffs, questions, PRs,
  artifacts, subagents and reviews. A summary reads only the head and tail of
  a file, and transcripts are read a page at a time from the end, because a
  session file can pass 400 MB. The hub follows the session folders through
  macOS file events. It never talks to the apps, so nothing about them
  changes. Codex's index is opened read-only.
- **The hub.** It runs inside Switchboard and listens on 127.0.0.1 only. It
  serves the phone app, and, to paired phones only, the profiles with their
  app state and usage, the recent sessions, and transcripts. It is on while
  Phone access is on and Switchboard is running.
- **The API.** A tRPC router (`src/remote/api.ts`) under `/api/trpc/`, which
  the phone calls with types shared from the same code. `live` is a
  server-sent-events subscription: it sends the overview when it starts and
  again whenever something on it changes, driven by the file events plus a
  five-second check for what is not a file (an app starting, new usage
  numbers). Calls from another origin are refused.
- **Tailscale.** `tailscale serve` publishes the hub on your tailnet (your
  private Tailscale network) over HTTPS, with a certificate Tailscale
  provides. Nothing is reachable from the internet, and the phone needs
  Tailscale on to open the app.
- **Pairing.** A phone pairs once with an eight-character code that lasts ten
  minutes and works once. In return the hub sets a device cookie: HttpOnly,
  so no script in the page can read it, and same-site only. Switchboard
  stores only a hash of it, and you can unpair the phone at any time, from
  the Mac or from the phone. A phone added to the home screen may keep its
  own cookies apart from Safari's; if it opens on the pairing screen, pair
  it there once.

## Setting it up

Everything is in Switchboard's **Phone** tab, which checks each step for real
and ticks it off.

1. Turn on **Phone access**, or run `switchboard remote on`.
2. Connect Tailscale on the Mac, and install it on the phone with the same
   account.
3. Publish the hub on your tailnet once. The tab shows the command, with a
   copy button:

   ```bash
   tailscale serve --bg --https=443 http://127.0.0.1:47821
   ```

   If Tailscale asks you to enable Serve or HTTPS certificates for your
   tailnet, follow its link and run it again. `tailscale serve --https=443 off`
   undoes it. The tab ticks this off once the hub answers at the tailnet
   address.

4. Choose **Show pairing code** and scan the QR code with the phone's camera.
   It opens the phone app with the code filled in. Or run
   `switchboard remote pair` and open the link it prints.
5. In Safari, **Share → Add to Home Screen** installs it as an app.

## What the phone shows

The phone app is React with TanStack Query over the hub's tRPC API, styled
from the same tokens as the window (`src/design/tokens.css`).

- **Sessions:** a summary of what changed since you last opened the app, then
  everything that needs you (a question waiting on you), what is working (with
  the agent's own step count when it keeps a task list), and earlier sessions
  with the PRs they opened. Profile chips narrow the list to one account;
  two profiles with the same name are told apart by their app. A turn with
  no new output for ten minutes stops counting as working, so a crashed
  agent does not look busy forever. A Claude session whose turn ended while
  agents, commands or monitors it started still run keeps counting as
  working, with how many are left, until each reports back or three hours
  pass with no write from the session or its agents.
- **A session:** who, where, which branch and model, what it cost, and the
  transcript. Replies are formatted (lists, tables, code with Copy; raw HTML
  shows as text). A run of tool calls folds into one row that opens to each
  command, its output and its diff. Questions, PRs, artifacts, subagents
  (running, done, stopped or failed), reviews and widgets get cards. What
  background work sends back, a task's notice or a subagent's report, is a
  row that opens to its text, not a message from you. Older parts of a long session load on
  request, and the screen follows new activity while you read.
- **Pictures and files:** pictures you pasted, screenshots a tool returned
  (inside its step), files the agent sent you, and the visualizations a Codex
  thread made. The phone fetches each from `/api/media/<id>`, where the id is
  signed by the hub for that transcript (`src/remote/media.ts`), so a phone
  can open what a session refers to and nothing else on the disk. Images
  stored inside session files are read back from their line. HTML runs in a
  sandbox of its own, without the device cookie or the network.
- **Files changed:** every file the session edited, with its diff.
- **Accounts:** each profile's usage windows, when they reset, and whether
  they will last until then at the current pace.
- **Settings:** light, dark or the phone's own appearance, which sessions
  the inbox shows, folded or open steps, text size, which profiles to show, and unpairing this phone. These stay on the
  phone.

## Replying and approving

Switchboard cannot drive the desktop apps from outside, so something inside
each one does it and asks the hub what to do, over a socket in
`~/.switchboard/remote/` that only your user can open (`src/remote/control.ts`).

```
phone ──reply / decide──▶ hub ◀──long poll── Claude plugin (in each Code session)
                               ◀──long poll── Codex tap (on the app's engine line)
```

- **Claude:** with phone access on, every Claude profile Switchboard launches,
  the Default one included, loads the `switchboard-remote` plugin beside the
  profile band. A reply comes in as your own prompt, a turn of its own once
  the session is idle.
- **Codex:** every Codex profile Switchboard launches runs its engine through
  a wrapper that taps the app's connection to it (`src/remote/codex-tap.ts`).
  A reply becomes the app's own turn, so the app shows it live.
- **Approvals and questions.** A Codex approval or question shows in the app
  and on the phone at once, and the first answer wins; the app's card clears
  by itself. A Claude one has to be held to wait for the phone, which would
  keep the app's own dialog from showing, so it goes to the phone only while
  nobody is at the Mac (the screen is locked, or no input for a minute), and
  goes back to the app as soon as someone is.
- A profile's app has to be opened from Switchboard after phone access is
  turned on. One opened from the Dock can be read from the phone but not
  replied to, and the session screen says so.
- Claude Desktop runs a session's engine, and with it the plugin, once the
  session is used in that run of the app, and keeps it while the app is open.
  After the app restarts, an older session can be replied to again once it
  has been opened and used on the Mac. A Codex profile's whole thread list is
  reachable as soon as the app is open.
- An approval that Claude asks for because of an `ask` rule in your settings
  stays on the Mac: Claude Code does not let a plugin lift a settings rule.
  Approvals the session's mode asks for (Manual) go to the phone.
- Codex also sends requests for more access (network, files outside the
  workspace) and MCP prompts: forms the phone fills in, and links it opens.
  Claude Code lets a plugin only refuse an MCP prompt, not fill it in, so
  Claude's stay on the Mac.

## Notifications

Settings on the phone has **Turn on notifications**. iOS allows it only once
Switchboard is on the Home Screen. The phone hands the hub a push
subscription, and the hub sends through Apple's push service, encrypted for
the phone, so Apple carries the message without reading it
(`src/remote/push.ts`). These go out over the internet, not only the tailnet,
and carry only what the notification shows. The Mac sends while it is awake
and Switchboard runs.

What triggers one (`src/remote/notify.ts`), each a switch in Settings:

| Kind                    | When                                                          | Default |
| ----------------------- | ------------------------------------------------------------- | ------- |
| Needs you               | A session asks a question, or an approval waits for the phone | On      |
| Long sessions finishing | A session that worked five minutes or more finishes           | On      |
| Errors                  | A session stops with an error                                 | On      |
| Usage running low       | A profile passes 90% of a usage window, once per window       | Off     |

Only changes count: turning the app on does not replay what already needs
you. Notifications for one session replace each other.

## From a terminal

```bash
switchboard remote status            # on or off, listening or not, the phone's address
switchboard remote on | off
switchboard remote pair              # a one-time code and a link with it filled in
switchboard remote devices
switchboard remote unpair DEVICE_ID  # or --all --yes
switchboard remote notifications     # what each phone is notified about
switchboard remote notifications DEVICE_ID --kinds needs,errored   # or --off, --test
switchboard remote sessions --working --human
switchboard remote session PROFILE SESSION_ID
```

`remote sessions` and `remote session` read the files directly, so they work
whether or not Switchboard is running.

## Files

Under `~/.switchboard/remote/`: `devices.json` (paired phones, with token
hashes), `pairing.json` (the hash of the one live code) and `hub.json`
(whether the app's hub is listening, for `remote status`), `media.key` (signs
picture and file ids), `push.json` (the push key pair and each phone's
subscription and choices) and `control.sock` (the control socket). All are
mode 600.

## Limits

- Replying and approving need the profile's app opened from Switchboard with
  phone access on. A desktop app opened from the Dock still shows up here,
  because its session files are the same, but read-only.
- Claude approvals reach the phone only while nobody is at the Mac, and
  not when a settings rule asked for them. Claude's MCP prompts, a Codex
  question with a secret answer and a Codex device check stay on the Mac.
- Notifications need the Mac awake. A reply sent while a turn runs waits for
  it to end.
- Session file formats belong to Anthropic and OpenAI and can change. The
  reader skips lines it does not understand rather than failing.
