import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { load, secrets, BucketId } from './store';
import { desktopRouting, readJson, writeFileAtomic } from '../storage';
import { VENDORS } from '../store';
import { ensureWorker, accounts } from './proxy';
import type { Profile } from '../types';
import { desktopCatalog, apiCatalog } from './models';
import { runtime } from './runtime';
import { shellQuote } from '../shell';

// Only the layout this was written against is followed; another could change
// what the entrypoint means.
const CodexPackage = z.object({ layoutVersion: z.literal(1), entrypoint: z.string().min(1) });

// The desktop app's Codex engine. Recent releases (26.924 here) ship it as a
// package under Resources/codex-cli whose manifest names its entrypoint;
// earlier ones shipped one binary at Resources/codex. Read at each launch,
// because the app can update while Switchboard runs.
export function codexBinary(resources = path.join(VENDORS.codex.appPath, 'Contents', 'Resources')): string {
  const root = path.join(resources, 'codex-cli');
  const manifest = path.join(root, 'codex-package.json');
  if (!fs.existsSync(manifest)) return path.join(resources, 'codex');
  let described: z.infer<typeof CodexPackage>;
  try {
    described = CodexPackage.parse(readJson(manifest));
  } catch {
    throw new Error(
      `Cannot read the ChatGPT app's Codex package at ${manifest}. Update Switchboard for this ChatGPT version.`,
    );
  }
  const entrypoint = path.resolve(root, described.entrypoint);
  if (!entrypoint.startsWith(root + path.sep))
    throw new Error(`The Codex package at ${manifest} names an entrypoint outside its folder`);
  return entrypoint;
}

// Only the desktop's embedded process receives these overrides. CODEX_HOME,
// auth.json, connectors, and the user's config.toml retain their ownership.
function providerOverrides(endpoint: string): string[] {
  const provider = `{name="Switchboard bucket",base_url=${JSON.stringify(endpoint)},wire_api="responses",env_key="SWITCHBOARD_PROXY_API_KEY",requires_openai_auth=false}`;
  return ['model_provider="switchboard"', `model_providers.switchboard=${provider}`];
}

export function wrapperScript(
  binary: string,
  endpoint: string,
  label?: { bucket: string; runtime: string; adapter: string; catalog?: string; model?: string },
): string {
  const overrides = providerOverrides(endpoint);
  if (label?.model) overrides.push('model=' + JSON.stringify(label.model));
  if (label?.catalog) overrides.push(`model_catalog_json=${JSON.stringify(label.catalog)}`);
  const command = label
    ? `env ELECTRON_RUN_AS_NODE=1 ${[label.runtime, label.adapter, label.bucket, binary].map(shellQuote).join(' ')}`
    : shellQuote(binary);
  // The app passes its own -c flags after app-server. Codex treats that as a
  // separate override list, replacing flags before the subcommand. Append ours
  // so the effective app-server config, not just its process argv, uses the pool.
  return `#!/bin/sh\nexec ${command} "$@" ${overrides.map((value) => `-c ${shellQuote(value)}`).join(' ')}\n`;
}

// The wrapper a Codex profile without a bucket launches its engine through
// while phone access is on: the engine untouched, with the phone's tap on
// its connection (desktop-remote.ts). Rewritten at each launch; its content
// only changes when Switchboard or ChatGPT moves. Null when the engine
// cannot be found: the app then launches as it would without phone access,
// read-only from the phone, rather than not at all.
export function remoteWrapper(profile: Profile, find: () => string = codexBinary): string | null {
  let binary: string;
  try {
    binary = find();
  } catch {
    return null;
  }
  if (!fs.existsSync(binary)) return null;
  const adapter = runtime();
  const file = desktopRouting(profile.id).wrapper;
  const command = `env ELECTRON_RUN_AS_NODE=1 ${[adapter.execPath, adapter.script('desktop-remote'), binary].map(shellQuote).join(' ')}`;
  writeFileAtomic(file, `#!/bin/sh\nexec ${command} "$@"\n`, 0o700);
  return file;
}

export async function desktopEnvironment(profile: Profile, codexHome: string): Promise<Record<string, string>> {
  if (profile.vendor !== 'codex') return {};
  if (!profile.proxyBucket) return {};
  const id = BucketId.parse(profile.proxyBucket);
  const bucket = load(id);
  // Found before the worker starts, so a launch that cannot succeed starts nothing.
  const binary = codexBinary();
  if (!fs.existsSync(binary))
    throw new Error(`The ChatGPT app's Codex engine is not at ${binary}. Update Switchboard for this ChatGPT version.`);
  const worker = await ensureWorker(id);
  const members = await accounts(id, worker.receipt.proxyPort);
  if (!bucket.upstream && !members.some((member) => !member.disabled))
    throw new Error('This bucket has no enabled accounts. Add an account in Proxy buckets.');
  const endpoint = `http://127.0.0.1:${worker.receipt.proxyPort}/v1`;
  const adapter = runtime();
  const files = desktopRouting(profile.id);
  const content = wrapperScript(binary, endpoint, {
    bucket: bucket.name,
    model: bucket.upstream?.defaultModel,
    runtime: adapter.execPath,
    adapter: adapter.script('desktop-stdio'),
    catalog: bucket.upstream
      ? apiCatalog(worker.upstream?.models ?? [], files.catalog)
      : await desktopCatalog(
          id,
          worker.receipt.proxyPort,
          binary,
          { home: codexHome, overrides: providerOverrides(endpoint) },
          files.catalog,
        ),
  });
  writeFileAtomic(files.wrapper, content, 0o700);
  return { CODEX_CLI_PATH: files.wrapper, SWITCHBOARD_PROXY_API_KEY: secrets(id).apiKey };
}
