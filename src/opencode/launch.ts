import * as fs from 'node:fs';
import * as path from 'node:path';
import { Service, type Profile, type Connection, type ReasoningEffort } from './types';
import { paths, secrets, identitySnapshot } from './profiles';
import { cachedModelInfo } from './models';
import { modelRef, poolId, selectedPoolModel } from './selection';

interface LocalMcp {
  type: 'local';
  enabled: boolean;
  timeout: number;
  command: string[];
}

interface RuntimeModel {
  name: string;
  reasoning: boolean;
  tool_call: boolean;
  limit?: { context: number; output: number };
  cost: { input: number; output: number };
  options: { store: false; reasoningEffort: ReasoningEffort };
}

// The generated subset of OpenCode's public config schema. User-authored config
// is parsed separately; this type catches misspelled fields in our own output.
export interface RuntimeConfig {
  $schema: 'https://opencode.ai/config.json';
  username: string;
  model: string;
  small_model?: string;
  autoupdate: false;
  provider: {
    'switchboard-chatgpt'?: {
      npm: '@ai-sdk/openai';
      name: string;
      options: { baseURL: string; apiKey: string };
      models: Record<string, RuntimeModel>;
    };
  };
  instructions?: string[];
  mcp: Partial<Record<Service, LocalMcp>>;
}

export function bridgeArgs(connection: Connection, service: Service, command: 'serve' | 'doctor' | 'tools'): string[] {
  return [
    connection.bridge,
    command,
    ...(command === 'tools' ? ['list'] : []),
    '--service',
    service,
    '--codex-home',
    connection.codexHome,
    '--codex-account',
    connection.account,
    ...(connection.access === 'read-only' ? ['--read-only'] : []),
  ];
}
function projectInstructions(cwd: string): string[] {
  let directory = path.resolve(cwd);
  let found: string | undefined;
  let searching = true;
  while (searching) {
    found = ['AGENTS.md', 'CLAUDE.md'].map((name) => path.join(directory, name)).find((file) => fs.existsSync(file));
    searching = !found && !fs.existsSync(path.join(directory, '.git')) && path.dirname(directory) !== directory;
    directory = path.dirname(directory);
  }
  return found ? [found] : [];
}
export function runtimeConfig(profile: Profile, port: number | undefined, cwd: string): RuntimeConfig {
  const provider = 'switchboard-chatgpt';
  const poolModel = selectedPoolModel(profile);
  const modelInfo = port ? cachedModelInfo(profile.id, poolModel) : undefined;
  const config: RuntimeConfig = {
    $schema: 'https://opencode.ai/config.json',
    username: profile.name,
    model: modelRef(profile.model),
    // Let OpenCode resolve auxiliary models from the session's current provider.
    // Pinning the startup model here would survive a /models switch or resume.
    ...(profile.smallModel ? { small_model: modelRef(profile.smallModel) } : {}),
    autoupdate: false,
    mcp: {},
    provider: port
      ? {
          [provider]: {
            npm: '@ai-sdk/openai',
            name: `${profile.name} · ChatGPT pool`,
            options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: secrets(profile.id).apiKey },
            models: {
              [poolModel]: {
                name: poolModel,
                reasoning: true,
                tool_call: true,
                // Launch refreshes this catalog before inference. Diagnostics can
                // run without a cache; they must not invent model limits.
                ...(modelInfo ? { limit: modelInfo.limits } : {}),
                cost: { input: 0, output: 0 },
                options: { store: false, reasoningEffort: profile.reasoningEffort },
              },
            },
          },
        }
      : {},
  };
  switch (profile.projectConfig) {
    case 'isolated':
      config.instructions = projectInstructions(cwd);
      break;
    case 'inherit':
      break;
  }
  const connections: Partial<Record<Service, LocalMcp>> = {};
  for (const service of Service.options) {
    const connection = profile.connections[service];
    if (connection) {
      const identityFile = identitySnapshot(profile.id, service, connection.identity);
      connections[service] = {
        type: 'local',
        enabled: true,
        timeout: 120000,
        command: [
          process.env.SWITCHBOARD_BUN || 'bun',
          ...bridgeArgs(connection, service, 'serve'),
          '--identity-file',
          identityFile,
        ],
      };
    }
  }
  config.mcp = connections;
  const small = profile.smallModel && poolId(profile.smallModel);
  const pool = config.provider[provider];
  if (port && small && small !== poolModel && pool) {
    const info = cachedModelInfo(profile.id, small);
    pool.models[small] = {
      ...pool.models[poolModel],
      name: small,
      ...(info ? { limit: info.limits } : {}),
    };
    if (!info) delete pool.models[small].limit;
  }
  return config;
}
export function launchEnv(
  profile: Profile,
  port: number | undefined,
  cwd: string,
  inherited = process.env,
): NodeJS.ProcessEnv {
  const directory = paths(profile.id);
  const env = { ...inherited };
  for (const name of [
    'CLAUDE_COMPANION_CONFIG_DIR',
    'CLAUDE_COMPANION_ACCOUNT',
    'CLAUDE_COMPANION_HOST',
    'CODEX_COMPUTER_HOME',
    'CODEX_COMPUTER_ACCOUNT',
  ]) {
    delete env[name];
  }
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('OPENCODE_') ||
      /^(OPENAI|ANTHROPIC|GOOGLE|GEMINI|GROQ|OPENROUTER|XAI|DEEPSEEK|MISTRAL|TOGETHER|CEREBRAS|AZURE_OPENAI)_.*(KEY|TOKEN|BASE_URL)$/.test(
        key,
      )
    )
      delete env[key];
  }
  Object.assign(env, {
    XDG_CONFIG_HOME: path.join(directory.base, 'config'),
    XDG_DATA_HOME: path.join(directory.base, 'data'),
    XDG_STATE_HOME: path.join(directory.base, 'state'),
    XDG_CACHE_HOME: path.join(directory.base, 'cache'),
    OPENCODE_CONFIG_DIR: directory.config,
    // This is an internal OpenCode hook, checked by the real-binary isolation test.
    // Keep the shell's HOME unchanged so Git/SSH don't inherit a fabricated home.
    OPENCODE_TEST_HOME: directory.home,
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_TERMINAL_TITLE: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: profile.projectConfig === 'isolated' ? '1' : '0',
    OPENCODE_CONFIG_CONTENT: JSON.stringify(runtimeConfig(profile, port, cwd)),
    SWITCHBOARD_PROFILE: profile.id,
  });

  const claude = profile.nativeAgents?.claude;
  const codex = profile.nativeAgents?.codex;

  if (claude) {
    env.CLAUDE_COMPANION_CONFIG_DIR = claude.configDir;
    env.CLAUDE_COMPANION_ACCOUNT = claude.account;
    env.CLAUDE_COMPANION_HOST = 'opencode';
  }

  if (codex) {
    env.CODEX_COMPUTER_HOME = codex.home;
    env.CODEX_COMPUTER_ACCOUNT = codex.account;
  }

  return env;
}
