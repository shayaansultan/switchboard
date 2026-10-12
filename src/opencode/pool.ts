import * as proxy from '../buckets/proxy';
import { refreshModelCatalog } from './models';
import { inspect } from '../buckets';
import { assertDefaultModel } from '../buckets/upstream';
import { poolId, selectedPoolModel } from './selection';
import type { Profile } from './types';
import type { Command } from '../buckets/runtime';

export async function preparePool(
  profile: Profile,
  cli: Command,
  perRunModel = false,
): Promise<{ port: number; accounts: number }> {
  const worker = await proxy.ensureWorker(profile.id, cli);
  if (profile.upstream) {
    const observation = await inspect(profile.id);
    if (observation.discovery.status !== 'ok') throw new Error('API discovery: ' + observation.discovery.status);
    for (const [index, ref] of [profile.model, profile.smallModel].entries()) {
      if (!ref) continue;
      const model = poolId(ref);
      if (!model) throw new Error('API profiles require an advertised bucket model');
      assertDefaultModel(
        {
          ...profile.upstream,
          allowMutableDefault: profile.upstream.allowMutableDefault || (index === 0 && perRunModel),
        },
        observation.models,
        model,
      );
    }
    return { port: worker.receipt.proxyPort, accounts: 0 };
  }
  const accounts = (await proxy.accounts(profile.id, worker.receipt.proxyPort)).filter(
    (account) => (account.provider ?? account.type) === 'codex',
  );
  if (!accounts.some((account) => !account.disabled)) {
    throw new Error(`No AI account is connected to ${profile.name}. Run: oc login ${profile.id}`);
  }
  const models = new Set([selectedPoolModel(profile)]);
  const small = profile.smallModel && poolId(profile.smallModel);
  if (small) models.add(small);
  const catalog = await refreshModelCatalog(profile.id, worker.receipt.proxyPort);
  for (const model of models) {
    const info = catalog.find((entry) => entry.model === model);
    if (!info) throw new Error(`${model} is not advertised as a compatible text/tool model by this pool`);
    if (info.reasoningEfforts.length && !info.reasoningEfforts.includes(profile.reasoningEffort)) {
      throw new Error(`${model} does not advertise ${profile.reasoningEffort} reasoning effort`);
    }
  }
  return { port: worker.receipt.proxyPort, accounts: accounts.length };
}
