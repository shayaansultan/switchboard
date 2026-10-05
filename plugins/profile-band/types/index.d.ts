// What the band keeps between draws: the profile's plan and rate-limit
// windows, as `switchboard usage` last reported them.
export type BandWindow = { label: string; remaining: number; resetsAt: string | null; severity: string };
export type BandUsage = { plan: string | null; windows: BandWindow[] };

declare module 'claude-code' {
  interface PluginState {
    'switchboard-profile-band': { usage: BandUsage | null };
  }
}
