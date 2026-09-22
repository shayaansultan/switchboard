// The Proxy buckets tab: a card per bucket with its state and actions, then
// one line per account in the pool.

import { act, providerLabel, type BucketAccount, type BucketView, type State } from './lib';
import { BucketNotes } from './accounts';
import { Bar, Btn, Icon } from './ui/primitives';
import { useOverlays } from './ui/overlays';

export function Buckets({ state }: { state: State }) {
  const buckets = state.buckets ?? [];
  return (
    <section class="bucket-list">
      <p class="hint">
        Shared model capacity for Codex desktop and OpenCode, behind a local proxy. Assign a bucket from the connection
        menu on a Codex account.
      </p>
      {state.bucketsError ? <p class="note">{state.bucketsError}</p> : null}
      {buckets.length ? (
        buckets.map((b) => <BucketPanel bucket={b} state={state} key={b.id} />)
      ) : (
        <div class="empty">No proxy buckets yet</div>
      )}
    </section>
  );
}

function BucketPanel({ bucket, state }: { bucket: BucketView; state: State }) {
  const { openMenu } = useOverlays();
  const users = state.profiles.filter((p) => p.proxyBucket === bucket.id);
  const running = bucket.status === 'running';
  return (
    <div class="bucket" data-bucket={bucket.id}>
      <div class="bucket-head">
        <span class="name">{bucket.name}</span>
        <span class={`status ${running ? 'on' : ''}`}>{bucket.status}</span>
        <span class="used-by">
          {users.length
            ? `Used by ${users.map((p) => `${state.vendors[p.vendor].label} ${p.name}`).join(', ')}`
            : 'No desktop profiles assigned'}
        </span>
        <div class="buttons">
          <Btn
            onClick={(e) =>
              openMenu(e.currentTarget as HTMLElement, [
                { label: 'Add ChatGPT account', run: () => window.sb.bucketAction(bucket.id, 'login', 'codex') },
                { label: 'Add Claude account', run: () => window.sb.bucketAction(bucket.id, 'login', 'claude') },
              ])
            }
          >
            Add account
            <Icon name="chevron" size={14} />
          </Btn>
          {running ? (
            <Btn
              variant="icon"
              icon="refresh"
              aria-label="Refresh bucket"
              title="Refresh bucket"
              onClick={(e) => act(() => window.sb.bucketAction(bucket.id, 'refresh'), e.currentTarget)}
            />
          ) : (
            <Btn
              variant="primary"
              onClick={(e) => act(() => window.sb.bucketAction(bucket.id, 'start'), e.currentTarget)}
            >
              Start bucket
            </Btn>
          )}
          {bucket.status === 'stopped' ? null : (
            <Btn
              variant="ghost"
              onClick={(e) =>
                act(async () => {
                  if (confirm(`Stop ${bucket.name}? This interrupts model requests from every app using this bucket.`))
                    await window.sb.bucketAction(bucket.id, 'stop');
                }, e.currentTarget)
              }
            >
              Stop
            </Btn>
          )}
        </div>
      </div>
      <div class="bucket-body">
        {bucket.accounts.map((account) => (
          <AccountRow
            bucket={bucket}
            account={account}
            remaining={state.settings.usageMode === 'remaining'}
            key={account.name}
          />
        ))}
        <BucketNotes bucket={bucket} />
      </div>
    </div>
  );
}

function AccountRow({
  bucket,
  account,
  remaining,
}: {
  bucket: BucketView;
  account: BucketAccount;
  remaining: boolean;
}) {
  const off = account.status === 'disabled';
  return (
    <div class={`acct ${off ? 'off' : ''}`}>
      <span class="who" title={account.email ?? account.name}>
        <span class="prov">{[providerLabel(account), account.plan?.name].filter(Boolean).join(' ')} </span>
        {account.email ?? account.name}
        {account.status !== 'fresh' ? <span class="prov"> · {account.status}</span> : null}
      </span>
      <div class="acct-windows">
        {account.windows.map((w) => (
          <Bar w={w} stale={account.status !== 'fresh'} remaining={remaining} key={w.label} />
        ))}
      </div>
      <Btn
        variant="ghost"
        onClick={(e) => act(() => window.sb.setBucketAccount(bucket.id, account.name, off), e.currentTarget)}
      >
        {off ? 'Enable' : 'Disable'}
      </Btn>
    </div>
  );
}
