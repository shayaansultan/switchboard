// A desktop-only adapter around the unmodified bundled Codex executable.
// Run under Node, or packaged Electron with ELECTRON_RUN_AS_NODE=1.
//
// For a profile routed through a bucket it labels the bucket's models; for
// any profile launched while phone access is on (SWITCHBOARD_CONTROL_SOCKET
// set) it taps the app's connection to the engine so the phone can reply
// and approve (src/remote/codex-tap.ts). desktop-remote.ts runs it with no
// bucket.
import { spawn } from 'node:child_process';
import type { Transform } from 'node:stream';
import { codexTap } from '../remote/codex-tap';
import { ModelLabels, JsonLines } from './model-labels';

export function run(bucket: string | null, binary: string, args: string[]): void {
  // Keep Electron's Node-mode switch local to this adapter. Codex's tools may
  // launch Electron applications themselves.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(binary, args, { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const appServer = args.includes('app-server');
  const labels = new ModelLabels();
  const socket = process.env.SWITCHBOARD_CONTROL_SOCKET;
  const profileId = process.env.SWITCHBOARD_PROFILE;
  // Computer Use's engine listens on stdio:// and never holds the app's threads.
  const tap =
    appServer && socket && profileId && !args.includes('--listen')
      ? codexTap({ profileId, socket, engine: child.stdin })
      : null;
  const toEngine: Transform[] = [];
  const toApp: Transform[] = [];
  if (appServer && bucket !== null) {
    toEngine.push(new JsonLines((line) => labels.request(line)));
    toApp.push(new JsonLines((line) => labels.response(line)));
  }
  if (tap) {
    toEngine.push(tap.fromApp);
    toApp.unshift(tap.fromEngine);
  }
  const chain = (from: NodeJS.ReadableStream, steps: Transform[], to: NodeJS.WritableStream) =>
    steps.reduce<NodeJS.ReadableStream>((stream, step) => stream.pipe(step), from).pipe(to);
  chain(process.stdin, toEngine, child.stdin);
  chain(child.stdout, toApp, process.stdout);

  child.stdin.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') {
      console.error('Codex input pipe failed');
      child.kill('SIGTERM');
    }
  });
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  process.on('SIGINT', () => child.kill('SIGINT'));
  child.once('error', () => {
    console.error(
      bucket
        ? `Could not start the bundled Codex runtime for bucket ${bucket}`
        : 'Could not start the bundled Codex runtime',
    );
    process.exitCode = 1;
    process.stdin.destroy();
  });
  child.once('close', (code, signal) => {
    tap?.stop();
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
    process.stdin.destroy();
    // Stopping the tap ends its long poll, so the process exits once the
    // engine's last output has reached the app; this only bounds the wait.
    if (tap) setTimeout(() => process.exit(), 3000);
  });
}

if (require.main === module) {
  const [bucket, binary, ...args] = process.argv.slice(2);
  if (!bucket || !binary) throw new Error('Expected bucket label and Codex executable');
  run(bucket, binary, args);
}
