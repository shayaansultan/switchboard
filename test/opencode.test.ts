import { afterAll, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as profiles from '../src/opencode/profiles';
import * as imports from '../src/opencode/imports';
import { launchEnv, runtimeConfig } from '../src/opencode/launch';
import { Identity, Profile, Service } from '../src/opencode/types';
import { quotaWeight, control, ensureWorker } from '../src/opencode/proxy';
import { acquireWorkerLease } from '../src/opencode/worker-lease';
import { gitEnvironment } from '../src/opencode/github';
import { refreshModelInfo } from '../src/opencode/models';
import * as http from 'node:http';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-opencode-'));
const originalRoot = process.env.SWITCHBOARD_ROOT;
process.env.SWITCHBOARD_ROOT = temporary;

afterAll(() => {
  if (originalRoot === undefined) delete process.env.SWITCHBOARD_ROOT;
  else process.env.SWITCHBOARD_ROOT = originalRoot;
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('profiles reject path traversal, orphan adoption, and invalid manifest states', () => {
  expect(() => profiles.paths('../outside')).toThrow();
  const profile = profiles.create('Independent');
  expect(profiles.load(profile.id)).toEqual(profile);
  expect(() => profiles.create('Independent')).toThrow();
  expect(Profile.safeParse({ ...profile, projectConfig: 'maybe' }).success).toBe(false);
  expect(Profile.safeParse({ ...profile, connections: { imaginary: {} } }).success).toBe(false);
  expect(Identity.safeParse({ status: 'verified', label: 'Only a name' }).success).toBe(false);
});

test('reconnecting a service does not rewrite an existing window identity snapshot', () => {
  const profile = profiles.create('Snapshot binding');
  const original = { status: 'verified' as const, subject: 'user-a', scopes: ['workspace-a'], label: 'A' };
  const next = { ...original, subject: 'user-b', scopes: ['workspace-b'], label: 'B' };
  const first = profiles.identitySnapshot(profile.id, 'notion', original);
  const second = profiles.identitySnapshot(profile.id, 'notion', next);

  expect(first).not.toBe(second);
  expect(profiles.readJson(first)).toEqual(original);
  expect(profiles.readJson(second)).toEqual(next);
  expect(profiles.identitySnapshot(profile.id, 'notion', original)).toBe(first);
});

test('worker ownership lasts until release and cannot remove another owner', () => {
  const file = path.join(temporary, 'worker-lease');
  const release = acquireWorkerLease(file);
  expect(() => acquireWorkerLease(file)).toThrow();
  release();
  const nextRelease = acquireWorkerLease(file);
  release();
  expect(fs.existsSync(file)).toBe(true);
  nextRelease();
  expect(fs.existsSync(file)).toBe(false);
});

test('an unreachable live worker is not replaced', async () => {
  const profile = profiles.create('Unreachable worker');
  profiles.writeJson(path.join(profiles.paths(profile.id).runtime, 'worker.json'), {
    profileId: profile.id,
    instance: 'existing-worker',
    controlPort: 1,
    proxyPort: 1,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });
  await expect(ensureWorker(profile.id, '/unused-cli')).rejects.toThrow('alive but unreachable');
  expect(fs.existsSync(path.join(profiles.paths(profile.id).proxy, 'config.yaml'))).toBe(false);
});

test('worker control failures are not reported as a stopped worker', async () => {
  const profile = profiles.create('Control errors');
  const server = http.createServer((_request, response) => response.writeHead(401).end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  profiles.writeJson(path.join(profiles.paths(profile.id).runtime, 'worker.json'), {
    profileId: profile.id,
    instance: 'fixture',
    controlPort: address.port,
    proxyPort: 1,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });
  try {
    await expect(control(profile.id, 'status')).rejects.toThrow('HTTP 401');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('profile launches scrub inherited OpenCode state and give each service its own binding', () => {
  const personal = profiles.create('Personal test');
  const work = profiles.create('Work test');
  const source = path.join(temporary, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'auth.json'), '{}');
  fs.writeFileSync(path.join(source, 'bridge.ts'), '// fixture');

  for (const service of Service.options) {
    profiles.connect(work.id, service, {
      backend: 'codex-hosted',
      bridge: path.join(source, 'bridge.ts'),
      codexHome: source,
      account: `${service}@example.com`,
      access: 'read-only',
      identity: { status: 'source-only', reason: 'Fixture' },
    });
  }

  const a = launchEnv(personal, 1234, temporary, {
    HOME: '/real/home',
    OPENCODE_DB: '/shared/database',
    OPENCODE_AUTH_CONTENT: 'credential',
    OPENAI_API_KEY: 'inherited-secret',
  });
  const b = launchEnv(profiles.load(work.id), 5678, temporary, { HOME: '/real/home' });
  const settings = JSON.parse(b.OPENCODE_CONFIG_CONTENT!);

  expect(a.HOME).toBe('/real/home');
  expect(a.OPENCODE_DB).toBeUndefined();
  expect(a.OPENCODE_AUTH_CONTENT).toBeUndefined();
  expect(a.OPENAI_API_KEY).toBeUndefined();
  expect(a.XDG_DATA_HOME).not.toBe(b.XDG_DATA_HOME);
  expect(a.OPENCODE_TEST_HOME).not.toBe(b.OPENCODE_TEST_HOME);
  expect(settings.model).toBe(settings.small_model);
  expect(Object.keys(settings.mcp)).toEqual(Service.options);

  for (const service of Service.options) {
    expect(settings.mcp[service].command).toContain(`${service}@example.com`);
    expect(settings.mcp[service].command).toContain(service);
    expect(settings.mcp[service].command).not.toContain('--namespaces');
  }

  profiles.disconnect(work.id, 'slack');
  expect(profiles.load(work.id).connections.slack).toBeUndefined();
  expect(profiles.load(work.id).connections.linear).toBeDefined();
});

test('selective imports preserve link/copy semantics without importing account secrets', () => {
  const source = path.join(temporary, 'import-source');
  fs.mkdirSync(path.join(source, 'skills', 'review'), { recursive: true });
  fs.writeFileSync(path.join(source, 'skills', 'review', 'SKILL.md'), 'original');
  fs.writeFileSync(
    path.join(source, 'opencode.jsonc'),
    JSON.stringify({
      permission: { edit: 'ask' },
      model: 'openai/other',
      provider: { openai: { options: { apiKey: 'secret' } } },
      mcp: { docs: { type: 'remote', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer secret' } } },
      plugin: ['example-plugin@1.0.0'],
    }),
  );
  const copy = profiles.create('Copied');
  const link = profiles.create('Linked');
  const items = imports.scan(source);
  const skill = items.find((item) => item.kind === 'skill')!;

  imports.apply(copy.id, skill, 'copy');
  imports.apply(link.id, skill, 'link');
  imports.apply(
    copy.id,
    items.find((item) => item.kind === 'preferences')!,
    'copy',
  );
  imports.apply(
    copy.id,
    items.find((item) => item.kind === 'mcp')!,
    'copy',
  );
  fs.writeFileSync(path.join(skill.source, 'SKILL.md'), 'changed');

  expect(fs.readFileSync(path.join(profiles.paths(copy.id).config, 'skills/review/SKILL.md'), 'utf8')).toBe('original');
  expect(fs.readFileSync(path.join(profiles.paths(link.id).config, 'skills/review/SKILL.md'), 'utf8')).toBe('changed');
  const settings = imports.config(path.join(profiles.paths(copy.id).config, 'opencode.json'));
  expect(JSON.stringify(settings)).not.toContain('secret');
  expect(settings.model).toBeUndefined();
  expect(settings.mcp).toEqual({ docs: { type: 'remote', url: 'https://example.com/mcp', enabled: false } });
  expect(() => imports.apply(copy.id, skill, 'copy')).toThrow();
});

test('isolated launch includes project instructions without project connector configuration', () => {
  const directory = path.join(temporary, 'project');
  fs.mkdirSync(path.join(directory, '.git'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'AGENTS.md'), 'Project rules');
  fs.writeFileSync(path.join(directory, 'opencode.json'), '{"mcp":{"other-account":{}}}');
  const profile = profiles.create('Project rules');
  const settings = runtimeConfig(profile, 1234, directory);

  expect(settings.instructions).toEqual([path.join(directory, 'AGENTS.md')]);
  expect(settings.mcp).toEqual({});
  expect(launchEnv(profile, 1234, directory).OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
});

test('quota weights use the tightest observed window, never evicting healthy sticky sessions', () => {
  expect(quotaWeight([])).toBe(50);
  expect(
    quotaWeight([
      { label: '5h', pct: 20, resetsAt: null },
      { label: '7d', pct: 90, resetsAt: null },
    ]),
  ).toBe(10);
  expect(quotaWeight([{ label: '7d', pct: 100, resetsAt: null }])).toBe(1);
  expect(quotaWeight([{ label: 'unknown', pct: null, resetsAt: null }])).toBe(50);
});

test('native agents inherit only the current profile binding', () => {
  const profile = profiles.create('Native binding');
  profiles.update(profile.id, (value) => {
    value.nativeAgents = {
      claude: { configDir: 'default', account: 'personal@example.com' },
      codex: { home: '/selected/native-codex', account: 'work@example.com' },
    };
  });
  const parent = { CLAUDE_COMPANION_CONFIG_DIR: '/other-account', CODEX_COMPUTER_HOME: '/other-codex' };
  const env = launchEnv(profiles.load(profile.id), 1, temporary, parent);

  expect(env.CLAUDE_COMPANION_CONFIG_DIR).toBe('default');
  expect(env.CLAUDE_COMPANION_ACCOUNT).toBe('personal@example.com');
  expect(env.CLAUDE_COMPANION_HOST).toBe('opencode');
  expect(env.CODEX_COMPUTER_HOME).toBe('/selected/native-codex');
  expect(env.CODEX_COMPUTER_ACCOUNT).toBe('work@example.com');
  expect(parent.CLAUDE_COMPANION_CONFIG_DIR).toBe('/other-account');

  const unbound = profiles.create('No native binding');
  expect(launchEnv(unbound, 1, temporary, parent).CLAUDE_COMPANION_CONFIG_DIR).toBeUndefined();
});

test('GitHub auth stays process-local and preserves pre-existing Git settings', () => {
  const parent = {
    GH_TOKEN: 'other',
    GITHUB_TOKEN: 'other-fallback',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'user.name',
    GIT_CONFIG_VALUE_0: 'Developer',
  };
  const child = gitEnvironment(parent, 'selected-fixture-token');

  expect(child.GH_TOKEN).toBe('selected-fixture-token');
  expect(parent.GH_TOKEN).toBe('other');
  expect(child.GITHUB_TOKEN).toBeUndefined();
  expect(parent.GITHUB_TOKEN).toBe('other-fallback');
  expect(child.GIT_CONFIG_COUNT).toBe('3');
  expect(child.GIT_CONFIG_VALUE_0).toBe('Developer');
  expect(child.GIT_CONFIG_KEY_1).toBe('credential.https://github.com.helper');
  expect(child.GIT_CONFIG_VALUE_1).toBe('');
  expect(child.GIT_CONFIG_VALUE_2).toBe('!gh auth git-credential');
});

test('model limits come from the selected pool catalog, not placeholder defaults', async () => {
  const profile = profiles.create('Catalog metadata');
  const model = () => runtimeConfig(profile, 1, temporary).provider['switchboard-chatgpt'].models[profile.model];
  expect(model().limit).toBeUndefined();

  const credentials = profiles.secrets(profile.id);
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    switch (request.url) {
      case '/v1/models':
        expect(request.headers.authorization).toBe(`Bearer ${credentials.apiKey}`);
        response.end(JSON.stringify({ data: [{ id: profile.model }] }));
        break;
      case '/v0/management/model-definitions/codex':
        expect(request.headers.authorization).toBe(`Bearer ${credentials.managementKey}`);
        response.end(
          JSON.stringify({
            models: [
              { id: 'unrelated-image-model' },
              {
                id: profile.model,
                context_length: 272000,
                max_completion_tokens: 128000,
                thinking: { levels: ['low', 'max'] },
              },
            ],
          }),
        );
        break;
      default:
        response.writeHead(404).end();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');

  try {
    const info = await refreshModelInfo(profile.id, address.port, profile.model);
    expect(model().limit).toEqual({ context: 272000, output: 128000 });
    expect(info.source).toBe('cliproxyapi:codex');
    expect(info.reasoningEfforts).toEqual(['low', 'max']);
    expect(model().options.reasoningEffort).toBe('low');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
