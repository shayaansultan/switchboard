# OpenCode terminal profiles

Switchboard's `oc` CLI runs independently of Electron. Each profile owns its
OpenCode configuration, history, MCP authentication, selected service connections,
and one ChatGPT account pool. The desktop application's existing account registry
remains separate; OpenCode cards are a later UI integration.

## Install and start

From this repository:

```sh
bun install
bun run build
node out/opencode/cli.js proxy-install
node out/opencode/cli.js install-cli
```

The installer verifies the SHA-256 of CLIProxyAPI 7.3.2 and stores its binary and
license under `~/.switchboard/bin/`. It supports Apple Silicon and Intel Macs.
It refuses to overwrite another `oc` installation. Add `~/.local/bin` to PATH
if your shell does not already include it.

```sh
oc create Personal
oc create Work
oc login work
oc login work       # add another account through a separate OAuth login
oc                  # numbered profile picker in the current terminal
oc work             # directly open Work in the current project
oc work --continue
```

`oc login` opens the proxy's native OAuth flow. Choose the intended ChatGPT
account in the browser. Finish one login before starting another because the
OAuth callback listener uses a fixed port. Subscription accounts require fresh
logins into the pool. The launcher never copies refresh tokens from Codex or
OpenCode authentication files.

`oc` starts OpenCode in the current directory. It does not change a global active
profile or replace the normal `opencode` command. Separate windows can use different
profiles; windows using the same profile reuse its routing worker.

The installed launcher points at this checkout's compiled CLI. After changing
the source, run `bun run build`. OpenCode loads configuration at startup, so
restart the affected OpenCode windows after changing settings, plugins or connections.

## Separate service connections

Supported service IDs:

- `google-workspace`
- `slack`
- `linear`
- `github`
- `notion`
- `wispr-flow`

Each is a separate MCP registration and process, backed by a service adapter in
the private `agentfiles/integrations/codex-apps-bridge` checkout. The shared
transport handles Codex App Server communication. Google retains its existing
file and Drive helpers. Other services do not load those helpers or expose Google tools.

```sh
oc probe slack --codex-home /absolute/codex/home --account work@example.com
oc connect work slack --codex-home /absolute/codex/home --account work@example.com
oc connect work linear --codex-home /another/codex/home --account other@example.com
oc disconnect work slack
```

Use `--bridge /absolute/path/to/src/main.ts` if agentfiles is elsewhere. The default
is `~/Desktop/agentfiles/integrations/codex-apps-bridge/src/main.ts`.
`SWITCHBOARD_BRIDGE` supplies the same default. `--access read-only` filters out
tools not explicitly annotated as reads; the default is `read-write`, subject to
the calling agent's authorization and permissions.

Connecting performs live discovery, verifies the source Codex login email, and
saves the service identity observation. Each service can use a different Codex
home. The path references that existing credential owner; it does not clone its login.
Changing the inference account never changes these bindings.

| Service          | Identity checked                 | Current limitation                                                                     |
| ---------------- | -------------------------------- | -------------------------------------------------------------------------------------- |
| Google Workspace | Default connected Google email   | Does not enforce an exhaustive allowlist of Google account links or resources          |
| Slack            | Current Slack user ID            | Workspace display name is reported; workspace access is not an independent ACL         |
| Linear           | Current user ID and workspace ID | Connector determines accessible teams/resources                                        |
| GitHub           | GitHub user ID                   | Repository and installation access are not frozen by this check                        |
| Notion           | Notion user ID and workspace ID  | Tools may still be restricted by workspace plan; inspect fetch("self") access metadata |
| Wispr Flow       | Source Codex login email only    | Account-info supplies a display name, not a stable service account ID                  |

Verified identities are compared during discovery and before tool dispatch. A
changed identity fails before the requested operation runs. Display-name changes
do not count as an identity change. Reconnect explicitly to adopt a different identity.
Each launch references a content-addressed identity snapshot, so reconnecting from
another window cannot rewrite an existing window's expected identity.

`source-only` is a distinct typed state, not a successful service-identity check.
It is shown by `probe`, `connect` and `show`. Hosted connector availability can
differ from Codex's cached desktop catalog.

These profiles isolate application state, not the macOS user or filesystem.
GitHub MCP credentials are separate from `gh` and Git author identity. An optional
`githubLogin` profile field binds `gh` and GitHub HTTPS Git authentication for the
launched process using an already-signed-in CLI account. Credentials remain in
memory, repository author settings are preserved, and no global account switch occurs.
Local messaging bridges and browser sessions may also have independent account stores.

## Selectively copy or link settings

```sh
oc import work /absolute/source/directory
oc import work /absolute/source/directory --items 1,3 --mode copy --dry-run
oc import work /absolute/source/directory --items 1,3 --mode copy
oc import work /absolute/source/directory --items 2 --mode link
```

The source can be an OpenCode config directory, a Claude/Codex profile home, or
an agentfiles checkout. The numbered inventory includes available skills,
instructions, TUI settings, plain plugin specifiers, and OpenCode MCP definitions.
OpenCode preferences support JSON and JSONC. Imports from vendor homes currently
cover portable files, not conversion of vendor plugin runtimes or configuration languages.

- Skills and instructions can be copied or linked. A linked file remains writable
  by every profile using it, and edits reach the original source.
- Existing destinations are refused, including dangling symlinks.
- Preferences copy an allowlist of non-credential settings. Provider/model fields
  and credential references are excluded.
- Remote MCP definitions copy only an endpoint, disabled. They require separate
  authentication. Credential-bearing URLs and local commands require explicit setup.
- Chat history, credential files, browser state and cached hosted app catalogs are
  not imported. History migration needs a separate supported export/import path.
- A multi-item import applies items in order. If a later item fails, earlier
  successful imports are retained and reported in the printed selection.

No source connections are uninstalled by an import. Keeping work-only services
out of a new Personal profile does not uninstall them from the original ChatGPT account.

## Isolation and routing

```text
~/.switchboard/opencode/<profile>/
  profile.json
  secrets.json
  config/opencode/
  data/opencode/
  state/opencode/
  cache/opencode/
  home/
  proxy/auth/
  runtime/
```

The launcher sets all four XDG roots, removes inherited OpenCode path/auth overrides,
and checks the real OpenCode binary's reported home/config/data paths before launch.
`OPENCODE_TEST_HOME` supplies the isolated OpenCode home lookup. This is an internal
hook verified against OpenCode 1.18.30, not a stable public profile API. The real
shell HOME is preserved for normal Git/SSH behaviour.

External skill discovery and Claude compatibility imports are disabled. Skills
must be explicitly imported. By default, project plugin/MCP config is disabled,
but the nearest project AGENTS.md or CLAUDE.md is added as an explicit instruction.
Choose the normal project configuration behaviour explicitly:

```sh
oc project-config work inherit
oc project-config work isolated
oc doctor work
```

The worker uses loopback-only endpoints, separate profile API keys and an authenticated
control endpoint. Quota observations adjust account weights every two minutes.
New sessions use weighted selection; healthy sessions remain on their selected
account. The tightest reported window determines the weight, conservatively across
the reported pools. Unknown data gets a neutral weight initially and retains the
previous weight when a later observation fails. A usage-endpoint 429 backs off probes.
It does not mark the inference account exhausted.

Actual inference quota errors, account eligibility, streaming and safe retries are
handled by CLIProxyAPI. Near-empty observations keep a positive weight to avoid
evicting healthy sessions. Subagents inherit session affinity by default. Model
failover is disabled. The main and auxiliary OpenCode model routes both use the
profile's custom Responses provider.

The default model is `gpt-6-astra` at low reasoning effort. Launches load context
and output limits from the proxy's Codex model catalog and record their provenance
in `runtime/model-info.json`; there are no guessed limit defaults. The subscription
route's catalog can differ from the model's public API specification. Use
`oc model PROFILE MODEL` and `oc effort PROFILE low|medium|high|xhigh|max` to change
the selection. Models still need to be available to
the signed-in accounts; this command does not grant model access.

```sh
oc status work
oc refresh work
oc stop work
```

Workers remain available until stopped and do not require the Electron app. Stopping
a worker interrupts requests using it. A crashed controller with a surviving proxy
is detected on the next launch and blocks a duplicate refresh owner. Inspect its
runtime receipt/log before recovery. The controller holds `runtime/worker.lock`
for its lifetime; an abrupt crash leaves that lease for explicit recovery after
confirming both controller and proxy have stopped. Unreachable controllers and
failed control requests are reported as failures, not as successful stops.
Cross-profile sharing of an AI account's
credentials is not implemented; never symlink pool auth directories.

Runtime overrides for development: `SWITCHBOARD_ROOT`, `SWITCHBOARD_OPENCODE`,
`SWITCHBOARD_PROXY_BINARY`, and `SWITCHBOARD_BUN`.

## Verification

```sh
bun run test
bun run build
SWITCHBOARD_LIVE_TESTS=1 bun test test/opencode-live.test.ts
```

The opt-in tests use installed OpenCode and CLIProxyAPI binaries. They verify
isolated config, worker reuse, cross-profile key rejection and process shutdown.
A local upstream fixture returns a quota error for one credential and a streamed
response for another; the real OpenCode CLI must receive the final response.
No subscription traffic is generated by that test.

Bridge tests live in agentfiles. Live `probe` checks exercise existing hosted
connections. A complete subscription acceptance run still requires fresh OAuth
logins, real inference, and token-refresh/continuation checks with those accounts.
