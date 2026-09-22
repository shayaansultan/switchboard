// Putting a shell, a command or a sign-in inside a profile's environment.

import * as launch from '../launch';
import { VENDORS, dirs, ensureDirs } from '../store';
import { runInherit } from '../child';
import { shellQuote } from '../shell';
import type { Profile } from '../types';
import type { Context } from './context';
import { parse, required, splitPassthrough } from './context';
import { ref, refused, usageError } from './output';
import { resolveProfile } from './resolve';

// The environment a command runs in for this profile. A Default profile
// removes the variable, so a nested call from another profile's shell
// cannot leak that profile's home into this one.
export function execEnv(profile: Profile, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  const { homeEnv } = VENDORS[profile.vendor];
  const d = dirs(profile);
  if (d.isDefault) delete env[homeEnv];
  else env[homeEnv] = d.home;
  return env;
}

export function commandCommand(rest: string[], ctx: Context): void {
  const { own, passthrough } = splitPassthrough(rest);
  const profile = resolveProfile(ctx.data, required(own[0], 'Profile'));
  ctx.out.result({ command: launch.cliCommand(profile, (passthrough ?? []).join(' ')) });
}

export function envCommand(rest: string[], ctx: Context): void {
  const { values, positionals } = parse(rest, { fish: { type: 'boolean' } });
  const profile = resolveProfile(ctx.data, required(positionals[0], 'Profile'));
  const { homeEnv } = VENDORS[profile.vendor];
  const d = dirs(profile);
  if (ctx.flags.json) {
    ctx.out.result(d.isDefault ? { set: {}, unset: [homeEnv] } : { set: { [homeEnv]: d.home }, unset: [] });
    return;
  }
  if (values.fish) ctx.out.text(d.isDefault ? `set -e ${homeEnv}` : `set -gx ${homeEnv} ${shellQuote(d.home)}`);
  else ctx.out.text(d.isDefault ? `unset ${homeEnv}` : `export ${homeEnv}=${shellQuote(d.home)}`);
}

async function runInside(profile: Profile, command: string[], cwd?: string): Promise<number> {
  ensureDirs(profile);
  try {
    return await runInherit(command[0], command.slice(1), { env: execEnv(profile), cwd });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw refused('not-installed', `${command[0]} is not installed or not on PATH`);
    }
    throw error;
  }
}

export async function execCommand(rest: string[], ctx: Context): Promise<number> {
  const { own, passthrough } = splitPassthrough(rest);
  const { values, positionals } = parse(own, { cwd: { type: 'string' } });
  const profile = resolveProfile(ctx.data, required(positionals[0], 'Profile'));
  if (!passthrough?.length) throw usageError('Give the command after --: switchboard exec PROFILE -- claude --version');
  return runInside(profile, passthrough, values.cwd);
}

export async function cliCommand(rest: string[], ctx: Context): Promise<number> {
  const profile = resolveProfile(ctx.data, required(rest[0], 'Profile'));
  const args = rest[1] === '--' ? rest.slice(2) : rest.slice(1);
  return runInside(profile, [VENDORS[profile.vendor].cli, ...args]);
}

export async function terminalCommand(rest: string[], ctx: Context): Promise<void> {
  const { values, positionals } = parse(rest, { cwd: { type: 'string' } });
  const profile = resolveProfile(ctx.data, required(positionals[0], 'Profile'));
  await launch.openShell(profile, ctx.data.settings, values.cwd);
  ctx.out.result({ profile: ref(profile), opened: true, terminal: ctx.data.settings.terminal });
}

export async function loginCommand(rest: string[], ctx: Context): Promise<number | void> {
  const { values, positionals } = parse(rest, { here: { type: 'boolean' } });
  const profile = resolveProfile(ctx.data, required(positionals[0], 'Profile'));
  const login = profile.vendor === 'claude' ? ['auth', 'login'] : ['login'];
  if (values.here) {
    if (!process.stdin.isTTY) throw refused('not-a-tty', 'Sign-in is interactive; run --here from a terminal');
    return runInside(profile, [VENDORS[profile.vendor].cli, ...login]);
  }
  await launch.openLogin(profile, ctx.data.settings);
  ctx.out.result({
    profile: ref(profile),
    opened: true,
    terminal: ctx.data.settings.terminal,
    command: launch.loginCommand(profile),
  });
}
