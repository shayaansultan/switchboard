// Launching, quitting and detecting desktop-app instances and terminals.
//
// Both desktop apps are Chromium-based, so `--user-data-dir` gives each
// instance its own session, cookies and local state. The CLI/agent side is
// isolated with an env var (CLAUDE_CONFIG_DIR / CODEX_HOME), which the Codex
// desktop app also honours because it embeds the same agent.

import { execFile, type ExecFileOptions, type ExecFileOptionsWithStringEncoding } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VENDORS, VENDOR_IDS, dirs, ensureDirs } from './store';
import { shellQuote } from './shell';
import type { Instance, Profile, Settings } from './types';
import { desktopEnvironment } from './buckets/desktop';

// What a failed command throws: the exec error plus whatever it printed.
export interface RunError extends Error {
  code?: number | string;
  stdout?: string;
  stderr?: string;
}

export function run(
  cmd: string,
  args: string[],
  opts: ExecFileOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const options = { timeout: 20000, ...opts, encoding: 'utf8' } as ExecFileOptionsWithStringEncoding;
    execFile(cmd, args, options, (err, stdout, stderr) => {
      if (err) {
        const e = err as RunError;
        e.stdout = stdout;
        e.stderr = stderr;
        reject(e);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

// An app launched from Finder inherits a minimal PATH, and `claude` or `codex`
// is often installed by a Node version manager (nvm, fnm, volta, mise, asdf)
// whose PATH only exists inside the user's shell. Ask the login shell once and
// adopt its PATH, so we find the same binaries the user's terminal does.
//
// This runs `env` rather than expanding $PATH in the shell, because the
// expansion is not portable: in fish, PATH is a list and "$PATH" comes back
// space-separated, which would produce a nonsense PATH. Every shell exports it
// to a child process colon-separated, so reading it back from `env` works the
// same everywhere. Taking the last match steps over anything the rc files echo.
// The login shell's own PATH, once known, so the window can say whether
// ~/.local/bin is really on it rather than only on ours.
export let loginShellPath: string | null = null;
export async function adoptLoginShellPath(): Promise<boolean> {
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const { stdout } = await run(shell, ['-ilc', '/usr/bin/env'], { timeout: 8000 });
    const line = stdout
      .split('\n')
      .reverse()
      .find((l) => l.startsWith('PATH='));
    const found = line ? line.slice('PATH='.length).trim() : '';
    if (found) {
      loginShellPath = found;
      const seen = new Set<string>();
      process.env.PATH = [...found.split(':'), ...(process.env.PATH || '').split(':')]
        .filter((p) => p && !seen.has(p) && seen.add(p))
        .join(':');
      return true;
    }
  } catch {
    /* fall back to the PATH we were given */
  }
  return false;
}

// Is a command runnable with the PATH we ended up with?
export async function haveCommand(cmd: string): Promise<boolean> {
  try {
    const { stdout } = await run('/usr/bin/env', ['sh', '-c', `command -v ${cmd}`]);
    return !!stdout.trim();
  } catch {
    return false;
  }
}

// Arguments for `open` that launch one profile's window.
//
// A non-default profile needs BOTH isolations and they cover different state:
//   --user-data-dir  the Chromium profile: cookies, the signed-in session
//   the env var      the embedded agent's home: sessions, plugins, config
// Passing only the flag leaves the second app's agent writing into the default
// home, which is a silent leak rather than a visible failure. `--env` takes the
// whole `NAME=value` as one argv element.
//
// `alreadyRunning` is only consulted for the Default profile, where `open -a`
// on its own would focus the existing window instead of starting a second one.
export function launchArgs(
  profile: Profile,
  alreadyRunning: boolean,
  environment: Record<string, string> = {},
): string[] {
  const v = VENDORS[profile.vendor];
  const d = dirs(profile);
  const env = Object.entries(environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
  if (d.isDefault) {
    return [...(alreadyRunning ? [] : ['-n']), ...env, '-a', v.appPath];
  }
  return ['-n', ...env, '--env', `${v.homeEnv}=${d.home}`, '-a', v.appPath, '--args', `--user-data-dir=${d.desktop}`];
}

export async function launchDesktop(profile: Profile): Promise<void> {
  const v = VENDORS[profile.vendor];
  if (!fs.existsSync(v.appPath)) throw new Error(`${v.appPath} is not installed`);
  ensureDirs(profile);
  const already = !!instanceFor(profile, await runningInstances());
  if (already && profile.proxyBucket)
    throw new Error('Quit this desktop profile before launching with a proxy bucket.');
  const environment = await desktopEnvironment(profile, dirs(profile).home);
  try {
    await run('open', launchArgs(profile, already, environment));
  } catch (error) {
    // execFile errors include argv; a proxy launch includes a local bearer key.
    if (profile.proxyBucket)
      throw new Error('Could not open the desktop app with its proxy connection. Retry from Switchboard.');
    throw error;
  }
}

// Every process on the machine, as ps reports it. Chromium helper processes
// carry --type=…; the browser/main process of an app does not.
async function mainProcesses(): Promise<{ pid: number; command: string }[]> {
  const { stdout } = await run('ps', ['-axo', 'pid=,command=']);
  const out: { pid: number; command: string }[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (m && !/--type=/.test(m[2])) out.push({ pid: Number(m[1]), command: m[2] });
  }
  return out;
}

// Snapshot of running desktop-app main processes.
export async function runningInstances(): Promise<Instance[]> {
  const out: Instance[] = [];
  for (const { pid, command } of await mainProcesses()) {
    for (const vendor of VENDOR_IDS) {
      if (!command.startsWith(VENDORS[vendor].appBinary)) continue;
      const udm = command.match(/--user-data-dir=(\S+)/);
      out.push({ pid, vendor, userDataDir: udm ? udm[1] : null });
    }
  }
  return out;
}

// Whether some other process is running the given executable.
export async function isRunning(binary: string): Promise<boolean> {
  return (await mainProcesses()).some((p) => p.pid !== process.pid && p.command.startsWith(binary));
}

// Is this running instance the given profile's window? The Default profile's
// window is the one launched without a user-data-dir.
function owns(profile: Profile, instance: Instance): boolean {
  if (instance.vendor !== profile.vendor) return false;
  const d = dirs(profile);
  return d.isDefault ? instance.userDataDir === null : instance.userDataDir === d.desktop;
}

export function instanceFor(profile: Profile, instances: Instance[]): Instance | undefined {
  return instances.find((i) => owns(profile, i));
}

export async function quitDesktop(profile: Profile): Promise<boolean> {
  const inst = instanceFor(profile, await runningInstances());
  if (!inst) return false;
  process.kill(inst.pid, 'SIGTERM');
  return true;
}

// For an app that ignored the polite quit, usually because it is showing a
// "quit anyway?" dialog. Anything unsaved in it is lost; its helper processes
// exit with it.
export async function forceQuitDesktop(profile: Profile): Promise<boolean> {
  const inst = instanceFor(profile, await runningInstances());
  if (!inst) return false;
  process.kill(inst.pid, 'SIGKILL');
  return true;
}

// ---- the native helper (src/native/app-events.swift) ----

// A native binary cannot run from inside app.asar; electron-builder unpacks
// it beside the archive (asarUnpack in package.json). Null when this build
// has none, e.g. one made off macOS.
export function appEventsHelper(): string | null {
  const file = path.join(__dirname, 'app-events').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  return fs.existsSync(file) ? file : null;
}

// How many windows each process has open, or null without Accessibility
// permission, in which case nobody should guess.
export async function windowCounts(helper: string, pids: number[]): Promise<Map<number, number> | null> {
  if (!pids.length) return new Map();
  const { stdout } = await run(helper, ['windows', ...pids.map(String)], { timeout: 5000 });
  const r = JSON.parse(stdout) as { trusted: boolean; windows?: Record<string, number> };
  if (!r.trusted) return null;
  return new Map(Object.entries(r.windows ?? {}).map(([pid, n]) => [Number(pid), n]));
}

// Bring back a profile's window, closed or minimised, as a click on its Dock
// icon would. Sent to that one process, so it reaches the right profile even
// with several instances of the same app running.
export async function showDesktop(profile: Profile, helper: string): Promise<boolean> {
  const inst = instanceFor(profile, await runningInstances());
  if (!inst) return false;
  const { stdout } = await run(helper, ['reopen', String(inst.pid)], { timeout: 5000 });
  return (JSON.parse(stdout) as { ok: boolean }).ok;
}

// Quit every instance of a vendor's app except the given profile's. Used
// before a first sign-in, because the login deep link is delivered to
// whichever instance macOS picks.
export async function quitOthers(profile: Profile): Promise<number> {
  const others = (await runningInstances()).filter((i) => i.vendor === profile.vendor && !owns(profile, i));
  for (const i of others) process.kill(i.pid, 'SIGTERM');
  return others.length;
}

// Terminals we know how to hand a command to. Only installed ones are offered.
interface TerminalApp {
  id: string;
  label: string;
  bundle: string;
}
interface InstalledTerminal extends TerminalApp {
  app: string;
}
const APP_DIRS = ['/Applications', path.join(os.homedir(), 'Applications'), '/System/Applications/Utilities'];
const TERMINALS: TerminalApp[] = [
  { id: 'Terminal', label: 'Terminal', bundle: 'Terminal.app' },
  { id: 'iTerm2', label: 'iTerm2', bundle: 'iTerm.app' },
  { id: 'Ghostty', label: 'Ghostty', bundle: 'Ghostty.app' },
  { id: 'Warp', label: 'Warp', bundle: 'Warp.app' },
  { id: 'kitty', label: 'kitty', bundle: 'kitty.app' },
  { id: 'Alacritty', label: 'Alacritty', bundle: 'Alacritty.app' },
  { id: 'WezTerm', label: 'WezTerm', bundle: 'WezTerm.app' },
];

function terminalApp(t: TerminalApp): string | null {
  for (const d of APP_DIRS) {
    const p = path.join(d, t.bundle);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function installedTerminals(): InstalledTerminal[] {
  const out: InstalledTerminal[] = [];
  for (const t of TERMINALS) {
    const app = terminalApp(t);
    if (app) out.push({ ...t, app });
  }
  return out;
}

// Warp has no "run this command" flag; it opens launch configurations by name.
function warpLaunchConfig(script: string, cwd?: string): string {
  const dir = path.join(os.homedir(), '.warp', 'launch_configurations');
  fs.mkdirSync(dir, { recursive: true });
  // Drop configs from earlier launches so they don't pile up in Warp's menu.
  for (const f of fs.readdirSync(dir)) {
    if (/^switchboard-\d+\.yaml$/.test(f) && Date.now() - Number(f.slice(12, -5)) > 60000)
      fs.unlinkSync(path.join(dir, f));
  }
  const name = `switchboard-${Date.now()}`;
  const yaml = `---
name: ${name}
windows:
  - tabs:
      - title: Switchboard
        layout:
          cwd: ${JSON.stringify(cwd || os.homedir())}
          commands:
            - exec: ${JSON.stringify(script)}
`;
  fs.writeFileSync(path.join(dir, `${name}.yaml`), yaml);
  return name;
}

// The `NAME='value'` assignment that puts a shell into the profile, or an
// empty string for a Default profile, which needs none.
function homeAssignment(profile: Profile): string {
  const v = VENDORS[profile.vendor];
  const d = dirs(profile);
  return d.isDefault ? '' : `${v.homeEnv}=${shellQuote(d.home)}`;
}

// The CLI with its arguments, e.g. `codex login`.
function cliInvocation(profile: Profile, extra: string): string {
  return [VENDORS[profile.vendor].cli, extra].filter(Boolean).join(' ');
}

// Command that puts the user's shell into a given profile, e.g.
//   CLAUDE_CONFIG_DIR='/Users/me/.switchboard/claude/work/home' claude
export function cliCommand(profile: Profile, extra = ''): string {
  return [homeAssignment(profile), cliInvocation(profile, extra)].filter(Boolean).join(' ');
}

export function loginCommand(profile: Profile): string {
  return cliCommand(profile, profile.vendor === 'claude' ? 'auth login' : 'login');
}

// Shell script that puts the session into the profile, then runs the CLI.
// The env var is exported so the shell you land in afterwards stays on the
// same account.
export function shellScript(profile: Profile, extra = ''): string {
  const assign = homeAssignment(profile);
  const cli = cliInvocation(profile, extra);
  return assign ? `export ${assign}; ${cli}` : cli;
}

// The CLI arguments that pick an agent session back up.
export function resumeArgs(profile: Profile, sessionId: string): string {
  return profile.vendor === 'claude' ? `--resume ${shellQuote(sessionId)}` : `resume ${shellQuote(sessionId)}`;
}

// Open a window in the chosen terminal that runs `script` in `cwd`.
// Unknown or uninstalled choices fall back to Terminal.app.
export async function openTerminal(
  script: string,
  { terminal = 'Terminal', cwd }: { terminal?: string; cwd?: string } = {},
): Promise<unknown> {
  const installed = installedTerminals();
  const t = installed.find((x) => x.id === terminal) || installed.find((x) => x.id === 'Terminal');
  if (!t) throw new Error('no terminal app found');
  const full = cwd ? `cd ${shellQuote(cwd)} && ${script}` : script;
  // For terminals that exit when the command does, keep a shell open after.
  const keepOpen = `${full}; exec "$SHELL"`;
  switch (t.id) {
    case 'iTerm2':
      return run('osascript', [
        '-e',
        `tell application "iTerm"
  activate
  set w to (create window with default profile)
  tell current session of w to write text ${JSON.stringify(full)}
end tell`,
      ]);
    case 'Ghostty':
      return run('open', ['-na', t.app, '--args', '-e', 'zsh', '-ic', keepOpen]);
    case 'Warp':
      return run('open', [`warp://launch/${warpLaunchConfig(full, cwd)}`]);
    case 'kitty':
      return run('open', ['-na', t.app, '--args', 'zsh', '-ic', keepOpen]);
    case 'Alacritty':
      return run('open', ['-na', t.app, '--args', '-e', 'zsh', '-ic', keepOpen]);
    case 'WezTerm':
      return run('open', ['-na', t.app, '--args', 'start', '--', 'zsh', '-ic', keepOpen]);
    default:
      return run('osascript', [
        '-e',
        `tell application "Terminal"
  activate
  do script ${JSON.stringify(full)}
end tell`,
      ]);
  }
}

export async function openLogin(profile: Profile, settings: Settings): Promise<void> {
  ensureDirs(profile);
  await openTerminal(shellScript(profile, profile.vendor === 'claude' ? 'auth login' : 'login'), {
    terminal: settings.terminal,
  });
}

export async function openShell(profile: Profile, settings: Settings, cwd?: string): Promise<void> {
  ensureDirs(profile);
  await openTerminal(shellScript(profile), { terminal: settings.terminal, cwd });
}

export function revealDir(profile: Profile): Promise<unknown> {
  const d = dirs(profile);
  return run('open', [d.isDefault ? d.home : path.dirname(d.home)]);
}
