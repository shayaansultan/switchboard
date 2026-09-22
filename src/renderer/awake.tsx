// Keep awake: the title-bar button and its popover. Its state comes from the
// dedicated awake channel; a full app snapshot only seeds it, since a late
// snapshot can carry an older value than a push that already arrived.

import { useEffect, useRef, useState } from 'preact/hooks';
import { Btn, Icon } from './ui/primitives';

type AwakeState = import('../awake').AwakeState;
type AwakeValue = import('../awake').AwakeValue;
type AwakeNotice = import('../awake').AwakeNotice;
type AwakeRefresh = import('../awake').AwakeRefresh;

const noticeText: Record<AwakeNotice, string> = {
  cancelled: 'Authorization cancelled. The current macOS setting is shown above.',
  'write-failed': 'macOS could not change the setting. You can try again.',
  'timed-out': 'Authorization timed out. Check the macOS prompt, then check the setting again.',
  'not-applied': 'macOS did not apply the change. The current setting is shown above.',
};

export function KeepAwake() {
  const [state, setState] = useState<AwakeState>({ status: 'checking' });
  const [pending, setPending] = useState(false);
  const [transportError, setTransportError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const initialized = useRef(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);

  const refresh = async (reason: AwakeRefresh = 'observe') => {
    try {
      await window.sb.refreshAwake(reason);
      // Successful IPC can return an unchanged value without a state event.
      // Clear any earlier transport error on the response itself as well.
      setTransportError(false);
    } catch {
      setTransportError(true);
    }
  };

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
    window.sb.onAwakeState((s) => {
      initialized.current = true;
      setTransportError(false);
      setState(s);
    });
    window.sb
      .getState()
      .then((s) => {
        if (initialized.current) return;
        initialized.current = true;
        setState(s.awake);
      })
      .catch(() => setTransportError(true));
    const pop = popover.current;
    if (!pop) return;
    const onBefore = (event: Event) => {
      if (event instanceof ToggleEvent) setExpanded(event.newState === 'open');
    };
    const onToggle = () => {
      if (pop.matches(':popover-open')) {
        position();
        void refresh();
      }
    };
    pop.addEventListener('beforetoggle', onBefore);
    pop.addEventListener('toggle', onToggle);
    window.addEventListener('resize', position);
    return () => {
      pop.removeEventListener('beforetoggle', onBefore);
      pop.removeEventListener('toggle', onToggle);
      window.removeEventListener('resize', position);
    };
  }, []);
  useEffect(() => {
    if (popover.current?.matches(':popover-open')) position();
  });

  const on = state.status === 'ready' && state.value === 'on';
  const unknown = state.status === 'unavailable';
  const label =
    state.status === 'changing' ? 'Keep awake · …' : on ? 'Awake' : unknown ? 'Keep awake · ?' : 'Keep awake';
  const title = on ? 'System sleep is disabled' : unknown ? 'Could not read the sleep setting' : 'Keep this Mac awake';

  let status = '';
  let changeLabel = '';
  let target: AwakeValue | null = null;
  let changeDisabled = pending;
  switch (state.status) {
    case 'checking':
      status = 'Checking macOS…';
      changeLabel = 'Checking…';
      changeDisabled = true;
      break;
    case 'ready':
      status = on ? 'On · System sleep is disabled' : 'Off · Normal sleep behavior';
      changeLabel = on ? 'Turn off' : 'Turn on';
      target = on ? 'off' : 'on';
      break;
    case 'changing':
      status = 'Waiting for macOS authorization and checking the result…';
      changeLabel = state.target === 'on' ? 'Turning on…' : 'Turning off…';
      changeDisabled = true;
      break;
    case 'unavailable':
      status =
        state.lastKnown === null
          ? 'Could not read the macOS sleep setting.'
          : `Could not read the current setting. Last checked: ${state.lastKnown}.`;
      // Recovery stays available even if readback fails. Never offer an
      // optimistic "Turn on" when the actual value is unknown.
      changeLabel = 'Turn off';
      target = 'off';
      break;
  }
  const notice = state.status === 'ready' && state.notice ? noticeText[state.notice] : null;
  const showRetry = unknown || (state.status === 'ready' && state.notice !== null);

  const change = async () => {
    if (target === null || pending) return;
    const value = target;
    setPending(true);
    setTransportError(false);
    try {
      await window.sb.setAwake(value);
    } catch {
      setTransportError(true);
    } finally {
      setPending(false);
      // An unchanged readback is not broadcast again, so read once more.
      await refresh();
    }
  };

  return (
    <>
      <button
        type="button"
        id="awake-toggle"
        ref={toggle}
        class={`ghost ${on ? 'is-awake' : ''} ${unknown ? 'needs-attention' : ''}`}
        popovertarget="awake-popover"
        aria-haspopup="dialog"
        aria-expanded={expanded}
        title={title}
      >
        <Icon name={on ? 'sun' : 'moon'} />
        <span class="lbl">{label}</span>
        <Icon name="chevron" size={14} class="chev" />
      </button>
      <div id="awake-popover" popover="auto" role="dialog" aria-labelledby="awake-heading" ref={popover}>
        <div class="awake-heading-row">
          <h2 id="awake-heading">Keep awake</h2>
          <button
            type="button"
            popovertarget="awake-popover"
            popovertargetaction="hide"
            aria-label="Close keep awake"
            class="awake-close"
          >
            ×
          </button>
        </div>
        <p id="awake-status" role="status" aria-live="polite">
          {status}
        </p>
        <p class="hint">Stays on if Switchboard closes or crashes. Reopen it to turn this off.</p>
        <p id="awake-notice" role="status" hidden={!notice}>
          {notice ?? ''}
        </p>
        <p id="awake-error" role="alert" hidden={!transportError}>
          Could not contact Switchboard. Close and reopen the window to try again.
        </p>
        <div class="awake-buttons">
          <Btn
            id="awake-retry"
            variant="secondary"
            hidden={!showRetry}
            disabled={pending}
            onClick={() => void refresh('recheck')}
          >
            Check again
          </Btn>
          <Btn id="awake-change" variant="primary" disabled={changeDisabled} onClick={() => void change()}>
            {changeLabel}
          </Btn>
        </div>
      </div>
    </>
  );
}
