// Exercises the real desktop Codex app-server behind the display-only adapter.
// No GUI, subscription requests, or real credentials are needed.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { wrapperScript, codexBinary } from '../out/buckets/desktop.js';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-labels-'));
const runtime = process.argv.includes('--packaged')
  ? path.resolve(`dist/mac-${process.arch}/Switchboard.app/Contents/MacOS/Switchboard`)
  : process.execPath;
const adapter = process.argv.includes('--packaged')
  ? path.resolve(`dist/mac-${process.arch}/Switchboard.app/Contents/Resources/app.asar/out/buckets/desktop-stdio.js`)
  : path.resolve('out/buckets/desktop-stdio.js');
// Bun's process.execPath is also supported; packaged execution uses Electron.
async function models(labeled) {
  const wrapper = path.join(home, labeled ? 'labeled' : 'plain');
  await fs.writeFile(
    wrapper,
    wrapperScript(
      codexBinary,
      'http://127.0.0.1:9/v1',
      labeled ? { bucket: 'AnswerThis', runtime, adapter } : undefined,
    ),
    { mode: 0o700 },
  );
  const child = spawn(
    wrapper,
    [
      '-c',
      'features.code_mode_host=true',
      'app-server',
      '--analytics-default-enabled',
      '-c',
      'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true',
    ],
    {
      cwd: home,
      env: { ...process.env, CODEX_HOME: home, SWITCHBOARD_PROXY_API_KEY: 'fixture-only' },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const lines = createInterface({ input: child.stdout });
  let errorText = '';
  child.stderr.on('data', (chunk) => {
    errorText += chunk;
  });
  const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Model list timed out: ${errorText}`)), 20000);
      child.once('error', reject);
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code) reject(new Error(`Codex exited ${code}: ${errorText}`));
      });
      lines.on('line', (line) => {
        const message = JSON.parse(line);
        if (message.error) {
          clearTimeout(timer);
          reject(new Error(JSON.stringify(message.error)));
        }
        if (message.id === 1) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'config/read', params: { includeLayers: true, cwd: null } });
        }
        if (message.id === 2) {
          try {
            assert.equal(
              message.result.config.model_provider,
              'switchboard',
              'Desktop subcommand flags must not erase the proxy route',
            );
            assert.equal(message.result.config.model_providers.switchboard.base_url, 'http://127.0.0.1:9/v1');
          } catch (error) {
            clearTimeout(timer);
            reject(error);
            return;
          }
          send({ id: 3, method: 'model/list', params: { limit: 100, includeHidden: true } });
        }
        if (message.id === 3) {
          clearTimeout(timer);
          resolve(message.result);
        }
      });
      send({
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'switchboard-model-labels', version: '1' },
          capabilities: { experimentalApi: true },
        },
      });
    });
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      child.once('close', resolve);
      setTimeout(resolve, 3000).unref();
    });
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'Adapter must exit with its child');
    lines.close();
  }
}
try {
  const original = await models(false);
  const labeled = await models(true);
  assert.ok(original.data.length > 0);
  assert.deepEqual(labeled, {
    ...original,
    data: original.data.map((model) => ({ ...model, displayName: `Proxy · ${model.displayName}` })),
  });
  console.log(
    JSON.stringify(
      {
        passed: true,
        unchangedModelIDs: labeled.data.map((model) => model.model),
        labels: labeled.data.map((model) => model.displayName),
      },
      null,
      2,
    ),
  );
} finally {
  await fs.rm(home, { recursive: true, force: true });
}
