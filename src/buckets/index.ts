import * as path from 'node:path';
import * as store from './store';
import * as proxy from './proxy';
import type { BucketView } from '../types';

export { create, load, paths, withOpenCode } from './store';

export async function snapshot(): Promise<BucketView[]> {
  return Promise.all(
    store.list().map(async (bucket): Promise<BucketView> => {
      try {
        const status = await proxy.control(bucket.id, 'status');
        return {
          ...bucket,
          status: status?.ready ? 'running' : proxy.receipt(bucket.id) ? 'unreachable' : 'stopped',
          accounts: status?.accounts ?? [],
        };
      } catch (error) {
        return {
          ...bucket,
          status: 'unreachable',
          accounts: [],
          error: error instanceof Error ? error.message : 'Cannot read bucket',
        };
      }
    }),
  );
}

export async function start(id: string): Promise<void> {
  await proxy.ensureWorker(id);
  await refresh(id);
}
export async function refresh(id: string): Promise<void> {
  store.load(id);
  if (!(await proxy.control(id, 'refresh'))) throw new Error('Bucket is stopped. Start it to refresh account usage.');
}
export async function stop(id: string): Promise<void> {
  store.load(id);
  const stopped = await proxy.control(id, 'stop');
  if (!stopped) {
    if (proxy.receipt(id)) throw new Error('Bucket worker is unreachable');
    return;
  }
  // The control endpoint acknowledges before shutting down. Wait for that
  // worker's receipt to disappear, without stopping a replacement worker.
  for (let attempt = 0; attempt < 80; attempt++) {
    if (proxy.receipt(id)?.instance !== stopped.receipt.instance) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Bucket shutdown has not completed. Refresh its status before retrying.');
}
export async function loginCommand(id: string, provider: 'codex' | 'claude' = 'codex'): Promise<string[]> {
  await proxy.ensureWorker(id);
  return [
    proxy.binary(),
    '-config',
    path.join(store.paths(id).proxy, 'config.yaml'),
    provider === 'claude' ? '-claude-login' : '-codex-login',
  ];
}
export async function setAccountEnabled(id: string, name: string, enabled: boolean): Promise<void> {
  store.load(id);
  const status = await proxy.ensureWorker(id);
  await proxy.setAccountEnabled(id, status.receipt.proxyPort, name, enabled);
  await refresh(id);
}
// Signs the account out of the pool: the proxy deletes its token file.
export async function removeAccount(id: string, name: string): Promise<void> {
  store.load(id);
  const status = await proxy.ensureWorker(id);
  await proxy.removeAccount(id, status.receipt.proxyPort, name);
  await refresh(id);
}
// Stops the worker, then deletes the bucket's directory. An unreachable
// worker still holds its ports and lease, so that bucket is left alone.
export async function remove(id: string): Promise<void> {
  await stop(id);
  store.remove(id);
}
