import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import * as http from 'node:http';
import * as buckets from '../src/buckets/store';
import * as profiles from '../src/opencode/profiles';
import { codexBinary, desktopEnvironment, wrapperScript } from '../src/buckets/desktop';
import { desktopCatalog } from '../src/buckets/models';
import { desktopRouting, writeFileAtomic } from '../src/storage';

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

test('each routed profile has one wrapper and one catalog, named for it', () => {
  const original = process.env.SWITCHBOARD_ROOT;
  process.env.SWITCHBOARD_ROOT = '/fixture-root';
  try {
    expect(desktopRouting('codex-answerthis')).toEqual({
      wrapper: '/fixture-root/desktop-routing/codex-codex-answerthis',
      catalog: '/fixture-root/desktop-routing/models-codex-answerthis.json',
    });
    // Desktop profile ids are slugs of any length, unlike bucket ids.
    expect(() => desktopRouting(`codex-${'a'.repeat(80)}`)).not.toThrow();
    for (const bad of ['../escape', 'Codex', '', 'a/b']) expect(() => desktopRouting(bad)).toThrow();
  } finally {
    if (original === undefined) delete process.env.SWITCHBOARD_ROOT;
    else process.env.SWITCHBOARD_ROOT = original;
  }
});

test('a bucket without Claude models leaves no catalog from an earlier launch', async () => {
  const original = process.env.SWITCHBOARD_ROOT;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-catalog-'));
  process.env.SWITCHBOARD_ROOT = temporary;
  const server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'gpt-5.5' }] }));
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const bucket = buckets.create('Codex only');
    const file = desktopRouting('codex-work').catalog;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"models":[]}');
    const port = (server.address() as { port: number }).port;
    const catalog = await desktopCatalog(
      bucket.id,
      port,
      '/nonexistent/codex',
      { home: temporary, overrides: [] },
      file,
    );
    expect(catalog).toBeUndefined();
    expect(fs.existsSync(file)).toBe(false);
  } finally {
    server.close();
    if (original === undefined) delete process.env.SWITCHBOARD_ROOT;
    else process.env.SWITCHBOARD_ROOT = original;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('an atomic rewrite replaces the content and sets the mode it is given', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-atomic-'));
  try {
    const file = path.join(temporary, 'codex-work');
    fs.writeFileSync(file, 'earlier launch', { mode: 0o644 });
    writeFileAtomic(file, '#!/bin/sh\n', 0o700);
    expect(fs.readFileSync(file, 'utf8')).toBe('#!/bin/sh\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(temporary)).toEqual(['codex-work']);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('the Codex engine is the package entrypoint when the app ships one, else the single binary', () => {
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-resources-'));
  try {
    expect(codexBinary(resources)).toBe(path.join(resources, 'codex'));
    const manifest = path.join(resources, 'codex-cli', 'codex-package.json');
    fs.mkdirSync(path.dirname(manifest));
    fs.writeFileSync(manifest, JSON.stringify({ layoutVersion: 1, entrypoint: 'bin/codex' }));
    expect(codexBinary(resources)).toBe(path.join(resources, 'codex-cli', 'bin', 'codex'));
    for (const entrypoint of ['../../elsewhere', '/usr/bin/true']) {
      fs.writeFileSync(manifest, JSON.stringify({ layoutVersion: 1, entrypoint }));
      expect(() => codexBinary(resources)).toThrow('outside its folder');
    }
    // A manifest caught mid-update, or a layout this was not written for.
    for (const text of ['{"layoutVer', JSON.stringify({ layoutVersion: 2, entrypoint: 'bin/codex' })]) {
      fs.writeFileSync(manifest, text);
      expect(() => codexBinary(resources)).toThrow(`Cannot read the ChatGPT app's Codex package at ${manifest}`);
    }
  } finally {
    fs.rmSync(resources, { recursive: true, force: true });
  }
});
