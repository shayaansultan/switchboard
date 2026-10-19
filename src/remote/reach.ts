// Whether the phone can act on a profile's running desktop app, and the two
// ways to make it able to.
//
// The phone replies and approves through a hook inside each app: the
// switchboard-remote plugin in Claude, the engine tap in Codex (control.ts).
// A launch carries the hook in its environment, so an app Switchboard opened
// with phone access on has it, and one opened from the Dock, or before phone
// access was on, does not. macOS shows a person their own processes' launch
// environment (`ps -E`), so Switchboard reads the hook from the app itself:
// that stays right across restarts of Switchboard and for apps an older
// version opened. An app without it gets "Relaunch for phone control".
//
// Default Claude has a second way in. Claude Code also reads
// CLAUDE_CODE_PLUGIN_DIRS from the `env` block of ~/.claude/settings.json,
// in Desktop sessions too, so with the opt-in "Default Claude from the Dock"
// setting Switchboard adds the plugin and the control socket there, and
// takes exactly those back out when the setting or phone access goes off,
// and when Switchboard quits (main.ts), since both point into it.
// Nothing else in the file changes. The profile is not written: the plugin
// works it out from CLAUDE_CONFIG_DIR, so a copy of the file in another
// profile still reports the right one.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { HOME } from '../store';
import { readJson, writeJson } from '../storage';

export type Reach = 'ready' | 'relaunch' | null;

// ---- the hook in a running app ----

const SOCKET_KEY = 'SWITCHBOARD_CONTROL_SOCKET';
const DIRS_KEY = 'CLAUDE_CODE_PLUGIN_DIRS';
const PLUGIN_DIR_NAME = 'switchboard-remote';

// Whether one `ps -E` line, the command and then its environment, carries the
// phone's hook: the socket, plus the plugin for Claude or the engine wrapper
// for Codex. null when the environment could not be read at all.
export function hookIn(vendor: string, line: string): boolean | null {
  if (!/\sHOME=\S/.test(line)) return null;
  if (!new RegExp(`\\s${SOCKET_KEY}=\\S`).test(line)) return false;
  return vendor === 'claude'
    ? new RegExp(`\\s${DIRS_KEY}=[^=]*${PLUGIN_DIR_NAME}`).test(line)
    : /\sCODEX_CLI_PATH=\S/.test(line);
}

// A process's launch environment never changes, so each answer is kept for
// as long as the process runs. An unknown one is not: a process caught
// mid-launch shows its command before its environment.
const seen = new Map<number, { vendor: string; hooked: boolean }>();

// For each running app, whether it carries the hook.
export async function hookedApps(apps: { pid: number; vendor: string }[]): Promise<Map<number, boolean | null>> {
  const fresh = apps.filter((a) => seen.get(a.pid)?.vendor !== a.vendor);
  if (fresh.length) {
    // ps exits 1 when one of the processes has gone, and still prints the rest.
    const { stdout } = await promisify(execFile)(
      'ps',
      ['-E', '-o', 'pid=,command=', '-p', fresh.map((a) => a.pid).join(',')],
      { maxBuffer: 8 * 1024 * 1024, timeout: 5000 },
    ).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '' }));
    const lines = new Map<number, string>();
    for (const line of stdout.split('\n')) {
      const m = line.match(/^\s*(\d+)\s/);
      if (m) lines.set(Number(m[1]), line);
    }
    for (const a of fresh) {
      const hooked = hookIn(a.vendor, lines.get(a.pid) ?? '');
      if (hooked !== null) seen.set(a.pid, { vendor: a.vendor, hooked });
    }
  }
  const live = new Set(apps.map((a) => a.pid));
  for (const pid of seen.keys()) if (!live.has(pid)) seen.delete(pid);
  return new Map(apps.map((a) => [a.pid, seen.get(a.pid)?.hooked ?? null]));
}

// ---- Default Claude's settings entry ----

export const defaultClaudeSettingsFile = (): string => path.join(HOME, '.claude', 'settings.json');

type Json = Record<string, unknown>;

// The file as it is, or null when it is missing; a file that is not a JSON
// object is left alone, and reported.
function readSettings(file: string): Json | null {
  if (!fs.existsSync(file)) return null;
  const parsed = readJson(file);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(`${file} is not a JSON object; Switchboard left it alone`);
  return parsed as Json;
}

const isOurs = (dir: string) => path.basename(dir) === PLUGIN_DIR_NAME;

export function defaultClaudeLinked(file = defaultClaudeSettingsFile()): boolean {
  try {
    const env = (readSettings(file)?.env ?? {}) as Json;
    const dirs = typeof env[DIRS_KEY] === 'string' ? (env[DIRS_KEY] as string).split(path.delimiter) : [];
    return typeof env[SOCKET_KEY] === 'string' && dirs.some(isOurs);
  } catch {
    return false;
  }
}

// Adds the plugin folder (beside any the person listed) and the control
// socket. Returns whether the file changed.
export function linkDefaultClaude(plugin: string, socket: string, file = defaultClaudeSettingsFile()): boolean {
  const settings = readSettings(file) ?? {};
  const env = { ...((settings.env ?? {}) as Json) };
  const dirs = typeof env[DIRS_KEY] === 'string' ? (env[DIRS_KEY] as string).split(path.delimiter).filter(Boolean) : [];
  const nextDirs = [...dirs.filter((d) => !isOurs(d)), plugin].join(path.delimiter);
  if (env[DIRS_KEY] === nextDirs && env[SOCKET_KEY] === socket) return false;
  env[DIRS_KEY] = nextDirs;
  env[SOCKET_KEY] = socket;
  writeJson(file, { ...settings, env });
  return true;
}

// Takes out exactly what linkDefaultClaude put in. Returns whether the file
// changed.
export function unlinkDefaultClaude(file = defaultClaudeSettingsFile()): boolean {
  const settings = readSettings(file);
  if (!settings || !settings.env || typeof settings.env !== 'object') return false;
  const env = { ...(settings.env as Json) };
  let changed = false;
  if (typeof env[DIRS_KEY] === 'string') {
    const dirs = (env[DIRS_KEY] as string).split(path.delimiter).filter(Boolean);
    const kept = dirs.filter((d) => !isOurs(d));
    if (kept.length !== dirs.length) {
      changed = true;
      if (kept.length) env[DIRS_KEY] = kept.join(path.delimiter);
      else delete env[DIRS_KEY];
    }
  }
  if (SOCKET_KEY in env) {
    delete env[SOCKET_KEY];
    changed = true;
  }
  if (!changed) return false;
  const next: Json = { ...settings, env };
  if (!Object.keys(env).length) delete next.env;
  writeJson(file, next);
  return true;
}

// ---- reach ----

// `hooked` is what the running app's environment says (hookedApps); the app
// is undefined when it is not running.
export function reachOf(
  profile: { vendor: string; isDefault: boolean },
  hooked: boolean | null | undefined,
  phoneOn: boolean,
): Reach {
  if (!phoneOn || hooked === undefined) return null;
  if (hooked) return 'ready';
  if (profile.vendor === 'claude' && profile.isDefault && defaultClaudeLinked()) return 'ready';
  // Not known: say nothing rather than ask for a relaunch that may not help.
  return hooked === null ? null : 'relaunch';
}
