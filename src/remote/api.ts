// The hub's API: a tRPC router the phone app calls with end-to-end types.
// Everything but pairing needs a paired device. The device token lives in an
// HttpOnly cookie the hub sets when pairing succeeds, so no script in the
// page can read it, and the browser sends it with every request and with the
// live-updates stream (EventSource cannot send headers). Scripts and tests
// may send it as a bearer header instead.
//
// `live` is a server-sent-events subscription: it sends the overview at once,
// then again whenever something the phone shows has changed. The hub decides
// when to look (file events, plus a timer for app state and usage); this
// only skips sending an overview identical to the last one.

import { on } from 'node:events';
import type { EventEmitter } from 'node:events';
import type * as http from 'node:http';
import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Overview } from './hub';
import { authenticate, pair, revoke, type DeviceView } from './pairing';
import type { Transcript } from './model';

export const COOKIE = 'sb_device';
// Chrome caps cookie lifetimes at 400 days; unpairing ends it sooner.
const COOKIE_MAX_AGE = 400 * 24 * 3600;

export interface ApiContext {
  device: DeviceView | null;
  setCookie(value: string | null): void;
}

function tokenFrom(req: http.IncomingMessage): string | null {
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
  if (bearer) return bearer;
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function createContext({ req, res }: { req: http.IncomingMessage; res: http.ServerResponse }): ApiContext {
  return {
    device: authenticate(tokenFrom(req)),
    setCookie(value) {
      const attrs = 'Path=/; HttpOnly; Secure; SameSite=Strict';
      res.setHeader(
        'set-cookie',
        value === null
          ? `${COOKIE}=; ${attrs}; Max-Age=0`
          : `${COOKIE}=${encodeURIComponent(value)}; ${attrs}; Max-Age=${COOKIE_MAX_AGE}`,
      );
    },
  };
}

const t = initTRPC.context<ApiContext>().create({
  // A ping keeps the stream open through proxies and lets the phone notice a
  // dead connection: it reconnects after 40 s with no message.
  sse: { ping: { enabled: true, intervalMs: 15_000 }, client: { reconnectAfterInactivityMs: 40_000 } },
});

const paired = t.procedure.use(({ ctx, next }) => {
  if (!ctx.device) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'not-paired' });
  return next({ ctx: { ...ctx, device: ctx.device } });
});

export interface ApiDeps {
  overview(): Overview;
  transcript(profileId: string, sessionId: string, before: number | null): Transcript | null;
  // Emits 'change' when the overview may have changed.
  changes: EventEmitter;
}

// What the phone should hear about; generatedAt always differs.
const fingerprint = (o: Overview): string => JSON.stringify({ p: o.profiles, s: o.sessions });

export function createRouter(deps: ApiDeps) {
  return t.router({
    pair: t.procedure
      .input(z.object({ code: z.string().min(1).max(32), name: z.string().max(200).optional() }))
      .mutation(({ input, ctx }) => {
        const result = pair(input.code, input.name ?? 'Phone');
        if (!result.ok)
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: result.reason === 'expired' ? 'code-expired' : 'code-wrong',
          });
        ctx.setCookie(result.token);
        return { device: result.device };
      }),

    me: paired.query(({ ctx }) => ({ device: ctx.device })),

    unpair: paired.mutation(({ ctx }) => {
      revoke(ctx.device.id);
      ctx.setCookie(null);
      return { unpaired: true };
    }),

    overview: paired.query(() => deps.overview()),

    session: paired
      .input(
        z.object({
          profileId: z.string().min(1).max(200),
          sessionId: z.string().min(1).max(200),
          // The `before` of the page after this one; absent for the newest page.
          cursor: z.number().int().positive().nullish(),
        }),
      )
      .query(({ input }) => {
        const transcript = deps.transcript(input.profileId, input.sessionId, input.cursor ?? null);
        if (!transcript) throw new TRPCError({ code: 'NOT_FOUND', message: 'no-such-session' });
        return transcript;
      }),

    live: paired.subscription(async function* ({ signal }) {
      let last = '';
      const next = (): Overview | null => {
        let o: Overview;
        try {
          o = deps.overview();
        } catch {
          // A file vanished mid-read; the next change reads it again.
          return null;
        }
        const print = fingerprint(o);
        if (print === last) return null;
        last = print;
        return o;
      };
      // Listen before the first read, so a change between them is not lost.
      const changes = on(deps.changes, 'change', { signal });
      const first = next();
      if (first) yield first;
      try {
        for await (const _ of changes) {
          const o = next();
          if (o) yield o;
        }
      } catch (error) {
        if ((error as Error).name !== 'AbortError') throw error;
      }
    }),
  });
}

export type ApiRouter = ReturnType<typeof createRouter>;
