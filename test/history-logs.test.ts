import { expect, test } from 'bun:test';
import { parseClaude, parseCodex, titleFrom, type CodexContext } from '../src/history/logs';
import { claudeAssistant, claudeToolResult, claudeUser, codexLine, codexUsage } from './history-fixtures';

const T = Date.parse('2026-09-20T10:00:00Z');

test('a Claude response written once per block is one call, keyed for dedupe', () => {
  const lines = [
    claudeAssistant({
      session: 's1',
      at: T,
      id: 'msg_1',
      input: 3,
      output: 40,
      cacheRead: 900,
      block: { type: 'thinking' },
    }),
    claudeAssistant({
      session: 's1',
      at: T,
      id: 'msg_1',
      input: 3,
      output: 40,
      cacheRead: 900,
      block: { type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { file_path: '/work/app/src/a.ts' } },
    }),
  ];
  const { calls, notes } = parseClaude(lines);
  expect(calls).toHaveLength(2);
  expect(new Set(calls.map((c) => c.key))).toEqual(new Set(['msg_1:req_msg_1']));
  expect(calls[0].tokens).toEqual({ input: 3, output: 40, cacheRead: 900, cacheWrite: 0 });
  // Tools and edited files are counted per block, so once.
  expect(notes.flatMap((n) => n.tools ?? [])).toEqual(['Edit']);
  expect(notes.flatMap((n) => n.files ?? [])).toEqual(['/work/app/src/a.ts']);
});

test('Claude prompts give the session its title; tool results and meta lines do not', () => {
  const { notes } = parseClaude([
    claudeUser({ session: 's1', at: T, text: '<command-name>/model</command-name>\nFix the flaky awake test\nmore' }),
    claudeToolResult({ session: 's1', at: T + 1 }),
  ]);
  expect(notes.filter((n) => n.prompts).map((n) => n.title)).toEqual(['Fix the flaky awake test']);
});

test('one-hour cache writes, subagents and synthetic errors', () => {
  const { calls } = parseClaude([
    claudeAssistant({ session: 's1', at: T, id: 'a', cacheWrite: 1000, cacheWriteHour: 600, sidechain: true }),
    claudeAssistant({ session: 's1', at: T, id: 'b', model: '<synthetic>', output: 5 }),
  ]);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ cacheWriteLong: 600, subagent: true });
  expect(calls[0].tokens.cacheWrite).toBe(1000);
});

test('titles lose tags and keep one line', () => {
  expect(titleFrom('<system-reminder>x</system-reminder>\n  Hello there  ')).toBe('Hello there');
  expect(titleFrom('[Request interrupted by user]')).toBeUndefined();
  expect(titleFrom('a'.repeat(100))).toHaveLength(80);
});

test('Codex per-response records win over running totals', () => {
  const ctx: CodexContext = {};
  const { calls, notes } = parseCodex(
    [
      codexLine(T, 'session_meta', {
        id: 'thread-1',
        session_id: 'thread-1',
        cwd: '/work/app',
        originator: 'codex_cli_rs',
      }),
      codexLine(T, 'turn_context', { model: 'gpt-5.3-codex', cwd: '/work/app' }),
      codexLine(T + 1, 'event_msg', { type: 'user_message', message: 'Port the worker' }),
      codexLine(T + 2, 'token_usage_record', { response_id: 'resp_1', usage: codexUsage(1000, 800, 50) }),
      codexLine(T + 2, 'event_msg', {
        type: 'token_count',
        info: { total_token_usage: codexUsage(1000, 800, 50), last_token_usage: codexUsage(1000, 800, 50) },
      }),
      codexLine(T + 3, 'response_item', {
        type: 'custom_tool_call',
        name: 'apply_patch',
        input: '*** Begin Patch\n*** Update File: src/worker.ts\n*** End Patch',
      }),
    ],
    ctx,
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ key: 'response:resp_1', session: 'thread-1', model: 'gpt-5.3-codex' });
  expect(calls[0].tokens).toEqual({ input: 200, output: 50, cacheRead: 800, cacheWrite: 0 });
  expect(notes.find((n) => n.prompts)?.title).toBe('Port the worker');
  expect(notes.flatMap((n) => n.files ?? [])).toEqual(['src/worker.ts']);
});

test('older Codex rollouts count the rise in the running total, once', () => {
  const ctx: CodexContext = {};
  const count = (total: ReturnType<typeof codexUsage>, last: ReturnType<typeof codexUsage>, at: number) =>
    codexLine(at, 'event_msg', { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } });
  const first = parseCodex(
    [
      codexLine(T, 'session_meta', { id: 't', cwd: '/w' }),
      codexLine(T, 'turn_context', { model: 'gpt-5.3-codex' }),
      count(codexUsage(100, 0, 10), codexUsage(100, 0, 10), T + 1),
      // Emitted again with the same total: not a new call.
      count(codexUsage(100, 0, 10), codexUsage(100, 0, 10), T + 2),
    ],
    ctx,
  );
  // The next read carries on from the context the first left.
  const second = parseCodex([count(codexUsage(300, 50, 30), codexUsage(200, 50, 20), T + 3)], ctx);
  expect(first.calls.map((c) => c.tokens)).toEqual([{ input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }]);
  expect(second.calls.map((c) => c.tokens)).toEqual([{ input: 150, output: 20, cacheRead: 50, cacheWrite: 0 }]);
});

test("a Codex subagent skips its parent's replayed history", () => {
  const ctx: CodexContext = {};
  const { calls } = parseCodex(
    [
      codexLine(T, 'session_meta', { id: 'child', session_id: 'root', cwd: '/w' }),
      codexLine(T, 'turn_context', { model: 'gpt-5.3-codex' }),
      codexLine(T + 1, 'event_msg', {
        type: 'token_count',
        info: { total_token_usage: codexUsage(5000, 0, 500), last_token_usage: codexUsage(5000, 0, 500) },
      }),
      codexLine(T + 2, 'event_msg', { type: 'task_started' }),
      codexLine(T + 3, 'event_msg', {
        type: 'token_count',
        info: { total_token_usage: codexUsage(5100, 0, 520), last_token_usage: codexUsage(100, 0, 20) },
      }),
    ],
    ctx,
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ session: 'root', subagent: true });
});
