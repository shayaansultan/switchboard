type AwakeState = import('../awake').AwakeState;
type AwakeValue = import('../awake').AwakeValue;
type AwakeNotice = import('../awake').AwakeNotice;
type AwakeRefresh = import('../awake').AwakeRefresh;

function awakeElement<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing awake element: ${id}`);
  return node as T;
}

const awakeToggle = awakeElement<HTMLButtonElement>('awake-toggle');
const awakePopover = awakeElement<HTMLDivElement>('awake-popover');
const awakeChange = awakeElement<HTMLButtonElement>('awake-change');
const awakeRetry = awakeElement<HTMLButtonElement>('awake-retry');
let awakeTarget: AwakeValue | null = null;
let awakeRequestPending = false;
let lastAwakeState: AwakeState = { status: 'checking' };
let awakeInitialized = false;

// A full app snapshot can arrive after a newer awake-only push. Use it only
// to initialize; subsequent updates come from the dedicated awake channel.
function initializeAwake(state: AwakeState): void {
  if (awakeInitialized) return;
  awakeInitialized = true;
  renderAwake(state);
}

const awakeNoticeText: Record<AwakeNotice, string> = {
  cancelled: 'Authorization cancelled. The current macOS setting is shown above.',
  'write-failed': 'macOS could not change the setting. You can try again.',
  'timed-out': 'Authorization timed out. Check the macOS prompt, then check the setting again.',
  'not-applied': 'macOS did not apply the change. The current setting is shown above.',
};

function positionAwakePopover(): void {
  const anchor = awakeToggle.getBoundingClientRect();
  const width = awakePopover.offsetWidth;
  awakePopover.style.top = `${anchor.bottom + 8}px`;
  awakePopover.style.left = `${Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8))}px`;
}

awakePopover.addEventListener('beforetoggle', (event) => {
  if (event instanceof ToggleEvent) awakeToggle.setAttribute('aria-expanded', String(event.newState === 'open'));
});
awakePopover.addEventListener('toggle', () => {
  const open = awakePopover.matches(':popover-open');
  if (open) {
    positionAwakePopover();
    void refreshAwake();
  }
});
window.addEventListener('resize', positionAwakePopover);

function renderAwake(state: AwakeState): void {
  lastAwakeState = state;
  const status = awakeElement<HTMLParagraphElement>('awake-status');
  const notice = awakeElement<HTMLParagraphElement>('awake-notice');
  const on = state.status === 'ready' && state.value === 'on';
  const unknown = state.status === 'unavailable';

  awakeToggle.classList.toggle('is-awake', on);
  awakeToggle.classList.toggle('needs-attention', unknown);
  awakeToggle.textContent = on ? '☀ Awake ▾' : unknown ? 'Keep awake · ? ▾' : 'Keep awake ▾';
  awakeToggle.title = on
    ? 'System sleep is disabled'
    : unknown
      ? 'Could not read the sleep setting'
      : 'Keep this Mac awake';
  awakeRetry.hidden = !unknown && !(state.status === 'ready' && state.notice !== null);
  awakeRetry.disabled = awakeRequestPending;
  awakeChange.disabled = awakeRequestPending;
  awakeTarget = null;
  notice.hidden = state.status !== 'ready' || state.notice === null;
  notice.textContent = state.status === 'ready' && state.notice ? awakeNoticeText[state.notice] : '';

  switch (state.status) {
    case 'checking':
      status.textContent = 'Checking macOS…';
      awakeChange.textContent = 'Checking…';
      awakeChange.disabled = true;
      break;
    case 'ready':
      status.textContent = on ? 'On · System sleep is disabled' : 'Off · Normal sleep behavior';
      awakeChange.textContent = on ? 'Turn off' : 'Turn on';
      awakeTarget = on ? 'off' : 'on';
      break;
    case 'changing':
      awakeToggle.textContent = 'Keep awake · …';
      status.textContent = 'Waiting for macOS authorization and checking the result…';
      awakeChange.textContent = state.target === 'on' ? 'Turning on…' : 'Turning off…';
      awakeChange.disabled = true;
      break;
    case 'unavailable':
      status.textContent =
        state.lastKnown === null
          ? 'Could not read the macOS sleep setting.'
          : `Could not read the current setting. Last checked: ${state.lastKnown}.`;
      // Recovery stays available even if readback fails. Never offer an
      // optimistic "Turn on" when the actual value is unknown.
      awakeChange.textContent = 'Turn off';
      awakeTarget = 'off';
      break;
  }

  if (awakePopover.matches(':popover-open')) positionAwakePopover();
}

function awakeRequestError(): void {
  const error = awakeElement<HTMLParagraphElement>('awake-error');
  error.hidden = false;
  error.textContent = 'Could not contact Switchboard. Close and reopen the window to try again.';
}

async function refreshAwake(reason: AwakeRefresh = 'observe'): Promise<void> {
  try {
    await window.sb.refreshAwake(reason);
    // Successful IPC can return an unchanged value without a state event.
    // Clear any earlier transport error on the response itself as well.
    awakeElement<HTMLParagraphElement>('awake-error').hidden = true;
  } catch {
    awakeRequestError();
  }
}

window.sb.onAwakeState((state) => {
  awakeElement<HTMLParagraphElement>('awake-error').hidden = true;
  awakeInitialized = true;
  renderAwake(state);
});
window.sb
  .getState()
  .then((state) => initializeAwake(state.awake))
  .catch(awakeRequestError);
awakeRetry.onclick = () => void refreshAwake('recheck');
awakeChange.onclick = async () => {
  if (awakeTarget === null || awakeRequestPending) return;
  const target = awakeTarget;
  awakeRequestPending = true;
  awakeChange.disabled = true;
  awakeElement<HTMLParagraphElement>('awake-error').hidden = true;
  try {
    await window.sb.setAwake(target);
  } catch {
    awakeRequestError();
  } finally {
    awakeRequestPending = false;
    // An unchanged readback is not broadcast again. Re-enable locally before
    // the fresh read, using the latest state received from the main process.
    renderAwake(lastAwakeState);
    await refreshAwake();
  }
};
