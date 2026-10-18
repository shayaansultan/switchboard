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
// a phone is listening or one wants notifications.
//
// It also runs the control socket (control.ts) the Claude plugin and the
// Codex wrapper reply and approve through, and sends notifications
// (notify.ts, push.ts) when the overview changes in a way a phone asked about.

import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHTTPHandler } from '@trpc/server/adapters/standalone';
import type { AppState, Vendor } from '../types';
import { createContext, createRouter, tokenFrom } from './api';
import { HTML_POLICY, readMedia, resolveMedia } from './media';
import { Control, type Pending } from './control';
import { changes as noteChanges, emptyWatch, type Watch } from './notify';
import { authenticate } from './pairing';
import { anySubscribed, push } from './push';
import { MAX_UPLOAD, saveUpload, sweepUploads } from './uploads';
import { SessionReader, watch, type ProfileHome, type SessionSummary } from './sessions';

export const DEFAULT_PORT = 47821;
export const API_BASE = '/api/trpc/';
// Session files are watched; this catches what is not a file.
const CHECK_MS = 5000;

export interface HubProfile {
  id: string;
  name: string;
  // The name the phone shows: the profile's name, with its app added when
  // another profile has the same name (Default · Claude, Default · Codex).
  label: string;
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
  // Requests waiting on the person that the phone can answer (control.ts).
  pending: Pending[];
  // `${profileId}/${sessionId}` of each session a reply from the phone reaches.
  reachable: string[];
  // Recent replies that reached the app but did not go through, by the same key.
  failures: Record<string, string>;
}

// What the hub reads from whoever hosts it: the app, or a test.
export interface HubSource {
  profiles(): Omit<HubProfile, 'label'>[];
  homes(): ProfileHome[];
  // Whether nobody is at the Mac (locked or idle). Without it, never.
  away?(): boolean;
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
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; " +
  "manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'";

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

// The name people gave this Mac ("Alex's MacBook Pro"). The network host
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

const APP_NAME: Record<Vendor, string> = { claude: 'Claude', codex: 'Codex' };

export function labelled(profiles: Omit<HubProfile, 'label'>[]): HubProfile[] {
  const count = new Map<string, number>();
  for (const p of profiles) count.set(p.name.toLowerCase(), (count.get(p.name.toLowerCase()) ?? 0) + 1);
  return profiles.map((p) => ({
    ...p,
    label: (count.get(p.name.toLowerCase()) ?? 0) > 1 ? `${p.name} · ${APP_NAME[p.vendor]}` : p.name,
  }));
}

export function overview(source: HubSource, reader: SessionReader, control?: Control, now = Date.now()): Overview {
  const sessions = reader.list(source.homes(), now);
  const live = control?.reachable() ?? { claude: [], codex: [] };
  const claude = new Set(live.claude);
  const codex = new Set(live.codex);
  return {
    host: computerName(),
    generatedAt: new Date(now).toISOString(),
    profiles: labelled(source.profiles()),
    sessions,
    pending: control?.pending() ?? [],
    failures: control?.failures() ?? {},
    reachable: sessions
      .filter((s) => (s.vendor === 'claude' ? claude.has(`${s.profileId}/${s.id}`) : codex.has(s.profileId)))
      .map((s) => `${s.profileId}/${s.id}`),
  };
}

// Watches the overview for what phones asked to be told about, while any
// phone wants notifications. The first look only seeds what is known.
function notifier(look: () => Overview, changes: EventEmitter, away: () => boolean): { sync(): void; stop(): void } {
  let watch: Watch | null = null;
  let busy = false;
  const check = () => {
    if (busy) return;
    busy = true;
    try {
      const o = look();
      // A Codex approval also shows on the desktop; buzz the phone for it only
      // while nobody is at the Mac. Claude's only reach the phone then anyway.
      const asking = away() ? o.pending.map((p) => ({ ...p, title: `${p.title}: ${p.detail}`.slice(0, 120) })) : [];
      const result = noteChanges(watch ?? emptyWatch(), o, asking, Date.now(), watch === null);
      watch = result.watch;
      for (const note of result.notes) void push(note).catch(() => {});
    } catch {
      // A file vanished mid-read; the next change looks again.
    } finally {
      busy = false;
    }
  };
  let on = false;
  return {
    sync() {
      const want = anySubscribed();
      if (want === on) return;
      on = want;
      if (want) {
        changes.on('quiet', check);
        check();
      } else {
        changes.off('quiet', check);
        watch = null;
      }
    },
    stop() {
      changes.off('quiet', check);
      on = false;
    },
  };
}

// Emits 'change' on file events in the profiles' session folders and on a
// timer for what is not a file (an app starting, new usage numbers), while
// anyone listens. A phone with the app open listens for 'change' and gets
// the timer every CHECK_MS; the notifier listens for 'quiet' and, when it is
// the only listener, the timer runs every QUIET_MS. Watching starts with the
// first listener of either and stops with the last.
const QUIET_MS = 60_000;

function changeSignal(source: HubSource): { changes: EventEmitter; emit(): void; stop(): void } {
  const changes = new EventEmitter();
  changes.setMaxListeners(50);
  let watching = '';
  let stopWatching: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let every = 0;
  const emit = () => {
    changes.emit('change');
    changes.emit('quiet');
  };
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
    every = 0;
  };
  // Listener counts change after these events fire, so look a tick later.
  const settle = () =>
    queueMicrotask(() => {
      const live = changes.listenerCount('change');
      if (!live && !changes.listenerCount('quiet')) return stop();
      follow();
      const want = live ? CHECK_MS : QUIET_MS;
      if (want === every) return;
      if (timer) clearInterval(timer);
      every = want;
      timer = setInterval(() => {
        follow();
        emit();
      }, want);
    });
  changes.on('newListener', (event) => {
    if (event === 'change' || event === 'quiet') settle();
  });
  changes.on('removeListener', (event) => {
    if (event === 'change' || event === 'quiet') settle();
  });
  return { changes, emit, stop };
}

export function startHub(options: {
  source: HubSource;
  staticDir: string;
  port?: number;
  host?: string;
  // The control socket; tests that do not need it pass false.
  control?: false;
}): Promise<Hub> {
  const { source, staticDir } = options;
  const reader = new SessionReader();
  const signal = changeSignal(source);
  const away = () => source.away?.() ?? false;
  const control = options.control === false ? undefined : new Control({ away, onChange: signal.emit });
  const look = () => overview(source, reader, control);
  const notes = notifier(look, signal.changes, away);
  sweepUploads();
  notes.sync();
  const router = createRouter({
    overview: look,
    control,
    notificationsChanged: () => notes.sync(),
    vendorOf: (profileId) => source.profiles().find((p) => p.id === profileId)?.vendor ?? null,
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

  // A picture or file a session refers to, by the signed id its transcript
  // gave (media.ts). Paired phones only, like the API.
  function serveMedia(req: http.IncomingMessage, res: http.ServerResponse, id: string): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method' });
    if (!authenticate(tokenFrom(req))) return send(res, 401, { error: 'not-paired' });
    const ref = resolveMedia(decodeURIComponent(id));
    const media = ref && readMedia(ref);
    if (!media) return send(res, 404, { error: 'no-such-media' });
    const active = media.type.startsWith('text/html') || media.type === 'image/svg+xml';
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': media.type,
      'content-length': String(media.size),
      'cache-control': 'private, max-age=3600',
      'content-disposition': `${media.type.startsWith('image/') || media.type === 'application/pdf' || active ? 'inline' : 'attachment'}; filename="${media.name.replace(/[^\w.-]/g, '_')}"`,
      // HTML and SVG run sandboxed, without the device cookie or the network;
      // anything else is never run at all.
      'content-security-policy': active ? HTML_POLICY : "default-src 'none'; sandbox",
      ...(active ? { 'x-frame-options': 'SAMEORIGIN' } : {}),
    });
    if (req.method === 'HEAD') {
      if ('destroy' in media.body) media.body.destroy();
      return void res.end();
    }
    if (Buffer.isBuffer(media.body)) res.end(media.body);
    else {
      // The file can vanish or fail after it was found; an error on the
      // stream would otherwise escape this handler.
      media.body.on('error', () => res.destroy());
      media.body.pipe(res);
    }
  }

  // A picture or file attached to a reply (uploads.ts). Paired phones only;
  // the body is the file, its name in x-file-name.
  function receiveUpload(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    if (!authenticate(tokenFrom(req))) return send(res, 401, { error: 'not-paired' });
    if (Number(req.headers['content-length'] ?? 0) > MAX_UPLOAD) return send(res, 413, { error: 'too-large' });
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_UPLOAD) {
        send(res, 413, { error: 'too-large' });
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (res.headersSent) return;
      let name = 'file';
      try {
        name = decodeURIComponent(String(req.headers['x-file-name'] ?? 'file'));
      } catch {
        // Keep the default.
      }
      try {
        const up = saveUpload(name, String(req.headers['content-type'] ?? ''), Buffer.concat(chunks));
        send(res, 200, { id: up.id, name: up.name, type: up.type, size: up.size });
      } catch {
        send(res, 500, { error: 'not-saved' });
      }
    });
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
    if (url.pathname.startsWith('/api/media/')) return serveMedia(req, res, url.pathname.slice('/api/media/'.length));
    if (url.pathname === '/api/upload') return receiveUpload(req, res);
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
    server.listen(options.port ?? DEFAULT_PORT, options.host ?? '127.0.0.1', async () => {
      server.off('error', reject);
      // Without the socket the phone still reads everything; it cannot reply.
      await control?.listen().catch(() => {});
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address ? address.port : (options.port ?? DEFAULT_PORT),
        close: () =>
          new Promise<void>((done) => {
            notes.stop();
            void control?.close();
            signal.stop();
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
