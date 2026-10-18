// What the Phone tab and `switchboard remote status` say about Tailscale.
// The Tailscale app's binary answers as the command line only when it can
// tell it was run from one; Switchboard opened at login has no terminal.

import { test, expect, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { tailnetName } from '../src/remote/status';

const savedPath = process.env.PATH;
const savedTerm = process.env.TERM;
afterEach(() => {
  process.env.PATH = savedPath;
  if (savedTerm === undefined) delete process.env.TERM;
  else process.env.TERM = savedTerm;
});

test.skipIf(process.platform === 'win32')(
  'the tailnet name is found without a terminal in the environment',
  async () => {
    // A stand-in `tailscale` first on PATH that, like the app's binary, opens
    // nothing useful unless told to be the command line.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-tailscale-'));
    fs.writeFileSync(
      path.join(dir, 'tailscale'),
      `#!/bin/sh
if [ -z "$TAILSCALE_BE_CLI" ]; then echo "The Tailscale GUI failed to start" >&2; exit 1; fi
echo '{"Self":{"DNSName":"studio.tail1234.ts.net."}}'
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${dir}:${savedPath}`;
    delete process.env.TERM;
    expect(await tailnetName()).toBe('studio.tail1234.ts.net');
    fs.rmSync(dir, { recursive: true, force: true });
  },
);
