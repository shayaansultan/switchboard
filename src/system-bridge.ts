// The system bridge as the main process sees it: a child process
// (src/native/system/bridge) spoken to in JSON lines, each request with an
// id and its reply with the same one, plus unprompted events. Fans and
// Caffeinate share one bridge, so the root helper sees one session holding
// either a fan boost or a lid-closed sleep hold. Controllers take a
// SystemBridge, so tests pass a fake.
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';

export type BridgeReply = Record<string, unknown>;

export interface SystemBridge {
  request(request: Record<string, unknown>): Promise<BridgeReply>;
  onEvent(listener: (event: BridgeReply) => void): void;
  close(): void;
}

/**
 * Runs the system bridge as a child process. It is started on first use and
 * again after it exits; closing stdin ends it, and the helper then ends
 * whatever it was holding.
 */
export function spawnSystemBridge(executable: string, timeout = 25_000): SystemBridge | null {
  if (process.platform !== 'darwin' || !fs.existsSync(executable)) return null;
  let child: ChildProcess | null = null;
  let buffer = '';
  let nextId = 1;
  const pending = new Map<number, { resolve: (reply: BridgeReply) => void; reject: (error: Error) => void }>();
  const listeners: ((event: BridgeReply) => void)[] = [];

  const fail = (error: Error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  const start = (): ChildProcess => {
    if (child && child.exitCode === null && !child.killed) return child;
    buffer = '';
    const next = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    next.stdout?.setEncoding('utf8');
    next.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message: BridgeReply;
        try {
          message = JSON.parse(line) as BridgeReply;
        } catch {
          continue;
        }
        const waiting = typeof message.id === 'number' ? pending.get(message.id) : undefined;
        if (waiting) {
          pending.delete(message.id as number);
          waiting.resolve(message);
        } else if (typeof message.event === 'string') {
          for (const listener of listeners) listener(message);
        }
      }
    });
    next.on('exit', () => {
      if (child === next) child = null;
      fail(new Error('The system bridge exited'));
    });
    next.on('error', (error) => fail(error));
    next.stdin?.on('error', () => {});
    child = next;
    return next;
  };

  return {
    request(request) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('The system bridge did not reply'));
        }, timeout);
        pending.set(id, {
          resolve: (reply) => {
            clearTimeout(timer);
            resolve(reply);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        start().stdin?.write(JSON.stringify({ ...request, id }) + '\n');
      });
    },
    onEvent(listener) {
      listeners.push(listener);
    },
    close() {
      child?.stdin?.end();
      child = null;
    },
  };
}

/**
 * Asks macOS to install the system helper. macOS only enables a new helper
 * after the person allows it in Login Items, so on `needs-approval` this
 * opens that pane; the caller says so and starts once it is allowed.
 */
export async function ensureHelper(bridge: SystemBridge): Promise<'installed' | 'needs-approval' | 'failed'> {
  const ask = (request: Record<string, unknown>) => bridge.request(request).catch(() => null);
  await ask({ op: 'install' });
  const helper = (await ask({ op: 'state' }))?.helper;
  if (helper === 'installed') return 'installed';
  if (helper !== 'needs-approval') return 'failed';
  await ask({ op: 'open-login-items' });
  return 'needs-approval';
}
