// The window. Everything renders from one State snapshot pushed by the main
// process through `window.sb`; the rest is which tab is open, which view the
// accounts use, and which dialog is up. The Usage tab fetches its own report,
// and is told through `usageVersion` when there is a newer one.

import { useEffect, useState } from 'preact/hooks';
import { Profiles } from './profiles';
import { KeepAwake } from './awake';
import { Buckets } from './buckets';
import { Cli } from './cli';
import { Usage } from './usage';
import { AddDialog, BucketDialog, SettingsDialog, type SetupRequest } from './dialogs';
import { act, type ProfilesView, type ProfileView, type State, type Vendor } from './lib';
import { ActionsCtx } from './ui/actions';
import { OverlayProvider, useOverlays } from './ui/overlays';
import { Icon, TipBtn, type IconName } from './ui/primitives';

type Tab = 'profiles' | 'usage' | 'buckets' | 'cli';

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [usageVersion, setUsageVersion] = useState(0);
  useEffect(() => {
    window.sb.onState(setState);
    window.sb.onUsageChanged(() => setUsageVersion((v) => v + 1));
    // A refresh can finish (and push state) before this initial fetch
    // resolves; never let the older snapshot overwrite the newer one.
    window.sb.getState().then((s) => setState((have) => have ?? s));
    // Keep "resets in" countdowns fresh.
    const tick = setInterval(() => setState((s) => (s ? { ...s } : s)), 60000);
    return () => clearInterval(tick);
  }, []);
  return (
    <OverlayProvider>
      <Shell state={state} usageVersion={usageVersion} />
    </OverlayProvider>
  );
}

function Shell({ state, usageVersion }: { state: State | null; usageVersion: number }) {
  const { closeMenu, hideTip } = useOverlays();
  const [tab, setTabState] = useState<Tab>('profiles');
  const [setup, setSetup] = useState<SetupRequest>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bucketOpen, setBucketOpen] = useState(false);
  const setTab = (t: Tab) => {
    closeMenu();
    hideTip();
    setTabState(t);
  };
  const view: ProfilesView = state?.settings.view ?? 'list';
  const setView = (v: ProfilesView) => void act(() => window.sb.saveSettings({ view: v }));
  const openSetup = (target?: ProfileView, vendor?: Vendor) => setSetup({ target: target ?? null, vendor });
  const newBucket = () => {
    setTab('buckets');
    setBucketOpen(true);
  };

  // The title bar holds only what applies to the whole app; a new profile
  // or bucket is made from the tab that lists them.
  return (
    <ActionsCtx.Provider value={{ openSetup, newBucket }}>
      <header class="titlebar">
        <div class="brand">Switchboard</div>
        <div class="actions">
          <KeepAwake />
          <TipBtn
            variant="icon"
            icon="refresh"
            id="refresh"
            class="outline"
            aria-label="Refresh usage"
            tip={['Refresh usage']}
            onClick={(e) => act(() => window.sb.refresh(), e.currentTarget)}
          />
          <TipBtn
            variant="icon"
            icon="sliders"
            id="settings"
            aria-label="Settings"
            tip={['Settings']}
            onClick={() => setSettingsOpen(true)}
          />
        </div>
      </header>
      <nav class="tabs" role="tablist" aria-label="Sections">
        <TabButton
          id="tab-profiles"
          icon="users"
          on={tab === 'profiles'}
          onClick={() => setTab('profiles')}
          count={state?.profiles.length}
        >
          Profiles
        </TabButton>
        <TabButton id="tab-usage" icon="chart" on={tab === 'usage'} onClick={() => setTab('usage')}>
          Usage
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
        {!state ? null : tab === 'profiles' ? (
          <Profiles state={state} view={view} setView={setView} />
        ) : tab === 'usage' ? (
          <Usage state={state} version={usageVersion} />
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
