#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { parseArgs, promisify } from 'node:util';
import { z } from 'zod';
import * as profiles from './profiles';
import * as imports from './imports';
import * as proxy from '../buckets/proxy';
import { runInherit as terminal } from '../child';
import { installShim, launcherScript } from '../shim';
import { bridgeArgs, launchEnv } from './launch';
import { bindGitHub } from './github';
import { modelArguments, modelRef, poolId, saveModel, selectedPoolModel } from './selection';
import { preparePool } from './pool';
import {
  Access,
  Connection,
  Identity,
  ImportMode,
  ModelRef,
  ReasoningEffort,
  Service,
  unreachable,
  type Profile,
} from './types';

const execute = promisify(execFile);
// This file, on the runtime that is executing it: what respawns of oc use.
const self = { execPath: process.execPath, script: __filename };
const help = `Switchboard OpenCode profiles

  oc                              Choose a profile in this terminal
  oc PROFILE [OpenCode options]   Open a profile in the current project
  oc create NAME                  Create an independent profile
  oc list                         List profiles
  oc show PROFILE                 Show profile settings, without credentials
  oc import PROFILE SOURCE        Choose specific skills/settings to copy or link
  oc connect PROFILE SERVICE      Configure one hosted service connection
       --codex-home PATH --account EMAIL [--bridge PATH] [--access read-write]
  oc disconnect PROFILE SERVICE   Remove a connection from this profile
  oc bridge PROFILE SERVICE ...   Run the bound bridge CLI (tools/call/doctor)
  oc native PROFILE AGENT ...     Run claude or codex-computer with the profile's login
  oc probe SERVICE                Inspect a service, using the same connection flags
  oc model PROFILE MODEL          Save a provider/model default (bare names use the pool)
  oc models PROFILE [PROVIDER]     List this profile's available models
  oc small-model PROFILE MODEL    Set auxiliary model; default uses native selection
  oc effort PROFILE LEVEL         Set pool reasoning: low, medium, high, xhigh, max
  oc project-config PROFILE MODE  isolated (default) or inherit
  oc login PROFILE                Sign a ChatGPT account into this profile's pool
  oc status PROFILE               Worker and quota status
  oc refresh PROFILE              Refresh quota observations
  oc stop PROFILE                 Stop this profile's routing worker
  oc doctor PROFILE               Verify isolated OpenCode directories
  oc proxy-install                Install the pinned macOS proxy release
  oc install-cli                  Install ~/.local/bin/oc, without shell changes

Services: google-workspace, slack, linear, github, notion, wispr-flow
Import flags: --items 1,3,5 --mode copy|link --dry-run
Each connection pins its own source account. AI routing never changes it.
`;

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required. Run oc --help.`);
  return value;
}

async function choose<T>(message: string, options: readonly T[], label: (option: T) => string): Promise<T> {
  if (!process.stdin.isTTY)
    throw new Error('Specify the profile or selection explicitly outside an interactive terminal');
  const prompt = createInterface({ input: process.stdin, output: process.stderr });

  try {
    console.error(message);
    options.forEach((option, index) => console.error(`  ${index + 1}. ${label(option)}`));
    const answer = await prompt.question('Choice: ');
    const index = Number(answer) - 1;

    if (!Number.isInteger(index) || !options[index]) throw new Error('No valid selection');
    return options[index];
  } finally {
    prompt.close();
  }
}

async function open(profile: Profile, args: string[]): Promise<number> {
  const selection = modelArguments(args);
  profile = { ...profile, poolModel: selectedPoolModel(profile), model: selection.model ?? profile.model };
  await verifyPaths(profile);
  const required = Boolean(poolId(profile.model) || (profile.smallModel && poolId(profile.smallModel)));
  const pool = required ? await preparePool(profile, self) : await optionalPool(profile);
  const env = await bindGitHub(profile.githubLogin, launchEnv(profile, pool?.port, process.cwd()));

  if (process.stdout.isTTY) {
    // Strip terminal control characters before using a user-chosen profile name.
    // eslint-disable-next-line no-control-regex
    process.stdout.write(`\u001b]0;OpenCode · ${profile.name.replace(/[\x00-\x1f\x7f]/g, '')}\u0007`);
    console.error(
      `${profile.name} · ${modelRef(profile.model)} · ${pool?.accounts ?? 0} pool account(s) · ${Object.keys(profile.connections).length} separate service connection(s)`,
    );
  }

  return terminal(process.env.SWITCHBOARD_OPENCODE || 'opencode', selection.args, { env });
}

async function optionalPool(profile: Profile): Promise<{ port: number; accounts: number } | undefined> {
  // The proxy owns credential parsing. Discovery and native-provider launches
  // must work without a proxy installation or a pool login.
  if (
    !fs.existsSync(proxy.binary()) ||
    !fs.readdirSync(profiles.paths(profile.id).auth).some((file) => file.endsWith('.json'))
  )
    return;
  try {
    // Bound optional preparation in a subprocess so discovery can finish even
    // when a controller is unreachable. A started worker remains reusable.
    const { stdout } = await execute(
      self.execPath,
      [self.script, 'prepare-pool', profile.id, selectedPoolModel(profile)],
      {
        timeout: 4000,
        maxBuffer: 1024 * 1024,
      },
    );
    return z
      .object({ port: z.number().int().positive(), accounts: z.number().int().nonnegative() })
      .parse(JSON.parse(stdout));
  } catch {
    console.error(
      'ChatGPT pool unavailable for this launch. Other providers are available; restart after restoring the pool.',
    );
    return;
  }
}

interface ConnectionFlags {
  'codex-home'?: string;
  account?: string;
  bridge?: string;
  access?: string;
}

function connectionInput(flags: ConnectionFlags): Connection {
  const bridge =
    flags.bridge ??
    process.env.SWITCHBOARD_BRIDGE ??
    path.join(os.homedir(), 'Developer', 'agentfiles', 'integrations', 'codex-apps-bridge', 'src', 'main.ts');

  return Connection.parse({
    backend: 'codex-hosted',
    bridge: path.resolve(bridge),
    codexHome: path.resolve(required(flags['codex-home'], '--codex-home')),
    account: required(flags.account, '--account'),
    access: Access.parse(flags.access ?? 'read-write'),
    identity: { status: 'source-only', reason: 'Not inspected yet' },
  });
}

async function probe(service: Service, connection: Connection) {
  const { stdout } = await execute(process.env.SWITCHBOARD_BUN || 'bun', bridgeArgs(connection, service, 'doctor'), {
    timeout: 180000,
    maxBuffer: 2 * 1024 * 1024,
    // Prevent a Google expectation in the caller's shell applying to Slack, etc.
    env: { ...process.env, CODEX_APPS_BRIDGE_ACCOUNT: '' },
  });

  return z
    .object({ ok: z.literal(true), codexAccount: z.email(), identity: Identity, toolCount: z.number() })
    .parse(JSON.parse(stdout));
}

async function doctor(id: string): Promise<void> {
  const profile = profiles.load(id);
  const reportedPaths = await verifyPaths(profile);

  console.log(
    JSON.stringify(
      {
        profile: id,
        model: modelRef(profile.model),
        poolModel: selectedPoolModel(profile),
        poolConfigured: fs.readdirSync(profiles.paths(id).auth).some((file) => file.endsWith('.json')),
        isolatedPathsVerified: true,
        paths: reportedPaths,
        connections: Object.keys(profile.connections),
      },
      null,
      2,
    ),
  );
}

async function verifyPaths(profile: Profile): Promise<string> {
  const env = launchEnv(profile, undefined, process.cwd());
  const { stdout } = await execute(process.env.SWITCHBOARD_OPENCODE || 'opencode', ['debug', 'paths'], {
    env,
    timeout: 30000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const expected = profiles.paths(profile.id);

  if (!stdout.includes(expected.data) || !stdout.includes(expected.config) || !stdout.includes(expected.home)) {
    throw new Error(
      'This OpenCode build did not report isolated home/config/data paths. Do not launch this profile until compatibility is restored.',
    );
  }

  return stdout.trim();
}

function installCli(): void {
  const file = installShim('oc', launcherScript('Switchboard OpenCode launcher', [self.execPath, self.script]));
  console.log(`Installed ${file}`);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const [head, ...rest] = args;
  const commands = z.enum([
    'create',
    'list',
    'show',
    'import',
    'connect',
    'disconnect',
    'bridge',
    'native',
    'probe',
    'model',
    'models',
    'small-model',
    'prepare-pool',
    'effort',
    'project-config',
    'login',
    'status',
    'refresh',
    'stop',
    'doctor',
    'proxy-install',
    'install-cli',
    'worker',
    'open',
    '--help',
    '-h',
  ]);

  const parsed = commands.safeParse(head);

  if (head && !parsed.success) {
    process.exitCode = await open(profiles.load(head), rest);
    return;
  }

  const command = parsed.success ? parsed.data : undefined;

  switch (command) {
    case undefined: {
      const available = profiles.list();
      if (!available.length) throw new Error('Create a profile first: oc create Personal');
      const selected = await choose('OpenCode profile', available, (profile) => profile.name);
      process.exitCode = await open(selected, []);
      break;
    }
    case 'open':
      process.exitCode = await open(profiles.load(required(rest[0], 'Profile')), rest.slice(1));
      break;
    case '--help':
    case '-h':
      console.log(help);
      break;
    case 'create':
      console.log(JSON.stringify(profiles.create(required(rest[0], 'Name')), null, 2));
      break;
    case 'list':
      console.log(
        JSON.stringify(
          profiles.list().map(({ id, name, connections }) => ({ id, name, services: Object.keys(connections) })),
          null,
          2,
        ),
      );
      break;
    case 'show': {
      const profile = profiles.load(required(rest[0], 'Profile'));
      console.log(
        JSON.stringify(
          {
            ...profile,
            model: modelRef(profile.model),
            poolModel: selectedPoolModel(profile),
            smallModel: profile.smallModel ?? 'native selection',
          },
          null,
          2,
        ),
      );
      break;
    }
    case 'model': {
      const model = ModelRef.parse(required(rest[1], 'Model'));
      profiles.update(required(rest[0], 'Profile'), (profile) => {
        saveModel(profile, model);
      });
      console.log('Model saved. Restart this profile’s OpenCode windows to apply it.');
      break;
    }
    case 'small-model': {
      const model = required(rest[1], 'Model or default');
      profiles.update(required(rest[0], 'Profile'), (profile) => {
        if (model === 'default') delete profile.smallModel;
        else profile.smallModel = modelRef(model);
      });
      console.log('Auxiliary model saved. Restart this profile’s OpenCode windows.');
      break;
    }
    case 'prepare-pool': {
      const profile = profiles.load(required(rest[0], 'Profile'));
      if (rest[1]) profile.model = modelRef(rest[1]);
      console.log(JSON.stringify(await preparePool(profile, self)));
      break;
    }
    case 'models': {
      const profile = profiles.load(required(rest[0], 'Profile'));
      await verifyPaths(profile);
      const pool = await optionalPool(profile);
      process.exitCode = await terminal(process.env.SWITCHBOARD_OPENCODE || 'opencode', ['models', ...rest.slice(1)], {
        env: launchEnv(profile, pool?.port, process.cwd()),
      });
      break;
    }
    case 'project-config': {
      const policy = z.enum(['isolated', 'inherit']).parse(rest[1]);
      profiles.update(required(rest[0], 'Profile'), (profile) => {
        profile.projectConfig = policy;
      });
      console.log('Project configuration policy saved. Restart this profile’s OpenCode windows.');
      break;
    }
    case 'effort': {
      const effort = ReasoningEffort.parse(rest[1]);
      profiles.update(required(rest[0], 'Profile'), (profile) => {
        profile.reasoningEffort = effort;
      });
      console.log('Reasoning effort saved. Restart this profile’s OpenCode windows.');
      break;
    }
    case 'import': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          items: { type: 'string' },
          mode: { type: 'string', default: 'copy' },
          'dry-run': { type: 'boolean' },
        },
      });
      const id = required(positionals[0], 'Profile');
      profiles.load(id);
      const items = imports.scan(required(positionals[1], 'Source directory'));
      items.forEach((item, index) => console.error(`${index + 1}. ${item.kind}: ${item.name}`));
      let selected: imports.ImportItem[];

      if (values.items) {
        selected = values.items.split(',').map((value) => {
          const item = items[Number(value) - 1];
          if (!item) throw new Error(`Invalid item number: ${value}`);
          return item;
        });
      } else {
        selected = [await choose('Select an item to import', items, (item) => `${item.kind}: ${item.name}`)];
      }

      const mode = ImportMode.parse(values.mode);
      console.log(
        JSON.stringify(
          {
            profile: id,
            mode,
            dryRun: values['dry-run'] ?? false,
            items: selected.map(({ kind, name, source }) => ({ kind, name, source })),
          },
          null,
          2,
        ),
      );

      if (!values['dry-run']) {
        for (const item of selected) imports.apply(id, item, mode);
        console.log('Imported. Restart this profile’s OpenCode windows to load the changes.');
      }
      break;
    }
    case 'probe':
    case 'connect': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          'codex-home': { type: 'string' },
          account: { type: 'string' },
          bridge: { type: 'string' },
          access: { type: 'string' },
        },
      });
      const service = Service.parse(positionals[command === 'connect' ? 1 : 0]);
      const input = connectionInput(values);
      const observation = await probe(service, input);

      if (command === 'connect') {
        profiles.connect(required(positionals[0], 'Profile'), service, { ...input, identity: observation.identity });
        console.error('Connection saved. Restart this profile’s OpenCode windows to load it.');
      }

      console.log(JSON.stringify({ service, ...observation }, null, 2));
      break;
    }
    case 'disconnect':
      profiles.disconnect(required(rest[0], 'Profile'), Service.parse(rest[1]));
      break;
    case 'bridge': {
      const profile = profiles.load(required(rest[0], 'Profile'));
      const service = Service.parse(rest[1]);
      const connection = profile.connections[service];
      const method = z.enum(['doctor', 'tools', 'call', 'serve']).parse(rest[2]);

      if (!connection) throw new Error(`${service} is not connected in ${profile.name}`);

      const identityFile = profiles.identitySnapshot(profile.id, service, connection.identity);
      process.exitCode = await terminal(process.env.SWITCHBOARD_BUN || 'bun', [
        connection.bridge,
        method,
        ...rest.slice(3),
        '--service',
        service,
        '--codex-home',
        connection.codexHome,
        '--codex-account',
        connection.account,
        '--identity-file',
        identityFile,
        ...(connection.access === 'read-only' ? ['--read-only'] : []),
      ]);
      break;
    }
    case 'native': {
      const profile = profiles.load(required(rest[0], 'Profile'));
      const agent = z.enum(['claude', 'codex-computer']).parse(rest[1]);
      const env = await bindGitHub(profile.githubLogin, launchEnv(profile, 1, process.cwd()));

      switch (agent) {
        case 'claude':
          if (!profile.nativeAgents?.claude) throw new Error('This profile has no Claude Companion account binding');
          process.exitCode = await terminal('claude-companion', rest.slice(2), { env });
          break;
        case 'codex-computer': {
          if (!profile.nativeAgents?.codex) throw new Error('This profile has no Codex Computer account binding');
          const script =
            process.env.CODEX_COMPUTER_SCRIPT ??
            path.join(os.homedir(), 'Developer', 'agentfiles', 'skills', 'codex-computer', 'scripts', 'codex-computer');
          process.exitCode = await terminal('python3', [script, ...rest.slice(2)], { env });
          break;
        }
        default:
          unreachable(agent);
      }
      break;
    }
    case 'proxy-install':
      console.log(await proxy.installProxy());
      break;
    case 'install-cli':
      installCli();
      break;
    case 'worker':
      await proxy.runWorker(required(rest[0], 'Profile'));
      break;
    case 'doctor':
      await doctor(required(rest[0], 'Profile'));
      break;
    case 'status':
    case 'refresh':
    case 'stop': {
      const id = required(rest[0], 'Profile');
      profiles.load(id);
      const status = await proxy.control(id, command === 'status' ? 'status' : command);
      const unresolved = !status && proxy.receipt(id);
      console.log(JSON.stringify(status ?? { profile: id, status: unresolved ? 'unreachable' : 'stopped' }, null, 2));
      if (unresolved) process.exitCode = 1;
      break;
    }
    case 'login': {
      const id = required(rest[0], 'Profile');
      await proxy.ensureWorker(id, self);
      // Native OAuth writes directly into the pool. Never copy rotating tokens
      // from Codex homes, which remain owned by the connector's Codex processes.
      process.exitCode = await terminal(proxy.binary(), [
        '-config',
        path.join(profiles.paths(id).proxy, 'config.yaml'),
        '-codex-login',
      ]);
      await proxy.control(id, 'refresh');
      break;
    }
    default:
      unreachable(command);
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Switchboard command failed');
    process.exitCode = 1;
  });
}
