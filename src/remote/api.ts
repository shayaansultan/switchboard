// The hub's API: a tRPC router the phone app calls with end-to-end types.
// Everything but pairing needs a paired device. The device token lives in an
// HttpOnly cookie the hub sets when pairing succeeds, so no script in the
// page can read it, and the browser sends it with every request and with the
// live-updates stream (EventSource cannot send headers). Scripts and tests
// may send it as a bearer header instead.
//
// `reply` and `decide` reach the desktop apps through the control socket
// (control.ts); `push` turns this phone's notifications on and off and says
// which kinds it wants (push.ts).
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
import type { Vendor } from '../types';
import type { Control } from './control';
import type { Overview } from './hub';
import { pushState, PushPrefs, publicKey, push, setPrefs, Subscription, subscribe, unsubscribe } from './push';
import { authenticate, pair, revoke, type DeviceView } from './pairing';
import type { Transcript } from './model';

export const COOKIE = 'sb_device';
// Chrome caps cookie lifetimes at 400 days; unpairing ends it sooner.
const COOKIE_MAX_AGE = 400 * 24 * 3600;

export interface ApiContext {
  device: DeviceView | null;
  setCookie(value: string | null): void;
}

export function tokenFrom(req: http.IncomingMessage): string | null {
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
  // Absent when the hub runs without its control socket.
  control?: Control;
  vendorOf?(profileId: string): Vendor | null;
  // A phone turned notifications on or off.
  notificationsChanged?(): void;
}

// A control error as the phone reads it.
function controlError(error: unknown): never {
  const message = (error as Error).message;
  const code = message === 'no-such-request' || message === 'not-reachable' ? 'NOT_FOUND' : 'BAD_REQUEST';
  throw new TRPCError({ code, message });
}

// What the phone should hear about; generatedAt always differs.
const fingerprint = (o: Overview): string =>
  JSON.stringify({ p: o.profiles, s: o.sessions, q: o.pending, r: o.reachable });

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
      unsubscribe(ctx.device.id);
      deps.notificationsChanged?.();
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

    // Types a reply into the session, as if at the Mac.
    reply: paired
      .input(
        z.object({
          profileId: z.string().min(1).max(200),
          sessionId: z.string().min(1).max(200),
          text: z.string().trim().min(1).max(20_000),
        }),
      )
      .mutation(({ input }) => {
        const vendor = deps.vendorOf?.(input.profileId);
        if (!deps.control || !vendor) throw new TRPCError({ code: 'NOT_FOUND', message: 'not-reachable' });
        try {
          deps.control.reply(vendor, input.profileId, input.sessionId, input.text);
        } catch (error) {
          controlError(error);
        }
        return { sent: true };
      }),

    // Answers a request waiting on the person: an approval or a question.
    decide: paired
      .input(
        z.object({
          id: z.string().min(1).max(100),
          choice: z.string().max(100).optional(),
          answers: z.record(z.string().max(2000), z.array(z.string().max(2000)).max(20)).optional(),
          // An MCP form's fields, by id.
          form: z
            .record(
              z.string().max(200),
              z.union([z.string().max(5000), z.number(), z.boolean(), z.array(z.string().max(500)).max(50)]),
            )
            .optional(),
        }),
      )
      .mutation(({ input }) => {
        if (!deps.control) throw new TRPCError({ code: 'NOT_FOUND', message: 'no-such-request' });
        try {
          deps.control.decide(
            input.id,
            input.answers ? { answers: input.answers } : { choice: input.choice ?? '', form: input.form },
          );
        } catch (error) {
          controlError(error);
        }
        return { decided: true };
      }),

    push: t.router({
      state: paired.query(({ ctx }) => ({ key: publicKey(), ...pushState(ctx.device.id) })),
      subscribe: paired
        .input(z.object({ subscription: Subscription, prefs: PushPrefs.optional() }))
        .mutation(({ ctx, input }) => {
          subscribe(ctx.device.id, input.subscription, input.prefs);
          deps.notificationsChanged?.();
          return pushState(ctx.device.id);
        }),
      prefs: paired.input(PushPrefs).mutation(({ ctx, input }) => {
        if (!setPrefs(ctx.device.id, input)) throw new TRPCError({ code: 'NOT_FOUND', message: 'not-subscribed' });
        return pushState(ctx.device.id);
      }),
      unsubscribe: paired.mutation(({ ctx }) => {
        unsubscribe(ctx.device.id);
        deps.notificationsChanged?.();
        return pushState(ctx.device.id);
      }),
      // A notification to this phone alone, to show the setup works.
      test: paired.mutation(async ({ ctx }) => {
        const sent = await push(
          {
            kind: 'needs',
            title: 'Switchboard',
            body: 'Notifications from this Mac reach this phone.',
            tag: 'test',
            url: '#/settings',
          },
          { deviceId: ctx.device.id },
        );
        return { sent: sent > 0 };
      }),
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
