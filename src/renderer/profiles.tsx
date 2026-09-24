// The Profiles tab: a panel per vendor, one profile per row (List) or per
// tile (Cards). Both draw the same pieces: identity, usage, the one action,
// the tools. Rows and tiles can be dragged into a new order within their
// vendor; the Default profile stays pinned first.

import { useState } from 'preact/hooks';
import {
  act,
  ago,
  clock,
  relShort,
  relTime,
  severityClass,
  type BucketAccount,
  type BucketView,
  type Identity,
  type ProfileView,
  type State,
  type Usage,
  type UsageWindow,
  type ProfilesView,
  type Vendor,
  type AppState,
} from './lib';
import {
  Badge,
  Bar,
  Btn,
  Dot,
  Icon,
  Note,
  Panel,
  Seg,
  Skeleton,
  StatusPill,
  TipBtn,
  type DotKind,
} from './ui/primitives';
import { useOverlays, useTip, type MenuItem } from './ui/overlays';
import { useActions } from './ui/actions';

type Drag = { id: string; vendor: string } | null;
type Over = { id: string; after: boolean } | null;

export function Profiles({
  state,
  view,
  setView,
}: {
  state: State;
  view: ProfilesView;
  setView: (v: ProfilesView) => void;
}) {
  const { openSetup } = useActions();
  const [drag, setDrag] = useState<Drag>(null);
  const [over, setOver] = useState<Over>(null);
  const latest = state.profiles
    .map((p) => p.usage?.fetchedAt)
    .filter(Boolean)
    .sort()
    .at(-1);
  const refreshed = latest ? `Refreshed ${ago(latest)}` : 'Waiting for the first refresh';

  // Where a drop lands: the dragged profile moves so it sits before or after
  // the target, counted among its vendor's movable profiles.
  const drop = (target: ProfileView) => {
    if (!drag || drag.vendor !== target.vendor || drag.id === target.id) return;
    const row = state.profiles.filter((p) => p.vendor === target.vendor && !p.isDefault);
    const from = row.findIndex((p) => p.id === drag.id);
    let to = row.findIndex((p) => p.id === target.id);
    if (from < 0) return;
    if (over?.after) to += 1;
    if (from < to) to -= 1;
    if (to !== from) void act(() => window.sb.moveProfile(drag.id, to - from));
  };
  const dnd = (p: ProfileView, axis: 'y' | 'x') => ({
    draggable: !p.isDefault,
    onDragStart: (e: DragEvent) => {
      if (p.isDefault) return;
      e.dataTransfer?.setData('text/plain', p.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      setDrag({ id: p.id, vendor: p.vendor });
    },
    onDragEnd: () => {
      setDrag(null);
      setOver(null);
    },
    onDragOver: (e: DragEvent) => {
      if (!drag || drag.vendor !== p.vendor || p.isDefault) return;
      e.preventDefault();
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const after = axis === 'y' ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2;
      if (over?.id !== p.id || over.after !== after) setOver({ id: p.id, after });
    },
    onDragLeave: (e: DragEvent) => {
      if (over?.id === p.id && !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver(null);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      drop(p);
      setDrag(null);
      setOver(null);
    },
  });
  const dragClass = (p: ProfileView) =>
    [drag?.id === p.id ? 'dragging' : '', over?.id === p.id ? (over.after ? 'drop-after' : 'drop-before') : ''].join(
      ' ',
    );

  return (
    <>
      <div class="toolbar">
        <span class="note">{refreshed}.</span>
        <Seg
          label="Show profiles as"
          value={view}
          onChange={setView}
          options={[
            { id: 'cards', label: 'Cards', icon: 'grid' },
            { id: 'list', label: 'List', icon: 'list' },
          ]}
        />
      </div>
      {Object.entries(state.vendors).map(([vendor, v]) => {
        const list = state.profiles.filter((p) => p.vendor === vendor);
        const rows = list.length ? (
          list.map((p) => (
            <Profile
              key={p.id}
              p={p}
              state={state}
              view={view}
              class={dragClass(p)}
              dnd={dnd(p, view === 'cards' ? 'x' : 'y')}
            />
          ))
        ) : (
          <div class="empty">No profiles</div>
        );
        const na = v.installed ? null : <span class="na">app not installed</span>;
        // A new profile is made where it will live, so the vendor is settled
        // before the dialog opens.
        const add = (
          <Btn id={`add-${vendor}`} icon="plus" onClick={() => openSetup(undefined, vendor as Vendor)}>
            Profile
          </Btn>
        );
        // Cards sit straight on the page under a plain heading; the list is a
        // panel with a header band, since its rows share columns.
        return view === 'cards' ? (
          <section class="vendor" key={vendor}>
            <div class="eyebrow">
              <span class="panel-title">{v.label}</span>
              {na}
              <span class="panel-actions">{add}</span>
            </div>
            <div class="grid">{rows}</div>
          </section>
        ) : (
          <Panel key={vendor} title={v.label} meta={na} actions={add}>
            {rows}
          </Panel>
        );
      })}
    </>
  );
}

type Dnd = Record<string, unknown>;

function Profile({
  p,
  state,
  view,
  class: cls,
  dnd,
}: {
  p: ProfileView;
  state: State;
  view: ProfilesView;
  class: string;
  dnd: Dnd;
}) {
  const { openMenu } = useOverlays();
  const [editing, setEditing] = useState(false);
  const items = useMenuItems(p, state, () => setEditing(true));
  // The same menu from the dots and from a right-click anywhere on the row.
  const onContextMenu = (e: MouseEvent) => {
    if ((e.target as Element).closest('input, a')) return;
    e.preventDefault();
    openMenu({ x: e.clientX, y: e.clientY }, items);
  };
  const foot = (
    <div class="foot">
      <PrimaryButton p={p} state={state} />
      <Tools p={p} state={state} items={items} />
    </div>
  );
  if (view === 'cards') {
    return (
      <div class={`card tile ${cls}`} style={{ '--card-color': p.color }} onContextMenu={onContextMenu} {...dnd}>
        <IdentityBlock p={p} state={state} pill editing={editing} setEditing={setEditing} />
        <UsageBlock p={p} state={state} />
        {foot}
      </div>
    );
  }
  return (
    <div class={`card ${cls}`} style={{ '--card-color': p.color }} onContextMenu={onContextMenu} {...dnd}>
      <IdentityBlock p={p} state={state} editing={editing} setEditing={setEditing} />
      <UsageBlock p={p} state={state} />
      {foot}
    </div>
  );
}

// Colour chip, name (double-click, or Rename in the menu, to rename), plan,
// running dot, then the signed-in identity.
function IdentityBlock({
  p,
  state,
  pill = false,
  editing,
  setEditing,
}: {
  p: ProfileView;
  state: State;
  pill?: boolean;
  editing: boolean;
  setEditing: (on: boolean) => void;
}) {
  const { openMenu } = useOverlays();
  const id: Partial<Identity> = p.identity ?? {};
  const u: Usage = p.usage ?? {};
  // Nothing known yet (first launch, no cache): show placeholders, not
  // misleading "not signed in" text.
  const pending = !p.identity;
  const app = p.app ?? 'off';
  const [draft, setDraft] = useState(p.name);
  const finish = () => {
    setEditing(false);
    const name = draft.trim();
    if (name && name !== p.name) void act(() => window.sb.updateProfile(p.id, { name }));
  };
  return (
    <div class="who">
      <div class="head">
        <button
          type="button"
          class="color"
          title="Colour"
          onClick={(e) =>
            openMenu(
              e.currentTarget as HTMLElement,
              [{ colors: state.palette, current: p.color, pick: (color) => window.sb.updateProfile(p.id, { color }) }],
              { prefer: 'below', align: 'left' },
            )
          }
        />
        <span
          class="name"
          title={p.isDefault ? undefined : 'Double-click to rename'}
          onDblClick={() => {
            if (p.isDefault) return;
            setDraft(p.name);
            setEditing(true);
          }}
        >
          {editing ? (
            <input
              value={draft}
              ref={(el) => el?.focus()}
              onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
                if (e.key === 'Escape') {
                  setDraft(p.name);
                  setEditing(false);
                }
              }}
              onBlur={finish}
            />
          ) : (
            p.name
          )}
        </span>
        {pill && p.isDefault ? <Badge tone="mute">default dirs</Badge> : null}
        {u.plan || id.plan ? <Badge>{u.plan || id.plan}</Badge> : null}
        {pill ? (
          <StatusPill on={app === 'running'} tone={APP_UI[app].tone} dot={APP_UI[app].dot}>
            {APP_UI[app].label}
          </StatusPill>
        ) : (
          <Dot on={app === 'running'} kind={APP_UI[app].dot} title={APP_UI[app].title} />
        )}
      </div>
      {pending ? (
        <div class="ident">
          <Skeleton width={150} />
        </div>
      ) : (
        <div class={`ident ${id.loggedIn ? '' : 'err'}`}>
          {id.loggedIn ? id.email || 'signed in' : id.error || 'CLI not signed in for this profile'}
          {id.loggedIn ? (
            p.isDefault && !pill ? (
              ' · default dirs'
            ) : null
          ) : (
            <>
              {' · '}
              <a
                href="#"
                title="Sign the CLI into this profile (needed for usage)."
                onClick={(e) => {
                  e.preventDefault();
                  void act(() => window.sb.login(p.id));
                }}
              >
                Sign in CLI
              </a>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// The profile's menu: who it is, then verbs grouped by kind (name, the
// connection, the session, the files, and last the one that removes it).
// The primary action never lives here.
function useMenuItems(p: ProfileView, state: State, rename: () => void): MenuItem[] {
  const { openSetup, newBucket } = useActions();
  const id: Partial<Identity> = p.identity ?? {};
  const plan = p.usage?.plan || id.plan;
  const who = [p.isDefault ? 'Default profile' : null, id.loggedIn ? id.email : 'not signed in', plan]
    .filter(Boolean)
    .join(' · ');
  const groups: MenuItem[][] = [
    [{ header: p.name, sub: who }],
    p.isDefault ? [] : [{ label: 'Rename', run: rename }],
    connectionItems(p, state, newBucket),
    [
      { label: 'Refresh usage', run: () => window.sb.refresh(p.id) },
      { label: id.loggedIn ? 'Sign in CLI again' : 'Sign in CLI', run: () => window.sb.login(p.id) },
    ],
    [
      ...(p.isDefault ? [] : [{ label: 'Bring over…', run: () => openSetup(p) }]),
      { label: 'Show in Finder', run: () => window.sb.reveal(p.id) },
    ],
    p.isDefault ? [] : [{ label: 'Remove…', danger: true, run: () => window.sb.removeProfile(p.id) }],
  ];
  return groups.filter((g) => g.length).flatMap((g, i) => (i ? ['separator' as const, ...g] : g));
}

// The model connection of a Codex profile, as a submenu that shows its
// value: its own sign-in, or any proxy bucket.
function connectionItems(p: ProfileView, state: State, newBucket: () => void): MenuItem[] {
  if (p.vendor !== 'codex') return [];
  const buckets = state.buckets ?? [];
  const current = buckets.find((b) => b.id === p.proxyBucket);
  const orphan = p.proxyBucket && !current ? p.proxyBucket : null;
  const pick = (bucket: string | null) => () => window.sb.setProxyBucket(p.id, bucket);
  return [
    {
      label: 'Connection',
      value: orphan ? 'Unavailable' : current ? current.name : 'Native',
      items: [
        { label: 'Native account', checked: !p.proxyBucket, run: pick(null) },
        ...buckets.map((b) => ({ label: b.name, checked: p.proxyBucket === b.id, run: pick(b.id) })),
        ...(orphan ? [{ label: `Unavailable · ${orphan}`, checked: true, disabled: true, run: () => {} }] : []),
        'separator',
        { label: 'New proxy bucket…', run: newBucket },
      ],
    },
  ];
}

// The usage bars, or whatever explains their absence, plus the notes that
// belong with them.
function UsageBlock({ p, state }: { p: ProfileView; state: State }) {
  const u: Usage = p.usage ?? {};
  const id: Partial<Identity> = p.identity ?? {};
  const pending = !p.identity;
  const remaining = state.settings.usageMode === 'remaining';
  const vendorLabel = state.vendors[p.vendor].label;
  const installed = state.vendors[p.vendor].installed;
  const bucket = state.buckets?.find((b) => b.id === p.proxyBucket);
  const at = clock(u.fetchedAt);

  let body;
  if (p.proxyBucket) {
    body = bucket ? (
      <BucketSummary bucket={bucket} remaining={remaining} />
    ) : (
      <Note tone="warn">Bucket unavailable. Choose another connection.</Note>
    );
  } else if (pending) {
    body = [0, 1].map((i) => (
      <div class="bar" key={i}>
        <Skeleton width={24} />
        <div class="track skel" />
        <Skeleton width={32} />
      </div>
    ));
  } else if (u.windows && u.windows.length) {
    body = (
      <>
        {u.windows.map((w) => (
          <Bar w={w} stale={!!u.stale} remaining={remaining} key={w.label} />
        ))}
        {u.stale && u.error ? (
          <Note>
            Couldn't refresh ({u.error}). Showing numbers from {at}.
          </Note>
        ) : p.cached ? (
          <Note>Numbers from {at}, updating…</Note>
        ) : null}
      </>
    );
  } else if (u.error) body = <Note>Usage: {u.error}</Note>;
  else body = <Note>Usage: loading…</Note>;

  return (
    <div class="bars">
      {body}
      {installed ? null : <Note>{vendorLabel} desktop app not found in /Applications.</Note>}
      {p.app === 'stalled' ? (
        <Note tone="warn">
          {vendorLabel} is still running after Quit. It may be asking you to confirm: switch to it and answer, or force
          quit it.
        </Note>
      ) : null}
      {!p.isDefault && (p.app ?? 'off') === 'off' && !id.loggedIn ? (
        <Note>
          Before the first sign-in, quit the other {vendorLabel} windows: the login link opens in whichever is running.{' '}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              void act(async () => {
                if (!confirm(`Quit every other ${vendorLabel} window?\n\nAnything unsaved in them is lost.`)) return;
                const n = await window.sb.quitOthers(p.id);
                alert(
                  n ? `Quit ${n} other ${vendorLabel} window(s).` : `No other ${vendorLabel} windows were running.`,
                );
              });
            }}
          >
            Quit others now
          </a>
        </Note>
      ) : null}
    </div>
  );
}

// The one action that changes the desktop app's state: filled play to
// launch, a red power sign to quit. Icon only, so a row of profiles stays
// quiet; the tooltip names the profile. While a launch or quit is on its way
// the button spins; an app that ignored Quit gets a labelled Force quit.
function PrimaryButton({ p, state }: { p: ProfileView; state: State }) {
  const vendor = state.vendors[p.vendor];
  const app = p.app ?? 'off';
  if (app === 'stalled') {
    return (
      <TipBtn
        class="primary-btn force"
        icon="zap"
        aria-label={`Force quit ${p.name}`}
        tip={[`Force quit ${p.name}`, 'Anything unsaved in it is lost']}
        onClick={(e) =>
          act(async () => {
            if (!confirm(`Force quit ${vendor.label} for "${p.name}"?\n\nAnything unsaved in it is lost.`)) return;
            await window.sb.forceQuit(p.id);
          }, e.currentTarget)
        }
      >
        Force quit
      </TipBtn>
    );
  }
  if (app === 'starting' || app === 'quitting') {
    const label = `${APP_UI[app].label.replace('…', '')} ${p.name}…`;
    return (
      <TipBtn
        class={`icon-btn primary-btn busy ${app === 'starting' ? 'primary' : 'quit'}`}
        icon="loader"
        disabled
        aria-label={label}
        tip={[label]}
      />
    );
  }
  const verb = app === 'running' ? 'Quit' : 'Launch';
  return (
    <TipBtn
      class={`icon-btn primary-btn ${app === 'running' ? 'quit' : 'primary'}`}
      icon={app === 'running' ? 'power' : 'play'}
      disabled={!vendor.installed}
      aria-label={`${verb} ${p.name}`}
      tip={[`${verb} ${p.name}`, vendor.installed ? `${vendor.label} desktop app` : `${vendor.label} is not installed`]}
      onClick={(e) => act(() => (app === 'running' ? window.sb.quit(p.id) : window.sb.launch(p.id)), e.currentTarget)}
    />
  );
}

// How each desktop-app state reads: the card's pill, the list's dot and its
// tooltip. The dot is hidden when the app is off.
const APP_UI: Record<AppState, { label: string; title: string; tone: 'ok' | 'mute' | 'warn'; dot: DotKind }> = {
  off: { label: 'Off', title: 'App not running', tone: 'mute', dot: 'off' },
  starting: { label: 'Starting…', title: 'App starting', tone: 'ok', dot: 'busy' },
  running: { label: 'Running', title: 'App running', tone: 'ok', dot: 'on' },
  quitting: { label: 'Quitting…', title: 'App quitting', tone: 'mute', dot: 'busy' },
  stalled: { label: "Won't quit", title: 'App still running after Quit', tone: 'warn', dot: 'warn' },
};

function Tools({ p, state, items }: { p: ProfileView; state: State; items: MenuItem[] }) {
  const { openMenu } = useOverlays();
  const [copied, setCopied] = useState(false);
  return (
    <div class="tools">
      <TipBtn
        variant="icon"
        icon="terminal"
        aria-label={`Terminal for ${p.name}`}
        tip={['Open a terminal in this profile', `${state.settings.terminal}, already signed in as ${p.name}`]}
        onClick={(e) => act(() => window.sb.shell(p.id), e.currentTarget)}
      />
      <TipBtn
        variant="icon"
        class={`copy-btn ${copied ? 'copied' : ''}`}
        aria-label={`Copy CLI command for ${p.name}`}
        tip={['Copy the command for this profile', p.cli]}
        onClick={() => {
          window.sb.copyCommand(p.id);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        <Icon name="copy" />
        <Icon name="check" />
      </TipBtn>
      <TipBtn
        variant="icon"
        icon="more"
        class="more-btn"
        aria-label={`More actions for ${p.name}`}
        tip={['More', 'Also on right-click']}
        onClick={(e) => openMenu(e.currentTarget as HTMLElement, items)}
      />
    </div>
  );
}

// On a profile card a bucket is pooled: one bar per provider and window,
// cut into a segment per account, so "GPT 7d" reads as one quota while a
// spent account still shows as a full segment. Segments are sized by the
// plan's capacity and the number is the capacity-weighted mean.
export function BucketSummary({ bucket, remaining }: { bucket: BucketView; remaining: boolean }) {
  type Part = { account: BucketAccount; pct: number; w: UsageWindow };
  const pools = new Map<string, Part[]>();
  for (const account of bucket.accounts) {
    if (account.status === 'disabled') continue;
    for (const w of account.windows) {
      if (w.pct === null || w.pct === undefined) continue;
      const label = account.provider === 'claude' ? `Claude ${w.label}` : `GPT ${w.label.replace(/^gpt-/, '')}`;
      pools.set(label, [...(pools.get(label) ?? []), { account, pct: w.pct, w }]);
    }
  }
  const shown = (pct: number): number => (remaining ? 100 - pct : pct);
  const who = (part: Part): string => part.account.email ?? part.account.name;
  const capacity = (part: Part): number => part.account.plan?.capacity ?? 1;
  const about = (part: Part): string =>
    [part.account.plan?.name, `${part.pct}% used`, relTime(part.w.resetsAt)].filter(Boolean).join(' · ');
  return (
    <>
      <Note>Usage from the {bucket.name} bucket</Note>
      {[...pools].map(([label, parts]) => {
        const size = parts.reduce((sum, part) => sum + capacity(part), 0);
        const used = Math.round(parts.reduce((sum, part) => sum + part.pct * capacity(part), 0) / size);
        const upcoming = parts.filter((part) => part.w.resetsAt && Date.parse(part.w.resetsAt) > Date.now());
        const low = upcoming.filter((part) => severityClass(part.w));
        const next = (low.length ? low : upcoming).map((part) => part.w.resetsAt as string).sort()[0];
        const reset = relShort(next ?? null);
        return (
          <PooledBar
            key={label}
            label={label}
            parts={parts}
            reset={reset}
            used={shown(used)}
            tip={[label, ...parts.map((part) => `${who(part)} · ${about(part)}`)]}
            segTip={(part) => [who(part), about(part)]}
            shown={shown}
            capacity={capacity}
          />
        );
      })}
      <BucketNotes bucket={bucket} />
    </>
  );
}

function PooledBar<P extends { pct: number; w: UsageWindow }>({
  label,
  parts,
  reset,
  used,
  tip,
  segTip,
  shown,
  capacity,
}: {
  label: string;
  parts: P[];
  reset: string;
  used: number;
  tip: string[];
  segTip: (p: P) => string[];
  shown: (pct: number) => number;
  capacity: (p: P) => number;
}) {
  const labelTip = useTip(tip);
  return (
    <div class="bar">
      <span class="label" {...labelTip}>
        {label}
        {parts.length > 1 ? <span class="reset"> ×{parts.length}</span> : null}
        {reset ? <span class="reset"> · {reset}</span> : null}
      </span>
      <div class="track pooled" style={{ '--segments': parts.length }}>
        {parts.map((part, i) => (
          <Segment
            key={i}
            part={part}
            flex={capacity(part)}
            width={shown(part.pct)}
            cls={severityClass(part.w)}
            tip={segTip(part)}
          />
        ))}
      </div>
      <span class="pct">{used}%</span>
    </div>
  );
}

function Segment<P>({
  part,
  flex,
  width,
  cls,
  tip,
}: {
  part: P;
  flex: number;
  width: number;
  cls: string;
  tip: string[];
}) {
  const handlers = useTip(tip);
  void part;
  return (
    <div class="seg" tabIndex={0} style={{ flex }} aria-label={tip.join(', ')} {...handlers}>
      <div class="seg-track">
        <div class={`fill ${cls}`} style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

// Why a bucket shows no bars, or fewer than expected.
export function BucketNotes({ bucket }: { bucket: BucketView }) {
  return (
    <>
      {bucket.status !== 'running' && !bucket.error ? (
        <Note>
          {bucket.status === 'stopped'
            ? 'Starts when an assigned desktop profile launches.'
            : 'Worker is unreachable. Check its status before restarting.'}
        </Note>
      ) : null}
      {bucket.status === 'running' && !bucket.accounts.length ? (
        <Note>No accounts reported yet. Refresh or add an account.</Note>
      ) : null}
      {bucket.error ? <Note>{bucket.error}</Note> : null}
    </>
  );
}
