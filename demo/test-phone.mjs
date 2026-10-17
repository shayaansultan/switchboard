// Phone access, end to end in the real app: the main process starts the hub
// from the phoneAccess setting, the Settings dialog pairs a phone, and the
// paired phone reads a session the Codex profile's files describe. Runs with
// an isolated HOME and one non-default Codex profile, whose sign-in is a
// file, so nothing touches this Mac's keychain or real profiles.
//
// Leaves screenshots of the Settings section and the phone app in
// docs/.work/phone/.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, _electron as electron } from 'playwright';
import * as fixture from './fixture.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(root, 'docs', '.work', 'phone');
await fs.mkdir(output, { recursive: true });

const port = 47000 + Math.floor(Math.random() * 900);
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-phone-'));
const codexHome = path.join(home, '.switchboard', 'codex', 'codex-demo', 'home');
await fs.mkdir(path.join(home, '.switchboard'), { recursive: true });
await fs.writeFile(
  path.join(home, '.switchboard', 'profiles.json'),
  JSON.stringify({
    settings: { ...fixture.settings, phoneAccess: true, phonePort: port },
    profiles: [{ id: 'codex-demo', vendor: 'codex', name: 'Demo', isDefault: false, color: '#3b82f6' }],
  }),
  { mode: 0o600 },
);

// A thread mid-turn, written as the desktop app writes one.
const now = new Date();
const day = path.join(
  codexHome,
  'sessions',
  String(now.getFullYear()),
  String(now.getMonth() + 1).padStart(2, '0'),
  String(now.getDate()).padStart(2, '0'),
);
await fs.mkdir(day, { recursive: true });
const records = [
  { type: 'session_meta', payload: { id: 'thread-1', cwd: '/Users/demo/Developer/shop', originator: 'Codex Desktop' } },
  { type: 'event_msg', payload: { type: 'task_started' } },
  {
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: { type: 'UserMessage', content: [{ type: 'text', text: 'Add a dark mode toggle to the settings page' }] },
    },
  },
  {
    type: 'event_msg',
    payload: { type: 'item_completed', item: { type: 'CommandExecution', command: ['bun', 'test'], exit_code: 0 } },
  },
  {
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: {
        type: 'AgentMessage',
        content: [{ type: 'Text', text: 'Tests pass. Wiring the toggle into the header next.' }],
      },
    },
  },
];
await fs.writeFile(
  path.join(day, 'rollout-2026-10-18T01-00-00-thread-1.jsonl'),
  records.map((r) => JSON.stringify(r)).join('\n') + '\n',
);
await fs.writeFile(
  path.join(codexHome, 'session_index.jsonl'),
  JSON.stringify({ id: 'thread-1', thread_name: 'Dark mode toggle' }) + '\n',
);

const base = `http://127.0.0.1:${port}`;
async function waitForHub() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('the hub never answered');
}

let app;
try {
  app = await electron.launch({
    args: [root, `--user-data-dir=${path.join(home, 'electron')}`],
    env: {
      HOME: home,
      PATH: process.env.PATH || '/usr/bin:/bin',
      TMPDIR: os.tmpdir(),
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
  });
  const page = await app.firstWindow();
  await waitForHub();

  // Pair from the window, as a person would.
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.locator('#phone-access').waitFor();
  await page.locator('#pair-phone').click();
  const code = await page.locator('.pair-code b').textContent();
  assert.match(code ?? '', /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  await page.locator('#settings-dialog').screenshot({ path: path.join(output, 'settings.png') });

  // The phone pairs itself from the link, and keeps the hub's cookie.
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      colorScheme: 'light',
    });
    const phone = await context.newPage();
    await phone.goto(`http://localhost:${port}/#pair=${code}`);
    await phone.locator('#name').fill('Test phone');
    await phone.getByRole('button', { name: 'Pair' }).click();
    await phone.getByText('Dark mode toggle').first().waitFor();
    const [cookie] = await context.cookies();
    assert.equal(cookie?.name, 'sb_device');
    assert.equal(cookie.httpOnly, true);
    assert.equal(await phone.evaluate(() => document.cookie), '');
    await phone.screenshot({ path: path.join(output, 'phone-home.png') });

    // The same data through the API, as the paired phone.
    const api = (route, input) =>
      context.request
        .get(
          `http://localhost:${port}/api/trpc/${route}` +
            (input ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''),
        )
        .then((r) => r.json())
        .then((r) => r.result.data);
    const overview = await api('overview');
    assert.deepEqual(
      overview.sessions.map((s) => [s.profileId, s.title, s.state]),
      [['codex-demo', 'Dark mode toggle', 'working']],
    );
    const transcript = await api('session', { profileId: 'codex-demo', sessionId: 'thread-1' });
    assert.deepEqual(
      transcript.entries.map((e) => e.kind),
      ['message', 'steps', 'message'],
    );

    await phone.locator('a.session').first().click();
    await phone.locator('.detail-head').waitFor();
    await phone.locator('.bubble.assistant', { hasText: 'Tests pass.' }).waitFor();
    await phone.screenshot({ path: path.join(output, 'phone-session.png') });
  } finally {
    await browser.close();
  }

  // The window lists the phone it just paired.
  await page.locator('#settings-cancel').click();
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.locator('.phones li').filter({ hasText: 'Test phone' }).waitFor();
  console.log(`phone access: ok (port ${port}); screenshots in ${path.relative(root, output)}`);
} finally {
  await app?.close();
  await fs.rm(home, { recursive: true, force: true });
}

// Quitting the app takes the hub down with it.
await assert.rejects(fetch(`${base}/api/health`));
