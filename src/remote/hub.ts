// Phone access: a small HTTP server in the app's main process that serves the
// phone app and, to paired phones only, what every profile's agents are doing.
//
// It listens on 127.0.0.1 alone. The phone reaches it through `tailscale
// serve`, which terminates HTTPS on the tailnet and forwards to this port, so
// nothing is exposed beyond the person's own devices and the app needs no
// certificate of its own. Requests must name localhost or a *.ts.net host,
// which shuts out a web page that rebinds its own name to 127.0.0.1, and API
// calls must come from the same origin.
//
// The API is the tRPC router in api.ts, under /api/trpc/. This module serves
// the app shell, which holds no data, and decides when the overview may have
// changed: on file events in any profile's session folders, and on a timer
// for what is not a file (an app starting, new usage numbers), but only while
// a phone is listening.

import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHTTPHandler } from '@trpc/server/adapters/standalone';
import type { AppState, Vendor } from '../types';
import { createContext, createRouter } from './api';
import { SessionReader, watch, type ProfileHome, type SessionSummary } from './sessions';

export const DEFAULT_PORT = 47821;
export const API_BASE = '/api/trpc/';
// Session files are watched; this catches what is not a file.
const CHECK_MS = 5000;

export interface HubProfile {
  id: string;
  name: string;
  vendor: Vendor;
  color: string;
  isDefault: boolean;
  email: string | null;
  plan: string | null;
  app: AppState | null;
  windows: { label: string; pct: number | null; resetsAt: string | null }[];
}

export interface Overview {
  host: string;
  generatedAt: string;
  profiles: HubProfile[];
  sessions: SessionSummary[];
}

// What the hub reads from whoever hosts it: the app, or a test.
export interface HubSource {
  profiles(): HubProfile[];
  homes(): ProfileHome[];
}

export interface Hub {
  port: number;
  close(): Promise<void>;
}

const ALLOWED_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net)(:\d+)?$/i;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

const CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
  "manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'";

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

// The name people gave this Mac ("Shayaan's MacBook Pro"). The network host
// name can be an address, which tells a phone nothing.
let computer: string | null = null;
function computerName(): string {
  if (computer) return computer;
  try {
    computer = execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2000 }).trim();
  } catch {
    // Not macOS, or scutil refused.
  }
  computer ||= os.hostname().replace(/\.local$/, '');
  return computer;
}

export function overview(source: HubSource, reader: SessionReader, now = Date.now()): Overview {
  return {
    host: computerName(),
    generatedAt: new Date(now).toISOString(),
    profiles: source.profiles(),
    sessions: reader.list(source.homes(), now),
  };
}

// Emits 'change' while anyone listens: on file events in the profiles'
// session folders, and every CHECK_MS. Watching starts with the first
// listener and stops with the last.
function changeSignal(source: HubSource): { changes: EventEmitter; stop(): void } {
  const changes = new EventEmitter();
  changes.setMaxListeners(50);
  let watching = '';
  let stopWatching: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const emit = () => changes.emit('change');
  const follow = () => {
    const homes = source.homes();
    const key = JSON.stringify(homes);
    if (key === watching) return;
    stopWatching?.();
    watching = key;
    stopWatching = watch(homes, emit);
  };
  const stop = () => {
    stopWatching?.();
    stopWatching = null;
    watching = '';
    if (timer) clearInterval(timer);
    timer = null;
  };
  changes.on('newListener', (event) => {
    if (event !== 'change' || timer) return;
    follow();
    timer = setInterval(() => {
      follow();
      emit();
    }, CHECK_MS);
  });
  changes.on('removeListener', (event) => {
    if (event === 'change' && changes.listenerCount('change') === 0) stop();
  });
  return { changes, stop };
}

export function startHub(options: {
  source: HubSource;
  staticDir: string;
  port?: number;
  host?: string;
}): Promise<Hub> {
  const { source, staticDir } = options;
  const reader = new SessionReader();
  const signal = changeSignal(source);
  const router = createRouter({
    overview: () => overview(source, reader),
    transcript: (profileId, sessionId, before) => reader.transcript(source.homes(), profileId, sessionId, before),
    changes: signal.changes,
  });
  const api = createHTTPHandler({ router, createContext, basePath: API_BASE });

  function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    const file = path.resolve(staticDir, rel);
    if (!file.startsWith(path.resolve(staticDir) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      // Unknown paths get the app, so a link into it still opens.
      if (!path.extname(rel)) return serveStatic(req, res, '/');
      res.writeHead(404, SECURITY_HEADERS).end();
      return;
    }
    const ext = path.extname(file);
    // The page and the worker must never go stale on the phone; the rest is
    // named by the build and can be cached briefly.
    const fresh = ext === '.html' || rel === 'sw.js' || ext === '.webmanifest';
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': TYPES[ext] ?? 'application/octet-stream',
      'cache-control': fresh ? 'no-cache' : 'max-age=300',
      ...(ext === '.html' ? { 'content-security-policy': CSP } : {}),
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
  }

  function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const host = req.headers.host ?? '';
    if (!ALLOWED_HOST.test(host)) return send(res, 421, { error: 'wrong-host' });
    const url = new URL(req.url ?? '/', `http://${host}`);
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method' });
      return serveStatic(req, res, url.pathname);
    }
    // A cross-site page can send a request; it cannot make it look same-origin.
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== host) return send(res, 403, { error: 'cross-origin' });
    if (url.pathname === '/api/health') return send(res, 200, { app: 'switchboard' });
    if (url.pathname.startsWith(API_BASE)) {
      res.setHeader('cache-control', 'no-store');
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
      return void api(req, res);
    }
    send(res, 404, { error: 'not-found' });
  }

  const server = http.createServer((req, res) => {
    try {
      handle(req, res);
    } catch {
      if (!res.headersSent) send(res, 500, { error: 'failed' });
      else res.end();
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? DEFAULT_PORT, options.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address ? address.port : (options.port ?? DEFAULT_PORT),
        close: () =>
          new Promise<void>((done) => {
            signal.stop();
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
