import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { ModelId, ReasoningEffort } from './types';
import { paths, readJson, secrets, writeJson } from './profiles';

export const ModelInfo = z.object({
  model: ModelId,
  limits: z.object({ context: z.number().int().positive(), output: z.number().int().positive() }),
  reasoningEfforts: z.array(ReasoningEffort),
  source: z.literal('cliproxyapi:codex'),
  observedAt: z.iso.datetime(),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

export function cachedModelInfo(profileId: string, model: ModelId): ModelInfo | undefined {
  const specific = path.join(paths(profileId).runtime, 'models', `${model}.json`);
  const file = fs.existsSync(specific) ? specific : path.join(paths(profileId).runtime, 'model-info.json');
  const info = fs.existsSync(file) ? ModelInfo.parse(readJson(file)) : undefined;
  return info?.model === model ? info : undefined;
}

export async function refreshModelInfo(profileId: string, port: number, model: ModelId): Promise<ModelInfo> {
  const credentials = secrets(profileId);
  const base = `http://127.0.0.1:${port}`;

  const [availableResponse, definitionsResponse] = await Promise.all([
    fetch(`${base}/v1/models`, {
      headers: { Authorization: `Bearer ${credentials.apiKey}` },
      signal: AbortSignal.timeout(15000),
    }),
    fetch(`${base}/v0/management/model-definitions/codex`, {
      headers: { Authorization: `Bearer ${credentials.managementKey}` },
      signal: AbortSignal.timeout(15000),
    }),
  ]);

  if (!availableResponse.ok || !definitionsResponse.ok) throw new Error('Could not load the pool model catalog');

  const available = z.object({ data: z.array(z.object({ id: z.string() })) }).parse(await availableResponse.json());
  if (!available.data.some((entry) => entry.id === model)) throw new Error(`${model} is not advertised by this pool`);

  const definitions = z
    .object({ models: z.array(z.record(z.string(), z.unknown())) })
    .parse(await definitionsResponse.json());
  const definition = z
    .object({
      id: ModelId,
      context_length: z.number().int().positive(),
      max_completion_tokens: z.number().int().positive(),
      thinking: z.object({ levels: z.array(z.string()) }).optional(),
    })
    .parse(definitions.models.find((entry) => entry.id === model));

  const info: ModelInfo = {
    model,
    limits: { context: definition.context_length, output: definition.max_completion_tokens },
    reasoningEfforts: (definition.thinking?.levels ?? []).flatMap((level) => {
      const parsed = ReasoningEffort.safeParse(level);
      return parsed.success ? [parsed.data] : [];
    }),
    source: 'cliproxyapi:codex',
    observedAt: new Date().toISOString(),
  };

  writeJson(path.join(paths(profileId).runtime, 'model-info.json'), info);
  writeJson(path.join(paths(profileId).runtime, 'models', `${model}.json`), info);
  return info;
}
