// The Usage tab end to end: the real main process indexes invented agent logs
// in two profiles' homes, the window shows them, a session opens in the
// inspector, and the `switchboard tokens` command reads what the app kept.
// Uses a scratch HOME; no real profile, credential or network is touched.
//
//   bun run test:usage-ui
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-usage-ui-'));
const store = path.join(home, '.switchboard');
const output = path.join(root, 'docs', '.work', 'usage');
await fs.mkdir(output, { recursive: true });
await fs.mkdir(store, { recursive: true });
const settings = { terminal: 'Terminal', pollMinutes: 60, usageMode: 'used', appearance: 'light' };
const profiles = [
  { id: 'claude-default', vendor: 'claude', name: 'Personal', color: '#d97757', isDefault: true },
  { id: 'claude-work', vendor: 'claude', name: 'Work', color: '#3b82f6', isDefault: false },
  { id: 'codex-default', vendor: 'codex', name: 'Default', color: '#10a37f', isDefault: true },
];
await fs.writeFile(path.join(store, 'profiles.json'), JSON.stringify({ settings, profiles }));

// An hour ago in Personal, and this morning in Work: one session each, the
// first response repeated as Claude Code writes one line per content block.
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
function session(id, cwd, title, start, calls, model = 'claude-sonnet-5') {
  const lines = [
    {
      type: 'user',
      sessionId: id,
      timestamp: iso(start),
      cwd,
      entrypoint: 'cli',
      message: { role: 'user', content: title },
    },
  ];
  for (let i = 0; i < calls; i++) {
    const message = {
      id: `msg_${id}_${i}`,
      model,
      content: [
        {
          type: 'tool_use',
          id: `t_${id}_${i}`,
          name: i % 2 ? 'Edit' : 'Read',
          input: { file_path: `${cwd}/src/f${i % 3}.ts` },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 100_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    };
    const line = {
      type: 'assistant',
      sessionId: id,
      timestamp: iso(start + (i + 1) * 60_000),
      cwd,
      requestId: `req_${id}_${i}`,
      message,
    };
    lines.push(line, ...(i === 0 ? [line] : []));
  }
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}
const personalLog = path.join(home, '.claude', 'projects', '-work-switchboard', 'personal-1.jsonl');
const workLog = path.join(store, 'claude', 'claude-work', 'home', 'projects', '-work-api', 'work-1.jsonl');
await fs.mkdir(path.dirname(personalLog), { recursive: true });
await fs.mkdir(path.dirname(workLog), { recursive: true });
await fs.writeFile(personalLog, session('personal-1', '/work/switchboard', 'Add a usage tab', now - 60 * 60_000, 10));
await fs.writeFile(workLog, session('work-1', '/work/api', 'Migrate billing', now - 3 * 60 * 60_000, 5));

// Window history as the app records it from each poll: Personal's current
// 5-hour window filled while its session ran.
const month = iso(now).slice(0, 7);
const resetsAt = iso(now + 4 * 60 * 60_000);
await fs.mkdir(path.join(store, 'usage'), { recursive: true });
await fs.writeFile(
  path.join(store, 'usage', `windows-${month}.jsonl`),
  [10, 30, 45]
    .map((pct, i) =>
      JSON.stringify({
        at: now - (50 - i * 20) * 60_000,
        profile: 'claude-default',
        windows: [{ label: '5h', pct, resetsAt }],
      }),
    )
    .join('\n') + '\n',
);

const env = { ...process.env, HOME: home, SWITCHBOARD_ROOT: store };
let app;
async function until(check, what) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${what}`);
}
try {
  app = await electron.launch({ args: [root, `--user-data-dir=${path.join(home, 'electron')}`], env });
  const page = await app.firstWindow();
  await page.locator('#tab-usage').click();

  // The first report may arrive before the logs are read; the tab is told
  // when the ledger changes and asks again.
  await until(async () => (await page.locator('.tile .v').first().textContent())?.startsWith('$'), 'the value tile');
  await until(async () => (await page.locator('.tile .v').first().textContent()) !== '$0.00', 'indexed sessions');
  const report = await page.evaluate(() => window.sb.usageReport(30));
  // $10 per million output tokens; the repeated first line counts once.
  assert.equal(Math.round(report.totals.value), 15);
  assert.equal(report.totals.sessions, 2);
  assert.deepEqual(report.projects.map((p) => p.name).sort(), ['api', 'switchboard']);
  assert.equal(JSON.stringify(report).includes('/work/'), false, 'no full paths reach the renderer');
  assert.equal(await page.locator('.acct-card').count(), 3);
  await page.screenshot({ path: path.join(output, 'overview.png'), fullPage: true });

  await page.getByRole('radio', { name: 'Tokens' }).click();
  await page.locator('table.mix').waitFor();
  await page.screenshot({ path: path.join(output, 'tokens.png'), fullPage: true });

  await page.getByRole('radio', { name: 'Sessions' }).click();
  const current = page.locator('.block').filter({ hasText: 'Current window' });
  await current.waitFor();
  assert.match(await current.textContent(), /Add a usage tab/);
  await page.locator('.session-row', { hasText: 'Migrate billing' }).click();
  const inspector = page.locator('.inspector:visible');
  await until(async () => (await inspector.locator('h3').textContent()) === 'Migrate billing', 'the inspector');
  assert.match(await inspector.textContent(), /Edit 2/);
  await page.locator('.session-row', { hasText: 'Add a usage tab' }).click();
  await until(async () => /Its share of the window/.test(await inspector.textContent()), 'the window share');
  await page.screenshot({ path: path.join(output, 'sessions.png'), fullPage: true });

  // The CLI reads the ledger the app wrote.
  const cli = JSON.parse(
    execFileSync(process.execPath, [path.join(root, 'src', 'cli.ts'), 'tokens', '--by', 'model'], {
      env,
      encoding: 'utf8',
    }),
  );
  assert.deepEqual(
    cli.rows.map((r) => r.model),
    ['claude-sonnet-5'],
  );
  assert.equal(Math.round(cli.totals.value), 15);
  console.log('Usage tab: indexing, overview, tokens, sessions, inspector and the tokens command passed.');
} finally {
  await app?.close().catch(() => {});
  await fs.rm(home, { recursive: true, force: true });
}
