// Renders the real renderer against invented accounts and writes the README
// images. Nothing here reads a profile, a keychain entry or the network.
//
//   bun run demo
//
// Output: docs/screenshot.png, docs/social-card.png and docs/demo.mp4

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RENDERER = path.join(ROOT, 'src', 'renderer');
const DOCS = path.join(ROOT, 'docs');
const WORK = path.join(ROOT, 'docs', '.work');

// The setup dialog's checklist comes from the app itself, so the demo cannot
// drift from what the app actually offers.
process.env.HOME = fs.mkdtempSync('/tmp/switchboard-demo-');
const { SETUP_ITEMS } = await import(path.join(ROOT, 'src', 'profiles.js'));
const fixture = await import(path.join(ROOT, 'demo', 'fixture.js'));

const VIEWPORT = { width: 920, height: 700 };

// macOS draws the traffic lights over the inset title bar. In a browser that
// space is simply empty, so draw them, and keep this to the demo only.
const CHROME_CSS = `
  .titlebar::before {
    content: ""; position: absolute; left: 20px; top: 50%; transform: translateY(-50%);
    width: 52px; height: 12px;
    background: radial-gradient(circle 6px at 6px 6px, #ff5f57 98%, transparent 100%),
                radial-gradient(circle 6px at 26px 6px, #febc2e 98%, transparent 100%),
                radial-gradient(circle 6px at 46px 6px, #28c840 98%, transparent 100%);
  }
  .titlebar { position: sticky; }
  html, body { background: #f1f1ee; }
`;

function bridge(state) {
  // Stands in for the preload bridge. Every call resolves without touching
  // anything; the demo only needs the UI to render and open its dialogs.
  return `
    window.__state = ${JSON.stringify(state)};
    const noop = () => Promise.resolve();
    window.sb = {
      getState: () => Promise.resolve(window.__state),
      measureSizes: () => Promise.resolve(window.__state),
      onState: (fn) => { window.__push = fn; },
      refresh: noop, addProfile: () => Promise.resolve({ result: { done: [], skipped: [] } }),
      removeProfile: noop, updateProfile: noop, bringOver: () => Promise.resolve({ done: [], skipped: [] }),
      saveSettings: noop, launch: noop, quit: noop, quitOthers: () => Promise.resolve(0),
      login: noop, shell: noop, reveal: noop, copyCommand: noop,
    };
    const s = document.createElement('style');
    s.textContent = ${JSON.stringify(CHROME_CSS)};
    document.addEventListener('DOMContentLoaded', () => document.head.append(s));
  `;
}

const state = {
  settings: fixture.settings,
  terminals: fixture.terminals,
  vendors: fixture.vendors,
  setupItems: Object.fromEntries(
    Object.entries(SETUP_ITEMS).map(([v, items]) => [
      v,
      items.map(({ id, label, hint, kind, on, warn, copyOnly }) => ({
        id, label, hint, kind, on, warn, copyOnly,
        size: id === 'history' ? (v === 'claude' ? '480 MB' : '1.2 GB') : null,
      })),
    ]),
  ),
  profiles: fixture.profiles.map((p) => ({
    ...p,
    dirs: { home: `~/.switchboard/${p.vendor}/${p.id}/home`, isDefault: p.isDefault },
    cli: p.isDefault ? p.vendor : `${p.vendor === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'}='~/.switchboard/${p.vendor}/${p.id}/home' ${p.vendor}`,
  })),
};

// A tiny static server, because the page's CSP is written for an http origin.
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const p = new URL(req.url).pathname;
    // Renderer files by default; docs/ and build/ resolve from the repo root
    // so the social card can reference the screenshot and the icon.
    const base = /^\/(docs|build)\//.test(p) ? ROOT : RENDERER;
    const file = Bun.file(path.join(base, p === '/' ? 'index.html' : p));
    return (await file.exists()) ? new Response(file) : new Response('not found', { status: 404 });
  },
});
const url = `http://localhost:${server.port}/`;

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(DOCS, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });

async function newPage(ctxOptions = {}) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, ...ctxOptions });
  await ctx.addInitScript(bridge(state));
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForSelector('.card');
  return { ctx, page };
}

// ---- still ----
{
  const { ctx, page } = await newPage();
  await page.screenshot({ path: path.join(DOCS, 'screenshot.png') });
  await ctx.close();
  console.log('wrote docs/screenshot.png');
}

// ---- social card ----
// GitHub crops the social preview to 2:1, so it needs its own frame rather
// than the screenshot, which is nearly square.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(`${url}__card`);
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>
    * { box-sizing: border-box; margin: 0; }
    body { width: 1280px; height: 640px; overflow: hidden; display: flex; align-items: center;
           background: linear-gradient(135deg, #f4f4f1 0%, #e8e8e3 100%);
           font-family: -apple-system, "SF Pro Text", system-ui, sans-serif; color: #1d1d1b; }
    .copy { width: 520px; flex: none; padding: 0 0 0 72px; }
    .icon { width: 76px; height: 76px; border-radius: 17px; display: block; margin-bottom: 26px;
            box-shadow: 0 8px 22px rgba(0,0,0,.18); }
    h1 { font-size: 60px; letter-spacing: -0.025em; font-weight: 700; line-height: 1; }
    p { font-size: 25px; line-height: 1.4; color: #55554f; margin-top: 18px; }
    .shot { flex: 1; height: 100%; position: relative; }
    .shot img { position: absolute; top: 76px; left: 34px; width: 860px;
                border-radius: 12px; box-shadow: 0 26px 70px rgba(0,0,0,.24), 0 0 0 1px rgba(0,0,0,.07); }
  </style>
  <div class="copy">
    <img class="icon" src="/build/icon-1024.png">
    <h1>Switchboard</h1>
    <p>Run multiple Claude and Codex accounts side by side on one Mac, each with its own window and usage bars.</p>
  </div>
  <div class="shot"><img src="/docs/screenshot.png"></div>`);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth));
  await page.screenshot({ path: path.join(DOCS, 'social-card.png') });
  await ctx.close();
  console.log('wrote docs/social-card.png');
}

// ---- clip: the setup dialog, which is the part worth showing in motion ----
{
  const { ctx, page } = await newPage({ recordVideo: { dir: WORK, size: VIEWPORT } });
  await page.waitForTimeout(1400);
  await page.click('#add');
  await page.waitForSelector('#add-dialog[open]');
  await page.waitForTimeout(900);
  await page.selectOption('select[name="vendor"]', 'codex');
  await page.fill('input[name="name"]', 'Client');
  await page.waitForTimeout(700);
  // Turn on the two items that are deliberately off by default.
  for (const id of ['plugins', 'connectors']) {
    await page.check(`input[name="item"][value="${id}"]`);
    await page.waitForTimeout(450);
  }
  await page.check('input[name="mode"][value="copy"]');
  await page.waitForTimeout(1200);
  await page.click('#add-cancel');
  await page.waitForTimeout(900);
  const video = page.video();
  await ctx.close();
  const webm = await video.path();
  execFileSync('ffmpeg', ['-v', 'error', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', path.join(DOCS, 'demo.mp4')]);
  console.log('wrote docs/demo.mp4');
}

await browser.close();
server.stop();
fs.rmSync(WORK, { recursive: true, force: true });
