// The phone app: what every Claude and Codex profile on one Mac is doing,
// served by that Mac's Switchboard (src/remote/hub.ts) over Tailscale.
//
// Three screens. Pair trades a code from Switchboard for a device cookie the
// hub sets (see api.ts). Home lists the sessions that are working, then each
// profile with its recent sessions, kept live by the hub's `live`
// subscription. A session shows its transcript and re-reads it whenever the
// overview says it changed.
//
// Read-only on purpose: replying and approving arrive with the in-app taps.

import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { HubProfile, Overview } from '../remote/hub';
import type { Entry as TranscriptEntry, SessionSummary, Transcript } from '../remote/model';
import { api, isUnpaired, pairingError } from './api';
const FILTER_KEY = 'switchboard.filter';
const SESSIONS_SHOWN = 4;

function storage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private mode: the pairing lasts as long as the page does.
  }
}

// ---- time and labels ----

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function until(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const m = Math.round((Date.parse(iso) - now) / 60_000);
  if (m <= 0) return 'resetting';
  if (m < 60) return `resets in ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `resets in ${h} h ${m % 60} min`;
  return `resets in ${Math.round(h / 24)} d`;
}

const VENDOR = { claude: 'Claude', codex: 'Codex' } as const;
const APP_STATE: Record<string, string> = {
  running: 'Running',
  background: 'No window',
  starting: 'Starting…',
  quitting: 'Quitting…',
  stalled: "Won't quit",
  off: 'Off',
};
const ORIGIN: Record<SessionSummary['origin'], string> = {
  desktop: 'Desktop',
  cli: 'Terminal',
  ide: 'Editor',
  exec: 'Script',
  other: 'Other',
};

const project = (cwd: string | null): string | null => (cwd ? (cwd.split('/').filter(Boolean).pop() ?? cwd) : null);

function tightest(p: HubProfile): HubProfile['windows'][number] | null {
  return p.windows.reduce<HubProfile['windows'][number] | null>(
    (best, w) => (w.pct !== null && (best?.pct === null || best === null || w.pct > (best.pct ?? -1)) ? w : best),
    null,
  );
}

const level = (pct: number): string => (pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : 'ok');

// ---- routing ----
// #/s/<profile>/<session> opens a session; #pair=CODE pre-fills pairing.

type Route = { name: 'home' } | { name: 'session'; profile: string; id: string };

function readRoute(): Route {
  const m = /^#\/s\/([^/]+)\/(.+)$/.exec(location.hash);
  return m ? { name: 'session', profile: decodeURIComponent(m[1]), id: decodeURIComponent(m[2]) } : { name: 'home' };
}

function useRoute(): Route {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const on = () => setRoute(readRoute());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return route;
}

function useNow(ms = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// ---- the live overview ----
// The hub sends the overview when the subscription starts and again whenever
// it changes. tRPC reconnects on its own after a drop; an UNAUTHORIZED error
// means this phone was unpaired.

type Link = 'connecting' | 'live' | 'retrying';

function useOverview(onUnpaired: () => void): { overview: Overview | null; link: Link } {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [link, setLink] = useState<Link>('connecting');
  useEffect(() => {
    const sub = api.live.subscribe(undefined, {
      onData: (o) => {
        setOverview(o);
        setLink('live');
      },
      onConnectionStateChange: (s) =>
        setLink(s.state === 'pending' ? 'live' : s.state === 'connecting' ? 'retrying' : 'connecting'),
      onError: (err) => (isUnpaired(err) ? onUnpaired() : setLink('retrying')),
    });
    return () => sub.unsubscribe();
  }, []);
  return { overview, link };
}

// ---- screens ----

function Pair({ onPaired }: { onPaired: () => void }) {
  const fromLink = /^#pair=([A-Za-z0-9-]+)$/.exec(location.hash)?.[1] ?? '';
  const [code, setCode] = useState(fromLink);
  const [name, setName] = useState(/iPad/.test(navigator.userAgent) ? 'iPad' : 'iPhone');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: Event) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api.pair.mutate({ code, name });
      history.replaceState(null, '', location.pathname);
      onPaired();
    } catch (err) {
      const reason = pairingError(err);
      setError(
        reason === 'code-expired'
          ? 'That code has expired. Make a new one in Switchboard.'
          : reason === 'code-wrong'
            ? "That code doesn't match. Check it in Switchboard and try again."
            : "Can't reach your Mac. Check that Tailscale is on, on both devices.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <main class="pair">
      <h1>Switchboard</h1>
      <p class="lede">See what your Claude and Codex profiles are working on, from here.</p>
      <form onSubmit={submit} class="pair-form">
        <label for="code">Pairing code</label>
        <input
          id="code"
          value={code}
          onInput={(e) => setCode((e.target as HTMLInputElement).value)}
          placeholder="ABCD-EFGH"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellcheck={false}
          required
        />
        <label for="name">Name this device</label>
        <input id="name" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        {error && <p class="error">{error}</p>}
        <button type="submit" disabled={pending || !code.trim()}>
          {pending ? 'Pairing…' : 'Pair'}
        </button>
      </form>
      <p class="hint">
        Make a code in Switchboard's Settings under Phone access, or run <code>switchboard remote pair</code>.
      </p>
    </main>
  );
}

function SessionRow({ s, now, profile }: { s: SessionSummary; now: number; profile?: HubProfile }) {
  const where = project(s.cwd);
  return (
    <a class="session" href={`#/s/${encodeURIComponent(s.profileId)}/${encodeURIComponent(s.id)}`}>
      <div class="session-top">
        {s.state === 'working' && <span class="pulse" aria-label="Working" />}
        <span class="session-title">{s.title}</span>
        <span class="when">{s.state === 'working' ? 'working' : ago(s.updatedAt, now)}</span>
      </div>
      <div class="session-meta">
        {profile && (
          <span class="chip" style={{ '--dot': profile.color }}>
            {profile.name}
          </span>
        )}
        {where && <span>{where}</span>}
        {s.origin !== 'desktop' && <span>{ORIGIN[s.origin]}</span>}
      </div>
      {s.lastMessage && (
        <p class="snippet">
          {s.lastMessage.role === 'user' && <span class="you">You: </span>}
          {s.lastMessage.text}
        </p>
      )}
    </a>
  );
}

function ProfileGroup({ p, sessions, now }: { p: HubProfile; sessions: SessionSummary[]; now: number }) {
  const [open, setOpen] = useState(false);
  const w = tightest(p);
  const shown = open ? sessions : sessions.slice(0, SESSIONS_SHOWN);
  const running = p.app === 'running' || p.app === 'background';
  return (
    <section class="profile" style={{ '--dot': p.color }}>
      <header class="profile-head">
        <span class="swatch" />
        <div class="profile-id">
          <div class="profile-name">
            {p.name} <span class="vendor">{VENDOR[p.vendor]}</span>
          </div>
          <div class="profile-account">{p.email ?? 'Not signed in'}</div>
        </div>
        <span class={`state ${running ? 'on' : ''}`}>{APP_STATE[p.app ?? 'off'] ?? 'Off'}</span>
      </header>
      {w && w.pct !== null && (
        <div class="limit">
          <div class="bar">
            <span class={`fill ${level(w.pct)}`} style={{ width: `${Math.min(100, w.pct)}%` }} />
          </div>
          <div class="limit-text">
            <span>
              {w.label} {Math.round(w.pct)}% used
            </span>
            <span>{until(w.resetsAt, now)}</span>
          </div>
        </div>
      )}
      {shown.length ? (
        <div class="sessions">
          {shown.map((s) => (
            <SessionRow key={s.id} s={s} now={now} />
          ))}
        </div>
      ) : (
        <p class="empty">No sessions this week.</p>
      )}
      {sessions.length > SESSIONS_SHOWN && (
        <button class="more" onClick={() => setOpen(!open)}>
          {open ? 'Show fewer' : `Show ${sessions.length - SESSIONS_SHOWN} more`}
        </button>
      )}
    </section>
  );
}

function Home({ overview, link }: { overview: Overview | null; link: Link }) {
  const now = useNow();
  const [all, setAll] = useState(storage(FILTER_KEY) === 'all');
  if (!overview) return <Status link={link} />;
  const visible = overview.sessions.filter((s) => all || s.origin === 'desktop');
  const working = visible.filter((s) => s.state === 'working');
  const byId = new Map(overview.profiles.map((p) => [p.id, p]));
  return (
    <main>
      <header class="top">
        <div>
          <h1>{overview.host}</h1>
          <span class={`link ${link}`}>{link === 'live' ? 'Live' : 'Reconnecting…'}</span>
        </div>
        <div class="segmented" role="group" aria-label="Which sessions">
          <button
            aria-pressed={!all}
            onClick={() => {
              setAll(false);
              store(FILTER_KEY, null);
            }}
          >
            Desktop
          </button>
          <button
            aria-pressed={all}
            onClick={() => {
              setAll(true);
              store(FILTER_KEY, 'all');
            }}
          >
            All
          </button>
        </div>
      </header>
      <section class="working">
        <h2>Working now</h2>
        {working.length ? (
          working.map((s) => <SessionRow key={s.id} s={s} now={now} profile={byId.get(s.profileId)} />)
        ) : (
          <p class="empty">Nothing is running. Sessions show up here while an agent works.</p>
        )}
      </section>
      {overview.profiles.map((p) => (
        <ProfileGroup key={p.id} p={p} sessions={visible.filter((s) => s.profileId === p.id)} now={now} />
      ))}
    </main>
  );
}

function Status({ link }: { link: Link }) {
  return (
    <main class="status">
      <p>{link === 'retrying' ? "Can't reach your Mac. Retrying…" : 'Connecting to your Mac…'}</p>
      {link === 'retrying' && <p class="hint">Check that Tailscale is on and Switchboard is running.</p>}
    </main>
  );
}

// Interim rendering of the shared model; the direction-A screens replace it.
function Entry({ e }: { e: TranscriptEntry }) {
  switch (e.kind) {
    case 'message':
      return <div class={`bubble ${e.role}`}>{e.queued ? `Queued: ${e.text}` : e.text}</div>;
    case 'steps':
      return (
        <>
          {e.calls.map((c) => (
            <div key={c.id} class={`tool ${c.failed ? 'failed' : ''}`}>
              <span class="tool-name">{c.service ? `${c.service} · ${c.name}` : c.name}</span>
              <span class="tool-detail">{c.detail}</span>
            </div>
          ))}
        </>
      );
    case 'notice':
      return <div class="tool">{e.text}</div>;
    case 'question':
      return <div class="bubble assistant">{e.questions.map((q) => q.text).join('\n')}</div>;
    case 'subagent':
      return (
        <div class="tool">
          <span class="tool-name">Subagent</span>
          <span class="tool-detail">{e.title}</span>
        </div>
      );
    case 'pr':
      return (
        <div class="tool">
          <span class="tool-name">PR</span>
          <span class="tool-detail">
            {e.repo} #{e.number}
          </span>
        </div>
      );
    case 'artifact':
      return (
        <div class="tool">
          <span class="tool-name">Artifact</span>
          <span class="tool-detail">{e.title}</span>
        </div>
      );
    case 'review':
      return <div class="bubble assistant">{`${e.verdict}: ${e.summary}`}</div>;
    default:
      return null;
  }
}

function SessionView({
  profile,
  id,
  overview,
  onUnpaired,
}: {
  profile: string;
  id: string;
  overview: Overview | null;
  onUnpaired: () => void;
}) {
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  const summary = overview?.sessions.find((s) => s.profileId === profile && s.id === id);
  const working = (summary ?? transcript?.session)?.state === 'working';
  // Re-read on every change the overview reports, and every few seconds while working.
  const tick = summary?.updatedAt;

  useEffect(() => {
    let stopped = false;
    const load = () =>
      api.session
        .query({ profileId: profile, sessionId: id })
        .then((t: Transcript) => !stopped && (setTranscript(t), setError(null)))
        .catch((err) => {
          if (isUnpaired(err)) onUnpaired();
          else if (!stopped) setError("Couldn't load this session.");
        });
    void load();
    const t = working ? setInterval(load, 4000) : null;
    return () => {
      stopped = true;
      if (t) clearInterval(t);
    };
  }, [profile, id, working, tick]);

  useEffect(() => {
    if (transcript && first.current) {
      first.current = false;
      bottom.current?.scrollIntoView();
    }
  }, [transcript]);

  const p = overview?.profiles.find((x) => x.id === profile);
  const s = summary ?? transcript?.session;
  return (
    <main class="detail">
      <header class="detail-head">
        <a class="back" href="#/">
          ‹ All sessions
        </a>
        <h1>{s?.title ?? 'Session'}</h1>
        <div class="session-meta">
          {p && (
            <span class="chip" style={{ '--dot': p.color }}>
              {p.name} · {VENDOR[p.vendor]}
            </span>
          )}
          {s && project(s.cwd) && <span>{project(s.cwd)}</span>}
          {s && (
            <span class={s.state === 'working' ? 'working-label' : ''}>
              {s.state === 'working' ? 'Working' : 'Idle'}
            </span>
          )}
        </div>
      </header>
      {error && <p class="error">{error}</p>}
      {!transcript && !error && <p class="empty">Loading…</p>}
      {transcript && (
        <div class="transcript">
          {transcript.entries.length ? (
            transcript.entries.map((e, i) => <Entry key={i} e={e} />)
          ) : (
            <p class="empty">No messages yet.</p>
          )}
          {working && <div class="typing">Working…</div>}
        </div>
      )}
      <div ref={bottom} />
    </main>
  );
}

function App() {
  // null while asking the hub whether this phone is paired.
  const [paired, setPaired] = useState<boolean | null>(null);
  const route = useRoute();
  useEffect(() => {
    api.me
      .query()
      .then(() => setPaired(true))
      .catch((err) => setPaired(isUnpaired(err) ? false : true));
  }, []);
  const unpair = useMemo(() => () => setPaired(false), []);
  if (paired === null) return <Status link="connecting" />;
  if (!paired) return <Pair onPaired={() => setPaired(true)} />;
  return <Paired route={route} onUnpaired={unpair} />;
}

function Paired({ route, onUnpaired }: { route: Route; onUnpaired: () => void }) {
  const { overview, link } = useOverview(onUnpaired);
  return route.name === 'session' ? (
    <SessionView profile={route.profile} id={route.id} overview={overview} onUnpaired={onUnpaired} />
  ) : (
    <Home overview={overview} link={link} />
  );
}

if ('serviceWorker' in navigator) void navigator.serviceWorker.register('sw.js').catch(() => {});
render(<App />, document.getElementById('app') as HTMLElement);
