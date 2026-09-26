// The Usage tab: what the accounts' windows and agent sessions have used, in
// three views. Overview answers "which account next, and where did it go";
// Tokens breaks the tokens and their API-equivalent value down; Sessions
// groups sessions by the window they counted against, with an inspector for
// one. Everything comes from one report the main process builds (see
// src/history/report.ts), fetched when the range changes, when the main
// process says there is something new, and once a minute.

import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import {
  act,
  clock,
  count,
  dayWord,
  duration,
  money,
  profileColor,
  profileName,
  relTime,
  severityClass,
  type State,
  type TokenCounts,
  type UsageBlock,
  type UsageReport,
  type UsageSession,
  type WindowPace,
} from './lib';
import { Badge, Btn, Icon, Note, Panel, Seg, Skeleton } from './ui/primitives';
import { useTip } from './ui/overlays';

type View = 'overview' | 'tokens' | 'sessions';
type Days = '7' | '30' | '90';

export function Usage({ state, version }: { state: State; version: number }) {
  const [view, setView] = useState<View>('overview');
  const [days, setDays] = useState<Days>('30');
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    const load = () =>
      window.sb.usageReport(Number(days)).then(
        (r) => {
          if (!current) return;
          setReport(r);
          setError(null);
        },
        (e: Error) => current && setError(e.message || String(e)),
      );
    void load();
    const tick = setInterval(load, 60_000);
    return () => {
      current = false;
      clearInterval(tick);
    };
  }, [days, version]);

  return (
    <>
      <div class="toolbar">
        <Seg
          label="Usage view"
          value={view}
          onChange={setView}
          options={[
            { id: 'overview', label: 'Overview' },
            { id: 'tokens', label: 'Tokens' },
            { id: 'sessions', label: 'Sessions' },
          ]}
        />
        <Seg
          label="Range"
          value={days}
          onChange={setDays}
          options={[
            { id: '7', label: '7 days' },
            { id: '30', label: '30 days' },
            { id: '90', label: '90 days' },
          ]}
        />
      </div>
      {error ? <Note tone="warn">Couldn't read the usage history: {error}</Note> : null}
      {!report ? (
        <Loading />
      ) : view === 'overview' ? (
        <Overview state={state} report={report} />
      ) : view === 'tokens' ? (
        <Tokens state={state} report={report} />
      ) : (
        <Sessions state={state} report={report} />
      )}
    </>
  );
}

function Loading() {
  return (
    <div class="usage-loading">
      <Skeleton width={220} />
      <Skeleton width={320} />
    </div>
  );
}

// ---------------------------------------------------------------- shared

const known = (state: State, id: string) => state.profiles.some((p) => p.id === id);
const fresh = (t: TokenCounts) => t.input + t.output + t.cacheWrite;
const allTokens = (t: TokenCounts) => t.input + t.output + t.cacheRead + t.cacheWrite;

function Swatch({ color }: { color: string }) {
  return <span class="swatch" style={{ background: color }} />;
}

function Who({ state, id }: { state: State; id: string }) {
  return (
    <span class="who-inline">
      <Swatch color={profileColor(state, id)} />
      {profileName(state, id)}
    </span>
  );
}

function Tile({
  k,
  v,
  sub,
  delta,
}: {
  k: string;
  v: string;
  sub: ComponentChildren;
  delta?: { text: string; tone: 'good' | 'bad' | 'neutral' } | null;
}) {
  return (
    <div class="tile">
      <span class="k">{k}</span>
      <span class="v-row">
        <span class="v">{v}</span>
        {delta ? <span class={`delta ${delta.tone}`}>{delta.text}</span> : null}
      </span>
      <span class="s">{sub}</span>
    </div>
  );
}

// The change on the previous period, as a percentage.
function change(cur: number, prev: number | undefined, tone: 'neutral' | 'lower-is-better' = 'neutral') {
  if (prev === undefined || prev <= 0) return null;
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (!pct) return { text: 'same', tone: 'neutral' as const };
  const good = tone === 'lower-is-better' ? pct < 0 : null;
  return {
    text: `${pct > 0 ? '+' : '−'}${Math.abs(pct)}%`,
    tone: good === null ? 'neutral' : good ? 'good' : 'bad',
  } as const;
}

// A row of the ranked lists: a name, a bar sized against the largest, the value.
function Ranked({
  rows,
}: {
  rows: { key: string; name: ComponentChildren; share: number; value: string; extra?: string }[];
}) {
  if (!rows.length) return <Note class="pad">Nothing in this range.</Note>;
  const max = Math.max(...rows.map((r) => r.share), 0) || 1;
  return (
    <div class="ranked">
      {rows.map((r) => (
        <div class="ranked-row" key={r.key}>
          <span class="name">{r.name}</span>
          <span class="meter">
            <span style={{ width: `${(r.share / max) * 100}%` }} />
          </span>
          {r.extra !== undefined ? <span class="extra">{r.extra}</span> : null}
          <span class="num">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

function Provenance({ report }: { report: UsageReport }) {
  return (
    <Note class="provenance">
      Dollar values are what these tokens would cost at API prices (as of {report.pricesAsOf}), read from the logs
      Claude Code and Codex keep in each profile
      {report.recordedSince ? `, recorded since ${dayWord(report.recordedSince)}` : ''}. Chats in the desktop apps and
      on the web count toward the windows but leave no token log.
    </Note>
  );
}

// ---------------------------------------------------------------- overview

function Overview({ state, report }: { state: State; report: UsageReport }) {
  const t = report.totals;
  const p = report.previous;
  const empty = !t.sessions && !report.accounts.some((a) => a.tightest);
  return (
    <>
      <Forecast state={state} report={report} />
      <div class="acct-grid">
        {report.accounts
          .filter((a) => known(state, a.profile))
          .map((a) => (
            <AccountCard key={a.profile} state={state} id={a.profile} t={a.tightest} />
          ))}
      </div>
      {empty ? (
        <div class="empty">
          No agent sessions in this range yet. Switchboard reads the logs Claude Code and Codex keep in each profile,
          and records every usage reading from now on.
        </div>
      ) : null}
      <div class="tiles">
        <Tile
          k="API-equivalent value"
          v={money(t.value)}
          sub={
            t.unpricedTokens
              ? `${count(t.unpricedTokens)} tokens of unpriced models`
              : 'what these tokens cost on the API'
          }
          delta={change(t.value, p?.value)}
        />
        <Tile
          k="Agent hours"
          v={duration(t.agentMs)}
          sub={`${t.sessions} sessions in ${t.projects} projects`}
          delta={change(t.agentMs, p?.agentMs)}
        />
        <Tile
          k="Limit hits"
          v={String(t.limitHits)}
          sub={t.limitHits ? `waited ${duration(t.waitedMs)} in total` : 'no window ran out'}
          delta={p && (t.limitHits || p.limitHits) ? limitChange(t.limitHits, p.limitHits) : null}
        />
      </div>
      <Panel title="Value per day, by account" actions={<Legend state={state} ids={activeIds(report)} />}>
        <DailyBars state={state} report={report} />
      </Panel>
      <div class="usage-cols">
        <WhereItWent state={state} report={report} />
        <Panel
          title="Every day with agent work"
          meta={report.recordedSince ? `since ${dayWord(report.recordedSince)}` : null}
        >
          <Heat report={report} />
        </Panel>
      </div>
      <Provenance report={report} />
    </>
  );
}

function limitChange(cur: number, prev: number) {
  const d = cur - prev;
  if (!d) return { text: 'same', tone: 'neutral' as const };
  return { text: `${d > 0 ? '+' : '−'}${Math.abs(d)}`, tone: d > 0 ? ('bad' as const) : ('good' as const) };
}

const activeIds = (report: UsageReport): string[] => {
  const ids = new Set<string>();
  for (const d of report.daily) for (const [id, v] of Object.entries(d.value)) if (v > 0) ids.add(id);
  return [...ids];
};

function Legend({ state, ids }: { state: State; ids: string[] }) {
  const ordered = state.profiles.filter((p) => ids.includes(p.id));
  return (
    <span class="legend">
      {ordered.map((p) => (
        <span key={p.id}>
          <Swatch color={p.color} />
          {profileName(state, p.id)}
        </span>
      ))}
    </span>
  );
}

// The warning when a window will run out before it resets.
function Forecast({ state, report }: { state: State; report: UsageReport }) {
  const f = report.forecast;
  const key = f ? `${f.profile}|${f.label}|${f.resetsAt}` : '';
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!f || dismissed === key || !known(state, f.profile)) return null;
  const early = Date.parse(f.resetsAt) - Date.parse(f.fullAt);
  const gap = early >= 3_600_000 ? 'over an hour' : `${Math.round(early / 60_000)} minutes`;
  const alt = f.alternative && known(state, f.alternative.profile) ? f.alternative : null;
  const altName = alt ? state.profiles.find((p) => p.id === alt.profile)?.name : null;
  return (
    <div class="forecast" role="status">
      <PctRing pct={f.pct} />
      <div class="forecast-text">
        <b>
          {profileName(state, f.profile)} will fill its {f.label} window at about {clock(f.fullAt)}, {gap} before it
          resets at {clock(f.resetsAt)}.
        </b>
        <span>
          {paceWords(f.pace)}
          {paceWords(f.pace) ? ', and ' : ''}
          {Math.round(f.ratePerHour)}% an hour lately.
          {alt ? ` ${profileName(state, alt.profile)} has ${100 - alt.pct}% of its ${alt.label} window left.` : ''}
        </span>
      </div>
      <div class="forecast-actions">
        {alt ? (
          <Btn variant="primary" onClick={(e) => act(() => window.sb.shell(alt.profile), e.currentTarget)}>
            Open a terminal in {altName}
          </Btn>
        ) : null}
        <Btn onClick={() => setDismissed(key)}>Dismiss</Btn>
      </div>
    </div>
  );
}

function paceWords(pace: number | null): string {
  if (pace === null || Math.abs(pace) < 3) return pace === null ? '' : 'On an even pace';
  return pace > 0 ? `${pace} points ahead of an even pace` : `${-pace} points behind an even pace`;
}

function PctRing({ pct }: { pct: number }) {
  const r = 22;
  const c = 2 * Math.PI * r;
  return (
    <svg class="pct-ring" viewBox="0 0 54 54" aria-hidden="true">
      <circle cx="27" cy="27" r={r} class="ring-track" />
      <circle
        cx="27"
        cy="27"
        r={r}
        class="ring-value"
        stroke-dasharray={`${((c * pct) / 100).toFixed(1)} ${c.toFixed(1)}`}
        transform="rotate(-90 27 27)"
      />
      <text x="27" y="31" text-anchor="middle">
        {pct}%
      </text>
    </svg>
  );
}

// An account's fullest window, with a tick where an even pace would be.
function AccountCard({ state, id, t }: { state: State; id: string; t: WindowPace | null }) {
  const p = state.profiles.find((x) => x.id === id);
  const plan = p?.usage?.plan || p?.identity?.plan;
  const remaining = state.settings.usageMode === 'remaining';
  const shown = (pct: number) => (remaining ? 100 - pct : pct);
  const tip = useTip(
    t && t.pace !== null
      ? [`${paceWords(t.pace)}`, `The tick is where an even burn across the ${t.label} window would be now.`]
      : null,
  );
  return (
    <div class="acct-card">
      <div class="ac-head">
        <Swatch color={profileColor(state, id)} />
        <b>{profileName(state, id)}</b>
        {plan ? <Badge>{plan}</Badge> : null}
      </div>
      {t ? (
        <>
          <div class="ac-row">
            <span>
              {t.label} window{remaining ? ', left' : ''}
            </span>
            <b>{shown(t.pct)}%</b>
          </div>
          <div class="ac-track" {...tip}>
            <div
              class={`fill ${severityClass({ label: t.label, pct: t.pct, resetsAt: t.resetsAt })}`}
              style={{ width: `${shown(t.pct)}%` }}
            />
            {t.pace !== null ? <span class="tick" style={{ left: `${shown(t.pct - t.pace)}%` }} /> : null}
          </div>
          <div class="ac-foot">
            <span>{relTime(t.resetsAt)}</span>
            <PaceChip pace={t.pace} />
          </div>
        </>
      ) : (
        <Note>No usage reading yet.</Note>
      )}
    </div>
  );
}

function PaceChip({ pace }: { pace: number | null }) {
  if (pace === null) return null;
  if (pace >= 5) return <Badge tone="warn">{pace} ahead</Badge>;
  if (pace <= -5) return <Badge tone="ok">In reserve</Badge>;
  return <Badge tone="mute">On pace</Badge>;
}

// A scale's dollars, without cents on round numbers.
const axisMoney = (v: number) => money(v).replace(/\.00$/, '');

// A tidy upper bound for a chart's scale.
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const step = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * step).find((m) => m >= v) ?? v;
}

function DailyBars({ state, report }: { state: State; report: UsageReport }) {
  const order = state.profiles.map((p) => p.id);
  const totals = report.daily.map((d) => Object.values(d.value).reduce((a, b) => a + b, 0));
  const max = niceMax(Math.max(...totals, 0));
  const every = Math.ceil(report.daily.length / 6);
  return (
    <div class="dbars">
      <div class="dbars-plot">
        {[0, 0.5, 1].map((f) => (
          <div class="gl" key={f} style={{ bottom: `${f * 100}%` }}>
            <span>{axisMoney(max * f)}</span>
          </div>
        ))}
        <div class="dbars-cols" style={{ gridTemplateColumns: `repeat(${report.daily.length}, minmax(0, 1fr))` }}>
          {report.daily.map((d, i) => (
            <DayColumn
              key={d.day}
              state={state}
              day={d.day}
              values={d.value}
              order={order}
              max={max}
              total={totals[i]}
            />
          ))}
        </div>
      </div>
      <div class="dbars-x" style={{ gridTemplateColumns: `repeat(${report.daily.length}, minmax(0, 1fr))` }}>
        {report.daily.map((d, i) => (
          <span key={d.day}>{(report.daily.length - 1 - i) % every === 0 ? shortDay(d.day) : ''}</span>
        ))}
      </div>
    </div>
  );
}

const shortDay = (day: string) =>
  new Date(`${day}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

function DayColumn({
  state,
  day,
  values,
  order,
  max,
  total,
}: {
  state: State;
  day: string;
  values: Record<string, number>;
  order: string[];
  max: number;
  total: number;
}) {
  const ids = order.filter((id) => (values[id] ?? 0) > 0);
  const tip = useTip([
    `${dayWord(`${day}T12:00:00`)} · ${money(total)}`,
    ...ids.map((id) => `${profileName(state, id)}: ${money(values[id])}`),
  ]);
  return (
    <div class="dcol" tabIndex={0} aria-label={`${day}: ${money(total)}`} {...tip}>
      {ids.map((id) => (
        <span key={id} style={{ height: `${(values[id] / max) * 100}%`, background: profileColor(state, id) }} />
      ))}
    </div>
  );
}

function WhereItWent({ state, report }: { state: State; report: UsageReport }) {
  const [by, setBy] = useState<'projects' | 'models'>('projects');
  const rows =
    by === 'projects'
      ? report.projects.slice(0, 5).map((p) => ({
          key: p.name,
          name: (
            <>
              {p.profiles.map((id) => (
                <Swatch key={id} color={profileColor(state, id)} />
              ))}
              <code>{p.name}</code>
            </>
          ),
          share: p.value || p.agentMs,
          value: p.value ? money(p.value) : duration(p.agentMs),
        }))
      : report.models.slice(0, 5).map((m) => ({
          key: m.model,
          name: <code>{m.model}</code>,
          share: m.value ?? 0,
          value: m.value === null ? `${count(m.tokens)} tokens` : money(m.value),
        }));
  return (
    <Panel
      title="Where it went"
      actions={
        <Seg
          label="Show"
          value={by}
          onChange={setBy}
          options={[
            { id: 'projects', label: 'Projects' },
            { id: 'models', label: 'Models' },
          ]}
        />
      }
    >
      <Ranked rows={rows} />
    </Panel>
  );
}

// 26 weeks of days, Monday at the top; days before recording began are
// drawn as not recorded rather than as idle.
function Heat({ report }: { report: UsageReport }) {
  const days = report.heat;
  const max = Math.max(...days.map((d) => d.agentMs ?? 0), 1);
  const lead = (new Date(`${days[0]?.day ?? '2000-01-03'}T12:00:00`).getDay() + 6) % 7;
  const level = (ms: number | null) =>
    ms === null ? 'n' : ms === 0 ? '0' : String(1 + Math.min(4, Math.floor((ms / max) * 5)));
  return (
    <div class="heat-wrap">
      <div class="heat" role="img" aria-label="Agent work per day, 26 weeks">
        {Array.from({ length: lead }, (_, i) => (
          <span key={`pad${i}`} class="cell pad" />
        ))}
        {days.map((d) => (
          <HeatCell key={d.day} day={d.day} ms={d.agentMs} level={level(d.agentMs)} />
        ))}
      </div>
      <div class="heat-legend">
        Less
        {['0', '1', '2', '3', '4', '5'].map((l) => (
          <span key={l} class={`cell l${l}`} />
        ))}
        More
        <span class="cell ln" />
        Not recorded
      </div>
    </div>
  );
}

function HeatCell({ day, ms, level }: { day: string; ms: number | null; level: string }) {
  const tip = useTip([
    dayWord(`${day}T12:00:00`),
    ms === null ? 'Not recorded' : ms ? `${duration(ms)} of agent work` : 'No agent work',
  ]);
  return <span class={`cell l${level}`} {...tip} />;
}

// ---------------------------------------------------------------- tokens

const KINDS: Record<keyof TokenCounts, string> = {
  cacheRead: 'Cache reads',
  cacheWrite: 'Cache writes',
  output: 'Output, with reasoning',
  input: 'Uncached input',
};

function Tokens({ state, report }: { state: State; report: UsageReport }) {
  const t = report.totals;
  const p = report.previous;
  const tokens = allTokens(t.tokens);
  const hit = tokens
    ? Math.round((t.tokens.cacheRead / (t.tokens.input + t.tokens.cacheRead + t.tokens.cacheWrite || 1)) * 100)
    : null;
  const byVendor = (vendor: string) =>
    report.accounts
      .filter((a) => state.profiles.find((x) => x.id === a.profile)?.vendor === vendor)
      .reduce((s, a) => s + a.value, 0);
  const mix = [...report.mix].sort((a, b) => b.tokens - a.tokens);
  const reads = report.mix.find((m) => m.kind === 'cacheRead');
  const readLine =
    reads && tokens && t.value
      ? `cache reads are ${Math.round((reads.tokens / tokens) * 100)}% of tokens but ${Math.round((reads.value / t.value) * 100)}% of value`
      : null;
  const accounts = report.accounts.filter((a) => known(state, a.profile) && (a.value || allTokens(a.tokens)));
  const maxAcct = Math.max(...accounts.map((a) => a.value), 0);
  const scale = niceMax(Math.max(...report.daily.flatMap((d) => Object.values(d.value)), 0));
  return (
    <>
      <div class="tiles four">
        <Tile
          k="Tokens"
          v={count(tokens)}
          sub="input, output and cache"
          delta={change(tokens, p ? allTokens(p.tokens) : undefined)}
        />
        <Tile
          k="Fresh tokens"
          v={count(fresh(t.tokens))}
          sub="without cache reads"
          delta={change(fresh(t.tokens), p ? fresh(p.tokens) : undefined)}
        />
        <Tile k="Cache hit" v={hit === null ? '—' : `${hit}%`} sub="of input served from cache" />
        <Tile
          k="API-equivalent value"
          v={money(t.value)}
          sub={`Claude ${money(byVendor('claude'))} · Codex ${money(byVendor('codex'))}`}
          delta={change(t.value, p?.value)}
        />
      </div>
      <div class="usage-cols wide-first">
        <Panel title="Token mix" meta={readLine}>
          <table class="mix">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Share of tokens</th>
                <th class="num">Tokens</th>
                <th>Share of value</th>
                <th class="num">Value</th>
              </tr>
            </thead>
            <tbody>
              {mix.map((m) => (
                <tr key={m.kind}>
                  <td>{KINDS[m.kind]}</td>
                  <td>
                    <span class="meter">
                      <span style={{ width: `${tokens ? (m.tokens / tokens) * 100 : 0}%` }} />
                    </span>
                  </td>
                  <td class="num">{count(m.tokens)}</td>
                  <td>
                    <span class="meter quiet">
                      <span style={{ width: `${t.value ? (m.value / t.value) * 100 : 0}%` }} />
                    </span>
                  </td>
                  <td class="num">{money(m.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title="Cache hit by account" meta="higher is cheaper">
          <Ranked
            rows={report.cacheHit
              .filter((c) => c.pct !== null && known(state, c.profile))
              .map((c) => ({
                key: c.profile,
                name: <Who state={state} id={c.profile} />,
                share: c.pct ?? 0,
                value: `${c.pct}%`,
              }))}
          />
        </Panel>
      </div>
      <Panel title="Value by account" meta={`last ${report.days} days`}>
        {accounts.length ? (
          <div class="acct-values">
            {accounts.map((a) => (
              <div class="acct-value" key={a.profile}>
                <Who state={state} id={a.profile} />
                <span class="meter solid">
                  <span
                    style={{
                      width: `${maxAcct ? (a.value / maxAcct) * 100 : 0}%`,
                      background: profileColor(state, a.profile),
                    }}
                  />
                </span>
                <span class="num">
                  {money(a.value)} <span class="muted">· {count(allTokens(a.tokens))} tokens</span>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <Note class="pad">Nothing in this range.</Note>
        )}
      </Panel>
      <Panel title="Daily value per account" meta={`same scale, $0 – ${axisMoney(scale)}`}>
        <div class="multiples">
          {accounts.map((a) => (
            <div class="multiple" key={a.profile}>
              <span class="multiple-head">
                <Who state={state} id={a.profile} />
                <span class="muted">{money(a.value)}</span>
              </span>
              <Spark
                values={report.daily.map((d) => d.value[a.profile] ?? 0)}
                max={scale}
                color={profileColor(state, a.profile)}
              />
            </div>
          ))}
        </div>
      </Panel>
      <Provenance report={report} />
    </>
  );
}

function Spark({ values, max, color }: { values: number[]; max: number; color: string }) {
  const W = 240;
  const H = 56;
  const x = (i: number) => 1 + (i / Math.max(1, values.length - 1)) * (W - 6);
  const y = (v: number) => H - 2 - (v / (max || 1)) * (H - 6);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  return (
    <svg class="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ color }} aria-hidden="true">
      <line x1="0" x2={W} y1={H - 2} y2={H - 2} class="axis" />
      <path d={`${d}L${x(values.length - 1)},${H - 2}L${x(0)},${H - 2}Z`} class="area" />
      <path d={d} class="line" />
    </svg>
  );
}

// ---------------------------------------------------------------- sessions

function Sessions({ state, report }: { state: State; report: UsageReport }) {
  const [account, setAccount] = useState('all');
  const [onlyHits, setOnlyHits] = useState<'all' | 'hits'>('all');
  const [picked, setPicked] = useState<string | null>(null);
  // Ten windows at a time: a month of them is a long page.
  const [limit, setLimit] = useState(10);
  const owners = [...new Set(report.blocks.map((b) => b.profile))].filter((id) => known(state, id));
  const matching = report.blocks.filter(
    (b) => known(state, b.profile) && (account === 'all' || b.profile === account) && (onlyHits === 'all' || b.hitAt),
  );
  const blocks = matching.slice(0, limit);
  const all = blocks.flatMap((b) => b.sessions.map((s) => ({ s, b })));
  const chosen = all.find((x) => `${x.b.profile}/${x.s.id}` === picked) ?? all[0] ?? null;
  const key = (b: UsageBlock, s: UsageSession) => `${b.profile}/${s.id}`;
  return (
    <>
      <div class="toolbar">
        <Seg
          label="Windows"
          value={onlyHits}
          onChange={(v) => {
            setOnlyHits(v);
            setLimit(10);
          }}
          options={[
            { id: 'all', label: 'All windows' },
            { id: 'hits', label: 'Only limit hits' },
          ]}
        />
        <select
          class="plain-select"
          aria-label="Account"
          value={account}
          onChange={(e) => {
            setAccount((e.currentTarget as HTMLSelectElement).value);
            setLimit(10);
          }}
        >
          <option value="all">All accounts</option>
          {owners.map((id) => (
            <option value={id} key={id}>
              {profileName(state, id)}
            </option>
          ))}
        </select>
      </div>
      {!blocks.length ? (
        <div class="empty">
          {onlyHits === 'hits' ? 'No window ran out in this range.' : 'No agent sessions in this range yet.'}
        </div>
      ) : (
        <div class="sessions-layout">
          <div class="blocks">
            {blocks.map((b) => (
              <Block
                key={`${b.profile}-${b.start}-${b.label}`}
                state={state}
                block={b}
                picked={chosen ? key(chosen.b, chosen.s) : null}
                onPick={(s) => setPicked(key(b, s))}
                inline={
                  chosen && chosen.b === b ? <Inspector state={state} report={report} block={b} s={chosen.s} /> : null
                }
              />
            ))}
            {matching.length > blocks.length ? (
              <Btn class="more-windows" onClick={() => setLimit(limit + 10)}>
                Show more windows ({matching.length - blocks.length})
              </Btn>
            ) : null}
          </div>
          {chosen ? (
            <div class="inspector-side">
              <Inspector state={state} report={report} block={chosen.b} s={chosen.s} />
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}

function blockTitle(b: UsageBlock): string {
  if (b.kind === 'day') return dayWord(`${b.label}T12:00:00`);
  return `${dayWord(b.start)} ${clock(b.start)} – ${clock(b.end)}`;
}

function Block({
  state,
  block: b,
  picked,
  onPick,
  inline,
}: {
  state: State;
  block: UsageBlock;
  picked: string | null;
  onPick: (s: UsageSession) => void;
  inline: ComponentChildren;
}) {
  return (
    <section class="block">
      <div class="block-head">
        <Swatch color={profileColor(state, b.profile)} />
        <b>{blockTitle(b)}</b>
        {b.current ? <Badge tone="ok">Current window</Badge> : null}
        {b.hitAt ? (
          <span class="hit">
            Hit the limit at {clock(b.hitAt)} · waited {duration(b.waitedMs)}
          </span>
        ) : null}
        <span class="peak">
          {b.peak !== null ? (
            <>
              Peak
              <span class="meter tiny">
                <span
                  class={severityClass({ label: b.label, pct: b.peak, resetsAt: null }) || 'ok'}
                  style={{ width: `${b.peak}%` }}
                />
              </span>
              {b.peak}% ·{' '}
            </>
          ) : null}
          {money(b.value)}
        </span>
      </div>
      {b.sessions.map((s) => {
        const on = picked === `${b.profile}/${s.id}`;
        return (
          <div key={s.id}>
            <button type="button" class={`session-row ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => onPick(s)}>
              <span class="title">
                <b>{s.title}</b>
                <span class="sub">
                  {s.project ? <code>{s.project}</code> : null}
                  <span class="via">{ENTRY[s.entry]}</span>
                </span>
              </span>
              <code class="model">{s.model ?? '—'}</code>
              <span class="num">{duration(s.agentMs)}</span>
              <span class="num">{count(allTokens(s.tokens))}</span>
              <span class="num">{money(s.value)}</span>
              <Icon name="right" size={14} />
            </button>
            {on ? <div class="inspector-inline">{inline}</div> : null}
          </div>
        );
      })}
    </section>
  );
}

const ENTRY: Record<UsageSession['entry'], string> = { cli: 'CLI', desktop: 'Desktop', sdk: 'Script', other: 'Other' };

function Inspector({
  state,
  report,
  block: b,
  s,
}: {
  state: State;
  report: UsageReport;
  block: UsageBlock;
  s: UsageSession;
}) {
  const others = b.sessions.filter((x) => x.id !== s.id && x.share);
  const used = b.sessions.reduce((a, x) => a + (x.share ?? 0), 0);
  const f = report.forecast;
  const forecast = b.current && f && f.profile === b.profile && f.label === b.label ? f : null;
  return (
    <section class="inspector" aria-label={`Session: ${s.title}`}>
      <div class="insp-head">
        <span class="insp-who">
          <Who state={state} id={s.profile} />
          <span class="via">{ENTRY[s.entry]}</span>
        </span>
        <h3>{s.title}</h3>
        <span class="insp-meta">
          {s.project ? <code>{s.project}</code> : null} {dayWord(s.start)} {clock(s.start)} – {clock(s.end)} ·{' '}
          {s.prompts} {s.prompts === 1 ? 'prompt' : 'prompts'}
        </span>
        <div class="insp-actions">
          <Btn
            variant="primary"
            icon="terminal"
            onClick={(e) => act(() => window.sb.resumeSession(s.profile, s.id), e.currentTarget)}
          >
            Resume in terminal
          </Btn>
          <Btn onClick={(e) => act(() => window.sb.openSession(s.profile, s.id, 'folder'), e.currentTarget)}>
            Open folder
          </Btn>
          <Btn onClick={(e) => act(() => window.sb.openSession(s.profile, s.id, 'transcript'), e.currentTarget)}>
            Show transcript
          </Btn>
        </div>
      </div>
      {b.kind === 'window' && s.share !== null ? (
        <div class="insp-sec">
          <span class="sec-title">Its share of the window</span>
          <span class="sec-meta">
            {blockTitle(b)} · {b.peak}% used
          </span>
          <div class="share-bar">
            <span class="this" style={{ width: `${s.share}%` }} />
            {others.map((o) => (
              <span class="other" key={o.id} style={{ width: `${o.share}%` }} />
            ))}
            <span class="free" />
          </div>
          <div class="share-rows">
            <span>
              <i class="this" />
              <b>This session</b>
              <span class="num">{s.share}%</span>
            </span>
            {others.map((o) => (
              <span key={o.id}>
                <i class="other" />
                {o.title}
                <span class="num">{o.share}%</span>
              </span>
            ))}
            <span class="muted">
              <i />
              Still free
              <span class="num">{Math.max(0, 100 - used)}%</span>
            </span>
          </div>
        </div>
      ) : null}
      {b.kind === 'window' && b.points.length > 1 ? (
        <div class="insp-sec">
          <span class="sec-title">How the window filled</span>
          <WindowChart block={b} s={s} fullAt={forecast?.fullAt ?? null} />
        </div>
      ) : null}
      <div class="insp-sec">
        <span class="sec-title">Details</span>
        <dl class="facts">
          {(
            [
              ['Model', <code>{s.model ?? '—'}</code>],
              ['Value', money(s.value)],
              ['Tokens', `${count(allTokens(s.tokens))} · ${count(fresh(s.tokens))} fresh`],
              ['Cache hit', s.cacheHit === null ? '—' : `${s.cacheHit}%`],
              ['Agent time', duration(s.agentMs)],
              ['Subagents', s.subagents ? `${s.subagents.calls} calls · ${money(s.subagents.value)}` : 'None'],
            ] as [string, ComponentChildren][]
          ).map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </div>
      {s.tools.length || s.fileCount ? (
        <div class="insp-sec">
          <span class="sec-title">What it did</span>
          <div class="tool-chips">
            {s.tools.map(([name, n]) => (
              <span class="tool-chip" key={name}>
                {name} <b>{n}</b>
              </span>
            ))}
          </div>
          {s.fileCount ? (
            <div class="files">
              <span class="muted">
                Edited {s.fileCount} {s.fileCount === 1 ? 'file' : 'files'}
              </span>
              {s.files.map((f) => (
                <code key={f}>{f}</code>
              ))}
              {s.fileCount > s.files.length ? <span class="muted">and {s.fileCount - s.files.length} more</span> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

// The window's percentage across its span, this session's time shaded, and
// where it is headed if it is on course to run out.
function WindowChart({ block: b, s, fullAt }: { block: UsageBlock; s: UsageSession; fullAt: string | null }) {
  const W = 440;
  const H = 110;
  const L = 32;
  const R = 6;
  const T = 6;
  const B = 18;
  const start = Date.parse(b.start);
  const end = Date.parse(b.end);
  const x = (ms: number) => L + ((Math.min(end, Math.max(start, ms)) - start) / (end - start)) * (W - L - R);
  const y = (pct: number) => T + (1 - pct / 100) * (H - T - B);
  const line = b.points.map(([at, pct], i) => `${i ? 'L' : 'M'}${x(at).toFixed(1)},${y(pct).toFixed(1)}`).join('');
  const last = b.points[b.points.length - 1];
  const hours = Math.round((end - start) / 3_600_000);
  const ticks = [0, 0.5, 1].map((f) => start + f * (end - start));
  return (
    <svg class="wchart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="How the window filled">
      {[0, 50, 100].map((v) => (
        <g key={v}>
          <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} class={v ? 'grid' : 'axis'} />
          <text x={L - 5} y={y(v) + 3.5} text-anchor="end">
            {v}%
          </text>
        </g>
      ))}
      <rect
        x={x(Date.parse(s.start))}
        y={T}
        width={Math.max(2, x(Date.parse(s.end)) - x(Date.parse(s.start)))}
        height={H - T - B}
        class="span"
      />
      <path d={line} class="line" />
      {fullAt && last ? (
        <path d={`M${x(last[0])},${y(last[1])}L${x(Date.parse(fullAt))},${y(100)}`} class="forecast-line" />
      ) : null}
      {last ? <circle cx={x(last[0])} cy={y(last[1])} r="3.2" class="dot" /> : null}
      {ticks.map((t, i) => (
        <text key={t} x={x(t)} y={H - 4} text-anchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}>
          {clock(new Date(t).toISOString())}
        </text>
      ))}
      <title>{`${b.label} window over ${hours} hours`}</title>
    </svg>
  );
}
