// Real Unix transport and CLI contracts with a labelled fake app handler.
// macOS identity/controller behavior is exercised by demo/test-cli-parity.mjs.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { serveAppControl, requestApp } from '../src/app-control';
import { CliError } from '../src/cli/output';

let directory: string;
let previous: string | undefined;
let stop: (() => void) | undefined;
beforeEach(() => {
  previous = process.env.SWITCHBOARD_ROOT;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-control-'));
  process.env.SWITCHBOARD_ROOT = directory;
});
afterEach(() => {
  stop?.();
  stop = undefined;
  if (previous === undefined) delete process.env.SWITCHBOARD_ROOT;
  else process.env.SWITCHBOARD_ROOT = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('private transport returns app results and preserves structured refusals', async () => {
  stop = await serveAppControl(async (command) => {
    if (command.command === 'focus') throw new CliError('desktop-not-running', 'Fixture has no app', 4);
    return { fixture: true, action: command.command === 'caffeinate' ? command.action : 'status' };
  });
  expect(fs.statSync(path.join(directory, 'app-control.sock')).mode & 0o777).toBe(0o600);
  expect(await requestApp({ command: 'caffeinate', action: 'stop' })).toEqual({ fixture: true, action: 'stop' });
  await expect(requestApp({ command: 'focus', profile: 'fixture' })).rejects.toMatchObject({
    code: 'desktop-not-running',
    exit: 4,
  });
  await expect(serveAppControl(async () => null)).rejects.toThrow('Another Switchboard');
  expect(await requestApp({ command: 'caffeinate', action: 'status' })).toMatchObject({ action: 'status' });
});

test('invalid input cannot invoke an app operation and only one request is dispatched per connection', async () => {
  const calls: unknown[] = [];
  stop = await serveAppControl(async (command) => {
    calls.push(command);
    return { fixture: true };
  });
  const send = (text: string) =>
    new Promise<string>((resolve, reject) => {
      const socket = net.createConnection(path.join(directory, 'app-control.sock'));
      let output = '';
      socket.setTimeout(2000, () => socket.destroy(new Error('test deadline')));
      socket.on('error', reject);
      socket.on('connect', () => socket.write(text));
      socket.on('data', (chunk) => {
        output += chunk;
      });
      socket.on('end', () => resolve(output));
    });
  expect(JSON.parse(await send('{"command":"caffeinate","action":"stop; bad"}\n'))).toMatchObject({
    ok: false,
    error: 'usage',
  });
  expect(calls).toEqual([]);
  await send('{"command":"caffeinate","action":"status"}\n{"command":"caffeinate","action":"stop"}\n');
  expect(calls).toEqual([{ command: 'caffeinate', action: 'status' }]);
  expect(await send('x'.repeat(17000))).toBe('');
  expect(calls).toHaveLength(1);
});

test('an absent or disconnected app is a refusal, never a successful operation', async () => {
  await expect(requestApp({ command: 'caffeinate', action: 'stop' })).rejects.toMatchObject({
    code: 'app-unavailable',
    exit: 4,
  });
  const server = net.createServer((socket) => socket.once('data', () => socket.destroy()));
  await new Promise<void>((resolve) => server.listen(path.join(directory, 'app-control.sock'), resolve));
  try {
    await expect(requestApp({ command: 'caffeinate', action: 'status' })).rejects.toMatchObject({
      code: 'app-disconnected',
      message: expect.stringContaining('may still have completed'),
    });
  } finally {
    server.close();
  }
});
