// The title bar's popovers as components: a button that shows a feature's
// state without opening it, and a panel under it whose header is the title,
// an optional (i), an optional reading and a close icon. Inside, panels are
// built from the same few blocks: a status line, a note, a countdown card and
// a row of buttons. Caffeinate and Fans are made of these, so the next one
// gets the same spacing and alignment without new CSS. Looks live in
// style.css under "title bar's popovers".

import type { ComponentChildren } from 'preact';
import { useTitlePopover } from './overlays';
import { Icon, InfoTip, type IconName } from './primitives';

export type Tone = 'run' | 'warm';

export function TitlePopover({
  id,
  pop,
  icon,
  label,
  tone,
  tip,
  title,
  info,
  meta,
  hidden,
  busy,
  children,
}: {
  /** Prefix for the toggle's and panel's ids. */
  id: string;
  pop: ReturnType<typeof useTitlePopover>;
  icon: IconName;
  label: string;
  /** Colours the button while something is running. */
  tone?: Tone | null;
  /** The button's hover title. */
  tip: string;
  title: string;
  /** Detail for the (i): first line is the heading. */
  info?: string[];
  /** A reading at the header's right, such as a temperature. */
  meta?: string | null;
  hidden?: boolean;
  busy?: boolean;
  children: ComponentChildren;
}) {
  return (
    <>
      <button
        type="button"
        id={`${id}-toggle`}
        ref={pop.toggle}
        class={`ghost title-toggle ${tone ? `is-${tone}` : ''}`}
        popovertarget={`${id}-popover`}
        aria-haspopup="dialog"
        aria-expanded={pop.open}
        hidden={hidden}
        title={tip}
      >
        <Icon name={icon} />
        <span class="lbl">{label}</span>
        <Icon name="chevron" size={14} class="chev" />
      </button>
      <div
        id={`${id}-popover`}
        class="title-popover"
        popover="auto"
        role="dialog"
        aria-labelledby={`${id}-heading`}
        aria-busy={busy}
        ref={pop.popover}
      >
        <div class="title-popover-head">
          <h2 id={`${id}-heading`}>{title}</h2>
          {info ? <InfoTip lines={info} /> : null}
          <span class="title-popover-gap" />
          {meta ? <span class="title-popover-meta">{meta}</span> : null}
          <button
            type="button"
            popovertarget={`${id}-popover`}
            popovertargetaction="hide"
            aria-label={`Close ${title}`}
            class="title-popover-close"
          >
            <Icon name="x" size={16} />
          </button>
        </div>
        {children}
      </div>
    </>
  );
}

/** Who is in control right now, with a coloured dot. */
export function StatusLine({ tone, children }: { tone: 'on' | 'warn' | 'idle'; children: ComponentChildren }) {
  return (
    <p class="pop-line">
      <span class={`dot ${tone}`} aria-hidden="true" />
      {children}
    </p>
  );
}

/** One line of news: why something ended, or what is needed. */
export function Note({
  tone,
  id,
  alert,
  onDismiss,
  action,
  children,
}: {
  tone?: 'warn' | 'bad';
  id?: string;
  /** Announced at once (role alert) rather than politely. */
  alert?: boolean;
  onDismiss?: (e: Event) => void;
  action?: ComponentChildren;
  children: ComponentChildren;
}) {
  return (
    <div class={`pop-note ${tone ?? ''}`} id={id} role={alert ? 'alert' : 'status'}>
      <span>{children}</span>
      {action}
      {onDismiss ? (
        <button type="button" class="pop-dismiss" aria-label="Dismiss" onClick={onDismiss}>
          <Icon name="x" size={14} />
        </button>
      ) : null}
    </div>
  );
}

/** A running session: what it is, the time left, and a bar that drains. */
export function StatusCard({
  tone,
  title,
  left,
  limit,
  children,
}: {
  tone: Tone;
  title: string;
  /** Minutes left, or null for a session that runs until stopped. */
  left: number | null;
  limit: number | null;
  children?: ComponentChildren;
}) {
  const share = limit && left !== null ? Math.min(1, left / limit) : 1;
  return (
    <div class={`pop-card ${tone}`} role="status">
      <div class="pop-card-row">
        <b>{title}</b>
        <span>{left === null ? 'until you stop' : timeLeft(left)}</span>
      </div>
      {children ? <p>{children}</p> : null}
      {left !== null ? (
        <div class="pop-drain" aria-hidden="true">
          <span style={{ width: `${Math.round(share * 100)}%` }} />
        </div>
      ) : null}
    </div>
  );
}

export function ButtonRow({ children }: { children: ComponentChildren }) {
  return <div class="pop-buttons">{children}</div>;
}

/** A titled block under a hairline, such as Boost. */
export function PopSection({ id, title, children }: { id: string; title: string; children: ComponentChildren }) {
  return (
    <section class="pop-section" aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      {children}
    </section>
  );
}

/** "52 min left", "2 h left", "1 h 30 min left". */
export function timeLeft(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  if (!hours) return `${minutes} min left`;
  return minutes % 60 ? `${hours} h ${minutes % 60} min left` : `${hours} h left`;
}

/** The title bar's short form: "52m", "2h". */
export function shortLeft(minutes: number): string {
  return minutes >= 60 ? `${Math.round(minutes / 60)}h` : `${minutes}m`;
}

/** Whole minutes until `endsAt`, never below one. */
export function minutesLeft(endsAt: number): number {
  return Math.max(1, Math.ceil((endsAt - Date.now()) / 60_000));
}
