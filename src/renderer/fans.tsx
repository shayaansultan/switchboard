// Fans: the title-bar button and its popover, beside Keep awake and built the
// same way. Manual is a short boost: choosing it holds the fans at the
// slider's speed for the chosen time, and every later change re-applies with
// a fresh time limit. The helper hands the fans back on its own (time up,
// sleep, restart, Switchboard quitting, serious heat), and the popover says
// why. Speeds are only read while the popover is open.

import { useEffect, useRef, useState } from 'preact/hooks';
import { act } from './lib';
import { Btn, Icon, Seg } from './ui/primitives';
import { FAN_MINUTES, NOTICE_TEXT, STOP_TEXT, type FanState } from '../shared/fans';

const POLL_MS = 2_000;
const minutesLabel = (minutes: number) =>
  minutes === 0 ? 'Until I choose System' : minutes < 60 ? `${minutes} min` : `${minutes / 60} hour`;

function remaining(endsAt: number | null, now: number): string {
  if (endsAt === null) return 'Holds until you choose System.';
  const minutes = Math.max(1, Math.ceil((endsAt - now) / 60_000));
  return `Back to System in ${minutes} min.`;
}

export function FanControl() {
  const [state, setState] = useState<FanState>({ status: 'checking' });
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(60);
  const [minutes, setMinutes] = useState<number>(FAN_MINUTES[0]);
  // Re-renders the countdown while the popover is open; the time itself is
  // read at render, so a fresh hold never shows a stale minute.
  const [, setTick] = useState(0);
  const initialized = useRef(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);

  const position = () => {
    const pop = popover.current;
    const btn = toggle.current;
    if (!pop || !btn) return;
    const anchor = btn.getBoundingClientRect();
    const width = pop.offsetWidth;
    pop.style.top = `${anchor.bottom + 8}px`;
    pop.style.left = `${Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8))}px`;
  };

  useEffect(() => {
    window.sb.onFanState((s) => {
      initialized.current = true;
      setState(s);
    });
    window.sb
      .getState()
      .then((s) => {
        if (!initialized.current && s.fans) setState(s.fans);
      })
      .catch(() => {});
    const pop = popover.current;
    if (!pop) return;
    const onToggle = (event: Event) => {
      const shown = event instanceof ToggleEvent ? event.newState === 'open' : pop.matches(':popover-open');
      setOpen(shown);
      if (shown) {
        position();
        void window.sb.refreshFans().catch(() => {});
      }
    };
    pop.addEventListener('toggle', onToggle);
    window.addEventListener('resize', position);
    return () => {
      pop.removeEventListener('toggle', onToggle);
      window.removeEventListener('resize', position);
    };
  }, []);

  // Live speeds and the countdown, only while someone is looking.
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => {
      setTick((n) => n + 1);
      void window.sb.refreshFans().catch(() => {});
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [open]);
  useEffect(() => {
    if (popover.current?.matches(':popover-open')) position();
  });

  const ready = state.status === 'ready' ? state : null;
  const held = ready?.level ?? null;
  useEffect(() => {
    if (held !== null) setDraft(held);
  }, [held]);

  const apply = (level: number, limit: number) => act(() => window.sb.setFans(level, limit));
  const pick = (mode: 'system' | 'manual') => {
    if (!ready || ready.busy) return;
    if (mode === 'manual' && held === null) void apply(draft, minutes);
    if (mode === 'system' && held !== null) void act(() => window.sb.fanAction('system'));
  };

  // The button stays out of the title bar until there is something to control.
  const hidden = !ready;
  const label = held === null ? 'Fans' : `Fans · ${held}%`;
  const mode = held === null ? 'system' : 'manual';
  const busy = ready?.busy ?? false;

  return (
    <>
      <button
        type="button"
        id="fans-toggle"
        ref={toggle}
        class={`ghost ${held !== null ? 'is-boosted' : ''}`}
        popovertarget="fans-popover"
        aria-haspopup="dialog"
        aria-expanded={open}
        hidden={hidden}
        title={held === null ? 'Fan speed' : `Fans held at ${held}%`}
      >
        <Icon name="fan" />
        <span class="lbl">{label}</span>
        <Icon name="chevron" size={14} class="chev" />
      </button>
      <div id="fans-popover" popover="auto" role="dialog" aria-labelledby="fans-heading" aria-busy={busy} ref={popover}>
        <div class="awake-heading-row">
          <h2 id="fans-heading">Fans</h2>
          <span class="fans-temp">{ready?.temperature != null ? `CPU ${Math.round(ready.temperature)} °C` : ''}</span>
          <button
            type="button"
            popovertarget="fans-popover"
            popovertargetaction="hide"
            aria-label="Close fans"
            class="awake-close"
          >
            ×
          </button>
        </div>
        {ready ? (
          <>
            <Seg
              label="Fan mode"
              value={mode}
              onChange={pick}
              options={[
                { id: 'system', label: 'System' },
                { id: 'manual', label: 'Manual' },
              ]}
            />
            {held === null ? (
              <p class="fans-mode-note">
                macOS is choosing fan speeds. Choose Manual to hold them at the speed below for a while.
              </p>
            ) : (
              <p class="fans-mode-note" role="status">
                Held at {held}%. {remaining(ready.endsAt, Date.now())}
              </p>
            )}
            <div class="fans-speed">
              <label for="fans-level">Speed</label>
              <output for="fans-level">{draft}%</output>
              <input
                id="fans-level"
                type="range"
                min={0}
                max={100}
                step={5}
                value={draft}
                disabled={busy}
                onInput={(e) => setDraft(Number(e.currentTarget.value))}
                onChange={(e) => {
                  if (held !== null) void apply(Number(e.currentTarget.value), minutes);
                }}
              />
              <span class="fans-scale" aria-hidden="true">
                <span>Quiet</span>
                <span>Full</span>
              </span>
            </div>
            <label class="fans-limit">
              <span>Back to System after</span>
              <select
                id="fans-minutes"
                value={minutes}
                disabled={busy}
                onChange={(e) => {
                  const next = Number(e.currentTarget.value);
                  setMinutes(next);
                  if (held !== null) void apply(held, next);
                }}
              >
                {FAN_MINUTES.map((m) => (
                  <option value={m} key={m}>
                    {minutesLabel(m)}
                  </option>
                ))}
              </select>
            </label>
            <ul class="fans-list" aria-label="Fan speeds">
              {ready.fans.map((fan, i) => {
                const share = (fan.actual - fan.minimum) / Math.max(1, fan.maximum - fan.minimum);
                return (
                  <li key={i}>
                    <span>{ready.fans.length === 1 ? 'Fan' : `Fan ${i + 1}`}</span>
                    <span class="fans-track" aria-hidden="true">
                      <span style={{ width: `${Math.round(Math.min(1, Math.max(0.03, share)) * 100)}%` }} />
                    </span>
                    <span class="fans-rpm">{fan.actual.toLocaleString('en-US')} rpm</span>
                  </li>
                );
              })}
            </ul>
            {ready.stop ? (
              <div class="fans-callout" role="status">
                <span>Back on System because {STOP_TEXT[ready.stop]}.</span>
                <Btn variant="secondary" onClick={(e) => act(() => window.sb.fanAction('dismiss'), e.currentTarget)}>
                  Dismiss
                </Btn>
              </div>
            ) : null}
            {ready.notice ? (
              <div class="fans-callout" id="fans-notice" role="alert">
                <span>{NOTICE_TEXT[ready.notice]}</span>
                {ready.notice === 'needs-approval' ? (
                  <Btn
                    variant="secondary"
                    onClick={(e) => act(() => window.sb.fanAction('login-items'), e.currentTarget)}
                  >
                    Open Login Items
                  </Btn>
                ) : null}
              </div>
            ) : null}
            {ready.helper !== 'installed' && !ready.notice ? (
              <p class="hint">
                Manual needs a small helper that runs as root. macOS asks you to allow it once in Login Items.
              </p>
            ) : null}
            <p class="hint">
              Switchboard hands the fans back to macOS when the time is up, on sleep or restart, if it quits, or if the
              Mac gets seriously hot.
            </p>
          </>
        ) : null}
      </div>
    </>
  );
}
