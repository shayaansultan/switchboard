// Notifications: which changes buzz a phone (notify.ts) and which phones a
// note goes to (push.ts). A phone hears only about changes it asked for,
// never about what the first look found, and a subscription that is gone or
// belongs to an unpaired phone is dropped.

import { test, expect, beforeEach } from 'bun:test';
import * as fs from 'node:fs';
import { sandboxHome } from './setup';
import type { Overview } from '../src/remote/hub';
import type { SessionSummary } from '../src/remote/model';
import { ASK_GRACE_MS, changes, emptyWatch, LONG_RUN_MS, plainText } from '../src/remote/notify';
import { newCode, pair, remoteDir, revoke } from '../src/remote/pairing';
import { push, pushState, setPrefs, subscribe, type Note, type Sender } from '../src/remote/push';

void sandboxHome;
beforeEach(() => fs.rmSync(remoteDir(), { recursive: true, force: true }));

const session = (state: SessionSummary['state'], extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 's1',
  profileId: 'claude-work',
  vendor: 'claude',
  title: 'Migrate billing',
  cwd: null,
  branch: null,
  origin: 'desktop',
  state,
  updatedAt: '2026-10-18T00:00:00Z',
  lastMessage: { role: 'assistant', text: 'All tests pass.' },
  plan: null,
  needs: state === 'needs-you' ? 'Which queue?' : null,
  background: 0,
  prs: [],
  model: null,
  costUsd: null,
  ...extra,
});

const overview = (sessions: SessionSummary[], pct: number | null = 10): Overview => ({
  host: 'Mac',
  generatedAt: '',
  profiles: [
    {
      id: 'claude-work',
      name: 'Work',
      label: 'Work',
      vendor: 'claude',
      color: '#000',
      isDefault: false,
      email: null,
      plan: null,
      app: null,
      windows: [{ label: '5h', pct, resetsAt: '2026-10-18T05:00:00Z' }],
    },
  ],
  sessions,
  pending: [],
  reachable: [],
  failures: {},
});

test('the first look sends nothing; a question, an error and a long run finishing each do', () => {
  const t0 = 1_000_000;
  let w = changes(emptyWatch(), overview([session('needs-you')], 95), [], t0, true);
  expect(w.notes).toEqual([]);

  w = changes(w.watch, overview([session('working')]), [], t0);
  expect(w.notes).toEqual([]);
  w = changes(w.watch, overview([session('needs-you')]), [], t0 + 1000);
  expect(w.notes).toMatchObject([
    { kind: 'needs', body: 'Work asks: Which queue?', url: '#/s/claude-work/s1', tag: 'claude-work/s1' },
  ]);

  w = changes(w.watch, overview([session('working')]), [], t0 + 2000);
  w = changes(w.watch, overview([session('finished')]), [], t0 + 3000);
  expect(w.notes).toEqual([]); // a quick turn stays quiet

  w = changes(w.watch, overview([session('working')]), [], t0 + 4000);
  w = changes(w.watch, overview([session('working')]), [], t0 + 4000 + LONG_RUN_MS);
  w = changes(w.watch, overview([session('finished')]), [], t0 + 4000 + LONG_RUN_MS);
  expect(w.notes).toMatchObject([{ kind: 'finished', body: 'Work: All tests pass.' }]);

  w = changes(w.watch, overview([session('errored')]), [], t0 + 5000 + LONG_RUN_MS);
  expect(w.notes).toMatchObject([{ kind: 'errored' }]);
});

test('a session that first appears already needing you is news; one that appears finished is not', () => {
  const seeded = changes(emptyWatch(), overview([]), [], 0, true).watch;
  expect(changes(seeded, overview([session('needs-you')]), [], 1).notes).toMatchObject([{ kind: 'needs' }]);
  expect(changes(seeded, overview([session('finished')]), [], 1).notes).toEqual([]);
});

test('a held request is announced once, and a profile running low warns once per window', () => {
  const asking = [{ id: 'r1', profileId: 'claude-work', sessionId: 's1', title: 'Run a command: bun test', since: 0 }];
  let w = changes(emptyWatch(), overview([]), [], 0, true);
  w = changes(w.watch, overview([]), asking, ASK_GRACE_MS + 1);
  expect(w.notes).toMatchObject([{ kind: 'needs', title: 'Run a command: bun test' }]);
  expect(changes(w.watch, overview([]), asking, ASK_GRACE_MS + 2).notes).toEqual([]);

  w = changes(w.watch, overview([], 92), [], 3);
  expect(w.notes).toMatchObject([{ kind: 'limits', title: 'Work is running low', url: '#/accounts' }]);
  expect(changes(w.watch, overview([], 97), [], 4).notes).toEqual([]);
});

const sub = (n: number) => ({ endpoint: `https://push.example.com/${n}`, keys: { p256dh: 'p', auth: 'a' } });
const note: Note = { kind: 'finished', title: 't', body: 'b', tag: 'x', url: '#/' };

test('a note goes to the phones that want its kind; a gone subscription and an unpaired phone are dropped', async () => {
  const a = pair(newCode().code, 'A');
  const b = pair(newCode().code, 'B');
  if (!a.ok || !b.ok) throw new Error('pairing failed');
  subscribe(a.device.id, sub(1));
  subscribe(b.device.id, sub(2));
  setPrefs(b.device.id, { needs: true, finished: false, errored: true, limits: false, allSessions: false });

  const sent: string[] = [];
  const ok: Sender = async (s) => (sent.push(s.endpoint), 201);
  expect(await push(note, { sender: ok })).toBe(1);
  expect(sent).toEqual(['https://push.example.com/1']);

  const gone: Sender = async () => {
    throw Object.assign(new Error('gone'), { statusCode: 410 });
  };
  await push({ ...note, kind: 'needs' }, { sender: gone });
  expect(pushState(a.device.id).on).toBe(false);
  expect(pushState(b.device.id).on).toBe(false);

  subscribe(a.device.id, sub(3));
  revoke(a.device.id);
  sent.length = 0;
  expect(await push(note, { sender: ok })).toBe(0);
  expect(fs.statSync(`${remoteDir()}/push.json`).mode & 0o777).toBe(0o600);
});

test('what the push service carries is encrypted for the phone, and the phone reads the note back', async () => {
  const { createECDH, randomBytes } = await import('node:crypto');
  const webpush = (await import('web-push')).default;
  const ece = (await import('http_ece')).default as { decrypt(body: Buffer, opts: object): Buffer };
  const phone = createECDH('prime256v1');
  phone.generateKeys();
  const auth = randomBytes(16);
  const subscription = {
    endpoint: 'https://web.push.apple.com/abc',
    keys: { p256dh: phone.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
  };
  const keys = webpush.generateVAPIDKeys();
  const request = webpush.generateRequestDetails(subscription, JSON.stringify(note), {
    vapidDetails: { subject: 'https://example.com', ...keys },
  });
  expect(request.headers.Authorization).toStartWith('vapid t=');
  expect(Buffer.from(request.body).includes(Buffer.from('"title"'))).toBe(false);
  const plain = ece.decrypt(Buffer.from(request.body), {
    version: 'aes128gcm',
    privateKey: phone,
    authSecret: auth.toString('base64url'),
  });
  expect(JSON.parse(plain.toString('utf8'))).toEqual(note);
});

test('a note says where its session runs; a request for a session not listed yet counts as desktop', () => {
  const cli = session('working', { id: 's2', origin: 'cli' });
  let w = changes(emptyWatch(), overview([cli]), [], 0, true);
  w = changes(w.watch, overview([{ ...cli, state: 'errored' }]), [], 1);
  expect(w.notes).toMatchObject([{ kind: 'errored', origin: 'cli' }]);
  const asking = [{ id: 'r9', profileId: 'claude-work', sessionId: 'new', title: 'Run a command', since: 2 }];
  expect(changes(w.watch, overview([]), asking, 2 + ASK_GRACE_MS).notes).toMatchObject([
    { kind: 'needs', origin: 'desktop' },
  ]);
});

test('sessions outside the desktop apps reach only phones that asked for all sessions', async () => {
  const a = pair(newCode().code, 'Desktop only');
  const b = pair(newCode().code, 'Everything');
  if (!a.ok || !b.ok) throw new Error('pairing failed');
  subscribe(a.device.id, sub(1));
  subscribe(b.device.id, sub(2), { needs: true, finished: true, errored: true, limits: true, allSessions: true });
  expect(pushState(a.device.id).prefs.allSessions).toBe(false);

  const sent: string[] = [];
  const ok: Sender = async (s) => (sent.push(s.endpoint), 201);
  const to = async (n: Note) => {
    sent.length = 0;
    await push(n, { sender: ok });
    return [...sent].sort();
  };
  const both = ['https://push.example.com/1', 'https://push.example.com/2'];
  // A `claude -p` an agent started, finishing and erroring.
  expect(await to({ ...note, origin: 'cli' })).toEqual(['https://push.example.com/2']);
  expect(await to({ ...note, kind: 'errored', origin: 'exec' })).toEqual(['https://push.example.com/2']);
  expect(await to({ ...note, origin: 'desktop' })).toEqual(both);
  // A profile running low is about no session.
  setPrefs(a.device.id, { ...pushState(a.device.id).prefs, limits: true });
  expect(await to({ ...note, kind: 'limits' })).toEqual(both);
  // Asking for all sessions later takes effect at once.
  setPrefs(a.device.id, { ...pushState(a.device.id).prefs, allSessions: true });
  expect(await to({ ...note, origin: 'ide' })).toEqual(both);
});

test('a push.json written before the setting existed keeps its phones, desktop only', () => {
  const a = pair(newCode().code, 'Old phone');
  if (!a.ok) throw new Error('pairing failed');
  subscribe(a.device.id, sub(1));
  const file = `${remoteDir()}/push.json`;
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  const keys = stored.keys;
  delete stored.phones[0].prefs.allSessions;
  fs.writeFileSync(file, JSON.stringify(stored));
  expect(pushState(a.device.id)).toEqual({
    on: true,
    prefs: { needs: true, finished: true, errored: true, limits: false, allSessions: false },
  });
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).keys).toEqual(keys);
});

test('a request that settles within the grace period never buzzes; one still waiting after it does, once', () => {
  const ask = (id: string, since: number) => ({
    id,
    profileId: 'claude-work',
    sessionId: 's1',
    title: 'Run a command',
    since,
  });
  let w = changes(emptyWatch(), overview([]), [], 0, true);
  // Auto mode: the classifier allows the call two seconds after it asked.
  w = changes(w.watch, overview([]), [ask('auto', 1000)], 1000);
  expect(w.notes).toEqual([]);
  expect(w.wakeIn).toBe(ASK_GRACE_MS);
  w = changes(w.watch, overview([]), [], 3000);
  expect(w.notes).toEqual([]);
  expect(w.wakeIn).toBeNull();
  // Nobody answers: announced when the grace period is up, and only then.
  w = changes(w.watch, overview([]), [ask('real', 10_000)], 10_000);
  expect(w.notes).toEqual([]);
  w = changes(w.watch, overview([]), [ask('real', 10_000)], 10_000 + ASK_GRACE_MS - 1);
  expect(w.notes).toEqual([]);
  expect(w.wakeIn).toBe(1);
  w = changes(w.watch, overview([]), [ask('real', 10_000)], 10_000 + ASK_GRACE_MS);
  expect(w.notes).toMatchObject([{ kind: 'needs', title: 'Run a command' }]);
  expect(changes(w.watch, overview([]), [ask('real', 10_000)], 40_000).notes).toEqual([]);
  // Waiting since before someone left the Mac: due at once.
  expect(changes(w.watch, overview([]), [ask('old', 0)], 60_000).notes).toHaveLength(1);
});

test('a finished note reads as plain text, not Markdown', () => {
  expect(
    plainText(
      'Fixed in draft PR [shayaansultan/switchboard#32](https://github.com/x/y/pull/32). The **UI tests** now run `bun test`.\n\n- one\n- two',
    ),
  ).toBe('Fixed in draft PR shayaansultan/switchboard#32. The UI tests now run bun test. one two');
  let w = changes(emptyWatch(), overview([session('working')]), [], 0, true);
  w = changes(w.watch, overview([session('working')]), [], LONG_RUN_MS);
  const done = session('finished', { lastMessage: { role: 'assistant', text: 'See [the PR](https://x.y/1).' } });
  expect(changes(w.watch, overview([done]), [], LONG_RUN_MS + 1).notes[0]?.body).toBe('Work: See the PR.');
});
