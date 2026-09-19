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
export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
