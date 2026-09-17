import { spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VENDORS } from './store';

const TIMEOUT_MS = 20_000;
const POLL_MS = 200;
const MAX_OUTPUT = 32_000;
const FAILURE_COOLDOWN_MS = 60_000;

export interface CredentialState {
  token: string;
  expiresAt: number | null;
}

export interface RecoveryOptions {
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  readCredential: () => Promise<CredentialState | null>;
  spawnCli?: (cwd: string, env: NodeJS.ProcessEnv) => ChildProcess;
}

const active = new Map<string, Promise<void>>();
const failedAt = new Map<string, number>();

function fingerprint(credential: CredentialState | null): string {
  if (!credential) return 'none';
  return crypto.createHash('sha256').update(credential.token).update(String(credential.expiresAt)).digest('hex');
}

function usable(credential: CredentialState | null, now: number): credential is CredentialState {
  return !!credential?.token && (!credential.expiresAt || credential.expiresAt > now);
}

function tclWord(value: string): string {
  // Double-quoted Tcl words preserve braces and whitespace. Escape every
  // substitution character, including backslashes, before embedding an arg.
  return `"${value.replace(/[\\$[\]"]/g, '\\$&')}"`;
}

export function spawnWithPty(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  // `expect` owns a real PTY. In Node/Electron, piping stdin to macOS `script`
  // gives script a socketpair and it exits at tcgetattr before starting Claude.
  // The PTY child owns a separate process group. Terminating expect alone
  // does not reliably terminate it, so the bridge cleans up its own child.
  const script = [
    'log_user 1',
    `spawn -noecho ${[command, ...args].map(tclWord).join(' ')}`,
    // Keep the workspace path and trust question on single lines.
    'stty rows 40 columns 240 < $spawn_out(slave,name)',
    'set child_pid [exp_pid]',
    'proc stop_child {} {',
    '  global child_pid',
    '  catch {exec /bin/kill -TERM -- -$child_pid}',
    '  after 200',
    '  catch {exec /bin/kill -KILL -- -$child_pid}',
    '  catch {wait}',
    '  exit',
    '}',
    'trap stop_child {SIGTERM SIGHUP SIGINT}',
    'interact',
    'stop_child',
  ].join('\n');
  return spawn('/usr/bin/expect', ['-c', script], { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
}

function defaultSpawn(cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  // macOS `expect` supplies the TTY Claude requires for interactive startup.
  // Claude writes OAuth data; Switchboard only rereads it to detect renewal.
  return spawnWithPty(
    'claude',
    [
      '--safe-mode',
      '--strict-mcp-config',
      '--no-chrome',
      '--disable-slash-commands',
      '--permission-mode',
      'plan',
      '--tools',
      '',
      '--settings',
      '{"remoteControlAtStartup":false}',
    ],
    cwd,
    env,
  );
}

function stopTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // It already exited.
    }
  }
}

function recoveryEnv(configDir: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Recovery must use this profile's Claude subscription. Do not allow a
  // launcher or login shell to redirect it to an API key, OAuth override, or
  // third-party/alternate endpoint.
  for (const key of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_PROFILE',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'GOOGLE_APPLICATION_CREDENTIALS',
  ]) {
    delete env[key];
  }
  // Setting this to ~/.claude is NOT equivalent to leaving it unset: Claude
  // relocates its onboarding/config state. Match the default CLI invocation.
  if (configDir === VENDORS.claude.defaultHome) delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = configDir;
  env.CLAUDE_CODE_SAFE_MODE = '1';
  delete env.CLAUDE_CODE_REMOTE_CONTROL;
  return env;
}

function plainTerminalOutput(output: string): string {
  // Claude renders word spacing with absolute horizontal cursor positions.
  // Removing these outright concatenates "Accessing workspace" into one word.
  /* eslint-disable no-control-regex -- terminal output contains ANSI escape sequences */
  return output
    .replace(/\x1b\[\d*G/g, ' ')
    .replace(/\x1b\[\d*C/g, ' ')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ');
  /* eslint-enable no-control-regex */
}

function isTrustPrompt(output: string, cwd: string): boolean {
  const plain = plainTerminalOutput(output);
  // Require the known menu, its exact workspace, and both options. Never
  // answer arbitrary text containing "trust" or a prompt for another folder.
  const start = Math.max(
    plain.lastIndexOf('Accessing workspace:'),
    plain.lastIndexOf('Do you trust the files in this folder?'),
  );
  if (start < 0) return false;
  const prompt = plain.slice(start);
  if (!/No, exit[\s\S]{0,500}Yes, I trust this folder/.test(prompt)) return false;
  return [cwd, fs.realpathSync(cwd)].some((candidate) => {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const workspace = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*(?:\\n|$)`);
    return (
      workspace.test(prompt) &&
      (prompt.startsWith('Do you trust the files in this folder?') ||
        prompt.includes('Quick safety check: Is this a project you created or one you trust?'))
    );
  });
}

function stopAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let giveUpTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      if (killTimer) clearTimeout(killTimer);
      if (giveUpTimer) clearTimeout(giveUpTimer);
      child.removeListener('close', finish);
      resolve();
    };
    child.once('close', finish);
    stopTree(child);
    child.stdin?.end();
    if (done) return;
    killTimer = setTimeout(() => {
      if (child.exitCode === null && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // It exited between the check and signal.
        }
      }
    }, 1000);
    giveUpTimer = setTimeout(finish, 2000);
  });
}

async function recover(configDir: string, options: RecoveryOptions): Promise<void> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const readCredential = async (): Promise<CredentialState | null> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Claude did not renew its session in time; open this profile in Terminal');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        options.readCredential(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Claude did not renew its session in time; open this profile in Terminal')),
            remaining,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const before = await readCredential();
  // A running Claude process may have renewed it since the usage check.
  if (usable(before, now())) return;
  const beforeFingerprint = fingerprint(before);
  let cwd: string | null = null;
  let child: ChildProcess | null = null;
  let output = '';
  let trustAccepted = false;
  let failure: Error | null = null;

  try {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-claude-recovery-'));
    fs.chmodSync(cwd, 0o700);
    try {
      child = (options.spawnCli ?? defaultSpawn)(cwd, { ...recoveryEnv(configDir), PWD: cwd });
    } catch {
      throw new Error('Claude could not be started for session renewal');
    }
    const capture = (chunk: Buffer | string) => {
      if (output.length < MAX_OUTPUT) output += String(chunk).slice(0, MAX_OUTPUT - output.length);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.stdin?.on('error', () => {
      // EPIPE is expected if Claude exits while cleanup or prompt input races it.
    });
    child.on('error', () => {
      // Do not expose spawn errors: their messages can include arguments,
      // environment-derived paths, or platform details.
      failure = new Error('Claude could not be started for session renewal');
    });

    while (Date.now() < deadline) {
      if (failure) throw failure;
      const plain = plainTerminalOutput(output);
      if (/sign in|log in|authenticate|open.*browser|verification code/i.test(plain)) {
        throw new Error('Claude needs an interactive sign-in; open this profile in Terminal');
      }
      if (!trustAccepted && isTrustPrompt(output, cwd)) {
        // "No, exit" is deliberately the default. Select the only other
        // option, which is safe because `cwd` is the empty directory above.
        if (child.stdin?.writable) child.stdin.write('\x1b[B\r', () => {});
        trustAccepted = true;
      }
      const current = await readCredential();
      if (usable(current, now()) && fingerprint(current) !== beforeFingerprint) {
        return;
      }
      if (child.exitCode !== null) throw new Error('Claude exited before renewing its session');
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? POLL_MS));
    }
    throw new Error('Claude did not renew its session in time; open this profile in Terminal');
  } finally {
    if (child) await stopAndWait(child);
    if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
  }
}

export async function recoverClaudeToken(configDir: string, options: RecoveryOptions): Promise<void> {
  const existing = active.get(configDir);
  if (existing) return existing;
  const now = options.now ?? Date.now;
  const lastFailure = failedAt.get(configDir);
  if (lastFailure !== undefined && now() - lastFailure < FAILURE_COOLDOWN_MS) {
    throw new Error('Claude session renewal recently failed; open this profile in Terminal or try again in a minute');
  }
  const attempt = recover(configDir, options)
    .catch((error) => {
      failedAt.set(configDir, now());
      throw error;
    })
    .finally(() => active.delete(configDir));
  active.set(configDir, attempt);
  return attempt;
}
