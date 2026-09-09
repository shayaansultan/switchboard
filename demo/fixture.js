// Invented accounts for the README screenshot and social card. Nothing here is
// real: the addresses are example domains and the numbers are made up.
// `bun run demo` renders the app's own UI against this, so the images stay
// honest to the interface without anyone's accounts appearing in them.
//
// The shapes do mirror what the two vendors actually return, so the images do
// not advertise windows the app never shows:
//   - Claude reports a 5-hour and a 7-day window, plus a model-scoped weekly
//     window on some plans, which always resets at the same moment as the
//     plain 7-day one. Only Claude sends a severity, which is what turns a bar
//     red before it reaches the percentage threshold.
//   - Codex reports no 5-hour window. It sends a weekly one, and model-specific
//     pools arrive as a 5-hour and 7-day pair sharing one prefixed label.

export const profiles = [
  {
    id: 'claude-default',
    vendor: 'claude',
    name: 'Personal',
    isDefault: true,
    color: '#d97757',
    running: true,
    identity: { loggedIn: true, email: 'you@example.com', plan: 'Max' },
    usage: {
      plan: 'Max',
      fetchedAt: new Date().toISOString(),
      windows: [
        { label: '5h', pct: 34, resetsAt: mins(50), severity: 'normal' },
        { label: '7d', pct: 62, resetsAt: mins(195), severity: 'normal' },
        // Shares the weekly reset, as the real one does.
        { label: '7d Fable', pct: 91, resetsAt: mins(195), severity: 'critical' },
      ],
    },
  },
  {
    id: 'claude-work',
    vendor: 'claude',
    name: 'Work',
    isDefault: false,
    color: '#3b82f6',
    running: false,
    setup: { from: 'claude-default' },
    identity: { loggedIn: true, email: 'you@acme.example', plan: 'Team' },
    usage: {
      plan: 'Team',
      fetchedAt: new Date().toISOString(),
      windows: [
        { label: '5h', pct: 12, resetsAt: mins(160), severity: 'normal' },
        { label: '7d', pct: 45, resetsAt: mins(1885), severity: 'normal' },
      ],
    },
  },
  {
    id: 'codex-default',
    vendor: 'codex',
    name: 'Personal',
    isDefault: true,
    color: '#10a37f',
    running: true,
    identity: { loggedIn: true, email: 'you@example.com', plan: 'Pro' },
    usage: {
      plan: 'Pro',
      fetchedAt: new Date().toISOString(),
      windows: [
        { label: '7d', pct: 50, resetsAt: mins(9165) },
        { label: '5.3-Spark 5h', pct: 41, resetsAt: mins(205) },
        { label: '5.3-Spark 7d', pct: 12, resetsAt: mins(9880) },
      ],
    },
  },
  {
    id: 'codex-client',
    vendor: 'codex',
    name: 'Client',
    isDefault: false,
    color: '#a855f7',
    running: false,
    setup: { from: 'codex-default' },
    identity: { loggedIn: true, email: 'you@client.example', plan: 'Business' },
    usage: {
      plan: 'Business',
      fetchedAt: new Date().toISOString(),
      windows: [{ label: '7d', pct: 23, resetsAt: mins(9777) }],
    },
  },
];

export const settings = { terminal: 'Ghostty', pollMinutes: 5, usageMode: 'used', openAtLogin: false };
export const terminals = [
  { id: 'Terminal', label: 'Terminal' },
  { id: 'iTerm2', label: 'iTerm2' },
  { id: 'Ghostty', label: 'Ghostty' },
  { id: 'Warp', label: 'Warp' },
];
export const vendors = {
  claude: { label: 'Claude', installed: true },
  codex: { label: 'Codex', installed: true },
};

function mins(n) {
  return new Date(Date.now() + n * 60000).toISOString();
}
