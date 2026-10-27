// Fans: the title-bar button and its popover, built from the title-popover
// pieces. A boost is an action, not a mode: nothing changes until Boost is
// pressed, and while one runs the popover turns into a countdown with Stop. The helper ends a boost on its
// own (time up, sleep, restart, Switchboard quitting, serious heat), and the
// popover says why. Speeds are only read while the popover is open.

import { useEffect, useRef, useState } from 'preact/hooks';
import { act } from './lib';
import { Btn, DurationPicker, durationMinutes, durationWords, type Duration } from './ui/primitives';
import { useTitlePopover } from './ui/overlays';
import {
  ButtonRow,
  Note,
  PopSection,
  StatusCard,
  StatusLine,
  TitlePopover,
  minutesLeft,
  shortLeft,
} from './ui/title-popover';
import { FAN_MINUTES, NOTICE_TEXT, STOP_TEXT, type FanState } from '../shared/fans';

const POLL_MS = 2_000;
const FANS_TIP = [
  'A boost always ends on its own',
  'When the time is up, on sleep or restart,',
  'if Switchboard quits, or in serious heat.',
  'The first boost asks once to allow a helper in Login Items.',
];
type Ready = Extract<FanState, { status: 'ready' }>;
type FanAction = Parameters<typeof window.sb.fanAction>[0];

function FanList({ fans }: { fans: Ready['fans'] }) {
  return (
    <ul class="fans-list" aria-label="Fan speeds">
      {fans.map((fan, i) => {
        const share = (fan.actual - fan.minimum) / Math.max(1, fan.maximum - fan.minimum);
        return (
          <li key={i}>
            <span>{fans.length === 1 ? 'Fan' : `Fan ${i + 1}`}</span>
            <span class="fans-track" aria-hidden="true">
              <span style={{ width: `${Math.round(Math.min(1, Math.max(0.03, share)) * 100)}%` }} />
            </span>
            <span class="fans-rpm">{fan.actual.toLocaleString('en-US')} rpm</span>
          </li>
        );
      })}
    </ul>
  );
}

function Speed({
  value,
  disabled,
  onInput,
  onCommit,
}: {
  value: number;
  disabled: boolean;
  onInput: (level: number) => void;
  onCommit?: (level: number) => void;
}) {
  return (
    <div class="fans-speed">
      <label for="fans-level">Speed</label>
      <output for="fans-level">{value}%</output>
      <input
        id="fans-level"
        type="range"
        min={0}
        max={100}
        step={5}
        value={value}
        disabled={disabled}
        onInput={(e) => onInput(Number(e.currentTarget.value))}
        onChange={(e) => onCommit?.(Number(e.currentTarget.value))}
      />
    </div>
  );
}

export function FanControl() {
  const [state, setState] = useState<FanState>({ status: 'checking' });
  const [draft, setDraft] = useState(75);
  const [duration, setDuration] = useState<Duration>({ choice: '15', custom: 45 });
  // Re-renders the countdown while the popover is open; the time itself is
  // read at render, so a fresh boost never shows a stale minute.
  const [, setTick] = useState(0);
  const initialized = useRef(false);
  const pop = useTitlePopover(() => void window.sb.refreshFans().catch(() => {}));
  const { open } = pop;

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
  }, []);

  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => {
      setTick((n) => n + 1);
      void window.sb.refreshFans().catch(() => {});
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [open]);

  const ready = state.status === 'ready' ? state : null;
  const held = ready?.level ?? null;
  useEffect(() => {
    if (held !== null) setDraft(held);
  }, [held]);

  const busy = ready?.busy ?? false;
  const minutes = durationMinutes(duration);
  const left = ready?.endsAt != null ? minutesLeft(ready.endsAt) : null;
  const label = held === null ? 'Fans' : `Fans · ${held}%${left !== null ? ` · ${shortLeft(left)}` : ''}`;
  const run = (action: FanAction) => (e: Event) => act(() => window.sb.fanAction(action), e.currentTarget);

  let body = null;
  if (ready?.queued && ready.notice === 'needs-approval') {
    body = (
      <>
        <Note tone="warn">{NOTICE_TEXT['needs-approval']}</Note>
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
  } else if (ready && held !== null) {
    body = (
      <>
        <StatusCard tone="warm" title={`Boosting at ${held}%`} left={left} limit={ready.limit} />
        <Speed
          value={draft}
          disabled={busy}
          onInput={setDraft}
          onCommit={(level) => void act(() => window.sb.adjustFans(level))}
        />
        <ButtonRow>
          {left !== null ? (
            <Btn id="fans-extend" variant="secondary" disabled={busy} onClick={run('extend')}>
              +15 min
            </Btn>
          ) : null}
          <Btn id="fans-stop" variant="primary" disabled={busy} onClick={run('system')}>
            Stop boost
          </Btn>
        </ButtonRow>
      </>
    );
  } else if (ready) {
    const foreign = ready.notice === 'already-controlled';
    let start = minutes ? `Boost for ${durationWords(minutes)}` : 'Boost until I stop';
    if (ready.helper !== 'installed') start = 'Set up and boost';
    if (ready.notice === 'control-failed') start = 'Try again';
    if (busy) start = 'Starting boost…';
    body = (
      <>
        <StatusLine tone={foreign ? 'warn' : 'on'}>
          {foreign ? 'Another app is controlling the fans' : 'macOS is controlling the fans'}
        </StatusLine>
        {ready.stop ? <Note onDismiss={run('dismiss')}>Boost ended because {STOP_TEXT[ready.stop]}.</Note> : null}
        {ready.notice ? (
          <Note tone={ready.notice === 'control-failed' ? 'bad' : 'warn'} id="fans-notice" alert>
            {NOTICE_TEXT[ready.notice]}
          </Note>
        ) : null}
        <PopSection id="fans-boost-heading" title="Boost">
          <Speed value={draft} disabled={busy || foreign} onInput={setDraft} />
          <DurationPicker
            label="Boost for"
            presets={FAN_MINUTES}
            value={duration}
            disabled={busy || foreign}
            onChange={setDuration}
          />
          <ButtonRow>
            {foreign ? (
              <Btn variant="secondary" onClick={(e) => act(() => window.sb.refreshFans(), e.currentTarget)}>
                Check again
              </Btn>
            ) : null}
            <Btn
              id="fans-boost"
              variant="primary"
              disabled={busy || foreign}
              onClick={(e) => act(() => window.sb.setFans(draft, minutes), e.currentTarget)}
            >
              {start}
            </Btn>
          </ButtonRow>
        </PopSection>
      </>
    );
  }

  return (
    <TitlePopover
      id="fans"
      pop={pop}
      icon="fan"
      label={label}
      tone={held !== null ? 'warm' : null}
      tip={held === null ? 'Boost the fans' : `Fans boosted to ${held}%`}
      title="Fans"
      info={FANS_TIP}
      meta={ready?.temperature != null ? `CPU ${Math.round(ready.temperature)} °C` : null}
      hidden={!ready}
      busy={busy}
    >
      {body}
      {ready ? <FanList fans={ready.fans} /> : null}
    </TitlePopover>
  );
}
