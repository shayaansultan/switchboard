// Notifications on paired phones, through Web Push. A phone that turns them
// on hands the hub a push subscription (an endpoint at Apple's or Google's
// push service and the keys to encrypt for it); the hub sends to that
// endpoint, and the push service wakes the phone's service worker.
//
// Payloads are encrypted for the phone (RFC 8291), so the push service
// carries them without reading them, and the hub signs each request with a
// key pair of its own (VAPID) so the service knows who sends. Both the keys
// and the subscriptions live in ~/.switchboard/remote/push.json, beside the
// paired devices, so unpairing a phone drops its subscription too.
//
// What each phone hears about is its own choice, stored here with its
// subscription: the Mac decides when to send (notify.ts).

import * as path from 'node:path';
import webpush from 'web-push';
import { z } from 'zod';
import { readJson, writeJson } from '../storage';
import { listDevices, remoteDir } from './pairing';

export const NoteKind = z.enum(['needs', 'finished', 'errored', 'limits']);
export type NoteKind = z.infer<typeof NoteKind>;

export const PushPrefs = z.object({
  needs: z.boolean(),
  finished: z.boolean(),
  errored: z.boolean(),
  limits: z.boolean(),
});
export type PushPrefs = z.infer<typeof PushPrefs>;
export const DEFAULT_PREFS: PushPrefs = { needs: true, finished: true, errored: true, limits: false };

export const Subscription = z.object({
  endpoint: z.url().max(2000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
});

const Phone = z.object({
  deviceId: z.string(),
  subscription: Subscription,
  prefs: PushPrefs,
});
type Phone = z.infer<typeof Phone>;

const Store = z.object({
  keys: z.object({ publicKey: z.string(), privateKey: z.string() }),
  phones: z.array(Phone),
});
type Store = z.infer<typeof Store>;

// Push services ask for a way to reach the sender; this names the project.
const SUBJECT = 'https://github.com/shayaansultan/switchboard';

const file = () => path.join(remoteDir(), 'push.json');

function load(): Store {
  try {
    return Store.parse(readJson(file()));
  } catch {
    const store: Store = { keys: webpush.generateVAPIDKeys(), phones: [] };
    writeJson(file(), store);
    return store;
  }
}

// Phones that were unpaired since they subscribed are dropped on read.
function phones(store = load()): Phone[] {
  const paired = new Set(listDevices().map((d) => d.id));
  return store.phones.filter((p) => paired.has(p.deviceId));
}

export function publicKey(): string {
  return load().keys.publicKey;
}

export function pushState(deviceId: string): { on: boolean; prefs: PushPrefs } {
  const phone = phones().find((p) => p.deviceId === deviceId);
  return { on: !!phone, prefs: phone?.prefs ?? DEFAULT_PREFS };
}

export function subscribe(deviceId: string, subscription: z.infer<typeof Subscription>, prefs?: PushPrefs): void {
  const store = load();
  const before = store.phones.find((p) => p.deviceId === deviceId);
  store.phones = [
    ...phones(store).filter((p) => p.deviceId !== deviceId),
    { deviceId, subscription, prefs: prefs ?? before?.prefs ?? DEFAULT_PREFS },
  ];
  writeJson(file(), store);
}

export function setPrefs(deviceId: string, prefs: PushPrefs): boolean {
  const store = load();
  const phone = store.phones.find((p) => p.deviceId === deviceId);
  if (!phone) return false;
  phone.prefs = prefs;
  writeJson(file(), store);
  return true;
}

export function unsubscribe(deviceId: string): void {
  const store = load();
  const kept = store.phones.filter((p) => p.deviceId !== deviceId);
  if (kept.length !== store.phones.length) writeJson(file(), { ...store, phones: kept });
}

export function anySubscribed(): boolean {
  return phones().length > 0;
}

export interface Note {
  kind: NoteKind;
  title: string;
  body: string;
  // Notifications with one tag replace each other: one per session.
  tag: string;
  // Where tapping it opens, a route in the phone app.
  url: string;
}

// The push service's answer for each phone; a gone subscription is dropped.
export type Sender = (subscription: z.infer<typeof Subscription>, payload: string) => Promise<number>;

const send: Sender = async (subscription, payload) => {
  const { keys } = load();
  const result = await webpush.sendNotification(subscription, payload, {
    vapidDetails: { subject: SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey },
    TTL: 3600,
    urgency: 'high',
    timeout: 15_000,
  });
  return result.statusCode;
};

// Sends `note` to every phone that wants its kind (or only `deviceId`).
// Returns how many push services accepted it.
export async function push(note: Note, options: { deviceId?: string; sender?: Sender } = {}): Promise<number> {
  const sender = options.sender ?? send;
  const targets = phones().filter((p) => (options.deviceId ? p.deviceId === options.deviceId : p.prefs[note.kind]));
  const gone: string[] = [];
  let sent = 0;
  await Promise.all(
    targets.map(async (p) => {
      try {
        const status = await sender(p.subscription, JSON.stringify(note));
        if (status >= 200 && status < 300) sent++;
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        // The phone turned notifications off or the subscription expired.
        if (status === 404 || status === 410) gone.push(p.deviceId);
      }
    }),
  );
  for (const id of gone) unsubscribe(id);
  return sent;
}
