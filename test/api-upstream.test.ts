// Credential and discovery boundaries: arbitrary shell stays inert, diagnostics
// cannot disclose bearer tokens, and server model identities survive unchanged.
import { test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Upstream, readCredential, inspectUpstream } from '../src/buckets/upstream';
import { create, load, paths, readJson, writeJson } from '../src/buckets/store';
import { proxyConfig } from '../src/buckets/proxy';
import { run } from './cli-helpers';
import * as profiles from '../src/opencode/profiles';
import { runtimeConfig } from '../src/opencode/launch';
import { main as oc } from '../src/opencode/cli';
import { sandboxHome } from './setup';

test('literal export parser rejects execution, duplicate keys and loose permissions', () => {
  const file = path.join(sandboxHome, 'parser.env');
  const ref = { file, variable: 'SOCLAAS_API_KEY' };
  expect(() => readCredential({ ...ref, variable: '.*' })).toThrow('literal variable');
  for (const literal of ["'fixture-key'", '"fixture-key"', 'fixture-key']) {
    fs.writeFileSync(file, `# comment\nexport SOCLAAS_API_KEY=${literal}\nOTHER=$(touch never)`, { mode: 0o600 });
    expect(readCredential(ref)).toBe('fixture-key');
  }
  for (const source of [
    'export SOCLAAS_API_KEY=$(touch never)',
    'export SOCLAAS_API_KEY="${OTHER}"',
    'export SOCLAAS_API_KEY=fixture; echo unsafe',
    'SOCLAAS_API_KEY=one\nSOCLAAS_API_KEY=two',
  ]) {
    fs.writeFileSync(file, source);
    expect(() => readCredential(ref)).toThrow();
  }
  fs.writeFileSync(file, 'SOCLAAS_API_KEY=fixture-key');
  fs.chmodSync(file, 0o644);
  expect(() => readCredential(ref)).toThrow('private');
  fs.unlinkSync(file);
});

test('API bucket persists only references; discovery preserves aliases, redacts secrets and classifies failures', async () => {
  const file = path.join(sandboxHome, 'upstream.env');
  fs.writeFileSync(file, "export SOCLAAS_API_KEY='fixture-secret'", { mode: 0o600 });
  let status = 200;
  let retired = false;
  let emptyAccounting = false;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      expect(request.headers.get('authorization')).toBe('Bearer fixture-secret');
      if (status !== 200) return Response.json({ error: 'fixture-secret' }, { status });
      if (emptyAccounting && !request.url.endsWith('/models')) return Response.json({ daily_limit: null });
      return Response.json(
        request.url.endsWith('/models')
          ? {
              data: [
                {
                  id: 'org/model+tools:exact',
                  context_length: 10000,
                  max_completion_tokens: 1000,
                  description: 'fixture-secret',
                  alias: 'latest',
                },
                { id: 'x-test-1', owned_by: 'test' },
                { id: 'rolling', soclaas: { alias_of: 'org/model+tools:exact' } },
                { id: 'replacement:1' },
              ].filter((model) => !retired || model.id !== 'org/model+tools:exact'),
            }
          : {
              requests_per_minute: 17,
              daily_budget: 12,
              monthly_budget: 91,
              usage: { today: 0.1 },
              api_key: 'fixture-secret',
            },
      );
    },
  });
  try {
    const upstream = Upstream.parse({
      kind: 'api',
      baseUrl: `${server.url}v1`,
      budgetUrl: `${server.url}budget`,
      adapter: 'responses',
      credential: { file, variable: 'SOCLAAS_API_KEY' },
      defaultModel: 'org/model+tools:exact',
    });
    const oauth = create('Unaffected OAuth');
    const before = fs.readFileSync(paths(oauth.id).manifest, 'utf8');
    const resultCli = await run(
      'bucket',
      'create-api',
      'API fixture',
      '--base-url',
      upstream.baseUrl,
      '--budget-url',
      upstream.budgetUrl!,
      '--credential-file',
      file,
      '--credential-env',
      'SOCLAAS_API_KEY',
      '--adapter',
      'responses',
      '--model',
      upstream.defaultModel,
      '--opencode',
    );
    expect(resultCli.code).toBe(0);
    expect(resultCli.out).not.toContain('fixture-secret');
    const bucket = load('api-fixture');
    const profile = profiles.load(bucket.id);
    await expect(oc(['effort', bucket.id, 'high'])).rejects.toThrow('not supported');
    expect(profiles.load(bucket.id).reasoningEffort).toBe(profile.reasoningEffort);
    await expect(oc(['model', bucket.id, 'rolling'])).rejects.toThrow('mutable');
    await expect(oc(['small-model', bucket.id, 'x-test-1'])).rejects.toThrow('mutable');
    expect(profiles.load(bucket.id).model).toBe(profile.model);
    profiles.update(bucket.id, (p) => {
      p.name = 'Renamed API';
    });
    expect(load(bucket.id).upstream).toEqual(upstream);
    expect(runtimeConfig(profile, 12345, sandboxHome).enabled_providers).toEqual(['switchboard-chatgpt']);
    await expect(oc(['login', bucket.id])).rejects.toThrow('not OAuth');
    expect(fs.readFileSync(paths(oauth.id).manifest, 'utf8')).toBe(before);
    expect(load(bucket.id).upstream).toEqual(upstream);
    expect(JSON.stringify(readJson(paths(bucket.id).manifest))).not.toContain('fixture-secret');
    const result = await inspectUpstream(upstream);
    expect(result.models.map((m) => m.id)).toEqual(['org/model+tools:exact', 'x-test-1', 'rolling', 'replacement:1']);
    expect(result.models[0].metadata.alias).toBe('latest');
    expect(result.models[1].mutable).toBe(true);
    expect(result.accounting.values?.requests_per_minute).toBe(17);
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
    expect(result.enforcement.status).toBe('unknown');
    emptyAccounting = true;
    const noLimits = await inspectUpstream(upstream);
    expect(noLimits.accounting).toEqual({ status: 'ok', httpStatus: 200, values: {} });
    expect(noLimits.enforcement.status).toBe('unknown');
    emptyAccounting = false;
    const config = proxyConfig(bucket.id, 12345, result.models);
    expect(fs.statSync(config).mode & 0o777).toBe(0o600);
    expect((readJson(config) as Record<string, unknown>).host).toBe('127.0.0.1');
    expect(() => Upstream.parse({ ...upstream, defaultModel: 'x-test-1' })).toThrow();
    for (const [code, expected] of [
      [401, 'authentication-failed'],
      [429, 'rate-limited'],
      [503, 'unavailable'],
    ] as const) {
      status = code;
      const observation = await inspectUpstream(upstream);
      expect(observation.discovery.status).toBe(expected);
      expect(observation.models).toEqual([]);
      expect(JSON.stringify(observation)).not.toContain('fixture-secret');
    }
    const rotated = path.join(sandboxHome, 'rotated.env');
    status = 200;
    retired = true;
    await oc(['model', bucket.id, 'replacement:1']);
    expect((await run('bucket', 'model', bucket.id, 'replacement:1')).code).toBe(0);
    expect(load(bucket.id).upstream?.defaultModel).toBe('replacement:1');
    expect(() =>
      proxyConfig(
        bucket.id,
        12345,
        [...result.models].filter((m) => m.id !== upstream.defaultModel),
      ),
    ).not.toThrow();
    fs.writeFileSync(rotated, 'export ROTATED=fixture-second', { mode: 0o600 });
    // Credential rotation remains possible after an unclean worker exit, even
    // when its old credential has disappeared; a living owner still blocks it.
    const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('occupied') });
    const port = probe.port!;
    const receiptFile = path.join(paths(bucket.id).runtime, 'worker.json');
    const leaseFile = path.join(paths(bucket.id).runtime, 'worker.lock');
    const exited = Bun.spawn([process.execPath, '-e', ''], { stdout: 'ignore', stderr: 'ignore' });
    await exited.exited;
    const receipt = {
      profileId: bucket.id,
      instance: 'crashed',
      pid: exited.pid,
      controlPort: port,
      proxyPort: port,
      startedAt: new Date().toISOString(),
    };
    writeJson(receiptFile, { ...receipt, pid: process.pid });
    expect((await run('bucket', 'credential', bucket.id, rotated, 'ROTATED')).code).not.toBe(0);
    writeJson(receiptFile, receipt);
    writeJson(leaseFile, { pid: exited.pid, instance: 'crashed' });
    expect((await run('bucket', 'credential', bucket.id, rotated, 'ROTATED')).code).not.toBe(0);
    probe.stop(true);
    fs.unlinkSync(file);
    expect((await run('bucket', 'credential', bucket.id, rotated, 'ROTATED')).code).toBe(0);
    expect(fs.existsSync(receiptFile)).toBe(false);
    expect(fs.existsSync(leaseFile)).toBe(false);
    expect(profiles.load(bucket.id).upstream?.credential.file).toBe(rotated);
    expect(profiles.load(bucket.id).name).toBe('Renamed API');
    expect((await inspectUpstream(upstream)).discovery.status).toBe('missing-credential');
  } finally {
    server.stop(true);
  }
});
