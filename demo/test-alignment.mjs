// Alignment audit: renders the shipped window in each of its main states
// against invented accounts, then measures what eyes notice and box models
// hide. For every control that pairs an icon with text, the icon's drawn
// centre (its paths, not its 24-unit box) should sit on the text's cap-height
// centre; for every button, that centre should sit on the button's middle.
// Fails when anything is off by more than a pixel, and lists it.
//
//   bun run test:alignment-ui
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import * as fixture from './fixture.js';
import { PALETTE } from '../out/store.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(root, 'docs', '.work', 'alignment');
await fs.mkdir(output, { recursive: true });
const TOLERANCE = 1;

const caffeinate = {
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
};
const fan = (actual) => ({ actual, minimum: 2317, maximum: 7826, target: actual, manual: false });
const fans = {
  status: 'ready',
  helper: 'installed',
  fans: [fan(2317), fan(2502)],
  temperature: 71.4,
  level: null,
  endsAt: null,
  limit: null,
  queued: false,
  stop: null,
  notice: null,
  busy: false,
};
const state = {
  palette: PALETTE,
  desktop: { helper: true, accessibility: 'off' },
  caffeinate,
  fans,
  buckets: [],
  settings: fixture.settings,
  terminals: fixture.terminals,
  vendors: fixture.vendors,
  setupItems: { claude: [], codex: [] },
  profiles: fixture.profiles.map((profile) => ({
    ...profile,
    dirs: { home: '~/.switchboard/example', isDefault: profile.isDefault },
    cli: profile.vendor,
  })),
};

const files = new Map(
  await Promise.all(
    ['index.html', 'style.css', 'main.js'].map(async (name) => [
      `/${name}`,
      await fs.readFile(path.join(root, 'out', 'renderer', name)),
    ]),
  ),
);
const fonts = path.join(root, 'out', 'renderer', 'fonts');
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const name = new URL(request.url).pathname;
    if (name.startsWith('/fonts/')) return new Response(Bun.file(path.join(fonts, path.basename(name))));
    const content = files.get(name === '/' ? '/index.html' : name);
    const type = name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : 'text/html';
    return new Response(content ?? 'Not found', { status: content ? 200 : 404, headers: { 'Content-Type': type } });
  },
});

// Runs in the page: every misalignment it can find among visible controls.
function audit(tolerance) {
  const ctx = document.createElement('canvas').getContext('2d');
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };
  const label = (el) =>
    `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}"`;
  // The cap-height centre of the first run of text directly in `el`.
  const capCentre = (el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.textContent.trim() && !node.parentElement.closest('svg') && visible(node.parentElement)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT,
    });
    const text = walker.nextNode();
    if (!text) return null;
    const range = document.createRange();
    range.selectNodeContents(text);
    const rect = range.getClientRects()[0];
    if (!rect) return null;
    const style = getComputedStyle(text.parentElement);
    ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const m = ctx.measureText('H');
    const ascent = m.fontBoundingBoxAscent;
    const content = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
    // The range box is the font's content area, centred on the line.
    const baseline = rect.top + (rect.height - content) / 2 + ascent;
    return baseline - m.actualBoundingBoxAscent / 2;
  };
  // The centre of what an icon actually draws.
  const iconCentre = (svg) => {
    const box = svg.getBBox();
    const rect = svg.getBoundingClientRect();
    const view = svg.viewBox.baseVal;
    const scale = rect.height / (view && view.height ? view.height : 24);
    return rect.top + (box.y + box.height / 2) * scale;
  };
  const problems = [];
  const report = (el, what, delta) => {
    if (Math.abs(delta) > tolerance) problems.push(`${label(el)}: ${what} off by ${delta.toFixed(1)}px`);
  };
  for (const el of document.querySelectorAll('button, .pop-line, .tabs a, [role="tab"]')) {
    if (!visible(el)) continue;
    const svg = [...el.querySelectorAll('svg')].find((s) => visible(s));
    const cap = capCentre(el);
    if (svg && cap !== null) report(el, 'icon vs text', iconCentre(svg) - cap);
    if (el.tagName === 'BUTTON') {
      // The middle inside the borders: a tab's underline is a bottom border.
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const top = r.top + parseFloat(style.borderTopWidth);
      const middle = top + (r.bottom - parseFloat(style.borderBottomWidth) - top) / 2;
      if (cap !== null) report(el, 'text vs button middle', cap - middle);
      else if (svg) report(el, 'icon vs button middle', iconCentre(svg) - middle);
    }
  }
  // A header row: its title, (i) and close share one centre line.
  for (const row of document.querySelectorAll('.title-popover-head, .titlebar')) {
    if (!visible(row)) continue;
    const title = row.querySelector('h2, .brand');
    const cap = title && capCentre(title);
    if (cap === null || cap === undefined) continue;
    for (const child of row.querySelectorAll(
      ':scope > button, :scope > .title-popover-meta, :scope > .actions > button',
    )) {
      if (!visible(child)) continue;
      const svg = [...child.querySelectorAll('svg')].find((s) => visible(s));
      const centre = svg ? iconCentre(svg) : capCentre(child);
      if (centre !== null) report(child, `centre vs ${row.className} title`, centre - cap);
    }
  }
  // Every size comes from the scales in src/design/tokens.css.
  const root = getComputedStyle(document.documentElement);
  const scale = (prefix) =>
    new Set(
      [...document.styleSheets]
        .flatMap((sheet) => [...sheet.cssRules])
        .filter((rule) => rule.selectorText === ':root')
        .flatMap((rule) => [...rule.style])
        .filter((name) => name.startsWith(prefix))
        .map((name) => parseFloat(root.getPropertyValue(name))),
    );
  const textSizes = scale('--text-');
  const controlSizes = scale('--control');
  const seenText = new Set();
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el) || el.closest('svg')) continue;
    const ownText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    if (!ownText) continue;
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (!textSizes.has(size) && !seenText.has(`${el.tagName}${size}`)) {
      seenText.add(`${el.tagName}${size}`);
      problems.push(`${label(el)}: font-size ${size}px is not on the type scale`);
    }
  }
  for (const el of document.querySelectorAll(
    '.title-popover button, .title-popover input:not([type=checkbox]):not([type=range])',
  )) {
    if (!visible(el)) continue;
    const height = el.getBoundingClientRect().height;
    if (![...controlSizes].some((c) => Math.abs(c - height) < 0.5))
      problems.push(`${label(el)}: height ${height}px is not a control size`);
  }
  // A popover's close icon ends on the same right edge as its content.
  for (const pop of document.querySelectorAll('.title-popover')) {
    if (!visible(pop)) continue;
    const close = pop.querySelector('.title-popover-close svg');
    if (!close) continue;
    const r = pop.getBoundingClientRect();
    const style = getComputedStyle(pop);
    const edge = r.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
    const svg = close.getBoundingClientRect();
    const box = close.getBBox();
    const drawnRight = svg.left + (box.x + box.width) * (svg.width / 24);
    report(pop.querySelector('.title-popover-close'), 'close icon vs content edge', drawnRight - edge);
  }
  return problems;
}

const browser = await chromium.launch({ channel: 'chrome' });
const failures = [];
try {
  const context = await browser.newContext({ viewport: { width: 900, height: 760 }, deviceScaleFactor: 2 });
  await context.addInitScript((initial) => {
    const noop = async () => {};
    window.__listeners = {};
    window.sb = new Proxy(
      {
        getState: async () => initial,
        measureSizes: async () => initial,
        listResets: async () => [],
      },
      {
        get: (target, key) =>
          key in target
            ? target[key]
            : typeof key === 'string' && key.startsWith('on')
              ? (fn) => {
                  window.__listeners[key] = fn;
                }
              : noop,
      },
    );
  }, state);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.waitForSelector('.card, .row');
  await page.evaluate(() => document.fonts.ready);

  const check = async (name) => {
    await page.waitForTimeout(150);
    const problems = await page.evaluate(audit, TOLERANCE);
    await page.screenshot({ path: path.join(output, `${name}.png`) });
    for (const problem of problems) failures.push(`${name}: ${problem}`);
  };

  await check('profiles');
  await page.locator('#caffeinate-toggle').click();
  await check('caffeinate');
  await page.keyboard.press('Escape');
  await page.locator('#fans-toggle').click();
  await check('fans');
  await page.keyboard.press('Escape');
  for (const tab of ['Proxy buckets', 'CLI', 'Phone']) {
    const button = page.getByRole('tab', { name: new RegExp(tab) });
    if (await button.count()) {
      await button.first().click();
      await check(tab.toLowerCase().replace(/\s+/g, '-'));
    }
  }
  const push = (key, value) => page.evaluate(([k, v]) => window.__listeners[k]?.(v), [key, value]);
  await page.getByRole('tab', { name: /Profiles/ }).click();
  await page.getByRole('radio', { name: 'Cards' }).click();
  await check('cards');
  await page.getByRole('radio', { name: 'List' }).click();
  await page.getByRole('button', { name: 'More' }).first().click();
  await check('row-menu');
  await page.keyboard.press('Escape');
  // Running sessions: the title bar and the popovers' countdown cards.
  await push('onCaffeinateState', {
    ...caffeinate,
    active: true,
    endsAt: Date.now() + 52 * 60_000,
    limit: 60,
    lid: true,
  });
  await push('onFanState', {
    ...fans,
    level: 75,
    endsAt: Date.now() + 12 * 60_000,
    limit: 15,
    fans: fans.fans.map((f) => ({ ...f, actual: 6449, manual: true })),
  });
  await check('running');
  await page.locator('#caffeinate-toggle').click();
  await check('caffeinated');
  await page.keyboard.press('Escape');
  await page.locator('#fans-toggle').click();
  await check('boosting');
  await page.keyboard.press('Escape');
  await page.emulateMedia({ colorScheme: 'dark' });
  await check('dark');
  await page.locator('#settings').click();
  await check('settings');
  assert.deepEqual(errors, []);
  await context.close();
} finally {
  await browser.close();
  server.stop();
}

if (failures.length) {
  console.error(failures.join('\n'));
  console.error(`\n${failures.length} misalignments over ${TOLERANCE}px. Screenshots: ${output}`);
  process.exit(1);
}
console.log(`Alignment checks passed. Screenshots: ${output}`);
