import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';

export function acquireWorkerLease(file: string): () => void {
  const owner = JSON.stringify({ pid: process.pid, instance: randomUUID() });

  try {
    fs.writeFileSync(file, owner, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Error(`A worker owns ${file}. Stop it, or inspect a stale lease before recovery.`);
  }

  // A lease lasts as long as the controller, unlike the launcher's short-lived
  // startup lock. A crash leaves it for explicit recovery rather than allowing
  // another process to race a surviving proxy's credential refreshes.
  return () => {
    try {
      if (fs.readFileSync(file, 'utf8') === owner) fs.unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
}
