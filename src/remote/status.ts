// What the CLI needs to know about phone access that only the app knows:
// whether its hub is listening, on which port, and why not if it failed.
// The app writes hub.json beside the device list when the hub starts, stops
// or fails; the CLI reads it and asks the port itself before believing it.
//
// Also the Mac's tailnet name, for the address the phone opens. Tailscale's
// own CLI answers that; when it cannot (not installed, logged out, or the
// app's CLI refusing to run from here), the address is simply not known.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { readJson, writeJson } from '../storage';
import type { PhonePairing, PhoneStatus, Settings } from '../types';
import { DEFAULT_PORT } from './hub';
import { listDevices, newCode, remoteDir } from './pairing';

const execute = promisify(execFile);

const HubStatus = z.object({
  port: z.number().nullable(),
  pid: z.number(),
  at: z.string(),
  error: z.string().nullable(),
});
export type HubStatus = z.infer<typeof HubStatus>;

const statusFile = () => path.join(remoteDir(), 'hub.json');

export function writeHubStatus(status: Omit<HubStatus, 'pid' | 'at'>): void {
  writeJson(statusFile(), { ...status, pid: process.pid, at: new Date().toISOString() });
}

export function clearHubStatus(): void {
  fs.rmSync(statusFile(), { force: true });
}

export function readHubStatus(): HubStatus | null {
  try {
    return HubStatus.parse(readJson(statusFile()));
  } catch {
    return null;
  }
}

// Whether a Switchboard hub answers on this port right now.
export function probe(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', headers: { host: 'localhost' } }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString()));
      res.on('end', () => resolve(res.statusCode === 200 && body.includes('switchboard')));
    });
    req.setTimeout(timeoutMs, () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

const TAILSCALE = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];

// This Mac's MagicDNS name, such as "studio.tail1234.ts.net", or null.
export async function tailnetName(): Promise<string | null> {
  for (const binary of TAILSCALE) {
    try {
      const { stdout } = await execute(binary, ['status', '--json'], { timeout: 5000 });
      const name = (JSON.parse(stdout) as { Self?: { DNSName?: string } }).Self?.DNSName?.replace(/\.$/, '');
      if (name) return name;
    } catch {
      // Not this binary; try the next.
    }
  }
  return null;
}

// The command that publishes the hub on the tailnet, for people to run.
export const serveCommand = (port: number): string => `tailscale serve --bg --https=443 http://127.0.0.1:${port}`;

// Everything the window and the CLI report about phone access.
export async function phoneStatus(settings: Settings): Promise<PhoneStatus> {
  const port = settings.phonePort ?? DEFAULT_PORT;
  const enabled = !!settings.phoneAccess;
  const listening = enabled && (await probe(port));
  const name = await tailnetName();
  return {
    enabled,
    port,
    listening,
    error: enabled && !listening ? (readHubStatus()?.error ?? 'Switchboard has not started phone access yet') : null,
    url: name ? `https://${name}/` : null,
    serve: serveCommand(port),
    devices: listDevices(),
  };
}

// A fresh pairing code, with the address that opens the phone app already filled in.
export async function pairing(): Promise<PhonePairing> {
  const { code, expiresAt } = newCode();
  const name = await tailnetName();
  return { code, expiresAt, url: name ? `https://${name}/#pair=${code}` : null };
}
