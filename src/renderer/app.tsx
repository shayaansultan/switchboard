// The window. Everything renders from one State snapshot pushed by the main
// process through `window.sb`; the rest is which tab is open, which view the
// accounts use, and which dialog is up.

import { useEffect, useState } from 'preact/hooks';
import { Accounts } from './accounts';
import { KeepAwake } from './awake';
import { Buckets } from './buckets';
import { Cli } from './cli';
import { AddDialog, BucketDialog, SettingsDialog, type SetupRequest } from './dialogs';
import { act, type AccountsView, type ProfileView, type State } from './lib';
import { ActionsCtx } from './ui/actions';
import { OverlayProvider, useOverlays } from './ui/overlays';
import { Btn, Icon, type IconName } from './ui/primitives';

type Tab = 'accounts' | 'buckets' | 'cli';

export function App() {
  const [state, setState] = useState<State | null>(null);
  useEffect(() => {
    window.sb.onState(setState);
    // A refresh can finish (and push state) before this initial fetch
    // resolves; never let the older snapshot overwrite the newer one.
    window.sb.getState().then((s) => setState((have) => have ?? s));
    // Keep "resets in" countdowns fresh.
    const tick = setInterval(() => setState((s) => (s ? { ...s } : s)), 60000);
    return () => clearInterval(tick);
  }, []);
  return (
    <OverlayProvider>
      <Shell state={state} />
    </OverlayProvider>
  );
}

function Shell({ state }: { state: State | null }) {
  const { closeMenu, hideTip } = useOverlays();
  const [tab, setTabState] = useState<Tab>('accounts');
  const [setup, setSetup] = useState<SetupRequest>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bucketOpen, setBucketOpen] = useState(false);
  const setTab = (t: Tab) => {
    closeMenu();
    hideTip();
    setTabState(t);
  };
  const view: AccountsView = state?.settings.view ?? 'list';
  const setView = (v: AccountsView) => void act(() => window.sb.saveSettings({ view: v }));
  const openSetup = (target?: ProfileView) => setSetup({ target: target ?? null });

  return (
    <ActionsCtx.Provider value={{ openSetup }}>
      <header class="titlebar">
        <div class="brand">Switchboard</div>
        <div class="actions">
          <KeepAwake />
          <Btn
            variant="icon"
            icon="refresh"
            id="refresh"
            class="outline"
            title="Refresh usage"
            aria-label="Refresh usage"
            onClick={(e) => act(() => window.sb.refresh(), e.currentTarget)}
          />
          {tab === 'accounts' ? (
            <Btn variant="secondary" icon="plus" id="add" onClick={() => openSetup()}>
              <span class="lbl">Profile</span>
            </Btn>
          ) : null}
          {tab === 'buckets' ? (
            <Btn variant="secondary" icon="plus" id="add-bucket" onClick={() => setBucketOpen(true)}>
              <span class="lbl">Proxy bucket</span>
            </Btn>
          ) : null}
          <Btn
            variant="icon"
            icon="sliders"
            id="settings"
            title="Settings"
            aria-label="Settings"
            onClick={() => setSettingsOpen(true)}
          />
        </div>
      </header>
      <nav class="tabs" role="tablist" aria-label="Sections">
        <TabButton
          id="tab-accounts"
          icon="users"
          on={tab === 'accounts'}
          onClick={() => setTab('accounts')}
          count={state?.profiles.length}
        >
          Accounts
        </TabButton>
        <TabButton
          id="tab-buckets"
          icon="layers"
          on={tab === 'buckets'}
          onClick={() => setTab('buckets')}
          count={state ? (state.buckets ?? []).length : undefined}
        >
          Proxy buckets
        </TabButton>
        <TabButton id="tab-cli" icon="terminal" on={tab === 'cli'} onClick={() => setTab('cli')}>
          CLI
        </TabButton>
      </nav>
      <main id="root" role="tabpanel">
        {!state ? null : tab === 'accounts' ? (
          <Accounts state={state} view={view} setView={setView} />
        ) : tab === 'buckets' ? (
          <Buckets state={state} />
        ) : (
          <Cli state={state} />
        )}
      </main>
      {state ? (
        <>
          <AddDialog state={state} request={setup} onClose={() => setSetup(null)} />
          <SettingsDialog state={state} open={settingsOpen} onClose={() => setSettingsOpen(false)} />
          <BucketDialog open={bucketOpen} onClose={() => setBucketOpen(false)} />
        </>
      ) : null}
    </ActionsCtx.Provider>
  );
}

function TabButton({
  id,
  icon,
  on,
  onClick,
  count,
  children,
}: {
  id: string;
  icon: IconName;
  on: boolean;
  onClick: () => void;
  count?: number;
  children: string;
}) {
  return (
    <button type="button" id={id} role="tab" aria-selected={on} aria-controls="root" onClick={onClick}>
      <Icon name={icon} size={15} />
      {children} {count === undefined ? null : <span class="count">{count}</span>}
    </button>
  );
}
