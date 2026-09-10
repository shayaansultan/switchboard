// Launching, quitting and detecting desktop-app instances and terminals.
//
// Both desktop apps are Chromium-based, so `--user-data-dir` gives each
// instance its own session, cookies and local state. The CLI/agent side is
// isolated with an env var (CLAUDE_CONFIG_DIR / CODEX_HOME), which the Codex
// desktop app also honours because it embeds the same agent.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { VENDORS, dirs, ensureDirs } = require('./profiles');

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 20000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
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
async function adoptLoginShellPath() {
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const { stdout } = await run(shell, ['-ilc', '/usr/bin/env'], { timeout: 8000 });
    const line = stdout
      .split('\n')
      .reverse()
      .find((l) => l.startsWith('PATH='));
    const found = line ? line.slice('PATH='.length).trim() : '';
    if (found) {
      const seen = new Set();
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
async function haveCommand(cmd) {
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
function launchArgs(profile, alreadyRunning) {
  const v = VENDORS[profile.vendor];
  const d = dirs(profile);
  if (d.isDefault) {
    return [...(alreadyRunning ? [] : ['-n']), '-a', v.appPath];
  }
  return ['-n', '--env', `${v.homeEnv}=${d.home}`, '-a', v.appPath, '--args', `--user-data-dir=${d.desktop}`];
}

async function launchDesktop(profile) {
  const v = VENDORS[profile.vendor];
  if (!fs.existsSync(v.appPath)) throw new Error(`${v.appPath} is not installed`);
  ensureDirs(profile);
  const already = dirs(profile).isDefault ? !!instanceFor(profile, await runningInstances()) : false;
  await run('open', launchArgs(profile, already));
}

// Snapshot of running desktop-app main processes: [{pid, vendor, userDataDir|null}]
async function runningInstances() {
  const { stdout } = await run('ps', ['-axo', 'pid=,command=']);
  const out = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const cmd = m[2];
    for (const [vendor, v] of Object.entries(VENDORS)) {
      if (!cmd.startsWith(v.appBinary)) continue;
      // Helper processes have --type=…; the browser/main process does not.
      if (/--type=/.test(cmd)) continue;
      const udm = cmd.match(/--user-data-dir=(\S+)/);
      out.push({ pid, vendor, userDataDir: udm ? udm[1] : null });
    }
  }
  return out;
}

function instanceFor(profile, instances) {
  const d = dirs(profile);
  return instances.find((i) => {
    if (i.vendor !== profile.vendor) return false;
    return d.isDefault ? i.userDataDir === null : i.userDataDir === d.desktop;
  });
}

async function quitDesktop(profile) {
  const inst = instanceFor(profile, await runningInstances());
  if (!inst) return false;
  process.kill(inst.pid, 'SIGTERM');
  return true;
}

// Quit every instance of a vendor's app except the given profile's. Used
// before a first sign-in, because the login deep link is delivered to
// whichever instance macOS picks.
async function quitOthers(profile) {
  const d = dirs(profile);
  const list = (await runningInstances()).filter((i) => i.vendor === profile.vendor);
  let n = 0;
  for (const i of list) {
    const mine = d.isDefault ? i.userDataDir === null : i.userDataDir === d.desktop;
    if (mine) continue;
    process.kill(i.pid, 'SIGTERM');
    n++;
  }
  return n;
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Terminals we know how to hand a command to. Only installed ones are offered.
const APP_DIRS = [
  '/Applications',
  path.join(require('os').homedir(), 'Applications'),
  '/System/Applications/Utilities',
];
const TERMINALS = [
  { id: 'Terminal', label: 'Terminal', bundle: 'Terminal.app' },
  { id: 'iTerm2', label: 'iTerm2', bundle: 'iTerm.app' },
  { id: 'Ghostty', label: 'Ghostty', bundle: 'Ghostty.app' },
  { id: 'Warp', label: 'Warp', bundle: 'Warp.app' },
  { id: 'kitty', label: 'kitty', bundle: 'kitty.app' },
  { id: 'Alacritty', label: 'Alacritty', bundle: 'Alacritty.app' },
  { id: 'WezTerm', label: 'WezTerm', bundle: 'WezTerm.app' },
];

function terminalApp(t) {
  for (const d of APP_DIRS) {
    const p = path.join(d, t.bundle);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function installedTerminals() {
  return TERMINALS.map((t) => ({ ...t, app: terminalApp(t) })).filter((t) => t.app);
}

// Warp has no "run this command" flag; it opens launch configurations by name.
function warpLaunchConfig(script, cwd) {
  const dir = path.join(require('os').homedir(), '.warp', 'launch_configurations');
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
          cwd: ${JSON.stringify(cwd || require('os').homedir())}
          commands:
            - exec: ${JSON.stringify(script)}
`;
  fs.writeFileSync(path.join(dir, `${name}.yaml`), yaml);
  return name;
}

// Command that puts the user's shell into a given profile, e.g.
//   CLAUDE_CONFIG_DIR='/Users/me/.switchboard/claude/work/home' claude
function cliCommand(profile, extra = '') {
  const v = VENDORS[profile.vendor];
  const d = dirs(profile);
  const prefix = d.isDefault ? '' : `${v.homeEnv}=${shellQuote(d.home)} `;
  return `${prefix}${v.cli}${extra ? ' ' + extra : ''}`.trim();
}

function loginCommand(profile) {
  return cliCommand(profile, profile.vendor === 'claude' ? 'auth login' : 'login');
}

// Shell script that puts the session into the profile, then runs the CLI.
// The env var is exported so the shell you land in afterwards stays on the
// same account.
function shellScript(profile, extra = '') {
  const v = VENDORS[profile.vendor];
  const d = dirs(profile);
  const prefix = d.isDefault ? '' : `export ${v.homeEnv}=${shellQuote(d.home)}; `;
  return `${prefix}${v.cli}${extra ? ' ' + extra : ''}`;
}

// Open a window in the chosen terminal that runs `script` in `cwd`.
// Unknown or uninstalled choices fall back to Terminal.app.
async function openTerminal(script, { terminal = 'Terminal', cwd } = {}) {
  const t =
    installedTerminals().find((x) => x.id === terminal) || installedTerminals().find((x) => x.id === 'Terminal');
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

async function openLogin(profile, settings) {
  ensureDirs(profile);
  await openTerminal(shellScript(profile, profile.vendor === 'claude' ? 'auth login' : 'login'), {
    terminal: settings.terminal,
  });
}

async function openShell(profile, settings, cwd) {
  ensureDirs(profile);
  await openTerminal(shellScript(profile), { terminal: settings.terminal, cwd });
}

function revealDir(profile) {
  const d = dirs(profile);
  return run('open', [d.isDefault ? d.home : path.dirname(d.home)]);
}

module.exports = {
  run,
  launchArgs,
  adoptLoginShellPath,
  haveCommand,
  installedTerminals,
  openTerminal,
  shellScript,
  launchDesktop,
  quitDesktop,
  quitOthers,
  runningInstances,
  instanceFor,
  cliCommand,
  loginCommand,
  openLogin,
  openShell,
  revealDir,
};
