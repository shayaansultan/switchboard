// The three dialogs: a new profile (or bringing things into one), settings,
// and a new proxy bucket. Each is a native <dialog> shown modally while its
// `open` prop holds; the form inside is remounted on every open, so it always
// starts from the current state.

import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { act, type BringMode, type ProfileView, type Settings, type State, type Vendor } from './lib';
import { Btn, Icon, Switch } from './ui/primitives';

function Modal({
  id,
  open,
  onClose,
  children,
}: {
  id: string;
  open: boolean;
  onClose: () => void;
  children: ComponentChildren;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog id={id} ref={ref} onClose={onClose} onCancel={onClose}>
      {open ? children : null}
    </dialog>
  );
}

export type SetupRequest = { target: ProfileView | null } | null;

export function AddDialog({ state, request, onClose }: { state: State; request: SetupRequest; onClose: () => void }) {
  return (
    <Modal id="add-dialog" open={!!request} onClose={onClose}>
      {request ? <AddForm state={state} target={request.target} onClose={onClose} /> : null}
    </Modal>
  );
}

function AddForm({ state, target, onClose }: { state: State; target: ProfileView | null; onClose: () => void }) {
  const [vendor, setVendor] = useState<Vendor>(target ? target.vendor : 'claude');
  const sources = state.profiles.filter((p) => p.vendor === vendor && (!target || p.id !== target.id));
  const preferred = sources.find((p) => p.isDefault) || sources[0];
  const [source, setSource] = useState(preferred ? preferred.id : '');
  useEffect(() => {
    // History sizes are expensive to compute, so ask for them only now.
    window.sb.measureSizes().catch(() => {});
  }, []);
  useEffect(() => {
    const list = state.profiles.filter((p) => p.vendor === vendor && (!target || p.id !== target.id));
    const first = list.find((p) => p.isDefault) || list[0];
    setSource(first ? first.id : '');
  }, [vendor]);

  const submit = (e: Event) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget as HTMLFormElement);
    const sourceId = (f.get('source') as string | null) || null;
    const opts = {
      items: f.getAll('item') as string[],
      mode: ((f.get('mode') as BringMode | null) || 'link') as BringMode,
    };
    void act(async () => {
      let r;
      if (target) {
        if (!sourceId) return;
        r = await window.sb.bringOver(target.id, sourceId, opts);
      } else {
        r = (await window.sb.addProfile({ vendor, name: String(f.get('name') ?? ''), sourceId, ...opts })).result;
      }
      const parts: string[] = [];
      if (r.done.length) parts.push(`Brought over: ${r.done.join(', ')}.`);
      if (r.skipped.length) parts.push(`Left as is, already there: ${r.skipped.map((x) => x.item).join(', ')}.`);
      if (target && parts.length) alert(parts.join('\n'));
      onClose();
    });
  };

  return (
    <form id="add-form" onSubmit={submit}>
      <h2 id="add-title">{target ? `Bring over into ${target.name}` : 'New profile'}</h2>
      <div id="add-basics" class="basics" hidden={!!target}>
        <div class="choices" role="radiogroup" aria-label="App">
          {(Object.entries(state.vendors) as [Vendor, State['vendors'][Vendor]][]).map(([v, info]) => (
            <label class="choice" key={v}>
              <input type="radio" name="vendor" value={v} checked={vendor === v} onChange={() => setVendor(v)} />
              <span class="mark">
                <Icon name="check" size={12} />
              </span>
              <span class="what">
                <b>{info.label}</b>
                <span>
                  {v === 'claude' ? 'Claude Desktop and the claude CLI' : 'The ChatGPT app and the codex CLI'}
                </span>
              </span>
            </label>
          ))}
        </div>
        <label>
          Name <input name="name" placeholder="Work, Personal, Client X…" required={!target} autoFocus />
        </label>
      </div>
      <label>
        Start from
        <select name="source" value={source} onChange={(e) => setSource((e.currentTarget as HTMLSelectElement).value)}>
          <option value="">Nothing, start blank</option>
          {sources.map((p) => (
            <option value={p.id} key={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <fieldset id="add-items" hidden={!source}>
        <legend>Bring over</legend>
        <div id="add-items-list" class="items">
          {state.setupItems[vendor].map((it) => (
            <label class={`check ${it.warn ? 'warn' : ''}`} key={it.id}>
              <input type="checkbox" name="item" value={it.id} defaultChecked={it.on} />
              <span>
                {it.label}
                {it.size ? ` (about ${it.size} from Default)` : ''}
                {it.hint ? <span class="hint">{it.hint}</span> : null}
              </span>
            </label>
          ))}
        </div>
        <div class="mode">
          <label class="check">
            <input type="radio" name="mode" value="link" defaultChecked /> Keep in sync with the source (links, one edit
            applies to both)
          </label>
          <label class="check">
            <input type="radio" name="mode" value="copy" /> Copy once (the two drift apart from here)
          </label>
        </div>
      </fieldset>
      <p class="hint">Login, chat history, memories and session state are never brought over.</p>
      <menu>
        <Btn variant="secondary" id="add-cancel" onClick={onClose}>
          Cancel
        </Btn>
        <Btn variant="primary" id="add-submit" type="submit">
          {target ? 'Bring over' : 'Create'}
        </Btn>
      </menu>
    </form>
  );
}

export function SettingsDialog({ state, open, onClose }: { state: State; open: boolean; onClose: () => void }) {
  return (
    <Modal id="settings-dialog" open={open} onClose={onClose}>
      {open ? <SettingsForm state={state} onClose={onClose} /> : null}
    </Modal>
  );
}

function SettingsForm({ state, onClose }: { state: State; onClose: () => void }) {
  const s = state.settings;
  const [terminal, setTerminal] = useState(state.terminals.some((t) => t.id === s.terminal) ? s.terminal : 'Terminal');
  const [usageMode, setUsageMode] = useState<Settings['usageMode']>(s.usageMode || 'used');
  const [pollMinutes, setPollMinutes] = useState(String(s.pollMinutes));
  const [menuBar, setMenuBar] = useState(s.menuBar || 'icon');
  const [appearance, setAppearance] = useState(s.appearance || 'system');
  const [openAtLogin, setOpenAtLogin] = useState(!!s.openAtLogin);
  const submit = (e: Event) => {
    e.preventDefault();
    void act(async () => {
      await window.sb.saveSettings({
        terminal,
        pollMinutes: Number(pollMinutes) || 5,
        openAtLogin,
        usageMode,
        appearance,
        menuBar,
      });
      onClose();
    });
  };
  const row = (label: string, about: string, control: ComponentChildren) => (
    <div class="srow">
      <label>
        <span class="about">
          <b>{label}</b>
          <span>{about}</span>
        </span>
        {control}
      </label>
    </div>
  );
  return (
    <form id="settings-form" onSubmit={submit}>
      <h2>Settings</h2>
      <div class="rows">
        {row(
          'Terminal',
          'Opened by the terminal button on each account.',
          <select
            name="terminal"
            value={terminal}
            onChange={(e) => setTerminal((e.currentTarget as HTMLSelectElement).value)}
          >
            {state.terminals.map((t) => (
              <option value={t.id} key={t.id}>
                {t.label}
              </option>
            ))}
          </select>,
        )}
        {row(
          'Show usage as',
          'Bars fill with what is used, or with what is left.',
          <select
            name="usageMode"
            value={usageMode}
            onChange={(e) => setUsageMode((e.currentTarget as HTMLSelectElement).value as Settings['usageMode'])}
          >
            <option value="used">How much is used</option>
            <option value="remaining">How much is left</option>
          </select>,
        )}
        {row(
          'Usage refresh',
          'Minutes between polls of each signed-in CLI.',
          <input
            name="pollMinutes"
            type="number"
            min={1}
            max={60}
            value={pollMinutes}
            onInput={(e) => setPollMinutes((e.currentTarget as HTMLInputElement).value)}
          />,
        )}
        {row(
          'Menu bar',
          'What the tray icon shows without opening the window.',
          <select
            name="menuBar"
            value={menuBar}
            onChange={(e) =>
              setMenuBar((e.currentTarget as HTMLSelectElement).value as NonNullable<Settings['menuBar']>)
            }
          >
            <option value="icon">Meter only</option>
            <option value="percent">Meter and the fullest window's percentage</option>
          </select>,
        )}
        {row(
          'Appearance',
          'Follows the Mac unless you pick one.',
          <select
            name="appearance"
            value={appearance}
            onChange={(e) =>
              setAppearance((e.currentTarget as HTMLSelectElement).value as NonNullable<Settings['appearance']>)
            }
          >
            <option value="system">Match the system</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>,
        )}
        {row(
          'Open at login',
          'Starts in the menu bar without a window.',
          <Switch name="openAtLogin" checked={openAtLogin} onChange={setOpenAtLogin} label="Open at login" />,
        )}
      </div>
      <menu>
        <Btn variant="secondary" id="settings-cancel" onClick={onClose}>
          Cancel
        </Btn>
        <Btn variant="primary" type="submit">
          Save
        </Btn>
      </menu>
    </form>
  );
}

export function BucketDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  useEffect(() => {
    if (open) setName('');
  }, [open]);
  return (
    <Modal id="bucket-dialog" open={open} onClose={onClose}>
      <form
        id="bucket-form"
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            await window.sb.createBucket(name);
            onClose();
          }, document.getElementById('bucket-submit'));
        }}
      >
        <h2>New proxy bucket</h2>
        <label>
          Name{' '}
          <input
            id="bucket-name"
            required
            maxLength={100}
            placeholder="Personal, Work…"
            autoFocus
            value={name}
            onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <p class="hint">Create an empty bucket, then use Add account to sign in through the proxy.</p>
        <menu>
          <Btn variant="secondary" id="bucket-cancel" onClick={onClose}>
            Cancel
          </Btn>
          <Btn variant="primary" id="bucket-submit" type="submit">
            Create bucket
          </Btn>
        </menu>
      </form>
    </Modal>
  );
}
