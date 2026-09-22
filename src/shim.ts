// Launcher shims: a tiny sh script in ~/.local/bin that execs a runtime on
// an entry file, so `oc` and `switchboard` work from any shell without
// touching rc files. Both CLIs install theirs through here.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { shellQuote } from './shell';
import { HOME } from './store';

export function launcherScript(comment: string, argv: string[], env: Record<string, string> = {}): string {
  const exports = Object.entries(env)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}\n`)
    .join('');
  return `#!/bin/sh\n# ${comment}\n${exports}exec ${argv.map(shellQuote).join(' ')} "$@"\n`;
}

// Write the shim, or leave an identical one alone. A file with different
// content is someone else's launcher and is never overwritten.
export function installShim(name: string, script: string): string {
  const file = path.join(HOME, '.local', 'bin', name);
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== script) {
    throw new Error(`An unrelated or differently installed launcher exists at ${file}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, script, { mode: 0o755 });
  return file;
}
