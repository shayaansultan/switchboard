// The Codex desktop adapter for a profile with no bucket: the engine runs as
// the app would run it, with only the phone's tap on its connection
// (desktop-stdio.ts). Launched through the wrapper desktop.ts writes while
// phone access is on.
import { run } from './desktop-stdio';

if (require.main === module) {
  const [binary, ...args] = process.argv.slice(2);
  if (!binary) throw new Error('Expected the Codex executable');
  run(null, binary, args);
}
