# Claude fresh-chat context investigation

Branch: `investigate/claude-context-bloat`.

## Question

Why do fresh Claude conversations in Codex desktop report roughly 250,000 input
tokens, while GPT conversations in the same profile start near 32,000?

## Plan

1. Use the installed desktop Codex and pinned CLIProxyAPI binaries with an isolated
   Codex home, a local MCP tool server, and a local Anthropic fixture endpoint.
2. Capture the Responses request before translation and the Anthropic request after
   translation. Measure tools, instructions, and messages separately. Fixture token
   usage is deliberately fixed; it must not be mistaken for measured tokenization.
3. Compare no connectors, the current Claude descriptor, tool search enabled, and
   code-mode variants. Change one capability at a time.
4. Exercise tool discovery, execution, and resume for any promising configuration.
   Smaller requests alone do not establish a working fix.
5. Add regression coverage at the real binary/translator boundary and run the
   repository checks. Record limitations and leave deployment as a separate step.

## Evidence from existing chats

The affected profile's first recorded input usage was 31,654 for GPT on
September 18, and 245,379 / 254,398 / 254,525 for three Claude chats on September 19.
The 245,379-token chat requested a fixed reply without tools. Its initial developer
messages total about 49,000 characters. The cached connector catalog contains 421
tools, whose names, descriptions, and input schemas total about 729,000 characters.

The generated Claude descriptors omit or disable `supports_search_tool`; GPT
enables it. This was the initial hypothesis; the experiments below confirmed it.

## Results

Confirmed with desktop `codex-cli 0.155.0-alpha.9.2` and CLIProxyAPI 7.3.2,
commit `7fa443dc`. Experiments used isolated Codex homes and a fake MCP server.

### Cause

The large request exists **before proxy translation**. The old Claude descriptor
does not enable `supports_search_tool`. Codex therefore exposes the whole connector
catalog to the model. GPT's descriptor enables deferred tools and code mode.

The proxy does not fabricate the token count. A real Claude Fable request with 421
synthetic connector tools reproduced the symptom at **262,057 input tokens**.
The same fixed-reply prompt and tool catalog with the new descriptor used
**10,648 input tokens**, a reduction of 95.9%. The latter includes 6,567 cached
tokens; that cache count is already part of the 10,648, not subtracted from it.

### Controlled experiments

The local fixture captures Codex's Responses payload and the translated Anthropic
payload. These are serialized byte measurements, not token estimates. Fixture
usage is hardcoded and is not used as evidence of token reduction.

| Configuration, 421 synthetic tools unless noted | Anthropic tool-definition bytes | Outcome                                                |
| ----------------------------------------------- | ------------------------------: | ------------------------------------------------------ |
| Old descriptor, no connectors                   |                          16,843 | Small baseline                                         |
| Old descriptor                                  |                         804,411 | All 421 MCP tools exposed, 436 tools total             |
| Enable Node REPL only                           |                         804,411 | No effect                                              |
| Enable code mode without search                 |                         827,284 | Full definitions move into `exec` description          |
| Enable search without code mode                 |                           8,859 | Broken discovery: proxy drops standalone `tool_search` |
| Enable search and code mode                     |                          16,453 | Small request, working discovery and execution         |
| Search + code mode, Node REPL still disabled    |                          16,453 | Same working result; REPL setting is unrelated         |

The capture shows the standalone `tool_search` descriptor in Codex's request and
its absence from the Anthropic request. A smaller request from that setting alone
would conceal lost connector functionality.

Replaying the profile's cached tool definitions also showed a large initial
catalog and a small code-mode request. That replay is supplementary, not an exact
reproduction of hosted connector registration: the fake MCP server assigns local
names, and Codex does not retain every cached tool in that representation.

### Fix

Add these fields to the Claude descriptor in `src/buckets/models.ts`:

```ts
supports_search_tool: true,
tool_mode: 'code_mode_only',
```

Codex keeps the deferred catalog in its local code-mode registry. The model can
filter `ALL_TOOLS` to retrieve individual tool descriptions and schemas, and call
the selected tools through `exec`. CLIProxyAPI already translates that custom
`exec` input and its results. No standalone Responses tool-search translation is
needed on this path.

`node_repl_disabled` stays true; code mode is a separate execution mechanism.
The installed binary also honored the descriptor with the `code_mode_host` feature
flag set false. No profile config override was necessary.

### Functional verification

Local fixtures exercised the full chain through both installed binaries:

- Discover tool 420 from a 421-tool catalog, returning only its definition.
- Execute it through MCP with the expected argument and observe its result.
- Write and read back a scratch file through the shell.
- Restart Codex, resume the saved conversation, call the tool again, and recreate
  the scratch file after the test deletes it.
- Check that tool definitions remain below 30 KB on every request.

Real Fable and Opus models independently performed discovery, connector execution,
file writing, and restart/resume against the synthetic MCP server through the
existing account bucket. Their first requests used 10,724 and 10,707 input tokens
respectively. Those prompts included the verification task, unlike the fixed-reply
comparison above. No real connector operations were executed.

The regression test was run before the fix and failed:

```text
Expected toolBytes < 30000
Received: 812224
```

The fixed descriptor passes the same test. The historical configurations remain
in the probe as negative controls.

Final checks on this branch:

- `bun run test`: lint and type checking passed; 106 tests passed, 7 opt-in tests skipped.
- `SWITCHBOARD_LIVE_TESTS=1 bun test test/claude-context-live.test.ts test/claude-live.test.ts`:
  all 4 local binary integration tests passed, including the negative-control matrix.
- `bun run build && node demo/test-claude-models.mjs`: build and actual Codex catalog
  parsing passed; bundled and user-supplied GPT metadata remained identical.
- Real-model Fable comparison and Fable/Opus execution/resume checks passed as
  recorded above.

## Reproduce

Local-only matrix, no account usage:

```sh
bun demo/claude-context-probe.ts
SWITCHBOARD_PROBE_VARIANT=production SWITCHBOARD_PROBE_EXERCISE=1 bun demo/claude-context-probe.ts
SWITCHBOARD_LIVE_TESTS=1 bun test test/claude-context-live.test.ts test/claude-live.test.ts
```

Explicit real-model checks, using an already-running bucket:

```sh
SWITCHBOARD_PROBE_LIVE_BUCKET=your-bucket SWITCHBOARD_PROBE_MODEL=claude-fable-5-1 SWITCHBOARD_PROBE_VARIANT=baseline bun demo/claude-context-probe.ts
SWITCHBOARD_PROBE_LIVE_BUCKET=your-bucket SWITCHBOARD_PROBE_MODEL=claude-fable-5-1 SWITCHBOARD_PROBE_VARIANT=production bun demo/claude-context-probe.ts
SWITCHBOARD_PROBE_LIVE_BUCKET=your-bucket SWITCHBOARD_PROBE_MODEL=claude-opus-5 SWITCHBOARD_PROBE_VARIANT=production SWITCHBOARD_PROBE_EXERCISE=1 bun demo/claude-context-probe.ts
```

The retained probe uses synthetic tools. One-off cache-replay and raw-description
debug options were removed after the investigation.

## Scope and deployment

Deployment verification found an additional cached-catalog case: the affected
profile's effective export already contained Claude descriptors with search
disabled. The old merge function preserved them and never called
`claudeDescriptor`, so merely installing the first fix did not update that profile.
The merge now refreshes the two transport capabilities on matching available
Claude entries, while preserving their other custom metadata, unavailable entries,
and all GPT descriptors. A regression test failed on the old merge behavior;
the installed-binary catalog test also covers stale custom Claude entries.

The 10.6k result belongs to the isolated test home. A normal desktop chat will also
include its own instructions, skills, memories, and project context. The fix
removes eager connector definitions, not those legitimate inputs.

The desktop binary, launch wrapper, proxy translation, MCP calls, and resume were
tested. The full desktop UI and every hosted app feature were not exercised.
Catalog parsing tests check that GPT metadata is preserved.

Installing the updated Switchboard build and relaunching the Codex profile
regenerates its model catalog. An already-running
desktop process continues using its previous catalog. Existing conversation
content is not rewritten by this change.
