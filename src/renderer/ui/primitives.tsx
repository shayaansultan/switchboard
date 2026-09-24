// The design's vocabulary as components: an icon, a button, a badge, a usage
// bar, the ring, a switch, a segmented control. Their looks live in
// style.css; these only fix the markup so every view draws them the same way.

import type { ComponentChildren, JSX } from 'preact';
import { severityClass, relShort, relTime, type UsageWindow } from '../lib';
import { useTip } from './overlays';

// Stroke icons in Lucide's style, coloured by the surrounding text.
const PATHS = {
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  sliders:
    '<line x1="21" y1="4" x2="14" y2="4"/><line x1="10" y1="4" x2="3" y2="4"/><line x1="21" y1="12" x2="12" y2="12"/><line x1="8" y1="12" x2="3" y2="12"/><line x1="21" y1="20" x2="16" y2="20"/><line x1="12" y1="20" x2="3" y2="20"/><line x1="14" y1="2" x2="14" y2="6"/><line x1="8" y1="10" x2="8" y2="14"/><line x1="16" y1="18" x2="16" y2="22"/>',
  refresh: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  chevron: '<polyline points="6 9 12 15 18 9"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
  layers:
    '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  users:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  warn: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  right: '<polyline points="9 6 15 12 9 18"/>',
  // Launch, quit, start and stop: the two filled ones read as "go" and "halt"
  // at 13 px, where a stroked triangle would not.
  play: '<polygon points="7 4 20 12 7 20 7 4" fill="currentColor" stroke="none"/>',
  power: '<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  // A launch or quit on its way (spun in CSS), and forcing one through.
  loader: '<path d="M21 12a9 9 0 1 1-6.22-8.56"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
};
export type IconName = keyof typeof PATHS;

export function Icon({ name, size, class: cls }: { name: IconName; size?: number; class?: string }) {
  const style = size ? { width: `${size}px`, height: `${size}px` } : undefined;
  return (
    <span class={`ico ico-${name} ${cls ?? ''}`} style={style} aria-hidden="true">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
        dangerouslySetInnerHTML={{ __html: PATHS[name] }}
      />
    </span>
  );
}

type ButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'icon';
  icon?: IconName;
  children?: ComponentChildren;
};
export function Btn({ variant = 'outline', icon, class: cls, children, type = 'button', ...rest }: ButtonProps) {
  const classes = [variant === 'outline' ? '' : variant === 'icon' ? 'icon-btn ghost' : variant, cls ?? ''].join(' ');
  return (
    <button type={type} class={classes.trim()} {...rest}>
      {icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}

// A button whose tooltip is the app's own instant one rather than the
// browser's slow title. The first line is the label; more lines are detail.
export function TipBtn({ tip, ...props }: ButtonProps & { tip: string[] }) {
  const handlers = useTip(tip);
  return <Btn {...props} {...handlers} />;
}

// The one panel every tab is built from: a header band of fixed height that
// holds a title, an optional status pill and a line of detail on the left
// and any actions on the right, then a body.
export function Panel({
  title,
  status,
  meta,
  actions,
  children,
  class: cls,
  ...rest
}: {
  title: ComponentChildren;
  status?: ComponentChildren;
  meta?: ComponentChildren;
  actions?: ComponentChildren;
  children: ComponentChildren;
  class?: string;
} & Record<string, unknown>) {
  return (
    <section class={`panel ${cls ?? ''}`} {...rest}>
      <div class="panel-head">
        <span class="panel-title">{title}</span>
        {status}
        {meta ? <span class="panel-meta">{meta}</span> : null}
        {actions ? <span class="panel-actions">{actions}</span> : null}
      </div>
      <div class="panel-body">{children}</div>
    </section>
  );
}

// Running or not, as a pill: mint with a filled dot when on. `tone` and
// `dot` override that for states in between, such as a desktop app starting
// (pulsing dot) or refusing to quit (amber).
export type DotKind = 'on' | 'off' | 'busy' | 'warn';
export function StatusPill({
  on,
  tone,
  dot,
  children,
}: {
  on: boolean;
  tone?: 'ok' | 'mute' | 'warn';
  dot?: DotKind;
  children: ComponentChildren;
}) {
  return (
    <span class={`badge ${tone ?? (on ? 'ok' : 'mute')} status`}>
      <span class={`dot ${dot ?? (on ? 'on' : 'off')}`} />
      {children}
    </span>
  );
}

export function Badge({ children, tone = 'plan' }: { children: ComponentChildren; tone?: 'plan' | 'mute' | 'ok' }) {
  return <span class={`badge ${tone}`}>{children}</span>;
}

// Hidden when off, so a list of stopped profiles stays quiet.
export function Dot({ on, kind, title }: { on: boolean; kind?: DotKind; title?: string }) {
  const k = kind ?? (on ? 'on' : 'off');
  return <span class={`dot ${k === 'off' ? '' : k}`} title={title} />;
}

export function Skeleton({ width }: { width: number }) {
  return <span class="skel" style={{ width: `${width}px` }} />;
}

// One usage window: label with its reset beside it, the bar, the number.
export function Bar({ w, stale = false, remaining = false }: { w: UsageWindow; stale?: boolean; remaining?: boolean }) {
  const pct = w.pct ?? 0;
  const shown = remaining ? 100 - pct : pct;
  const passed = stale && !!w.resetsAt && Date.parse(w.resetsAt) <= Date.now();
  const reset = passed ? 'reset passed' : relShort(w.resetsAt);
  const hint = passed ? 'Reset time passed; awaiting updated usage' : relTime(w.resetsAt);
  return (
    <div class="bar">
      <span class="label" title={[w.label, hint].filter(Boolean).join(', ')}>
        {w.label}
        {reset ? <span class="reset"> · {reset}</span> : null}
      </span>
      <div class="track">
        <div class={`fill ${severityClass(w)}`} style={{ width: `${shown}%` }} />
      </div>
      <span class="pct" title={remaining ? `${pct}% used` : `${100 - pct}% left`}>
        {shown}%
      </span>
    </div>
  );
}

// The account's fullest window at a glance, coloured like that window's bar.
// Hollow while nothing is known, so the column still lines up.
export function Ring({ w }: { w: UsageWindow | null }) {
  if (!w) return <span class="empty-ring" />;
  const pct = w.pct ?? 0;
  const r = 12.5;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 28 28" aria-label={`${w.label}: ${pct}% used`}>
      <circle cx="14" cy="14" r={r} fill="none" stroke-width="3" stroke="var(--track)" />
      <circle
        cx="14"
        cy="14"
        r={r}
        fill="none"
        stroke-width="3"
        class={`ring-fill ${severityClass(w)}`}
        stroke-linecap="round"
        stroke-dasharray={c.toFixed(1)}
        stroke-dashoffset={(c * (1 - pct / 100)).toFixed(1)}
      />
    </svg>
  );
}

export function Note({ children, tone, class: cls }: { children: ComponentChildren; tone?: 'warn'; class?: string }) {
  return <div class={`note ${tone ?? ''} ${cls ?? ''}`}>{children}</div>;
}

// Wispr's 42 by 25 switch, wrapping a real checkbox; `small` is the 34 by
// 20 one for a row.
export function Switch({
  name,
  checked,
  onChange,
  label,
  small = false,
}: {
  name?: string;
  checked: boolean;
  onChange?: (on: boolean) => void;
  label: string;
  small?: boolean;
}) {
  return (
    <span class={`switch ${small ? 'sm' : ''}`}>
      <input
        type="checkbox"
        name={name}
        checked={checked}
        aria-label={label}
        onChange={(e) => onChange?.((e.currentTarget as HTMLInputElement).checked)}
      />
      <span class="knob" />
    </span>
  );
}

// A segmented control: a warm track, the chosen segment lifted on white.
export function Seg<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { id: T; label: string; icon?: IconName }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div class="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          type="button"
          role="radio"
          aria-checked={o.id === value}
          class={o.id === value ? 'on' : ''}
          onClick={() => onChange(o.id)}
          key={o.id}
        >
          {o.icon ? <Icon name={o.icon} size={14} /> : null}
          {o.label}
        </button>
      ))}
    </div>
  );
}
