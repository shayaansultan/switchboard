import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import * as net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { root, paths, load, readJson, writeJson, secrets, BucketId } from './store';
import { parseClaudeUsage, parseCodexUsage } from '../usage-parsers';
import type { UsageWindow } from '../types';
import { acquireWorkerLease } from './worker-lease';
import { workerCommand, type Command } from './runtime';

const execute = promisify(execFile);
const VERSION = '7.3.2';
const Receipt = z.object({
  profileId: BucketId,
  instance: z.string(),
  controlPort: z.number().int().positive(),
  proxyPort: z.number().int().positive(),
  pid: z.number().int().positive(),
  startedAt: z.string(),
});
export type Receipt = z.infer<typeof Receipt>;
const AuthFile = z.object({
  name: z.string(),
  auth_index: z.string(),
  email: z.string().optional(),
  account_id: z.string().optional(),
  // The management API returns selected decoded claims, not the token itself.
  id_token: z.object({ chatgpt_account_id: z.string().optional() }).optional(),
  provider: z.string().optional(),
  type: z.string().optional(),
  disabled: z.boolean().optional(),
  weight: z.number().optional(),
  status: z.string().optional(),
});
type AuthFile = z.infer<typeof AuthFile>;
const AccountUsage = z.object({
  name: z.string(),
  provider: z.enum(['codex', 'claude']).default('codex'),
  email: z.string().optional(),
  status: z.enum(['fresh', 'unknown', 'cooldown', 'disabled']),
  windows: z.array(
    z.object({
      label: z.string(),
      pct: z.number().min(0).max(100).nullable(),
      resetsAt: z.string().nullable(),
      severity: z.string().nullable().optional(),
    }),
  ),
  weight: z.number().int().nonnegative(),
  observedAt: z.string().optional(),
  nextProbeAt: z.number().optional(),
});
export type AccountUsage = z.infer<typeof AccountUsage>;

const WorkerStatus = z.object({ receipt: Receipt, accounts: z.array(AccountUsage), ready: z.boolean() });
export type WorkerStatus = z.infer<typeof WorkerStatus>;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function binary(): string {
  return process.env.SWITCHBOARD_PROXY_BINARY || path.join(root(), 'bin', `cliproxyapi-${VERSION}`, 'cli-proxy-api');
}

export async function installProxy(): Promise<string> {
  const architectures = {
    arm64: {
      asset: `CLIProxyAPI_${VERSION}_darwin_aarch64.tar.gz`,
      digest: '34376bc5823281668859a7b3e3688bb90eeb267d8f197a247605947a478af4ec',
    },
    x64: {
      asset: `CLIProxyAPI_${VERSION}_darwin_amd64.tar.gz`,
      digest: '975ce91feb82da9ef6a3b4403abe7f0d865fbbabb9ba4e46da5c0e280a8ece1d',
    },
  };
  if (process.platform !== 'darwin' || !(process.arch === 'arm64' || process.arch === 'x64'))
    throw new Error('Automatic proxy installation currently supports macOS only');
  const target = binary();
  if (fs.existsSync(target)) throw new Error(`Proxy already installed: ${target}`);
  const release = architectures[process.arch];
  const response = await fetch(
    `https://github.com/router-for-me/CLIProxyAPI/releases/download/v${VERSION}/${release.asset}`,
    { signal: AbortSignal.timeout(120000) },
  );
  if (!response.ok) throw new Error(`Proxy download failed: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(archive).digest('hex') !== release.digest)
    throw new Error('Proxy release checksum mismatch');
  fs.mkdirSync(path.dirname(path.dirname(target)), { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(path.dirname(path.dirname(target)), '.proxy-install-'));
  try {
    const file = path.join(staging, 'release.tar.gz');
    fs.writeFileSync(file, archive, { mode: 0o600 });
    await execute('tar', ['-xzf', file, '-C', staging, 'cli-proxy-api', 'LICENSE']);
    fs.unlinkSync(file);
    fs.chmodSync(path.join(staging, 'cli-proxy-api'), 0o700);
    fs.renameSync(staging, path.dirname(target));
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return target;
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to allocate proxy port');
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

export function proxyConfig(id: string, port: number): string {
  const directory = paths(id);
  const credentials = secrets(id);
  const file = path.join(directory.proxy, 'config.yaml');
  // JSON is a YAML subset, avoiding a second configuration serializer.
  writeJson(file, {
    host: '127.0.0.1',
    port,
    'auth-dir': directory.auth,
    'api-keys': [credentials.apiKey],
    'remote-management': {
      'allow-remote': false,
      'secret-key': credentials.managementKey,
      'disable-control-panel': true,
      'disable-auto-update-panel': true,
    },
    routing: {
      strategy: 'weighted-round-robin',
      'session-affinity': true,
      'session-affinity-ttl': '24h',
      'session-affinity-subagents': true,
    },
    'quota-exceeded': { 'switch-project': true, 'switch-preview-model': false },
    'request-retry': 1,
    'max-retry-credentials': 0,
    'max-retry-interval': 2,
    'save-cooldown-status': true,
    'logging-to-file': false,
    'request-log': false,
    'usage-statistics-enabled': false,
    codex: { 'stream-bootstrap-buffering': true },
  });
  return file;
}

async function management(
  id: string,
  port: number,
  endpoint: 'auth-files' | 'api-call' | 'auth-files/fields' | 'auth-files/status',
  method: 'GET' | 'POST' | 'PATCH' = 'GET',
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}/v0/management/${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${secrets(id).managementKey}`, 'Content-Type': 'application/json' },
    ...(method !== 'GET' && body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Proxy management ${endpoint}: HTTP ${response.status}`);
  return response.json();
}

export async function accounts(id: string, port: number): Promise<AuthFile[]> {
  const result = z.object({ files: z.array(AuthFile) }).parse(await management(id, port, 'auth-files'));
  return result.files.filter((file) => ['codex', 'claude'].includes(file.provider ?? file.type ?? ''));
}

export async function setAccountEnabled(id: string, port: number, name: string, enabled: boolean): Promise<void> {
  if (!(await accounts(id, port)).some((account) => account.name === name))
    throw new Error('Account is not in this bucket');
  await management(id, port, 'auth-files/status', 'PATCH', { name, disabled: !enabled });
}

export function usageRequest(account: AuthFile) {
  const provider = account.provider ?? account.type;
  const header: Record<string, string> = { Authorization: 'Bearer $TOKEN$', Accept: 'application/json' };
  if (provider === 'claude') {
    header['anthropic-beta'] = 'oauth-2025-04-20';
    return { url: 'https://api.anthropic.com/api/oauth/usage', header };
  }
  if (provider !== 'codex') throw new Error('Unsupported bucket provider');
  const accountId = account.account_id ?? account.id_token?.chatgpt_account_id;
  if (accountId) header['ChatGPT-Account-Id'] = accountId;
  return { url: 'https://chatgpt.com/backend-api/wham/usage', header };
}

export function quotaWeight(windows: readonly UsageWindow[]): number {
  const known = windows.filter((window) => window.pct !== null);
  const headroom = known.length ? Math.min(...known.map((window) => 100 - window.pct!)) : 50;
  // Keep a positive weight for nearly-exhausted accounts. Zero would evict a
  // healthy sticky session; actual quota errors are the proxy's authority.
  return Math.max(1, Math.round(headroom));
}
async function observe(id: string, port: number, account: AuthFile, previous?: AccountUsage): Promise<AccountUsage> {
  const base: AccountUsage = {
    name: account.name,
    provider: account.provider === 'claude' || account.type === 'claude' ? 'claude' : 'codex',
    email: account.email,
    status: 'unknown',
    windows: [],
    weight: account.weight ?? 50,
  };
  if (account.disabled) return { ...base, status: 'disabled' };
  if (previous?.nextProbeAt && previous.nextProbeAt > Date.now()) return previous;
  try {
    const result = z
      .object({
        status_code: z.number(),
        body: z.string(),
        header: z.record(z.string(), z.array(z.string())).optional(),
      })
      .parse(
        await management(id, port, 'api-call', 'POST', {
          auth_index: account.auth_index,
          method: 'GET',
          ...usageRequest(account),
        }),
      );
    switch (result.status_code) {
      case 200: {
        const windows = (base.provider === 'claude' ? parseClaudeUsage : parseCodexUsage)(JSON.parse(result.body));
        if (!windows.length) return previous ? { ...previous, status: 'unknown' } : base;
        const weight = quotaWeight(windows);
        if (weight !== account.weight)
          await management(id, port, 'auth-files/fields', 'PATCH', { name: account.name, weight });
        return { ...base, status: 'fresh', windows, weight, observedAt: new Date().toISOString() };
      }
      case 429:
        return { ...(previous ?? base), status: 'cooldown', nextProbeAt: Date.now() + 15 * 60_000 };
      default:
        return previous ? { ...previous, status: 'unknown' } : base;
    }
  } catch {
    return previous ? { ...previous, status: 'unknown' } : base;
  }
}
export function receipt(id: string): Receipt | undefined {
  const file = path.join(paths(id).runtime, 'worker.json');
  return fs.existsSync(file) ? Receipt.parse(readJson(file)) : undefined;
}
export async function control(id: string, action: 'status' | 'refresh' | 'stop'): Promise<WorkerStatus | undefined> {
  const current = receipt(id);
  if (!current || current.profileId !== id) return undefined;
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${current.controlPort}/${action}`, {
      method: action === 'status' ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${secrets(id).managementKey}`, 'X-Switchboard-Instance': current.instance },
      signal: AbortSignal.timeout(action === 'refresh' ? 90000 : 3000),
    });
  } catch {
    return undefined;
  }

  if (!response.ok) throw new Error(`Worker ${action} failed: HTTP ${response.status}`);
  const value = WorkerStatus.parse(await response.json());
  if (value.receipt.instance !== current.instance || value.receipt.profileId !== id)
    throw new Error('Worker identity mismatch');
  return value;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function assertWorkerAbsent(id: string): Promise<void> {
  const previous = receipt(id);
  if (!previous) return;
  if (processAlive(previous.pid))
    throw new Error(`Profile ${id}'s worker is alive but unreachable or stopping. A second worker was not started.`);

  let orphaned = false;
  try {
    await accounts(id, previous.proxyPort);
    orphaned = true;
  } catch {
    /* No authenticated proxy remains at the old address. */
  }

  if (orphaned)
    throw new Error(
      `Profile ${id} has a live proxy without its controller. Inspect ${paths(id).runtime} before recovery.`,
    );
}
export async function ensureWorker(id: string, worker: Command = workerCommand()): Promise<WorkerStatus> {
  load(id);
  const running = await control(id, 'status');
  if (running?.ready) return running;

  await assertWorkerAbsent(id);

  if (!fs.existsSync(binary())) throw new Error('Install the routing worker first: oc proxy-install');
  const lock = path.join(paths(id).runtime, 'starting.lock');
  let owner = false;
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
    owner = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (!alive) {
      fs.unlinkSync(lock);
      return ensureWorker(id, worker);
    }
  }
  try {
    if (owner) {
      const startedMeanwhile = await control(id, 'status');
      if (startedMeanwhile?.ready) return startedMeanwhile;
      await assertWorkerAbsent(id);
      const log = path.join(paths(id).runtime, 'worker.log');
      if (fs.existsSync(log) && fs.statSync(log).size > 4 * 1024 * 1024) fs.renameSync(log, `${log}.previous`);
      const fd = fs.openSync(log, 'a', 0o600);
      const child = spawn(worker.execPath, [worker.script, 'worker', id], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        detached: true,
        stdio: ['ignore', fd, fd],
        cwd: paths(id).runtime,
      });
      child.on('error', () => {});
      child.unref();
      fs.closeSync(fd);
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = await control(id, 'status');
      if (status?.ready) return status;
      await delay(200);
    }
    throw new Error(`Worker did not start. Inspect ${path.join(paths(id).runtime, 'worker.log')}`);
  } finally {
    if (owner && fs.existsSync(lock)) fs.unlinkSync(lock);
  }
}

export async function runWorker(id: string): Promise<void> {
  load(id);
  const release = acquireWorkerLease(path.join(paths(id).runtime, 'worker.lock'));

  try {
    const existing = await control(id, 'status');
    if (existing?.ready) throw new Error(`Profile ${id} already has a running worker`);
    await assertWorkerAbsent(id);
    await serveWorker(id);
  } finally {
    release();
  }
}

async function serveWorker(id: string): Promise<void> {
  const profile = load(id);
  const directory = paths(id);
  const proxyPort = await freePort();
  const configFile = proxyConfig(id, proxyPort);
  const child = spawn(binary(), ['-config', configFile], {
    cwd: directory.proxy,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  let exited = false;
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let currentAccounts: AccountUsage[] = [];
  let refreshPromise: Promise<void> | undefined;
  const token = secrets(id).managementKey;
  const worker: Receipt = {
    profileId: profile.id,
    instance: randomUUID(),
    controlPort: 0,
    proxyPort,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  const status = (): WorkerStatus => ({ receipt: worker, accounts: currentAccounts, ready: !exited && !stopping });
  const refresh = (): Promise<void> => {
    refreshPromise ??= (async () => {
      const available = await accounts(id, proxyPort);
      const next: AccountUsage[] = [];
      for (const account of available)
        next.push(
          await observe(
            id,
            proxyPort,
            account,
            currentAccounts.find((item) => item.name === account.name),
          ),
        );
      currentAccounts = next;
      writeJson(path.join(directory.runtime, 'usage.json'), currentAccounts);
    })().finally(() => {
      refreshPromise = undefined;
    });
    return refreshPromise;
  };
  const server = http.createServer((request, response) => {
    if (
      request.headers.authorization !== `Bearer ${token}` ||
      request.headers['x-switchboard-instance'] !== worker.instance
    ) {
      response.writeHead(401).end();
      return;
    }
    const reply = () => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(status()));
    };
    switch (`${request.method} ${request.url}`) {
      case 'GET /status':
        reply();
        break;
      case 'POST /refresh':
        void refresh()
          .then(reply)
          .catch(() => {
            response.writeHead(502).end();
          });
        break;
      case 'POST /stop':
        reply();
        void stop();
        break;
      default:
        response.writeHead(404).end();
    }
  });
  let finish: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  async function stop() {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    server.close();
    child.kill('SIGTERM');
    for (let attempt = 0; attempt < 50 && !exited; attempt++) await delay(100);
    if (!exited) child.kill('SIGKILL');
    const saved = receipt(id);
    if (saved?.instance === worker.instance) fs.rmSync(path.join(directory.runtime, 'worker.json'), { force: true });
    finish();
  }
  child.once('error', () => {
    exited = true;
    void stop();
  });
  child.once('exit', () => {
    exited = true;
    void stop();
  });
  process.once('SIGTERM', () => {
    void stop();
  });
  process.once('SIGINT', () => {
    void stop();
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 80 && !exited && !ready; attempt++) {
      try {
        await accounts(id, proxyPort);
        ready = true;
      } catch {
        await delay(200);
      }
    }
    if (!ready) throw new Error('Proxy did not become ready');
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Control server address is unavailable');
    worker.controlPort = address.port;
    writeJson(path.join(directory.runtime, 'worker.json'), worker);
    const tick = async () => {
      try {
        await refresh();
      } catch {
        /* An unavailable quota endpoint must not take inference down. */
      }
      if (!stopping)
        timer = setTimeout(() => {
          void tick();
        }, 2 * 60_000);
    };
    void tick();
    await finished;
  } finally {
    await stop();
  }
}
