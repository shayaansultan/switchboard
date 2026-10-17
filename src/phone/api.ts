// The phone's typed client for the hub's tRPC API (src/remote/api.ts).
// Subscriptions go over server-sent events, everything else is batched into
// one request where it can be. Both are same-origin, so the browser sends the
// HttpOnly device cookie the hub set at pairing; no token is kept in the page.

import { createTRPCClient, httpBatchLink, httpSubscriptionLink, splitLink, TRPCClientError } from '@trpc/client';
import type { ApiRouter } from '../remote/api';

const url = '/api/trpc';

export const api = createTRPCClient<ApiRouter>({
  links: [
    splitLink({
      condition: (op) => op.type === 'subscription',
      true: httpSubscriptionLink({ url }),
      false: httpBatchLink({ url }),
    }),
  ],
});

// This phone is not (or no longer) paired: show the pairing screen.
export function isUnpaired(error: unknown): boolean {
  return error instanceof TRPCClientError && (error.data as { code?: string } | undefined)?.code === 'UNAUTHORIZED';
}

// A pairing failure's reason, as the hub names it.
export function pairingError(error: unknown): 'code-expired' | 'code-wrong' | 'unreachable' {
  if (error instanceof TRPCClientError && (error.message === 'code-expired' || error.message === 'code-wrong'))
    return error.message;
  return 'unreachable';
}
