// `switchboard tokens`: the usage history the app keeps, for a terminal or
// an agent. It reads what the app last indexed and never reads the logs
// itself, so it cannot race the app's writes; `indexedAt` says how fresh it is.

import { UsageHistory, USAGE_DIR } from '../history';
import type { UsageReport } from '../types';
import type { Context } from './context';
import { parse } from './context';
import { notFound, table, usageError } from './output';
import { readLiveCache } from './usage';

const BY = ['account', 'model', 'project', 'day'] as const;
type By = (typeof BY)[number];

const total = (t: { input: number; output: number; cacheRead: number; cacheWrite: number }) =>
  t.input + t.output + t.cacheRead + t.cacheWrite;
const dollars = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);

function rows(report: UsageReport, by: By, name: (id: string) => string): Record<string, unknown>[] {
  switch (by) {
    case 'account':
      return report.accounts.map((a) => ({
        profile: a.profile,
        name: name(a.profile),
        value: dollars(a.value),
        tokens: total(a.tokens),
        fresh: a.tokens.input + a.tokens.output + a.tokens.cacheWrite,
        cacheHit: report.cacheHit.find((c) => c.profile === a.profile)?.pct ?? null,
      }));
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
        profiles: p.profiles.join(','),
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

export function tokensCommand(rest: string[], ctx: Context, dir = USAGE_DIR): void {
  const { values } = parse(rest, {
    days: { type: 'string', default: '30' },
    by: { type: 'string', default: 'account' },
  });
  const days = Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > 366) throw usageError('--days is a whole number from 1 to 366');
  const by = values.by as By;
  if (!BY.includes(by)) throw usageError(`--by must be one of: ${BY.join(', ')}`);
  const history = UsageHistory.readOnly(dir);
  if (!history) {
    throw notFound(
      'no-usage-history',
      'Switchboard has not recorded any usage yet',
      'Open Switchboard: it reads the Claude Code and Codex logs of every profile and keeps the totals.',
    );
  }
  const cache = readLiveCache().entries;
  const live = ctx.data.profiles.map((p) => ({ id: p.id, vendor: p.vendor, windows: cache[p.id]?.usage?.windows }));
  const report = history.report(live, days);
  const name = (id: string) => ctx.data.profiles.find((p) => p.id === id)?.name ?? id;
  const list = rows(report, by, name);
  const result = {
    days,
    by,
    recordedSince: report.recordedSince,
    indexedAt: report.indexedAt,
    pricesAsOf: report.pricesAsOf,
    totals: {
      value: dollars(report.totals.value),
      tokens: total(report.totals.tokens),
      sessions: report.totals.sessions,
      agentMinutes: Math.round(report.totals.agentMs / 60000),
      limitHits: report.totals.limitHits,
      unpricedTokens: report.totals.unpricedTokens,
    },
    rows: list,
  };
  ctx.out.result(result, () =>
    [
      table(list, Object.keys(list[0] ?? { [by]: '' })),
      '',
      `$${result.totals.value} API-equivalent over ${days} days · estimates at API prices of ${report.pricesAsOf}`,
    ].join('\n'),
  );
}
