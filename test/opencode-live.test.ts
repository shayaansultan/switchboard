// Opt-in contract tests against installed binaries. All model traffic terminates
// at a local fixture; no real subscriptions or service accounts are used.
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { create, paths, root, writeJson, secrets, save } from '../src/opencode/profiles';
import { ModelId } from '../src/opencode/types';
import { launchEnv } from '../src/opencode/launch';
import { control, ensureWorker } from '../src/opencode/proxy';

const live = process.env.SWITCHBOARD_LIVE_TESTS === '1' ? test : test.skip;
const execute = promisify(execFile);
const cli = path.resolve(import.meta.dir, '../out/opencode/cli.js');
const installed = path.join(os.homedir(), '.switchboard/bin/cliproxyapi-7.3.2/cli-proxy-api');
const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No listening port');
  return address.port;
}

function responseStream(response: http.ServerResponse): void {
  const item = {
    type: 'message',
    id: 'msg_fixture',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'profile-fixture-ok', annotations: [] }],
  };
  const completed = {
    id: 'resp_fixture',
    object: 'response',
    created_at: 1,
    model: 'gpt-5.4',
    status: 'completed',
    output: [item],
    usage: { input_tokens: 1, output_tokens: 4, total_tokens: 5 },
  };
  const events = [
    { type: 'response.created', response: { ...completed, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    {
      type: 'response.content_part.added',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    },
    {
      type: 'response.output_text.delta',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: 'profile-fixture-ok',
    },
    {
      type: 'response.output_text.done',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text: 'profile-fixture-ok',
    },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: completed },
  ];
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}

live(
  'real OpenCode isolates home, configuration, and credentials; real workers are reused and stopped',
  async () => {
    const previous = process.env.SWITCHBOARD_ROOT;
    const previousBinary = process.env.SWITCHBOARD_PROXY_BINARY;
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-live-'));
    process.env.SWITCHBOARD_ROOT = temporary;
    process.env.SWITCHBOARD_PROXY_BINARY = installed;
    const a = create('Profile A');
    const b = create('Profile B');

    try {
      for (const profile of [a, b]) {
        const env = launchEnv(profile, 1, temporary);
        const result = await execute('opencode', ['debug', 'paths'], { env, timeout: 60000 });
        expect(result.stdout).toContain(paths(profile.id).home);
        expect(result.stdout).toContain(paths(profile.id).data);
        expect(result.stdout).toContain(paths(profile.id).config);
        const resolved = await execute('opencode', ['debug', 'config'], {
          env,
          cwd: temporary,
          timeout: 90000,
          maxBuffer: 4 * 1024 * 1024,
        });
        const config = JSON.parse(resolved.stdout);
        expect(config.model).toBe('switchboard-chatgpt/gpt-6-astra');
        expect(Object.keys(config.mcp)).toEqual([]);
        expect(config.instructions).not.toContain(path.join(os.homedir(), '.claude/CLAUDE.md'));
      }

      const [first, second] = await Promise.all([ensureWorker(a.id, cli), ensureWorker(a.id, cli)]);
      const other = await ensureWorker(b.id, cli);
      expect(first.receipt.instance).toBe(second.receipt.instance);
      expect(other.receipt.proxyPort).not.toBe(first.receipt.proxyPort);
      expect(first.accounts).toEqual([]);

      const blocked = await fetch(`http://127.0.0.1:${other.receipt.proxyPort}/v1/models`, {
        headers: { Authorization: `Bearer ${secrets(a.id).apiKey}` },
      });
      expect(blocked.status).toBe(401);
      const stopped = await control(a.id, 'stop');
      expect(stopped?.receipt.instance).toBe(first.receipt.instance);
      await delay(1000);
      expect(await control(a.id, 'status')).toBeUndefined();
      expect((await control(b.id, 'status'))?.ready).toBe(true);
    } finally {
      await control(a.id, 'stop');
      await control(b.id, 'stop');
      await delay(1500);
      if (previous === undefined) delete process.env.SWITCHBOARD_ROOT;
      else process.env.SWITCHBOARD_ROOT = previous;
      if (previousBinary === undefined) delete process.env.SWITCHBOARD_PROXY_BINARY;
      else process.env.SWITCHBOARD_PROXY_BINARY = previousBinary;
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  },
  240000,
);

live(
  'real OpenCode receives a streamed response through the real proxy after account failover',
  async () => {
    const previous = process.env.SWITCHBOARD_ROOT;
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-inference-'));
    process.env.SWITCHBOARD_ROOT = temporary;
    const calls: string[] = [];
    const upstream = http.createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        const account = request.headers.authorization ?? 'none';
        calls.push(account);
        switch (account) {
          case 'Bearer fixture-exhausted':
            response.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
            response.end(
              JSON.stringify({ error: { type: 'usage_limit_reached', message: 'Fixture account exhausted' } }),
            );
            break;
          default:
            responseStream(response);
        }
      });
    });
    const port = await listen(upstream);
    const reservation = http.createServer();
    const proxyPort = await listen(reservation);
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const profile = create('Fixture');
    profile.model = ModelId.parse('gpt-5.4');
    save(profile);
    writeJson(path.join(paths(profile.id).runtime, 'model-info.json'), {
      model: profile.model,
      limits: { context: 128000, output: 32768 },
      reasoningEfforts: ['low'],
      source: 'cliproxyapi:codex',
      observedAt: new Date().toISOString(),
    });
    const configFile = path.join(root(), 'fixture.yaml');
    writeJson(configFile, {
      host: '127.0.0.1',
      port: proxyPort,
      'auth-dir': paths(profile.id).auth,
      'api-keys': [secrets(profile.id).apiKey],
      'remote-management': { 'disable-control-panel': true },
      routing: { strategy: 'fill-first', 'session-affinity': true },
      'request-retry': 1,
      'max-retry-interval': 1,
      'codex-api-key': [
        {
          'api-key': 'fixture-exhausted',
          priority: 10,
          'base-url': `http://127.0.0.1:${port}`,
          models: [{ name: 'gpt-5.4' }],
        },
        {
          'api-key': 'fixture-healthy',
          priority: 0,
          'base-url': `http://127.0.0.1:${port}`,
          models: [{ name: 'gpt-5.4' }],
        },
      ],
    });
    const child = spawn(installed, ['-config', configFile], { stdio: 'ignore', cwd: temporary });

    try {
      let ready = false;
      for (let attempt = 0; attempt < 100 && !ready; attempt++) {
        try {
          const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`, {
            headers: { Authorization: `Bearer ${secrets(profile.id).apiKey}` },
          });
          ready = response.ok;
        } catch {
          await delay(100);
        }
      }
      expect(ready).toBe(true);

      const env = launchEnv(profile, proxyPort, temporary);
      const running = execute(
        'opencode',
        ['run', '--format', 'json', 'Reply with profile-fixture-ok. Do not use tools.'],
        {
          env,
          cwd: temporary,
          timeout: 90000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      // `run` reads piped stdin before starting inference; execFile leaves that
      // pipe open unless the test explicitly sends EOF.
      running.child.stdin?.end();
      const result = await running;
      expect(result.stdout).toContain('profile-fixture-ok');
      expect(calls).toContain('Bearer fixture-exhausted');
      expect(calls).toContain('Bearer fixture-healthy');
    } finally {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        setTimeout(resolve, 3000).unref();
      });
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      if (previous === undefined) delete process.env.SWITCHBOARD_ROOT;
      else process.env.SWITCHBOARD_ROOT = previous;
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  },
  150000,
);
