import { expect, test } from 'bun:test';
import { vendorRequest } from '../src/buckets/proxy';
import { mergedCatalog, claudeDescriptor, type ClaudeModel } from '../src/buckets/models';
import { parseClaudeUsage } from '../src/usage-parsers';

const model: ClaudeModel = {
  id: 'claude-fixture',
  display_name: 'Claude fixture',
  context_length: 200000,
  max_completion_tokens: 32000,
  supportedInputModalities: ['text', 'image'],
  supportedOutputModalities: ['text'],
  thinking: { levels: ['low', 'high', 'future-effort'] },
};

test('mixed buckets select provider-specific usage endpoints and headers', () => {
  const account = {
    name: 'claude.json',
    auth_index: 'claude-id',
    provider: 'claude',
    account_id: 'not-a-chatgpt-account',
  };
  const claude = vendorRequest(account);
  expect(claude.url).toBe('https://api.anthropic.com/api/oauth/usage');
  expect(claude.header['anthropic-beta']).toBe('oauth-2025-04-20');
  expect(claude.header['ChatGPT-Account-Id']).toBeUndefined();
  expect(vendorRequest(account, 'profile').url).toBe('https://api.anthropic.com/api/oauth/profile');
  const codex = { name: 'codex.json', auth_index: 'codex-id', type: 'codex', account_id: 'chatgpt-account' };
  const usage = vendorRequest(codex);
  expect(usage.header['ChatGPT-Account-Id']).toBe('chatgpt-account');
  expect(usage.header['anthropic-beta']).toBeUndefined();
  // Codex reports its plan with usage; there is no profile to ask.
  expect(() => vendorRequest(codex, 'profile')).toThrow();
  expect(() => vendorRequest({ name: 'other', auth_index: 'id', provider: 'other' })).toThrow();
});

test('Claude metadata is appended without mutating GPT catalog entries', () => {
  const gpt = {
    slug: 'gpt-fixture',
    display_name: 'GPT',
    priority: 1,
    model_messages: { instructions_template: 'original' },
    futureCapability: { value: 42 },
  };
  const combined = mergedCatalog({ models: [gpt] }, [model]);
  expect(combined.models[0]).toEqual(gpt);
  expect(combined.models[1].slug).toBe('claude-fixture');
  expect(combined.models[1].context_window).toBe(200000);
  expect(combined.models[1].apply_patch_tool_type).toBeNull();
  expect(combined.models[1].use_responses_lite).toBe(false);
  expect(combined.models[1].node_repl_disabled).toBe(true);
  expect(combined.models[1].supports_search_tool).toBe(true);
  expect(combined.models[1].tool_mode).toBe('code_mode_only');
  expect(combined.models[1].supported_reasoning_levels).toEqual([
    { effort: 'low', description: 'low reasoning effort' },
    { effort: 'high', description: 'high reasoning effort' },
  ]);
  expect(mergedCatalog(combined, [model]).models).toEqual(combined.models);
  expect(claudeDescriptor({ ...model, thinking: undefined }, 100).default_reasoning_level).toBeNull();
});

test('Claude fallback usage includes model-specific windows without duplicating the modern limits array', () => {
  const payload = {
    five_hour: { utilization: 12 },
    seven_day: { utilization: 25 },
    seven_day_opus: { utilization: 80 },
  };
  expect(parseClaudeUsage(payload).map((window) => [window.label, window.pct])).toEqual([
    ['5h', 12],
    ['7d', 25],
    ['7d Opus', 80],
  ]);
  expect(parseClaudeUsage({ ...payload, limits: [{ kind: 'session', percent: 14 }] })).toHaveLength(1);
});

test('existing Claude catalog entries receive current tool capabilities without losing custom metadata', () => {
  const gpt = { slug: 'gpt-fixture', supports_search_tool: false, tool_mode: 'custom-gpt-mode' };
  const existing = {
    slug: model.id,
    display_name: 'Custom Claude label',
    priority: 5,
    context_window: 123456,
    model_messages: { instructions_template: 'Custom instructions' },
    futureCapability: { value: 42 },
    supports_search_tool: false,
    tool_mode: null,
  };
  const unavailable = { slug: 'claude-unavailable', supports_search_tool: false };
  const original = { models: [gpt, existing, unavailable] };
  const snapshot = structuredClone(original);
  const combined = mergedCatalog(original, [model]);
  expect(combined.models).toEqual([
    gpt,
    { ...existing, supports_search_tool: true, tool_mode: 'code_mode_only' },
    unavailable,
  ]);
  expect(original).toEqual(snapshot);
  expect(mergedCatalog(combined, [model])).toEqual(combined);
});
