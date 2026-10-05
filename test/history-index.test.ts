import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sandboxHome } from './setup';
import { UsageHistory } from '../src/history';
import { emptyLedger, saveLedger } from '../src/history/ledger';
import { claudeAssistant, write } from './history-fixtures';

const dir = path.join(sandboxHome, 'history-index-test');
const home = path.join(dir, 'claude');
const profile = { id: 'claude-work', vendor: 'claude' as const, home };
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a change is announced to the caller that started the pass, not to those who joined it', async () => {
  write(path.join(home, 'projects', 'p', 's.jsonl'), [
    claudeAssistant({ session: 's', at: Date.now(), id: 'm', output: 1 }),
  ]);
  const history = new UsageHistory(path.join(dir, 'usage'));
  const results = await Promise.all([history.index([profile]), history.index([profile]), history.index([profile])]);
  expect(results).toEqual([true, false, false]);
  expect(fs.existsSync(path.join(dir, 'usage', 'ledger.json'))).toBe(true);
});

test('the CLI finds no history in a ledger of another version', () => {
  const usage = path.join(dir, 'usage');
  expect(UsageHistory.readOnly(usage)).toBeNull();
  fs.mkdirSync(usage, { recursive: true });
  fs.writeFileSync(path.join(usage, 'ledger.json'), JSON.stringify({ ...emptyLedger(), v: 2 }));
  expect(UsageHistory.readOnly(usage)).toBeNull();
  // Reading it never copies it aside: that is the app's to do.
  expect(fs.readdirSync(usage)).toEqual(['ledger.json']);
  saveLedger(path.join(usage, 'ledger.json'), emptyLedger());
  expect(UsageHistory.readOnly(usage)).not.toBeNull();
});

test('the app copies a ledger it cannot use aside before starting afresh', () => {
  const usage = path.join(dir, 'usage');
  fs.mkdirSync(usage, { recursive: true });
  fs.writeFileSync(path.join(usage, 'ledger.json'), '{"torn');
  const history = new UsageHistory(usage);
  expect(history.current().profiles).toEqual({});
  const copies = fs.readdirSync(usage).filter((n) => n.startsWith('ledger.json.unreadable-'));
  expect(copies).toHaveLength(1);
  expect(fs.readFileSync(path.join(usage, copies[0]), 'utf8')).toBe('{"torn');
});
