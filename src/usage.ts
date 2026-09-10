// Identity and rate-limit lookups, per profile. Runs only in the main
// process. Tokens are read, used for one HTTPS call, and discarded; the
// renderer only ever receives percentages, reset times, email and plan.
//
// Claude: the Claude Code CLI keeps its OAuth blob in the macOS Keychain under
//   "Claude Code-credentials" for ~/.claude, or
//   "Claude Code-credentials-<sha256(CLAUDE_CONFIG_DIR)[0:8]>" for any other dir,
//   falling back to <dir>/.credentials.json. Usage comes from the same endpoint
//   Claude Code's /usage screen calls.
// Codex: <CODEX_HOME>/auth.json holds ChatGPT OAuth tokens. Usage comes from
//   the endpoint the Codex CLI /status screen calls.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run, haveCommand, type RunError } from './launch';
import { VENDORS, dirs } from './store';
import type { Identity, Profile, Usage, UsageWindow } from './types';

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CODEX_USAGE_URLS = [
  'https://chatgpt.com/backend-api/wham/usage',
  'https://chatgpt.com/backend-api/api/codex/usage',
];
const UA = 'switchboard/0.1';

// The endpoints are undocumented, so their bodies are handled as they come.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export function keychainService(configDir: string): string {
  if (configDir === VENDORS.claude.defaultHome) return 'Claude Code-credentials';
  const h = crypto.createHash('sha256').update(configDir).digest('hex').slice(0, 8);
  return `Claude Code-credentials-${h}`;
}

async function readKeychain(service: string): Promise<string | null> {
  try {
    const { stdout } = await run('security', [
      'find-generic-password',
      '-s',
      service,
      '-a',
      os.userInfo().username,
      '-w',
    ]);
    return stdout.trim() || null;
  } catch (err) {
    const e = err as RunError;
    // 44 = item not found. Anything else (locked keychain, denied) is reported.
    if (e.code === 44) return null;
    throw new Error(`keychain: ${(e.stderr || e.message || '').trim()}`);
  }
}

interface ClaudeCredential {
  token: string;
  expiresAt: number | null;
  subscriptionType: string | null;
}

async function claudeToken(home: string): Promise<ClaudeCredential | null> {
  let blob = await readKeychain(keychainService(home));
  if (!blob) {
    const f = path.join(home, '.credentials.json');
    if (fs.existsSync(f)) blob = fs.readFileSync(f, 'utf8');
  }
  if (!blob) return null;
  const j: Json = JSON.parse(blob);
  const o = j.claudeAiOauth || j;
  if (!o.accessToken) return null;
  return { token: o.accessToken, expiresAt: o.expiresAt || null, subscriptionType: o.subscriptionType || null };
}

async function claudeIdentity(profile: Profile): Promise<Identity> {
  const d = dirs(profile);
  const env = { ...process.env };
  if (!d.isDefault) env.CLAUDE_CONFIG_DIR = d.home;
  try {
    const { stdout } = await run(VENDORS.claude.cli, ['auth', 'status', '--json'], { env });
    const j: Json = JSON.parse(stdout);
    return {
      loggedIn: !!j.loggedIn,
      email: j.email || null,
      plan: planName(j.subscriptionType),
      org: j.orgName || null,
    };
  } catch (err) {
    const e = err as RunError;
    // `claude auth status` exits non-zero when logged out but still prints JSON.
    try {
      const j: Json = JSON.parse(e.stdout || '');
      return { loggedIn: !!j.loggedIn, email: j.email || null, plan: planName(j.subscriptionType) };
    } catch {
      const missing = e.code === 'ENOENT' || /not found/i.test(e.message || '');
      return { loggedIn: false, error: missing ? 'the claude CLI is not installed' : 'claude auth status failed' };
    }
  }
}

// Vendors report plans as internal slugs ("self_serve_business_prolite", "max").
export function planName(slug: unknown): string | null {
  if (!slug) return null;
  const s = String(slug).toLowerCase();
  for (const [needle, label] of [
    ['enterprise', 'Enterprise'],
    ['business', 'Business'],
    ['team', 'Team'],
    ['max', 'Max'],
    ['pro', 'Pro'],
    ['plus', 'Plus'],
    ['free', 'Free'],
  ]) {
    if (s.includes(needle)) return label;
  }
  return String(slug);
}

// How long to leave an endpoint alone after a 429. The server's Retry-After
// is honoured when it gives a real number; otherwise back off for 15 minutes.
function retryDelay(res: Response): number {
  const ra = Number(res.headers.get('retry-after'));
  return ra > 0 ? ra * 1000 : 15 * 60 * 1000;
}

function pct(x: unknown): number | null {
  const n = Number(x);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
}

function isoOrNull(x: unknown): string | null {
  if (!x) return null;
  if (typeof x === 'number') return new Date(x < 1e12 ? x * 1000 : x).toISOString();
  const t = Date.parse(String(x));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

async function claudeUsage(profile: Profile): Promise<Usage> {
  const d = dirs(profile);
  const cred = await claudeToken(d.home);
  if (!cred) return { error: 'not signed in via CLI' };
  if (cred.expiresAt && cred.expiresAt < Date.now()) {
    return { error: 'CLI token expired; run claude once to refresh' };
  }
  const res = await fetch(CLAUDE_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${cred.token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      Accept: 'application/json',
      'User-Agent': UA,
    },
  });
  if (res.status === 429) return { error: 'rate limited by the usage API', retryAfterMs: retryDelay(res) };
  if (!res.ok) return { error: `usage API ${res.status}` };
  const windows = parseClaudeUsage(await res.json());
  return { windows, plan: planName(cred.subscriptionType), fetchedAt: new Date().toISOString() };
}

// The usage endpoint's JSON, as a list of windows for the bars. Pure, so the
// shapes the endpoint has been seen to return can be pinned down in tests.
export function parseClaudeUsage(j: Json): UsageWindow[] {
  const windows: UsageWindow[] = [];
  if (Array.isArray(j.limits) && j.limits.length) {
    // `limits` is the complete list: the session window, the weekly window,
    // and any model- or surface-scoped weekly windows (e.g. a Fable pool).
    for (const l of j.limits) {
      if (l.percent == null) continue;
      const scope = l.scope || {};
      const scopeName = (scope.model && scope.model.display_name) || scope.surface || null;
      let label: string;
      if (l.kind === 'session') label = '5h';
      else if (l.kind === 'weekly_all') label = '7d';
      else label = `${l.group === 'session' ? '5h' : '7d'} ${scopeName || l.kind}`;
      windows.push({ label, pct: pct(l.percent), resetsAt: isoOrNull(l.resets_at), severity: l.severity || null });
    }
  } else {
    const push = (label: string, w: Json) => {
      if (w && w.utilization != null)
        windows.push({ label, pct: pct(w.utilization), resetsAt: isoOrNull(w.resets_at) });
    };
    push('5h', j.five_hour);
    push('7d', j.seven_day);
  }
  return windows;
}

function decodeJwt(t: string): Json | null {
  try {
    const p = t.split('.')[1];
    return JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

interface CodexAuth {
  mode: string;
  token: string | null;
  accountId: string | null;
  email: string | null;
  plan: string | null;
}

function codexAuth(home: string): CodexAuth | null {
  const f = path.join(home, 'auth.json');
  if (!fs.existsSync(f)) return null;
  const j: Json = JSON.parse(fs.readFileSync(f, 'utf8'));
  const t = j.tokens || {};
  const claims = t.id_token ? decodeJwt(t.id_token) : null;
  const auth = (claims && claims['https://api.openai.com/auth']) || {};
  return {
    mode: j.auth_mode || (t.access_token ? 'chatgpt' : j.OPENAI_API_KEY ? 'apikey' : 'none'),
    token: t.access_token || null,
    accountId: t.account_id || auth.chatgpt_account_id || null,
    email: (claims && claims.email) || null,
    plan: planName(auth.chatgpt_plan_type),
  };
}

async function codexIdentity(profile: Profile): Promise<Identity> {
  const d = dirs(profile);
  const a = codexAuth(d.home);
  if (!a || a.mode === 'none') {
    // Signed out and never-installed look the same on disk; say which it is.
    const installed = await haveCommand(VENDORS.codex.cli);
    return { loggedIn: false, error: installed ? null : 'the codex CLI is not installed' };
  }
  return { loggedIn: true, email: a.email, plan: a.plan, mode: a.mode };
}

async function codexUsage(profile: Profile): Promise<Usage> {
  const d = dirs(profile);
  const a = codexAuth(d.home);
  if (!a || !a.token)
    return { error: a && a.mode === 'apikey' ? 'API-key login has no rate-limit windows' : 'not signed in' };
  let last: string | null = null;
  for (const url of CODEX_USAGE_URLS) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${a.token}`,
        'ChatGPT-Account-Id': a.accountId || '',
        Accept: 'application/json',
        'User-Agent': UA,
      },
    });
    if (res.status === 404) {
      last = `usage API ${res.status}`;
      continue;
    }
    if (res.status === 401) return { error: 'token expired; run codex once to refresh' };
    if (res.status === 429) return { error: 'rate limited by the usage API', retryAfterMs: retryDelay(res) };
    if (!res.ok) return { error: `usage API ${res.status}` };
    const j: Json = await res.json();
    return { windows: parseCodexUsage(j), plan: planName(j.plan_type) || a.plan, fetchedAt: new Date().toISOString() };
  }
  return { error: last || 'usage API unavailable' };
}

// The usage endpoint's JSON, as a list of windows for the bars. `now` is only
// consulted when a window gives its reset as seconds from now.
export function parseCodexUsage(j: Json, now: number = Date.now()): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const windowLabel = (w: Json): string => {
    const secs = w.limit_window_seconds || (w.limit_window_minutes || 0) * 60;
    if (!secs) return 'window';
    return secs >= 86400 ? `${Math.round(secs / 86400)}d` : `${Math.round(secs / 3600)}h`;
  };
  const push = (w: Json, prefix = '') => {
    if (!w || w.used_percent == null) return;
    const resetsAt =
      w.reset_at != null
        ? isoOrNull(w.reset_at)
        : w.resets_at != null
          ? isoOrNull(w.resets_at)
          : w.reset_after_seconds != null
            ? new Date(now + w.reset_after_seconds * 1000).toISOString()
            : null;
    windows.push({ label: (prefix + windowLabel(w)).trim(), pct: pct(w.used_percent), resetsAt });
  };
  const rl = j.rate_limit || {};
  push(rl.primary_window);
  push(rl.secondary_window);
  // Model-specific limits (e.g. a separate pool for a fast model).
  for (const extra of j.additional_rate_limits || []) {
    const name = String(extra.limit_name || '')
      .replace(/^GPT-/, '')
      .replace(/-?Codex-?/i, '-')
      .replace(/^-|-$/g, '');
    push(extra.rate_limit && extra.rate_limit.primary_window, name ? `${name} ` : '');
    push(extra.rate_limit && extra.rate_limit.secondary_window, name ? `${name} ` : '');
  }
  return windows;
}

export async function identity(profile: Profile): Promise<Identity> {
  return profile.vendor === 'claude' ? claudeIdentity(profile) : codexIdentity(profile);
}

export async function usage(profile: Profile): Promise<Usage> {
  try {
    return profile.vendor === 'claude' ? await claudeUsage(profile) : await codexUsage(profile);
  } catch (e) {
    return { error: (e as Error).message || String(e) };
  }
}
