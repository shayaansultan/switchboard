// The store resolves HOME at import time. Establish one isolated home before
// any test module loads, regardless of filesystem/test discovery order.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const sandboxHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-tests-')));
const originalHome = process.env.HOME;
process.env.HOME = sandboxHome;

process.once('exit', () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(sandboxHome, { recursive: true, force: true });
});
