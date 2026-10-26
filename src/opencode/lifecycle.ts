// Launch leases and a removal gate live outside the movable profile directory.
// A launch registers before checking the gate; removal closes the gate before
// checking leases. Thus even a native-provider launch cannot slip past removal.
// Leases last until the foreground child exits, and allow multiple windows.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { root, ProfileId } from '../storage';
import { processAlive } from '../buckets/proxy';

function directory(id: string): string {
  return path.join(root(), 'opencode-lifecycle', ProfileId.parse(id));
}
function owner(file: string): number {
  const pid = Number(fs.readFileSync(file, 'utf8'));
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error(`Invalid lifecycle lock: ${file}. Inspect it before retrying.`);
  return pid;
}
function active(file: string): boolean {
  try {
    return processAlive(owner(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
export function holdLaunch(id: string): () => void {
  const base = directory(id);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const lease = path.join(base, `${process.pid}-${randomUUID()}.launch`);
  fs.writeFileSync(lease, String(process.pid), { flag: 'wx', mode: 0o600 });
  const release = () => fs.rmSync(lease, { force: true });
  try {
    // Even a dead remover must recover before any new launch can use its files.
    if (fs.existsSync(path.join(base, 'removing')))
      throw new Error(`OpenCode profile ${id} is being removed. Retry removal before launching.`);
    return release;
  } catch (error) {
    release();
    throw error;
  }
}
export function holdRemoval(id: string): () => void {
  const base = directory(id);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const gate = path.join(base, 'removing');
  // Leave stale gates for explicit recovery rather than racing two reclaimers.
  // A dead owner's gate is claimed via an exclusive recovery file.
  const recovery = path.join(base, 'recovering');
  if (fs.existsSync(gate) && !active(gate)) {
    let fd: number;
    try {
      fd = fs.openSync(recovery, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error(
          `OpenCode recovery is blocked by ${recovery}. Check for another running removal; if none is running, remove this leftover recovery file and retry.`,
        );
      throw error;
    }
    try {
      if (!active(gate)) fs.rmSync(gate, { force: true });
      fs.writeFileSync(gate, String(process.pid), { flag: 'wx', mode: 0o600 });
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(recovery);
    }
  } else fs.writeFileSync(gate, String(process.pid), { flag: 'wx', mode: 0o600 });
  const release = () => fs.rmSync(gate, { force: true });
  try {
    for (const entry of fs.readdirSync(base).filter((name) => name.endsWith('.launch'))) {
      const lease = path.join(base, entry);
      if (active(lease))
        throw new Error(`OpenCode profile ${id} has an active launch. Quit its OpenCode windows and tools first.`);
      fs.rmSync(lease, { force: true });
    }
    return release;
  } catch (error) {
    release();
    throw error;
  }
}
