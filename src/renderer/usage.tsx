// The Usage tab: what every account's agent sessions have used, in two
// views. Overview puts all the accounts together, by vendor and by whether
// you or an automation started the work, in value, tokens, hours or
// sessions; Sessions groups sessions by the window they counted against,
// with an inspector for one. Everything comes from one report the main process builds (see
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
  type Measures,
  type Starter,
  type UsageSplit,
  type Vendor,
} from './lib';
import { Badge, Btn, Icon, Meter, Note, Panel, Ring, Seg, Skeleton } from './ui/primitives';
import { planCostOver } from '../shared/usage';

type View = 'overview' | 'sessions';
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

function Swatch({ color }: { color: string }) {
  return <span class="key-swatch" style={{ background: color }} />;
}

function Who({ state, id }: { state: State; id: string }) {
  return (
    <span class="who-inline">
      <Swatch color={profileColor(state, id)} />
      {profileName(state, id)}
    </span>
  );
}

// An SVG path through points already in the chart's coordinates.
const linePath = (points: [number, number][]) =>
  points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');

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
// Every account together: four measures to switch between, each day's work by
// vendor and by who started it, the token mix, and the repositories and
// accounts it went to. All of it comes from report.overview, which counts
// the sessions that started in the range, so the four measures agree.

type Metric = keyof Measures;
const METRICS: { id: Metric; label: string; tile: string; word: string }[] = [
  { id: 'value', label: 'Value', tile: 'API-equivalent value', word: 'value' },
  { id: 'tokens', label: 'Tokens', tile: 'Tokens', word: 'tokens' },
  { id: 'agentMs', label: 'Hours', tile: 'Agent hours', word: 'agent hours' },
  { id: 'sessions', label: 'Sessions', tile: 'Sessions', word: 'sessions' },
];

// "424h" past ten hours: minutes stop mattering at that scale.
// Whole hours, or minutes under one: "190h", "3h", "40m".
const hours = (ms: number) => (ms >= 3_600_000 ? `${Math.round(ms / 3_600_000)}h` : `${Math.round(ms / 60_000)}m`);
const shownAs = (metric: Metric, n: number): string =>
  metric === 'value'
    ? money(n)
    : metric === 'tokens'
      ? count(n)
      : metric === 'agentMs'
        ? hours(n)
        : Math.round(n).toLocaleString('en-US');

// The chart's four series, bottom up: each vendor's own colour, lighter for
// automations.
const SERIES: { vendor: Vendor; who: Starter; label: string; color: string }[] = [
  { vendor: 'claude', who: 'you', label: 'Claude, you', color: 'var(--claude)' },
  { vendor: 'claude', who: 'auto', label: 'Claude, automations', color: 'var(--claude-soft)' },
  { vendor: 'codex', who: 'you', label: 'Codex, you', color: 'var(--codex)' },
  { vendor: 'codex', who: 'auto', label: 'Codex, automations', color: 'var(--codex-soft)' },
];
const METRIC_COLOR: Record<Metric, string> = {
  value: 'var(--claude)',
  tokens: 'var(--series-4)',
  agentMs: 'var(--series-5)',
  sessions: 'var(--codex)',
};

const splitSum = (sp: UsageSplit, metric: Metric, keep: (vendor: Vendor, who: Starter) => boolean = () => true) =>
  SERIES.reduce((sum, s) => (keep(s.vendor, s.who) ? sum + sp[s.vendor][s.who][metric] : sum), 0);

// Each account's colour in this tab: the chart palette in the profiles'
// own order, so it stays put when the sort changes. Not the profile's colour:
// profiles often share one (a Default per vendor), and here nine accounts
// sit side by side and must be told apart.
const SERIES_COLORS = 10;
function accountColors(state: State): Map<string, string> {
  return new Map(state.profiles.map((p, i) => [p.id, `var(--series-${(i % SERIES_COLORS) + 1})`]));
}

function Overview({ state, report }: { state: State; report: UsageReport }) {
  const [metric, setMetric] = useState<Metric>('value');
  const o = report.overview;
  const m = METRICS.find((x) => x.id === metric) as (typeof METRICS)[number];
  const empty = !splitSum(o.totals, 'sessions');
  return (
    <>
      <Forecast state={state} report={report} />
      {empty ? (
        <div class="empty">
          No agent sessions in this range yet. Switchboard reads the logs Claude Code and Codex keep in each profile,
          and records every usage reading from now on.
        </div>
      ) : null}
      <div class="metric-tiles" role="radiogroup" aria-label="Measure">
        {METRICS.map((x) => (
          <MetricTile key={x.id} report={report} metric={x.id} on={x.id === metric} onPick={() => setMetric(x.id)} />
        ))}
      </div>
      <Panel
        title={`${m.label === 'Hours' ? 'Agent hours' : m.label} per day`}
        actions={
          <Seg
            label="Measure"
            value={metric}
            onChange={setMetric}
            options={METRICS.map((x) => ({ id: x.id, label: x.label }))}
          />
        }
      >
        <DayChart report={report} metric={metric} />
      </Panel>
      <div class="usage-cols top">
        <TokenMix report={report} />
        <Panel title="By repository" meta={`${m.word} · temporary folders as Scratch`}>
          <Repos report={report} metric={metric} />
        </Panel>
      </div>
      <Panel title="By account" meta={`sorted by ${m.word}`}>
        <AccountTable state={state} report={report} metric={metric} />
      </Panel>
      <Provenance report={report} />
    </>
  );
}

// A measure's total, what it is made of, and its days as a sparkline. The
// tile is also the switch for the chart and the lists below.
function MetricTile({
  report,
  metric,
  on,
  onPick,
}: {
  report: UsageReport;
  metric: Metric;
  on: boolean;
  onPick: () => void;
}) {
  const o = report.overview;
  const x = METRICS.find((d) => d.id === metric) as (typeof METRICS)[number];
  const total = splitSum(o.totals, metric);
  const you = splitSum(o.totals, metric, (_, who) => who === 'you');
  const kind = (k: keyof TokenCounts) => o.mix.find((e) => e.kind === k)?.tokens ?? 0;
  const sub =
    metric === 'value'
      ? `Claude ${money(splitSum(o.totals, metric, (v) => v === 'claude'))} · Codex ${money(splitSum(o.totals, metric, (v) => v === 'codex'))}`
      : metric === 'tokens'
        ? `${count(kind('input') + kind('output') + kind('cacheWrite'))} fresh · ${count(kind('cacheRead'))} cache reads`
        : `You ${shownAs(metric, you)} · automations ${shownAs(metric, total - you)}`;
  const days = o.days.map((d) => splitSum(d.split, metric));
  const max = Math.max(...days, 0) || 1;
  return (
    <button type="button" role="radio" aria-checked={on} class={on ? 'metric-tile on' : 'metric-tile'} onClick={onPick}>
      <span class="mt-head">
        {x.tile}
        <Swatch color={METRIC_COLOR[metric]} />
      </span>
      <span class="mt-value">{shownAs(metric, total)}</span>
      <span class="mt-spark" aria-hidden="true">
        {days.map((v, i) => (
          // Square-root heights, so a quiet day still shows beside a big one.
          <i
            key={i}
            style={{
              height: `${v > 0 ? Math.max(8, Math.sqrt(v / max) * 100) : 4}%`,
              background: v > 0 ? METRIC_COLOR[metric] : undefined,
            }}
          />
        ))}
      </span>
      <span class="mt-sub">{sub}</span>
    </button>
  );
}

// Each day's bar, stacked by vendor and starter. One day far above the rest
// (a single long session) is cut at twice the next and labelled, so it does
// not flatten every other day.
function DayChart({ report, metric }: { report: UsageReport; metric: Metric }) {
  const days = report.overview.days;
  const totals = days.map((d) => splitSum(d.split, metric));
  const sorted = [...totals].sort((a, b) => b - a);
  const cap = sorted[0] > 2 * (sorted[1] || 0) && sorted[1] > 0 ? 2 * sorted[1] : sorted[0] || 1;
  const every = days.length <= 7 ? 1 : days.length <= 30 ? 5 : 15;
  const seriesTotals = SERIES.map((s) => days.reduce((sum, d) => sum + d.split[s.vendor][s.who][metric], 0));
  return (
    <div class="day-chart">
      <div class="dc-legend">
        {SERIES.map((s, i) => (
          <span key={s.label}>
            <Swatch color={s.color} />
            {s.label} <b>{shownAs(metric, seriesTotals[i])}</b>
          </span>
        ))}
      </div>
      <div
        class="dc-plot"
        role="img"
        aria-label={`${METRICS.find((x) => x.id === metric)?.word} per day, from ${shortDay(days[0]?.day ?? '')}: ${totals.map((t) => shownAs(metric, t)).join(', ')}`}
      >
        {days.map((d, i) => {
          const scale = totals[i] > cap ? cap / totals[i] : 1;
          return (
            <div class="dc-day" key={d.day} title={`${dayWord(d.day)}: ${shownAs(metric, totals[i])}`}>
              {totals[i] > cap ? <span class="dc-clip">{shownAs(metric, totals[i])} ↑</span> : null}
              {SERIES.map((s) => {
                const v = d.split[s.vendor][s.who][metric];
                return v > 0 ? (
                  <i
                    key={s.label}
                    style={{ height: `${Math.max(1, ((v * scale) / cap) * 100)}%`, background: s.color }}
                  />
                ) : null;
              })}
            </div>
          );
        })}
      </div>
      <div class="dc-axis">
        {days.map((d, i) => (
          <span key={d.day}>{i % every === 0 || i === days.length - 1 ? shortDay(d.day) : ''}</span>
        ))}
      </div>
    </div>
  );
}

const MIX: { kind: keyof TokenCounts; label: string; color: string; note: string }[] = [
  { kind: 'cacheRead', label: 'Cache reads', color: 'var(--mix-read)', note: 'cheapest per token' },
  { kind: 'cacheWrite', label: 'Cache writes', color: 'var(--mix-write)', note: 'about 1.25× input' },
  { kind: 'output', label: 'Output', color: 'var(--mix-output)', note: 'dearest per token' },
  { kind: 'input', label: 'Input', color: 'var(--mix-input)', note: 'not from cache' },
];

// Share of tokens against share of value, kind by kind: cache reads are most
// of the tokens and much less of the value.
function TokenMix({ report }: { report: UsageReport }) {
  const mix = MIX.map((k) => ({
    ...k,
    ...(report.overview.mix.find((e) => e.kind === k.kind) ?? { tokens: 0, value: 0 }),
  }));
  const tokens = mix.reduce((s, k) => s + k.tokens, 0);
  const value = mix.reduce((s, k) => s + k.value, 0);
  const read = mix[0].tokens;
  const input = read + mix[1].tokens + mix[3].tokens;
  const hit = input ? Math.round((read / input) * 1000) / 10 : null;
  return (
    <Panel title="Token mix" meta={`${count(tokens)} tokens${hit === null ? '' : ` · ${hit}% of input from cache`}`}>
      <div class="token-mix">
        {(['tokens', 'value'] as const).map((by) => (
          <div class="tm-row" key={by}>
            <span class="muted">Share of {by}</span>
            <div
              class="tm-bar"
              role="img"
              aria-label={`Share of ${by}: ${mix.map((k) => `${k.label} ${Math.round(((by === 'tokens' ? k.tokens / tokens : k.value / value) || 0) * 100)}%`).join(', ')}`}
            >
              {mix.map((k) => (
                <i
                  key={k.kind}
                  style={{
                    flexGrow: Math.max(by === 'tokens' ? k.tokens / (tokens || 1) : k.value / (value || 1), 0.004),
                    background: k.color,
                  }}
                />
              ))}
            </div>
          </div>
        ))}
        <div class="tm-keys">
          {mix.map((k) => (
            <span key={k.kind}>
              <Swatch color={k.color} />
              <span>
                <b>{k.label}</b>
                <span class="muted">
                  {count(k.tokens)} tokens · {money(k.value)} · {k.note}
                </span>
              </span>
            </span>
          ))}
        </div>
      </div>
    </Panel>
  );
}

const TOP_REPOS = 8;

function Repos({ report, metric }: { report: UsageReport; metric: Metric }) {
  const rows = report.overview.repos
    .map((r) => ({
      name: r.name,
      claude: splitSum(r.split, metric, (v) => v === 'claude'),
      codex: splitSum(r.split, metric, (v) => v === 'codex'),
      sessions: splitSum(r.split, 'sessions'),
      auto: splitSum(r.split, 'sessions', (_, who) => who === 'auto'),
    }))
    .map((r) => ({ ...r, total: r.claude + r.codex }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total);
  if (!rows.length) return <Note>Nothing in this range.</Note>;
  const top = rows.slice(0, TOP_REPOS);
  const max = top[0].total || 1;
  return (
    <div class="repo-rows">
      {top.map((r) => (
        <div class="repo-row" key={r.name}>
          <span class="rr-name">
            <b>{r.name}</b>
            <span class="muted">
              {r.sessions.toLocaleString('en-US')} sessions
              {r.auto ? ` · ${Math.round((r.auto / r.sessions) * 100)}% automations` : ''}
            </span>
          </span>
          <span
            class="rr-bar"
            role="img"
            aria-label={`Claude ${shownAs(metric, r.claude)}, Codex ${shownAs(metric, r.codex)}`}
          >
            <i style={{ width: `${(r.claude / max) * 100}%`, background: 'var(--claude)' }} />
            <i style={{ width: `${(r.codex / max) * 100}%`, background: 'var(--codex)' }} />
          </span>
          <span class="num">{shownAs(metric, r.total)}</span>
        </div>
      ))}
      {rows.length > TOP_REPOS ? <Note>and {rows.length - TOP_REPOS} more</Note> : null}
    </div>
  );
}

// Every account with all four measures, its share of the chosen one, its
// plan against its value, and its fullest window now.
function AccountTable({ state, report, metric }: { state: State; report: UsageReport; metric: Metric }) {
  const colors = accountColors(state);
  const remaining = state.settings.usageMode === 'remaining';
  const rows = report.overview.accounts
    .filter((a) => known(state, a.profile))
    .sort((a, b) => b.measures[metric] - a.measures[metric]);
  const max = Math.max(...rows.map((r) => r.measures[metric]), 0) || 1;
  return (
    <div class="table-scroll">
      <table class="acct-table">
        <thead>
          <tr>
            <th>Account</th>
            <th class="share">Share of {METRICS.find((x) => x.id === metric)?.word}</th>
            {METRICS.map((x) => (
              <th class={x.id === metric ? 'num on' : 'num'} key={x.id}>
                {x.label}
              </th>
            ))}
            <th class="window">Fullest window</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const p = profileById(state, r.profile);
            const plan = p ? planOf(p) : undefined;
            const t = report.accounts.find((a) => a.profile === r.profile)?.tightest ?? null;
            const color = colors.get(r.profile) ?? profileColor(state, r.profile);
            const cost = p?.planPrice === undefined ? null : planCostOver(p.planPrice, report.days);
            return (
              <tr key={r.profile}>
                <td>
                  <span class="at-who">
                    <Swatch color={color} />
                    <span>
                      <b>{profileName(state, r.profile)}</b>
                      <span class="at-plan">
                        {plan ? <span class="muted">{plan}</span> : null}
                        <PlanPrice id={r.profile} monthly={p?.planPrice} />
                        {cost ? (
                          <b title="Value against the plan's price over these days">{times(r.measures.value / cost)}</b>
                        ) : null}
                      </span>
                    </span>
                  </span>
                </td>
                <td class="share">
                  <Meter frac={r.measures[metric] / max} color={color} />
                </td>
                {METRICS.map((x) => (
                  <td class={x.id === metric ? 'num on' : 'num'} key={x.id}>
                    {shownAs(x.id, r.measures[x.id])}
                  </td>
                ))}
                <td class="window">
                  {t ? (
                    <span class="at-window" title={`${t.label} window, ${relTime(t.resetsAt)}`}>
                      <Meter frac={shownPct(t.pct, remaining) / 100} tone={severityClass(t) || undefined} />
                      <span class="num">
                        {t.label} {shownPct(t.pct, remaining)}%
                      </span>
                    </span>
                  ) : (
                    <span class="muted">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
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
  const minutes = Math.max(1, Math.round(early / 60_000));
  const gap = early >= 3_600_000 ? 'over an hour' : minutes === 1 ? 'a minute' : `${minutes} minutes`;
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
          {paceWords(f.pace, true) ? `${paceWords(f.pace, true)}.` : ''}
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

// `early` is whether the shared pace says the window runs out before it
// resets; then it is ahead however the points round.
function paceWords(pace: number | null, early: boolean): string {
  if (pace !== null && early && pace < 3) return 'Just ahead of an even pace';
  if (pace === null || Math.abs(pace) < 3) return pace === null ? '' : 'On an even pace';
  return pace > 0 ? `${pace} points ahead of an even pace` : `${-pace} points behind an even pace`;
}

// "2.6×", "12×": how many times over a plan its value came to.
const times = (x: number) => `${x >= 10 ? Math.round(x) : x.toFixed(1)}×`;

// An account's monthly plan price, edited in place: Enter or leaving the
// field saves, Escape keeps what was there, and an empty field clears it.
function PlanPrice({ id, monthly }: { id: string; monthly: number | undefined }) {
  const [editing, setEditing] = useState(false);
  if (!editing)
    return (
      <Btn variant="ghost" size="sm" class="plan-price" onClick={() => setEditing(true)}>
        {monthly === undefined ? 'Set plan price' : `$${Number.isInteger(monthly) ? monthly : monthly.toFixed(2)}/mo`}
      </Btn>
    );
  let done = false;
  const finish = (input: HTMLInputElement | null) => {
    if (done) return;
    done = true;
    setEditing(false);
    // Text the field cannot read ("1e", "-") reads back as empty; keep the
    // price rather than clearing it.
    if (input && (input.validity.badInput || !input.checkValidity())) input = null;
    const text = input?.value.trim() ?? '';
    const next = input === null ? (monthly ?? null) : text === '' ? null : Number(text);
    if (next !== (monthly ?? null)) void act(() => window.sb.updateProfile(id, { planPrice: next }));
  };
  return (
    <input
      class="plan-input"
      type="number"
      min="0"
      max="10000"
      step="any"
      inputMode="decimal"
      defaultValue={monthly === undefined ? '' : String(monthly)}
      placeholder="$ a month"
      aria-label="Plan price, US dollars a month"
      ref={(el) => el?.focus()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(e.currentTarget);
        if (e.key === 'Escape') finish(null);
      }}
      onBlur={(e) => finish(e.currentTarget)}
    />
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
