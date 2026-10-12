// Opt-in installed-proxy contract test. All traffic goes to a loopback fixture.
import { test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { create, paths, secrets } from '../src/opencode/profiles';
import { Upstream } from '../src/buckets/upstream';
import { ensureWorker, control } from '../src/buckets/proxy';
import { stop } from '../src/buckets';
import { launchEnv } from '../src/opencode/launch';
import { wrapperScript, codexBinary } from '../src/buckets/desktop';
import { apiCatalog } from '../src/buckets/models';
import { run } from './cli-helpers';
import { STORE_FILE } from '../src/store';
import { sandboxHome } from './setup';
const live = process.env.SWITCHBOARD_LIVE_TESTS === '1' ? test : test.skip;
const execute = promisify(execFile);
function stream(model: string, tool = false) {
  const item = tool
    ? {
        id: 'fc_fixture',
        type: 'function_call',
        call_id: 'call_fixture',
        name: 'echo',
        arguments: '{"text":"fixture"}',
        status: 'completed',
      }
    : {
        id: 'msg_fixture',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'fixture-ok', annotations: [] }],
      };
  const completed = {
    id: 'resp_fixture',
    object: 'response',
    created_at: 1,
    model,
    status: 'completed',
    output: [item],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  const events = [
    { type: 'response.created', response: { ...completed, status: 'in_progress', output: [] } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, status: 'in_progress', ...(tool ? { arguments: '' } : { content: [] }) },
    },
    ...(tool
      ? [
          {
            type: 'response.function_call_arguments.delta',
            item_id: item.id,
            output_index: 0,
            delta: '{"text":"fixture"}',
          },
        ]
      : [
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
            delta: 'fixture-ok',
          },
          {
            type: 'response.output_text.done',
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            text: 'fixture-ok',
          },
        ]),
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: completed },
  ];
  return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}
live(
  'API worker isolates models, streams tools, rotates on restart and runs installed clients',
  async () => {
    const previous = process.env.SWITCHBOARD_PROXY_BINARY;
    process.env.SWITCHBOARD_PROXY_BINARY = path.join(os.homedir(), '.switchboard/bin/cliproxyapi-7.3.2/cli-proxy-api');
    const file = path.join(sandboxHome, 'live-api.env');
    fs.writeFileSync(file, "export KEY='fixture-first'", { mode: 0o600 });
    const model = 'model:exact';
    let code = 200;
    let tool = false;
    const seen: { auth: string | null; body: Record<string, unknown> }[] = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (request.url.endsWith('/models'))
          return Response.json({
            data: [{ id: model, context_length: 32768, max_completion_tokens: 1024 }, { id: 'x-test-1' }],
          });
        if (request.url.endsWith('/budget')) return Response.json({ policy: { requests_per_minute_limit: 17 } });
        const body = (await request.json()) as Record<string, unknown>;
        seen.push({ auth: request.headers.get('authorization'), body });
        if (code !== 200)
          return Response.json({ error: { message: 'fixture error', type: 'api_error' } }, { status: code });
        return stream(String(body.model), tool);
      },
    });
    const upstream = Upstream.parse({
      kind: 'api',
      adapter: 'responses',
      baseUrl: `${server.url}v1`,
      budgetUrl: `${server.url}budget`,
      credential: { file, variable: 'KEY' },
      defaultModel: model,
    });
    const profile = create('API live fixture', upstream);
    const worker = { execPath: process.execPath, script: path.resolve('src/buckets/cli.ts') };
    try {
      let running = await ensureWorker(profile.id, worker);
      const call = (body: unknown, key = secrets(profile.id).apiKey) =>
        fetch(`http://127.0.0.1:${running.receipt.proxyPort}/v1/responses`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10000),
        });
      const models = await fetch(`http://127.0.0.1:${running.receipt.proxyPort}/v1/models`, {
        headers: { Authorization: `Bearer ${secrets(profile.id).apiKey}` },
      }).then((r) => r.json());
      expect(models.data.map((m: { id: string }) => m.id).sort()).toEqual([model, 'x-test-1'].sort());
      expect((await call({ model, input: 'Hello', stream: true }, 'wrong-key')).status).toBe(401);
      expect(await (await call({ model, input: 'Hello', stream: true })).text()).toContain('fixture-ok');
      expect(seen.at(-1)?.body.model).toBe(model);
      tool = true;
      expect(
        await (
          await call({
            model,
            input: 'Echo',
            stream: true,
            tools: [
              {
                type: 'function',
                name: 'echo',
                parameters: { type: 'object', properties: { text: { type: 'string' } } },
              },
            ],
          })
        ).text(),
      ).toContain('call_fixture');
      tool = false;
      await (
        await call({
          model,
          stream: true,
          input: [
            { type: 'function_call', name: 'echo', call_id: 'call_fixture', arguments: '{"text":"fixture"}' },
            { type: 'function_call_output', call_id: 'call_fixture', output: 'fixture' },
          ],
        })
      ).text();
      expect(JSON.stringify(seen.at(-1)?.body)).toContain('function_call_output');
      const env = launchEnv(profile, running.receipt.proxyPort, sandboxHome);
      const oc = execute('opencode', ['run', '--format', 'json', 'Reply briefly.'], {
        env,
        cwd: sandboxHome,
        timeout: 45000,
        maxBuffer: 2 * 1024 * 1024,
      });
      oc.child.stdin?.end();
      expect((await oc).stdout).toContain('fixture-ok');
      const home = path.join(sandboxHome, 'codex-api-home');
      fs.mkdirSync(home);
      const catalog = apiCatalog(running.upstream!.models, path.join(home, 'models.json'));
      fs.writeFileSync(
        path.join(home, 'fixture.config.toml'),
        'model = "model:exact"\nmodel_provider = "fixture"\nmodel_catalog_json = ' +
          JSON.stringify(catalog) +
          '\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "http://127.0.0.1:' +
          running.receipt.proxyPort +
          '/v1"\nwire_api = "responses"\nenv_key = "SWITCHBOARD_PROXY_API_KEY"\nrequires_openai_auth = false\n',
      );
      const layered = execute(
        'codex',
        ['exec', '--profile', 'fixture', '--skip-git-repo-check', '--json', 'Reply briefly.'],
        {
          env: { ...process.env, CODEX_HOME: home, SWITCHBOARD_PROXY_API_KEY: secrets(profile.id).apiKey },
          cwd: home,
          timeout: 45000,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      layered.child.stdin?.end();
      expect((await layered).stdout).toContain('fixture-ok');
      const wrapper = path.join(home, 'wrapper');
      fs.writeFileSync(wrapper, wrapperScript(codexBinary(), `http://127.0.0.1:${running.receipt.proxyPort}/v1`), {
        mode: 0o700,
      });
      const codex = execute(wrapper, ['exec', '--skip-git-repo-check', '--json', '-m', model, 'Reply briefly.'], {
        env: { ...process.env, CODEX_HOME: home, SWITCHBOARD_PROXY_API_KEY: secrets(profile.id).apiKey },
        cwd: home,
        timeout: 45000,
        maxBuffer: 2 * 1024 * 1024,
      });
      codex.child.stdin?.end();
      expect((await codex).stdout).toContain('fixture-ok');
      expect((await run('add', 'codex', 'API routed fixture')).code).toBe(0);
      expect((await run('assign', 'codex-api-routed-fixture', profile.id)).code).toBe(0);
      const nativeStore = fs.readFileSync(STORE_FILE, 'utf8');
      const routed = execute(
        process.execPath,
        [
          path.resolve('out/cli.js'),
          'routed',
          'codex-api-routed-fixture',
          'exec',
          '--skip-git-repo-check',
          '--json',
          'Reply briefly.',
        ],
        {
          env: process.env,
          cwd: sandboxHome,
          timeout: 45000,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      routed.child.stdin?.end();
      expect((await routed).stdout).toContain('fixture-ok');
      expect(fs.readFileSync(STORE_FILE, 'utf8')).toBe(nativeStore);
      expect(seen.every((call) => call.auth === 'Bearer fixture-first')).toBe(true);
      const count = seen.length;
      const unavailable = await call({ model: 'paid-provider-only', input: 'Hello', stream: true });
      expect(unavailable.ok).toBe(false);
      await unavailable.text();
      expect(seen.length).toBe(count);
      await stop(profile.id);
      expect(fs.existsSync(path.join(paths(profile.id).proxy, 'config.yaml'))).toBe(false);
      fs.writeFileSync(file, "export KEY='fixture-rotated'");
      running = await ensureWorker(profile.id, worker);
      await (await call({ model, input: 'Hello', stream: true })).text();
      expect(seen.at(-1)?.auth).toBe('Bearer fixture-rotated');
      for (const status of [401, 429, 503]) {
        code = status;
        const response = await call({ model, input: 'Hello', stream: true });
        expect(response.status).toBe(status);
        await response.text();
        // Reset proxy cooldown by restarting this fixture-owned worker.
        await stop(profile.id);
        running = await ensureWorker(profile.id, worker);
      }
      server.stop(true);
      const outage = await call({ model, input: 'Hello', stream: true });
      expect(outage.status).toBeGreaterThanOrEqual(500);
      await outage.text();
      await stop(profile.id);
      const logs = fs.readdirSync(path.join(paths(profile.id).proxy, 'api-auth'), { recursive: true });
      expect(logs.filter((name) => String(name).endsWith('.log'))).toEqual([]);
      expect(fs.readFileSync(path.join(paths(profile.id).runtime, 'worker.log'), 'utf8')).not.toContain(
        'fixture-rotated',
      );
      fs.unlinkSync(file);
      await expect(ensureWorker(profile.id, worker)).rejects.toThrow();
      expect(await control(profile.id, 'status')).toBeUndefined();
    } catch (error) {
      console.error(fs.readFileSync(path.join(paths(profile.id).runtime, 'worker.log'), 'utf8'));
      throw error;
    } finally {
      await stop(profile.id).catch(() => {});
      server.stop(true);
      if (previous === undefined) delete process.env.SWITCHBOARD_PROXY_BINARY;
      else process.env.SWITCHBOARD_PROXY_BINARY = previous;
    }
  },
  180000,
);
