// Vendors report plans as internal slugs: Codex's usage endpoint says "pro" or
// "prolite", Claude's credential says "max" with a rate-limit tier such as
// "default_claude_max_20x". A Plan is what Switchboard makes of them: the name
// people know and how much quota the plan carries relative to the vendor's base
// plan, which is what makes two accounts' percentages comparable.
//
// The multiples are the vendors' own: OpenAI sells Pro as 5x ($100) or 20x
// ($200) the Codex usage of Plus, with Business seats equal to Plus, and
// Anthropic names Max by its multiple of Pro.

import type { Vendor } from './types';

export interface Plan {
  name: string;
  capacity: number;
}

const FAMILIES: [string, string][] = [
  ['enterprise', 'Enterprise'],
  ['business', 'Business'],
  ['team', 'Team'],
  ['max', 'Max'],
  ['pro', 'Pro'],
  ['plus', 'Plus'],
  ['free', 'Free'],
];

export function describePlan(vendor: Vendor, ...slugs: unknown[]): Plan | null {
  const known = slugs.filter((slug) => slug != null && slug !== '').map(String);
  if (!known.length) return null;
  const s = known.join(' ').toLowerCase();
  const family = FAMILIES.find(([needle]) => s.includes(needle))?.[1] ?? known[0];
  // Codex's plain "pro" is the $200 plan; the $100 one carries "lite".
  const multiple = /20x/.test(s) ? 20 : /5x|pro_?lite/.test(s) ? 5 : vendor === 'codex' && family === 'Pro' ? 20 : null;
  // A Claude Max without its tier is at least the 5x plan.
  const capacity = multiple ?? (vendor === 'claude' && family === 'Max' ? 5 : 1);
  return { name: multiple ? `${family} ${multiple}x` : family, capacity };
}

export function planName(vendor: Vendor, ...slugs: unknown[]): string | null {
  return describePlan(vendor, ...slugs)?.name ?? null;
}
