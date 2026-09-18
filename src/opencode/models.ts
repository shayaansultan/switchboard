import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { z } from 'zod';
import { ModelId, ReasoningEffort } from './types';
import { paths, readJson, secrets, writeJson } from './profiles';

const ModelLimits = z.object({
  context: z.number().int().positive(),
  input: z.number().int().positive().optional(),
  output: z.number().int().positive(),
});

export const ModelInfo = z.object({
  model: ModelId,
  limits: ModelLimits,
  limitsSource: z.enum(['opencode:openai', 'cliproxyapi:codex']).optional(),
  reasoningEfforts: z.array(ReasoningEffort),
  source: z.literal('cliproxyapi:codex'),
  observedAt: z.iso.datetime(),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

function nativeModelLimits(profileId: string): Map<string, z.infer<typeof ModelLimits>> {
  // Share only public model metadata, never the native provider's credentials or config.
  const files = [
    path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'opencode', 'models.json'),
    path.join(paths(profileId).base, 'cache', 'opencode', 'models.json'),
  ];
  const limits = new Map<string, z.infer<typeof ModelLimits>>();
  for (const file of files) {
    try {
      const catalog = z
        .object({ openai: z.object({ models: z.record(z.string(), z.unknown()) }) })
        .parse(readJson(file));
      for (const [id, model] of Object.entries(catalog.openai.models)) {
        const parsed = z.object({ limit: ModelLimits }).safeParse(model);
        if (parsed.success && !limits.has(id)) limits.set(id, parsed.data.limit);
      }
    } catch {
      // New installations or incomplete caches can still use the proxy's limits.
    }
  }
  return limits;
}

export function cachedModelInfo(profileId: string, model: ModelId): ModelInfo | undefined {
  const specific = path.join(paths(profileId).runtime, 'models', `${model}.json`);
  const file = fs.existsSync(specific) ? specific : path.join(paths(profileId).runtime, 'model-info.json');
  const info = fs.existsSync(file) ? ModelInfo.parse(readJson(file)) : undefined;
  return info?.model === model ? info : undefined;
}

export function cachedModelCatalog(profileId: string): ModelInfo[] {
  const file = path.join(paths(profileId).runtime, 'model-catalog.json');
  return fs.existsSync(file) ? z.array(ModelInfo).parse(readJson(file)) : [];
}

export async function refreshModelCatalog(profileId: string, port: number): Promise<ModelInfo[]> {
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
  const availableIds = new Set(available.data.map((entry) => entry.id));

  const definitions = z
    .object({ models: z.array(z.record(z.string(), z.unknown())) })
    .parse(await definitionsResponse.json());
  const definitionSchema = z.object({
    id: ModelId,
    context_length: z.number().int().positive(),
    max_completion_tokens: z.number().int().positive(),
    thinking: z.object({ levels: z.array(z.string()) }).optional(),
    supported_parameters: z.array(z.string()),
    supportedOutputModalities: z.array(z.string()),
  });

  const catalog: ModelInfo[] = [];
  const nativeLimits = nativeModelLimits(profileId);
  for (const entry of definitions.models) {
    const parsed = definitionSchema.safeParse(entry);
    if (!parsed.success) continue;
    const definition = parsed.data;
    if (
      !availableIds.has(definition.id) ||
      !definition.supported_parameters.includes('tools') ||
      !definition.supportedOutputModalities.includes('text')
    )
      continue;
    catalog.push({
      model: definition.id,
      limits: nativeLimits.get(definition.id) ?? {
        context: definition.context_length,
        output: definition.max_completion_tokens,
      },
      limitsSource: nativeLimits.has(definition.id) ? 'opencode:openai' : 'cliproxyapi:codex',
      reasoningEfforts: (definition.thinking?.levels ?? []).flatMap((level) => {
        const effort = ReasoningEffort.safeParse(level);
        return effort.success ? [effort.data] : [];
      }),
      source: 'cliproxyapi:codex',
      observedAt: new Date().toISOString(),
    });
  }
  if (!catalog.length) throw new Error('This pool advertises no compatible text/tool models');
  for (const info of catalog) {
    writeJson(path.join(paths(profileId).runtime, 'models', `${info.model}.json`), info);
  }
  writeJson(path.join(paths(profileId).runtime, 'model-catalog.json'), catalog);
  return catalog;
}

export async function refreshModelInfo(profileId: string, port: number, model: ModelId): Promise<ModelInfo> {
  const catalog = await refreshModelCatalog(profileId, port);
  const info = catalog.find((entry) => entry.model === model);
  if (!info) throw new Error(`${model} is not advertised as a compatible text/tool model by this pool`);
  writeJson(path.join(paths(profileId).runtime, 'model-info.json'), info);
  return info;
}
