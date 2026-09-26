import { load, secrets, BucketId } from './store';
import { desktopRouting, writeFileAtomic } from '../storage';
import { ensureWorker, accounts } from './proxy';
import type { Profile } from '../types';
import { desktopCatalog } from './models';
import { runtime } from './runtime';
import { shellQuote } from '../shell';

export const codexBinary = '/Applications/ChatGPT.app/Contents/Resources/codex';

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
  const adapter = runtime();
  const files = desktopRouting(profile.id);
  const content = wrapperScript(codexBinary, endpoint, {
    bucket: bucket.name,
    runtime: adapter.execPath,
    adapter: adapter.script('desktop-stdio'),
    catalog: await desktopCatalog(
      id,
      worker.receipt.proxyPort,
      codexBinary,
      { home: codexHome, overrides: providerOverrides(endpoint) },
      files.catalog,
    ),
  });
  writeFileAtomic(files.wrapper, content, 0o700);
  return { CODEX_CLI_PATH: files.wrapper, SWITCHBOARD_PROXY_API_KEY: secrets(id).apiKey };
}
