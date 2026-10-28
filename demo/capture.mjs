// Renders the real renderer against invented accounts and writes the README
// images. Nothing here reads a profile, a keychain entry or the network.
//
//   bun run demo
//
// Output: docs/screenshot.png, docs/usage.png, docs/social-card.png and docs/demo.mp4

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DOCS = path.join(ROOT, 'docs');
const WORK = path.join(ROOT, 'docs', '.work');

const VIEWPORT = { width: 920, height: 700 };
const { bridge, state, usageReports, serveRenderer } = await import('./window-stub.mjs');
const reports = await usageReports([30]);
const server = serveRenderer();
const url = `http://localhost:${server.port}/`;

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(DOCS, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });

async function newPage(ctxOptions = {}) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, ...ctxOptions });
  await ctx.addInitScript(bridge(state, reports));
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

// ---- the Usage tab ----
{
  const { ctx, page } = await newPage({ viewport: { width: VIEWPORT.width, height: 1240 } });
  await page.click('#tab-usage');
  await page.waitForSelector('.metric-tile');
  await page.screenshot({ path: path.join(DOCS, 'usage.png') });
  await ctx.close();
  console.log('wrote docs/usage.png');
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
  await page.click('#add-codex');
  await page.waitForSelector('#add-dialog[open]');
  await page.waitForTimeout(900);
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
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-i',
    webm,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-y',
    path.join(DOCS, 'demo.mp4'),
  ]);
  console.log('wrote docs/demo.mp4');
}

await browser.close();
server.stop();
fs.rmSync(WORK, { recursive: true, force: true });
