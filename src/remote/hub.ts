// Phone access: a small HTTP server in the app's main process that serves the
// phone app and, to paired phones only, what every profile's agents are doing.
//
// It listens on 127.0.0.1 alone. The phone reaches it through `tailscale
// serve`, which terminates HTTPS on the tailnet and forwards to this port, so
// nothing is exposed beyond the person's own devices and the app needs no
// certificate of its own. Requests must name localhost or a *.ts.net host,
// which shuts out a web page that rebinds its own name to 127.0.0.1.
//
// Read-only for now: sessions come from the files the apps write (see
// sessions.ts), and profiles from the app's own state. Every data route needs
// a device token from pairing.ts; the app shell itself holds no data.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import type { AppState, Vendor } from '../types';
import { authenticate, pair } from './pairing';
import { SessionReader, watch, type ProfileHome, type SessionSummary } from './sessions';

export const DEFAULT_PORT = 47821;
// Session files are watched; this catches what is not a file, such as an
// app starting or new usage numbers.
const STREAM_CHECK_MS = 5000;
const HEARTBEAT_MS = 25_000;
const MAX_BODY = 4096;

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

function bearer(req: http.IncomingMessage): string | null {
  const header = req.headers.authorization;
  const m = header && /^Bearer\s+(\S+)$/i.exec(header);
  return m ? m[1] : null;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const PairBody = z.object({ code: z.string().min(1).max(32), name: z.string().max(200).optional() });

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

// What changes the phone should hear about; generatedAt always differs.
const fingerprint = (o: Overview): string => JSON.stringify({ p: o.profiles, s: o.sessions });

export function startHub(options: {
  source: HubSource;
  staticDir: string;
  port?: number;
  host?: string;
}): Promise<Hub> {
  const { source, staticDir } = options;
  const reader = new SessionReader();
  const streams = new Map<http.ServerResponse, () => void>();
  // One watcher over every profile's session folders, rebuilt when the set
  // of profiles changes, telling each open stream to look again.
  let watching = '';
  let stopWatching: (() => void) | null = null;
  const ensureWatching = () => {
    const homes = source.homes();
    const key = JSON.stringify(homes);
    if (key === watching) return;
    stopWatching?.();
    watching = key;
    stopWatching = watch(homes, () => {
      for (const push of streams.values()) push();
    });
  };

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

  function stream(res: http.ServerResponse): void {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    let last = '';
    let lastWrite = Date.now();
    const push = () => {
      try {
        const o = overview(source, reader);
        const print = fingerprint(o);
        if (print !== last) {
          last = print;
          res.write(`data: ${JSON.stringify(o)}\n\n`);
          lastWrite = Date.now();
        } else if (Date.now() - lastWrite > HEARTBEAT_MS) {
          res.write(': keep-alive\n\n');
          lastWrite = Date.now();
        }
      } catch {
        // A file vanished between list and read; the next tick sees the new state.
      }
    };
    streams.set(res, push);
    ensureWatching();
    push();
    const timer = setInterval(() => {
      ensureWatching();
      push();
    }, STREAM_CHECK_MS);
    res.on('close', () => {
      clearInterval(timer);
      streams.delete(res);
      if (!streams.size) {
        stopWatching?.();
        stopWatching = null;
        watching = '';
      }
    });
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const host = req.headers.host ?? '';
    if (!ALLOWED_HOST.test(host)) {
      send(res, 421, { error: 'wrong-host' });
      return;
    }
    const url = new URL(req.url ?? '/', `http://${host}`);
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method' });
      return serveStatic(req, res, url.pathname);
    }
    // A cross-site page can send a request; it cannot make it look same-origin.
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== host) return send(res, 403, { error: 'cross-origin' });

    if (url.pathname === '/api/health') return send(res, 200, { app: 'switchboard' });

    if (url.pathname === '/api/pair') {
      if (req.method !== 'POST') return send(res, 405, { error: 'method' });
      let body: z.infer<typeof PairBody>;
      try {
        body = PairBody.parse(JSON.parse(await readBody(req)));
      } catch {
        return send(res, 400, { error: 'bad-request' });
      }
      const result = pair(body.code, body.name ?? 'Phone');
      if (!result.ok) return send(res, 401, { error: result.reason === 'expired' ? 'code-expired' : 'code-wrong' });
      return send(res, 200, { token: result.token, device: result.device });
    }

    const device = authenticate(bearer(req));
    if (!device) return send(res, 401, { error: 'not-paired' });
    if (req.method !== 'GET') return send(res, 405, { error: 'method' });

    switch (url.pathname) {
      case '/api/overview':
        return send(res, 200, overview(source, reader));
      case '/api/session': {
        const profile = url.searchParams.get('profile') ?? '';
        const id = url.searchParams.get('id') ?? '';
        const before = Number(url.searchParams.get('before'));
        const transcript = reader.transcript(
          source.homes(),
          profile,
          id,
          Number.isInteger(before) && before > 0 ? before : null,
        );
        if (!transcript) return send(res, 404, { error: 'no-such-session' });
        return send(res, 200, transcript);
      }
      case '/api/stream':
        return stream(res);
      case '/api/me':
        return send(res, 200, { device });
      default:
        return send(res, 404, { error: 'not-found' });
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: 'failed' });
      else res.end();
    });
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
            stopWatching?.();
            for (const s of streams.keys()) s.destroy();
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
