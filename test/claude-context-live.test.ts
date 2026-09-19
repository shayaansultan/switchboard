import { expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as os from 'node:os';

const execute = promisify(execFile);
const live = process.env.SWITCHBOARD_LIVE_TESTS === '1' ? test : test.skip;

async function probe(exercise: boolean, variant = 'production') {
  const result = await execute(process.execPath, [path.resolve(import.meta.dir, '../demo/claude-context-probe.ts')], {
    env: {
      ...process.env,
      SWITCHBOARD_PROBE_VARIANT: variant,
      SWITCHBOARD_PROBE_EXERCISE: exercise ? '1' : '0',
      SWITCHBOARD_PROBE_LIVE_BUCKET: '',
      SWITCHBOARD_PROBE_MODEL: 'claude-sonnet-4-6',
      SWITCHBOARD_PROBE_CODE_MODE: '1',
      SWITCHBOARD_PROXY_BINARY:
        process.env.SWITCHBOARD_PROXY_BINARY ||
        path.join(os.userInfo().homedir, '.switchboard/bin/cliproxyapi-7.3.2/cli-proxy-api'),
    },
    timeout: 90000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

live(
  'Claude keeps a large MCP catalog out of fresh requests on both sides of the real proxy',
  async () => {
    const [result] = await probe(false);
    expect(result.sourceTools).toBe(421);
    expect(result.codex[0].toolBytes).toBeLessThan(30000);
    expect(result.anthropic[0].toolBytes).toBeLessThan(30000);
    expect(result.anthropic[0].names).toContain('exec');
  },
  100000,
);

live(
  'Claude discovers and executes a deferred MCP tool, edits a file, and resumes through the real proxy',
  async () => {
    const [exercise, result] = await probe(true);
    expect(exercise).toEqual({ exercise: 'discovery-connector-shell-resume', passed: true });
    expect(result.anthropic).toHaveLength(8);
    expect(result.anthropic.every((request: { toolBytes: number }) => request.toolBytes < 30000)).toBe(true);
    expect(result.anthropic.every((request: { bytes: number }) => request.bytes < 100000)).toBe(true);
  },
  100000,
);

live(
  'context controls isolate eager schemas and the proxy dropping standalone tool search',
  async () => {
    const results = await probe(false, '');
    const byName = Object.fromEntries(results.map((result) => [result.variant, result]));
    expect(byName.baseline.anthropic[0].tools).toBeGreaterThanOrEqual(421);
    expect(byName.baseline.anthropic[0].toolBytes).toBeGreaterThan(700000);
    expect(byName['no-connectors'].anthropic[0].toolBytes).toBeLessThan(30000);
    expect(byName.repl.anthropic[0].toolBytes).toBe(byName.baseline.anthropic[0].toolBytes);
    expect(byName['code-mode'].anthropic[0].toolBytes).toBeGreaterThan(700000);
    expect(byName.search.codex[0].toolTypes).toContain('tool_search');
    expect(byName.search.anthropic[0].hasSearchTool).toBe(false);
    expect(byName['search-code-mode-disabled-repl'].anthropic[0].toolBytes).toBe(
      byName.production.anthropic[0].toolBytes,
    );
  },
  100000,
);
