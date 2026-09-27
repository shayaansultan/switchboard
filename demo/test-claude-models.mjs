// Validate generated metadata using the installed Codex binary's own parser.
// Local metadata only; there are no account logins or inference requests.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mergedCatalog, desktopCatalog } from '../out/buckets/models.js';
import { create } from '../out/buckets/store.js';
import { codexBinary } from '../out/buckets/desktop.js';

const execute = promisify(execFile);
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-claude-catalog-'));
const previousRoot = process.env.SWITCHBOARD_ROOT;
process.env.SWITCHBOARD_ROOT = path.join(home, 'switchboard');
let server;
try {
  const env = { ...process.env, CODEX_HOME: home };
  const original = JSON.parse(
    (await execute(codexBinary(), ['debug', 'models', '--bundled'], { env, maxBuffer: 16 * 1024 * 1024 })).stdout,
  );
  const definition = {
    id: 'claude-fixture',
    display_name: 'Claude fixture',
    context_length: 200000,
    max_completion_tokens: 32000,
    supportedInputModalities: ['text', 'image'],
    supportedOutputModalities: ['text'],
    thinking: { levels: ['low', 'high'] },
  };
  const catalog = mergedCatalog(original, [definition]);
  const file = path.join(home, 'catalog.json');
  await fs.writeFile(file, JSON.stringify(catalog));
  const result = await execute(
    codexBinary(),
    [
      '-c',
      `model_catalog_json=${JSON.stringify(file)}`,
      '-c',
      'model_provider="fixture"',
      '-c',
      'model_providers.fixture={name="fixture",base_url="http://127.0.0.1:9/v1",wire_api="responses"}',
      'debug',
      'models',
    ],
    { env, maxBuffer: 16 * 1024 * 1024, timeout: 20000 },
  );
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(
    parsed.models.filter((model) => model.slug !== 'claude-fixture'),
    original.models,
  );
  const claude = parsed.models.find((model) => model.slug === 'claude-fixture');
  assert.equal(claude.context_window, 200000);
  assert.equal(claude.apply_patch_tool_type, null);
  assert.equal(claude.node_repl_disabled, true);
  assert.equal(claude.supports_search_tool, true);
  assert.equal(claude.tool_mode, 'code_mode_only');
  // Launching a bucket must extend this profile's effective catalog, including
  // custom GPT metadata, rather than silently reverting to bundled defaults.
  const custom = structuredClone(original);
  custom.models[0].display_name = 'Custom GPT label';
  const staleClaude = {
    ...claude,
    display_name: 'Custom Claude label',
    supports_search_tool: false,
    tool_mode: null,
  };
  custom.models.push(staleClaude);
  const customFile = path.join(home, 'custom-models.json');
  await fs.writeFile(customFile, JSON.stringify(custom));
  await fs.writeFile(path.join(home, 'config.toml'), `model_catalog_json = ${JSON.stringify(customFile)}\n`);
  server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify(request.url === '/v1/models' ? { data: [{ id: definition.id }] } : { models: [definition] }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const bucket = create('Catalog fixture');
  const generated = await desktopCatalog(
    bucket.id,
    server.address().port,
    codexBinary(),
    {
      home,
      overrides: [
        'model_provider="fixture"',
        'model_providers.fixture={name="fixture",base_url="http://127.0.0.1:9/v1",wire_api="responses"}',
      ],
    },
    path.join(home, 'models-fixture.json'),
  );
  const extended = JSON.parse(await fs.readFile(generated, 'utf8'));
  assert.deepEqual(
    extended.models.filter((model) => model.slug !== definition.id),
    custom.models.filter((model) => model.slug !== definition.id),
  );
  assert.deepEqual(
    extended.models.filter((model) => model.slug === definition.id),
    [{ ...staleClaude, supports_search_tool: true, tool_mode: 'code_mode_only' }],
  );
  console.log(
    'Real Codex parsed Claude capabilities; stale Claude tool settings were refreshed while custom Claude and GPT metadata were preserved.',
  );
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (previousRoot === undefined) delete process.env.SWITCHBOARD_ROOT;
  else process.env.SWITCHBOARD_ROOT = previousRoot;
  await fs.rm(home, { recursive: true, force: true });
}
