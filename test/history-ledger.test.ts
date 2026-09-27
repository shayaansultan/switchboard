import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sandboxHome } from './setup';
import {
  aggTokens,
  aggValue,
  dayOf,
  emptyLedger,
  indexLogs,
  loadLedger,
  openLedger,
  saveLedger,
  type Ledger,
  type LedgerProfile,
} from '../src/history/ledger';
import { claudeAssistant, claudeUser, codexLine, codexUsage, write } from './history-fixtures';

const base = path.join(sandboxHome, 'ledger-test');
const claudeHome = path.join(base, 'claude');
const codexHome = path.join(base, 'codex');
const claude: LedgerProfile = { id: 'claude-work', vendor: 'claude', home: claudeHome };
const codex: LedgerProfile = { id: 'codex-default', vendor: 'codex', home: codexHome };
const T = Date.parse('2026-09-20T10:00:00Z');
const DAY = 86_400_000;
const transcript = path.join(claudeHome, 'projects', '-work-app', 's1.jsonl');

beforeEach(() => fs.rmSync(base, { recursive: true, force: true }));
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

const totalValue = (l: Ledger, id: string) => Object.values(l.profiles[id].facts).reduce((a, f) => a + aggValue(f), 0);
const totalTokens = (l: Ledger, id: string) =>
  Object.values(l.profiles[id].facts).reduce((a, f) => a + aggTokens(f), 0);

test('indexes a transcript once, then only what is appended', async () => {
  write(transcript, [
    claudeUser({ session: 's1', at: T, text: 'Add a usage tab' }),
    claudeAssistant({ session: 's1', at: T + 60_000, id: 'm1', input: 1_000_000, output: 100_000 }),
    claudeAssistant({ session: 's1', at: T + 60_000, id: 'm1', input: 1_000_000, output: 100_000 }),
  ]);
  const ledger = emptyLedger(T);
  expect(await indexLogs(ledger, [claude], T + 120_000)).toBe(true);
  // claude-sonnet-5: $2 per million in, $10 per million out, counted once.
  expect(totalValue(ledger, 'claude-work')).toBeCloseTo(3, 6);
  const s = ledger.profiles['claude-work'].sessions.s1;
  expect(s).toMatchObject({ title: 'Add a usage tab', cwd: '/work/app', prompts: 1, entry: 'cli' });
  expect(s.ms).toBe(60_000);

  // Nothing new: nothing changes.
  expect(await indexLogs(ledger, [claude], T + 180_000)).toBe(false);

  // A second response, and a copy of the first as a resumed session writes it.
  write(
    transcript,
    [
      claudeAssistant({ session: 's1', at: T + 120_000, id: 'm2', output: 1_000_000 }),
      claudeAssistant({ session: 's1', at: T + 60_000, id: 'm1', input: 1_000_000, output: 100_000 }),
    ],
    true,
  );
  expect(await indexLogs(ledger, [claude], T + 240_000)).toBe(true);
  expect(totalValue(ledger, 'claude-work')).toBeCloseTo(13, 6);
});

test('agent time is the conversation, not the pauses in it', async () => {
  const H = 3_600_000;
  write(transcript, [
    claudeUser({ session: 's1', at: T, text: 'Start' }),
    claudeAssistant({ session: 's1', at: T + 60_000, id: 'a', output: 1 }),
    // A twelve-minute build between two responses is work.
    claudeAssistant({ session: 's1', at: T + 13 * 60_000, id: 'b', output: 1 }),
    // Picked up again five hours later: the pause is not work, the wait for
    // the answer to the new prompt is.
    claudeUser({ session: 's1', at: T + 5 * H, text: 'Carry on' }),
    claudeAssistant({ session: 's1', at: T + 5 * H + 90_000, id: 'c', output: 1 }),
    // A permission prompt left for two hours counts no more than half an hour.
    claudeAssistant({ session: 's1', at: T + 7 * H + 90_000, id: 'd', output: 1 }),
  ]);
  const ledger = emptyLedger(T);
  await indexLogs(ledger, [claude], T + 8 * H);
  expect(ledger.profiles['claude-work'].sessions.s1.ms).toBe(60_000 + 12 * 60_000 + 90_000 + 30 * 60_000);
});

test('a ledger from an older version is read again from the logs', () => {
  const file = path.join(base, 'ledger.json');
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...emptyLedger(T), v: 1 }));
  expect(loadLedger(file)).toBeNull();
  saveLedger(file, emptyLedger(T));
  expect(loadLedger(file)).not.toBeNull();
});

test('a half-written last line waits for the next pass', async () => {
  const whole = claudeAssistant({ session: 's1', at: T, id: 'm1', output: 10 });
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, whole.slice(0, 40));
  const ledger = emptyLedger(T);
  await indexLogs(ledger, [claude], T);
  expect(totalTokens(ledger, 'claude-work')).toBe(0);
  fs.writeFileSync(transcript, whole + '\n');
  await indexLogs(ledger, [claude], T);
  expect(totalTokens(ledger, 'claude-work')).toBe(10);
});

test('unknown models are counted as unpriced, not guessed', async () => {
  write(transcript, [claudeAssistant({ session: 's1', at: T, id: 'm1', model: 'claude-opus-9', output: 500 })]);
  const ledger = emptyLedger(T);
  await indexLogs(ledger, [claude], T);
  const [fact] = Object.values(ledger.profiles['claude-work'].facts);
  expect(aggValue(fact)).toBe(0);
  expect(fact.u).toBe(500);
});

test('an archived Codex rollout is the same file, not new usage', async () => {
  const name = 'rollout-2026-09-20T10-00-00-abc.jsonl';
  const live = path.join(codexHome, 'sessions', '2026', '09', '20', name);
  const lines = [
    codexLine(T, 'session_meta', { id: 'thread', cwd: '/work/app' }),
    codexLine(T, 'turn_context', { model: 'gpt-5.3-codex' }),
    codexLine(T + 1000, 'event_msg', {
      type: 'token_count',
      info: { total_token_usage: codexUsage(1000, 0, 100), last_token_usage: codexUsage(1000, 0, 100) },
    }),
  ];
  write(live, lines);
  const ledger = emptyLedger(T);
  await indexLogs(ledger, [codex], T);
  const before = totalTokens(ledger, 'codex-default');
  fs.mkdirSync(path.join(codexHome, 'archived_sessions'), { recursive: true });
  fs.renameSync(live, path.join(codexHome, 'archived_sessions', name));
  await indexLogs(ledger, [codex], T);
  expect(before).toBe(1100);
  expect(totalTokens(ledger, 'codex-default')).toBe(1100);
});

test('facts are kept by day, model and folder; old sessions are pruned', async () => {
  const old = T - 100 * 86_400_000;
  write(transcript, [
    claudeAssistant({ session: 'old', at: old, id: 'o1', output: 10 }),
    claudeAssistant({ session: 's1', at: T, id: 'm1', output: 20, cwd: '/work/other' }),
  ]);
  const ledger = emptyLedger(T);
  await indexLogs(ledger, [claude], T);
  const pl = ledger.profiles['claude-work'];
  expect(Object.keys(pl.sessions)).toEqual(['s1']);
  expect(Object.keys(pl.facts).sort()).toEqual(
    [`${dayOf(old)}\tclaude-sonnet-5\t/work/app`, `${dayOf(T)}\tclaude-sonnet-5\t/work/other`].sort(),
  );
});

test('a profile no longer listed keeps its facts but not its sessions, and the ledger round-trips', async () => {
  write(transcript, [claudeAssistant({ session: 's1', at: T, id: 'm1', output: 20 })]);
  const ledger = emptyLedger(T);
  await indexLogs(ledger, [claude], T);
  const file = path.join(base, 'ledger.json');
  saveLedger(file, ledger);
  expect(loadLedger(file)).toEqual(ledger);
  expect(await indexLogs(ledger, [], T)).toBe(true);
  expect(ledger.profiles['claude-work'].sessions).toEqual({});
  expect(totalTokens(ledger, 'claude-work')).toBe(20);
  // Back again, its logs are not counted a second time.
  await indexLogs(ledger, [claude], T);
  expect(totalTokens(ledger, 'claude-work')).toBe(20);
});

test("a resumed session's copy of the earlier conversation is not counted again", async () => {
  const tool = { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/work/app/a.ts' } };
  const earlier = [
    claudeUser({ session: 's1', at: T, text: 'Add a usage tab', uuid: 'u1' }),
    claudeAssistant({ session: 's1', at: T + 60_000, id: 'm1', output: 100, block: tool, uuid: 'a1' }),
  ];
  write(transcript, earlier);
  // Resumed a day later: the new file opens with the earlier lines, uuids and
  // times kept, under the new session's id.
  const copy = (line: string) => line.replace('"sessionId":"s1"', '"sessionId":"s2"');
  write(path.join(claudeHome, 'projects', '-work-app', 's2.jsonl'), [
    ...earlier.map(copy),
    claudeUser({ session: 's2', at: T + DAY, text: 'Carry on', uuid: 'u2' }),
    claudeAssistant({ session: 's2', at: T + DAY + 60_000, id: 'm2', output: 50, uuid: 'a2' }),
  ]);
  const ledger = emptyLedger(T);
  await indexLogs(ledger, [claude], T + DAY + 120_000);
  const { s1, s2 } = ledger.profiles['claude-work'].sessions;
  expect(s1).toMatchObject({ prompts: 1, tools: { Edit: 1 }, files: ['a.ts'] });
  expect(s2).toMatchObject({ prompts: 1, tools: {}, files: [], title: 'Carry on', start: T + DAY });
  expect(totalTokens(ledger, 'claude-work')).toBe(150);
});

test("a Codex subagent's rollout is filed under its root, not as the root's transcript", async () => {
  const day = path.join(codexHome, 'sessions', '2026', '09', '20');
  const parent = path.join(day, 'rollout-2026-09-20T10-00-00-root.jsonl');
  const child = path.join(day, 'rollout-2026-09-20T10-05-00-child.jsonl');
  const usage = (id: string, at: number) =>
    codexLine(at, 'token_usage_record', { response_id: id, usage: codexUsage(1000, 0, 100) });
  write(parent, [
    codexLine(T, 'session_meta', { id: 'root', cwd: '/work/app', originator: 'codex_cli_rs' }),
    codexLine(T, 'turn_context', { model: 'gpt-5.3-codex' }),
    usage('r1', T + 1000),
  ]);
  // Real subagent rollouts name themselves, then replay the parent's header.
  write(child, [
    codexLine(T + 300_000, 'session_meta', {
      id: 'child',
      session_id: 'root',
      cwd: '/work/app',
      source: { subagent: { thread_spawn: { parent_thread_id: 'root', depth: 1 } } },
    }),
    codexLine(T + 300_000, 'session_meta', { id: 'root', session_id: 'root', cwd: '/work/app', source: 'vscode' }),
    codexLine(T + 300_000, 'turn_context', { model: 'gpt-5.3-codex' }),
    usage('r1', T + 300_000),
    codexLine(T + 300_001, 'inter_agent_communication_metadata', { trigger_turn: true }),
    usage('c1', T + 301_000),
  ]);
  const ledger = emptyLedger(T);
  await indexLogs(ledger, [codex], T + 400_000);
  const root = ledger.profiles['codex-default'].sessions.root;
  expect(Object.keys(root.sub)).toEqual(['gpt-5.3-codex']);
  expect(root.sub['gpt-5.3-codex'].n).toBe(1);
  expect(root.models['gpt-5.3-codex'].n).toBe(1);
  expect(root.entry).toBe('cli');
  expect(root.file).toBe(parent);

  // Archived, the transcript is found where it went.
  const archived = path.join(codexHome, 'archived_sessions', path.basename(parent));
  fs.mkdirSync(path.dirname(archived), { recursive: true });
  fs.renameSync(parent, archived);
  await indexLogs(ledger, [codex], T + 400_000);
  expect(ledger.profiles['codex-default'].sessions.root.file).toBe(archived);
});

test('an unreadable log is passed over, not a reason to stop the pass', async () => {
  const bad = path.join(claudeHome, 'projects', '-work-app', 'root-owned.jsonl');
  write(bad, [claudeAssistant({ session: 's0', at: T, id: 'm0', output: 5 })]);
  write(transcript, [claudeAssistant({ session: 's1', at: T, id: 'm1', output: 10 })]);
  const other = path.join(codexHome, 'sessions', '2026', '09', '20', 'rollout-x.jsonl');
  write(other, [
    codexLine(T, 'session_meta', { id: 'th', cwd: '/w' }),
    codexLine(T, 'turn_context', { model: 'gpt-5.3-codex' }),
    codexLine(T + 1, 'token_usage_record', { response_id: 'r', usage: codexUsage(100, 0, 1) }),
  ]);
  fs.chmodSync(bad, 0o000);
  const ledger = emptyLedger(T);
  try {
    expect(await indexLogs(ledger, [claude, codex], T)).toBe(true);
  } finally {
    fs.chmodSync(bad, 0o600);
  }
  expect(totalTokens(ledger, 'claude-work')).toBe(10);
  expect(totalTokens(ledger, 'codex-default')).toBe(101);
  // Readable again, it is read on the next pass.
  await indexLogs(ledger, [claude, codex], T);
  expect(totalTokens(ledger, 'claude-work')).toBe(15);
});

test('a ledger that cannot be used is copied aside before a new one starts', () => {
  fs.mkdirSync(base, { recursive: true });
  const file = path.join(base, 'ledger.json');
  const old = JSON.stringify({ ...emptyLedger(T), v: 1 });
  fs.writeFileSync(file, old);
  expect(openLedger(file, T + 1).profiles).toEqual({});
  expect(fs.readFileSync(path.join(base, `ledger.json.unreadable-${T + 1}`), 'utf8')).toBe(old);
  fs.writeFileSync(file, '{"v":3,"profi');
  openLedger(file, T + 2);
  expect(fs.readFileSync(path.join(base, `ledger.json.unreadable-${T + 2}`), 'utf8')).toBe('{"v":3,"profi');
  // No file: nothing to keep.
  fs.rmSync(file);
  openLedger(file, T + 3);
  expect(fs.existsSync(path.join(base, `ledger.json.unreadable-${T + 3}`))).toBe(false);
});

test('a profile whose home moved keeps its facts, and logs that moved with it count once', async () => {
  write(transcript, [claudeAssistant({ session: 's1', at: T, id: 'm1', output: 20 })]);
  const ledger = emptyLedger(T);
  await indexLogs(ledger, [claude], T);
  const moved = path.join(base, 'claude-moved');
  fs.cpSync(claudeHome, moved, { recursive: true });
  await indexLogs(ledger, [{ ...claude, home: moved }], T);
  expect(totalTokens(ledger, 'claude-work')).toBe(20);
  expect(ledger.profiles['claude-work'].home).toBe(moved);
});

test("a resumed copy made long after the original is still known, while the original's log remains", async () => {
  const earlier = [
    claudeUser({ session: 's1', at: T, text: 'Add a usage tab', uuid: 'u1' }),
    claudeAssistant({ session: 's1', at: T + 60_000, id: 'm1', output: 100, uuid: 'a1' }),
  ];
  write(transcript, earlier);
  const ledger = emptyLedger(T);
  await indexLogs(ledger, [claude], T + 120_000);
  // Claude Code kept its logs longer than 30 days; the session is resumed 50
  // days later, and passes run in between.
  await indexLogs(ledger, [claude], T + 50 * DAY);
  const copy = (line: string) => line.replace('"sessionId":"s1"', '"sessionId":"s2"');
  write(path.join(claudeHome, 'projects', '-work-app', 's2.jsonl'), earlier.map(copy));
  await indexLogs(ledger, [claude], T + 50 * DAY + 1000);
  expect(totalTokens(ledger, 'claude-work')).toBe(100);
  expect(ledger.profiles['claude-work'].sessions.s2).toBeUndefined();
});

test('the keys of lines no log could hold any more are let go', async () => {
  write(transcript, [claudeAssistant({ session: 's1', at: T, id: 'm1', output: 1 })]);
  const ledger = emptyLedger(T);
  await indexLogs(ledger, [claude], T);
  expect(Object.keys(ledger.profiles['claude-work'].seen)).toHaveLength(1);
  // Claude Code deleted the transcript; a newer one is all there is.
  fs.rmSync(transcript);
  write(path.join(claudeHome, 'projects', '-work-app', 's9.jsonl'), [
    claudeAssistant({ session: 's9', at: T + 40 * DAY, id: 'm9', output: 1 }),
  ]);
  await indexLogs(ledger, [claude], T + 40 * DAY);
  expect(Object.values(ledger.profiles['claude-work'].seen)).toEqual([Math.floor((T + 40 * DAY) / DAY)]);
});

test('a Codex prompt is remembered by a hash, not its text', async () => {
  write(path.join(codexHome, 'sessions', '2026', '09', '20', 'rollout-p.jsonl'), [
    codexLine(T, 'session_meta', { id: 'th', cwd: '/w' }),
    codexLine(T + 1, 'response_item', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'A private prompt about the merger' }],
    }),
  ]);
  const ledger = emptyLedger(T);
  await indexLogs(ledger, [codex], T);
  expect(ledger.profiles['codex-default'].sessions.th.prompts).toBe(1);
  // The title is the prompt's first line; the record of the file is not the prompt.
  expect(JSON.stringify(ledger.profiles['codex-default'].files)).not.toContain('merger');
});

test('ids from the logs that name Object.prototype are plain keys', async () => {
  const tool = { type: 'tool_use', id: 't1', name: 'constructor', input: {} };
  write(transcript, [
    claudeUser({ session: 'constructor', at: T, text: 'Go' }),
    claudeAssistant({ session: 'constructor', at: T + 1000, id: 'm1', model: 'toString', output: 5, block: tool }),
    claudeAssistant({ session: '__proto__', at: T + 2000, id: 'm2', output: 5 }),
  ]);
  const ledger = emptyLedger(T);
  await indexLogs(ledger, [claude], T + 3000);
  const pl = ledger.profiles['claude-work'];
  expect(Object.hasOwn(pl.sessions, 'constructor')).toBe(true);
  expect(pl.sessions.constructor.tools).toEqual({ constructor: 1 });
  expect(pl.sessions.constructor.models.toString.n).toBe(1);
  expect(Object.getPrototypeOf(pl.sessions)).toBe(Object.prototype);
  expect(({} as Record<string, unknown>).start).toBeUndefined();
  expect(loadLedger((saveLedger(path.join(base, 'l.json'), ledger), path.join(base, 'l.json')))).toEqual(ledger);
});
