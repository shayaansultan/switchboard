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
import {
  cliCommand,
  commandCommand,
  envCommand,
  execCommand,
  loginCommand,
  routedCommand,
  terminalCommand,
} from './cli/exec';
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
import { appCommand, caffeinateCommand, exportCommand, fansCommand } from './cli/app';
import { settingsCommand } from './cli/settings';
import { pickCommand, usageCommand } from './cli/usage';
import { resetsCommand } from './cli/resets';
import { remoteCommand } from './cli/remote';

const help = `Switchboard: run and inspect Claude and Codex accounts from a terminal

Read
  switchboard guide                           Print the same skill copied by the app
  switchboard list [--vendor claude|codex]    Profiles, with running state and cached account
  switchboard show PROFILE                    One profile in full
  switchboard usage [PROFILE...] [--vendor V] [--max-age 15m | --refresh] [--no-renew]
  switchboard pick VENDOR [--window 5h|7d|LABEL] [--max-age 15m] [--min-headroom N]
  switchboard resets PROFILE [--redeem GRANT_ID --yes]
                                            List native grants (spends with --redeem)
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
  switchboard quit PROFILE [--no-wait] [--force --yes]
  switchboard quit-others PROFILE --yes       Before a first sign-in
  switchboard focus PROFILE                   Show its existing app; never launch another profile
  switchboard caffeinate status|stop|dismiss   Keep the Mac awake, or Decaf (let it sleep as usual)
  switchboard caffeinate start [--minutes N] [--screen] [--lid]
                                              Stay awake N minutes (default 60; 0 until stopped),
                                              with the screen on, or with the lid closed too
  switchboard caffeinate extend [--minutes N] Add N minutes (default 60) to a timed session
  switchboard caffeinate clear                Turn sleep back on after pmset disablesleep
  switchboard fans status|system|dismiss       Fan speeds, or stop a boost and hand back to macOS
  switchboard fans set LEVEL [--minutes N]    Boost the fans to LEVEL% (steps of 5) for N minutes
                                              (default 15; 0 runs until system)
  switchboard fans extend [--minutes N]       Add N minutes (default 15) to a timed boost
  switchboard fans install|remove             The root system helper (install asks for approval)
  switchboard accessibility status|open       Permission of the running Switchboard app
  switchboard export PROFILE --format t3      Print provider config without credentials
  switchboard reveal PROFILE                  Open its directory in Finder

Shell
  switchboard command PROFILE [-- ARGS]       Print the one-line command for this profile
  switchboard env PROFILE [--fish]            eval "$(switchboard env work)"
  switchboard exec PROFILE [--cwd DIR] -- CMD [ARGS]
  switchboard cli PROFILE [ARGS]              exec with the vendor's own CLI
  switchboard routed PROFILE [ARGS]           cli through the profile's bucket, as its desktop window runs
  switchboard terminal PROFILE [--cwd DIR]    Open a terminal window inside the profile
  switchboard login PROFILE [--here]          Sign the profile's CLI in

Buckets
  switchboard bucket list|show|create|start|stop|refresh|enable|disable|login|install-proxy ...
  switchboard bucket create-api NAME --base-url URL --credential-file PATH --credential-env NAME
       --adapter responses --model ID [--budget-url URL] [--opencode] [--allow-mutable-default]
  switchboard bucket credential BUCKET PATH VARIABLE  Change a stopped API bucket credential reference
  switchboard bucket model BUCKET ID          Change a stopped API bucket default model
  switchboard bucket inspect-api BUCKET       Refresh API catalogue and accounting without starting a worker
  switchboard bucket remove BUCKET --yes      Delete it (and its OpenCode profile) and unassign its profiles
  switchboard bucket remove-account BUCKET ACCOUNT --yes
  switchboard bucket resets BUCKET ACCOUNT [--redeem GRANT_ID --yes]
                                            List or spend proxy-account reset grants

Phone access
  switchboard remote status                   Whether the hub is listening, and the phone's address
  switchboard remote on [--port N] | off      Serve the phone app (the app runs the hub)
  switchboard remote pair                     A one-time code for pairing a phone
  switchboard remote devices                  Paired phones
  switchboard remote unpair DEVICE_ID | --all --yes
  switchboard remote notifications [DEVICE_ID [--kinds needs,finished,errored,limits] [--sessions desktop|all] [--off] [--test]]
                                            What each phone is notified about, and whether terminal, IDE and
                                            scripted sessions count; phones turn them on themselves
  switchboard remote publish                  Publish phone access on this Mac's tailnet (runs tailscale serve)
  switchboard remote relaunch PROFILE         Quit an app the phone can't reach and reopen it with the phone's hook
  switchboard remote sessions [PROFILE...] [--all] [--working]
                                            Recent sessions as the phone sees them (desktop only unless --all)
  switchboard remote session PROFILE SESSION_ID [--before N]
                                            One page of a transcript; pass the page's before value for older entries

Setup
  switchboard settings set KEY VALUE
  switchboard install-cli [--dev]             ~/.local/bin/switchboard on the installed app

Flags: --human (tables for lists) --yes --quiet --json --version --help
Profiles are addressed by id (claude-work), vendor (claude = its Default), vendor/name or a unique name.
Results are JSON on stdout. Failures print {"error": CODE, ...} on stderr and exit 1 (failed),
2 (usage), 3 (not found) or 4 (refused). exec, cli and routed exit with the command's own status.
`;

const COMMANDS = z.enum([
  'list',
  'show',
  'usage',
  'resets',
  'pick',
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
  'caffeinate',
  'fans',
  'accessibility',
  'focus',
  'export',
  'launch',
  'quit',
  'quit-others',
  'reveal',
  'command',
  'env',
  'exec',
  'cli',
  'routed',
  'terminal',
  'login',
  'bucket',
  'remote',
  'install-cli',
  'worker',
  'help',
  'guide',
]);

// Flags that apply to every command. They may appear anywhere before `--`,
// or, for `cli PROFILE ...` and `routed PROFILE ...`, anywhere before the profile: everything after it
// belongs to the vendor's CLI.
export function splitFlags(args: string[]): { flags: Flags; rest: string[]; version: boolean } {
  const flags: Flags = { json: false, human: false, yes: false, quiet: false };
  let version = false;
  const rest: string[] = [];
  let passthrough = false;
  for (const arg of args) {
    if (passthrough) rest.push(arg);
    else if (arg === '--' || ((rest[0] === 'cli' || rest[0] === 'routed') && rest.length === 2)) {
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
  if (command === 'guide') {
    if (args.length) throw usageError('guide takes no arguments');
    out.text(fs.readFileSync(path.join(__dirname, '..', 'skills', 'switchboard', 'SKILL.md'), 'utf8'));
    return;
  }
  if (command === 'worker') return workerCommand(args);
  const data = load();
  if (data.loadError) out.narrate(data.loadError);
  const ctx: Context = { data, out, flags: out.flags };
  switch (command) {
    case 'accessibility':
    case 'focus':
      return appCommand(command, args, ctx);
    case 'fans':
      return fansCommand(args, ctx);
    case 'caffeinate':
      return caffeinateCommand(args, ctx);
    case 'export':
      return exportCommand(args, ctx);
    case 'list':
      return listCommand(args, ctx);
    case 'show':
      return showCommand(args, ctx);
    case 'usage':
      return usageCommand(args, ctx);
    case 'resets':
      return resetsCommand(args, ctx);
    case 'pick':
      return pickCommand(args, ctx);
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
    case 'routed':
      return routedCommand(args, ctx);
    case 'terminal':
      return terminalCommand(args, ctx);
    case 'login':
      return loginCommand(args, ctx);
    case 'bucket':
      return bucketCommand(args, ctx);
    case 'remote':
      return remoteCommand(args, ctx);
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
