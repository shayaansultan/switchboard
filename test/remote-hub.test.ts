// Phone access exposes transcripts, so the gate matters more than the pages:
// only a paired phone reads data, pairing hands back a cookie scripts cannot
// read rather than a token, a code works once and not forever, unpairing takes
// effect at once, and other hosts and other origins are turned away. The live
// stream must notice a session file changing without being asked.

import { test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { createTRPCClient, httpLink, TRPCClientError } from '@trpc/client';
import { sandboxHome } from './setup';
import { startHub, type Hub, type HubSource } from '../src/remote/hub';
import type { ApiRouter } from '../src/remote/api';
import { authenticate, CODE_TTL_MS, newCode, pair, remoteDir, revoke } from '../src/remote/pairing';

if (!remoteDir().startsWith(sandboxHome + path.sep))
  throw new Error(`refusing to run outside the sandbox: ${remoteDir()}`);

const staticDir = path.join(sandboxHome, 'phone-static');
const claudeHome = path.join(sandboxHome, 'hub-claude');
const source: HubSource = {
  profiles: () => [
    {
      id: 'claude-work',
      name: 'Work',
      vendor: 'claude',
      color: '#000000',
      isDefault: false,
      email: 'me@example.com',
      plan: 'Max',
      app: 'running',
      windows: [],
    },
  ],
  homes: () => [{ id: 'claude-work', vendor: 'claude', home: claudeHome }],
};

let hub: Hub;
beforeEach(async () => {
  fs.rmSync(remoteDir(), { recursive: true, force: true });
  fs.rmSync(claudeHome, { recursive: true, force: true });
  fs.mkdirSync(path.join(claudeHome, 'projects', 'p'), { recursive: true });
  fs.mkdirSync(staticDir, { recursive: true });
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>app</title>');
  fs.writeFileSync(path.join(sandboxHome, 'secret.txt'), 'secret');
  hub = await startHub({ source, staticDir, port: 0 });
});
afterEach(() => hub.close());

const base = () => `http://127.0.0.1:${hub.port}`;

// A client that keeps the cookie the hub sets, as a browser would.
function client(extra: Record<string, string> = {}) {
  const jar = { cookie: '', setCookie: '' };
  const trpc = createTRPCClient<ApiRouter>({
    links: [
      httpLink({
        url: `${base()}/api/trpc`,
        headers: () => ({ ...(jar.cookie ? { cookie: jar.cookie } : {}), ...extra }),
        fetch: async (url, init) => {
          const res = await fetch(url, init as RequestInit);
          const set = res.headers.get('set-cookie');
          if (set) {
            jar.setCookie = set;
            jar.cookie = set.split(';')[0];
          }
          return res;
        },
      }),
    ],
  });
  return { trpc, jar };
}

const code = (e: unknown) => (e instanceof TRPCClientError ? (e.data as { code?: string })?.code : String(e));

test('data needs a paired device, and pairing sets a cookie scripts cannot read, once per code', async () => {
  const phone = client();
  expect(await phone.trpc.overview.query().catch(code)).toBe('UNAUTHORIZED');

  const { code: pairing } = newCode();
  const paired = await phone.trpc.pair.mutate({ code: pairing.toLowerCase(), name: 'Test phone' });
  expect(JSON.stringify(paired)).not.toContain('token');
  expect(phone.jar.setCookie).toMatch(/^sb_device=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=\d+$/);
  expect((await phone.trpc.overview.query()).profiles.map((p) => p.id)).toEqual(['claude-work']);

  const again = await client()
    .trpc.pair.mutate({ code: pairing })
    .catch((e: TRPCClientError<ApiRouter>) => e.message);
  expect(again).toBe('code-expired');
});

test('unpairing, from the Mac or from the phone itself, shuts it out on its next request', async () => {
  const phone = client();
  const { device } = await phone.trpc.pair.mutate({ code: newCode().code });
  expect((await phone.trpc.me.query()).device.id).toBe(device.id);
  revoke(device.id);
  expect(await phone.trpc.me.query().catch(code)).toBe('UNAUTHORIZED');

  const other = client();
  await other.trpc.pair.mutate({ code: newCode().code });
  await other.trpc.unpair.mutate();
  expect(other.jar.setCookie).toContain('Max-Age=0');
  expect(await other.trpc.me.query().catch(code)).toBe('UNAUTHORIZED');
});

test('a code stops working after it expires or after five wrong guesses', () => {
  const now = Date.now();
  const expiring = newCode(now).code;
  expect(pair(expiring, 'p', now + CODE_TTL_MS + 1)).toEqual({ ok: false, reason: 'expired' });

  const { code: right } = newCode(now);
  for (let i = 0; i < 5; i++) expect(pair('WRONG-CODE', 'p', now).ok).toBe(false);
  expect(pair(right, 'p', now)).toEqual({ ok: false, reason: 'expired' });
  expect(authenticate('not-a-token')).toBeNull();
});

test('requests for another host name, or from another origin, are refused', async () => {
  // fetch cannot forge Host, so speak HTTP directly.
  const raw = await new Promise<string>((resolve) => {
    const socket = net.connect(hub.port, '127.0.0.1', () =>
      socket.write('GET /api/health HTTP/1.1\r\nHost: evil.example:80\r\nConnection: close\r\n\r\n'),
    );
    let text = '';
    socket.on('data', (c) => (text += c.toString()));
    socket.on('end', () => resolve(text));
  });
  expect(raw.startsWith('HTTP/1.1 421')).toBe(true);
  const hostile = client({ origin: 'https://evil.example' });
  const outcome = await hostile.trpc.pair.mutate({ code: newCode().code }).then(
    () => 'accepted',
    () => 'refused',
  );
  expect(outcome).toBe('refused');
  expect(hostile.jar.setCookie).toBe('');
});

test('the app shell is served, and paths outside it are not', async () => {
  expect(await (await fetch(`${base()}/`)).text()).toContain('<title>app</title>');
  expect(await (await fetch(`${base()}/s/anything`)).text()).toContain('<title>app</title>');
  expect(await (await fetch(`${base()}/..%2Fsecret.txt`)).text()).not.toContain('secret');
});

test('the live stream sends the overview, then again when a session file changes', async () => {
  const phone = client();
  await phone.trpc.pair.mutate({ code: newCode().code });
  const controller = new AbortController();
  const res = await fetch(`${base()}/api/trpc/live`, {
    headers: { cookie: phone.jar.cookie, accept: 'text/event-stream' },
    signal: controller.signal,
  });
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const overviews = async (n: number, timeoutMs: number) => {
    const found: { sessions: { title: string }[] }[] = [];
    const deadline = Date.now() + timeoutMs;
    while (found.length < n && Date.now() < deadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((r) =>
          setTimeout(() => r({ value: undefined, done: true }), deadline - Date.now()),
        ),
      ]);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let at: number;
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const data = buffer
          .slice(0, at)
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('');
        buffer = buffer.slice(at + 2);
        try {
          const parsed = JSON.parse(data);
          if (Array.isArray(parsed?.sessions)) found.push(parsed);
        } catch {
          // A ping or the connection event.
        }
      }
    }
    return found;
  };
  const [first] = await overviews(1, 3000);
  expect(first.sessions).toEqual([]);

  const record = {
    type: 'user',
    sessionId: 'live1',
    cwd: '/x',
    entrypoint: 'claude-desktop',
    timestamp: '2026-10-18T01:00:00Z',
    message: { role: 'user', content: 'Ship the stream' },
  };
  fs.writeFileSync(path.join(claudeHome, 'projects', 'p', 'live1.jsonl'), JSON.stringify(record) + '\n');
  // A file event arrives within moments; the 5 s timer is the fallback, so allow for it.
  const [second] = await overviews(1, 7000);
  controller.abort();
  expect(second.sessions.map((s) => s.title)).toEqual(['Ship the stream']);
});
