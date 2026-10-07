// The usage-reset dialog: what an account has saved, a confirmation that names
// exactly what will be spent, then the vendor's answer beside the refreshed
// bars. Three steps in one <dialog>, so the irreversible step always has a
// screen of its own. The main process keeps the session pinned to the account;
// the window only sees the offers and a token that names them.

import { useEffect, useRef, useState } from 'preact/hooks';
import {
  providerLabel,
  type ResetList,
  type ResetOffer,
  type ResetResult,
  type ResetTarget,
  type State,
  type UsageWindow,
} from './lib';
import { Modal } from './dialogs';
import { Badge, Bar, Btn, Icon } from './ui/primitives';

export function ResetsDialog({
  state,
  target,
  onClose,
}: {
  state: State;
  target: ResetTarget | null;
  onClose: () => void;
}) {
  const [locked, setLocked] = useState(false);
  return (
    <Modal id="resets-dialog" open={!!target} locked={locked} onClose={onClose}>
      {target ? <Resets state={state} target={target} onClose={onClose} setLocked={setLocked} /> : null}
    </Modal>
  );
}

type Step =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'list'; list: ResetList; pick: string | null }
  | { kind: 'confirm'; list: ResetList; offer: ResetOffer; spending: boolean }
  | { kind: 'done'; result: ResetResult | null; message: string };

function Resets({
  state,
  target,
  onClose,
  setLocked,
}: {
  state: State;
  target: ResetTarget;
  onClose: () => void;
  setLocked: (on: boolean) => void;
}) {
  const [step, setStep] = useState<Step>({ kind: 'loading' });
  const token = useRef<string | null>(null);
  const account = accountFor(state, target);
  // The bars as they were when the dialog opened, to show what a reset changed.
  const [before] = useState(() => new Map((account?.windows ?? []).map((w) => [w.label, w.pct])));

  useEffect(() => {
    let live = true;
    window.sb.listResets(target).then(
      (list) => {
        token.current = list.token;
        if (live) setStep({ kind: 'list', list, pick: list.offers.find((o) => o.usable)?.id ?? null });
        else void window.sb.closeResets(list.token);
      },
      (e: Error) => live && setStep({ kind: 'failed', message: e.message || String(e) }),
    );
    return () => {
      live = false;
      if (token.current) void window.sb.closeResets(token.current);
    };
  }, []);

  // Not through act(): a failure here is the vendor's answer and belongs on
  // the dialog's last screen, not in an alert over it.
  const spend = async (list: ResetList, offer: ResetOffer) => {
    setStep({ kind: 'confirm', list, offer, spending: true });
    setLocked(true);
    try {
      const result = await window.sb.redeemReset(list.token, offer.id);
      setStep({ kind: 'done', result, message: result.message });
    } catch (e) {
      setStep({ kind: 'done', result: null, message: (e as Error).message || String(e) });
    } finally {
      token.current = null;
      setLocked(false);
    }
  };

  if (step.kind === 'confirm') {
    const { list, offer, spending } = step;
    return (
      <div class="resets">
        <h2>Use this reset?</h2>
        <div class="rows">
          <Fact label="Account" value={list.account} sub={account?.sub} />
          <Fact label="Reset" value={offer.title} sub={offer.clears} />
          {offer.remaining === null ? null : (
            <Fact
              label="Left afterwards"
              value={`${offer.remaining - 1} of ${offer.remaining}`}
              sub={expiry(offer.expiresAt)}
            />
          )}
        </div>
        <div class="callout warn">
          <Icon name="warn" />
          <span>
            This spends the reset and can’t be undone. It applies in every app signed in to this account. It never buys
            credits or changes your plan.
          </span>
        </div>
        <menu>
          <Btn variant="ghost" disabled={spending} onClick={() => setStep({ kind: 'list', list, pick: offer.id })}>
            Back
          </Btn>
          <span class="spacer" />
          <Btn disabled={spending} onClick={onClose} autoFocus>
            Cancel
          </Btn>
          <Btn variant="primary" disabled={spending} onClick={() => void spend(list, offer)}>
            {spending ? 'Using reset…' : 'Use reset'}
          </Btn>
        </menu>
      </div>
    );
  }

  if (step.kind === 'done') {
    const ok = step.result?.outcome === 'reset';
    return (
      <div class="resets">
        <h2 class="with-mark">
          <span class={`mark-circle ${ok ? 'ok' : 'warn'}`}>
            <Icon name={ok ? 'check' : 'warn'} size={16} />
          </span>
          {ok ? 'Reset confirmed' : 'Reset not confirmed'}
        </h2>
        <p class="lead">{step.message}</p>
        {account ? <Account account={account} state={state} before={before} /> : null}
        <menu>
          <Btn variant="primary" onClick={onClose} autoFocus>
            Done
          </Btn>
        </menu>
      </div>
    );
  }

  const list = step.kind === 'list' ? step.list : null;
  const pick = step.kind === 'list' ? step.pick : null;
  const chosen = list?.offers.find((o) => o.id === pick && o.usable);
  return (
    <div class="resets">
      <h2>Usage resets</h2>
      {account ? (
        <Account account={account} state={state} email={target.kind === 'profile' ? list?.account : undefined} />
      ) : null}
      {step.kind === 'loading' ? (
        <>
          <div class="hint">Checking for saved resets…</div>
          <div class="choice skel-choice" aria-hidden="true">
            <span class="skel" style={{ width: '40%' }} />
            <span class="skel" style={{ width: '70%' }} />
          </div>
        </>
      ) : step.kind === 'failed' ? (
        <div class="callout warn">
          <Icon name="warn" />
          <span>{step.message}</span>
        </div>
      ) : !list?.offers.length ? (
        <div class="empty">No saved resets on this account.</div>
      ) : (
        <div class="offers" role="radiogroup" aria-label="Saved resets">
          {list.offers.map((offer) => (
            <Offer
              key={offer.id}
              offer={offer}
              picked={offer.id === pick}
              onPick={() => setStep({ kind: 'list', list, pick: offer.id })}
            />
          ))}
        </div>
      )}
      {list?.note ? <p class="hint">{list.note}</p> : null}
      <menu>
        <Btn onClick={onClose} autoFocus={!chosen}>
          Close
        </Btn>
        {list?.offers.length ? (
          <Btn
            variant="primary"
            disabled={!chosen}
            onClick={() => chosen && setStep({ kind: 'confirm', list, offer: chosen, spending: false })}
          >
            Use reset…
          </Btn>
        ) : null}
      </menu>
    </div>
  );
}

function Offer({ offer, picked, onPick }: { offer: ResetOffer; picked: boolean; onPick: () => void }) {
  return (
    <label class={`choice ${offer.usable ? '' : 'unusable'}`}>
      <input type="radio" name="reset" checked={picked} disabled={!offer.usable} onChange={onPick} />
      <span class="mark">
        <Icon name="check" size={12} />
      </span>
      <span class="what">
        <b>{offer.title}</b>
        <span>{offer.usable ? offer.clears : offer.reason}</span>
        <span class="chips">
          {offer.remaining === null ? null : <Badge tone="mute">{offer.remaining} left</Badge>}
          <Badge tone="mute">{expiry(offer.expiresAt)}</Badge>
        </span>
      </span>
    </label>
  );
}

function Fact({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div class="srow">
      <span class="key">{label}</span>
      <span class="about">
        <b>{value}</b>
        {sub ? <span>{sub}</span> : null}
      </span>
    </div>
  );
}

// Who the dialog is about, with their live bars. `before` turns the
// percentages into "was, now" once a reset has been spent.
function Account({
  account,
  state,
  email,
  before,
}: {
  account: AccountInfo;
  state: State;
  email?: string;
  before?: Map<string, UsageWindow['pct']>;
}) {
  const remaining = state.settings.usageMode === 'remaining';
  const was = (w: UsageWindow) => {
    const old = before?.get(w.label);
    return old != null && w.pct != null && old !== w.pct ? old : undefined;
  };
  return (
    <div class="reset-account">
      <div class="head">
        {account.color ? <span class="sq" style={{ background: account.color }} /> : null}
        <span class="name">{account.name}</span>
        {account.plan ? <Badge>{account.plan}</Badge> : null}
        <span class="ident">{email ?? account.ident}</span>
      </div>
      {account.windows.length ? (
        <div class={`bars ${before ? 'compare' : ''}`}>
          {account.windows.map((w) => (
            <Bar w={w} remaining={remaining} was={was(w)} key={w.label} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

type AccountInfo = {
  name: string;
  ident: string;
  sub: string;
  plan?: string;
  color?: string;
  windows: UsageWindow[];
};

// The profile or bucket account the dialog is about, read from the live
// state so its bars move when the refresh after a reset lands.
function accountFor(state: State, target: ResetTarget): AccountInfo | null {
  if (target.kind === 'profile') {
    const p = state.profiles.find((x) => x.id === target.id);
    if (!p) return null;
    const plan = p.usage?.plan || p.identity?.plan;
    return {
      name: p.name,
      ident: p.identity?.email ?? '',
      sub: [p.name, state.vendors[p.vendor].label, plan].filter(Boolean).join(' · '),
      plan: plan || undefined,
      color: p.color,
      // A routed profile's bars are its bucket's, not this account's.
      windows: p.proxyBucket ? [] : (p.usage?.windows ?? []),
    };
  }
  const bucket = state.buckets?.find((b) => b.id === target.id);
  const a = bucket?.accounts.find((x) => x.name === target.account);
  if (!bucket || !a) return null;
  const where = `${bucket.name} · ${providerLabel(a)}`;
  return {
    name: a.email ?? a.name,
    ident: where,
    sub: where,
    plan: a.plan?.name,
    windows: a.windows,
  };
}

function expiry(iso: string | null): string {
  if (!iso) return 'No expiry';
  const at = new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return `Expires ${at}`;
}
