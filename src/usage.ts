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
import { recoverClaudeToken } from './claude-recovery';
import { run, haveCommand, type RunError } from './launch';
import { VENDORS, dirs } from './store';
import type { Identity, Profile, Usage } from './types';
import { parseClaudeUsage, parseCodexUsage } from './usage-parsers';
import { planName } from './plans';
export { parseClaudeUsage, parseCodexUsage } from './usage-parsers';

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

// Read through Apple's `security` tool on purpose, and never through an
// in-process keychain call. Claude Code writes its credential item with the
// same tool, and items written that way stay readable by it without a
// password dialog. An app reading the item from its own binary gets the
// dialog instead, and gets it again every time Claude Code refreshes its
// token and rewrites the item's permissions. That recurring prompt is the
// single most hated behaviour of similar apps; keep this path as it is.
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
  rateLimitTier: string | null;
}

export interface UsageDependencies {
  readClaudeCredential?: (home: string) => Promise<ClaudeCredential | null>;
  recoverClaudeCredential?: (home: string) => Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
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
  return {
    token: o.accessToken,
    expiresAt: o.expiresAt || null,
    subscriptionType: o.subscriptionType || null,
    rateLimitTier: o.rateLimitTier || null,
  };
}

async function renewClaudeToken(home: string): Promise<void> {
  await recoverClaudeToken(home, { readCredential: () => claudeToken(home) });
}

async function claudeIdentity(profile: Profile): Promise<Identity> {
  const d = dirs(profile);
  const env = { ...process.env };
  if (!d.isDefault) env.CLAUDE_CONFIG_DIR = d.home;
  // `claude auth status` names the plan but not its tier; the credential has
  // both, so the badge can say "Max 20x" before any usage has been fetched.
  const tier = (await claudeToken(d.home).catch(() => null))?.rateLimitTier;
  const named = (j: Json): Identity => ({
    loggedIn: !!j.loggedIn,
    email: j.email || null,
    plan: planName('claude', j.subscriptionType, tier),
  });
  try {
    const { stdout } = await run(VENDORS.claude.cli, ['auth', 'status', '--json'], { env });
    const j: Json = JSON.parse(stdout);
    return { ...named(j), org: j.orgName || null };
  } catch (err) {
    const e = err as RunError;
    // `claude auth status` exits non-zero when logged out but still prints JSON.
    try {
      return named(JSON.parse(e.stdout || ''));
    } catch {
      const missing = e.code === 'ENOENT' || /not found/i.test(e.message || '');
      return { loggedIn: false, error: missing ? 'the claude CLI is not installed' : 'claude auth status failed' };
    }
  }
}

// How long to leave an endpoint alone after a 429. The server's Retry-After
// is honoured when it gives a real number; otherwise back off for 15 minutes.
function retryDelay(res: Response): number {
  const ra = Number(res.headers.get('retry-after'));
  return ra > 0 ? ra * 1000 : 15 * 60 * 1000;
}

async function claudeUsage(profile: Profile, dependencies: UsageDependencies = {}): Promise<Usage> {
  const d = dirs(profile);
  const readCredential = dependencies.readClaudeCredential ?? claudeToken;
  const recoverCredential = dependencies.recoverClaudeCredential ?? renewClaudeToken;
  const requestFetch = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  let cred = await readCredential(d.home);
  let recovered = false;
  if (!cred) return { error: 'not signed in via CLI' };
  if (cred.expiresAt && cred.expiresAt <= now()) {
    await recoverCredential(d.home);
    recovered = true;
    cred = await readCredential(d.home);
    if (!cred) return { error: 'Claude session renewal did not produce usable credentials' };
  }
  const request = (token: string) =>
    requestFetch(CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json',
        'User-Agent': UA,
      },
    });
  let res = await request(cred.token);
  if (res.status === 401 && !recovered) {
    // Another CLI may already have rotated the token. Startup can renew an
    // expired token, but cannot reliably repair a revoked, unexpired token.
    const latest = await readCredential(d.home);
    if (latest?.expiresAt && latest.expiresAt <= now()) {
      await recoverCredential(d.home);
      cred = await readCredential(d.home);
      if (!cred) return { error: 'Claude session renewal did not produce usable credentials' };
      res = await request(cred.token);
    } else if (latest && latest.token !== cred.token) {
      res = await request(latest.token);
    }
  }
  if (res.status === 401) return { error: 'Claude session rejected (401); open this profile in Terminal to sign in' };
  if (res.status === 429) return { error: 'rate limited by the usage API', retryAfterMs: retryDelay(res) };
  if (!res.ok) return { error: `usage API ${res.status}` };
  const windows = parseClaudeUsage(await res.json());
  return {
    windows,
    plan: planName('claude', cred.subscriptionType, cred.rateLimitTier),
    fetchedAt: new Date().toISOString(),
  };
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
    plan: planName('codex', auth.chatgpt_plan_type),
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
    return {
      windows: parseCodexUsage(j),
      plan: planName('codex', j.plan_type) || a.plan,
      fetchedAt: new Date().toISOString(),
    };
  }
  return { error: last || 'usage API unavailable' };
}

// Whether a usage answer suggests the sign-in itself changed, rather than
// the endpoint being unavailable.
export function looksSignedOut(u: Usage | undefined): boolean {
  return !!u?.error && /not signed in|expired|401|403/i.test(u.error);
}

export async function identity(profile: Profile): Promise<Identity> {
  return profile.vendor === 'claude' ? claudeIdentity(profile) : codexIdentity(profile);
}

export async function usage(profile: Profile, dependencies: UsageDependencies = {}): Promise<Usage> {
  try {
    return profile.vendor === 'claude' ? await claudeUsage(profile, dependencies) : await codexUsage(profile);
  } catch (e) {
    return { error: (e as Error).message || String(e) };
  }
}
