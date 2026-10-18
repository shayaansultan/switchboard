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
import { instanceFor, runningInstances } from '../launch';
import type { PhonePairing, PhoneStatus, Profile, Settings } from '../types';
import { DEFAULT_PORT } from './hub';
import { listDevices, newCode, remoteDir } from './pairing';
import { defaultClaudeLinked, hookedApps, reachOf } from './reach';

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
// The app's binary answers as the command line only when it can tell it was
// run from one: a terminal's TERM, or this. Switchboard opened at login has
// launchd's environment and no TERM, and without it the binary tries to open
// the Tailscale app instead, so the Phone tab said this Mac was not on the
// tailnet while phones reached it fine. Read at each call: the app adopts
// the login shell's PATH after this module loads.
const tailscaleEnv = () => ({ ...process.env, TAILSCALE_BE_CLI: '1' });

// This Mac's MagicDNS name, such as "studio.tail1234.ts.net", or null.
export async function tailnetName(): Promise<string | null> {
  for (const binary of TAILSCALE) {
    try {
      const { stdout } = await execute(binary, ['status', '--json'], { timeout: 5000, env: tailscaleEnv() });
      const name = (JSON.parse(stdout) as { Self?: { DNSName?: string } }).Self?.DNSName?.replace(/\.$/, '');
      if (name) return name;
    } catch {
      // Not this binary; try the next.
    }
  }
  return null;
}

// Whether the hub answers at https://<name>/, which is only the case once
// `tailscale serve` forwards that address to it.
export async function publishedAt(name: string, timeoutMs = 4000): Promise<boolean> {
  try {
    const res = await fetch(`https://${name}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok && ((await res.json()) as { app?: string }).app === 'switchboard';
  } catch {
    return false;
  }
}

// The command that publishes the hub on the tailnet, for people to run.
export const serveCommand = (port: number): string => `tailscale serve --bg --https=443 http://127.0.0.1:${port}`;

// Everything the window and the CLI report about phone access. `profiles`
// lets it name the running apps the phone cannot act on.
export async function phoneStatus(settings: Settings, profiles: Profile[] = []): Promise<PhoneStatus> {
  const port = settings.phonePort ?? DEFAULT_PORT;
  const enabled = !!settings.phoneAccess;
  const listening = enabled && (await probe(port));
  const name = await tailnetName();
  return {
    enabled,
    port,
    listening,
    tailnet: name,
    published: listening && name !== null && (await publishedAt(name)),
    error: enabled && !listening ? (readHubStatus()?.error ?? 'Switchboard has not started phone access yet') : null,
    url: name ? `https://${name}/` : null,
    serve: serveCommand(port),
    devices: listDevices(),
    unreachable: enabled ? await unreachable(profiles) : [],
    defaultClaude: { on: !!settings.phoneDefaultClaude, linked: defaultClaudeLinked(), error: null },
  };
}

async function unreachable(profiles: Profile[]): Promise<PhoneStatus['unreachable']> {
  const instances = await runningInstances().catch(() => []);
  const running = profiles.flatMap((p) => {
    const inst = instanceFor(p, instances);
    return inst ? [{ profile: p, pid: inst.pid, vendor: p.vendor }] : [];
  });
  const hooks = await hookedApps(running);
  return running
    .filter((r) => reachOf(r.profile, hooks.get(r.pid) ?? null, true) === 'relaunch')
    .map(({ profile: p }) => ({ id: p.id, name: p.name, vendor: p.vendor }));
}

// A fresh pairing code, with the address that opens the phone app already filled in.
export async function pairing(): Promise<PhonePairing> {
  const { code, expiresAt } = newCode();
  const name = await tailnetName();
  return { code, expiresAt, url: name ? `https://${name}/#pair=${code}` : null };
}
