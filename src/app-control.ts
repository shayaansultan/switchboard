// A private, local CLI connection to operations owned by the running Electron
// app. This is separate from phone control. One bounded JSON line per socket;
// filesystem permissions restrict it to the same macOS user.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';
import { z } from 'zod';
import { root } from './storage';
import { CliError, classify, refused } from './cli/output';

export const AppCommand = z.discriminatedUnion('command', [
  z.object({ command: z.literal('awake'), action: z.enum(['status', 'on', 'off', 'recheck']) }).strict(),
  z.object({ command: z.literal('accessibility'), action: z.enum(['status', 'open']) }).strict(),
  z.object({ command: z.literal('focus'), profile: z.string().min(1) }).strict(),
  z.object({ command: z.literal('force-quit'), profile: z.string().min(1) }).strict(),
]);
export type AppCommand = z.infer<typeof AppCommand>;
const LIMIT = 16 * 1024;
const TIMEOUT = 130_000; // macOS authorization itself is bounded at 120 s.
const socketPath = () => path.join(root(), 'app-control.sock');
const unavailable = () =>
  refused(
    'app-unavailable',
    'The Switchboard app is not accepting local commands.',
    'Open the matching Switchboard app with this store. If it is already open, check its startup log for a blocked app-control.sock; an older app may need updating.',
  );

export async function requestApp(command: AppCommand): Promise<unknown> {
  AppCommand.parse(command);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath());
    let buffer = '';
    let answered = false;
    let sent = false;
    const disconnected = () =>
      sent
        ? new CliError(
            'app-disconnected',
            'The app disconnected before replying; the operation may still have completed. Check its state before retrying.',
            1,
          )
        : unavailable();
    const fail = (error: Error) => {
      answered = true;
      socket.destroy();
      reject(error);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(TIMEOUT, () =>
      fail(
        new CliError(
          'app-timeout',
          'The app did not reply in time; the operation may still have completed. Check its state before retrying.',
          1,
        ),
      ),
    );
    socket.on('error', () => fail(disconnected()));
    socket.on('connect', () => {
      sent = true;
      socket.write(JSON.stringify(command) + '\n');
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > LIMIT) return fail(new Error('App response exceeded the size limit'));
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try {
        const reply = z
          .discriminatedUnion('ok', [
            z.object({ ok: z.literal(true), result: z.unknown() }),
            z.object({
              ok: z.literal(false),
              error: z.string(),
              message: z.string(),
              exit: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
              hint: z.string().optional(),
            }),
          ])
          .parse(JSON.parse(buffer.slice(0, end)));
        answered = true;
        socket.destroy();
        if (reply.ok) resolve(reply.result);
        else reject(new CliError(reply.error, reply.message, reply.exit, { hint: reply.hint }));
      } catch (error) {
        fail(error as Error);
      }
    });
    socket.on('close', () => {
      if (!answered) fail(disconnected());
    });
  });
}

export async function serveAppControl(handle: (command: AppCommand) => Promise<unknown>): Promise<() => void> {
  const file = socketPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error(`Refusing to replace ${file}`);
    const stale = await new Promise<boolean>((resolve, reject) => {
      const probe = net.createConnection(file);
      probe.setTimeout(1000, () => {
        probe.destroy();
        reject(new Error('Existing app control socket did not answer'));
      });
      probe.once('connect', () => {
        probe.destroy();
        resolve(false);
      });
      probe.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(true);
        else reject(error);
      });
    });
    if (!stale) throw new Error('Another Switchboard app owns this store’s control socket');
    fs.unlinkSync(file);
  }
  const clients = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    clients.add(socket);
    socket.once('close', () => clients.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(TIMEOUT, () => socket.destroy());
    socket.setEncoding('utf8');
    let buffer = '';
    let dispatched = false;
    socket.on('data', (chunk: string) => {
      if (dispatched) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > LIMIT) {
        socket.destroy();
        return;
      }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      dispatched = true;
      void (async () => {
        try {
          const command = AppCommand.parse(JSON.parse(buffer.slice(0, end)));
          const result = await handle(command);
          socket.end(JSON.stringify({ ok: true, result }) + '\n');
        } catch (error) {
          const failure =
            error instanceof z.ZodError ? new CliError('usage', 'Invalid app command', 2) : classify(error);
          socket.end(JSON.stringify({ ok: false, ...failure.failure(), exit: failure.exit }) + '\n');
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(file, () => {
      fs.chmodSync(file, 0o600);
      resolve();
    });
  });
  const inode = fs.statSync(file).ino;
  return () => {
    for (const client of clients) client.destroy();
    // Unlink only our own socket, before close's automatic unlink.
    if (fs.existsSync(file) && fs.statSync(file).ino === inode) fs.unlinkSync(file);
    server.close();
  };
}
