import { ModelId, ModelRef, type Profile } from './types';

export const poolProvider = 'switchboard-chatgpt';

export function modelRef(value: string): string {
  const model = ModelRef.parse(value);
  return model.includes('/') ? model : `${poolProvider}/${model}`;
}

export function poolId(value: string): ModelId | undefined {
  const model = modelRef(value);
  return model.startsWith(`${poolProvider}/`) ? ModelId.parse(model.slice(poolProvider.length + 1)) : undefined;
}

export function selectedPoolModel(profile: Profile): ModelId {
  return poolId(profile.model) ?? profile.poolModel ?? ModelId.parse('gpt-6-astra');
}

export function saveModel(profile: Profile, value: string): void {
  const model = modelRef(value);
  profile.poolModel = poolId(model) ?? selectedPoolModel(profile);
  profile.model = model;
}

// Normalize only model options, preserving OpenCode's other arguments and the
// end-of-options marker. This also handles `oc PROFILE run --model ...`.
export function modelArguments(args: string[]): { args: string[]; model?: string } {
  const normalized = [...args];
  let model: string | undefined;
  for (let i = 0; i < normalized.length; i++) {
    const arg = normalized[i];
    if (arg === '--') break;
    if (arg === '--model' || arg === '-m') {
      const value = normalized[++i];
      if (!value || value.startsWith('-')) throw new Error(`${arg} requires a provider/model`);
      model = normalized[i] = modelRef(value);
    } else if (arg.startsWith('--model=') || arg.startsWith('-m=')) {
      const equals = arg.indexOf('=');
      model = modelRef(arg.slice(equals + 1));
      normalized[i] = `${arg.slice(0, equals)}=${model}`;
    }
  }
  return { args: normalized, model };
}
