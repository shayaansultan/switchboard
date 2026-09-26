// Invented agent logs and window readings for the demo accounts, put through
// the real indexer and report builder, so the Usage tab's screenshot and its
// browser test show what the app would compute, not a hand-made report.
// Nothing here reads a real profile.
//
//   const report = await usageFixture(days)

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { emptyLedger, indexLogs, SLOT_MS, type LedgerProfile } from '../src/history/ledger';
import { buildReport } from '../src/history/report';
import type { WindowRecord } from '../src/history/windows';
import type { UsageReport, UsageWindow } from '../src/types';

const H = 3_600_000;
const D = 24 * H;

// A small deterministic generator, so every run draws the same month.
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Account {
  id: string;
  vendor: 'claude' | 'codex';
  models: string[];
  projects: string[];
  titles: string[];
  // Sessions on a weekday and on a weekend day, and their usual hours.
  weekday: number;
  weekend: number;
  hours: [number, number];
  // Dollars of work a full 5-hour window holds, to turn value into percent.
  window: number;
}

const ACCOUNTS: Account[] = [
  {
    id: 'claude-default',
    vendor: 'claude',
    models: ['claude-opus-5-5', 'claude-opus-5-5', 'claude-sonnet-5'],
    projects: ['/Users/you/code/switchboard', '/Users/you/notes', '/Users/you/side/bikes', '/Users/you/dotfiles'],
    titles: [
      'Add a usage tab to Switchboard',
      'Fix flaky awake popover test',
      'Summarise my reading notes',
      'Rewrite the bike-route planner UI',
      'Port the bucket worker to leases',
      'Explain CLIProxyAPI routing',
      'Tidy zsh startup',
    ],
    weekday: 1.4,
    weekend: 2.6,
    hours: [19, 23],
    window: 28,
  },
  {
    id: 'claude-work',
    vendor: 'claude',
    models: ['claude-opus-5-5', 'claude-sonnet-5', 'claude-sonnet-5'],
    projects: ['/Users/you/acme/api', '/Users/you/acme/web', '/Users/you/acme/infra'],
    titles: [
      'Migrate billing to the new invoices table',
      'Review the auth middleware PR',
      'Write tests for the export job',
      'Speed up the dashboard query',
      'Plan the Q4 API deprecations',
    ],
    weekday: 3,
    weekend: 0.2,
    hours: [9, 18],
    window: 80,
  },
  {
    id: 'codex-default',
    vendor: 'codex',
    models: ['gpt-5.3-codex', 'gpt-5.3-codex', 'gpt-5.3-codex-spark'],
    projects: ['/Users/you/dotfiles', '/Users/you/side/bikes'],
    titles: ['Clean up the Brewfile', 'Add offline maps to the planner', 'Refactor route scoring'],
    weekday: 0.8,
    weekend: 1.4,
    hours: [20, 23],
    window: 60,
  },
  {
    id: 'codex-client',
    vendor: 'codex',
    models: ['gpt-5.3-codex'],
    projects: ['/Users/you/client/portal'],
    titles: ['Build the invoice PDF export', 'Fix the portal login redirect'],
    weekday: 0.5,
    weekend: 0,
    hours: [10, 16],
    window: 60,
  },
];

// Sessions placed by hand: the one running now, on course to fill Personal's
// window before it resets, and a Saturday that ran into the limit.
const PLACED: { account: string; start: (now: number) => number; calls: number; title: string; cwd: string }[] = [
  {
    account: 'claude-default',
    start: (now) => now - 2.2 * H,
    calls: 230,
    title: 'Add a usage tab to Switchboard',
    cwd: '/Users/you/code/switchboard',
  },
  {
    account: 'claude-default',
    start: (now) => {
      const d = new Date(now - 6 * D);
      d.setHours(10, 30, 0, 0);
      return d.getTime();
    },
    calls: 460,
    title: 'Port the bucket worker to leases',
    cwd: '/Users/you/code/switchboard',
  },
];

const iso = (ms: number) => new Date(ms).toISOString();

function claudeLines(
  session: string,
  cwd: string,
  title: string,
  model: string,
  start: number,
  calls: number,
  r: () => number,
) {
  const lines = [
    JSON.stringify({
      type: 'user',
      sessionId: session,
      timestamp: iso(start),
      cwd,
      entrypoint: r() < 0.8 ? 'cli' : 'claude-desktop',
      message: { role: 'user', content: title },
    }),
  ];
  let at = start;
  for (let i = 0; i < calls; i++) {
    at += (20 + r() * 70) * 1000;
    const tool = r() < 0.5 ? (r() < 0.5 ? 'Read' : 'Bash') : r() < 0.6 ? 'Edit' : r() < 0.5 ? 'Grep' : 'Write';
    const file = `${cwd}/src/${['app', 'usage', 'store', 'main', 'style'][Math.floor(r() * 5)]}.ts`;
    const write = Math.round(2000 + r() * 9000);
    lines.push(
      JSON.stringify({
        type: 'assistant',
        sessionId: session,
        timestamp: iso(at),
        cwd,
        entrypoint: 'cli',
        requestId: `req_${session}_${i}`,
        message: {
          id: `msg_${session}_${i}`,
          model,
          content: [{ type: 'tool_use', id: `toolu_${session}_${i}`, name: tool, input: { file_path: file } }],
          usage: {
            input_tokens: Math.round(2 + r() * 40),
            output_tokens: Math.round(300 + r() * 4200),
            cache_read_input_tokens: Math.round(40_000 + r() * 90_000),
            cache_creation_input_tokens: write,
            cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write },
          },
        },
      }),
    );
  }
  return { lines, end: at };
}

function codexLines(
  session: string,
  cwd: string,
  title: string,
  model: string,
  start: number,
  calls: number,
  r: () => number,
) {
  const line = (at: number, type: string, payload: object) => JSON.stringify({ timestamp: iso(at), type, payload });
  const lines = [
    line(start, 'session_meta', {
      id: session,
      session_id: session,
      cwd,
      originator: r() < 0.7 ? 'codex_cli_rs' : 'Codex Desktop',
    }),
    line(start, 'turn_context', { model, cwd }),
    line(start, 'event_msg', { type: 'user_message', message: title }),
  ];
  let at = start;
  for (let i = 0; i < calls; i++) {
    at += (25 + r() * 80) * 1000;
    const cached = Math.round(30_000 + r() * 70_000);
    const output = Math.round(400 + r() * 5000);
    lines.push(
      line(at, 'response_item', { type: 'function_call', name: r() < 0.7 ? 'shell' : 'apply_patch' }),
      line(at, 'token_usage_record', {
        response_id: `resp_${session}_${i}`,
        usage: {
          input_tokens: cached + Math.round(r() * 3000),
          cached_input_tokens: cached,
          output_tokens: output,
          reasoning_output_tokens: 0,
          total_tokens: cached + output,
        },
      }),
    );
  }
  return { lines, end: at };
}

// Writes a month of logs under `home` and returns what a report needs.
export async function usageFixture(days = 30, now = Date.now()): Promise<UsageReport> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-usage-demo-'));
  try {
    const r = rng(20260924);
    const profiles: LedgerProfile[] = [];
    // The value of each account's calls, per five-minute slot, to drive its windows.
    const slots = new Map<string, Map<number, number>>();
    for (const a of ACCOUNTS) {
      const accountHome = path.join(home, a.id);
      profiles.push({ id: a.id, vendor: a.vendor, home: accountHome });
      slots.set(a.id, new Map());
      const place = (id: string, cwd: string, title: string, model: string, start: number, calls: number) => {
        const { lines } = (a.vendor === 'claude' ? claudeLines : codexLines)(id, cwd, title, model, start, calls, r);
        const file =
          a.vendor === 'claude'
            ? path.join(accountHome, 'projects', cwd.replace(/\//g, '-'), `${id}.jsonl`)
            : path.join(accountHome, 'sessions', `rollout-${id}.jsonl`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, lines.filter((l) => JSON.parse(l).timestamp <= iso(now)).join('\n') + '\n');
      };
      for (const [i, s] of PLACED.entries())
        if (s.account === a.id) place(`${a.id}-placed-${i}`, s.cwd, s.title, a.models[0], s.start(now), s.calls);
      for (let back = 34; back >= 0; back--) {
        const day = new Date(now - back * D);
        day.setHours(0, 0, 0, 0);
        const weekend = day.getDay() === 0 || day.getDay() === 6;
        let n = weekend ? a.weekend : a.weekday;
        n = Math.floor(n) + (r() < n % 1 ? 1 : 0);
        for (let k = 0; k < n; k++) {
          const hour = a.hours[0] + r() * (a.hours[1] - a.hours[0] - 1);
          const start = day.getTime() + hour * H;
          if (start > now - 20 * 60_000) continue;
          const id = `${a.id}-${back}-${k}`;
          const cwd = a.projects[Math.floor(r() * a.projects.length)];
          const title = a.titles[Math.floor(r() * a.titles.length)];
          const model = a.models[Math.floor(r() * a.models.length)];
          // Leave the placed sessions' hours to them.
          if (a.id === 'claude-default' && (back === 0 || back === 6)) continue;
          place(id, cwd, title, model, start, Math.round(20 + r() * (a.vendor === 'claude' ? 110 : 60)));
        }
      }
    }
    const ledger = emptyLedger(now - 35 * D);
    await indexLogs(ledger, profiles, now);
    for (const [id, pl] of Object.entries(ledger.profiles)) {
      const m = slots.get(id) as Map<number, number>;
      for (const s of Object.values(pl.sessions))
        for (const [slot, v] of Object.entries(s.slots)) m.set(Number(slot), (m.get(Number(slot)) ?? 0) + v);
    }

    // Window readings every 15 minutes: a 5-hour window opens at the first
    // work after a reset and fills with the value spent in it.
    const records: WindowRecord[] = [];
    const live: { id: string; vendor: 'claude' | 'codex'; windows: UsageWindow[] }[] = [];
    for (const a of ACCOUNTS) {
      const m = slots.get(a.id) as Map<number, number>;
      const label = a.vendor === 'claude' ? '5h' : 'Spark 5h';
      let open: { start: number; spent: number } | null = null;
      let week = 0;
      let weekEnd = 0;
      let latest: UsageWindow[] = [];
      for (let t = now - 30 * D; t <= now; t += 15 * 60_000) {
        const spent = [0, 1, 2].reduce((sum, i) => sum + (m.get(Math.floor(t / SLOT_MS) - i) ?? 0), 0);
        if (open && t >= open.start + 5 * H) open = null;
        if (!open && spent > 0) open = { start: t, spent: 0 };
        if (open) open.spent += spent;
        if (nextMonday(t) !== weekEnd) {
          weekEnd = nextMonday(t);
          week = 0;
        }
        week += spent;
        const windows: UsageWindow[] = [
          { label: '7d', pct: Math.min(100, Math.round((week / (a.window * 9)) * 100)), resetsAt: iso(weekEnd) },
        ];
        if (open)
          windows.unshift({
            label,
            pct: Math.min(100, Math.round((open.spent / a.window) * 100)),
            resetsAt: iso(open.start + 5 * H),
          });
        records.push({ at: t, profile: a.id, windows });
        latest = windows;
      }
      live.push({ id: a.id, vendor: a.vendor, windows: latest });
    }
    return buildReport({ ledger, records, windowsSince: records[0]?.at ?? null, live, days, now });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function nextMonday(t: number): number {
  const d = new Date(t);
  d.setHours(9, 0, 0, 0);
  while (d.getDay() !== 1 || d.getTime() <= t) d.setDate(d.getDate() + 1);
  return d.getTime();
}
