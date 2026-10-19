// What the Phone tab and `switchboard remote status` say about Tailscale,
// and publishing on the tailnet. The Tailscale app's binary answers as the
// command line only when it can tell it was run from one; Switchboard opened
// at login has no terminal. A stand-in `tailscale` first on PATH answers
// every call here, so no test reaches the real one.

import { test, expect, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { publish, tailnetName } from '../src/remote/status';

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

// A stand-in that records its arguments and answers with `body`.
function standIn(body: string): { dir: string; calls: () => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-tailscale-'));
  const log = path.join(dir, 'calls');
  fs.writeFileSync(path.join(dir, 'tailscale'), `#!/bin/sh\necho "$TAILSCALE_BE_CLI $*" >> "${log}"\n${body}\n`, {
    mode: 0o755,
  });
  process.env.PATH = `${dir}:${savedPath}`;
  return { dir, calls: () => fs.readFileSync(log, 'utf8').trim() };
}

test.skipIf(process.platform === 'win32')('Publish runs tailscale serve for the hub, as the command line', async () => {
  const t = standIn('exit 0');
  expect(await publish(47821)).toEqual({ published: true, enableUrl: null, error: null });
  expect(t.calls()).toBe('1 serve --bg --https=443 http://127.0.0.1:47821');
  fs.rmSync(t.dir, { recursive: true, force: true });
});

test.skipIf(process.platform === 'win32')(
  'a tailnet that has not allowed Serve hands back the link to allow it, without waiting on it',
  async () => {
    const t = standIn(`echo "Serve is not enabled on your tailnet."
echo "To enable, visit:"
echo ""
echo "         https://login.tailscale.com/f/serve?node=nX1"
sleep 30`);
    const started = Date.now();
    expect(await publish(47821, 1000)).toEqual({
      published: false,
      enableUrl: 'https://login.tailscale.com/f/serve?node=nX1',
      error: null,
    });
    expect(Date.now() - started).toBeLessThan(5000);
    fs.rmSync(t.dir, { recursive: true, force: true });
  },
);

test.skipIf(process.platform === 'win32')('any other refusal comes back as what Tailscale said', async () => {
  const t = standIn('echo "error: listener already exists for port 443" >&2; exit 1');
  expect(await publish(47821)).toEqual({
    published: false,
    enableUrl: null,
    error: 'error: listener already exists for port 443',
  });
  fs.rmSync(t.dir, { recursive: true, force: true });
});

test.skipIf(process.platform === 'win32')(
  'a Tailscale that waits without saying why is cut short and says so',
  async () => {
    const t = standIn('sleep 30');
    expect(await publish(47821, 500)).toEqual({
      published: false,
      enableUrl: null,
      error: 'Tailscale did not answer within 0.5 seconds. Check that it is signed in, then publish again.',
    });
    fs.rmSync(t.dir, { recursive: true, force: true });
  },
);
