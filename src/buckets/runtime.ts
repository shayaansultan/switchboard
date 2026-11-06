// Which runtime and compiled files the desktop wrappers and bucket workers
// embed. Every Switchboard process shares this answer so a wrapper minted by
// the CLI is byte-identical to one minted by the app.
//
// Inside Electron (the app, or the CLI running on the app's binary in Node
// mode) that is this process's own bundle. Under a plain Node or Bun CLI it
// is the installed app when there is one, so nothing launched from a
// checkout hardcodes a node binary or an out/ directory the next build
// deletes. Failing that it is this checkout, with .ts entries when running
// from source under Bun.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { VENDORS } from '../store';

export const INSTALLED_APP = '/Applications/Switchboard.app';

export interface Command {
  execPath: string;
  script: string;
}

type Script = 'desktop-stdio' | 'desktop-remote' | 'cli';

export interface Runtime {
  execPath: string;
  script(name: Script): string;
}

export function runtime(installed = INSTALLED_APP): Runtime {
  const asar = path.join(installed, 'Contents', 'Resources', 'app.asar');
  if (!process.versions.electron && fs.existsSync(asar)) {
    return {
      execPath: path.join(installed, 'Contents', 'MacOS', 'Switchboard'),
      script: (name) => path.join(asar, 'out', 'buckets', `${name}.js`),
    };
  }
  return { execPath: process.execPath, script: (name) => path.join(__dirname, `${name}${path.extname(__filename)}`) };
}

// Codex authenticates the ancestry of app-tools clients. The desktop adapter
// must run in Codex's signed Node, and outside Electron's ASAR archive.
export function desktopAdapter(name: 'desktop-stdio' | 'desktop-remote'): Command & { electron?: boolean } {
  const node = path.join(VENDORS.codex.appPath, 'Contents', 'Resources', 'cua_node', 'bin', 'node');
  if (!fs.existsSync(node)) {
    const legacy = runtime();
    return { execPath: legacy.execPath, script: legacy.script(name), electron: true };
  }
  const own = __dirname.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  if (own !== __dirname) return { execPath: node, script: path.join(own, `${name}.js`) };
  const packaged = path.join(
    INSTALLED_APP,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'out',
    'buckets',
    `${name}.js`,
  );
  const checkout = path.resolve(__dirname, '../../out/buckets', `${name}.js`);
  const script = !process.versions.electron && fs.existsSync(packaged) ? packaged : checkout;
  if (!fs.existsSync(script)) throw new Error('Build Switchboard with bun run build before launching a Codex adapter.');
  return { execPath: node, script };
}

// The command that starts a bucket worker.
export function workerCommand(installed = INSTALLED_APP): Command {
  const r = runtime(installed);
  return { execPath: r.execPath, script: r.script('cli') };
}
