// Replying and approving from the phone go through the control socket: the
// Claude plugin and the Codex tap ask the hub what to do, and the phone's
// answers reach them. These pin the hub's side over a real Unix socket, and
// the Codex tap against a stand-in engine: what reaches which side, what the
// app never sees, and that a Claude approval goes to the phone only while
// nobody is at the Mac.

import { test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { Control } from '../src/remote/control';
import { codexTap, post } from '../src/remote/codex-tap';

let control: Control;
let socket: string;
let away = true;
let changes = 0;
// What each session's file says its permission mode is.
let modes: Record<string, string> = {};

beforeEach(async () => {
  away = true;
  changes = 0;
  modes = {};
  socket = path.join(os.tmpdir(), `sb-control-${process.pid}-${Date.now()}.sock`);
  control = new Control({
    away: () => away,
    onChange: () => changes++,
    socket,
    holdMs: 1000,
    claudeMode: (profileId, sessionId) => modes[`${profileId}/${sessionId}`] ?? null,
    claudeProfile: (configDir) =>
      configDir === null ? 'claude-default' : configDir.endsWith('/work') ? 'claude-work' : null,
  });
  await control.listen();
});
afterEach(async () => {
  await control.close();
  fs.rmSync(socket, { force: true });
});

const claude = { profileId: 'claude-work', sessionId: 's1' };
const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('a reply reaches the polling Claude session, and only a session that polls can be reached', async () => {
  expect(() => control.reply('claude', claude.profileId, claude.sessionId, 'hi')).toThrow('not-reachable');
  const poll = post(socket, '/claude/poll', claude);
  await until(() => control.reachable().claude.includes('claude-work/s1'));
  control.reply('claude', claude.profileId, claude.sessionId, 'Ship it');
  expect(await poll).toEqual({ commands: [{ type: 'prompt', text: 'Ship it' }] });
  // Delivered once: the next poll has nothing.
  expect(await post(socket, '/claude/poll', claude)).toEqual({ commands: [] });
  expect(fs.statSync(socket).mode & 0o777).toBe(0o600);
});

test('a Claude session that was not told its profile is known by its config dir', async () => {
  // Default Claude opened from the Dock: no SWITCHBOARD_PROFILE, no CLAUDE_CONFIG_DIR.
  const poll = post(socket, '/claude/poll', { profileId: '', sessionId: 's2' });
  await until(() => control.reachable().claude.includes('claude-default/s2'));
  control.reply('claude', 'claude-default', 's2', 'From the Dock');
  expect(await poll).toEqual({ commands: [{ type: 'prompt', text: 'From the Dock' }] });

  const work = post(socket, '/claude/poll', { profileId: '', sessionId: 's3', configDir: '/Users/someone/work' });
  await until(() => control.reachable().claude.includes('claude-work/s3'));
  control.reply('claude', 'claude-work', 's3', 'hi');
  expect(await work).toEqual({ commands: [{ type: 'prompt', text: 'hi' }] });

  // A config dir no profile owns is refused rather than guessed.
  expect(await post(socket, '/claude/poll', { profileId: '', sessionId: 's4', configDir: '/elsewhere' })).toEqual({
    error: 'unknown-profile',
  });
});

test('a Claude approval goes to the phone only while nobody is at the Mac, and the answer waits to be collected', async () => {
  away = false;
  const ask = { ...claude, kind: 'approval', tool: 'Bash', input: { command: 'rm -rf build' } };
  expect(await post(socket, '/claude/ask', ask)).toEqual({ route: 'desk' });
  expect(control.pending()).toEqual([]);

  away = true;
  const { id } = (await post(socket, '/claude/ask', ask)) as { id: string };
  expect(control.pending()).toMatchObject([
    { id, vendor: 'claude', kind: 'approval', title: 'Run a command', detail: 'rm -rf build' },
  ]);
  // Decided between two of the plugin's waits: kept until it asks.
  control.decide(id, { choice: 'allow' });
  expect(control.pending()).toEqual([]);
  expect(await post(socket, '/claude/wait', { id })).toEqual({ status: 'decided', decision: { choice: 'allow' } });
  expect(() => control.decide(id, { choice: 'allow' })).toThrow('no-such-request');
});

test('a held Claude call goes back to the desktop as soon as someone is at the Mac', async () => {
  const { id } = (await post(socket, '/claude/ask', {
    ...claude,
    kind: 'approval',
    tool: 'Write',
    input: { file_path: '/x' },
  })) as {
    id: string;
  };
  const wait = post(socket, '/claude/wait', { id });
  away = false;
  expect(await wait).toEqual({ status: 'release' });
  expect(control.pending()).toEqual([]);
});

test("a Claude question is answered with the person's picks, and a wrong-shaped answer is refused", async () => {
  const input = {
    questions: [
      {
        question: 'Which branch?',
        header: 'Branch',
        options: [{ label: 'main' }, { label: 'dev', description: 'staging' }],
        multiSelect: false,
      },
    ],
  };
  const { id } = (await post(socket, '/claude/ask', {
    ...claude,
    kind: 'question',
    tool: 'AskUserQuestion',
    input,
  })) as { id: string };
  expect(control.pending()[0]).toMatchObject({
    kind: 'question',
    questions: [
      {
        id: 'Which branch?',
        options: [
          { label: 'main', hint: null },
          { label: 'dev', hint: 'staging' },
        ],
      },
    ],
  });
  expect(() => control.decide(id, { choice: 'allow' })).toThrow('bad-answers');
  const wait = post(socket, '/claude/wait', { id });
  control.decide(id, { answers: { 'Which branch?': ['dev'] } });
  expect(await wait).toEqual({ status: 'decided', decision: { answers: { 'Which branch?': ['dev'] } } });
});

// ---- Codex: the tap on the app's connection to its engine ----

function lines(stream: PassThrough): () => Record<string, unknown>[] {
  let text = '';
  stream.on('data', (c: Buffer) => (text += c.toString()));
  return () =>
    text
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function codex() {
  const engine = new PassThrough();
  const toEngine = lines(engine);
  const tap = codexTap({ profileId: 'codex-work', socket, engine });
  const app = new PassThrough();
  const toApp = lines(app);
  tap.fromEngine.pipe(app);
  tap.fromApp.pipe(new PassThrough());
  return {
    tap,
    toEngine,
    toApp,
    fromApp: (m: unknown) => tap.fromApp.write(JSON.stringify(m) + '\n'),
    fromEngine: (m: unknown) => tap.fromEngine.write(JSON.stringify(m) + '\n'),
  };
}

test("a Codex reply becomes the app's own turn, and the engine's answer to it never reaches the app", async () => {
  const c = codex();
  // Until the app asks this engine for threads, it takes no commands.
  await new Promise((r) => setTimeout(r, 100));
  expect(control.reachable().codex).toEqual([]);
  c.fromApp({ id: 'list:1', method: 'thread/list', params: {} });
  await until(() => control.reachable().codex.includes('codex-work'));

  control.reply('codex', 'codex-work', 't1', 'Run the tests');
  await until(() => c.toEngine().some((m) => m.method === 'turn/start'));
  const start = c.toEngine().find((m) => m.method === 'turn/start')!;
  expect(start.params).toEqual({ threadId: 't1', input: [{ type: 'text', text: 'Run the tests' }] });
  c.fromEngine({ id: start.id, result: { turn: { id: 'turn-1' } } });
  c.fromEngine({ method: 'turn/started', params: { threadId: 't1' } });
  await until(() => c.toApp().length === 1);
  expect(c.toApp()).toEqual([{ method: 'turn/started', params: { threadId: 't1' } }]);
  c.tap.stop();
});

test('a Codex approval shows on the phone, its answer goes to the engine, and an answer from the app clears it', async () => {
  const c = codex();
  const ask = {
    method: 'item/commandExecution/requestApproval',
    id: 7,
    params: { threadId: 't1', turnId: 'u1', itemId: 'i1', command: "/bin/zsh -lc 'bun test'" },
  };
  c.fromEngine(ask);
  await until(() => control.pending().length === 1);
  const [p] = control.pending();
  expect(p).toMatchObject({
    vendor: 'codex',
    sessionId: 't1',
    title: 'Run a command',
    detail: "/bin/zsh -lc 'bun test'",
  });
  expect(p.choices.map((x) => x.value)).toEqual(['accept', 'acceptForSession', 'decline']);
  // The app sees the request too.
  expect(c.toApp()).toEqual([ask]);

  c.fromApp({ id: 'list:1', method: 'thread/list', params: {} });
  await until(() => control.reachable().codex.includes('codex-work'));
  control.decide(p.id, { choice: 'acceptForSession' });
  await until(() => c.toEngine().some((m) => m.id === 7));
  expect(c.toEngine().find((m) => m.id === 7)).toEqual({ id: 7, result: { decision: 'acceptForSession' } });

  // The next one the app answers first.
  c.fromEngine({ ...ask, id: 8 });
  await until(() => control.pending().length === 1);
  c.fromApp({ id: 8, result: { decision: 'decline' } });
  await until(() => control.pending().length === 0);
  c.tap.stop();
});

test('a Codex question is answered by question id, and one with a secret answer stays on the Mac', async () => {
  const c = codex();
  c.fromApp({ id: 'list:1', method: 'thread/list', params: {} });
  await until(() => control.reachable().codex.includes('codex-work'));
  c.fromEngine({
    method: 'item/tool/requestUserInput',
    id: 3,
    params: {
      threadId: 't1',
      turnId: 'u',
      itemId: 'i',
      isBlocking: true,
      questions: [{ id: 'q1', header: 'Env', question: 'Where?', options: [{ label: 'Prod', description: '' }] }],
    },
  });
  await until(() => control.pending().length === 1);
  control.decide(control.pending()[0].id, { answers: { q1: ['Prod'] } });
  await until(() => c.toEngine().some((m) => m.id === 3));
  expect(c.toEngine().find((m) => m.id === 3)).toEqual({ id: 3, result: { answers: { q1: { answers: ['Prod'] } } } });

  c.fromEngine({
    method: 'item/tool/requestUserInput',
    id: 4,
    params: {
      threadId: 't1',
      turnId: 'u',
      itemId: 'i',
      isBlocking: true,
      questions: [{ id: 'k', header: 'Key', question: 'API key?', isSecret: true }],
    },
  });
  await new Promise((r) => setTimeout(r, 150));
  expect(control.pending()).toEqual([]);
  c.tap.stop();
});

test('a Codex request for more access is granted for the turn or the session, or declined with nothing', async () => {
  const c = codex();
  c.fromApp({ id: 'list:1', method: 'thread/list', params: {} });
  await until(() => control.reachable().codex.includes('codex-work'));
  const permissions = { network: { enabled: true }, fileSystem: { write: ['/Users/me/.cache'] } };
  const ask = (id: number) => ({
    method: 'item/permissions/requestApproval',
    id,
    params: {
      threadId: 't1',
      turnId: 'u',
      itemId: 'i',
      cwd: '/x',
      startedAtMs: 0,
      reason: 'Install packages',
      permissions,
    },
  });
  c.fromEngine(ask(11));
  await until(() => control.pending().length === 1);
  expect(control.pending()[0]).toMatchObject({
    kind: 'approval',
    title: 'Get more access',
    detail: 'Install packages\nNetwork access\nWrite /Users/me/.cache',
  });
  control.decide(control.pending()[0].id, { choice: 'session' });
  await until(() => c.toEngine().some((m) => m.id === 11));
  expect(c.toEngine().find((m) => m.id === 11)).toEqual({ id: 11, result: { permissions, scope: 'session' } });

  c.fromEngine(ask(12));
  await until(() => control.pending().length === 1);
  control.decide(control.pending()[0].id, { choice: 'decline' });
  await until(() => c.toEngine().some((m) => m.id === 12));
  expect(c.toEngine().find((m) => m.id === 12)).toEqual({ id: 12, result: { permissions: {} } });
  c.tap.stop();
});

test('an MCP form is filled in on the phone, a link prompt is confirmed, and a device check stays on the Mac', async () => {
  const c = codex();
  c.fromApp({ id: 'list:1', method: 'thread/list', params: {} });
  await until(() => control.reachable().codex.includes('codex-work'));
  c.fromEngine({
    method: 'mcpServer/elicitation/request',
    id: 21,
    params: {
      threadId: 't1',
      serverName: 'Linear',
      mode: 'form',
      message: 'Which team gets the issue?',
      requestedSchema: {
        type: 'object',
        required: ['team'],
        properties: {
          team: {
            type: 'string',
            oneOf: [
              { const: 'eng', title: 'Engineering' },
              { const: 'ops', title: 'Operations' },
            ],
          },
          urgent: { type: 'boolean', default: false },
          estimate: { type: 'number', title: 'Estimate (days)' },
          note: { type: 'string', description: 'Shown on the issue' },
          labels: { type: 'array', items: { type: 'string', enum: ['bug', 'docs'] } },
        },
      },
    },
  });
  await until(() => control.pending().length === 1);
  const form = control.pending()[0];
  expect(form).toMatchObject({ kind: 'form', title: 'Linear asks for details', detail: 'Which team gets the issue?' });
  expect(form.fields.map((f) => [f.id, f.type, f.required])).toEqual([
    ['team', 'choice', true],
    ['urgent', 'boolean', false],
    ['estimate', 'number', false],
    ['note', 'text', false],
    ['labels', 'multi', false],
  ]);
  expect(form.fields[0].options).toEqual([
    { value: 'eng', label: 'Engineering' },
    { value: 'ops', label: 'Operations' },
  ]);
  control.decide(form.id, { choice: 'accept', form: { team: 'ops', urgent: true, labels: ['bug'] } });
  await until(() => c.toEngine().some((m) => m.id === 21));
  expect(c.toEngine().find((m) => m.id === 21)).toEqual({
    id: 21,
    result: { action: 'accept', content: { team: 'ops', urgent: true, labels: ['bug'] } },
  });

  c.fromEngine({
    method: 'mcpServer/elicitation/request',
    id: 22,
    params: {
      threadId: 't1',
      serverName: 'GitHub',
      mode: 'url',
      elicitationId: 'e',
      message: 'Sign in',
      url: 'https://github.com/login/device',
    },
  });
  await until(() => control.pending().length === 1);
  expect(control.pending()[0]).toMatchObject({ kind: 'form', url: 'https://github.com/login/device', fields: [] });
  control.decide(control.pending()[0].id, { choice: 'accept' });
  await until(() => c.toEngine().some((m) => m.id === 22));
  expect(c.toEngine().find((m) => m.id === 22)).toEqual({ id: 22, result: { action: 'accept', content: null } });

  c.fromEngine({
    method: 'mcpServer/elicitation/request',
    id: 23,
    params: {
      threadId: 't1',
      serverName: 'X',
      mode: 'openai/userVerification',
      challenge: 'c',
      title: 't',
      description: 'd',
    },
  });
  await new Promise((r) => setTimeout(r, 150));
  expect(control.pending()).toEqual([]);
  c.tap.stop();
});

test('files attached on the phone reach Claude by path and Codex as images of the turn', async () => {
  const shot = { name: 'shot.png', type: 'image/png', path: '/u/1/shot.png' };
  const log = { name: 'build.log', type: 'application/octet-stream', path: '/u/2/build.log' };
  const poll = post(socket, '/claude/poll', claude);
  await until(() => control.reachable().claude.includes('claude-work/s1'));
  control.reply('claude', 'claude-work', 's1', 'Why does this fail?', [shot, log]);
  expect(await poll).toEqual({
    commands: [
      {
        type: 'prompt',
        text: 'Why does this fail?\n\nAttached from my phone (open with the Read tool):\n- /u/1/shot.png\n- /u/2/build.log',
      },
    ],
  });

  const c = codex();
  c.fromApp({ id: 'list:1', method: 'thread/list', params: {} });
  await until(() => control.reachable().codex.includes('codex-work'));
  control.reply('codex', 'codex-work', 't1', '', [shot, log]);
  await until(() => c.toEngine().some((m) => m.method === 'turn/start'));
  expect(c.toEngine().find((m) => m.method === 'turn/start')!.params).toEqual({
    threadId: 't1',
    input: [
      { type: 'text', text: 'Attached from my phone:\n- /u/2/build.log' },
      { type: 'localImage', path: '/u/1/shot.png' },
    ],
  });
  c.tap.stop();
});

test('a Codex reply during a running turn joins the thread queue, and one Codex refuses is reported to the phone', async () => {
  const c = codex();
  c.fromApp({ id: 'list:1', method: 'thread/list', params: {} });
  await until(() => control.reachable().codex.includes('codex-work'));
  c.fromEngine({ method: 'turn/started', params: { threadId: 't1', turn: { id: 'u1' } } });
  control.reply('codex', 'codex-work', 't1', 'Also update the docs');
  await until(() => c.toEngine().some((m) => m.method === 'thread/queue/add'));
  const queued = c.toEngine().find((m) => m.method === 'thread/queue/add')!;
  expect(queued.params).toMatchObject({ threadId: 't1', input: [{ type: 'text', text: 'Also update the docs' }] });
  c.fromEngine({ id: queued.id, error: { message: 'queue is full' } });
  await until(() => control.failures()['codex-work/t1'] === 'queue is full');
  expect(c.toApp().some((m) => m.id === queued.id)).toBe(false);

  // After the turn ends a reply starts one, and clears the old failure.
  c.fromEngine({ method: 'turn/completed', params: { threadId: 't1', turn: { id: 'u1' } } });
  control.reply('codex', 'codex-work', 't1', 'Go on');
  expect(control.failures()).toEqual({});
  await until(() => c.toEngine().some((m) => m.method === 'turn/start'));
  c.tap.stop();
});

test('a reply nobody collects within two minutes is dropped rather than typed in later', async () => {
  const poll = post(socket, '/claude/poll', claude);
  await until(() => control.reachable().claude.includes('claude-work/s1'));
  control.reply('claude', 'claude-work', 's1', 'first');
  await poll;
  const realNow = Date.now;
  control.reply('claude', 'claude-work', 's1', 'stale');
  Date.now = () => realNow() + 3 * 60_000;
  try {
    expect(await post(socket, '/claude/poll', claude)).toEqual({ commands: [] });
  } finally {
    Date.now = realNow;
  }
});

test('an approval in auto mode goes back to Claude, so its classifier decides without waiting on the phone', async () => {
  const ask = { ...claude, kind: 'approval', tool: 'Bash', input: { command: 'cd /tmp && ls' } };
  for (const mode of ['auto', 'dontAsk', 'bypassPermissions']) {
    modes['claude-work/s1'] = mode;
    expect(await post(socket, '/claude/ask', ask)).toEqual({ route: 'desk' });
  }
  expect(control.pending()).toEqual([]);
  // A mode that asks a person still reaches the phone.
  for (const mode of ['default', 'acceptEdits']) {
    modes['claude-work/s1'] = mode;
    expect(await post(socket, '/claude/ask', ask)).toMatchObject({ route: 'phone' });
  }
  // So does a session whose mode is unknown, and a question, which is the person's in any mode.
  delete modes['claude-work/s1'];
  expect(await post(socket, '/claude/ask', ask)).toMatchObject({ route: 'phone' });
  modes['claude-work/s1'] = 'auto';
  const question = { ...claude, kind: 'question', tool: 'AskUserQuestion', input: { questions: [] } };
  expect(await post(socket, '/claude/ask', question)).toMatchObject({ route: 'phone' });
});

test('a Read approval names the file instead of its raw input', async () => {
  const ask = { ...claude, kind: 'approval', tool: 'Read', input: { file_path: '/Users/someone/notes.md' } };
  await post(socket, '/claude/ask', ask);
  expect(control.pending()[0]).toMatchObject({ title: 'Read a file', detail: '/Users/someone/notes.md' });
});
