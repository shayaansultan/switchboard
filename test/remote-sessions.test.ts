// The phone shows what each profile's agents are doing, read from the files
// Claude and Codex write. These pin what it must get right from those files:
// which session is working, what it is called, which files are not sessions
// of their own, and what the transcript leaves out.

import { test, expect, beforeEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sandboxHome } from './setup';
import { SessionReader, STALE_MS, type ProfileHome } from '../src/remote/sessions';

const root = path.join(sandboxHome, 'remote-sessions');
const claude: ProfileHome = { id: 'claude-work', vendor: 'claude', home: path.join(root, 'claude') };
const codex: ProfileHome = { id: 'codex-work', vendor: 'codex', home: path.join(root, 'codex') };

beforeEach(() => fs.rmSync(root, { recursive: true, force: true }));

function write(file: string, records: unknown[], mtime = Date.now()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.utimesSync(file, mtime / 1000, mtime / 1000);
}

const prompt = (text: string, extra = {}) => ({
  type: 'user',
  sessionId: 's1',
  cwd: '/Users/me/Developer/app',
  entrypoint: 'claude-desktop',
  timestamp: '2026-10-18T01:00:00Z',
  message: { role: 'user', content: text },
  ...extra,
});
const reply = (content: unknown[], stop: string | null) => ({
  type: 'assistant',
  sessionId: 's1',
  timestamp: '2026-10-18T01:00:05Z',
  message: { role: 'assistant', content, stop_reason: stop },
});
const claudeFile = (id = 's1') => path.join(claude.home, 'projects', '-Users-me-Developer-app', `${id}.jsonl`);

test('a Claude session mid tool call is working, and one that stopped on its own is idle', () => {
  write(claudeFile(), [
    prompt('Fix the login bug'),
    reply([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'bun test' } }], 'tool_use'),
  ]);
  const [working] = new SessionReader().list([claude]);
  expect(working).toMatchObject({
    id: 's1',
    state: 'working',
    origin: 'desktop',
    title: 'Fix the login bug',
    cwd: '/Users/me/Developer/app',
  });

  write(claudeFile(), [prompt('Fix the login bug'), reply([{ type: 'text', text: 'Fixed it.' }], 'end_turn')]);
  const [idle] = new SessionReader().list([claude]);
  expect(idle.state).toBe('idle');
  expect(idle.lastMessage).toEqual({ role: 'assistant', text: 'Fixed it.' });
});

test('a Claude turn the person interrupted, or one nobody has written to in a while, is not working', () => {
  write(claudeFile(), [prompt('Go'), prompt('[Request interrupted by user for tool use]')]);
  expect(new SessionReader().list([claude])[0].state).toBe('idle');

  write(
    claudeFile(),
    [prompt('Go'), reply([{ type: 'tool_use', id: 't', name: 'Bash', input: {} }], 'tool_use')],
    Date.now() - STALE_MS - 1000,
  );
  expect(new SessionReader().list([claude])[0].state).toBe('idle');
});

test('a Claude title set in the app wins over the first prompt, and subagent files are not sessions', () => {
  write(claudeFile(), [
    prompt('long first prompt'),
    { type: 'custom-title', sessionId: 's1', customTitle: 'Login bug' },
  ]);
  write(path.join(claude.home, 'projects', '-Users-me-Developer-app', 's1', 'subagents', 'agent-1.jsonl'), [
    prompt('sub'),
  ]);
  const sessions = new SessionReader().list([claude]);
  expect(sessions.map((s) => s.title)).toEqual(['Login bug']);
});

test('a Claude transcript drops attached reminders and tool results, and marks failed tool calls', () => {
  write(claudeFile(), [
    prompt('Run the tests<system-reminder>internal</system-reminder>'),
    reply([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'bun test' } }], 'tool_use'),
    prompt('', {
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'boom' }] },
    }),
    reply([{ type: 'text', text: 'Two tests fail.' }], 'end_turn'),
  ]);
  const reader = new SessionReader();
  reader.list([claude]);
  const { entries } = reader.transcript([claude], 'claude-work', 's1')!;
  expect(entries.map((e) => ({ ...e, at: undefined }))).toEqual([
    { kind: 'user', text: 'Run the tests', at: undefined },
    { kind: 'tool', name: 'Bash', detail: 'bun test', failed: true, at: undefined },
    { kind: 'assistant', text: 'Two tests fail.', at: undefined },
  ]);
});

// ---- Codex ----

function rollout(id: string, events: unknown[], meta: Record<string, unknown> = {}, mtime = Date.now()): string {
  const d = new Date(mtime);
  const dir = path.join(
    codex.home,
    'sessions',
    String(d.getFullYear()),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  );
  const file = path.join(dir, `rollout-2026-10-18T01-00-00-${id}.jsonl`);
  write(
    file,
    [
      { type: 'session_meta', payload: { id, cwd: '/Users/me/Developer/app', originator: 'Codex Desktop', ...meta } },
      ...events,
    ],
    mtime,
  );
  return file;
}
const event = (payload: unknown) => ({ type: 'event_msg', timestamp: '2026-10-18T01:00:00Z', payload });
const item = (i: unknown) => event({ type: 'item_completed', item: i });
const userMessage = (text: string) => item({ type: 'UserMessage', content: [{ type: 'text', text }] });

test('a Codex thread is working between task_started and task_complete, and takes its name from the index', () => {
  rollout('t1', [event({ type: 'task_started' }), userMessage('Add dark mode')]);
  fs.writeFileSync(
    path.join(codex.home, 'session_index.jsonl'),
    JSON.stringify({ id: 't1', thread_name: 'Dark mode' }) + '\n',
  );
  const [working] = new SessionReader().list([codex]);
  expect(working).toMatchObject({ id: 't1', title: 'Dark mode', state: 'working', origin: 'desktop' });

  rollout('t1', [event({ type: 'task_started' }), userMessage('Add dark mode'), event({ type: 'task_complete' })]);
  expect(new SessionReader().list([codex])[0].state).toBe('idle');
});

test('a Codex subagent thread is part of its parent, not a session of its own', () => {
  rollout('parent', [userMessage('Plan it')]);
  rollout('child', [userMessage('Sub task')], { source: { subagent: { other: 'guardian' } } });
  expect(new SessionReader().list([codex]).map((s) => s.id)).toEqual(['parent']);
});

test('a codex exec run is titled by its prompt, found past the instructions Codex injects first', () => {
  const instructions = {
    type: 'response_item',
    payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'x'.repeat(100_000) }] },
  };
  const context = {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: '# AGENTS.md instructions' },
        { type: 'input_text', text: '<environment_context/>' },
      ],
    },
  };
  const ask = {
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review the branch' }] },
  };
  rollout(
    'e1',
    [instructions, context, ask, item({ type: 'AgentMessage', content: [{ type: 'Text', text: 'READY' }] })],
    { originator: 'codex_exec' },
  );
  expect(new SessionReader().list([codex])[0]).toMatchObject({ title: 'Review the branch', origin: 'exec' });
});
