// The notifications part of Settings. Turning them on asks iOS for
// permission, subscribes this phone's service worker with the Mac's public
// key, and hands the subscription to the Mac, which sends from then on
// (src/remote/push.ts). Which kinds this phone hears about are kept on the
// Mac, beside the subscription, because the Mac decides when to send.
//
// iOS only lets a web app add notifications once it is on the Home Screen,
// and only from a tap, so the button is the only way in.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { PushPrefs } from '../../remote/push';
import { Button } from '../components/ui/button';
import { Switch } from '../components/ui/switch';
import { SectionTitle } from '../components/bits';
import { useTRPC } from '../data';

const KINDS: [keyof PushPrefs, string, string][] = [
  ['needs', 'Needs you', 'A question or an approval is waiting'],
  ['finished', 'Long sessions finishing', 'After five minutes or more of work'],
  ['errored', 'Errors', 'A session stopped with an error'],
  ['limits', 'Usage running low', 'A profile passes 90% of a window'],
];

// The applicationServerKey PushManager wants, from the base64url the Mac sends.
function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  const padded = (key + '='.repeat((4 - (key.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const standalone = () =>
  matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
const ios = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

function Group({ children }: { children: React.ReactNode }) {
  return <div className="overflow-hidden rounded-2xl border border-border bg-card">{children}</div>;
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-2 border-b border-border px-3.5 py-3 last:border-b-0">{children}</div>;
}

export function NotificationSettings() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const state = useQuery(trpc.push.state.queryOptions());
  const [local, setLocal] = useState<PushSubscription | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.push.state.queryKey() });

  // Whether this browser still holds its subscription: iOS drops it when
  // notifications are turned off in Settings, or the app is removed.
  useEffect(() => {
    if (!supported()) return setLocal(null);
    void navigator.serviceWorker.ready
      .then((r) => r.pushManager.getSubscription())
      .then(setLocal)
      .catch(() => setLocal(null));
  }, [state.data?.on]);

  const subscribe = useMutation(trpc.push.subscribe.mutationOptions({ onSuccess: refresh }));
  const unsubscribe = useMutation(trpc.push.unsubscribe.mutationOptions({ onSuccess: refresh }));
  const prefs = useMutation(trpc.push.prefs.mutationOptions({ onSuccess: refresh }));
  const test = useMutation(trpc.push.test.mutationOptions());

  async function turnOn() {
    setError(null);
    try {
      if ((await Notification.requestPermission()) !== 'granted') {
        setError(
          ios()
            ? 'Notifications are blocked. Allow them for Switchboard in iOS Settings, then try again.'
            : "Notifications are blocked. Allow them for this site in the browser's settings, then try again.",
        );
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const key = state.data?.key ?? '';
      const sub =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }));
      const json = sub.toJSON();
      await subscribe.mutateAsync({
        subscription: {
          endpoint: sub.endpoint,
          keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
        },
      });
      setLocal(sub);
    } catch (e) {
      setError(`Could not turn notifications on: ${(e as Error).message}`);
    }
  }

  async function turnOff() {
    setError(null);
    try {
      await local?.unsubscribe();
    } catch {
      // Gone already; the Mac forgets it either way.
    }
    setLocal(null);
    await unsubscribe.mutateAsync();
  }

  const on = !!state.data?.on && !!local;
  let blocked: string | null = null;
  if (!supported())
    blocked =
      ios() && !standalone()
        ? 'Add Switchboard to your Home Screen to get notifications.'
        : "This browser can't show notifications.";
  else if (ios() && !standalone()) blocked = 'Open Switchboard from your Home Screen to turn notifications on.';
  else if (Notification.permission === 'denied')
    blocked = ios()
      ? 'Notifications are blocked. Allow them for Switchboard in iOS Settings.'
      : "Notifications are blocked. Allow them for this site in the browser's settings.";

  return (
    <section className="flex flex-col gap-2">
      <SectionTitle>Notifications</SectionTitle>
      <Group>
        {blocked ? (
          <Row>
            <span className="text-sm text-subtle">{blocked}</span>
          </Row>
        ) : !on ? (
          <Row>
            <span className="text-sm text-subtle">
              Hear from this Mac when a session needs you or finishes, while the Mac is awake.
            </span>
            <Button onClick={() => void turnOn()} disabled={!state.data || subscribe.isPending}>
              {subscribe.isPending ? 'Turning on…' : 'Turn on notifications'}
            </Button>
          </Row>
        ) : (
          <>
            {KINDS.map(([kind, label, hint]) => (
              <Row key={kind}>
                <label className="flex items-center justify-between gap-3">
                  <span className="flex flex-col">
                    <span className="font-medium">{label}</span>
                    <span className="text-xs text-muted-foreground">{hint}</span>
                  </span>
                  <Switch
                    checked={state.data!.prefs[kind]}
                    disabled={prefs.isPending}
                    onCheckedChange={(v) => prefs.mutate({ ...state.data!.prefs, [kind]: v })}
                    aria-label={label}
                  />
                </label>
              </Row>
            ))}
            <Row>
              <span className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => test.mutate()} disabled={test.isPending}>
                  {test.isPending
                    ? 'Sending…'
                    : test.data
                      ? test.data.sent
                        ? 'Sent'
                        : 'Not delivered'
                      : 'Send a test'}
                </Button>
                <Button variant="outline" className="flex-1" onClick={() => void turnOff()}>
                  Turn off
                </Button>
              </span>
            </Row>
          </>
        )}
      </Group>
      {error ? <p className="m-0 text-xs text-bad-text">{error}</p> : null}
    </section>
  );
}
