// A health report: what is installed, whether the store and cache read, and
// whether the app is running. Never fails; it reports.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as launch from '../launch';
import { binary } from '../buckets/proxy';
import { INSTALLED_APP } from '../buckets/runtime';
import { LIVE_CACHE_FILE, STORE_FILE, VENDORS, VENDOR_IDS, readStore } from '../store';
import type { Context } from './context';

async function appRunning(): Promise<boolean> {
  const main = path.join(INSTALLED_APP, 'Contents', 'MacOS', 'Switchboard');
  try {
    const { stdout } = await launch.run('ps', ['-axo', 'pid=,command=']);
    // The CLI itself may be running on the app's binary; skip our own row
    // and the app's helper processes.
    return stdout.split('\n').some((line) => {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      return !!m && Number(m[1]) !== process.pid && m[2].startsWith(main) && !/--type=/.test(m[2]);
    });
  } catch {
    return false;
  }
}

function storeHealth(): { path: string; ok: boolean; error?: string } {
  try {
    readStore();
    return { path: STORE_FILE, ok: true };
  } catch (error) {
    return { path: STORE_FILE, ok: false, error: (error as Error).message };
  }
}

function cacheHealth(): { path: string; present: boolean; ageSeconds: number | null } {
  try {
    const age = Math.round((Date.now() - fs.statSync(LIVE_CACHE_FILE).mtimeMs) / 1000);
    return { path: LIVE_CACHE_FILE, present: true, ageSeconds: age };
  } catch {
    return { path: LIVE_CACHE_FILE, present: false, ageSeconds: null };
  }
}

export async function doctorCommand(_rest: string[], ctx: Context): Promise<void> {
  const entries = await Promise.all(
    VENDOR_IDS.map(async (v) => [v, await launch.haveCommand(VENDORS[v].cli)] as const),
  );
  ctx.out.result({
    apps: Object.fromEntries(
      VENDOR_IDS.map((v) => [v, { installed: fs.existsSync(VENDORS[v].appPath), path: VENDORS[v].appPath }]),
    ),
    clis: Object.fromEntries(entries),
    proxy: { installed: fs.existsSync(binary()), path: binary() },
    terminals: launch.installedTerminals().map(({ id, label }) => ({ id, label })),
    store: storeHealth(),
    cache: cacheHealth(),
    app: { installed: fs.existsSync(INSTALLED_APP), running: await appRunning() },
  });
}
