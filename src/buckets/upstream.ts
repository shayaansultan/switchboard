// API settings contain references only. Parse credentials as data, never shell;
// reduce remote diagnostics to non-secret observations before storing them.
/* eslint-disable no-control-regex -- Reject control characters in opaque IDs and credentials. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
const Endpoint = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1'))
    );
  }, 'Use HTTPS or loopback HTTP without credentials or query parameters');
export const OpaqueModelId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\s\x00-\x1f\x7f]+$/);
export const Upstream = z
  .object({
    kind: z.literal('api'),
    baseUrl: Endpoint,
    adapter: z.literal('responses'),
    credential: z.object({
      file: z.string().refine(path.isAbsolute),
      variable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    }),
    budgetUrl: Endpoint.optional(),
    defaultModel: OpaqueModelId,
    allowMutableDefault: z.boolean().default(false),
  })
  .strict()
  .refine(
    (v) => v.defaultModel !== 'x-test-1' || v.allowMutableDefault,
    'x-test-1 is experimental and mutable; explicitly allow it before making it a default',
  );
export type Upstream = z.infer<typeof Upstream>;
export const ApiModel = z.object({
  id: OpaqueModelId,
  metadata: z.record(z.string(), z.unknown()),
  experimental: z.boolean(),
  mutable: z.boolean(),
});
export type ApiModel = z.infer<typeof ApiModel>;
const EndpointState = z.object({
  status: z.enum([
    'ok',
    'missing-credential',
    'invalid-credential',
    'authentication-failed',
    'rate-limited',
    'unavailable',
    'invalid-response',
    'not-configured',
  ]),
  httpStatus: z.number().optional(),
});
export const ApiObservation = z.object({
  observedAt: z.string(),
  discovery: EndpointState,
  models: z.array(ApiModel),
  accounting: EndpointState.extend({ values: z.record(z.string(), z.number()).optional() }),
  enforcement: z.object({
    status: z.enum(['unknown', 'operator-reported-not-enforced']),
    reportedAt: z.string().optional(),
    source: z.string().optional(),
  }),
});
export type ApiObservation = z.infer<typeof ApiObservation>;
export function readCredential(ref: Upstream['credential']): string {
  if (!path.isAbsolute(ref.file) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref.variable))
    throw new Error('Credential reference requires an absolute file and a literal variable name');
  let source: string;
  try {
    const stat = fs.statSync(ref.file);
    if (!stat.isFile() || stat.size > 65536 || stat.mode & 0o077) throw new Error();
    source = fs.readFileSync(ref.file, 'utf8');
  } catch {
    throw new Error('Credential file is missing, unreadable, too large, or not private (chmod 600)');
  }
  const matches = source
    .split(/\r?\n/)
    .filter((line) => new RegExp(`^\\s*(?:export\\s+)?${ref.variable}\\s*=`).test(line));
  if (matches.length !== 1) throw new Error('Credential variable must appear exactly once');
  const raw = matches[0].replace(new RegExp(`^\\s*(?:export\\s+)?${ref.variable}\\s*=\\s*`), '');
  const match = /^(?:'([^'\r\n]+)'|"([^"$`\\\r\n]+)"|([A-Za-z0-9._~+/=:-]+))\s*(?:#.*)?$/.exec(raw);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!value || /[\x00-\x20\x7f]/.test(value)) throw new Error('Credential must be a nonempty literal token');
  return value;
}
function sanitized(value: unknown, key: string): unknown {
  if (typeof value === 'string') return value.split(key).join('[REDACTED]');
  if (Array.isArray(value)) return value.map((item) => sanitized(item, key));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([name]) => !/api.?key|secret|authorization|password/i.test(name))
        .map(([name, item]) => [name.split(key).join('[REDACTED]'), sanitized(item, key)]),
    );
  return value;
}
async function get(url: string, key: string): Promise<{ state: z.infer<typeof EndpointState>; body?: unknown }> {
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      return {
        state: {
          status:
            response.status === 401 || response.status === 403
              ? 'authentication-failed'
              : response.status === 429
                ? 'rate-limited'
                : 'unavailable',
          httpStatus: response.status,
        },
      };
    try {
      return { state: { status: 'ok', httpStatus: response.status }, body: await response.json() };
    } catch {
      return { state: { status: 'invalid-response', httpStatus: response.status } };
    }
  } catch {
    return { state: { status: 'unavailable' } };
  }
}
export async function inspectUpstream(config: Upstream): Promise<ApiObservation> {
  const result: ApiObservation = {
    observedAt: new Date().toISOString(),
    discovery: { status: 'missing-credential' },
    models: [],
    accounting: { status: 'not-configured' },
    enforcement:
      new URL(config.baseUrl).hostname === 'soclaas-api.comp.nus.edu.sg'
        ? { status: 'operator-reported-not-enforced', reportedAt: '2026-10-11', source: 'https://t.me/c/4345150434/6' }
        : { status: 'unknown' },
  };
  let key: string;
  try {
    key = readCredential(config.credential);
  } catch {
    result.discovery.status = fs.existsSync(config.credential.file) ? 'invalid-credential' : 'missing-credential';
    if (config.budgetUrl) result.accounting.status = result.discovery.status;
    return result;
  }
  const [models, budget] = await Promise.all([
    get(`${config.baseUrl.replace(/\/$/, '')}/models`, key),
    config.budgetUrl ? get(config.budgetUrl, key) : Promise.resolve(undefined),
  ]);
  result.discovery = models.state;
  if (models.state.status === 'ok') {
    const parsed = z
      .object({
        data: z
          .array(
            z
              .object({
                id: OpaqueModelId,
              })
              .passthrough(),
          )
          .min(1),
      })
      .safeParse(models.body);
    if (!parsed.success) result.discovery.status = 'invalid-response';
    else
      result.models = parsed.data.data.map((model) => ({
        id: model.id.split(key).join('[REDACTED]'),
        metadata: sanitized(model, key) as Record<string, unknown>,
        experimental: model.id === 'x-test-1',
        mutable: model.id === 'x-test-1' || Boolean((model.soclaas as Record<string, unknown> | undefined)?.alias_of),
      }));
  }
  if (budget) {
    result.accounting = budget.state;
    if (budget.state.status === 'ok') {
      const values: Record<string, number> = {};
      const collect = (input: unknown, prefix = '') => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) return;
        for (const [name, value] of Object.entries(input)) {
          if (name.includes(key) || /api.?key|secret|password|authorization|credits|(^|_)id$/i.test(name)) continue;
          const field = prefix ? `${prefix}.${name}` : name;
          if (typeof value === 'number' && Number.isFinite(value)) values[field] = value;
          else collect(value, field);
        }
      };
      collect(budget.body);
      result.accounting = Object.keys(values).length ? { ...budget.state, values } : { status: 'invalid-response' };
    }
  }
  return result;
}
// Preserve every discovered entry, but only advertise chat-capable entries to
// coding clients. Missing capability metadata remains unknown, not an invented identity.
export function isChatModel(model: ApiModel): boolean {
  const capabilities = (model.metadata.soclaas as Record<string, unknown> | undefined)?.capabilities;
  return !Array.isArray(capabilities) || capabilities.includes('chat');
}
export function assertDefaultModel(config: Upstream, models: ApiModel[], id = config.defaultModel): void {
  const model = models.find((item) => item.id === id && isChatModel(item));
  if (!model) throw new Error('Choose an advertised chat model from this API bucket');
  if (model.mutable && !config.allowMutableDefault)
    throw new Error('This model is mutable; use an explicit per-run selection or allow mutable defaults');
}
export function upstreamConfig(config: Upstream, models: ApiModel[]): Record<string, unknown> {
  assertDefaultModel(config, models);
  const key = readCredential(config.credential);
  const entries = models.map((model) => ({ name: model.id, alias: model.id }));
  return { 'codex-api-key': [{ 'api-key': key, 'base-url': config.baseUrl, models: entries }] };
}
