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
  planOf,
  profileById,
  profileColor,
  profileName,
  relTime,
  severityClass,
  shortDay,
  shownPct,
  freshTokens,
  tokenSum,
  type State,
  type TokenCounts,
  type UsageBlock,
  type UsageReport,
  type UsageSession,
  type WindowPace,
} from './lib';
import { Badge, Btn, Icon, Meter, Note, Panel, Ring, Seg, Skeleton, Track } from './ui/primitives';
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
        error ? null : (
          <Loading />
        )
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

const known = (state: State, id: string) => !!profileById(state, id);

// The history keeps a removed profile's work, so a day's values can name
// profiles the window no longer has. The charts fold those into one muted
// entry, so a day's bar still adds up to the totals above it.
const REMOVED = '(removed)';
const shownValues = (state: State, values: Record<string, number>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [id, v] of Object.entries(values)) {
    const k = known(state, id) ? id : REMOVED;
    out[k] = (out[k] ?? 0) + v;
  }
  return out;
};
const seriesOrder = (state: State) => [...state.profiles.map((p) => p.id), REMOVED];

function Swatch({ color }: { color: string }) {
  return <span class="key-swatch" style={{ background: color }} />;
}

function Who({ state, id }: { state: State; id: string }) {
  return (
    <span class="who-inline">
      <Swatch color={id === REMOVED ? 'var(--muted)' : profileColor(state, id)} />
      {id === REMOVED ? 'Removed profiles' : profileName(state, id)}
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
    <div class="stat">
      <span class="k">{k}</span>
      <span class="v-row">
        <span class="v">{v}</span>
        {delta ? <span class={`delta ${delta.tone}`}>{delta.text}</span> : null}
      </span>
      <span class="s" title={typeof sub === 'string' ? sub : undefined}>
        {sub}
      </span>
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

// A ranked list: a name, a bar, the value. The bar is sized against `max`
// where the rows have a natural whole (a percentage's 100), else against the
// largest row. `solid` is the taller bar in each row's own colour.
type RankedRow = { key: string; name: ComponentChildren; share: number; value: ComponentChildren; color?: string };
function Ranked({ rows, max, solid = false }: { rows: RankedRow[]; max?: number; solid?: boolean }) {
  if (!rows.length) return <Note>Nothing in this range.</Note>;
  const top = max ?? (Math.max(...rows.map((r) => r.share), 0) || 1);
  return (
    <div class={solid ? 'ranked solid' : 'ranked'}>
      {rows.map((r) => (
        <div class="ranked-row" key={r.key}>
          <span class="name">{r.name}</span>
          <Meter frac={r.share / top} color={r.color} class={solid ? 'solid' : undefined} />
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
      <div class="stats">
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
          delta={
            p && report.previousHasLimits && (t.limitHits || p.limitHits) ? limitChange(t.limitHits, p.limitHits) : null
          }
        />
      </div>
      <Panel title="Value per day, by account" actions={<Legend state={state} ids={activeIds(state, report)} />}>
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

const activeIds = (state: State, report: UsageReport): string[] => {
  const ids = new Set<string>();
  for (const d of report.daily)
    for (const [id, v] of Object.entries(shownValues(state, d.value))) if (v > 0) ids.add(id);
  return [...ids];
};

function Legend({ state, ids }: { state: State; ids: string[] }) {
  return (
    <span class="legend">
      {seriesOrder(state)
        .filter((id) => ids.includes(id))
        .map((id) => (
          <Who key={id} state={state} id={id} />
        ))}
    </span>
  );
}

// The warning dismissed last, kept outside the component so switching views
// or tabs does not bring it back. It stays dismissed until that window
// resets; Codex's reset times drift by seconds between readings.
type Dismissed = { profile: string; label: string; resetsAt: string };
let dismissedForecast: Dismissed | null = null;
const sameWarning = (a: Dismissed | null, b: Dismissed) =>
  !!a &&
  a.profile === b.profile &&
  a.label === b.label &&
  Math.abs(Date.parse(a.resetsAt) - Date.parse(b.resetsAt)) <= 10 * 60_000;

// The warning when a window will run out before it resets.
function Forecast({ state, report }: { state: State; report: UsageReport }) {
  const f = report.forecast;
  const [dismissed, setDismissedState] = useState<Dismissed | null>(dismissedForecast);
  const setDismissed = (d: Dismissed) => setDismissedState((dismissedForecast = d));
  if (!f || sameWarning(dismissed, f) || !known(state, f.profile)) return null;
  const early = Date.parse(f.resetsAt) - Date.parse(f.fullAt);
  const gap = early >= 3_600_000 ? 'over an hour' : `${Math.round(early / 60_000)} minutes`;
  const alt = f.alternative;
  const other = alt ? profileById(state, alt.profile) : undefined;
  const otherName = other ? profileName(state, other.id) : '';
  return (
    <div class="forecast" role="status">
      <Ring pct={f.pct} />
      <div class="forecast-text">
        <b>
          {profileName(state, f.profile)} will fill its {f.label} window at about {clock(f.fullAt)}, {gap} before it
          resets at {clock(f.resetsAt)}.
        </b>
        <span>
          {paceWords(f.pace)}
          {paceWords(f.pace) ? ', and ' : ''}
          {rate(f.ratePerHour)}% an hour lately.
          {alt && other ? ` ${otherName} has ${100 - alt.pct}% of its ${alt.label} window left.` : ''}
        </span>
      </div>
      <div class="forecast-actions">
        {/* Its desktop app where there is one; a terminal in it otherwise. */}
        {other && state.vendors[other.vendor].installed ? (
          <Btn variant="primary" size="sm" onClick={(e) => act(() => window.sb.openApp(other.id), e.currentTarget)}>
            Open {otherName}
          </Btn>
        ) : other ? (
          <Btn
            variant="primary"
            size="sm"
            icon="terminal"
            onClick={(e) => act(() => window.sb.shell(other.id), e.currentTarget)}
          >
            Open a terminal in {otherName}
          </Btn>
        ) : null}
        <Btn size="sm" onClick={() => setDismissed({ profile: f.profile, label: f.label, resetsAt: f.resetsAt })}>
          Dismiss
        </Btn>
      </div>
    </div>
  );
}

// A weekly window can fill at well under a point an hour; say 0.4, not 0.
const rate = (perHour: number) => (perHour < 1 ? perHour.toFixed(1) : String(Math.round(perHour)));

function paceWords(pace: number | null): string {
  if (pace === null || Math.abs(pace) < 3) return pace === null ? '' : 'On an even pace';
  return pace > 0 ? `${pace} points ahead of an even pace` : `${-pace} points behind an even pace`;
}

// An account's fullest window, with a tick where an even pace would be.
function AccountCard({ state, id, t }: { state: State; id: string; t: WindowPace | null }) {
  const p = profileById(state, id);
  const plan = p ? planOf(p) : undefined;
  const remaining = state.settings.usageMode === 'remaining';
  const shown = (pct: number) => shownPct(pct, remaining);
  const tipLines =
    t && t.pace !== null
      ? [paceWords(t.pace), `The tick is where an even burn across the ${t.label} window would be now.`]
      : null;
  const tip = useTip(tipLines);
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
          <Track
            class="big"
            w={t}
            shown={shown(t.pct)}
            tick={t.pace !== null ? shown(t.pct - t.pace) : null}
            {...(tipLines
              ? { tabIndex: 0, role: 'img', 'aria-label': `${t.label} window ${t.pct}% used. ${tipLines.join(' ')}` }
              : {})}
            {...tip}
          />
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
  const order = seriesOrder(state);
  const days = report.daily.map((d) => shownValues(state, d.value));
  const totals = days.map((v) => Object.values(v).reduce((a, b) => a + b, 0));
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
              values={days[i]}
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
  const lines = [
    `${dayWord(day)} · ${money(total)}`,
    ...ids.map((id) => `${id === REMOVED ? 'Removed profiles' : profileName(state, id)}: ${money(values[id])}`),
  ];
  const tip = useTip(lines);
  return (
    <div class="dcol" tabIndex={0} role="img" aria-label={lines.join(', ')} {...tip}>
      {ids.map((id) => (
        <span
          key={id}
          style={{
            height: `${(values[id] / max) * 100}%`,
            background: id === REMOVED ? 'var(--muted)' : profileColor(state, id),
          }}
        />
      ))}
    </div>
  );
}

function WhereItWent({ state, report }: { state: State; report: UsageReport }) {
  const [by, setBy] = useState<'projects' | 'models'>('projects');
  // One unit per list: dollars where any project has a price, else agent
  // time. Mixed, a project of unpriced models would be sized in
  // milliseconds against the others' dollars.
  const top = report.projects.slice(0, 5);
  const priced = top.some((p) => p.value > 0);
  const rows =
    by === 'projects'
      ? top.map((p) => ({
          key: p.name,
          name: (
            <>
              {p.profiles.map((id) => (
                <Swatch key={id} color={profileColor(state, id)} />
              ))}
              <code>{p.name}</code>
            </>
          ),
          share: priced ? p.value : p.agentMs,
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
  const lead = days[0] ? (new Date(`${days[0].day}T12:00:00`).getDay() + 6) % 7 : 0;
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
    dayWord(day),
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
  const tokens = tokenSum(t.tokens);
  const hit = tokens
    ? Math.round((t.tokens.cacheRead / (t.tokens.input + t.tokens.cacheRead + t.tokens.cacheWrite || 1)) * 100)
    : null;
  // Removed profiles are in the total but in no vendor's account.
  const removed = report.daily.reduce((sum, d) => sum + (shownValues(state, d.value)[REMOVED] ?? 0), 0);
  const byVendor = (vendor: string) =>
    report.accounts.filter((a) => profileById(state, a.profile)?.vendor === vendor).reduce((s, a) => s + a.value, 0);
  const mix = [...report.mix].sort((a, b) => b.tokens - a.tokens);
  const reads = report.mix.find((m) => m.kind === 'cacheRead');
  const readLine =
    reads && tokens && t.value
      ? `cache reads are ${Math.round((reads.tokens / tokens) * 100)}% of tokens but ${Math.round((reads.value / t.value) * 100)}% of value`
      : null;
  const accounts = report.accounts.filter((a) => known(state, a.profile) && (a.value || tokenSum(a.tokens)));
  // One scale for the accounts drawn, not for profiles no longer listed.
  const scale = niceMax(Math.max(...accounts.flatMap((a) => report.daily.map((d) => d.value[a.profile] ?? 0)), 0));
  return (
    <>
      <div class="stats four">
        <Tile
          k="Tokens"
          v={count(tokens)}
          sub="input, output and cache"
          delta={change(tokens, p ? tokenSum(p.tokens) : undefined)}
        />
        <Tile
          k="Fresh tokens"
          v={count(freshTokens(t.tokens))}
          sub="without cache reads"
          delta={change(freshTokens(t.tokens), p ? freshTokens(p.tokens) : undefined)}
        />
        <Tile k="Cache hit" v={hit === null ? '—' : `${hit}%`} sub="of input served from cache" />
        <Tile
          k="API-equivalent value"
          v={money(t.value)}
          sub={`Claude ${money(byVendor('claude'))} · Codex ${money(byVendor('codex'))}${removed >= 0.005 ? ` · removed ${money(removed)}` : ''}`}
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
                    <Meter frac={tokens ? m.tokens / tokens : 0} />
                  </td>
                  <td class="num">{count(m.tokens)}</td>
                  <td>
                    <Meter class="quiet" frac={t.value ? m.value / t.value : 0} />
                  </td>
                  <td class="num">{money(m.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title="Cache hit by account" meta="higher is cheaper">
          <Ranked
            max={100}
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
        <Ranked
          solid
          rows={accounts.map((a) => ({
            key: a.profile,
            name: <Who state={state} id={a.profile} />,
            share: a.value,
            color: profileColor(state, a.profile),
            value: (
              <>
                {money(a.value)} <span class="muted">· {count(tokenSum(a.tokens))} tokens</span>
              </>
            ),
          }))}
        />
      </Panel>
      <Panel title="Daily value per account" meta={accounts.length ? `same scale, $0 – ${axisMoney(scale)}` : null}>
        {accounts.length ? (
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
        ) : (
          <Note>Nothing in this range.</Note>
        )}
      </Panel>
      <Provenance report={report} />
    </>
  );
}

// An SVG path through points already in the chart's coordinates.
const linePath = (points: [number, number][]) =>
  points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');

function Spark({ values, max, color }: { values: number[]; max: number; color: string }) {
  const W = 240;
  const H = 56;
  const x = (i: number) => 1 + (i / Math.max(1, values.length - 1)) * (W - 6);
  const y = (v: number) => H - 2 - (v / (max || 1)) * (H - 6);
  const d = linePath(values.map((v, i) => [x(i), y(v)]));
  return (
    <svg class="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ color }} aria-hidden="true">
      <line x1="0" x2={W} y1={H - 2} y2={H - 2} class="axis" />
      <path d={`${d}L${x(values.length - 1)},${H - 2}L${x(0)},${H - 2}Z`} class="area" />
      <path d={d} class="line" />
    </svg>
  );
}

// ---------------------------------------------------------------- sessions

const sessionKey = (s: UsageSession) => `${s.profile}/${s.id}`;

function Sessions({ state, report }: { state: State; report: UsageReport }) {
  const [chosenAccount, setAccount] = useState('all');
  const [onlyHits, setOnlyHits] = useState<'all' | 'hits'>('all');
  const [picked, setPicked] = useState<string | null>(null);
  const owners = [...new Set(report.blocks.map((b) => b.profile))].filter((id) => known(state, id));
  // An account picked in another range may have no windows in this one;
  // the filter falls back to all rather than showing an empty list under a
  // blank menu.
  const account = chosenAccount === 'all' || owners.includes(chosenAccount) ? chosenAccount : 'all';
  // Ten windows at a time: a month of them is a long page. Any change of
  // range or filter starts again from ten.
  const listing = `${report.days}|${account}|${onlyHits}`;
  const [more, setMore] = useState({ listing, limit: 10 });
  const limit = more.listing === listing ? more.limit : 10;
  const matching = report.blocks.filter(
    (b) => known(state, b.profile) && (account === 'all' || b.profile === account) && (onlyHits === 'all' || b.hitAt),
  );
  const blocks = matching.slice(0, limit);
  const all = blocks.flatMap((b) => b.sessions.map((s) => ({ s, b })));
  const chosen = all.find((x) => sessionKey(x.s) === picked) ?? all[0] ?? null;
  return (
    <>
      <div class="toolbar">
        <Seg
          label="Windows"
          value={onlyHits}
          onChange={setOnlyHits}
          options={[
            { id: 'all', label: 'All windows' },
            { id: 'hits', label: 'Only limit hits' },
          ]}
        />
        <select
          class="plain-select"
          aria-label="Account"
          value={account}
          onChange={(e) => setAccount((e.currentTarget as HTMLSelectElement).value)}
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
                picked={chosen ? sessionKey(chosen.s) : null}
                onPick={(s) => setPicked(sessionKey(s))}
                inline={
                  chosen && chosen.b === b ? <Inspector state={state} report={report} block={b} s={chosen.s} /> : null
                }
              />
            ))}
            {matching.length > blocks.length ? (
              <Btn class="more-windows" onClick={() => setMore({ listing, limit: limit + 10 })}>
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
  if (b.kind === 'day') return dayWord(b.label);
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
    <section class="panel block">
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
              <Meter
                class="tiny"
                frac={b.peak / 100}
                tone={severityClass({ label: b.label, pct: b.peak, resetsAt: null })}
              />
              {b.peak}% ·{' '}
            </>
          ) : null}
          {money(b.value)}
        </span>
      </div>
      {b.sessions.map((s) => {
        const on = picked === sessionKey(s);
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
              <span class="num time">{duration(s.agentMs)}</span>
              <span class="num tokens">{count(tokenSum(s.tokens))}</span>
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
            size="sm"
            icon="terminal"
            onClick={(e) => act(() => window.sb.resumeSession(s.profile, s.id), e.currentTarget)}
          >
            Resume in terminal
          </Btn>
          {/* Revealed in Finder, not opened: the folder's name came from a log. */}
          {s.project ? (
            <Btn
              size="sm"
              onClick={(e) => act(() => window.sb.openSession(s.profile, s.id, 'folder'), e.currentTarget)}
            >
              Show folder
            </Btn>
          ) : null}
          <Btn
            size="sm"
            onClick={(e) => act(() => window.sb.openSession(s.profile, s.id, 'transcript'), e.currentTarget)}
          >
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
              ['Tokens', `${count(tokenSum(s.tokens))} · ${count(freshTokens(s.tokens))} fresh`],
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
  const line = linePath(b.points.map(([at, pct]) => [x(at), y(pct)]));
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
