// The usage endpoints are undocumented, so the shapes they have been seen to
// return are pinned here. If a bar goes blank after a vendor change, the new
// response belongs in one of these fixtures.

const { test, expect } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// usage.js pulls in the profile store, which resolves HOME at import.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-usage-'));
const { parseClaudeUsage, parseCodexUsage, planName, keychainService } = require('../src/usage');

// ---- Claude ----

test('Claude: the limits list gives the session, weekly and model-scoped windows', () => {
  const windows = parseClaudeUsage({
    limits: [
      { kind: 'session', percent: 8.4, resets_at: '2026-09-10T06:00:00Z', severity: 'ok' },
      { kind: 'weekly_all', percent: 3, resets_at: 1789344000, severity: null },
      {
        kind: 'weekly_model',
        group: 'weekly',
        percent: 2,
        resets_at: 1789344000,
        scope: { model: { display_name: 'Fable' } },
      },
      { kind: 'weekly_surface', group: 'session', percent: 55, resets_at: null, scope: { surface: 'code' } },
      { kind: 'weekly_model', percent: null, scope: { model: { display_name: 'Ignored' } } },
    ],
    five_hour: { utilization: 99 }, // ignored when `limits` is present
  });
  expect(windows).toEqual([
    { label: '5h', pct: 8, resetsAt: '2026-09-10T06:00:00.000Z', severity: 'ok' },
    { label: '7d', pct: 3, resetsAt: '2026-09-14T00:00:00.000Z', severity: null },
    { label: '7d Fable', pct: 2, resetsAt: '2026-09-14T00:00:00.000Z', severity: null },
    { label: '5h code', pct: 55, resetsAt: null, severity: null },
  ]);
});

test('Claude: the older two-window shape still parses', () => {
  const windows = parseClaudeUsage({
    five_hour: { utilization: 12.6, resets_at: '2026-09-10T06:00:00Z' },
    seven_day: { utilization: 4 },
  });
  expect(windows).toEqual([
    { label: '5h', pct: 13, resetsAt: '2026-09-10T06:00:00.000Z' },
    { label: '7d', pct: 4, resetsAt: null },
  ]);
});

test('Claude: an empty or unrecognised body yields no windows, not a crash', () => {
  expect(parseClaudeUsage({})).toEqual([]);
  expect(parseClaudeUsage({ limits: [] })).toEqual([]);
  expect(parseClaudeUsage({ five_hour: { utilization: null } })).toEqual([]);
});

// ---- Codex ----

const NOW = Date.parse('2026-09-10T12:00:00Z');

test('Codex: primary and secondary windows, labelled by their length', () => {
  const windows = parseCodexUsage(
    {
      plan_type: 'pro',
      rate_limit: {
        primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_after_seconds: 3600 },
        secondary_window: { used_percent: 2.4, limit_window_minutes: 10080, reset_at: 1789344000 },
      },
    },
    NOW,
  );
  expect(windows).toEqual([
    { label: '5h', pct: 0, resetsAt: '2026-09-10T13:00:00.000Z' },
    { label: '7d', pct: 2, resetsAt: '2026-09-14T00:00:00.000Z' },
  ]);
});

test('Codex: model-specific pools are prefixed with a short model name', () => {
  const windows = parseCodexUsage({
    rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 604800 } },
    additional_rate_limits: [
      {
        limit_name: 'GPT-5.3-Codex-Spark',
        rate_limit: {
          primary_window: { used_percent: 0, limit_window_seconds: 18000 },
          secondary_window: { used_percent: 0, limit_window_seconds: 604800 },
        },
      },
      { limit_name: 'gpt-reserve', rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 604800 } } },
    ],
  });
  expect(windows.map((w) => w.label)).toEqual(['7d', '5.3-Spark 5h', '5.3-Spark 7d', 'gpt-reserve 7d']);
});

test('Codex: windows without a percentage are skipped, and odd lengths get a plain label', () => {
  const windows = parseCodexUsage({
    rate_limit: {
      primary_window: { used_percent: null, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 150 },
    },
  });
  expect(windows).toEqual([{ label: 'window', pct: 100, resetsAt: null }]);
});

test('Codex: an empty body yields no windows', () => {
  expect(parseCodexUsage({})).toEqual([]);
});

// ---- shared ----

test('plan slugs are reduced to the name people know', () => {
  expect(planName('self_serve_business_prolite')).toBe('Business');
  expect(planName('max')).toBe('Max');
  expect(planName('pro')).toBe('Pro');
  expect(planName('plus')).toBe('Plus');
  expect(planName('enterprise_2024')).toBe('Enterprise');
  expect(planName('mystery')).toBe('mystery');
  expect(planName(null)).toBe(null);
});

test('the keychain service name depends on the config dir, as Claude Code derives it', () => {
  // The default home comes from the profile module, which may already have
  // been loaded by another test file with its own sandbox HOME.
  const { VENDORS } = require('../src/profiles');
  expect(keychainService(VENDORS.claude.defaultHome)).toBe('Claude Code-credentials');
  const other = keychainService('/some/other/dir');
  expect(other).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
  expect(keychainService('/some/other/dir')).toBe(other);
});
