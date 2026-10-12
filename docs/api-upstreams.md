# API upstream buckets

Switchboard can route one Responses-compatible API service through a dedicated
loopback bucket. The existing CLIProxyAPI `codex-api-key` adapter supports this
transport. OAuth buckets retain their existing accounts, routing and headroom.

Create a bucket and an optional dedicated OpenCode profile:

```sh
switchboard bucket create-api SoCLaaS \
  --base-url https://soclaas-api.comp.nus.edu.sg/v1 \
  --credential-file "$HOME/.config/soclaas/soclaas.env" \
  --credential-env SOCLAAS_API_KEY \
  --budget-url https://soclaas-portal.comp.nus.edu.sg/api-key/budget \
  --adapter responses --model qwen3.6:35b --opencode
switchboard bucket inspect-api soclaas
switchboard bucket start soclaas
oc soclaas
```

The example model was advertised on 2026-10-12. Creation refreshes discovery and
requires an advertised chat model. `x-test-1` and service aliases are labeled
mutable. Mutable defaults need `--allow-mutable-default`; choose `x-test-1` for
one OpenCode run with `oc soclaas run --model x-test-1 "Reply briefly."`.

The UI's New proxy bucket dialog accepts the same upstream and credential-reference
settings. Its API panel shows discovery/accounting status, observation time,
configured equivalent allowances, reported usage and model IDs. Credentials and
subscription headroom are absent from that panel.

The bucket manifest persists non-secret settings and the credential reference.
Each bucket keeps independent local authentication and an empty API auth directory,
separate from OAuth account files. The proxy binds to 127.0.0.1; API routing contains
one upstream key, with cross-project/model fallback disabled. Proxy request and
error-body logging are disabled through commercial mode. Credential files require
private permissions, and shell export assignments are parsed without evaluation.
Generated configuration is mode 600 and removed on clean shutdown.

`bucket inspect-api` refreshes metadata without starting a worker. `bucket refresh`
refreshes observations for an existing bucket, including a stopped API bucket.
Routing models and credentials are materialized when the worker starts. Restart
only this bucket after approving an interruption to load key/catalogue changes.
Changing to a different file uses `bucket credential BUCKET ABSOLUTE_PATH VARIABLE`
while stopped. `bucket model BUCKET ID` updates the bucket's default after validating
current discovery. Use it when the old model is retired; select the OpenCode default
separately with `oc model PROFILE ID`. Both settings persist without recreating the
bucket. Existing clients must relaunch after a worker restart because its
local port changes. A missing credential, failed authentication or unreachable
model endpoint prevents startup; none redirects to another service.

Configured SoCLaaS allowances are reporting/fair-use settings, not payments or
subscription headroom. [Operators reported no enforcement on 2026-10-11](https://t.me/c/4345150434/6).
That dated report does not suppress HTTP 429 handling. The current key-specific
budget endpoint remains authoritative for configured values.
[`x-test-1` was announced as GLM 5.3 Flash with an explicit swap warning](https://t.me/c/4345150434/7).

## Codex and compatibility

Create a dedicated profile and assign only it after deployment approval:

```sh
switchboard add codex SoCLaaS
switchboard assign codex-soclaas soclaas
switchboard routed codex-soclaas exec --skip-git-repo-check "Reply briefly."
switchboard unassign codex-soclaas
```

Assignment affects the next desktop launch and the `routed` command. Native `cli`
commands, base config and auth.json keep their ownership. The API catalogue contains
only this service's chat models, rather than subscription GPT entries. The installed
Codex CLI 0.162.1 uses separate `NAME.config.toml` profile files; launch overrides
avoid changing the user's provider defaults. Do not change the NUS education
profile or any default without explicit approval.

Both SoCLaaS Chat Completions and Responses accepted tiny live streaming probes.
This implementation supports the Responses adapter. Embedding and transcription
models remain discoverable but are not advertised as coding models; those inference
endpoints are not supported by this path. Per-model tool quality, reasoning, vision
and output limits require separate verification. Unknown output limits are not
invented, and accounting price metadata is not advertised as cash cost.

## Verification

- `bun run check`: formatter, lint, type checks, unit regressions and build.
- `SWITCHBOARD_LIVE_TESTS=1 bun test test/api-upstream-live.test.ts`: installed proxy,
  Codex and OpenCode against a loopback fixture, including streams, function calls,
  errors, outage, restart, rotation, redaction and separate Codex profile-file syntax.
- `SWITCHBOARD_LIVE_TESTS=1 bun test test/opencode-live.test.ts`: existing provider,
  isolation, reuse, resume and failover contracts, entirely local fixtures.
- `bun run build && bun demo/test-api-bucket.mjs`: real Electron form, IPC, discovery,
  accounting, mutable labels, refresh and unchanged profile routing in isolated state.

On 2026-10-12, dedicated Codex and OpenCode profiles each completed a live
`printf SOCLAAS_TOOL_OK` tool round trip through this bucket. The installed Codex
engine emits telemetry warnings about colons in model IDs; inference and tools
still succeed. Preserve the exact service ID rather than renaming it to hide
those warnings. These probes do not establish every model's client compatibility.
Live acceptance must use tiny synthetic prompts after deployment approval.

## Rollback

Run `switchboard unassign PROFILE` for any profile deliberately assigned here, then
relaunch that profile. With approval, `switchboard bucket stop soclaas --yes` stops
only this bucket. `switchboard bucket remove soclaas --yes` deletes its state and
its paired OpenCode profile; use only when deletion is requested. The external key
file is not deleted. Roll back the app separately using the previous reviewed build
and signing identity; do not restart unrelated workers.

## Thinking controls and absent limits

The current API adapter does not advertise reasoning-effort choices. SoCLaaS's
live catalogue does not declare supported reasoning levels. Probes on 2026-10-13
accepted `none`, `high` and even an invalid Responses effort value; successful
requests therefore do not prove that the setting changes thinking. Codex may
show its generic “Medium” label even when this catalogue has no effort choices.
Do not infer a working thinking control or a disabled-thinking guarantee from it.
`oc effort` rejects API profiles instead of claiming an unused setting was applied.

API-backed profile cards show API credential/discovery health independently of
the native account's login. They show dated operator-reported enforcement or an
explicit unknown status instead of empty subscription bars. An empty or null-only
accounting object is valid missing information, not an API failure or unlimited
access; malformed responses and 401/429/outages remain separate error states.
