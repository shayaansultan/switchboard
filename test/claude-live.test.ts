// Opt-in real Codex -> CLIProxyAPI -> local Anthropic fixture round trip.
// No subscription credentials are read or used.
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mergedCatalog } from '../src/buckets/models';
import { wrapperScript, codexBinary } from '../src/buckets/desktop';

const execute = promisify(execFile);
const live = process.env.SWITCHBOARD_LIVE_TESTS === '1' ? test : test.skip;
async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

live(
  'Claude Responses translation runs a shell edit and resumes through real desktop Codex',
  async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-claude-live-'));
    const home = path.join(temporary, 'home');
    fs.mkdirSync(home);
    const model = 'claude-sonnet-4-6';
    const requests: { model: string; tools: { name: string }[]; messages: { content: unknown }[] }[] = [];
    const upstream = http.createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        const payload = JSON.parse(body);
        requests.push(payload);
        const tool = payload.tools?.find((entry: { name: string }) => entry.name === 'exec');
        const hasResult = JSON.stringify(payload.messages).includes('tool_result');
        const useTool = tool && !hasResult;
        const content = useTool
          ? { type: 'tool_use', id: 'tool_fixture', name: tool.name, input: {} }
          : { type: 'text', text: '' };
        const events = [
          {
            type: 'message_start',
            message: {
              id: 'msg_fixture',
              type: 'message',
              role: 'assistant',
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 20, output_tokens: 1 },
            },
          },
          { type: 'content_block_start', index: 0, content_block: content },
          {
            type: 'content_block_delta',
            index: 0,
            delta: useTool
              ? {
                  type: 'input_json_delta',
                  partial_json: JSON.stringify({
                    input: 'text(await tools.exec_command({cmd:"printf fixture-write-ok > proof.txt"}));',
                  }),
                }
              : { type: 'text_delta', text: 'CLAUDE_FIXTURE_OK' },
          },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: useTool ? 'tool_use' : 'end_turn', stop_sequence: null },
            usage: { output_tokens: 10 },
          },
          { type: 'message_stop' },
        ];
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        response.end();
      });
    });
    const upstreamPort = await listen(upstream);
    const reservation = http.createServer();
    const port = await listen(reservation);
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const config = path.join(temporary, 'proxy.json');
    fs.writeFileSync(
      config,
      JSON.stringify({
        host: '127.0.0.1',
        port,
        'auth-dir': path.join(temporary, 'auth'),
        'api-keys': ['local-fixture-key'],
        'claude-api-key': [
          {
            'api-key': 'upstream-fixture-key',
            'base-url': `http://127.0.0.1:${upstreamPort}`,
            models: [{ name: model }],
            cloak: { mode: 'never' },
          },
        ],
        'remote-management': { 'disable-control-panel': true },
      }),
    );
    const proxy = spawn(
      path.join(os.homedir(), '.switchboard/bin/cliproxyapi-7.3.2/cli-proxy-api'),
      ['-config', config],
      { cwd: temporary, stdio: 'ignore' },
    );
    const env = { ...process.env, CODEX_HOME: home, SWITCHBOARD_PROXY_API_KEY: 'local-fixture-key' };
    try {
      let ready = false;
      for (let attempt = 0; attempt < 100 && !ready; attempt++) {
        try {
          ready = (
            await fetch(`http://127.0.0.1:${port}/v1/models`, {
              headers: { Authorization: 'Bearer local-fixture-key' },
            })
          ).ok;
        } catch {}
        if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(ready).toBe(true);
      const bundled = JSON.parse(
        (await execute(codexBinary, ['debug', 'models', '--bundled'], { env, maxBuffer: 16 * 1024 * 1024 })).stdout,
      );
      const catalog = path.join(home, 'catalog.json');
      fs.writeFileSync(
        catalog,
        JSON.stringify(
          mergedCatalog(bundled, [
            {
              id: model,
              display_name: 'Claude fixture',
              context_length: 200000,
              max_completion_tokens: 64000,
              supportedInputModalities: ['text', 'image'],
              supportedOutputModalities: ['text'],
              thinking: { levels: ['low', 'high'] },
            },
          ]),
        ),
      );
      fs.writeFileSync(
        path.join(home, 'config.toml'),
        `model = "${model}"\nmodel_reasoning_effort = "low"\n[features]\ncode_mode_host = true\n`,
      );
      const wrapper = path.join(temporary, 'codex-wrapper');
      fs.writeFileSync(
        wrapper,
        wrapperScript(codexBinary, `http://127.0.0.1:${port}/v1`, {
          bucket: 'Fixture',
          runtime: process.execPath,
          adapter: path.resolve(import.meta.dir, '../out/buckets/desktop-stdio.js'),
          catalog,
        }),
        { mode: 0o700 },
      );
      const first = execute(
        wrapper,
        [
          'exec',
          '--skip-git-repo-check',
          '--sandbox',
          'workspace-write',
          '--json',
          'Write proof.txt using the shell, then reply.',
        ],
        { env, cwd: temporary, timeout: 60000 },
      );
      first.child.stdin?.end();
      const result = await first;
      expect(result.stdout).toContain('CLAUDE_FIXTURE_OK');
      expect(result.stdout).toContain('command_execution');
      expect(fs.readFileSync(path.join(temporary, 'proof.txt'), 'utf8')).toBe('fixture-write-ok');
      expect(requests.some((request) => JSON.stringify(request.messages).includes('tool_result'))).toBe(true);
      expect(requests.every((request) => request.model === model)).toBe(true);
      const thread = result.stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((event) => event.type === 'thread.started').thread_id;
      const resumed = execute(
        wrapper,
        ['exec', 'resume', '--skip-git-repo-check', '--json', thread, 'Reply once more.'],
        { env, cwd: temporary, timeout: 60000 },
      );
      resumed.child.stdin?.end();
      expect((await resumed).stdout).toContain('CLAUDE_FIXTURE_OK');
    } finally {
      proxy.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        proxy.once('exit', () => resolve());
        setTimeout(resolve, 3000).unref();
      });
      if (proxy.exitCode === null && proxy.signalCode === null) proxy.kill('SIGKILL');
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  },
  150000,
);
