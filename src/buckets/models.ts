import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { root, secrets, writeJson } from './store';

const execute = promisify(execFile);
const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
const ClaudeModel = z.object({
  id: z.string().regex(/^claude-[a-zA-Z0-9._-]+$/),
  display_name: z.string().min(1),
  description: z.string().optional(),
  created: z.number().optional(),
  context_length: z.number().int().positive(),
  max_completion_tokens: z.number().int().positive(),
  supportedInputModalities: z.array(z.string()).default(['text']),
  supportedOutputModalities: z.array(z.string()).default(['text']),
  thinking: z.object({ levels: z.array(z.string()).optional() }).optional(),
});
export type ClaudeModel = z.infer<typeof ClaudeModel>;

export async function claudeModels(id: string, port: number): Promise<ClaudeModel[]> {
  const credentials = secrets(id);
  const base = `http://127.0.0.1:${port}`;
  const availableResponse = await fetch(`${base}/v1/models`, {
    headers: { Authorization: `Bearer ${credentials.apiKey}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!availableResponse.ok) throw new Error('Could not discover bucket models');
  const available = z.object({ data: z.array(z.object({ id: z.string() })) }).parse(await availableResponse.json());
  const ids = new Set(available.data.map((model) => model.id));
  if (![...ids].some((model) => model.startsWith('claude-'))) return [];
  const response = await fetch(`${base}/v0/management/model-definitions/claude`, {
    headers: { Authorization: `Bearer ${credentials.managementKey}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('Could not load Claude model capabilities');
  const definitions = z.object({ models: z.array(z.unknown()) }).parse(await response.json());
  return definitions.models
    .flatMap((entry) => {
      const parsed = ClaudeModel.safeParse(entry);
      return parsed.success && ids.has(parsed.data.id) && parsed.data.supportedOutputModalities.includes('text')
        ? [parsed.data]
        : [];
    })
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
}

// This is a separate Claude descriptor, not a renamed GPT descriptor. Codex's
// GPT entries are carried forward verbatim from its own current catalog.
export function claudeDescriptor(model: ClaudeModel, priority: number): Record<string, unknown> {
  const levels = (model.thinking?.levels ?? []).filter((effort) => Effort.safeParse(effort).success);
  return {
    slug: model.id,
    display_name: model.display_name,
    description: model.description ?? 'Claude through the shared proxy bucket',
    default_reasoning_level: levels.includes('low') ? 'low' : (levels[0] ?? null),
    supported_reasoning_levels: levels.map((effort) => ({ effort, description: `${effort} reasoning effort` })),
    shell_type: 'unified_exec',
    visibility: 'list',
    supported_in_api: true,
    priority,
    context_window: model.context_length,
    max_context_window: model.context_length,
    effective_context_window_percent: 95,
    support_verbosity: false,
    supports_reasoning_summary_parameter: false,
    default_reasoning_summary: 'none',
    truncation_policy: { mode: 'tokens', limit: 10000 },
    experimental_supported_tools: [],
    input_modalities: model.supportedInputModalities.filter((value) => value === 'text' || value === 'image'),
    // This Codex build only supports freeform apply_patch, which the Claude
    // translator drops. Claude edits through the standard shell tools instead.
    apply_patch_tool_type: null,
    web_search_tool_type: 'text',
    node_repl_disabled: true,
    use_responses_lite: false,
    // Keep connector schemas local in Codex's code-mode registry. Without search
    // support, Codex eagerly puts every connected tool into the initial prompt.
    // Search alone is insufficient: CLIProxyAPI drops Responses tool_search.
    // Code mode discovers deferred tools through ALL_TOOLS and uses the custom
    // exec tool, whose input/result translation is supported by the proxy.
    supports_search_tool: true,
    tool_mode: 'code_mode_only',
    model_messages: {
      instructions_template:
        'You are a coding assistant powered by Anthropic Claude, running in the Codex desktop app. Work with the user in their workspace. Follow the project instructions. Use the available tools to inspect, edit, and verify your work. Use the shell tools for file edits. Preserve unrelated user changes. Explain results accurately and distinguish completed work from unverified assumptions.',
      instructions_variables: null,
    },
  };
}

export function mergedCatalog(bundled: unknown, claude: ClaudeModel[]) {
  const original = z.object({ models: z.array(z.record(z.string(), z.unknown())).min(1) }).parse(bundled);
  const existing = new Set(original.models.map((model) => model.slug));
  const priority = Math.max(
    100,
    ...original.models.map((model) => (typeof model.priority === 'number' ? model.priority : 0)),
  );
  return {
    ...original,
    models: [
      ...original.models,
      ...claude
        .filter((model) => !existing.has(model.id))
        .map((model, index) => claudeDescriptor(model, priority + index + 1)),
    ],
  };
}

export async function desktopCatalog(
  id: string,
  port: number,
  binary: string,
  config: { home: string; overrides: string[] },
): Promise<string | undefined> {
  const claude = await claudeModels(id, port);
  if (!claude.length) return;
  // Export the effective catalog for this same custom-provider launch. This
  // preserves a user-supplied catalog and avoids consulting the default home.
  const result = await execute(binary, ['debug', 'models', ...config.overrides.flatMap((value) => ['-c', value])], {
    cwd: config.home,
    env: { ...process.env, CODEX_HOME: config.home, SWITCHBOARD_PROXY_API_KEY: secrets(id).apiKey },
    timeout: 20000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const catalog = mergedCatalog(JSON.parse(result.stdout), claude);
  const digest = createHash('sha256').update(JSON.stringify(catalog)).digest('hex').slice(0, 20);
  const file = path.join(root(), 'desktop-routing', `models-${digest}.json`);
  writeJson(file, catalog);
  return file;
}
