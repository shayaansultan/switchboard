// Which phones may read the hub. A phone pairs once with a short code shown
// by the window or `switchboard remote pair`, and gets a device token it
// sends with every request. Only hashes are stored: devices.json holds a
// SHA-256 of each token, pairing.json a hash of the one live code.
//
// Both files live under ~/.switchboard/remote/ so the app and the CLI share
// them: the CLI can mint a code that the app's hub accepts, and revoking a
// phone from either side takes effect on its next request. A code is single
// use, expires after CODE_TTL_MS, and is burned after MAX_ATTEMPTS wrong tries.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { readJson, root, writeJson } from '../storage';

export const CODE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
// lastSeenAt is for the devices list, so it need not be written on every request.
const SEEN_RESOLUTION_MS = 5 * 60_000;
// No 0/O, 1/I/L: a code is read off one screen and typed on another.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const Device = z.object({
  id: z.string(),
  name: z.string(),
  tokenHash: z.string(),
  createdAt: z.string(),
  lastSeenAt: z.string().nullable(),
});
export type Device = z.infer<typeof Device>;
export type DeviceView = Omit<Device, 'tokenHash'>;
const Devices = z.object({ devices: z.array(Device) });
const Pending = z.object({ codeHash: z.string(), expiresAt: z.number(), attempts: z.number() });

export function remoteDir(): string {
  return path.join(root(), 'remote');
}
const devicesFile = () => path.join(remoteDir(), 'devices.json');
const pendingFile = () => path.join(remoteDir(), 'pairing.json');

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

function readDevices(): Device[] {
  try {
    return Devices.parse(readJson(devicesFile())).devices;
  } catch {
    return [];
  }
}

function writeDevices(devices: Device[]): void {
  writeJson(devicesFile(), { devices });
}

const view = (d: Device): DeviceView => ({
  id: d.id,
  name: d.name,
  createdAt: d.createdAt,
  lastSeenAt: d.lastSeenAt,
});

export function listDevices(): DeviceView[] {
  return readDevices().map(view);
}

// "ABCD-EFGH". The dash is decoration; normalizeCode drops it.
export function newCode(now = Date.now()): { code: string; expiresAt: string } {
  const bytes = randomBytes(8);
  const raw = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  writeJson(pendingFile(), { codeHash: sha256(raw), expiresAt: now + CODE_TTL_MS, attempts: 0 });
  return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt: new Date(now + CODE_TTL_MS).toISOString() };
}

export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export type PairResult = { ok: true; token: string; device: DeviceView } | { ok: false; reason: 'expired' | 'wrong' };

// Trade a pairing code for a device token. The token is returned once, here.
export function pair(code: string, name: string, now = Date.now()): PairResult {
  let pending: z.infer<typeof Pending>;
  try {
    pending = Pending.parse(readJson(pendingFile()));
  } catch {
    return { ok: false, reason: 'expired' };
  }
  if (pending.expiresAt <= now) {
    fs.rmSync(pendingFile(), { force: true });
    return { ok: false, reason: 'expired' };
  }
  if (!sameHash(sha256(normalizeCode(code)), pending.codeHash)) {
    const attempts = pending.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) fs.rmSync(pendingFile(), { force: true });
    else writeJson(pendingFile(), { ...pending, attempts });
    return { ok: false, reason: 'wrong' };
  }
  fs.rmSync(pendingFile(), { force: true });
  const token = randomBytes(32).toString('base64url');
  const device: Device = {
    id: randomUUID(),
    name: name.trim().slice(0, 60) || 'Phone',
    tokenHash: sha256(token),
    createdAt: new Date(now).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
  };
  writeDevices([...readDevices(), device]);
  return { ok: true, token, device: view(device) };
}

// The paired device a bearer token belongs to, or null.
export function authenticate(token: string | null, now = Date.now()): DeviceView | null {
  if (!token) return null;
  const hash = sha256(token);
  const devices = readDevices();
  const device = devices.find((d) => sameHash(d.tokenHash, hash));
  if (!device) return null;
  const seen = device.lastSeenAt ? Date.parse(device.lastSeenAt) : 0;
  if (now - seen > SEEN_RESOLUTION_MS) {
    device.lastSeenAt = new Date(now).toISOString();
    writeDevices(devices);
  }
  return view(device);
}

// Unpair one device by id, or every device. Returns what was removed.
export function revoke(id: string | 'all'): DeviceView[] {
  const devices = readDevices();
  const gone = devices.filter((d) => id === 'all' || d.id === id);
  if (gone.length) writeDevices(devices.filter((d) => !gone.includes(d)));
  return gone.map(view);
}
