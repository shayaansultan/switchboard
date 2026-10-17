# Phone access

Phone access lets you see, from your phone, what every Claude and Codex
profile on this Mac is working on. It covers sessions started in the desktop
apps, in a terminal or by a script. It is read-only for now: you can watch
sessions and read their transcripts, but not reply or approve from the phone.

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
  the Phone access setting is on and Switchboard is running.
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

1. In Switchboard, open **Settings**, turn on **Phone access** and save.
   Or run `switchboard remote on`.
2. Publish the hub on your tailnet once. Switchboard shows the command:

   ```bash
   tailscale serve --bg --https=443 http://127.0.0.1:47821
   ```

   If Tailscale asks you to enable HTTPS certificates for your tailnet,
   follow its link. `tailscale serve --https=443 off` undoes it.

3. Open Settings again and choose **Pair a phone**, or run
   `switchboard remote pair`. On the phone, with Tailscale on, open the
   address shown (`https://<this Mac>.<tailnet>.ts.net/`). A link with the
   code included fills it in for you.
4. In Safari, **Share → Add to Home Screen** installs it as an app.

## What the phone shows

- **Working now:** every session whose latest turn has not ended, across all
  profiles. A turn with no new output for ten minutes stops counting as
  working, so a crashed agent does not look busy forever.
- **Each profile:** its colour, account, whether its desktop app is running,
  its fullest usage window, and its recent sessions. **Desktop** shows
  sessions started in the desktop apps; **All** adds terminal, editor and
  script runs.
- **A session:** your prompts, the agent's replies and a one-line summary of
  each tool call, kept up to date while it works.

## From a terminal

```bash
switchboard remote status            # on or off, listening or not, the phone's address
switchboard remote on | off
switchboard remote pair              # a one-time code and a link with it filled in
switchboard remote devices
switchboard remote unpair DEVICE_ID  # or --all --yes
switchboard remote sessions --working --human
switchboard remote session PROFILE SESSION_ID
```

`remote sessions` and `remote session` read the files directly, so they work
whether or not Switchboard is running.

## Files

Under `~/.switchboard/remote/`: `devices.json` (paired phones, with token
hashes), `pairing.json` (the hash of the one live code) and `hub.json`
(whether the app's hub is listening, for `remote status`). All are mode 600.

## Limits

- Read-only. Replying and approving from the phone come next, through the
  same plugin Switchboard already loads into Claude profiles and the engine
  wrapper it uses for Codex.
- No push notifications yet. The phone app updates while it is open.
- A desktop app opened from the Dock rather than Switchboard still shows up
  here, because its session files are the same.
- Session file formats belong to Anthropic and OpenAI and can change. The
  reader skips lines it does not understand rather than failing.
