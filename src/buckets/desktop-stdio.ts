// A desktop-only adapter around the unmodified bundled Codex executable.
// Run under Node, or packaged Electron with ELECTRON_RUN_AS_NODE=1.
import { spawn } from 'node:child_process';
import { ModelLabels, JsonLines } from './model-labels';

function run(bucket: string, binary: string, args: string[]): void {
  // Keep Electron's Node-mode switch local to this adapter. Codex's tools may
  // launch Electron applications themselves.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(binary, args, { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const labels = new ModelLabels();
  const input = args.includes('app-server') ? new JsonLines((line) => labels.request(line)) : null;
  const output = args.includes('app-server') ? new JsonLines((line) => labels.response(line)) : null;
  if (input) process.stdin.pipe(input).pipe(child.stdin);
  else process.stdin.pipe(child.stdin);
  if (output) child.stdout.pipe(output).pipe(process.stdout);
  else child.stdout.pipe(process.stdout);

  child.stdin.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') {
      console.error('Codex input pipe failed');
      child.kill('SIGTERM');
    }
  });
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  process.on('SIGINT', () => child.kill('SIGINT'));
  child.once('error', () => {
    console.error(`Could not start the bundled Codex runtime for bucket ${bucket}`);
    process.exitCode = 1;
    process.stdin.destroy();
  });
  child.once('close', (code, signal) => {
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
    process.stdin.destroy();
  });
}

if (require.main === module) {
  const [bucket, binary, ...args] = process.argv.slice(2);
  if (!bucket || !binary) throw new Error('Expected bucket label and Codex executable');
  run(bucket, binary, args);
}
