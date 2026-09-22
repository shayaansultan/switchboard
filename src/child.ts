// Run a command in the foreground, sharing this process's terminal, and
// resolve with the exit code a shell would report for it.

import { spawn } from 'node:child_process';
import * as os from 'node:os';

export function runInherit(
  command: string,
  args: string[],
  { env = process.env, cwd }: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1)));

    // Parent and child share the foreground terminal group. Let the child
    // receive terminal signals once, while the launcher waits for its exit.
    const waitForChild = () => {};
    process.on('SIGINT', waitForChild);
    const terminate = () => child.kill('SIGTERM');
    process.on('SIGTERM', terminate);
    child.once('close', () => {
      process.off('SIGINT', waitForChild);
      process.off('SIGTERM', terminate);
    });
  });
}
