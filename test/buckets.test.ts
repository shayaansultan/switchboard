import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import * as buckets from '../src/buckets/store';
import * as profiles from '../src/opencode/profiles';
import { desktopEnvironment, wrapperScript } from '../src/buckets/desktop';

test('shared buckets reuse existing pool storage and credentials without adopting collisions', () => {
  const original = process.env.SWITCHBOARD_ROOT;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-buckets-'));
  process.env.SWITCHBOARD_ROOT = temporary;
  try {
    const legacy = profiles.create('AnswerThis');
    const key = profiles.secrets(legacy.id);
    expect(buckets.paths(legacy.id).auth).toBe(profiles.paths(legacy.id).auth);
    expect(buckets.paths(legacy.id).runtime).toBe(profiles.paths(legacy.id).runtime);
    expect(buckets.secrets(legacy.id)).toEqual(key);
    expect(() => buckets.create('AnswerThis')).toThrow();
    const shared = buckets.create('Shared');
    expect(buckets.paths(shared.id).base).toBe(path.join(temporary, 'buckets', 'shared'));
    expect(() => profiles.create('Shared')).toThrow();
    expect(buckets.list().map((b) => b.id)).toEqual(['answerthis', 'shared']);
    expect(() => buckets.paths('../escape')).toThrow();
    fs.mkdirSync(path.join(temporary, 'buckets', legacy.id));
    expect(() => buckets.paths(legacy.id)).toThrow('Ambiguous');
  } finally {
    if (original === undefined) delete process.env.SWITCHBOARD_ROOT;
    else process.env.SWITCHBOARD_ROOT = original;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('desktop wrapper passes literal config and arguments, preserving native home and auth files', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "switchboard wrapper's "));
  try {
    const binary = path.join(temporary, 'fake-codex');
    fs.writeFileSync(
      binary,
      '#!/usr/bin/env node\nconsole.log(JSON.stringify({argv:process.argv.slice(2),home:process.env.CODEX_HOME,key:process.env.SWITCHBOARD_PROXY_API_KEY}));\n',
      { mode: 0o700 },
    );
    const wrapper = path.join(temporary, 'wrapper');
    fs.writeFileSync(wrapper, wrapperScript(binary, 'http://127.0.0.1:4000/v1'), { mode: 0o700 });
    const original = 'untouched native config';
    fs.writeFileSync(path.join(temporary, 'config.toml'), original);
    fs.writeFileSync(path.join(temporary, 'auth.json'), original);
    const { stdout } = await promisify(execFile)(wrapper, ['app-server', '--literal=$HOME'], {
      env: { ...process.env, CODEX_HOME: temporary, SWITCHBOARD_PROXY_API_KEY: 'test-only-secret' },
    });
    const result = JSON.parse(stdout);
    expect(result.argv.slice(0, 2)).toEqual(['app-server', '--literal=$HOME']);
    expect(result.argv[3]).toBe('model_provider="switchboard"');
    expect(result.argv[5]).toContain('requires_openai_auth=false');
    expect(result.home).toBe(temporary);
    expect(result.key).toBe('test-only-secret');
    expect(fs.readFileSync(wrapper, 'utf8')).not.toContain('test-only-secret');
    for (const file of ['config.toml', 'auth.json'])
      expect(fs.readFileSync(path.join(temporary, file), 'utf8')).toBe(original);
    expect(
      await desktopEnvironment(
        { id: 'native', vendor: 'codex', name: 'Native', color: '#fff', isDefault: false },
        temporary,
      ),
    ).toEqual({});
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
