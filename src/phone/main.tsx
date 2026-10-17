// The phone app: what every Claude and Codex profile on one Mac is doing,
// served by that Mac's Switchboard (src/remote/hub.ts) over Tailscale.
//
// React with TanStack Query and the hub's typed tRPC API (data.ts). The
// inbox, accounts and settings share a tab bar; a session and its files open
// over it. Until the hub knows this phone, the pairing screen shows instead.
//
// Read-only for now: answering and approving arrive with the in-app taps.

import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TabBar } from './components/bits';
import { isUnpaired, makeClients, TRPCProvider, useOverview, useRoute, useTRPC } from './data';
import { applyTheme, getPrefs, setPrefs, TEXT_SIZE, usePrefs } from './prefs';
import { Accounts } from './screens/Accounts';
import { Files } from './screens/Files';
import { Inbox } from './screens/Inbox';
import { Pair } from './screens/Pair';
import { Session } from './screens/Session';
import { Settings } from './screens/Settings';

function Paired() {
  const route = useRoute();
  const { overview, link } = useOverview();
  const needs = overview?.sessions.filter((s) => s.state === 'needs-you').length ?? 0;
  useEffect(() => {
    scrollTo(0, 0);
  }, [route.name]);
  if (route.name === 'session')
    return <Session profileId={route.profileId} sessionId={route.sessionId} overview={overview} />;
  if (route.name === 'files')
    return <Files profileId={route.profileId} sessionId={route.sessionId} overview={overview} />;
  return (
    <div className="flex min-h-dvh flex-col">
      <div className="flex-1">
        {route.name === 'accounts' ? (
          <Accounts overview={overview} />
        ) : route.name === 'settings' ? (
          <Settings overview={overview} link={link} />
        ) : (
          <Inbox overview={overview} link={link} />
        )}
      </div>
      <TabBar route={route.name} needs={needs} />
    </div>
  );
}

function App() {
  const trpc = useTRPC();
  const prefs = usePrefs();
  const me = useQuery(trpc.me.queryOptions(undefined, { retry: (n, e) => !isUnpaired(e) && n < 2 }));
  useEffect(() => {
    document.documentElement.style.fontSize = TEXT_SIZE[prefs.text];
  }, [prefs.text]);
  useEffect(() => applyTheme(prefs.theme), [prefs.theme]);
  // Remember when the app was put away, for "since you left".
  useEffect(() => {
    const away = () => {
      if (document.visibilityState === 'hidden') setPrefs({ lastSeen: Date.now() });
    };
    document.addEventListener('visibilitychange', away);
    return () => document.removeEventListener('visibilitychange', away);
  }, []);
  if (me.isPending)
    return <main className="grid min-h-dvh place-items-center text-muted-foreground">Connecting to your Mac…</main>;
  if (me.isError && isUnpaired(me.error)) return <Pair />;
  if (me.isError)
    return (
      <main className="px-gutter grid min-h-dvh place-items-center text-center text-muted-foreground">
        Can't reach your Mac. Check that Tailscale is on and Switchboard is running.
      </main>
    );
  return <Paired />;
}

function Root() {
  const [clients] = useState(makeClients);
  return (
    <QueryClientProvider client={clients.queryClient}>
      <TRPCProvider trpcClient={clients.trpcClient} queryClient={clients.queryClient}>
        <App />
      </TRPCProvider>
    </QueryClientProvider>
  );
}

// Before the first paint, so a pinned theme never flashes the other one.
applyTheme(getPrefs().theme);
if ('serviceWorker' in navigator) void navigator.serviceWorker.register('sw.js').catch(() => {});
createRoot(document.getElementById('app') as HTMLElement).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
