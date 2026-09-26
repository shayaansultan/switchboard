// Shared disk primitives for isolated OpenCode profiles and proxy buckets.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const ProfileId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
  .brand<'ProfileId'>();
export const Secrets = z.object({ apiKey: z.string().min(32), managementKey: z.string().min(32) });

export function root(): string {
  return path.resolve(process.env.SWITCHBOARD_ROOT || path.join(process.env.HOME || os.homedir(), '.switchboard'));
}
export function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
// Readers see the old file or the new one, never half of either.
export function writeFileAtomic(file: string, text: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { mode, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
export function writeJson(file: string, value: unknown): void {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}
// The launch wrapper and model catalog a Codex desktop profile routed through
// a bucket starts with: one pair per profile, rewritten on each launch. A
// routed profile cannot be launched while it runs, so neither changes under
// the app using it.
export function desktopRouting(id: string): { wrapper: string; catalog: string } {
  // Desktop profile ids are slugs of any length, so only their shape is held.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`Not a profile id: ${id}`);
  const directory = path.join(root(), 'desktop-routing');
  return { wrapper: path.join(directory, `codex-${id}`), catalog: path.join(directory, `models-${id}.json`) };
}
