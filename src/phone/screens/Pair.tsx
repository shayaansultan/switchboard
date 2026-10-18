// Pairing: trade the one-time code shown on the Mac for this phone's device
// cookie. A link from the Mac's QR code carries the code after #pair=.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { useState } from 'react';
import { Button } from '../components/ui/button';
import { useTRPC } from '../data';

const MESSAGES: Record<string, string> = {
  'code-expired': 'That code has expired, or was already used. Make a new one on your Mac.',
  'code-wrong': "That code doesn't match. Check it on your Mac and try again.",
};

export function Pair() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [code, setCode] = useState(() => /^#pair=([A-Za-z0-9-]+)$/.exec(location.hash)?.[1] ?? '');
  const [name, setName] = useState(() => (/iPad/.test(navigator.userAgent) ? 'iPad' : 'iPhone'));
  const pair = useMutation(
    trpc.pair.mutationOptions({
      onSuccess: async () => {
        history.replaceState(null, '', location.pathname);
        await queryClient.invalidateQueries();
      },
    }),
  );
  const error = pair.error
    ? (MESSAGES[pair.error instanceof TRPCClientError ? pair.error.message : ''] ??
      "Can't reach your Mac. Check that Tailscale is on, on both devices.")
    : null;

  return (
    <main className="px-gutter pt-safe flex min-h-dvh flex-col justify-center gap-5 pb-10">
      <h1 className="m-0 font-serif text-[40px] leading-none font-medium">Switchboard</h1>
      <p className="m-0 text-subtle">See what your Claude and Codex profiles are working on, from here.</p>
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          pair.mutate({ code, name });
        }}
      >
        <label htmlFor="code" className="mt-1.5 text-[13px] text-muted-foreground">
          Pairing code
        </label>
        <input
          id="code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="ABCD-EFGH"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          required
          className="rounded-xl border border-border bg-card px-3.5 py-3 font-mono text-lg tracking-[0.12em]"
        />
        <label htmlFor="name" className="mt-1.5 text-[13px] text-muted-foreground">
          Name this device
        </label>
        <input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded-xl border border-border bg-card px-3.5 py-3 text-lg"
        />
        {error ? <p className="m-0 text-sm text-bad-text">{error}</p> : null}
        <Button type="submit" className="mt-2.5" disabled={pair.isPending || !code.trim()}>
          {pair.isPending ? 'Pairing…' : 'Pair'}
        </Button>
      </form>
      <p className="m-0 text-sm text-muted-foreground">
        On your Mac, open Switchboard's Phone tab and scan the code, or run{' '}
        <code className="font-mono text-[13px]">switchboard remote pair</code>.
      </p>
    </main>
  );
}
