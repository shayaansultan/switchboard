// Time in words, the same way everywhere Switchboard shows it: the window,
// the menu bar and the phone app. Short forms ("2h 5m", "40m ago") because
// they sit beside bars and rows; whole days past two days.

export function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.round(h / 24)}d`;
}

// "resets in 2h 5m", "resets now", or '' for no or a bad time.
export function resetsIn(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const ms = Date.parse(iso) - now;
  if (Number.isNaN(ms)) return '';
  return ms <= 0 ? 'resets now' : `resets in ${duration(ms)}`;
}

// "just now", "2m ago", "3h ago", "4d ago", or '' for no or a bad time.
// Whole hours: how long ago matters less than how long until.
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const ms = now - Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

// A local clock time, "4:05 PM" or "16:05" as the device prefers.
export function clock(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
}

// "Sat 02:00": a moment days away, easier to plan around as a day and time.
export function dayAndTime(at: number, timeZone?: string): string {
  return new Date(Math.round(at / 60000) * 60000).toLocaleString('en-GB', {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  });
}
