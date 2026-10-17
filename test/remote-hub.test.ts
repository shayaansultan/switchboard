// Phone access exposes transcripts, so the gate matters more than the
// pages: only a paired phone reads data, a pairing code works once and not
// forever, unpairing takes effect at once, and a page that rebinds its own
// name to 127.0.0.1 is turned away.

import { test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sandboxHome } from './setup';
import { startHub, type Hub, type HubSource } from '../src/remote/hub';
import { authenticate, CODE_TTL_MS, newCode, pair, remoteDir, revoke } from '../src/remote/pairing';

if (!remoteDir().startsWith(sandboxHome + path.sep))
  throw new Error(`refusing to run outside the sandbox: ${remoteDir()}`);

const staticDir = path.join(sandboxHome, 'phone-static');
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
  homes: () => [{ id: 'claude-work', vendor: 'claude', home: path.join(sandboxHome, 'no-such-home') }],
};

let hub: Hub;
beforeEach(async () => {
  fs.rmSync(remoteDir(), { recursive: true, force: true });
  fs.mkdirSync(staticDir, { recursive: true });
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>app</title>');
  fs.writeFileSync(path.join(sandboxHome, 'secret.txt'), 'secret');
  hub = await startHub({ source, staticDir, port: 0 });
});
afterEach(() => hub.close());

const url = (p: string) => `http://127.0.0.1:${hub.port}${p}`;
const get = (p: string, headers: Record<string, string> = {}) => fetch(url(p), { headers });
const postPair = (code: string, headers: Record<string, string> = {}) =>
  fetch(url('/api/pair'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ code, name: 'Test phone' }),
  });

test('data needs a paired device; the pairing code from the CLI pairs once', async () => {
  expect((await get('/api/overview')).status).toBe(401);
  const { code } = newCode();
  const first = await postPair(code.toLowerCase());
  expect(first.status).toBe(200);
  const { token } = (await first.json()) as { token: string };
  expect((await postPair(code)).status).toBe(401);

  const overview = await get('/api/overview', { authorization: `Bearer ${token}` });
  expect(overview.status).toBe(200);
  expect(((await overview.json()) as { profiles: { id: string }[] }).profiles.map((p) => p.id)).toEqual([
    'claude-work',
  ]);
});

test('unpairing a phone shuts it out on its next request', async () => {
  newCode();
  const { code } = newCode();
  const { token, device } = (await (await postPair(code)).json()) as { token: string; device: { id: string } };
  expect((await get('/api/me', { authorization: `Bearer ${token}` })).status).toBe(200);
  revoke(device.id);
  expect((await get('/api/me', { authorization: `Bearer ${token}` })).status).toBe(401);
});

test('a code stops working after it expires or after five wrong guesses', () => {
  const now = Date.now();
  const expiring = newCode(now).code;
  expect(pair(expiring, 'p', now + CODE_TTL_MS + 1)).toEqual({ ok: false, reason: 'expired' });

  const { code } = newCode(now);
  for (let i = 0; i < 5; i++) expect(pair('WRONG-CODE', 'p', now).ok).toBe(false);
  expect(pair(code, 'p', now)).toEqual({ ok: false, reason: 'expired' });
  expect(authenticate('not-a-token')).toBeNull();
});

test('requests for another host name, or from another origin, are refused', async () => {
  // fetch cannot forge Host, so speak HTTP directly.
  const raw = await new Promise<string>((resolve) => {
    const net = require('node:net') as typeof import('node:net');
    const socket = net.connect(hub.port, '127.0.0.1', () =>
      socket.write('GET /api/health HTTP/1.1\r\nHost: evil.example:80\r\nConnection: close\r\n\r\n'),
    );
    let text = '';
    socket.on('data', (c) => (text += c.toString()));
    socket.on('end', () => resolve(text));
  });
  expect(raw.startsWith('HTTP/1.1 421')).toBe(true);
  const { code } = newCode();
  expect((await postPair(code, { origin: 'https://evil.example' })).status).toBe(403);
});

test('the app shell is served, and paths outside it are not', async () => {
  expect(await (await get('/')).text()).toContain('<title>app</title>');
  expect(await (await get('/s/anything')).text()).toContain('<title>app</title>');
  const escape = await get('/..%2Fsecret.txt');
  expect(await escape.text()).not.toContain('secret');
});
