// The window. A plain script, not a module: it talks to the main process
// only through `window.sb` (see preload.ts), and takes its types by
// `import()` so it compiles without a module wrapper.

type State = import('../types').State;
type ProfileView = import('../types').ProfileView;
type UsageWindow = import('../types').UsageWindow;
type Identity = import('../types').Identity;
type Usage = import('../types').Usage;
type Vendor = import('../types').Vendor;
type BringMode = import('../types').BringMode;
type Appearance = import('../types').Appearance;
type MenuBarStyle = import('../types').MenuBarStyle;

const root = document.getElementById('root') as HTMLElement;
let state: State | null = null;

// The state, once it has arrived. Every renderer is called after that.
function current(): State {
  if (!state) throw new Error('no state yet');
  return state;
}

type Child = Node | string | number | null | undefined | Child[];
type Attrs = Record<string, unknown>;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = String(v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'style') e.setAttribute('style', String(v));
    else if (v !== null && v !== undefined) e.setAttribute(k, String(v));
  }
  const append = (c: Child): void => {
    if (c === null || c === undefined) return;
    if (Array.isArray(c)) c.forEach(append);
    else e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  children.forEach(append);
  return e;
}

function relTime(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return 'resets now';
  const m = Math.round(ms / 60000);
  if (m < 60) return `resets in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `resets in ${h}h ${m % 60}m` : `resets in ${h}h`;
  return `resets in ${Math.round(h / 24)}d`;
}

// The same moment without the words, for the space beside a bar's label.
function relShort(iso: string | null): string {
  return relTime(iso).replace(/^resets (in )?/, '');
}

// Small stroke icons, coloured by the surrounding text.
const ICONS = {
  terminal:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l3.5-3L3 5"/><path d="M8.5 12h4.5"/></svg>',
  copy: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/></svg>',
  check:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3 3 7-7"/></svg>',
};
function icon(name: keyof typeof ICONS): HTMLSpanElement {
  const s = el('span', { class: `ico ${name}` });
  s.innerHTML = ICONS[name];
  return s;
}

// A small popover anchored above a button, styled like the rest of the
// window. It lives on <body>, outside the re-rendered tree, follows its
// button when the page scrolls or the window resizes, and goes away on a
// choice, a click elsewhere or Escape.
type MenuItem =
  | { label: string; danger?: boolean; disabled?: boolean; run: () => unknown }
  | { colors: string[]; current: string; pick: (color: string) => unknown }
  | 'separator';
type MenuPlacement = { prefer?: 'above' | 'below'; align?: 'left' | 'right' };
let openMenu: { el: HTMLDivElement; anchor: HTMLElement; place: MenuPlacement } | null = null;
// Pressing the button that opened the menu sends a mousedown first, which
// counts as a click outside and closes it, and then a click, which would
// open it again. Remember the anchor of a menu closed that way so the click
// that follows toggles it shut instead.
let closedByAnchor: HTMLElement | null = null;
function closeMenu(): void {
  if (!openMenu) return;
  openMenu.el.remove();
  openMenu = null;
  document.removeEventListener('mousedown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('scroll', placeMenu, true);
  window.removeEventListener('resize', placeMenu);
}
// Above the button, right-aligned to it: the button sits at the foot of its
// card, so above is where the room is. Below only when the button is so
// close to the top that above would not fit, and never past an edge.
function placeMenu(): void {
  if (!openMenu) return;
  const { el: menu, anchor, place } = openMenu;
  if (!anchor.isConnected) {
    closeMenu();
    return;
  }
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const gap = 4;
  const margin = 8;
  const fitsAbove = r.top - gap - h >= margin;
  const fitsBelow = r.bottom + gap + h <= window.innerHeight - margin;
  const above = place.prefer === 'below' ? !fitsBelow && fitsAbove : fitsAbove || !fitsBelow;
  const top = above ? r.top - gap - h : r.bottom + gap;
  const left = place.align === 'left' ? r.left : r.right - w;
  menu.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - h - margin))}px`;
  menu.style.left = `${Math.max(margin, Math.min(left, window.innerWidth - w - margin))}px`;
}
function onOutside(e: MouseEvent): void {
  if (!openMenu || openMenu.el.contains(e.target as Node)) return;
  closedByAnchor = openMenu.anchor.contains(e.target as Node) ? openMenu.anchor : null;
  closeMenu();
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeMenu();
}
function showMenu(anchor: HTMLElement, items: MenuItem[], place: MenuPlacement = {}): void {
  closeMenu();
  if (closedByAnchor === anchor) {
    closedByAnchor = null;
    return;
  }
  closedByAnchor = null;
  const menu = el('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (it === 'separator') {
      menu.append(el('hr'));
      continue;
    }
    if ('colors' in it) {
      // A row of swatches, plus one that opens the system colour panel.
      const custom = el('input', { type: 'color', value: it.current, title: 'Any colour' });
      custom.addEventListener('change', () => {
        closeMenu();
        act(() => it.pick(custom.value), anchor);
      });
      menu.append(
        el(
          'div',
          { class: 'swatches', role: 'group', title: 'Colour' },
          ...it.colors.map((c) =>
            el('button', {
              class: `swatch ${c.toLowerCase() === it.current.toLowerCase() ? 'on' : ''}`,
              style: `background:${c}`,
              title: c,
              onclick: () => {
                closeMenu();
                act(() => it.pick(c), anchor);
              },
            }),
          ),
          el('label', { class: 'swatch custom', title: 'Any colour' }, custom),
        ),
      );
      continue;
    }
    menu.append(
      el(
        'button',
        {
          class: it.danger ? 'danger' : '',
          role: 'menuitem',
          disabled: it.disabled ? 'true' : null,
          onclick: () => {
            closeMenu();
            act(it.run, anchor);
          },
        },
        it.label,
      ),
    );
  }
  document.body.append(menu);
  openMenu = { el: menu, anchor, place };
  placeMenu();
  document.addEventListener('mousedown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', placeMenu, true);
  window.addEventListener('resize', placeMenu);
  (menu.querySelector('button[role=menuitem]:not([disabled])') as HTMLButtonElement | null)?.focus();
}

// A small dark label above whatever is hovered or focused, for detail that
// has no room on the card. Like the menu it lives on <body>; it goes away
// when the pointer leaves, focus moves on, or a render removes its anchor.
let tipEl: HTMLDivElement | null = null;
function hideTip(): void {
  tipEl?.remove();
  tipEl = null;
}
function showTip(anchor: HTMLElement, lines: string[]): void {
  hideTip();
  tipEl = el(
    'div',
    { class: 'tip', role: 'tooltip' },
    lines.map((line, i) => el('div', { class: i ? 'sub' : '' }, line)),
  );
  document.body.append(tipEl);
  const r = anchor.getBoundingClientRect();
  const w = tipEl.offsetWidth;
  const h = tipEl.offsetHeight;
  const gap = 6;
  const margin = 8;
  const top = r.top - gap - h >= margin ? r.top - gap - h : r.bottom + gap;
  const left = r.left + r.width / 2 - w / 2;
  tipEl.style.top = `${top}px`;
  tipEl.style.left = `${Math.max(margin, Math.min(left, window.innerWidth - w - margin))}px`;
}
function withTip<T extends HTMLElement>(node: T, lines: string[]): T {
  node.addEventListener('mouseenter', () => showTip(node, lines));
  node.addEventListener('focus', () => showTip(node, lines));
  node.addEventListener('mouseleave', hideTip);
  node.addEventListener('blur', hideTip);
  return node;
}

async function act(fn: () => unknown, btn?: EventTarget | null): Promise<void> {
  const b = btn instanceof HTMLButtonElement ? btn : null;
  if (b) b.disabled = true;
  try {
    await fn();
  } catch (e) {
    alert((e as Error).message || String(e));
  } finally {
    if (b) b.disabled = false;
  }
}

// Colour always reflects how close the window is to running out.
function severityClass(w: UsageWindow): string {
  const pct = w.pct ?? 0;
  return w.severity === 'critical' || pct >= 90 ? 'bad' : w.severity === 'warning' || pct >= 70 ? 'warn' : '';
}

function bar(w: UsageWindow, stale = false): HTMLDivElement {
  const pct = w.pct ?? 0;
  const cls = severityClass(w);
  const remaining = current().settings.usageMode === 'remaining';
  const shown = remaining ? 100 - pct : pct;
  const passed = stale && !!w.resetsAt && Date.parse(w.resetsAt) <= Date.now();
  const reset = passed ? 'reset passed' : relShort(w.resetsAt);
  const hint = passed ? 'Reset time passed; awaiting updated usage' : relTime(w.resetsAt);
  return el(
    'div',
    { class: 'bar' },
    el(
      'span',
      { class: 'label', title: [w.label, hint].filter(Boolean).join(', ') },
      el('span', { class: 'window' }, w.label, reset ? el('span', { class: 'reset' }, ` · ${reset}`) : null),
    ),
    el('div', { class: 'track' }, el('div', { class: `fill ${cls}`, style: `width:${shown}%` })),
    el('span', { class: 'pct', title: remaining ? `${pct}% used` : `${100 - pct}% left` }, `${shown}%`),
  );
}

function card(p: ProfileView): HTMLDivElement {
  const s = current();
  const id: Partial<Identity> = p.identity ?? {};
  const u: Usage = p.usage ?? {};
  const vendorLabel = s.vendors[p.vendor].label;
  const installed = s.vendors[p.vendor].installed;
  const bucket = s.buckets?.find((b) => b.id === p.proxyBucket);

  const nameEl = el(
    'span',
    {
      class: 'name',
      title: 'Double-click to rename',
      ondblclick: () => {
        if (p.isDefault) return;
        const input = el('input', { value: p.name });
        // Put the text back before anything else renders, so the guard in
        // render() lifts the moment editing ends. Escape restores the old name.
        const finish = () => {
          const name = input.value.trim();
          nameEl.replaceChildren(document.createTextNode(name || p.name));
          if (name && name !== p.name) window.sb.updateProfile(p.id, { name });
        };
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') input.blur();
          if (ev.key === 'Escape') {
            input.value = p.name;
            input.blur();
          }
        });
        input.addEventListener('blur', finish);
        nameEl.replaceChildren(input);
        input.focus();
        input.select();
      },
    },
    p.name,
  );

  // Nothing known yet (first launch, no cache): show placeholders, not
  // misleading "not signed in" text.
  const pending = !p.identity;
  const identText = pending
    ? null
    : id.loggedIn
      ? id.email || 'signed in'
      : id.error || 'CLI not signed in for this profile';

  let usageBlock: HTMLDivElement;
  if (pending) {
    usageBlock = el(
      'div',
      { class: 'bars' },
      [0, 1].map(() =>
        el(
          'div',
          { class: 'bar' },
          el('span', { class: 'skel', style: 'width:24px' }),
          el('div', { class: 'track skel' }),
          el('span', { class: 'skel', style: 'width:32px; justify-self:end' }),
        ),
      ),
    );
  } else if (u.windows && u.windows.length) {
    usageBlock = el(
      'div',
      { class: 'bars' },
      u.windows.map((window) => bar(window, !!u.stale)),
    );
    const at = u.fetchedAt ? new Date(u.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
    if (u.stale && u.error)
      usageBlock.append(el('div', { class: 'note' }, `Couldn't refresh (${u.error}). Showing numbers from ${at}.`));
    else if (p.cached) usageBlock.append(el('div', { class: 'note' }, `Numbers from ${at}, updating…`));
  } else if (u.error) usageBlock = el('div', { class: 'note' }, `Usage: ${u.error}`);
  else usageBlock = el('div', { class: 'note' }, 'Usage: loading…');
  if (p.proxyBucket) {
    usageBlock = el(
      'div',
      { class: 'bars' },
      bucket ? bucketSummary(bucket) : el('div', { class: 'note' }, 'Bucket unavailable. Choose another connection.'),
    );
  }

  const launchBtn = el(
    'button',
    {
      class: 'primary',
      disabled: installed ? null : 'true',
      onclick: (e: Event) => act(() => (p.running ? window.sb.quit(p.id) : window.sb.launch(p.id)), e.target),
    },
    p.running ? 'Quit app' : 'Launch app',
  );

  const more = el(
    'button',
    {
      class: 'icon-btn',
      'aria-label': `More actions for ${p.name}`,
      onclick: (e: Event) => {
        // Position among this vendor's added profiles, for the move items.
        const row = s.profiles.filter((x) => x.vendor === p.vendor && !x.isDefault);
        const at = row.findIndex((x) => x.id === p.id);
        const items: MenuItem[] = [
          { label: 'Refresh usage', run: () => window.sb.refresh(p.id) },
          { label: id.loggedIn ? 'Sign in CLI again' : 'Sign in CLI', run: () => window.sb.login(p.id) },
          'separator' as const,
          ...(p.isDefault
            ? []
            : [
                { label: 'Move left', disabled: at <= 0, run: () => window.sb.moveProfile(p.id, -1) },
                { label: 'Move right', disabled: at >= row.length - 1, run: () => window.sb.moveProfile(p.id, 1) },
                'separator' as const,
                { label: 'Bring over', run: () => openSetup({ target: p }) },
              ]),
          { label: 'Show in Finder', run: () => window.sb.reveal(p.id) },
          ...(p.isDefault
            ? []
            : ['separator' as const, { label: 'Remove', danger: true, run: () => window.sb.removeProfile(p.id) }]),
        ];
        showMenu(e.currentTarget as HTMLElement, items);
      },
      title: 'More',
    },
    '⋯',
  );

  // One row: the launch button, the model connection where there is a
  // choice, then the small tools pushed to the right.
  const buttons = el(
    'div',
    { class: 'buttons' },
    launchBtn,
    p.vendor === 'codex' ? connectionControl(p) : null,
    el('span', { class: 'spacer' }),
    el(
      'button',
      {
        class: 'icon-btn',
        'aria-label': `Terminal for ${p.name}`,
        onclick: (e: Event) => act(() => window.sb.shell(p.id), e.currentTarget),
        title: 'Open a terminal already pointed at this profile',
      },
      icon('terminal'),
    ),
    copyButton(p),
    more,
  );

  const notes: HTMLElement[] = [];
  if (!installed) notes.push(el('div', { class: 'note' }, `${vendorLabel} desktop app not found in /Applications.`));
  if (!p.isDefault && !p.running && !id.loggedIn) {
    notes.push(
      el(
        'div',
        { class: 'note' },
        `Before the first sign-in, quit the other ${vendorLabel} windows: the login link opens in whichever is running. `,
        el(
          'a',
          {
            href: '#',
            onclick: (e: Event) => {
              e.preventDefault();
              act(async () => {
                if (!confirm(`Quit every other ${vendorLabel} window?\n\nAnything unsaved in them is lost.`)) return;
                const n = await window.sb.quitOthers(p.id);
                alert(
                  n ? `Quit ${n} other ${vendorLabel} window(s).` : `No other ${vendorLabel} windows were running.`,
                );
              });
            },
          },
          'Quit others now',
        ),
      ),
    );
  }

  const colorBtn = el('button', {
    class: 'color',
    title: 'Colour',
    onclick: (e: Event) =>
      showMenu(
        e.currentTarget as HTMLElement,
        [{ colors: s.palette, current: p.color, pick: (color) => window.sb.updateProfile(p.id, { color }) }],
        { prefer: 'below', align: 'left' },
      ),
  });

  return el(
    'div',
    { class: 'card', style: `--card-color:${p.color}` },
    el(
      'div',
      { class: 'head' },
      colorBtn,
      el('span', { class: `dot ${p.running ? 'on' : ''}`, title: p.running ? 'App running' : 'App not running' }),
      nameEl,
      p.isDefault ? el('span', { class: 'badge' }, 'default dirs') : null,
      u.plan || id.plan ? el('span', { class: 'badge' }, u.plan || id.plan) : null,
    ),
    pending
      ? el('div', { class: 'ident' }, el('span', { class: 'skel', style: 'width:180px' }))
      : el(
          'div',
          { class: `ident ${id.loggedIn ? '' : 'err'}` },
          identText,
          id.loggedIn
            ? null
            : [
                ' · ',
                el(
                  'a',
                  {
                    href: '#',
                    title: 'Sign the CLI into this profile (needed for usage).',
                    onclick: (e: Event) => {
                      e.preventDefault();
                      act(() => window.sb.login(p.id));
                    },
                  },
                  'Sign in CLI',
                ),
              ],
        ),
    usageBlock,
    buttons,
    notes,
  );
}

function connectionControl(p: ProfileView): HTMLElement {
  const select = el(
    'select',
    { 'aria-label': `Model connection for ${p.name}` },
    el('option', { value: '' }, 'Native account'),
    (current().buckets ?? []).map((bucket) => el('option', { value: bucket.id }, `Proxy · ${bucket.name}`)),
  );
  if (p.proxyBucket && !(current().buckets ?? []).some((b) => b.id === p.proxyBucket)) {
    select.append(el('option', { value: p.proxyBucket }, `Unavailable · ${p.proxyBucket}`));
  }
  select.value = p.proxyBucket ?? '';
  select.addEventListener('change', () => {
    const value = select.value;
    select.disabled = true;
    void act(async () => {
      try {
        await window.sb.setProxyBucket(p.id, value || null);
      } catch (error) {
        select.value = p.proxyBucket ?? '';
        throw error;
      } finally {
        select.disabled = false;
      }
    });
  });
  select.title = p.running
    ? 'Model connection. Changes take effect on the next launch from Switchboard.'
    : 'Model connection. Applies when launched from Switchboard; Terminal uses the native account.';
  return el('div', { class: 'connection' }, select);
}

type BucketView = import('../types').BucketView;
type BucketAccount = BucketView['accounts'][number];

function providerLabel(account: BucketAccount): string {
  return account.provider === 'claude' ? 'Claude' : 'ChatGPT';
}

// Why a bucket shows no bars, or fewer than expected.
function bucketNotes(bucket: BucketView): (HTMLElement | null)[] {
  return [
    bucket.status !== 'running'
      ? el(
          'div',
          { class: 'note' },
          bucket.status === 'stopped'
            ? 'Starts when an assigned desktop profile launches.'
            : 'Worker is unreachable. Check its status before restarting.',
        )
      : null,
    bucket.status === 'running' && !bucket.accounts.length
      ? el('div', { class: 'note' }, 'No accounts reported yet. Refresh or add an account.')
      : null,
    bucket.error ? el('div', { class: 'note' }, bucket.error) : null,
  ];
}

// On a profile card a bucket is pooled: one bar per provider and window,
// cut into a segment per account, so "GPT 7d" reads as one quota while a
// spent account still shows as a full segment. The number is the mean, which
// treats the accounts as equal in size; plans differ, so it is a guide to how
// much of the pool is gone, not a count of requests. The Buckets tab has
// every account on its own.
function pooledBars(bucket: BucketView): HTMLElement[] {
  const pools = new Map<string, { label: string; parts: { who: string; w: UsageWindow }[] }>();
  for (const account of bucket.accounts) {
    if (account.status === 'disabled') continue;
    for (const w of account.windows) {
      if (w.pct === null || w.pct === undefined) continue;
      const label = account.provider === 'claude' ? `Claude ${w.label}` : `GPT ${w.label.replace(/^gpt-/, '')}`;
      const pool = pools.get(label) ?? { label, parts: [] };
      pool.parts.push({ who: account.email ?? account.name, w });
      pools.set(label, pool);
    }
  }
  const remaining = current().settings.usageMode === 'remaining';
  return [...pools.values()].map(({ label, parts }) => {
    const used = Math.round(parts.reduce((sum, part) => sum + (part.w.pct ?? 0), 0) / parts.length);
    const resets = parts
      .map((part) => part.w.resetsAt)
      .filter((at): at is string => !!at && Date.parse(at) > Date.now())
      .sort();
    // The reset that matters is the next one among accounts that are running low.
    const tight = parts
      .filter((part) => severityClass(part.w) && part.w.resetsAt && Date.parse(part.w.resetsAt) > Date.now())
      .map((part) => part.w.resetsAt as string)
      .sort();
    const reset = relShort(tight[0] ?? resets[0] ?? null);
    const about = (part: (typeof parts)[number]): string =>
      [`${part.w.pct}% used`, relTime(part.w.resetsAt)].filter(Boolean).join(' · ');
    return el(
      'div',
      { class: 'bar' },
      withTip(
        el(
          'span',
          { class: 'label' },
          el(
            'span',
            { class: 'window' },
            label,
            parts.length > 1 ? el('span', { class: 'reset' }, ` ×${parts.length}`) : null,
            reset ? el('span', { class: 'reset' }, ` · ${reset}`) : null,
          ),
        ),
        [label, ...parts.map((part) => `${part.who} · ${about(part)}`)],
      ),
      el(
        'div',
        { class: 'track pooled' },
        // Each segment answers for its own account when hovered or tabbed to.
        parts.map((part) =>
          withTip(
            el(
              'div',
              { class: 'seg', tabindex: '0', 'aria-label': `${part.who}, ${about(part)}` },
              el(
                'div',
                { class: 'seg-track' },
                el('div', {
                  class: `fill ${severityClass(part.w)}`,
                  style: `width:${remaining ? 100 - (part.w.pct ?? 0) : (part.w.pct ?? 0)}%`,
                }),
              ),
            ),
            [part.who, about(part)],
          ),
        ),
      ),
      el('span', { class: 'pct' }, `${remaining ? 100 - used : used}%`),
    );
  });
}

function bucketSummary(bucket: BucketView): HTMLElement {
  return el(
    'div',
    { class: 'bucket-usage' },
    el('div', { class: 'note' }, `Usage from the ${bucket.name} bucket`),
    pooledBars(bucket),
    bucketNotes(bucket),
  );
}

function accountRow(bucket: BucketView, account: BucketAccount): HTMLElement {
  const off = account.status === 'disabled';
  return el(
    'div',
    { class: `acct ${off ? 'off' : ''}` },
    el(
      'span',
      { class: 'who', title: account.email ?? account.name },
      el('span', { class: 'prov' }, `${providerLabel(account)} `),
      account.email ?? account.name,
      account.status !== 'fresh' ? el('span', { class: 'prov' }, ` · ${account.status}`) : null,
    ),
    el(
      'div',
      { class: 'acct-windows' },
      account.windows.map((w) => bar(w, account.status !== 'fresh')),
    ),
    el(
      'button',
      { onclick: (e: Event) => act(() => window.sb.setBucketAccount(bucket.id, account.name, off), e.currentTarget) },
      off ? 'Enable' : 'Disable',
    ),
  );
}

// A tinted band with the bucket's name, state and actions, then one row per
// account.
function bucketPanel(bucket: BucketView): HTMLElement {
  const users = current().profiles.filter((p) => p.proxyBucket === bucket.id);
  const running = bucket.status === 'running';
  return el(
    'div',
    { class: 'bucket', 'data-bucket': bucket.id },
    el(
      'div',
      { class: 'bucket-head' },
      el('span', { class: 'name' }, bucket.name),
      el('span', { class: `status ${running ? 'on' : ''}` }, bucket.status),
      el(
        'span',
        { class: 'badge used-by' },
        users.length
          ? `Used by ${users.map((p) => `${current().vendors[p.vendor].label} ${p.name}`).join(', ')}`
          : 'No desktop profiles assigned',
      ),
      el(
        'div',
        { class: 'buttons' },
        el(
          'button',
          {
            onclick: (e: Event) =>
              showMenu(e.currentTarget as HTMLElement, [
                { label: 'Add ChatGPT account', run: () => window.sb.bucketAction(bucket.id, 'login', 'codex') },
                { label: 'Add Claude account', run: () => window.sb.bucketAction(bucket.id, 'login', 'claude') },
              ]),
          },
          'Add account ▾',
        ),
        running
          ? el(
              'button',
              {
                class: 'icon-btn',
                'aria-label': 'Refresh bucket',
                title: 'Refresh bucket',
                onclick: (e: Event) => act(() => window.sb.bucketAction(bucket.id, 'refresh'), e.currentTarget),
              },
              '↻',
            )
          : el(
              'button',
              {
                class: 'primary',
                onclick: (e: Event) => act(() => window.sb.bucketAction(bucket.id, 'start'), e.currentTarget),
              },
              'Start bucket',
            ),
        bucket.status === 'stopped'
          ? null
          : el(
              'button',
              {
                class: 'quiet',
                onclick: (e: Event) =>
                  act(async () => {
                    if (
                      confirm(`Stop ${bucket.name}? This interrupts model requests from every app using this bucket.`)
                    )
                      await window.sb.bucketAction(bucket.id, 'stop');
                  }, e.currentTarget),
              },
              'Stop',
            ),
      ),
    ),
    el(
      'div',
      { class: 'bucket-body' },
      bucket.accounts.map((account) => accountRow(bucket, account)),
      bucketNotes(bucket),
    ),
  );
}

function bucketSection(): HTMLElement {
  const buckets = current().buckets ?? [];
  return el(
    'section',
    { class: 'bucket-list' },
    el(
      'p',
      { class: 'hint' },
      'Shared model capacity for Codex desktop and OpenCode. Assign a bucket from the connection menu on a Codex card.',
    ),
    current().bucketsError ? el('p', { class: 'note' }, current().bucketsError) : null,
    buckets.length ? buckets.map(bucketPanel) : el('div', { class: 'empty' }, 'No buckets yet'),
  );
}

function openBucketCreate(): void {
  const dialog = document.getElementById('bucket-dialog') as HTMLDialogElement;
  (document.getElementById('bucket-name') as HTMLInputElement).value = '';
  dialog.showModal();
}
document.getElementById('bucket-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  void act(async () => {
    await window.sb.createBucket((document.getElementById('bucket-name') as HTMLInputElement).value);
    (document.getElementById('bucket-dialog') as HTMLDialogElement).close();
  }, document.getElementById('bucket-submit'));
});
document
  .getElementById('bucket-cancel')
  ?.addEventListener('click', () => (document.getElementById('bucket-dialog') as HTMLDialogElement).close());

// Copies the command that enters this profile. The tooltip shows it, and
// the icon flips to a tick for a moment so the click is seen to have done
// something.
function copyButton(p: ProfileView): HTMLButtonElement {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const btn = el(
    'button',
    {
      class: 'icon-btn copy-btn',
      'aria-label': `Copy CLI command for ${p.name}`,
      title: `Copy command: ${p.cli}`,
      onclick: () => {
        window.sb.copyCommand(p.id);
        btn.classList.add('copied');
        clearTimeout(timer);
        timer = setTimeout(() => btn.classList.remove('copied'), 1500);
      },
    },
    icon('copy'),
    icon('check'),
  );
  return btn;
}

// Accounts or Buckets. Every launch starts on Accounts.
let tab: 'accounts' | 'buckets' = 'accounts';
function showTab(next: typeof tab): void {
  tab = next;
  closeMenu();
  render();
}

function render(): void {
  if (!state) return;
  // A poll or the minute tick must not wipe out a rename in progress. The
  // next render after editing ends picks up whatever state arrived meanwhile.
  if (root.querySelector('.name input, .connection select:focus')) return;
  for (const [name, count] of [
    ['accounts', state.profiles.length],
    ['buckets', (state.buckets ?? []).length],
  ] as const) {
    const button = byId(`tab-${name}`);
    button.setAttribute('aria-selected', String(tab === name));
    button.querySelector('.count')!.textContent = String(count);
  }
  byId('add').hidden = tab !== 'accounts';
  byId('add-bucket').hidden = tab !== 'buckets';
  hideTip();
  root.replaceChildren();
  if (tab === 'buckets') {
    root.append(bucketSection());
    return;
  }
  for (const [vendor, v] of Object.entries(state.vendors)) {
    const list = state.profiles.filter((p) => p.vendor === vendor);
    root.append(
      el(
        'section',
        {},
        el(
          'h3',
          {},
          el('span', {}, `${v.label} accounts`),
          v.installed ? null : el('span', { class: 'na' }, 'app not installed'),
        ),
        el('div', { class: 'grid' }, list.length ? list.map(card) : el('div', { class: 'empty' }, 'No profiles')),
      ),
    );
  }
}

// --- dialogs ---
function byId<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
}
function field<T extends HTMLInputElement | HTMLSelectElement>(form: HTMLFormElement, name: string): T {
  const f = form.elements.namedItem(name);
  if (!f) throw new Error(`missing field ${name}`);
  return f as T;
}

const addDialog = byId<HTMLDialogElement>('add-dialog');
const addForm = byId<HTMLFormElement>('add-form');
let setupTarget: ProfileView | null = null; // an existing profile when bringing things over; null when creating

function renderSetupOptions(): void {
  const s = current();
  const vendor = (setupTarget ? setupTarget.vendor : field<HTMLSelectElement>(addForm, 'vendor').value) as Vendor;
  const sources = s.profiles.filter((p) => p.vendor === vendor && (!setupTarget || p.id !== setupTarget.id));
  const source = field<HTMLSelectElement>(addForm, 'source');
  source.replaceChildren(
    el('option', { value: '' }, 'Nothing, start blank'),
    ...sources.map((p) => el('option', { value: p.id }, p.name)),
  );
  const preferred = sources.find((p) => p.isDefault) || sources[0];
  source.value = preferred ? preferred.id : '';
  byId('add-items-list').replaceChildren(
    ...s.setupItems[vendor].map((it) =>
      el(
        'label',
        { class: `check ${it.warn ? 'warn' : ''}` },
        el('input', { type: 'checkbox', name: 'item', value: it.id, ...(it.on ? { checked: '' } : {}) }),
        el(
          'span',
          {},
          it.label,
          it.size ? ` (about ${it.size} from Default)` : '',
          it.hint ? el('span', { class: 'hint' }, it.hint) : null,
        ),
      ),
    ),
  );
  byId('add-items').hidden = !source.value;
}

function openSetup({ target }: { target?: ProfileView } = {}): void {
  // History sizes are expensive to compute, so ask for them only now.
  window.sb.measureSizes().catch(() => {});
  setupTarget = target || null;
  addForm.reset();
  byId('add-title').textContent = target ? `Bring over into ${target.name}` : 'New profile';
  byId('add-basics').hidden = !!target;
  byId('add-submit').textContent = target ? 'Bring over' : 'Create';
  field<HTMLInputElement>(addForm, 'name').required = !target;
  renderSetupOptions();
  addDialog.showModal();
}

byId('add').onclick = () => openSetup();
byId('add-bucket').onclick = openBucketCreate;
byId('tab-accounts').onclick = () => showTab('accounts');
byId('tab-buckets').onclick = () => showTab('buckets');
field(addForm, 'vendor').onchange = renderSetupOptions;
field(addForm, 'source').onchange = () => {
  byId('add-items').hidden = !field<HTMLSelectElement>(addForm, 'source').value;
};
byId('add-cancel').onclick = () => addDialog.close();
addForm.onsubmit = (e) => {
  const f = new FormData(e.target as HTMLFormElement);
  const sourceId = (f.get('source') as string | null) || null;
  const opts = {
    items: f.getAll('item') as string[],
    mode: ((f.get('mode') as BringMode | null) || 'link') as BringMode,
  };
  act(async () => {
    let r;
    if (setupTarget) {
      if (!sourceId) return;
      r = await window.sb.bringOver(setupTarget.id, sourceId, opts);
    } else {
      r = (
        await window.sb.addProfile({
          vendor: f.get('vendor') as Vendor,
          name: String(f.get('name') ?? ''),
          sourceId,
          ...opts,
        })
      ).result;
    }
    const parts: string[] = [];
    if (r.done.length) parts.push(`Brought over: ${r.done.join(', ')}.`);
    if (r.skipped.length) parts.push(`Left as is, already there: ${r.skipped.map((x) => x.item).join(', ')}.`);
    if (setupTarget && parts.length) alert(parts.join('\n'));
  });
};

const settingsDialog = byId<HTMLDialogElement>('settings-dialog');
const settingsForm = byId<HTMLFormElement>('settings-form');
byId('settings').onclick = () => {
  const s = current();
  const terminal = field<HTMLSelectElement>(settingsForm, 'terminal');
  // Only terminals actually installed on this Mac are offered.
  terminal.replaceChildren(...s.terminals.map((t) => el('option', { value: t.id }, t.label)));
  terminal.value = s.terminals.some((t) => t.id === s.settings.terminal) ? s.settings.terminal : 'Terminal';
  field<HTMLInputElement>(settingsForm, 'pollMinutes').value = String(s.settings.pollMinutes);
  field<HTMLSelectElement>(settingsForm, 'usageMode').value = s.settings.usageMode || 'used';
  field<HTMLInputElement>(settingsForm, 'openAtLogin').checked = !!s.settings.openAtLogin;
  field<HTMLSelectElement>(settingsForm, 'appearance').value = s.settings.appearance || 'system';
  field<HTMLSelectElement>(settingsForm, 'menuBar').value = s.settings.menuBar || 'icon';
  settingsDialog.showModal();
};
byId('settings-cancel').onclick = () => settingsDialog.close();
settingsForm.onsubmit = (e) => {
  const f = new FormData(e.target as HTMLFormElement);
  act(() =>
    window.sb.saveSettings({
      terminal: String(f.get('terminal') ?? 'Terminal'),
      pollMinutes: Number(f.get('pollMinutes')) || 5,
      openAtLogin: f.get('openAtLogin') === 'on',
      usageMode: (f.get('usageMode') as State['settings']['usageMode'] | null) || 'used',
      appearance: (f.get('appearance') as Appearance | null) || 'system',
      menuBar: (f.get('menuBar') as MenuBarStyle | null) || 'icon',
    }),
  );
};

byId('refresh').onclick = (e) => act(() => window.sb.refresh(), e.target);

window.sb.onState((s) => {
  state = s;
  render();
});
// A refresh can finish (and push state) before this initial fetch resolves;
// never let the older snapshot overwrite the newer one.
window.sb.getState().then((s) => {
  if (!state) {
    state = s;
    render();
  }
});
// Keep "resets in" countdowns fresh.
setInterval(render, 60000);
