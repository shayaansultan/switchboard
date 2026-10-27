// What the band keeps between draws: the profile's plan and rate-limit
// windows, as `switchboard usage` last reported them, and this session's
// context fill (a whole percentage) and cost, as the session last reported them.
export type BandWindow = { label: string; remaining: number; resetsAt: string | null; severity: string | null };
export type BandUsage = { plan: string | null; windows: BandWindow[] };
export type BandSession = { context: number | null; costUsd: number | null };

declare module 'claude-code' {
  interface PluginState {
    'switchboard-profile-band': { usage: BandUsage | null; session: BandSession | null };
  }
}
