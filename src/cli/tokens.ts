// `switchboard tokens` and `switchboard digest`: the usage history the app
// keeps, for a terminal or an agent. It reads what the app last indexed and
// never reads the logs itself, so it cannot race the app's writes;
// `indexedAt` says how fresh it is.

import { sumTokens, UsageHistory, USAGE_DIR } from '../history';
import { buildDigest, lastWeekEnd } from '../history/digest';
import { dayOf } from '../history/ledger';
import { VENDORS } from '../profiles';
import type { Profile, UsageReport } from '../types';
import type { Context } from './context';
import { parse } from './context';
import { notFound, ref, table, usageError } from './output';

const BY = ['account', 'repo', 'model', 'project', 'day'] as const;
type By = (typeof BY)[number];

// "Claude · Default": a profile's name alone repeats across vendors.
const accountOf = (profiles: Profile[], id: string): string => {
  const p = profiles.find((x) => x.id === id);
  return p ? `${VENDORS[p.vendor].label} · ${p.name}` : id;
};

const dollars = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);

// The columns `--human` prints; JSON carries every field.
const COLUMNS: Record<By, string[]> = {
  account: ['account', 'value', 'tokens', 'fresh', 'cacheHit'],
  repo: ['repo', 'value', 'tokens', 'sessions', 'automations', 'agentMinutes'],
  model: ['model', 'value', 'tokens', 'sessions'],
  project: ['project', 'profiles', 'value', 'sessions', 'agentMinutes'],
  day: ['day', 'value', 'tokens'],
};

function rows(report: UsageReport, by: By, profiles: Profile[]): Record<string, unknown>[] {
  switch (by) {
    case 'account':
      return report.accounts.map((a) => {
        const p = profiles.find((x) => x.id === a.profile);
        return {
          ...(p ? ref(p) : { id: a.profile, name: a.profile }),
          account: accountOf(profiles, a.profile),
          value: dollars(a.value),
          tokens: sumTokens(a.tokens),
          fresh: a.tokens.input + a.tokens.output + a.tokens.cacheWrite,
          cacheHit: report.cacheHit.find((c) => c.profile === a.profile)?.pct ?? null,
        };
      });
    case 'repo':
      // From the sessions that started in the range, as the Usage tab counts them.
      return report.overview.repos.map((r) => {
        const all = [r.split.claude.you, r.split.claude.auto, r.split.codex.you, r.split.codex.auto];
        const sum = (k: 'value' | 'tokens' | 'agentMs' | 'sessions') => all.reduce((s, m) => s + m[k], 0);
        return {
          repo: r.name,
          value: dollars(sum('value')),
          tokens: sum('tokens'),
          sessions: sum('sessions'),
          automations: r.split.claude.auto.sessions + r.split.codex.auto.sessions,
          agentMinutes: Math.round(sum('agentMs') / 60000),
        };
      });
    case 'model':
      return report.models.map((m) => ({
        model: m.model,
        value: dollars(m.value),
        tokens: m.tokens,
        sessions: m.sessions,
      }));
    case 'project':
      return report.projects.map((p) => ({
        project: p.name,
        profiles: p.profiles,
        value: dollars(p.value),
        sessions: p.sessions,
        agentMinutes: Math.round(p.agentMs / 60000),
      }));
    case 'day':
      return report.daily.map((d) => ({
        day: d.day,
        value: dollars(Object.values(d.value).reduce((a, b) => a + b, 0)),
        tokens: Object.values(d.tokens).reduce((a, b) => a + b, 0),
      }));
  }
}

function readHistory(dir: string): UsageHistory {
  const history = UsageHistory.readOnly(dir);
  if (!history) {
    throw notFound(
      'no-usage-history',
      'Switchboard has not recorded any usage yet',
      'Open Switchboard: it reads the Claude Code and Codex logs of every profile and keeps the totals.',
    );
  }
  return history;
}

export function tokensCommand(rest: string[], ctx: Context, dir = USAGE_DIR): void {
  const { values } = parse(rest, {
    days: { type: 'string', default: '30' },
    by: { type: 'string', default: 'account' },
  });
  const days = Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > 366) throw usageError('--days is a whole number from 1 to 366');
  const by = values.by as By;
  if (!BY.includes(by)) throw usageError(`--by must be one of: ${BY.join(', ')}`);
  const history = readHistory(dir);
  // Live windows only feed the forecast and pace, which this does not print.
  const report = history.report(
    ctx.data.profiles.map((p) => ({ id: p.id, vendor: p.vendor, windows: undefined })),
    days,
  );
  const list = rows(report, by, ctx.data.profiles);
  const result = {
    days,
    by,
    recordedSince: report.recordedSince,
    indexedAt: report.indexedAt,
    pricesAsOf: report.pricesAsOf,
    totals: {
      value: dollars(report.totals.value),
      tokens: sumTokens(report.totals.tokens),
      sessions: report.totals.sessions,
      agentMinutes: Math.round(report.totals.agentMs / 60000),
      limitHits: report.totals.limitHits,
      unpricedTokens: report.totals.unpricedTokens,
    },
    rows: list,
  };
  ctx.out.result(result, () =>
    [
      table(
        list.map((r) => (Array.isArray(r.profiles) ? { ...r, profiles: r.profiles.join(',') } : r)),
        COLUMNS[by],
      ),
      '',
      `$${(result.totals.value ?? 0).toFixed(2)} API-equivalent over ${days} days · estimates at API prices of ${report.pricesAsOf}`,
    ].join('\n'),
  );
}

const day = (d: string) =>
  new Date(`${d}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const hm = (ms: number) => {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
};

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

// Last week, Monday to Sunday: what the Monday notification says, in full.
export function digestCommand(rest: string[], ctx: Context, dir = USAGE_DIR, now = Date.now()): void {
  parse(rest, {});
  const end = lastWeekEnd(now);
  const report = readHistory(dir).report(
    ctx.data.profiles.map((p) => ({ id: p.id, vendor: p.vendor, windows: undefined })),
    7,
    end,
  );
  const d = buildDigest(report, Object.fromEntries(ctx.data.profiles.map((p) => [p.id, p.planPrice])));
  const name = (id: string) => ctx.data.profiles.find((x) => x.id === id)?.name ?? id;
  const account = (id: string) => accountOf(ctx.data.profiles, id);
  const result = {
    from: d.from,
    to: d.to,
    recordedSince: report.recordedSince,
    indexedAt: report.indexedAt,
    pricesAsOf: report.pricesAsOf,
    value: dollars(d.value),
    agentMinutes: Math.round(d.agentMs / 60000),
    sessions: d.sessions,
    previous: d.previous && { value: dollars(d.previous.value), agentMinutes: Math.round(d.previous.agentMs / 60000) },
    limitHits: d.limitHits,
    hits: d.hits.map((h) => ({ ...h, name: name(h.profile), account: account(h.profile) })),
    waitedMinutes: Math.round(d.waitedMs / 60000),
    busiest: d.busiest && { day: d.busiest.day, value: dollars(d.busiest.value) },
    project: d.project && { name: d.project.name, value: dollars(d.project.value) },
    model: d.model && { model: d.model.model, value: dollars(d.model.value) },
    accounts: d.accounts.map((a) => ({
      id: a.profile,
      name: name(a.profile),
      account: account(a.profile),
      value: dollars(a.value),
      planCost: dollars(a.planCost),
      times: a.times === null ? null : Math.round(a.times * 10) / 10,
    })),
  };
  ctx.out.result(result, () => {
    const change =
      d.previous && d.previous.value > 0
        ? ` (${signed(Math.round((d.value / d.previous.value - 1) * 100))}% on the week before)`
        : '';
    const where = d.hits.map((h) => `${account(h.profile)} ${h.label}, ${day(dayOf(Date.parse(h.at)))}`).join('; ');
    const hits = d.limitHits
      ? `Limits: hit ${d.limitHits === 1 ? 'once' : `${d.limitHits} times`}${where ? ` (${d.hits.length < d.limitHits ? 'including ' : ''}${where})` : ''}, waited ${hm(d.waitedMs)}`
      : 'Limits: none hit';
    return [
      `Week of ${day(d.from)} to ${day(d.to)}`,
      `$${(result.value ?? 0).toFixed(2)} of value · ${hm(d.agentMs)} agent time · ${d.sessions} sessions${change}`,
      hits,
      ...(d.busiest ? [`Busiest day: ${day(d.busiest.day)}, $${d.busiest.value.toFixed(2)}`] : []),
      ...(d.project ? [`Top project: ${d.project.name} · top model: ${d.model?.model ?? 'none'}`] : []),
      '',
      table(
        result.accounts.map((a) => ({
          account: a.account,
          value: a.value,
          plan: a.planCost === null ? 'not set' : a.planCost,
          times: a.times === null ? '' : `${a.times}x`,
        })),
        ['account', 'value', 'plan', 'times'],
      ),
      '',
      `estimates at API prices of ${report.pricesAsOf}; plan is the monthly price over these 7 days${
        report.recordedSince && report.recordedSince > d.from
          ? ` · recorded only since ${day(report.recordedSince)}`
          : ''
      }`,
    ].join('\n');
  });
}
