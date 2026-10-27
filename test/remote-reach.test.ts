// Whether the phone can act on a running app (src/remote/reach.ts): the hook
// in the app's launch environment, and the opt-in entry in Default Claude's
// settings.json. These pin that the entry goes in and comes out
// without touching anything else in the person's file, and which running app
// gets "Relaunch for phone control".

import { test, expect, afterEach } from 'bun:test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  defaultClaudeLinked,
  defaultClaudeSettingsFile,
  hookedApps,
  hookIn,
  linkDefaultClaude,
  reachOf,
  unlinkDefaultClaude,
} from '../src/remote/reach';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-reach-'));
const file = path.join(dir, 'settings.json');
const plugin = '/Applications/Switchboard.app/Contents/Resources/plugins/switchboard-remote';
const socket = '/Users/someone/.switchboard/remote/control.sock';
const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));

afterEach(() => {
  fs.rmSync(file, { force: true });
  fs.rmSync(defaultClaudeSettingsFile(), { force: true });
});

test('linking adds the plugin beside the person’s own, and unlinking leaves the file as it was', () => {
  const before = {
    model: 'opus',
    permissions: { allow: ['Bash(ls)'] },
    env: { MCP_TIMEOUT: '60000', CLAUDE_CODE_PLUGIN_DIRS: `/Users/someone/plugins/mine${path.delimiter}` },
  };
  fs.writeFileSync(file, JSON.stringify(before));
  expect(defaultClaudeLinked(file)).toBe(false);

  expect(linkDefaultClaude(plugin, socket, file)).toBe(true);
  expect(read()).toEqual({
    ...before,
    env: {
      MCP_TIMEOUT: '60000',
      CLAUDE_CODE_PLUGIN_DIRS: ['/Users/someone/plugins/mine', plugin].join(path.delimiter),
      SWITCHBOARD_CONTROL_SOCKET: socket,
    },
  });
  expect(defaultClaudeLinked(file)).toBe(true);
  // Again changes nothing; a moved app replaces its old folder rather than adding a second.
  expect(linkDefaultClaude(plugin, socket, file)).toBe(false);
  const moved = '/Users/someone/Applications/Switchboard.app/Contents/Resources/plugins/switchboard-remote';
  expect(linkDefaultClaude(moved, socket, file)).toBe(true);
  expect(read().env.CLAUDE_CODE_PLUGIN_DIRS).toBe(['/Users/someone/plugins/mine', moved].join(path.delimiter));

  expect(unlinkDefaultClaude(file)).toBe(true);
  expect(read()).toEqual({
    ...before,
    env: { MCP_TIMEOUT: '60000', CLAUDE_CODE_PLUGIN_DIRS: '/Users/someone/plugins/mine' },
  });
  expect(defaultClaudeLinked(file)).toBe(false);
  expect(unlinkDefaultClaude(file)).toBe(false);
});

test('an env block that held only our entry goes away with it, and a missing file is created', () => {
  expect(unlinkDefaultClaude(file)).toBe(false);
  expect(fs.existsSync(file)).toBe(false);
  expect(linkDefaultClaude(plugin, socket, file)).toBe(true);
  expect(read()).toEqual({ env: { CLAUDE_CODE_PLUGIN_DIRS: plugin, SWITCHBOARD_CONTROL_SOCKET: socket } });
  fs.writeFileSync(file, JSON.stringify({ theme: 'dark', ...read() }));
  expect(unlinkDefaultClaude(file)).toBe(true);
  expect(read()).toEqual({ theme: 'dark' });
});

test('a settings file that is not a JSON object is left alone', () => {
  fs.writeFileSync(file, '[1, 2]');
  expect(() => linkDefaultClaude(plugin, socket, file)).toThrow('not a JSON object');
  expect(() => unlinkDefaultClaude(file)).toThrow('not a JSON object');
  expect(defaultClaudeLinked(file)).toBe(false);
  expect(fs.readFileSync(file, 'utf8')).toBe('[1, 2]');
});

// `ps -E` lines as macOS prints them: the command, then its environment.
const env = 'HOME=/Users/someone PATH=/usr/bin:/bin TMPDIR=/var/folders/x';
const claudeLine = (extra: string) => `  4242 /Applications/Claude.app/Contents/MacOS/Claude ${env} ${extra}`.trim();
const codexLine = (extra: string) => `  5150 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT ${env} ${extra}`.trim();

test('the hook is read from the app’s own launch environment', () => {
  const hooked = `SWITCHBOARD_CONTROL_SOCKET=${socket} CLAUDE_CODE_PLUGIN_DIRS=/Users/someone/mine:${plugin}`;
  expect(hookIn('claude', claudeLine(hooked))).toBe(true);
  // Opened from the Dock: launchd's environment, nothing of Switchboard's.
  expect(hookIn('claude', claudeLine('__CFBundleIdentifier=com.anthropic.claudefordesktop'))).toBe(false);
  // The profile band alone is not the phone's hook.
  expect(hookIn('claude', claudeLine('CLAUDE_CODE_PLUGIN_DIRS=/x/profile-band SWITCHBOARD_PROFILE=claude-work'))).toBe(
    false,
  );
  expect(hookIn('codex', codexLine(`SWITCHBOARD_CONTROL_SOCKET=${socket} CODEX_CLI_PATH=/x/codex-remote`))).toBe(true);
  // A proxy bucket's engine wrapper without phone access.
  expect(hookIn('codex', codexLine('CODEX_CLI_PATH=/x/codex-routed'))).toBe(false);
  // ps showed the command but no environment: unknown, not "relaunch".
  expect(hookIn('codex', '  5150 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT')).toBeNull();
});

test('a running app without the hook is offered a relaunch; one not running, or unknown, is not', () => {
  const work = { vendor: 'codex', isDefault: false };
  expect(reachOf(work, true, true)).toBe('ready');
  expect(reachOf(work, false, true)).toBe('relaunch');
  expect(reachOf(work, null, true)).toBeNull();
  expect(reachOf(work, undefined, true)).toBeNull();
  expect(reachOf(work, false, false)).toBeNull();
});

// `ps -E` is macOS's; elsewhere every app reads as unknown.
test.skipIf(process.platform !== 'darwin')('a real process’s environment is read once it is running', async () => {
  // Not a system binary: macOS hides the environment of its own.
  const start = (env: Record<string, string>) =>
    spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { env, stdio: 'ignore' });
  const hooked = start({
    HOME: '/Users/someone',
    SWITCHBOARD_CONTROL_SOCKET: socket,
    CODEX_CLI_PATH: '/x/codex-remote',
  });
  const plain = start({ HOME: '/Users/someone' });
  const gone = start({ HOME: '/Users/someone' });
  gone.kill();
  await new Promise((r) => gone.once('exit', r));
  try {
    const apps = [hooked, plain, gone].map((c) => ({ pid: c.pid!, vendor: 'codex' }));
    // Until each has started, its environment reads as unknown and is asked for again.
    let out = await hookedApps(apps);
    for (let i = 0; i < 100 && (out.get(hooked.pid!) === null || out.get(plain.pid!) === null); i++) {
      await new Promise((r) => setTimeout(r, 20));
      out = await hookedApps(apps);
    }
    expect(out.get(hooked.pid!)).toBe(true);
    expect(out.get(plain.pid!)).toBe(false);
    expect(out.get(gone.pid!)).toBeNull();
  } finally {
    hooked.kill();
    plain.kill();
  }
});

test('Default Claude opened from the Dock is ready while its settings carry the plugin', () => {
  const claude = { vendor: 'claude', isDefault: true };
  const codex = { vendor: 'codex', isDefault: true };
  expect(reachOf(claude, false, true)).toBe('relaunch');
  fs.mkdirSync(path.dirname(defaultClaudeSettingsFile()), { recursive: true });
  linkDefaultClaude(plugin, socket);
  expect(reachOf(claude, false, true)).toBe('ready');
  // Codex has no settings entry to lean on.
  expect(reachOf(codex, false, true)).toBe('relaunch');
});
