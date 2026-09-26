#!/usr/bin/env node
// The `switchboard` command: everything the window can do, for a terminal or
// an agent. Results are JSON on stdout; see cli/output.ts for the contract.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { load } from './store';
import { INSTALLED_APP } from './buckets/runtime';
import { installShim, launcherScript } from './shim';
import { bucketCommand, workerCommand } from './cli/buckets';
import type { Context } from './cli/context';
import { parse, required } from './cli/context';
import { doctorCommand } from './cli/doctor';
import { launchCommand, quitCommand, quitOthersCommand, revealCommand, runningCommand } from './cli/desktop';
import { cliCommand, commandCommand, envCommand, execCommand, loginCommand, terminalCommand } from './cli/exec';
import { classify, consoleIo, Output, refused, usageError, type Flags, type Io } from './cli/output';
import {
  addCommand,
  assignCommand,
  bringOverCommand,
  listCommand,
  moveCommand,
  recolorCommand,
  removeCommand,
  renameCommand,
  setupItemsCommand,
  showCommand,
} from './cli/profiles';
import { settingsCommand } from './cli/settings';
import { pickCommand, usageCommand } from './cli/usage';
import { tokensCommand } from './cli/tokens';

const help = `Switchboard: run and inspect Claude and Codex accounts from a terminal

Read
  switchboard list [--vendor claude|codex]    Profiles, with running state and cached account
  switchboard show PROFILE                    One profile in full
  switchboard usage [PROFILE...] [--vendor V] [--max-age 15m | --refresh] [--no-renew]
  switchboard pick VENDOR [--window 5h|7d|LABEL] [--max-age 15m] [--min-headroom N]
  switchboard tokens [--days 30] [--by account|model|project|day]   Usage history the app keeps
  switchboard running                         Desktop windows and which profile owns each
  switchboard setup-items VENDOR              What add --from and bring-over can carry
  switchboard doctor                          Installed apps, CLIs, proxy, store and cache health
  switchboard settings get [KEY]

Profiles
  switchboard add VENDOR NAME [--from PROFILE [--items a,b|none] [--mode link|copy]]
  switchboard bring-over PROFILE --from SOURCE [--items a,b] [--mode link|copy]
  switchboard rename PROFILE NAME
  switchboard recolor PROFILE #rrggbb|INDEX
  switchboard move PROFILE up|down
  switchboard remove PROFILE --yes            Deletes the profile's directory tree
  switchboard assign PROFILE BUCKET           Route a Codex desktop profile through a bucket
  switchboard unassign PROFILE

Desktop
  switchboard launch PROFILE [--no-wait]
  switchboard quit PROFILE [--no-wait]
  switchboard quit-others PROFILE --yes       Before a first sign-in
  switchboard reveal PROFILE                  Open its directory in Finder

Shell
  switchboard command PROFILE [-- ARGS]       Print the one-line command for this profile
  switchboard env PROFILE [--fish]            eval "$(switchboard env work)"
  switchboard exec PROFILE [--cwd DIR] -- CMD [ARGS]
  switchboard cli PROFILE [ARGS]              exec with the vendor's own CLI
  switchboard terminal PROFILE [--cwd DIR]    Open a terminal window inside the profile
  switchboard login PROFILE [--here]          Sign the profile's CLI in

Buckets
  switchboard bucket list|show|create|start|stop|refresh|enable|disable|login|install-proxy ...

Setup
  switchboard settings set KEY VALUE
  switchboard install-cli [--dev]             ~/.local/bin/switchboard on the installed app

Flags: --human (tables for lists) --yes --quiet --json --version --help
Profiles are addressed by id (claude-work), vendor (claude = its Default), vendor/name or a unique name.
Results are JSON on stdout. Failures print {"error": CODE, ...} on stderr and exit 1 (failed),
2 (usage), 3 (not found) or 4 (refused). exec and cli exit with the command's own status.
`;

const COMMANDS = z.enum([
  'list',
  'show',
  'usage',
  'pick',
  'tokens',
  'running',
  'setup-items',
  'doctor',
  'settings',
  'add',
  'bring-over',
  'rename',
  'recolor',
  'move',
  'remove',
  'assign',
  'unassign',
  'launch',
  'quit',
  'quit-others',
  'reveal',
  'command',
  'env',
  'exec',
  'cli',
  'terminal',
  'login',
  'bucket',
  'install-cli',
  'worker',
  'help',
]);

// Flags that apply to every command. They may appear anywhere before `--`,
// or, for `cli PROFILE ...`, anywhere before the profile: everything after it
// belongs to the vendor's CLI.
export function splitFlags(args: string[]): { flags: Flags; rest: string[]; version: boolean } {
  const flags: Flags = { json: false, human: false, yes: false, quiet: false };
  let version = false;
  const rest: string[] = [];
  let passthrough = false;
  for (const arg of args) {
    if (passthrough) rest.push(arg);
    else if (arg === '--' || (rest[0] === 'cli' && rest.length === 2)) {
      passthrough = true;
      rest.push(arg);
    } else if (arg === '--json') flags.json = true;
    else if (arg === '--human' || arg === '-H') flags.human = true;
    else if (arg === '--yes' || arg === '-y') flags.yes = true;
    else if (arg === '--quiet' || arg === '-q') flags.quiet = true;
    else if (arg === '--version') version = true;
    else if (arg === '--help' || arg === '-h') rest.unshift('help');
    else rest.push(arg);
  }
  return { flags, rest, version };
}

function version(): string {
  return (JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { version: string })
    .version;
}

function installCli(rest: string[], ctx: Context): void {
  const { values } = parse(rest, { dev: { type: 'boolean' } });
  if (values.dev) {
    if (path.extname(__filename) === '.ts') {
      throw refused(
        'source-run',
        'Build first, then install from out/: bun run build && node out/cli.js install-cli --dev',
      );
    }
    const script = launcherScript('Switchboard CLI launcher (development checkout)', [process.execPath, __filename]);
    ctx.out.result({ installed: installShim('switchboard', script), mode: 'dev' });
    return;
  }
  const binary = path.join(INSTALLED_APP, 'Contents', 'MacOS', 'Switchboard');
  const entry = path.join(INSTALLED_APP, 'Contents', 'Resources', 'app.asar', 'out', 'cli.js');
  if (!fs.existsSync(binary)) {
    throw refused('not-installed', `${INSTALLED_APP} is not installed`, 'bun run install-app, or install-cli --dev');
  }
  const script = launcherScript('Switchboard CLI launcher', [binary, entry], { ELECTRON_RUN_AS_NODE: '1' });
  ctx.out.result({ installed: installShim('switchboard', script), mode: 'app' });
}

async function dispatch(rest: string[], out: Output): Promise<number | void> {
  const [head, ...args] = rest;
  const parsed = COMMANDS.safeParse(head ?? 'help');
  if (!parsed.success) throw usageError(`Unknown command "${head}"`);
  const command = parsed.data;
  if (command === 'help') {
    out.text(help);
    return;
  }
  if (command === 'worker') return workerCommand(args);
  const data = load();
  if (data.loadError) out.narrate(data.loadError);
  const ctx: Context = { data, out, flags: out.flags };
  switch (command) {
    case 'list':
      return listCommand(args, ctx);
    case 'show':
      return showCommand(args, ctx);
    case 'usage':
      return usageCommand(args, ctx);
    case 'pick':
      return pickCommand(args, ctx);
    case 'tokens':
      return tokensCommand(args, ctx);
    case 'running':
      return runningCommand(args, ctx);
    case 'setup-items':
      return setupItemsCommand(args, ctx);
    case 'doctor':
      return doctorCommand(args, ctx);
    case 'settings':
      return settingsCommand(args, ctx);
    case 'add':
      return addCommand(args, ctx);
    case 'bring-over':
      return bringOverCommand(args, ctx);
    case 'rename':
      return renameCommand(args, ctx);
    case 'recolor':
      return recolorCommand(args, ctx);
    case 'move':
      return moveCommand(args, ctx);
    case 'remove':
      return removeCommand(args, ctx);
    case 'assign':
      return assignCommand([args[0]], ctx, required(args[1], 'Bucket'));
    case 'unassign':
      return assignCommand(args, ctx, null);
    case 'launch':
      return launchCommand(args, ctx);
    case 'quit':
      return quitCommand(args, ctx);
    case 'quit-others':
      return quitOthersCommand(args, ctx);
    case 'reveal':
      return revealCommand(args, ctx);
    case 'command':
      return commandCommand(args, ctx);
    case 'env':
      return envCommand(args, ctx);
    case 'exec':
      return execCommand(args, ctx);
    case 'cli':
      return cliCommand(args, ctx);
    case 'terminal':
      return terminalCommand(args, ctx);
    case 'login':
      return loginCommand(args, ctx);
    case 'bucket':
      return bucketCommand(args, ctx);
    case 'install-cli':
      return installCli(args, ctx);
  }
}

// Runs one command and resolves with the process exit status.
export async function main(args = process.argv.slice(2), io: Io = consoleIo): Promise<number> {
  // Set by the launcher shim so the app's binary runs this file as Node.
  // Children (open, osascript, the vendor CLIs) must not inherit it.
  delete process.env.ELECTRON_RUN_AS_NODE;
  const { flags, rest, version: showVersion } = splitFlags(args);
  const out = new Output(io, flags);
  if (showVersion) {
    out.text(version());
    return 0;
  }
  try {
    return (await dispatch(rest, out)) ?? 0;
  } catch (error) {
    const failure = classify(error);
    out.fail(failure);
    return failure.exit;
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}
