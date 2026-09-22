import { expect, test } from 'bun:test';
import { describePlan, planName } from '../src/plans';

test('Codex plans carry the multiples OpenAI sells them by', () => {
  expect(describePlan('codex', 'plus')).toEqual({ name: 'Plus', capacity: 1 });
  expect(describePlan('codex', 'prolite')).toEqual({ name: 'Pro 5x', capacity: 5 });
  expect(describePlan('codex', 'pro_lite')).toEqual({ name: 'Pro 5x', capacity: 5 });
  expect(describePlan('codex', 'pro')).toEqual({ name: 'Pro 20x', capacity: 20 });
  expect(describePlan('codex', 'self_serve_business_prolite')).toEqual({ name: 'Business 5x', capacity: 5 });
  expect(describePlan('codex', 'team')).toEqual({ name: 'Team', capacity: 1 });
  expect(describePlan('codex', 'enterprise_2024')).toEqual({ name: 'Enterprise', capacity: 1 });
});

test('Claude plans take their multiple from the rate-limit tier', () => {
  expect(describePlan('claude', 'pro', 'default_claude_pro')).toEqual({ name: 'Pro', capacity: 1 });
  expect(describePlan('claude', 'max', 'default_claude_max_5x')).toEqual({ name: 'Max 5x', capacity: 5 });
  expect(describePlan('claude', 'max', 'default_claude_max_20x')).toEqual({ name: 'Max 20x', capacity: 20 });
  expect(describePlan('claude', undefined, 'default_claude_max_20x')).toEqual({ name: 'Max 20x', capacity: 20 });
  // Without the tier a Max is at least the 5x plan.
  expect(describePlan('claude', 'max')).toEqual({ name: 'Max', capacity: 5 });
  expect(describePlan('claude', 'max', null)).toEqual({ name: 'Max', capacity: 5 });
});

test('unknown slugs are shown as given and count as the base plan', () => {
  expect(describePlan('codex', 'mystery')).toEqual({ name: 'mystery', capacity: 1 });
  expect(describePlan('claude', null)).toBeNull();
  expect(describePlan('claude', '', undefined)).toBeNull();
  expect(planName('claude', 'max', 'default_claude_max_20x')).toBe('Max 20x');
  expect(planName('codex', null)).toBeNull();
});
