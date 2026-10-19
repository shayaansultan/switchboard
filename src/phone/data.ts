// How the phone talks to the hub (src/remote/api.ts): a tRPC client typed
// from the router, wrapped for TanStack Query so screens read data as
// cached queries. Subscriptions go over server-sent events, everything else
// is batched. Both are same-origin, so the browser sends the HttpOnly device
// cookie set at pairing; the page never holds a token.
//
// The live overview is one query kept current by the `live` subscription,
// which writes each overview it receives into that query's cache.

import { apply } from '../remote/live';
import { QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { createTRPCClient, httpBatchLink, httpSubscriptionLink, splitLink, TRPCClientError } from '@trpc/client';
import { createTRPCContext, useSubscription } from '@trpc/tanstack-react-query';
import { useEffect, useState } from 'react';
import type { ApiRouter } from '../remote/api';
import type { Overview } from '../remote/hub';

export const { TRPCProvider, useTRPC } = createTRPCContext<ApiRouter>();

const url = '/api/trpc';

// This phone is not, or is no longer, paired.
export function isUnpaired(error: unknown): boolean {
  return error instanceof TRPCClientError && (error.data as { code?: string } | undefined)?.code === 'UNAUTHORIZED';
}

export function makeClients() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 5_000, retry: (count, error) => !isUnpaired(error) && count < 3 },
    },
  });
  const trpcClient = createTRPCClient<ApiRouter>({
    links: [
      splitLink({
        condition: (op) => op.type === 'subscription',
        true: httpSubscriptionLink({ url }),
        false: httpBatchLink({ url }),
      }),
    ],
  });
  return { queryClient, trpcClient };
}

export type Link = 'connecting' | 'live' | 'retrying';

// The overview, kept current by the live subscription while the app is open.
export function useOverview(): { overview: Overview | undefined; link: Link; unpaired: boolean } {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const query = useQuery(trpc.overview.queryOptions());
  const sub = useSubscription(
    trpc.live.subscriptionOptions(undefined, {
      // The stream sends the overview once, then what changed (live.ts).
      onData: (m) => queryClient.setQueryData(trpc.overview.queryKey(), (o) => apply(o, m)),
    }),
  );
  const link: Link =
    sub.status === 'pending'
      ? 'live'
      : sub.status === 'connecting' || sub.status === 'error'
        ? 'retrying'
        : 'connecting';
  return { overview: query.data, link, unpaired: isUnpaired(query.error) || isUnpaired(sub.error) };
}

// ---- routes ----
// #/                    inbox          #/accounts, #/settings   the other tabs
// #/s/<profile>/<id>    a session      #/s/<profile>/<id>/files its changed files
// #pair=CODE            the pairing screen with the code filled in

export type Route =
  | { name: 'inbox' }
  | { name: 'accounts' }
  | { name: 'settings' }
  | { name: 'session'; profileId: string; sessionId: string }
  | { name: 'files'; profileId: string; sessionId: string };

export function readRoute(hash = location.hash): Route {
  const s = /^#\/s\/([^/]+)\/([^/]+)(\/files)?$/.exec(hash);
  if (s) {
    const ids = { profileId: decodeURIComponent(s[1]), sessionId: decodeURIComponent(s[2]) };
    return s[3] ? { name: 'files', ...ids } : { name: 'session', ...ids };
  }
  if (hash === '#/accounts') return { name: 'accounts' };
  if (hash === '#/settings') return { name: 'settings' };
  return { name: 'inbox' };
}

export const sessionHref = (profileId: string, sessionId: string, files = false): string =>
  `#/s/${encodeURIComponent(profileId)}/${encodeURIComponent(sessionId)}${files ? '/files' : ''}`;

export function useRoute(): Route {
  const [route, setRoute] = useState(() => readRoute());
  useEffect(() => {
    const on = () => setRoute(readRoute());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
