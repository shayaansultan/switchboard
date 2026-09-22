// Drive the CLI in-process with captured output. No test spawns a process.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { sandboxHome } from './setup';
import { main } from '../src/cli';
import * as store from '../src/store';

if (!store.ROOT.startsWith(sandboxHome + path.sep)) {
  throw new Error(`refusing to run: store root is ${store.ROOT}, outside the sandbox ${sandboxHome}`);
}

export interface Run {
  code: number;
  out: string;
  err: string;
  json<T = Record<string, unknown>>(): T;
  failure(): { error: string; message: string; hint?: string; candidates?: unknown[]; details?: unknown };
}

export async function run(...args: string[]): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return {
    code,
    out: out.join('\n'),
    err: err.join('\n'),
    json: () => JSON.parse(out.join('\n')),
    failure: () => JSON.parse(err[err.length - 1] ?? 'null'),
  };
}

// A clean store, and the vendor homes the Default profiles point at.
export function resetStore(): void {
  for (const p of [store.ROOT, path.join(sandboxHome, '.claude'), path.join(sandboxHome, '.codex')]) {
    if (!p.startsWith(sandboxHome + path.sep)) throw new Error(`refusing to delete ${p}`);
    fs.rmSync(p, { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(sandboxHome, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(sandboxHome, '.codex'), { recursive: true });
}

// Pretend stdin is not a terminal, so confirmations cannot block on a prompt.
export function withoutTty<T>(fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  return fn().finally(() => {
    if (original) Object.defineProperty(process.stdin, 'isTTY', original);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
  });
}
