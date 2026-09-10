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
  if (h < 48) return `resets in ${h}h ${m % 60}m`;
  return `resets in ${Math.round(h / 24)}d`;
}

// Small stroke icons, coloured by the surrounding text.
const ICONS = {
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
type MenuItem = { label: string; danger?: boolean; run: () => unknown } | 'separator';
let openMenu: { el: HTMLDivElement; anchor: HTMLElement } | null = null;
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
  const { el: menu, anchor } = openMenu;
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
  const top = fitsAbove ? r.top - gap - h : r.bottom + gap;
  menu.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - h - margin))}px`;
  menu.style.left = `${Math.max(margin, Math.min(r.right - w, window.innerWidth - w - margin))}px`;
}
function onOutside(e: MouseEvent): void {
  if (openMenu && !openMenu.el.contains(e.target as Node)) closeMenu();
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeMenu();
}
function showMenu(anchor: HTMLElement, items: MenuItem[]): void {
  closeMenu();
  const menu = el('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (it === 'separator') {
      menu.append(el('hr'));
      continue;
    }
    menu.append(
      el(
        'button',
        {
          class: it.danger ? 'danger' : '',
          role: 'menuitem',
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
  openMenu = { el: menu, anchor };
  placeMenu();
  document.addEventListener('mousedown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', placeMenu, true);
  window.addEventListener('resize', placeMenu);
  (menu.querySelector('button') as HTMLButtonElement | null)?.focus();
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

function bar(w: UsageWindow): HTMLDivElement {
  const pct = w.pct ?? 0;
  // Colour always reflects how close the window is to running out.
  const cls = w.severity === 'critical' || pct >= 90 ? 'bad' : w.severity === 'warning' || pct >= 70 ? 'warn' : '';
  const remaining = current().settings.usageMode === 'remaining';
  const shown = remaining ? 100 - pct : pct;
  return el(
    'div',
    { class: 'bar' },
    el('span', { class: 'label' }, w.label),
    el('div', { class: 'track' }, el('div', { class: `fill ${cls}`, style: `width:${shown}%` })),
    el('span', { class: 'pct', title: remaining ? `${pct}% used` : `${100 - pct}% left` }, `${shown}%`),
    w.resetsAt ? el('span', { class: 'reset' }, relTime(w.resetsAt)) : null,
  );
}

function card(p: ProfileView): HTMLDivElement {
  const s = current();
  const id: Partial<Identity> = p.identity ?? {};
  const u: Usage = p.usage ?? {};
  const vendorLabel = s.vendors[p.vendor].label;
  const installed = s.vendors[p.vendor].installed;

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
    usageBlock = el('div', { class: 'bars' }, u.windows.map(bar));
    const at = u.fetchedAt ? new Date(u.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
    if (u.stale && u.error)
      usageBlock.append(el('div', { class: 'note' }, `Couldn't refresh (${u.error}). Showing numbers from ${at}.`));
    else if (p.cached) usageBlock.append(el('div', { class: 'note' }, `Numbers from ${at}, updating…`));
  } else if (u.error) usageBlock = el('div', { class: 'note' }, `Usage: ${u.error}`);
  else usageBlock = el('div', { class: 'note' }, 'Usage: loading…');

  const launchBtn = el(
    'button',
    {
      class: 'primary',
      disabled: installed ? null : 'true',
      onclick: (e: Event) => act(() => (p.running ? window.sb.quit(p.id) : window.sb.launch(p.id)), e.target),
    },
    p.running ? 'Quit app' : `Launch ${vendorLabel} app`,
  );

  const buttons = el(
    'div',
    { class: 'buttons' },
    launchBtn,
    el(
      'button',
      {
        onclick: (e: Event) => act(() => window.sb.shell(p.id), e.target),
        title: 'Open a terminal already pointed at this profile',
      },
      'Terminal',
    ),
    el(
      'button',
      {
        onclick: (e: Event) => act(() => window.sb.login(p.id), e.target),
        title: 'Sign the CLI into this profile (needed for usage). Run again if the token expires.',
      },
      'Sign in CLI',
    ),
    el('button', { onclick: (e: Event) => act(() => window.sb.refresh(p.id), e.target), title: 'Refresh usage' }, '↻'),
    el(
      'button',
      {
        onclick: (e: Event) =>
          showMenu(e.currentTarget as HTMLElement, [
            ...(p.isDefault ? [] : [{ label: 'Bring over', run: () => openSetup({ target: p }) } satisfies MenuItem]),
            { label: 'Show in Finder', run: () => window.sb.reveal(p.id) },
            ...(p.isDefault
              ? []
              : ['separator' as const, { label: 'Remove', danger: true, run: () => window.sb.removeProfile(p.id) }]),
          ]),
        title: 'More',
      },
      '⋯',
    ),
  );

  const notes: HTMLElement[] = [];
  if (!installed) notes.push(el('div', { class: 'note' }, `${vendorLabel} desktop app not found in /Applications.`));
  if (!p.isDefault && !p.running && !id.loggedIn) {
    notes.push(
      el(
        'div',
        { class: 'note' },
        el('b', {}, 'First sign-in tip: '),
        'the login link opens in whichever instance is running, so quit the other ',
        vendorLabel,
        ' windows before signing into this one. ',
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

  return el(
    'div',
    { class: 'card', style: `--card-color:${p.color}` },
    el(
      'div',
      { class: 'head' },
      el('span', { class: `dot ${p.running ? 'on' : ''}`, title: p.running ? 'App running' : 'App not running' }),
      nameEl,
      p.isDefault ? el('span', { class: 'badge' }, 'default dirs') : null,
      u.plan || id.plan ? el('span', { class: 'badge' }, u.plan || id.plan) : null,
    ),
    pending
      ? el('div', { class: 'ident' }, el('span', { class: 'skel', style: 'width:180px' }))
      : el('div', { class: `ident ${id.loggedIn ? '' : 'err'}` }, identText),
    usageBlock,
    buttons,
    cliBox(p),
    notes,
  );
}

// The command that enters this profile, as selectable text, with a button
// that copies it. The icon flips to a tick for a moment so the click is seen
// to have done something.
function cliBox(p: ProfileView): HTMLDivElement {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const btn = el(
    'button',
    {
      class: 'copy-btn',
      title: 'Copy command',
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
  return el('div', { class: 'cli' }, el('span', { class: 'cmd' }, p.cli), btn);
}

function render(): void {
  if (!state) return;
  // A poll or the minute tick must not wipe out a rename in progress. The
  // next render after editing ends picks up whatever state arrived meanwhile.
  if (root.querySelector('.name input')) return;
  root.replaceChildren();
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
