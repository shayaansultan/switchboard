// Pictures and files reach a phone only through ids the hub signed for a
// transcript, so a phone can fetch what a session refers to and nothing else
// on the disk. These pin that, that an image stored inline in a session file
// is found again by its line, and that HTML a session made runs sandboxed.

import { test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sandboxHome } from './setup';
import { startHub, type Hub, type HubSource } from '../src/remote/hub';
import { mediaId, readMedia, resolveMedia } from '../src/remote/media';
import { newCode, pair, remoteDir } from '../src/remote/pairing';
import { SessionReader, type ProfileHome } from '../src/remote/sessions';
import type { Entry } from '../src/remote/model';

const root = path.join(sandboxHome, 'remote-media');
const claude: ProfileHome = { id: 'claude-work', vendor: 'claude', home: path.join(root, 'claude') };
const codex: ProfileHome = { id: 'codex-work', vendor: 'codex', home: path.join(root, 'codex') };
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

let hub: Hub;
beforeEach(async () => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(remoteDir(), { recursive: true, force: true });
  const source: HubSource = { profiles: () => [], homes: () => [claude, codex] };
  hub = await startHub({ source, staticDir: path.join(root, 'static'), port: 0 });
});
afterEach(() => hub.close());

function write(file: string, records: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A multi-byte character ahead of the image, so byte and character positions differ.
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

const base = { sessionId: 's1', cwd: '/x', entrypoint: 'claude-desktop' };
const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } };

function claudeSession() {
  write(path.join(claude.home, 'projects', 'p', 's1.jsonl'), [
    { ...base, type: 'user', timestamp: 't', message: { role: 'user', content: 'Café — look at this ✓' } },
    {
      ...base,
      type: 'user',
      timestamp: 't',
      message: { role: 'user', content: [{ type: 'text', text: 'Here' }, image] },
    },
    {
      ...base,
      type: 'assistant',
      timestamp: 't',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'shot', name: 'mcp__Claude_Browser__computer', input: { action: 'screenshot' } },
        ],
        stop_reason: 'tool_use',
      },
    },
    {
      ...base,
      type: 'user',
      timestamp: 't',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'shot', content: [{ type: 'text', text: 'ok' }, image] }],
      },
    },
  ]);
  const reader = new SessionReader();
  reader.list([claude]);
  return reader.transcript([claude], claude.id, 's1')!.entries;
}

const ids = (entries: Entry[]) => ({
  pasted: entries.filter((e) => e.kind === 'image').map((e) => (e as Extract<Entry, { kind: 'image' }>).mediaId),
  shots: entries.flatMap((e) => (e.kind === 'steps' ? e.calls.flatMap((c) => c.images) : [])),
});

test('a picture pasted into Claude and a screenshot a tool returned are both found again from their lines', () => {
  const { pasted, shots } = ids(claudeSession());
  expect(pasted).toHaveLength(1);
  expect(shots).toHaveLength(1);
  for (const id of [...pasted, ...shots]) {
    const media = readMedia(resolveMedia(id)!)!;
    expect(media.type).toBe('image/png');
    expect(Buffer.compare(media.body as Buffer, PNG)).toBe(0);
  }
});

test('Codex: a viewed image is a step with its picture, and a thread lists the visualizations it made', () => {
  const day = path.join(codex.home, 'sessions', '2026', '10', '18');
  const shot = path.join(root, 'shot.png');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(shot, PNG);
  write(path.join(day, 'rollout-2026-10-18T01-00-00-t1.jsonl'), [
    { type: 'session_meta', payload: { id: 't1', cwd: '/x', originator: 'Codex Desktop' } },
    {
      type: 'event_msg',
      payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'Chart it' }] } },
    },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'ImageView', id: 'v', path: shot } } },
  ]);
  fs.utimesSync(path.join(day, 'rollout-2026-10-18T01-00-00-t1.jsonl'), new Date(), new Date());
  const viz = path.join(codex.home, 'visualizations', '2026', '10', '18', 't1');
  fs.mkdirSync(viz, { recursive: true });
  fs.writeFileSync(path.join(viz, 'chart.html'), '<h1>chart</h1>');
  const reader = new SessionReader();
  reader.list([codex]);
  const t = reader.transcript([codex], codex.id, 't1')!;
  const call = t.entries.flatMap((e) => (e.kind === 'steps' ? e.calls : []))[0];
  expect(call).toMatchObject({ name: 'View image', detail: shot });
  expect(readMedia(resolveMedia(call.images[0])!)!.size).toBe(PNG.length);
  expect(t.files.map((f) => [f.name, f.type])).toEqual([['chart.html', 'html']]);
});

test('the hub serves media only to a paired phone, only by an id it signed, and HTML only sandboxed', async () => {
  const [id] = ids(claudeSession()).pasted;
  const url = (m: string) => `http://127.0.0.1:${hub.port}/api/media/${encodeURIComponent(m)}`;
  expect((await fetch(url(id))).status).toBe(401);

  const result = pair(newCode().code, 'Test');
  if (!result.ok) throw new Error('pairing failed');
  const cookie = { cookie: `sb_device=${result.token}` };
  const ok = await fetch(url(id), { headers: cookie });
  expect(ok.headers.get('content-type')).toBe('image/png');
  expect(Buffer.compare(Buffer.from(await ok.arrayBuffer()), PNG)).toBe(0);

  // Any other file on the disk, or a reference with its signature changed, is refused.
  const secret = path.join(root, 'secret.txt');
  fs.writeFileSync(secret, 'secret');
  const [body] = mediaId({ p: secret }).split('.');
  const forged = `${Buffer.from(JSON.stringify({ p: '/etc/hosts' })).toString('base64url')}.${mediaId({ p: secret }).split('.')[1]}`;
  expect((await fetch(url(`${body}.${'A'.repeat(32)}`), { headers: cookie })).status).toBe(404);
  expect((await fetch(url(forged), { headers: cookie })).status).toBe(404);

  const page = path.join(root, 'made.html');
  fs.writeFileSync(page, '<script>fetch("/api/trpc/overview")</script>');
  const html = await fetch(url(mediaId({ p: page })), { headers: cookie });
  expect(html.headers.get('content-security-policy')).toMatch(
    /^sandbox allow-scripts allow-popups;.*connect-src 'none'/,
  );
});
