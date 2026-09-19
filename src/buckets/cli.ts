// Worker entry point also runs under packaged Electron with ELECTRON_RUN_AS_NODE.
import { runWorker } from './proxy';

if (require.main === module) {
  const [command, id] = process.argv.slice(2);
  if (command !== 'worker' || !id) throw new Error('Expected worker BUCKET');
  runWorker(id).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Bucket worker failed');
    process.exitCode = 1;
  });
}
