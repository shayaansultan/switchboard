// Defaults to local fixtures: real Codex -> real CLIProxyAPI -> fake Anthropic.
// SWITCHBOARD_PROBE_LIVE_BUCKET explicitly opts into real model requests.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import * as readline from 'node:readline';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mergedCatalog } from '../src/buckets/models';
import { codexBinary } from '../src/buckets/desktop';
import { paths, secrets } from '../src/buckets/store';

const execute = promisify(execFile);
const model = process.env.SWITCHBOARD_PROBE_MODEL || 'claude-sonnet-4-6';
const script = path.resolve(import.meta.filename);
const tools = Array.from({ length: 421 }, (_, index) => ({
  name: `fixture_tool_${index}`,
  annotations: { readOnlyHint: true },
  description: `Fixture connector operation ${index}. ${'Detailed tool instructions and parameter documentation. '.repeat(30)}`,
  inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
}));

if (process.argv.includes('--mcp')) {
  const input = readline.createInterface({ input: process.stdin });
  input.on('line', (line) => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    let result: any = {};
    if (request.method === 'initialize')
      result = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'context-fixture', version: '1' },
      };
    if (request.method === 'tools/list') result = { tools };
    if (request.method === 'tools/call') {
      const valid = request.params.name === 'fixture_tool_420' && request.params.arguments?.value === 'proof';
      result = {
        content: [{ type: 'text', text: valid ? 'CONNECTOR_EXECUTED' : 'Unexpected fixture call' }],
        isError: !valid,
      };
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
  });
} else {
  await run();
}

async function listen(server: http.Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as { port: number }).port;
}

function server(handler: (request: http.IncomingMessage, response: http.ServerResponse) => Promise<void>) {
  return http.createServer((request, response) => {
    void handler(request, response).catch((error: Error) => {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error.message, type: 'fixture_error' } }));
    });
  });
}

async function stopProxy(proxy: ChildProcess) {
  if (proxy.exitCode !== null || proxy.signalCode !== null || !proxy.pid) return;
  const exited = once(proxy, 'exit');
  proxy.kill('SIGTERM');
  const deadline = setTimeout(() => proxy.kill('SIGKILL'), 3000);
  try {
    await exited;
  } finally {
    clearTimeout(deadline);
  }
}

function summary(payload: any) {
  const definitions = payload.tools ?? [];
  return {
    model: payload.model,
    bytes: Buffer.byteLength(JSON.stringify(payload)),
    tools: definitions.length,
    toolBytes: Buffer.byteLength(JSON.stringify(definitions)),
    instructionBytes: Buffer.byteLength(JSON.stringify(payload.instructions ?? payload.system ?? '')),
    messageBytes: Buffer.byteLength(JSON.stringify(payload.input ?? payload.messages ?? [])),
    toolTypes: [...new Set(definitions.map((tool: any) => tool.type ?? 'function'))],
    names: definitions.slice(0, 12).map((tool: any) => tool.name),
    hasSearchTool: definitions.some((tool: any) => tool.type === 'tool_search' || tool.name === 'tool_search'),
  };
}

async function run() {
  const requests: any[] = [];
  const upstreamRequests: any[] = [];
  const usage: any[] = [];
  const liveBucket = process.env.SWITCHBOARD_PROBE_LIVE_BUCKET;
  const liveReceipt = liveBucket
    ? JSON.parse(fs.readFileSync(path.join(paths(liveBucket).runtime, 'worker.json'), 'utf8'))
    : undefined;
  const apiKey = liveBucket ? secrets(liveBucket).apiKey : 'local-fixture-key';
  const exercise = process.env.SWITCHBOARD_PROBE_EXERCISE === '1';
  const selectedVariant = process.env.SWITCHBOARD_PROBE_VARIANT || (liveBucket || exercise ? 'production' : undefined);
  const proxyBinary =
    process.env.SWITCHBOARD_PROXY_BINARY || path.join(os.homedir(), '.switchboard/bin/cliproxyapi-7.3.2/cli-proxy-api');
  if (!liveBucket) fs.accessSync(proxyBinary, fs.constants.X_OK);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-context-'));
  let proxy: ChildProcess | undefined;
  let proxyPort = liveReceipt?.proxyPort;
  let step = 0;
  const upstream = server(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    upstreamRequests.push(payload);
    const scripts = [
      'text(ALL_TOOLS.filter(t => t.name.endsWith("fixture_tool_420")));',
      'const t = ALL_TOOLS.find(t => t.name.endsWith("fixture_tool_420")); text(await tools[t.name]({value:"proof"}));',
      'text(await tools.exec_command({cmd:"printf context-proof > proof.txt"}));',
    ];
    const source = exercise ? scripts[step++] : undefined;
    if (source && !payload.tools.some((tool: any) => tool.name === 'exec'))
      throw new Error('Exercise requires code-mode exec');
    const events = [
      {
        type: 'message_start',
        message: {
          id: 'msg_context',
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 20, output_tokens: 1 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: source
          ? { type: 'tool_use', id: `tool_context_${upstreamRequests.length}`, name: 'exec', input: {} }
          : { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: source
          ? { type: 'input_json_delta', partial_json: JSON.stringify({ input: source }) }
          : { type: 'text_delta', text: 'CONTEXT_FIXTURE_OK' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: source ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: 10 },
      },
      { type: 'message_stop' },
    ];
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  const reservation = http.createServer();
  const capture = server(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (body.length) requests.push(JSON.parse(body.toString()));
    const result = await fetch(`http://127.0.0.1:${proxyPort}${request.url}`, {
      method: request.method,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: body.length ? body : undefined,
      signal: AbortSignal.timeout(liveBucket ? 180000 : 60000),
    });
    const output = Buffer.from(await result.arrayBuffer());
    for (const line of output.toString().split('\n')) {
      if (!line.startsWith('data: {')) continue;
      const event = JSON.parse(line.slice(6));
      if (event.type === 'response.completed') usage.push(event.response.usage);
    }
    response.writeHead(result.status, { 'Content-Type': result.headers.get('content-type') ?? 'application/json' });
    response.end(output);
  });
  try {
    const capturePort = await listen(capture);
    if (!liveBucket) {
      const upstreamPort = await listen(upstream);
      proxyPort = await listen(reservation);
      await new Promise<void>((resolve) => reservation.close(() => resolve()));
      const config = path.join(temporary, 'proxy.json');
      fs.writeFileSync(
        config,
        JSON.stringify({
          host: '127.0.0.1',
          port: proxyPort,
          'auth-dir': path.join(temporary, 'auth'),
          'api-keys': ['local-fixture-key'],
          'claude-api-key': [
            {
              'api-key': 'fixture-key',
              'base-url': `http://127.0.0.1:${upstreamPort}`,
              models: [{ name: model }],
              cloak: { mode: 'never' },
            },
          ],
          'remote-management': { 'disable-control-panel': true },
        }),
      );
      proxy = spawn(proxyBinary, ['-config', config], { cwd: temporary, stdio: 'ignore' });
      await once(proxy, 'spawn');
      let ready = false;
      for (let attempt = 0; attempt < 100 && !ready; attempt++) {
        try {
          ready = (
            await fetch(`http://127.0.0.1:${proxyPort}/v1/models`, {
              headers: { Authorization: 'Bearer local-fixture-key' },
            })
          ).ok;
        } catch {}
        if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!ready) throw new Error('Proxy did not start');
    }
    const bundled = JSON.parse(
      (await execute(codexBinary(), ['debug', 'models', '--bundled'], { maxBuffer: 16 * 1024 * 1024 })).stdout,
    );
    const variants = [
      { name: 'production', mcp: true, overrides: {} },
      { name: 'no-connectors', mcp: false, overrides: {} },
      { name: 'baseline', mcp: true, overrides: {} },
      { name: 'search', mcp: true, overrides: { supports_search_tool: true } },
      { name: 'repl', mcp: true, overrides: { node_repl_disabled: false } },
      { name: 'search-repl', mcp: true, overrides: { supports_search_tool: true, node_repl_disabled: false } },
      { name: 'code-mode', mcp: true, overrides: { node_repl_disabled: false, tool_mode: 'code_mode_only' } },
      {
        name: 'search-code-mode',
        mcp: true,
        overrides: { supports_search_tool: true, node_repl_disabled: false, tool_mode: 'code_mode_only' },
      },
      {
        name: 'search-code-mode-disabled-repl',
        mcp: true,
        overrides: { supports_search_tool: true, tool_mode: 'code_mode_only' },
      },
    ];
    if (selectedVariant && !variants.some((variant) => variant.name === selectedVariant))
      throw new Error(`Unknown probe variant: ${selectedVariant}`);
    for (const variant of variants) {
      if (selectedVariant && variant.name !== selectedVariant) continue;
      const home = path.join(temporary, variant.name);
      fs.mkdirSync(home);
      const catalog = mergedCatalog(bundled, [
        {
          id: model,
          display_name: 'Claude fixture',
          context_length: 1000000,
          max_completion_tokens: 64000,
          supportedInputModalities: ['text'],
          supportedOutputModalities: ['text'],
          thinking: { levels: ['low', 'high'] },
        },
      ]);
      Object.assign(
        catalog.models.find((entry) => entry.slug === model)!,
        variant.name === 'production' ? {} : { supports_search_tool: false, tool_mode: undefined },
        variant.overrides,
      );
      const catalogPath = path.join(home, 'catalog.json');
      fs.writeFileSync(catalogPath, JSON.stringify(catalog));
      fs.writeFileSync(
        path.join(home, 'config.toml'),
        `model = "${model}"\nmodel_reasoning_effort = "low"\n[features]\ncode_mode_host = ${process.env.SWITCHBOARD_PROBE_CODE_MODE !== '0'}\ntool_search_always_defer_mcp_tools = true\n${variant.mcp ? `[mcp_servers.fixture]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([script, '--mcp'])}\nstartup_timeout_sec = 30\n` : ''}`,
      );
      requests.length = 0;
      upstreamRequests.length = 0;
      usage.length = 0;
      step = 0;
      const provider = `{name="Fixture",base_url="http://127.0.0.1:${capturePort}/v1",wire_api="responses",env_key="SWITCHBOARD_PROXY_API_KEY",requires_openai_auth=false}`;
      const prompt =
        exercise && liveBucket
          ? 'Discover fixture_tool_420 without printing the full tool catalog. Call it with value "proof". Write context-proof to proof.txt using the shell. Then reply exactly CONTEXT_FIXTURE_OK. Perform only these verification steps.'
          : 'Reply exactly CONTEXT_FIXTURE_OK.';
      const invoke = async (args: string[]) => {
        const invocation = execute(
          codexBinary(),
          [
            'exec',
            ...args,
            '-c',
            'model_provider="fixture"',
            '-c',
            `model_providers.fixture=${provider}`,
            '-c',
            `model_catalog_json=${JSON.stringify(catalogPath)}`,
          ],
          {
            cwd: home,
            env: { ...process.env, CODEX_HOME: home, SWITCHBOARD_PROXY_API_KEY: 'local-fixture-key' },
            timeout: liveBucket ? 180000 : 60000,
            maxBuffer: 16 * 1024 * 1024,
          },
        );
        invocation.child.stdin?.end();
        return invocation;
      };
      const result = await invoke(['--skip-git-repo-check', '--sandbox', 'workspace-write', '--json', prompt]);
      if (!result.stdout.includes('CONTEXT_FIXTURE_OK')) throw new Error(`No fixture reply: ${variant.name}`);
      if (exercise) {
        const history = liveBucket ? requests.at(-1).input : upstreamRequests.at(-1).messages;
        if (!JSON.stringify(history).includes('CONNECTOR_EXECUTED')) throw new Error('Connector execution failed');
        if (fs.readFileSync(path.join(home, 'proof.txt'), 'utf8').trimEnd() !== 'context-proof')
          throw new Error('Shell execution failed');
        const thread = result.stdout
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .find((event) => event.type === 'thread.started').thread_id;
        fs.unlinkSync(path.join(home, 'proof.txt'));
        step = 0;
        const resumedResult = await invoke([
          'resume',
          '--skip-git-repo-check',
          '--json',
          thread,
          'Repeat the verification, including recreating proof.txt.',
        ]);
        if (
          !resumedResult.stdout.includes('CONTEXT_FIXTURE_OK') ||
          !resumedResult.stdout.includes('CONNECTOR_EXECUTED')
        )
          throw new Error('Resume execution failed');
        if (fs.readFileSync(path.join(home, 'proof.txt'), 'utf8').trimEnd() !== 'context-proof')
          throw new Error('Resumed shell execution failed');
        console.log(JSON.stringify({ exercise: 'discovery-connector-shell-resume', passed: true }));
      }
      console.log(
        JSON.stringify({
          variant: variant.name,
          live: !!liveBucket,
          sourceTools: variant.mcp ? tools.length : 0,
          codex: requests.map(summary),
          anthropic: upstreamRequests.map(summary),
          usage,
        }),
      );
    }
  } finally {
    if (proxy) await stopProxy(proxy);
    for (const server of [capture, upstream, reservation]) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
