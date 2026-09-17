// Run against compiled production code under Node, not Bun's different spawn
// implementation: bun run test:claude-pty. No real credentials or CLI involved.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnWithPty, recoverClaudeToken } = require('../out/claude-recovery');

test('Node PTY preserves arguments and forwards input to a terminal', { timeout: 5000 }, async (t) => {
  const value = 'a{b}\\c "$x" [expr 1+1]\nsecond line';
  const program =
    'console.log(JSON.stringify({tty:process.stdin.isTTY,arg:process.argv[1]}));' +
    'process.stdin.once("data", b=>{console.log("GOT:"+b.toString().trim());process.exit()})';
  const child = spawnWithPty(process.execPath, ['-e', program, value], process.cwd(), process.env);
  t.after(() => {
    child.kill('SIGTERM');
  });
  let output = '';
  let sent = false;
  child.stdout.on('data', (chunk) => {
    output += chunk;
    if (!sent && output.includes('"tty":true')) {
      sent = true;
      child.stdin.write('hello\n');
    }
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  const line = output.split(/\r?\n/).find((line) => line.startsWith('{"tty"'));
  assert.deepEqual(JSON.parse(line), { tty: true, arg: value });
  assert.match(output, /GOT:hello/);
});

test('recovery terminates the real PTY child on timeout', { timeout: 6000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-pty-check-'));
  const pidFile = path.join(root, 'pid');
  let pid;
  t.after(() => {
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  await assert.rejects(
    recoverClaudeToken(root, {
      timeoutMs: 1000,
      pollMs: 20,
      readCredential: async () => ({ token: 'synthetic', expiresAt: 1 }),
      spawnCli: (cwd, env) =>
        spawnWithPty(
          process.execPath,
          [
            '-e',
            'require("fs").writeFileSync(process.argv[1],String(process.pid));' +
              'process.on("SIGTERM",()=>{});process.on("SIGHUP",()=>{});setInterval(()=>{},1000)',
            pidFile,
          ],
          cwd,
          env,
        ),
    }),
    /did not renew/,
  );
  pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
