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
    claudeAssistant({ session: 's1', at: T + 120_000, id: 'b', output: 1 }),
    // Picked up again five hours later: the pause is not work, the wait for
    // the answer to the new prompt is.
    claudeUser({ session: 's1', at: T + 5 * H, text: 'Carry on' }),
    claudeAssistant({ session: 's1', at: T + 5 * H + 90_000, id: 'c', output: 1 }),
  ]);
  const ledger = emptyLedger(T);
  await indexLogs(ledger, [claude], T + 6 * H);
  expect(ledger.profiles['claude-work'].sessions.s1.ms).toBe(60_000 + 60_000 + 90_000);
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

test('a profile no longer listed is dropped, and the ledger round-trips', async () => {
  write(transcript, [claudeAssistant({ session: 's1', at: T, id: 'm1', output: 20 })]);
  const ledger = emptyLedger(T);
  await indexLogs(ledger, [claude], T);
  const file = path.join(base, 'ledger.json');
  saveLedger(file, ledger);
  expect(loadLedger(file)).toEqual(ledger);
  await indexLogs(ledger, [], T);
  expect(ledger.profiles).toEqual({});
});
