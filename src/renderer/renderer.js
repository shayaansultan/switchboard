const root = document.getElementById('root');
let state = null;

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'style') e.setAttribute('style', v);
    else if (v !== null && v !== undefined) e.setAttribute(k, v);
  }
  for (const c of children.flat())
    if (c !== null && c !== undefined) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}

function relTime(iso) {
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
function icon(name) {
  const s = el('span', { class: `ico ${name}` });
  s.innerHTML = ICONS[name];
  return s;
}

async function act(fn, btn) {
  if (btn) btn.disabled = true;
  try {
    await fn();
  } catch (e) {
    alert(e.message || String(e));
  } finally {
    if (btn) btn.disabled = false;
  }
}

function bar(w) {
  // Colour always reflects how close the window is to running out.
  const cls = w.severity === 'critical' || w.pct >= 90 ? 'bad' : w.severity === 'warning' || w.pct >= 70 ? 'warn' : '';
  const remaining = state.settings.usageMode === 'remaining';
  const shown = remaining ? 100 - w.pct : w.pct;
  return el(
    'div',
    { class: 'bar' },
    el('span', { class: 'label' }, w.label),
    el('div', { class: 'track' }, el('div', { class: `fill ${cls}`, style: `width:${shown}%` })),
    el('span', { class: 'pct', title: remaining ? `${w.pct}% used` : `${100 - w.pct}% left` }, `${shown}%`),
    w.resetsAt ? el('span', { class: 'reset' }, relTime(w.resetsAt)) : null,
  );
}

function card(p) {
  const id = p.identity || {};
  const u = p.usage || {};
  const vendorLabel = state.vendors[p.vendor].label;
  const installed = state.vendors[p.vendor].installed;

  const nameEl = el(
    'span',
    {
      class: 'name',
      title: 'Double-click to rename',
      ondblclick: () => {
        if (p.isDefault) return;
        const input = el('input', { value: p.name });
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') input.blur();
          if (ev.key === 'Escape') render();
        });
        input.addEventListener('blur', () => window.sb.updateProfile(p.id, { name: input.value }));
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

  let usageBlock;
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
      onclick: (e) => act(() => (p.running ? window.sb.quit(p.id) : window.sb.launch(p.id)), e.target),
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
        onclick: (e) => act(() => window.sb.shell(p.id), e.target),
        title: 'Open a terminal already pointed at this profile',
      },
      'Terminal',
    ),
    el(
      'button',
      {
        onclick: (e) => act(() => window.sb.login(p.id), e.target),
        title: 'Sign the CLI into this profile (needed for usage). Run again if the token expires.',
      },
      'Sign in CLI',
    ),
    el('button', { onclick: (e) => act(() => window.sb.refresh(p.id), e.target), title: 'Refresh usage' }, '↻'),
    el(
      'button',
      {
        onclick: (e) =>
          act(async () => {
            const choice = await window.sb.menu(p.id);
            if (choice === 'bringOver') openSetup({ target: p });
            else if (choice === 'reveal') await window.sb.reveal(p.id);
            else if (choice === 'remove') await window.sb.removeProfile(p.id);
          }, e.target),
        title: 'More',
      },
      '⋯',
    ),
  );

  const notes = [];
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
            onclick: (e) => {
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
function cliBox(p) {
  const btn = el(
    'button',
    {
      class: 'copy-btn',
      title: 'Copy command',
      onclick: () => {
        window.sb.copyCommand(p.id);
        btn.classList.add('copied');
        clearTimeout(btn.timer);
        btn.timer = setTimeout(() => btn.classList.remove('copied'), 1500);
      },
    },
    icon('copy'),
    icon('check'),
  );
  return el('div', { class: 'cli' }, el('span', { class: 'cmd' }, p.cli), btn);
}

function render() {
  if (!state) return;
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
const addDialog = document.getElementById('add-dialog');
const addForm = document.getElementById('add-form');
let setupTarget = null; // an existing profile when bringing things over; null when creating

function renderSetupOptions() {
  const vendor = setupTarget ? setupTarget.vendor : addForm.vendor.value;
  const sources = state.profiles.filter((p) => p.vendor === vendor && (!setupTarget || p.id !== setupTarget.id));
  addForm.source.replaceChildren(
    el('option', { value: '' }, 'Nothing, start blank'),
    ...sources.map((p) => el('option', { value: p.id }, p.name)),
  );
  const preferred = sources.find((p) => p.isDefault) || sources[0];
  addForm.source.value = preferred ? preferred.id : '';
  document
    .getElementById('add-items-list')
    .replaceChildren(
      ...state.setupItems[vendor].map((it) =>
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
  document.getElementById('add-items').hidden = !addForm.source.value;
}

function openSetup({ target } = {}) {
  // History sizes are expensive to compute, so ask for them only now.
  window.sb.measureSizes().catch(() => {});
  setupTarget = target || null;
  addForm.reset();
  document.getElementById('add-title').textContent = target ? `Bring over into ${target.name}` : 'New profile';
  document.getElementById('add-basics').hidden = !!target;
  document.getElementById('add-submit').textContent = target ? 'Bring over' : 'Create';
  addForm.name.required = !target;
  renderSetupOptions();
  addDialog.showModal();
}

document.getElementById('add').onclick = () => openSetup();
addForm.vendor.onchange = renderSetupOptions;
addForm.source.onchange = () => {
  document.getElementById('add-items').hidden = !addForm.source.value;
};
document.getElementById('add-cancel').onclick = () => addDialog.close();
addForm.onsubmit = (e) => {
  const f = new FormData(e.target);
  const sourceId = f.get('source') || null;
  const opts = { items: f.getAll('item'), mode: f.get('mode') || 'link' };
  act(async () => {
    let r;
    if (setupTarget) {
      if (!sourceId) return;
      r = await window.sb.bringOver(setupTarget.id, sourceId, opts);
    } else {
      r = (await window.sb.addProfile({ vendor: f.get('vendor'), name: f.get('name'), sourceId, ...opts })).result;
    }
    const parts = [];
    if (r.done.length) parts.push(`Brought over: ${r.done.join(', ')}.`);
    if (r.skipped.length) parts.push(`Left as is, already there: ${r.skipped.map((x) => x.item).join(', ')}.`);
    if (setupTarget && parts.length) alert(parts.join('\n'));
  });
};

const settingsDialog = document.getElementById('settings-dialog');
document.getElementById('settings').onclick = () => {
  const form = document.getElementById('settings-form');
  // Only terminals actually installed on this Mac are offered.
  form.terminal.replaceChildren(...state.terminals.map((t) => el('option', { value: t.id }, t.label)));
  form.terminal.value = state.terminals.some((t) => t.id === state.settings.terminal)
    ? state.settings.terminal
    : 'Terminal';
  form.pollMinutes.value = state.settings.pollMinutes;
  form.usageMode.value = state.settings.usageMode || 'used';
  form.openAtLogin.checked = !!state.settings.openAtLogin;
  settingsDialog.showModal();
};
document.getElementById('settings-cancel').onclick = () => settingsDialog.close();
document.getElementById('settings-form').onsubmit = (e) => {
  const f = new FormData(e.target);
  act(() =>
    window.sb.saveSettings({
      terminal: f.get('terminal'),
      pollMinutes: Number(f.get('pollMinutes')) || 5,
      openAtLogin: f.get('openAtLogin') === 'on',
      usageMode: f.get('usageMode'),
    }),
  );
};

document.getElementById('refresh').onclick = (e) => act(() => window.sb.refresh(), e.target);

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
