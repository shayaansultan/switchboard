// The phone shows what each profile's agents are doing, read from the files
// Claude and Codex write. These pin what it must get right from those files:
// which state a session is in, what it is called, what it asked and produced,
// which files are not sessions of their own, and that a long session can be
// paged without reading it whole.

import { test, expect, beforeEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sandboxHome } from './setup';
import { SessionReader, STALE_MS, type ProfileHome } from '../src/remote/sessions';
import type { Entry, Transcript } from '../src/remote/model';
import { sessionMode, PAGE_BYTES } from '../src/remote/claude';

const root = path.join(sandboxHome, 'remote-sessions');
const claude: ProfileHome = { id: 'claude-work', vendor: 'claude', home: path.join(root, 'claude') };
const codex: ProfileHome = { id: 'codex-work', vendor: 'codex', home: path.join(root, 'codex') };

beforeEach(() => fs.rmSync(root, { recursive: true, force: true }));

function write(file: string, records: unknown[], mtime = Date.now()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.utimesSync(file, mtime / 1000, mtime / 1000);
}

const kinds = (entries: Entry[]) => entries.map((e) => e.kind);

// ---- Claude ----

const base = { sessionId: 's1', cwd: '/Users/me/Developer/app', entrypoint: 'claude-desktop', gitBranch: 'fix/login' };
const prompt = (content: unknown, extra = {}) => ({
  ...base,
  type: 'user',
  timestamp: '2026-10-18T01:00:00Z',
  message: { role: 'user', content },
  ...extra,
});
const reply = (content: unknown[], stop: string | null, extra = {}) => ({
  ...base,
  type: 'assistant',
  timestamp: '2026-10-18T01:00:05Z',
  message: { role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: stop },
  ...extra,
});
const tool = (id: string, name: string, input: unknown) => reply([{ type: 'tool_use', id, name, input }], 'tool_use');
const result = (id: string, content: unknown, toolUseResult: unknown = {}, isError = false) =>
  prompt([{ type: 'tool_result', tool_use_id: id, content, is_error: isError }], { toolUseResult });
const claudeFile = (id = 's1') => path.join(claude.home, 'projects', '-Users-me-Developer-app', `${id}.jsonl`);

function session(records: unknown[], mtime?: number) {
  write(claudeFile(), records, mtime);
  const reader = new SessionReader();
  const [summary] = reader.list([claude]);
  return { summary, transcript: summary && reader.transcript([claude], claude.id, summary.id)! };
}

test('a Claude session mid tool call is working; one that stopped on its own is finished', () => {
  const working = session([prompt('Fix the login bug'), tool('t1', 'Bash', { command: 'bun test' })]).summary;
  expect(working).toMatchObject({
    state: 'working',
    origin: 'desktop',
    title: 'Fix the login bug',
    branch: 'fix/login',
    model: 'claude-opus-5-5',
  });

  const done = session([prompt('Fix the login bug'), reply([{ type: 'text', text: 'Fixed it.' }], 'end_turn')]).summary;
  expect(done.state).toBe('finished');
  expect(done.lastMessage).toEqual({ role: 'assistant', text: 'Fixed it.' });
});

test('a Claude turn the person stopped, one that went quiet, and one that hit an API error each say so', () => {
  expect(session([prompt('Go'), prompt('[Request interrupted by user for tool use]')]).summary.state).toBe('stopped');
  expect(session([prompt('Go'), tool('t', 'Bash', {})], Date.now() - STALE_MS - 1000).summary.state).toBe('finished');
  expect(
    session([
      prompt('Go'),
      { type: 'system', subtype: 'api_error', content: 'Overloaded', timestamp: '2026-10-18T01:00:09Z' },
    ]).summary.state,
  ).toBe('errored');
});

test('an unanswered Claude question puts the session in needs-you, and the answer closes it', () => {
  const ask = tool('q1', 'AskUserQuestion', {
    questions: [
      {
        question: 'Which index?',
        multiSelect: false,
        options: [{ label: 'B-tree', description: 'Fast, small' }, { label: 'Full text' }],
      },
    ],
  });
  const waiting = session([prompt('Make search fast'), ask]);
  expect(waiting.summary).toMatchObject({ state: 'needs-you', needs: 'Which index?' });
  expect(waiting.transcript.entries[1]).toMatchObject({
    kind: 'question',
    questions: [
      {
        text: 'Which index?',
        options: [
          { label: 'B-tree', hint: 'Fast, small' },
          { label: 'Full text', hint: null },
        ],
      },
    ],
    answers: null,
  });

  const answered = session([
    prompt('Make search fast'),
    ask,
    result('q1', 'User answered', { answers: { 'Which index?': 'B-tree' } }),
    reply([{ type: 'text', text: 'Adding it.' }], 'end_turn'),
  ]);
  expect(answered.summary.state).toBe('finished');
  expect(answered.transcript.entries[1]).toMatchObject({ kind: 'question', answers: ['B-tree'] });
});

test('Claude tool calls gather into one steps entry, with output, failures, diffs and connector names', () => {
  const { transcript } = session([
    prompt('Run the tests<system-reminder>internal</system-reminder>'),
    tool('t1', 'Bash', { command: 'bun test' }),
    result('t1', 'boom', { stdout: '2 failed', stderr: 'boom' }, true),
    tool('t2', 'Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }),
    result('t2', 'ok', {
      filePath: 'src/a.ts',
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
    }),
    tool('t3', 'mcp__99486f1e-5fa9-4730-b81b-8efeb06ef414__notion-search', { query: 'roadmap' }),
    reply([{ type: 'text', text: 'Two tests fail.' }], 'end_turn'),
  ]);
  expect(kinds(transcript.entries)).toEqual(['message', 'steps', 'message']);
  expect(transcript.entries[0]).toMatchObject({ role: 'user', text: 'Run the tests' });
  const steps = transcript.entries[1] as Extract<Entry, { kind: 'steps' }>;
  expect(steps.calls.map((c) => [c.name, c.service, c.detail, c.failed])).toEqual([
    ['Shell', null, 'bun test', true],
    ['Edit', null, 'src/a.ts', false],
    ['notion search', 'Notion', 'roadmap', false],
  ]);
  expect(steps.calls[0].output).toBe('2 failed\nboom');
  expect(steps.calls[1].change).toMatchObject({ path: 'src/a.ts', kind: 'modify', adds: 1, dels: 1 });
});

test('what a Claude session produced becomes entries: one PR however often it is recorded, artifacts, subagents', () => {
  const pr = {
    type: 'pr-link',
    sessionId: 's1',
    prNumber: 42,
    prUrl: 'https://github.com/me/app/pull/42',
    prRepository: 'me/app',
    timestamp: '2026-10-18T01:00:06Z',
  };
  const { summary, transcript } = session([
    prompt('Ship it'),
    tool('a1', 'Agent', { description: 'Find callers', prompt: '…' }),
    result('a1', [{ type: 'text', text: 'Found 3 callers.' }]),
    tool('f1', 'Artifact', { file_path: '/tmp/notes.html' }),
    result('f1', 'Published /tmp/notes.html at https://claude.ai/artifact/AbC123 (Version 1)'),
    pr,
    reply([{ type: 'text', text: 'Opened the PR.' }], 'end_turn'),
    pr,
  ]);
  expect(transcript.entries.filter((e) => e.kind === 'pr')).toHaveLength(1);
  expect(transcript.entries.find((e) => e.kind === 'subagent')).toMatchObject({
    title: 'Find callers',
    summary: 'Found 3 callers.',
  });
  expect(transcript.entries.find((e) => e.kind === 'artifact')).toMatchObject({
    url: 'https://claude.ai/artifact/AbC123',
    title: 'notes',
  });
  expect(summary.prs).toEqual([{ url: 'https://github.com/me/app/pull/42', number: 42, repo: 'me/app' }]);
});

test("a Claude prompt typed while the agent works shows as queued until it is picked up, and the agent's task list feeds the summary", () => {
  const plan = tool('p1', 'TodoWrite', {
    todos: [
      { content: 'Read', status: 'completed' },
      { content: 'Fix', status: 'in_progress' },
      { content: 'Test', status: 'pending' },
    ],
  });
  const { summary, transcript } = session([
    prompt('Fix it'),
    plan,
    {
      type: 'queue-operation',
      operation: 'enqueue',
      content: 'also update the docs',
      timestamp: '2026-10-18T01:00:07Z',
    },
    tool('t1', 'Bash', { command: 'bun test' }),
  ]);
  expect(transcript.entries.at(-1)).toMatchObject({
    kind: 'message',
    role: 'user',
    text: 'also update the docs',
    queued: true,
  });
  expect(summary.plan).toEqual({ done: 1, total: 3, current: 'Fix' });
  expect(transcript.entries.some((e) => e.kind === 'steps' && e.calls.some((c) => c.name === 'TodoWrite'))).toBe(false);
});

test('a Claude title set in the app wins over the first prompt, and subagent files are not sessions', () => {
  write(claudeFile(), [
    prompt('long first prompt'),
    { type: 'custom-title', sessionId: 's1', customTitle: 'Login bug' },
  ]);
  write(path.join(claude.home, 'projects', '-Users-me-Developer-app', 's1', 'subagents', 'agent-1.jsonl'), [
    prompt('sub'),
  ]);
  expect(new SessionReader().list([claude]).map((s) => s.title)).toEqual(['Login bug']);
});

test('a Claude session whose turn ended is still working while what it started in the background runs', () => {
  const hour = 3600_000;
  const launch = [
    prompt('Catch me up'),
    tool('a1', 'Agent', { description: 'Read the PRs', prompt: '…', run_in_background: true }),
    result('a1', 'Async agent launched', {
      isAsync: true,
      status: 'async_launched',
      agentId: 'ag1',
      description: 'Read the PRs',
    }),
    tool('b1', 'Bash', { command: 'bun test', run_in_background: true }),
    result('b1', 'Command running in background with ID: bx1.', { backgroundTaskId: 'bx1' }),
    reply([{ type: 'text', text: 'Both are running; I will report back.' }], 'end_turn'),
  ];
  // Long after the last write, but within the background window.
  const busy = session(launch, Date.now() - hour).summary;
  expect(busy).toMatchObject({ state: 'working', background: 2 });

  // The command reports mid-turn as a queued attachment; the agent hands back as a peer message.
  const notice =
    '<task-notification>\n<task-id>bx1</task-id>\n<status>completed</status>\n<summary>Background command "bun test" completed</summary>\n</task-notification>';
  const report =
    '<agent-message from="ag1">\n[Subagent hand-back] The text below is the final report. The report follows:\n  Found **two** PRs.\n  Both pass.\n</agent-message>';
  const done = session(
    [
      ...launch,
      { ...base, type: 'queue-operation', operation: 'enqueue', content: notice },
      { ...base, type: 'attachment', timestamp: 't', attachment: { type: 'queued_command', prompt: notice } },
      { ...base, type: 'queue-operation', operation: 'remove', content: notice },
      prompt(report, { origin: { kind: 'peer', from: 'ag1', name: 'general-purpose', body: report } }),
      prompt(
        '<task-notification>\n<task-id>ag1</task-id>\n<status>completed</status>\n<summary>Agent "Read the PRs" finished</summary>\n<result>This agent\'s report was delivered to you as a message.</result>\n</task-notification>',
        { origin: { kind: 'task-notification' } },
      ),
      reply([{ type: 'text', text: 'Both PRs pass.' }], 'end_turn'),
    ],
    Date.now() - hour,
  );
  expect(done.summary).toMatchObject({ state: 'finished', background: 0 });
  const entries = done.transcript.entries;
  // Nothing the app delivered shows as something the person said, or as queued.
  expect(
    entries.filter((e) => e.kind === 'message' && e.role === 'user').map((e) => (e as { text: string }).text),
  ).toEqual(['Catch me up']);
  expect(entries.find((e) => e.kind === 'subagent')).toMatchObject({
    title: 'Read the PRs',
    status: 'done',
    summary: 'Found **two** PRs.\nBoth pass.',
  });
  const events = entries.filter((e) => e.kind === 'event');
  expect(events.map((e) => [e.source, e.title])).toEqual([
    ['task', 'Background command "bun test" completed'],
    ['peer', 'Report from Read the PRs'],
  ]);

  // Work that went quiet for hours no longer counts.
  expect(session(launch, Date.now() - 4 * hour).summary).toMatchObject({ state: 'finished', background: 0 });
});

test('skill text, the compaction summary and wrapper tags never show as what the person typed; a reply from the phone does', () => {
  const { transcript } = session([
    prompt(
      '<artifact-view-context artifact="x">{"page":1}</artifact-view-context>Tighten <pasted_content id="1">this line</pasted_content>',
    ),
    prompt('Base directory for this skill: /skills/catch-up', { isMeta: true }),
    prompt('And the docs', { origin: { kind: 'plugin', name: 'switchboard-remote', asUser: true } }),
    prompt('A plugin talking', { origin: { kind: 'plugin', name: 'other' } }),
    prompt('This session is being continued from a previous conversation.', { isCompactSummary: true }),
    reply([{ type: 'text', text: 'Done.' }], 'end_turn'),
  ]);
  expect(transcript.entries.filter((e) => e.kind === 'message').map((e) => (e as { text: string }).text)).toEqual([
    'Tighten this line',
    'And the docs',
    'Done.',
  ]);
});

test("Claude Desktop's end-of-turn box is an entry with its replies, and a blocking one means the session needs you", () => {
  const box = (blocked: boolean) =>
    tool('w', 'mcp__ccd_turn__wrap_up', {
      recap: 'The migration is ready.',
      ask: 'Run it now?',
      blocked,
      actions: [
        { label: 'Run it', message: 'Run the migration now.' },
        { label: 'Commit', action: 'commit' },
      ],
    });
  const steps = [
    prompt('Prepare the migration'),
    tool('p1', 'mcp__ccd_turn__update_plan', {
      items: [
        { content: 'Write it', status: 'in_progress' },
        { content: 'Test it', status: 'pending' },
        { content: 'Report', status: 'pending' },
      ],
    }),
    result('p1', 'ok'),
    tool('p2', 'mcp__ccd_turn__update_plan', { advance: true }),
    result('p2', 'ok'),
  ];
  const midway = session(steps).summary;
  expect(midway.plan).toEqual({ done: 1, total: 3, current: 'Test it' });

  const { summary, transcript } = session([...steps, box(true), result('w', 'Shown')], Date.now() - 60_000);
  // The box is the turn's last word; nothing follows it.
  expect(summary).toMatchObject({ state: 'needs-you', needs: 'Run it now?', plan: { done: 3, total: 3 } });
  expect(transcript.entries.at(-1)).toMatchObject({
    kind: 'next',
    recap: 'The migration is ready.',
    ask: 'Run it now?',
    replies: [{ label: 'Run it', message: 'Run the migration now.' }],
  });

  const closing = reply([{ type: 'text', text: 'The migration is ready to run.' }], 'end_turn');
  expect(session([...steps, box(false), result('w', 'Shown'), closing], Date.now() - 60_000).summary.state).toBe(
    'finished',
  );
  const answered = session([...steps, box(true), result('w', 'Shown'), prompt('Run the migration now.')]).summary;
  expect(answered.state).not.toBe('needs-you');
});

test('a record longer than a page (an inline screenshot) does not stop paging', () => {
  const big = 'x'.repeat(5 * 1024 * 1024);
  const { transcript } = session([
    prompt('First prompt'),
    reply([{ type: 'text', text: big }], 'end_turn'),
    prompt('Last prompt'),
    reply([{ type: 'text', text: 'Done.' }], 'end_turn'),
  ]);
  const reader = new SessionReader();
  reader.list([claude]);
  const seen: string[] = [];
  let before: number | null = null;
  const cursors: number[] = [];
  for (let page = 0; page < 10; page++) {
    const t: Transcript = reader.transcript([claude], claude.id, transcript.session.id, before)!;
    for (const e of t.entries) if (e.kind === 'message' && e.role === 'user') seen.push(e.text);
    if (t.before === null) break;
    if (before !== null) expect(t.before).toBeLessThan(before);
    cursors.push(t.before);
    before = t.before;
  }
  expect(seen).toContain('First prompt');
  expect(seen).toContain('Last prompt');
});

test('a tool call keeps its output when its result lands on the next page', () => {
  // Size the last reply so the newest page starts inside the call's line:
  // the call is then on the older page and its result on the newer one.
  const call = tool('t1', 'Bash', { command: 'bun test' });
  const done = result('t1', 'ok', { stdout: '42 pass', stderr: '' });
  const size = (r: unknown) => JSON.stringify(r).length + 1;
  const shell = size(reply([{ type: 'text', text: '' }], 'end_turn'));
  const pad = 'p'.repeat(PAGE_BYTES - size(done) - Math.floor(size(call) / 2) - shell);
  write(claudeFile(), [prompt('Run the tests'), call, done, reply([{ type: 'text', text: pad }], 'end_turn')]);
  const reader = new SessionReader();
  const [summary] = reader.list([claude]);
  const newest = reader.transcript([claude], claude.id, summary.id)!;
  expect(newest.before).not.toBeNull();
  const older = reader.transcript([claude], claude.id, summary.id, newest.before)!;
  const found = older.entries.flatMap((e) => (e.kind === 'steps' ? e.calls : []))[0];
  expect(found).toMatchObject({ name: 'Shell', output: '42 pass' });
});

test('a waiting session is finished once its scheduled time passes, without a new write', () => {
  const at = Date.now() + 60_000;
  write(claudeFile(), [
    prompt('Check back in a minute'),
    tool('s', 'ScheduleWakeup', { delaySeconds: 60 }),
    result('s', 'Scheduled', { scheduledFor: at }),
    reply([{ type: 'text', text: 'Back in a minute.' }], 'end_turn'),
  ]);
  const reader = new SessionReader();
  expect(reader.list([claude])[0].state).toBe('waiting');
  expect(reader.list([claude], at + 1000)[0].state).toBe('finished');
});

test('a long session is read a page at a time, from the end back to the start', () => {
  const records: unknown[] = [prompt('Start')];
  for (let i = 0; i < 4000; i++)
    records.push(reply([{ type: 'text', text: `Reply ${i} ` + 'x'.repeat(2000) }], 'end_turn'));
  write(claudeFile(), records);
  const reader = new SessionReader();
  reader.list([claude]);
  const pages: Entry[][] = [];
  let before: number | null = null;
  do {
    const page: Transcript = reader.transcript([claude], claude.id, 's1', before)!;
    pages.push(page.entries);
    before = page.before;
  } while (before !== null);
  expect(pages.length).toBeGreaterThan(1);
  const texts = pages
    .reverse()
    .flat()
    .map((e) => (e.kind === 'message' ? e.text.slice(0, 10) : e.kind));
  expect(texts[0]).toBe('Start');
  expect(texts.at(-1)).toBe('Reply 3999');
  expect(texts).toHaveLength(4001);
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
const agentMessage = (text: string) => item({ type: 'AgentMessage', content: [{ type: 'Text', text }] });
const call = (name: string, args: unknown) => ({
  type: 'response_item',
  payload: { type: 'function_call', name, arguments: JSON.stringify(args), call_id: name },
});

test('a Codex thread is working between task_started and task_complete; one the person stopped says so', () => {
  rollout('t1', [event({ type: 'task_started' }), userMessage('Add dark mode')]);
  expect(new SessionReader().list([codex])[0]).toMatchObject({
    id: 't1',
    title: 'Add dark mode',
    state: 'working',
    origin: 'desktop',
  });
  rollout('t1', [
    event({ type: 'task_started' }),
    userMessage('Add dark mode'),
    event({ type: 'turn_aborted', reason: 'interrupted' }),
  ]);
  expect(new SessionReader().list([codex])[0].state).toBe('stopped');
});

test('a Codex question waits for the next message, and its commands, edits and reviews become entries', () => {
  rollout('t1', [
    userMessage('Make search fast'),
    item({
      type: 'CommandExecution',
      id: 'c1',
      command: ['/bin/zsh', '-lc', 'rg -n index src'],
      aggregated_output: 'src/db.ts:4',
      exit_code: 1,
    }),
    item({
      type: 'FileChange',
      id: 'f1',
      changes: { 'src/db.ts': { type: 'update', unified_diff: '@@ -1 +1,2 @@\n a\n+b' } },
      status: 'completed',
    }),
    call('request_user_input_async', { questions: [{ title: 'Which index?', options: ['B-tree', 'Full text'] }] }),
    event({ type: 'task_complete' }),
  ]);
  const reader = new SessionReader();
  expect(reader.list([codex])[0]).toMatchObject({ state: 'needs-you', needs: 'Which index?' });
  const { entries } = reader.transcript([codex], codex.id, 't1')!;
  expect(kinds(entries)).toEqual(['message', 'steps', 'question']);
  const steps = entries[1] as Extract<Entry, { kind: 'steps' }>;
  expect(steps.calls.map((c) => [c.name, c.detail, c.failed, c.output])).toEqual([
    ['Shell', 'rg -n index src', true, 'src/db.ts:4'],
    ['Edit', 'src/db.ts', false, null],
  ]);
  expect(steps.calls[1].change).toMatchObject({ kind: 'modify', adds: 1, dels: 0 });

  rollout('t1', [
    userMessage('Make search fast'),
    call('request_user_input_async', { questions: [{ title: 'Which index?', options: ['B-tree'] }] }),
    userMessage('B-tree'),
    item({
      type: 'ExitedReviewMode',
      id: 'r',
      review_output: {
        findings: [{ title: 'Missing test', body: 'No test covers it' }],
        overall_correctness: 'patch is incorrect',
        overall_explanation: 'One gap.',
      },
    }),
  ]);
  const later = new SessionReader();
  expect(later.list([codex])[0].state).toBe('finished');
  const again = later.transcript([codex], codex.id, 't1')!.entries;
  expect(again[1]).toMatchObject({ kind: 'question', answers: ['B-tree'] });
  expect(again.at(-1)).toMatchObject({
    kind: 'review',
    verdict: 'patch is incorrect',
    findings: [{ title: 'Missing test' }],
  });
});

test("Codex's thread index names threads and hides subagents and archived threads, and the folders stand in without it", () => {
  const now = Date.now();
  const parent = rollout('parent', [userMessage('Plan it')]);
  const child = rollout('child', [userMessage('Sub task')]);
  const old = rollout('old', [userMessage('Archived')]);
  const db = new DatabaseSync(path.join(codex.home, 'state_5.sqlite'));
  db.exec(`create table threads (id text, rollout_path text, name text, title text, git_branch text, model text, originator text, source text, updated_at_ms integer, archived integer);
           create table thread_spawn_edges (parent_thread_id text, child_thread_id text, status text);`);
  const add = db.prepare('insert into threads values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  add.run('parent', parent, 'Planning', 'Plan it', 'main', 'gpt-6', 'Codex Desktop', 'vscode', now, 0);
  add.run('child', child, null, 'Sub task', null, null, 'Codex Desktop', 'vscode', now, 0);
  add.run('old', old, null, 'Archived', null, null, 'Codex Desktop', 'vscode', now, 1);
  db.prepare('insert into thread_spawn_edges values (?, ?, ?)').run('parent', 'child', 'done');
  db.close();
  expect(new SessionReader().list([codex]).map((s) => [s.id, s.title, s.branch, s.model])).toEqual([
    ['parent', 'Planning', 'main', 'gpt-6'],
  ]);

  fs.rmSync(path.join(codex.home, 'state_5.sqlite'));
  expect(
    new SessionReader()
      .list([codex])
      .map((s) => s.id)
      .sort(),
  ).toEqual(['child', 'old', 'parent']);
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
  rollout('e1', [instructions, context, ask, agentMessage('READY')], { originator: 'codex_exec' });
  expect(new SessionReader().list([codex])[0]).toMatchObject({ title: 'Review the branch', origin: 'exec' });
});

test("a session's permission mode is the last its file recorded, found past long tool output", () => {
  const home = fs.mkdtempSync(path.join(sandboxHome, 'mode-'));
  const dir = path.join(home, 'projects', '-Users-someone-app');
  fs.mkdirSync(dir, { recursive: true });
  const prompt = (mode: string) => JSON.stringify({ type: 'user', permissionMode: mode, message: { content: 'go' } });
  const output = JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', content: 'x'.repeat(3000) }] },
  });
  // Switched to auto, then 20 KB of tool output after the last prompt.
  fs.writeFileSync(
    path.join(dir, 's1.jsonl'),
    [prompt('default'), prompt('auto'), ...Array.from({ length: 7 }, () => output)].join('\n') + '\n',
  );
  // Read in 4 KB windows, so the record sits several windows back.
  expect(sessionMode(home, 's1', 4096)).toBe('auto');
  // Beyond the limit it is not found rather than read whole.
  expect(sessionMode(home, 's1', 4096, 8192)).toBeNull();
  expect(sessionMode(home, 'missing')).toBeNull();
  fs.rmSync(home, { recursive: true, force: true });
});
