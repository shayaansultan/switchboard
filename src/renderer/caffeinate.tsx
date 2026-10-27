// Caffeinate: the title-bar button and its popover, before Fans and built the
// same way. Decaf (the Mac sleeps as usual) is the resting state; nothing
// changes until Caffeinate is pressed, and a running session is a green
// countdown with +1 hour and Decaf now. "Keep the screen on too" and "Also
// with the lid closed" are off by default; only the lid option needs the
// system helper, so lid-open sessions never ask for anything.

import { useEffect, useRef, useState } from 'preact/hooks';
import { act } from './lib';
import { Btn, DurationPicker, Icon, InfoTip, durationMinutes, durationWords, type Duration } from './ui/primitives';
import { useTitlePopover } from './ui/overlays';
import {
  CAFFEINATE_MINUTES,
  CAFFEINATE_NOTICE_TEXT,
  CAFFEINATE_STOP_TEXT,
  LID_SUPPORT_TEXT,
  type CaffeinateState,
} from '../shared/caffeinate';

type Action = Parameters<typeof window.sb.caffeinateAction>[0];

const minutesLeft = (endsAt: number) => Math.max(1, Math.ceil((endsAt - Date.now()) / 60_000));
const longLeft = (minutes: number) => {
  const hours = Math.floor(minutes / 60);
  if (!hours) return `${minutes} min left`;
  return minutes % 60 ? `${hours} h ${minutes % 60} min left` : `${hours} h left`;
};
const shortLeft = (minutes: number) => (minutes >= 60 ? `${Math.round(minutes / 60)}h` : `${minutes}m`);

export function Caffeinate() {
  const [state, setState] = useState<CaffeinateState | null>(null);
  const [duration, setDuration] = useState<Duration>({ choice: '60', custom: 90 });
  const [screen, setScreen] = useState(false);
  const [lid, setLid] = useState(false);
  const [, setTick] = useState(0);
  const initialized = useRef(false);
  const { toggle, popover, open } = useTitlePopover(() => void window.sb.refreshCaffeinate().catch(() => {}));

  useEffect(() => {
    window.sb.onCaffeinateState((s) => {
      initialized.current = true;
      setState(s);
    });
    window.sb
      .getState()
      .then((s) => {
        if (!initialized.current && s.caffeinate) setState(s.caffeinate);
      })
      .catch(() => {});
  }, []);

  // Keeps the countdown current while someone is looking, and notices the
  // helper being allowed in Login Items.
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => {
      setTick((n) => n + 1);
      if (state?.queued) void window.sb.refreshCaffeinate().catch(() => {});
    }, 5_000);
    return () => clearInterval(timer);
  }, [open, state?.queued]);

  const run = (action: Action) => (e: Event) => act(() => window.sb.caffeinateAction(action), e.currentTarget);
  const active = state?.active ?? false;
  const busy = state?.busy ?? false;
  const left = state?.endsAt != null ? minutesLeft(state.endsAt) : null;
  const minutes = durationMinutes(duration);
  const lidAvailable = state?.lidSupport === 'available';

  let label = 'Decaf';
  if (active) label = `Caffeinated${left !== null ? ` · ${shortLeft(left)}` : ''}${state?.lid ? ' · lid' : ''}`;

  let body = null;
  if (state?.queued) {
    body = (
      <>
        <div class="pop-note warn" role="status">
          <span>{CAFFEINATE_NOTICE_TEXT['needs-approval']}</span>
        </div>
        <div class="pop-buttons">
          <Btn variant="secondary" onClick={run('cancel')}>
            Cancel
          </Btn>
          <Btn variant="primary" onClick={run('login-items')}>
            Open Login Items
          </Btn>
        </div>
      </>
    );
  } else if (state && active) {
    const scope = ['The Mac stays awake', state.screen ? 'with the screen on' : null];
    if (state.lid) scope.push('even with the lid closed');
    const share = state.limit && left !== null ? Math.min(1, left / state.limit) : 1;
    body = (
      <>
        <div class="pop-card run" role="status">
          <div class="pop-card-row">
            <b>Caffeinated</b>
            <span>{left !== null ? longLeft(left) : 'until you stop'}</span>
          </div>
          <p>{scope.filter(Boolean).join(', ')}.</p>
          {state.lid ? <span class="pop-tag">Lid closed · ends below 20% battery</span> : null}
          {left !== null ? (
            <div class="pop-drain" aria-hidden="true">
              <span style={{ width: `${Math.round(share * 100)}%` }} />
            </div>
          ) : null}
        </div>
        <div class="pop-buttons">
          {left !== null ? (
            <Btn id="caffeinate-extend" variant="secondary" disabled={busy} onClick={run('extend')}>
              +1 hour
            </Btn>
          ) : null}
          <Btn id="caffeinate-stop" variant="primary" disabled={busy} onClick={run('stop')}>
            Decaf now
          </Btn>
        </div>
      </>
    );
  } else if (state) {
    let start = minutes ? `Caffeinate for ${durationWords(minutes)}` : 'Caffeinate until I stop';
    if (busy) start = 'Starting…';
    body = (
      <>
        <p class="pop-line">
          <span class="dot idle" aria-hidden="true" />
          Decaf: the Mac sleeps as usual
        </p>
        {state.sleepDisabledElsewhere ? (
          <div class="pop-note warn" role="status">
            <span>Sleep is turned off system-wide outside Caffeinate, as an older Keep awake or pmset left it.</span>
            <Btn variant="secondary" disabled={busy} onClick={run('clear')}>
              Turn sleep on
            </Btn>
          </div>
        ) : null}
        {state.stop ? (
          <div class="pop-note" role="status">
            <span>Ended because {CAFFEINATE_STOP_TEXT[state.stop]}.</span>
            <button type="button" class="pop-dismiss" aria-label="Dismiss" onClick={run('dismiss')}>
              ×
            </button>
          </div>
        ) : null}
        {state.notice ? (
          <div class="pop-note warn" id="caffeinate-notice" role="alert">
            <span>{CAFFEINATE_NOTICE_TEXT[state.notice]}</span>
          </div>
        ) : null}
        <DurationPicker
          label="Stay awake for"
          presets={CAFFEINATE_MINUTES}
          value={duration}
          disabled={busy}
          onChange={setDuration}
        />
        <div class="pop-options">
          <label class="pop-option">
            <input
              type="checkbox"
              checked={screen}
              disabled={busy}
              onChange={(e) => setScreen(e.currentTarget.checked)}
            />
            <span>Keep the screen on too</span>
          </label>
          <div class={`pop-option ${lidAvailable ? '' : 'off'}`}>
            <label>
              <input
                type="checkbox"
                checked={lid && lidAvailable}
                disabled={busy || !lidAvailable}
                onChange={(e) => setLid(e.currentTarget.checked)}
              />
              <span>Also with the lid closed</span>
            </label>
            <InfoTip
              lines={
                lidAvailable
                  ? [
                      'Keeps a closed MacBook awake',
                      'Ends by itself below 20% battery or in serious heat.',
                      ...(state.helper === 'installed' ? [] : ['Asks once to allow a helper in Login Items.']),
                    ]
                  : [
                      'Not available here',
                      LID_SUPPORT_TEXT[state.lidSupport as Exclude<typeof state.lidSupport, 'available'>],
                    ]
              }
            />
          </div>
        </div>
        <Btn
          id="caffeinate-start"
          variant="primary"
          disabled={busy}
          onClick={(e) => act(() => window.sb.startCaffeinate(minutes, screen, lid && lidAvailable), e.currentTarget)}
        >
          {start}
        </Btn>
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        id="caffeinate-toggle"
        ref={toggle}
        class={`ghost title-toggle ${active ? 'is-on' : ''}`}
        popovertarget="caffeinate-popover"
        aria-haspopup="dialog"
        aria-expanded={open}
        hidden={!state}
        title={active ? 'The Mac is being kept awake' : 'Keep the Mac awake for a while'}
      >
        <Icon name={active ? 'coffee' : 'cup'} />
        <span class="lbl">{label}</span>
        <Icon name="chevron" size={14} class="chev" />
      </button>
      <div
        id="caffeinate-popover"
        class="title-popover"
        popover="auto"
        role="dialog"
        aria-labelledby="caffeinate-heading"
        aria-busy={busy}
        ref={popover}
      >
        <div class="title-popover-head">
          <h2 id="caffeinate-heading">Caffeinate</h2>
          <InfoTip
            lines={['Ends when the time is up or Switchboard quits', 'With the lid open it needs no password.']}
          />
          <button
            type="button"
            popovertarget="caffeinate-popover"
            popovertargetaction="hide"
            aria-label="Close Caffeinate"
            class="title-popover-close"
          >
            ×
          </button>
        </div>
        {body}
      </div>
    </>
  );
}
