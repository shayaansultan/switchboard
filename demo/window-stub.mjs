// The window as the demo shows it: invented accounts, a stand-in for the
// preload bridge, and a server for the built renderer. Shared by
// `bun run demo` (the README images) and `bun run preview` (the same window
// in a browser to click through). Nothing here reads a profile, a keychain
// entry or the network.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RENDERER = path.join(ROOT, 'out', 'renderer'); // built by `bun run build`

// The setup dialog's checklist comes from the app itself, so the demo cannot
// drift from what the app actually offers.
process.env.HOME = fs.mkdtempSync('/tmp/switchboard-demo-');
const { SETUP_ITEMS, PALETTE } = await import(path.join(ROOT, 'src', 'profiles.ts'));
const fixture = await import(path.join(ROOT, 'demo', 'fixture.js'));
// The Usage tab's report, computed by the real indexer from invented logs.
const { usageFixture } = await import(path.join(ROOT, 'demo', 'usage-fixture.ts'));

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
  html, body { background: #fcfcfb; }
`;

export function bridge(state, reports) {
  // Stands in for the preload bridge. Every call resolves without touching
  // anything; the demo only needs the UI to render and open its dialogs.
  return `
    window.__state = ${JSON.stringify(state)};
    window.__usage = ${JSON.stringify(reports)};
    const noop = () => Promise.resolve();
    window.sb = {
      getState: () => Promise.resolve(window.__state),
      refreshCaffeinate: noop, onCaffeinateState: () => {}, onFanState: () => {}, refreshFans: noop,
      measureSizes: () => Promise.resolve(window.__state),
      onState: (fn) => { window.__push = fn; },
      refresh: noop, addProfile: () => Promise.resolve({ result: { done: [], skipped: [] } }),
      removeProfile: noop,
      // Applied to the stand-in state, so an edit shows as it would in the app.
      updateProfile: (id, patch) => {
        const p = window.__state.profiles.find((x) => x.id === id);
        if (p) for (const [k, v] of Object.entries(patch)) v === null ? delete p[k] : (p[k] = v);
        window.__push?.({ ...window.__state });
        return Promise.resolve();
      }, moveProfile: () => Promise.resolve(true), bringOver: () => Promise.resolve({ done: [], skipped: [] }),
      saveSettings: noop, launch: noop, quit: noop, forceQuit: noop, showWindow: noop, accessibility: () => Promise.resolve(false), quitOthers: () => Promise.resolve(0),
      login: noop, shell: noop, reveal: noop, copyCommand: noop,
      usageReport: (days) => Promise.resolve(window.__usage[days] ?? window.__usage[30]), onUsageChanged: () => {}, resumeSession: noop, openSession: noop, openApp: noop,
    };
    const s = document.createElement('style');
    s.textContent = ${JSON.stringify(CHROME_CSS)};
    document.addEventListener('DOMContentLoaded', () => document.head.append(s));
  `;
}

export const state = {
  caffeinate: {
    active: false,
    endsAt: null,
    limit: null,
    lid: false,
    lidSupport: 'available',
    helper: 'installed',
    sleepDisabledElsewhere: false,
    stop: null,
    notice: null,
    queued: false,
    busy: false,
  },
  fans: { status: 'unavailable', reason: 'no-fans' },
  palette: PALETTE,
  desktop: { helper: true, accessibility: 'off' },
  settings: fixture.settings,
  terminals: fixture.terminals,
  vendors: fixture.vendors,
  setupItems: Object.fromEntries(
    Object.entries(SETUP_ITEMS).map(([v, items]) => [
      v,
      items.map(({ id, label, hint, kind, on, warn, copyOnly }) => ({
        id,
        label,
        hint,
        kind,
        on,
        warn,
        copyOnly,
        size: id === 'history' ? (v === 'claude' ? '480 MB' : '1.2 GB') : null,
      })),
    ]),
  ),
  profiles: fixture.profiles.map((p) => ({
    ...p,
    dirs: { home: `~/.switchboard/${p.vendor}/${p.id}/home`, isDefault: p.isDefault },
    cli: p.isDefault
      ? p.vendor
      : `${p.vendor === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'}='~/.switchboard/${p.vendor}/${p.id}/home' ${p.vendor}`,
  })),
};

// The Usage tab's report for each range it offers, computed by the real
// indexer from invented logs.
export async function usageReports(ranges = [7, 30, 90]) {
  const reports = {};
  for (const days of ranges) reports[days] = await usageFixture(days);
  return reports;
}

// A tiny static server, because the page's CSP is written for an http origin.
// With `inject`, index.html loads that script first, standing in for the
// preload bridge in an ordinary browser.
export function serveRenderer({ port = 0, inject = null } = {}) {
  return Bun.serve({
    port,
    async fetch(req) {
      const p = new URL(req.url).pathname;
      if (inject && p === '/__bridge.js')
        return new Response(inject, { headers: { 'content-type': 'text/javascript' } });
      if (inject && (p === '/' || p === '/index.html')) {
        const html = await Bun.file(path.join(RENDERER, 'index.html')).text();
        return new Response(
          html.replace('<script type="module"', '<script src="__bridge.js"></script>\n  <script type="module"'),
          {
            headers: { 'content-type': 'text/html' },
          },
        );
      }
      // Renderer files by default; docs/ and build/ resolve from the repo root
      // so the social card can reference the screenshot and the icon.
      const base = /^\/(docs|build)\//.test(p) ? ROOT : RENDERER;
      const file = Bun.file(path.join(base, p === '/' ? 'index.html' : p));
      return (await file.exists()) ? new Response(file) : new Response('not found', { status: 404 });
    },
  });
}
