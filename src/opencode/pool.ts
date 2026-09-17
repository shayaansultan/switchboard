import * as proxy from './proxy';
import { refreshModelInfo } from './models';
import { poolId, selectedPoolModel } from './selection';
import type { Profile } from './types';

export async function preparePool(profile: Profile, cli: string): Promise<{ port: number; accounts: number }> {
  const worker = await proxy.ensureWorker(profile.id, cli);
  const accounts = await proxy.accounts(profile.id, worker.receipt.proxyPort);
  if (!accounts.some((account) => !account.disabled)) {
    throw new Error(`No AI account is connected to ${profile.name}. Run: oc login ${profile.id}`);
  }
  const models = new Set([selectedPoolModel(profile)]);
  const small = profile.smallModel && poolId(profile.smallModel);
  if (small) models.add(small);
  for (const model of models) {
    const info = await refreshModelInfo(profile.id, worker.receipt.proxyPort, model);
    if (info.reasoningEfforts.length && !info.reasoningEfforts.includes(profile.reasoningEffort)) {
      throw new Error(`${model} does not advertise ${profile.reasoningEffort} reasoning effort`);
    }
  }
  return { port: worker.receipt.proxyPort, accounts: accounts.length };
}
