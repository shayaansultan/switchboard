// The Proxy buckets tab: a panel per bucket with its state and actions in the
// header, then one row per account in the pool, laid out like a profile row.

import { act, providerLabel, type BucketAccount, type BucketView, type State } from './lib';
import { BucketNotes } from './profiles';
import { Badge, Bar, Btn, Icon, Panel, StatusPill, Switch, TipBtn } from './ui/primitives';
import { useOverlays } from './ui/overlays';
import { useActions } from './ui/actions';

export function Buckets({ state }: { state: State }) {
  const { newBucket } = useActions();
  const buckets = state.buckets ?? [];
  return (
    <>
      <div class="toolbar">
        <span class="note">
          A bucket picks the account with the most headroom for each request. Assign one from a Codex profile's menu.
        </span>
        <Btn variant="secondary" icon="plus" id="add-bucket" onClick={newBucket}>
          Proxy bucket
        </Btn>
      </div>
      {state.bucketsError ? <p class="note">{state.bucketsError}</p> : null}
      {buckets.length ? (
        buckets.map((b) => <BucketPanel bucket={b} state={state} key={b.id} />)
      ) : (
        <div class="empty">No proxy buckets yet</div>
      )}
    </>
  );
}

function BucketPanel({ bucket, state }: { bucket: BucketView; state: State }) {
  const { openMenu } = useOverlays();
  const users = state.profiles.filter((p) => p.proxyBucket === bucket.id);
  const running = bucket.status === 'running';
  const n = bucket.accounts.length;
  const meta = [
    `${n} account${n === 1 ? '' : 's'}`,
    users.length ? `used by ${users.map((p) => p.name).join(', ')}` : 'no profile assigned',
  ].join(' · ');
  const actions = (
    <>
      <Btn
        icon="plus"
        aria-label="Add account"
        onClick={(e) =>
          openMenu(e.currentTarget as HTMLElement, [
            { label: 'Add ChatGPT account', run: () => window.sb.bucketAction(bucket.id, 'login', 'codex') },
            { label: 'Add Claude account', run: () => window.sb.bucketAction(bucket.id, 'login', 'claude') },
          ])
        }
      >
        Account
        <Icon name="chevron" size={14} />
      </Btn>
      {running ? (
        <TipBtn
          variant="icon"
          icon="refresh"
          aria-label="Refresh bucket"
          tip={['Refresh this bucket']}
          onClick={(e) => act(() => window.sb.bucketAction(bucket.id, 'refresh'), e.currentTarget)}
        />
      ) : (
        <Btn
          variant="primary"
          icon="play"
          aria-label="Start bucket"
          onClick={(e) => act(() => window.sb.bucketAction(bucket.id, 'start'), e.currentTarget)}
        >
          Start
        </Btn>
      )}
      {bucket.status === 'stopped' ? null : (
        <Btn
          variant="outline"
          class="danger"
          icon="stop"
          aria-label="Stop bucket"
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
      <TipBtn
        variant="icon"
        icon="more"
        aria-label={`More actions for ${bucket.name}`}
        tip={['More']}
        onClick={(e) =>
          openMenu(e.currentTarget as HTMLElement, [
            { label: 'Delete bucket…', danger: true, run: () => act(() => window.sb.removeBucket(bucket.id)) },
          ])
        }
      />
    </>
  );
  return (
    <Panel
      data-bucket={bucket.id}
      title={bucket.name}
      status={<StatusPill on={running}>{bucket.status[0].toUpperCase() + bucket.status.slice(1)}</StatusPill>}
      meta={meta}
      actions={actions}
    >
      {bucket.accounts.map((account) => (
        <AccountRow
          bucket={bucket}
          account={account}
          remaining={state.settings.usageMode === 'remaining'}
          key={account.name}
        />
      ))}
      <BucketNotes bucket={bucket} />
    </Panel>
  );
}

// An account in the pool: who, then whether it takes traffic, which is a
// state rather than an action, so a switch and not a button. Signing it out
// of the pool is rare and destructive, so it sits behind the menu.
function AccountRow({
  bucket,
  account,
  remaining,
}: {
  bucket: BucketView;
  account: BucketAccount;
  remaining: boolean;
}) {
  const { openMenu } = useOverlays();
  const off = account.status === 'disabled';
  const name = account.email ?? account.name;
  return (
    <div class={`card acct ${off ? 'off' : ''}`}>
      <div class="who">
        <div class="head">
          <span class="name" title={name}>
            {name}
          </span>
          {account.plan?.name ? <Badge>{account.plan.name}</Badge> : null}
          {account.status === 'fresh' ? null : <Badge tone="mute">{account.status}</Badge>}
        </div>
        <div class="ident">{providerLabel(account)}</div>
      </div>
      <div class="bars">
        {account.windows.map((w) => (
          <Bar w={w} stale={account.status !== 'fresh'} remaining={remaining} key={w.label} />
        ))}
      </div>
      <div class="foot">
        <label class="toggle">
          <Switch
            small
            checked={!off}
            label={`Take traffic from ${name}`}
            onChange={(on) => act(() => window.sb.setBucketAccount(bucket.id, account.name, on))}
          />
          <span>{off ? 'Paused' : 'Takes traffic'}</span>
        </label>
        <TipBtn
          variant="icon"
          icon="more"
          class="acct-more"
          aria-label={`More actions for ${name}`}
          tip={['More']}
          onClick={(e) =>
            openMenu(e.currentTarget as HTMLElement, [
              {
                label: 'Remove account…',
                danger: true,
                run: () => act(() => window.sb.removeBucketAccount(bucket.id, account.name)),
              },
            ])
          }
        />
      </div>
    </div>
  );
}
