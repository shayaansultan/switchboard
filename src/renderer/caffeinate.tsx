// Caffeinate: the title-bar button and its popover, before Fans and built
// from the same title-popover pieces. Decaf (the Mac sleeps as usual) is the
// resting state; nothing changes until Caffeinate is pressed, and a running
// session is a green countdown with +1 hour and Decaf now. The screen stays
// on throughout. "Also with the lid closed" is off by default; only it needs
// the system helper, so lid-open sessions never ask for anything.

import { useEffect, useRef, useState } from 'preact/hooks';
import { act } from './lib';
import { Btn, DurationPicker, InfoTip, durationMinutes, durationWords, type Duration } from './ui/primitives';
import { useTitlePopover } from './ui/overlays';
import { ButtonRow, Note, StatusCard, StatusLine, TitlePopover, minutesLeft, shortLeft } from './ui/title-popover';
import {
  CAFFEINATE_MINUTES,
  CAFFEINATE_NOTICE_TEXT,
  CAFFEINATE_STOP_TEXT,
  LID_SUPPORT_TEXT,
  type CaffeinateState,
} from '../shared/caffeinate';

type Action = Parameters<typeof window.sb.caffeinateAction>[0];
const INFO = ['Ends when the time is up or Switchboard quits', 'With the lid open it needs no password.'];

export function Caffeinate() {
  const [state, setState] = useState<CaffeinateState | null>(null);
  const [duration, setDuration] = useState<Duration>({ choice: '60', custom: 90 });
  const [lid, setLid] = useState(false);
  const [, setTick] = useState(0);
  const initialized = useRef(false);
  const pop = useTitlePopover(() => void window.sb.refreshCaffeinate().catch(() => {}));
  const { open } = pop;

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

  // Keeps the countdown current, in the title bar too while the popover is
  // closed, and notices the helper being allowed in Login Items.
  const timed = state?.endsAt != null;
  useEffect(() => {
    if (!open && !timed) return;
    const timer = setInterval(
      () => {
        setTick((n) => n + 1);
        if (open && state?.queued) void window.sb.refreshCaffeinate().catch(() => {});
      },
      open ? 5_000 : 15_000,
    );
    return () => clearInterval(timer);
  }, [open, timed, state?.queued]);

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
        <Note tone="warn">{CAFFEINATE_NOTICE_TEXT['needs-approval']}</Note>
        <ButtonRow>
          <Btn variant="secondary" onClick={run('cancel')}>
            Cancel
          </Btn>
          <Btn variant="primary" onClick={run('login-items')}>
            Open Login Items
          </Btn>
        </ButtonRow>
      </>
    );
  } else if (state && active) {
    body = (
      <>
        <StatusCard tone="run" title="Caffeinated" left={left} limit={state.limit}>
          {state.lid
            ? 'The Mac and its screen stay awake, even with the lid closed.'
            : 'The Mac and its screen stay awake.'}
        </StatusCard>
        <ButtonRow>
          {left !== null ? (
            <Btn id="caffeinate-extend" variant="secondary" disabled={busy} onClick={run('extend')}>
              +1 hour
            </Btn>
          ) : null}
          <Btn id="caffeinate-stop" variant="primary" disabled={busy} onClick={run('stop')}>
            Decaf now
          </Btn>
        </ButtonRow>
      </>
    );
  } else if (state) {
    let start = minutes ? `Caffeinate for ${durationWords(minutes)}` : 'Caffeinate until I stop';
    if (busy) start = 'Starting…';
    body = (
      <>
        <StatusLine tone="idle">Decaf: the Mac sleeps as usual</StatusLine>
        {state.sleepDisabledElsewhere ? (
          <Note
            tone="warn"
            action={
              <Btn variant="secondary" disabled={busy} onClick={run('clear')}>
                Turn sleep on
              </Btn>
            }
          >
            Sleep is turned off system-wide outside Caffeinate.
          </Note>
        ) : null}
        {state.stop ? <Note onDismiss={run('dismiss')}>Ended because {CAFFEINATE_STOP_TEXT[state.stop]}.</Note> : null}
        {state.notice ? (
          <Note tone="warn" id="caffeinate-notice" alert>
            {CAFFEINATE_NOTICE_TEXT[state.notice]}
          </Note>
        ) : null}
        <DurationPicker
          label="Stay awake for"
          presets={CAFFEINATE_MINUTES}
          value={duration}
          disabled={busy}
          onChange={setDuration}
        />
        <div class="pop-options">
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
          onClick={(e) => act(() => window.sb.startCaffeinate(minutes, lid && lidAvailable), e.currentTarget)}
        >
          {start}
        </Btn>
      </>
    );
  }

  return (
    <TitlePopover
      id="caffeinate"
      pop={pop}
      icon={active ? 'coffee' : 'cup'}
      label={label}
      tone={active ? 'run' : null}
      tip={active ? 'The Mac is being kept awake' : 'Keep the Mac awake for a while'}
      title="Caffeinate"
      info={INFO}
      hidden={!state}
      busy={busy}
    >
      {body}
    </TitlePopover>
  );
}
