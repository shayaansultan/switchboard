# Shared proxy buckets

Switchboard's **Proxy buckets** tab manages account pools shared with OpenCode. Use it to
create a bucket, start or stop its worker, refresh usage, add an account through the
proxy's OAuth flow, enable/disable individual accounts, or remove an account or the
whole bucket. Each account is one row
with all of its usage windows. Add one account
at a time because the OAuth callback uses a fixed port. After login completes, refresh
the bucket to see the account.

**Add account** offers ChatGPT and Claude logins. The worker lists both providers
and reads their usage through their respective endpoints. Claude logins belong to
the proxy; the existing Claude desktop/CLI credentials are not imported.

When the proxy stops routing to an account, for example because its token expired
and could not be renewed, the account row says **unavailable** with the proxy's
reason, profile cards using the bucket show a note, and the account's menu offers
**Sign in again**. A Claude usage lookup that is rate limited waits 15 minutes
before asking again, but a new sign-in rewrites the account's token file and is
asked about at the next refresh.

## Claude models in Codex desktop

After adding a Claude account, relaunch the assigned Codex desktop profile. Available
Claude models appear alongside GPT models. Selecting a Claude model uses a Claude
account; selecting GPT uses a ChatGPT account. Quotas are not interchangeable.

Claude model availability, context limits and reasoning levels come from the proxy's
catalog. Switchboard appends those descriptors to the installed Codex binary's effective
catalog for that profile, including any user-supplied catalog. Existing GPT entries
are preserved. Matching Claude entries retain their metadata but receive the
current tool-search and code-mode settings. The resulting snapshot is regenerated on
each desktop launch and referenced only by that launch wrapper.

Claude uses Codex's code-mode `exec` tool to call shell tools and connectors.
Connector definitions stay in Codex's local tool registry; Claude can discover the
ones it needs through `ALL_TOOLS` rather than receiving the whole catalog on every
request. The descriptor enables both `supports_search_tool` and
`tool_mode: code_mode_only`. Search support alone is insufficient because the pinned
proxy omits the standalone Responses `tool_search` tool. See the
[context investigation](claude-context-investigation.md) for measurements and tests.

The installed Codex build offers only freeform `apply_patch`, which the proxy's
Claude translator omits. Claude descriptors therefore do not advertise it or
Responses Lite. Files are edited through shell tools. Hosted app features still
require individual compatibility checks. The existing OpenCode provider continues
exposing its ChatGPT models.

Each Codex card has a model connection menu beside its launch button. Choose
**Native account** or a bucket. The choice takes effect when that desktop profile is next launched from
Switchboard. Quit the profile first if it is already open. Other desktop profiles
keep their own choices.

Proxy mode changes model routing only. The profile keeps its Codex home, login,
local chats, projects, settings and connected-service identities. Its terminal and
Sign in CLI actions continue to use its native account. Sharing a bucket does not
merge desktop histories. App features that depend on hosted services still depend
on the desktop login and provider support.

The card then pools the bucket's usage: one bar per provider and window (Claude 5h,
GPT 7d and so on), cut into a segment per account. Segments are sized by the plan's
capacity, using the vendors' published multiples (a $200 Pro is 20x Plus, a Max 5x is
5x Pro), and the percentage is the mean weighted the same way, so a spent small plan
beside fresh large ones reads as a pool with most of its quota left. Routing favours
accounts by the same measure. Hover a segment to see which account and plan it is. The
Proxy buckets tab lists every account. Native account usage remains
available on that account's native card and in the menu bar. The model picker belongs
to Codex; the selected model must be available through the bucket.

In proxy mode, the Codex model picker labels models with **Proxy · Model**.
Switchboard shows the assigned bucket name. The prefix identifies proxy mode, not the health of the worker or which
upstream account handled the latest request. Native launches retain their normal
model names. A desktop restart is needed to pick up a changed label or connection.

## Lifetime and recovery

- Launch starts or reuses one worker for the selected bucket. OpenCode and desktop
  clients share its session-aware routing and account quota observations.
- An empty or unavailable pool fails the launch. Switchboard never silently falls
  back to the native account.
- Stopping a bucket interrupts all clients using it. After restarting the bucket,
  relaunch those clients so they receive its current endpoint.
- Quitting Switchboard leaves workers running for their clients.
- After a reboot or abrupt worker exit, Switchboard resumes buckets with a
  remaining worker receipt when it next opens. A bucket stopped normally stays
  stopped. **Start bucket** uses the same recovery path.
- Recovery clears a stale receipt and lease only when their worker is gone and
  neither old port is listening. An active or ambiguous worker is left alone;
  the bucket card shows the reason until the next successful action.
- **Remove account…** (the account's menu, or `switchboard bucket remove-account`)
  deletes the account's token file through the proxy. The vendor's grant is not
  revoked, and the account's other sign-ins, such as the desktop app's, are
  untouched.
- **Remove bucket…** (the bucket's menu, or `switchboard bucket remove`) stops the
  worker, interrupting every client routed through it as Stop does, deletes the
  bucket's directory with its accounts' token files, and moves every profile
  routed through it back to its own sign-in. A bucket stored with an OpenCode
  profile shares that profile's directory, so the OpenCode profile goes with it.
  Removing a bucket refuses while a profile routed through it is running, and
  while its worker is unreachable: recover or stop it first. It holds the lock a
  worker start takes, so a launch cannot start a new worker until it is done.
  Removing an account starts a stopped bucket's worker to reach its proxy; the
  CLI stops it again afterwards.
- A dead controller with an orphan proxy requires explicit recovery as described
  in [OpenCode profiles](opencode-profiles.md#isolation-and-routing).

## Implementation

`src/buckets/` owns bucket discovery, account management, routing workers and the
desktop adapter. Existing OpenCode pools keep their manifests, credentials, ports
and worker leases under `~/.switchboard/opencode/<id>/`. They are discovered as
buckets without moving or copying rotating credentials. New standalone buckets live
under `~/.switchboard/buckets/<id>/`. The existing OpenCode profiles continue using
their same-named pools; standalone buckets currently serve desktop clients.

The wrapper embeds the runtime and adapter script that `src/buckets/runtime.ts`
resolves: the process's own bundle inside Electron, otherwise the installed
Switchboard.app when there is one. A wrapper minted by the `switchboard` CLI is
therefore byte-identical to one minted by the app, and never points at a
checkout's `out/` directory. Changes to `desktop-stdio.ts` reach desktop
launches after `bun run install-app`.

Desktop assignments live in `profiles.json` as `proxyBucket`. A private, immutable
launch wrapper under `~/.switchboard/desktop-routing/` supplies provider overrides
to the app's embedded Codex process via `CODEX_CLI_PATH`. The local proxy key is passed
in the launch environment, never written into the wrapper or sent to the renderer.
Neither `config.toml` nor `auth.json` is rewritten. Native launches use the normal
app runtime. This executable override is an app implementation detail and needs
rechecking after desktop updates.

Routing overrides must follow the desktop's arguments, including its `app-server`
subcommand flags. Codex can replace top-level `-c` overrides when the app supplies
its own subcommand-level `-c` flags. The app-server contract test uses that exact
launch shape and checks `config/read` for the effective provider and endpoint;
process arguments or a display prefix alone are not sufficient verification.

The proxy wrapper runs a small stdio adapter that changes only `displayName` in
matching app-server `model/list` responses. All model IDs, capabilities, requests,
and inference messages pass through unchanged. This label adapter does not change
model capabilities or modify the signed desktop app. Non-app-server invocations pass through
without JSON processing, and the adapter forwards termination to Codex.

The worker can run under Node or packaged Electron's Node mode. OpenCode's CLI entry
points call the shared implementation directly. Usage parsing is independent
of desktop profile initialization.

## Verification

```sh
bun run test
bun run test:buckets-ui
bun run test:model-labels
node demo/test-claude-models.mjs
SWITCHBOARD_LIVE_TESTS=1 bun test test/opencode-live.test.ts
SWITCHBOARD_LIVE_TESTS=1 bun test test/claude-live.test.ts
SWITCHBOARD_LIVE_TESTS=1 bun test test/claude-context-live.test.ts
bun run dist
bun demo/test-buckets.mjs --packaged
node demo/test-model-labels.mjs --packaged
```

The UI test uses an isolated home and an empty real worker, and checks assignment
persistence, worker reuse across app restarts, native reset and fail-closed launches.
The opt-in binary test sends only local fixture traffic through the real proxy. It
checks a quota-error failover, streaming and restart/resume with the installed
desktop Codex binary, then a request from real OpenCode through the same proxy.
Screenshots are saved under `docs/.work/buckets/`.

The Claude fixture test exercises the actual Codex binary and CLIProxyAPI against
a local Anthropic endpoint, including streamed tool calls, a real scratch-file edit,
tool-result replay and conversation resume. The metadata check asks Codex itself to
parse the generated catalog and compares GPT entries against its original catalog.

The context fixture test supplies 421 synthetic MCP tools, measures requests before
and after proxy translation, and exercises deferred discovery, connector execution,
shell editing, and process-restart/resume. It uses local fixtures, not subscription
credentials, despite sharing the existing `SWITCHBOARD_LIVE_TESTS` opt-in flag.
