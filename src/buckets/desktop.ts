import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { root, load, secrets, BucketId } from './store';
import { ensureWorker, accounts } from './proxy';
import type { Profile } from '../types';
import { desktopCatalog } from './models';

export const codexBinary = '/Applications/ChatGPT.app/Contents/Resources/codex';
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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
  label?: { bucket: string; runtime: string; adapter: string; catalog?: string },
): string {
  const overrides = providerOverrides(endpoint);
  if (label?.catalog) overrides.push(`model_catalog_json=${JSON.stringify(label.catalog)}`);
  const command = label
    ? `env ELECTRON_RUN_AS_NODE=1 ${[label.runtime, label.adapter, label.bucket, binary].map(shellQuote).join(' ')}`
    : shellQuote(binary);
  // The app passes its own -c flags after app-server. Codex treats that as a
  // separate override list, replacing flags before the subcommand. Append ours
  // so the effective app-server config, not just its process argv, uses the pool.
  return `#!/bin/sh\nexec ${command} "$@" ${overrides.map((value) => `-c ${shellQuote(value)}`).join(' ')}\n`;
}

export async function desktopEnvironment(profile: Profile, codexHome: string): Promise<Record<string, string>> {
  if (profile.vendor !== 'codex') return {};
  if (!profile.proxyBucket) return {};
  const id = BucketId.parse(profile.proxyBucket);
  const bucket = load(id);
  const worker = await ensureWorker(id);
  const members = await accounts(id, worker.receipt.proxyPort);
  if (!members.some((member) => !member.disabled))
    throw new Error('This bucket has no enabled accounts. Add an account in Proxy buckets.');
  const endpoint = `http://127.0.0.1:${worker.receipt.proxyPort}/v1`;
  const content = wrapperScript(codexBinary, endpoint, {
    bucket: bucket.name,
    runtime: process.execPath,
    adapter: path.join(__dirname, 'desktop-stdio.js'),
    catalog: await desktopCatalog(id, worker.receipt.proxyPort, codexBinary, {
      home: codexHome,
      overrides: providerOverrides(endpoint),
    }),
  });
  const digest = createHash('sha256').update(content).digest('hex').slice(0, 20);
  const directory = path.join(root(), 'desktop-routing');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `codex-${digest}`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, content, { mode: 0o700, flag: 'wx' });
  else if (fs.readFileSync(file, 'utf8') !== content) throw new Error('Desktop routing wrapper has changed');
  return { CODEX_CLI_PATH: file, SWITCHBOARD_PROXY_API_KEY: secrets(id).apiKey };
}
