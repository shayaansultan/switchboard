// Opt-in contract tests against installed binaries. All model traffic terminates
// at a local fixture; no real subscriptions or service accounts are used.
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { create, paths, root, writeJson, secrets } from '../src/buckets/store';
import { control, ensureWorker } from '../src/buckets/proxy';
import { wrapperScript, codexBinary } from '../src/buckets/desktop';

const live = process.env.SWITCHBOARD_LIVE_TESTS === '1' ? test : test.skip;
const execute = promisify(execFile);
const worker = path.resolve(__dirname, '../src/buckets/cli.ts');
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
  'real workers are reused per bucket, refuse a second owner and stop cleanly',
  async () => {
    const previous = process.env.SWITCHBOARD_ROOT;
    const previousBinary = process.env.SWITCHBOARD_PROXY_BINARY;
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-live-'));
    process.env.SWITCHBOARD_ROOT = temporary;
    process.env.SWITCHBOARD_PROXY_BINARY = installed;
    const a = create('Bucket A');
    const b = create('Bucket B');

    try {
      const [first, second] = await Promise.all([
        ensureWorker(a.id, { execPath: process.execPath, script: worker }),
        ensureWorker(a.id, { execPath: process.execPath, script: worker }),
      ]);
      const other = await ensureWorker(b.id, { execPath: process.execPath, script: worker });
      expect(first.receipt.instance).toBe(second.receipt.instance);
      expect(other.receipt.proxyPort).not.toBe(first.receipt.proxyPort);
      expect(first.accounts).toEqual([]);
      // A direct internal-worker invocation must not overwrite an active worker's
      // config or start a second refresh owner, even outside ensureWorker's lock.
      await expect(execute(process.execPath, [worker, 'worker', a.id], { timeout: 10000 })).rejects.toThrow();
      expect((await control(a.id, 'status'))?.receipt.instance).toBe(first.receipt.instance);

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
  'real desktop Codex streams, resumes and survives account failover through a bucket proxy',
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
    const bucket = create('Fixture');
    const configFile = path.join(root(), 'fixture.yaml');
    writeJson(configFile, {
      host: '127.0.0.1',
      port: proxyPort,
      'auth-dir': paths(bucket.id).auth,
      'api-keys': [secrets(bucket.id).apiKey],
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
            headers: { Authorization: `Bearer ${secrets(bucket.id).apiKey}` },
          });
          ready = response.ok;
        } catch {
          await delay(100);
        }
      }
      expect(ready).toBe(true);

      const codexHome = path.join(temporary, 'codex-home');
      fs.mkdirSync(codexHome);
      fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-5.4"\n');
      const wrapper = path.join(temporary, 'codex-desktop-wrapper');
      fs.writeFileSync(wrapper, wrapperScript(codexBinary(), `http://127.0.0.1:${proxyPort}/v1`), { mode: 0o700 });
      const codexEnv = { ...process.env, CODEX_HOME: codexHome, SWITCHBOARD_PROXY_API_KEY: secrets(bucket.id).apiKey };
      const firstCodex = execute(
        wrapper,
        ['exec', '--skip-git-repo-check', '--json', '-m', 'gpt-5.4', 'Reply briefly.'],
        { env: codexEnv, cwd: temporary, timeout: 60000 },
      );
      firstCodex.child.stdin?.end();
      const codexResult = await firstCodex;
      expect(codexResult.stdout).toContain('profile-fixture-ok');
      expect(calls).toContain('Bearer fixture-exhausted');
      expect(calls).toContain('Bearer fixture-healthy');
      const thread = codexResult.stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((event) => event.type === 'thread.started').thread_id;
      calls.length = 0;
      const resumedCodex = execute(
        wrapper,
        ['exec', 'resume', '--skip-git-repo-check', '--json', thread, 'Reply again.'],
        { env: codexEnv, cwd: temporary, timeout: 60000 },
      );
      resumedCodex.child.stdin?.end();
      expect((await resumedCodex).stdout).toContain('profile-fixture-ok');
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((account) => account === 'Bearer fixture-healthy')).toBe(true);
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
