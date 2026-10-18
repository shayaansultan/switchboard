// The Phone tab: phone access in one place. Turn it on, see what is still
// needed before a phone can reach this Mac (Tailscale, `tailscale serve`, a
// paired phone), pair a phone by scanning a QR code, and unpair one. The
// checks are real: the tab asks the main process every few seconds, which
// probes the hub on this Mac and at its tailnet address.
//
// It also names running apps the phone can only watch, because they were
// opened from the Dock or before phone access was on, with a Relaunch for
// each, and holds the opt-in for Default Claude opened from the Dock
// (src/remote/reach.ts).
//
// The same operations are `switchboard remote ...` in the CLI.

import qrcode from 'qrcode-generator';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { PhonePairing, PhoneStatus } from '../types';
import { CopyButton } from './cli';
import { act, ago, type State } from './lib';
import { Badge, Btn, Note, Panel, Switch } from './ui/primitives';

const CHECK_MS = 5000;

// The QR code as one SVG path of its dark modules.
function Qr({ text }: { text: string }) {
  const { size, d } = useMemo(() => {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    const n = q.getModuleCount();
    let path = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) path += `M${c} ${r}h1v1h-1z`;
    return { size: n, d: path };
  }, [text]);
  return (
    <svg class="qr" viewBox={`-4 -4 ${size + 8} ${size + 8}`} role="img" aria-label="Pairing QR code">
      <rect x="-4" y="-4" width={size + 8} height={size + 8} fill="var(--qr-light)" />
      <path d={d} fill="var(--qr-dark)" shape-rendering="crispEdges" />
    </svg>
  );
}

function Step({ done, title, children }: { done: boolean; title: string; children?: preact.ComponentChildren }) {
  return (
    <li class={`phone-step ${done ? 'done' : ''}`}>
      <span class="mark" aria-hidden="true">
        {done ? '✓' : ''}
      </span>
      <div>
        <b>{title}</b>
        {children}
      </div>
    </li>
  );
}

function minutesLeft(iso: string, now: number): string {
  const m = Math.max(0, Math.round((Date.parse(iso) - now) / 60000));
  return m <= 1 ? 'about a minute' : `${m} minutes`;
}

export function PhoneTab({ state }: { state: State }) {
  const on = !!state.settings.phoneAccess;
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [pairing, setPairing] = useState<PhonePairing | null>(null);
  const [now, setNow] = useState(Date.now());
  const load = () =>
    window.sb
      .phoneStatus()
      .then(setStatus)
      .catch(() => {});

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      void load();
      setNow(Date.now());
    }, CHECK_MS);
    return () => clearInterval(t);
  }, [on]);

  // A code is single use: once a phone more than before is paired, hide it.
  const devices = status?.devices.length ?? 0;
  const [devicesAtPair, setDevicesAtPair] = useState(0);
  useEffect(() => {
    if (pairing && devices > devicesAtPair) setPairing(null);
    if (pairing && Date.parse(pairing.expiresAt) <= now) setPairing(null);
  }, [devices, now]);

  const reachable = !!status?.published;
  const startPair = () =>
    void act(async () => {
      setDevicesAtPair(devices);
      setPairing(await window.sb.pairPhone());
    });

  return (
    <section class="phone-tab">
      <div class="phone-main">
        <Panel
          title="Phone access"
          status={
            status ? (
              !on ? (
                <Badge tone="mute">Off</Badge>
              ) : reachable ? (
                <Badge tone="ok">Reachable</Badge>
              ) : status.listening ? (
                <Badge tone="warn">Not on your tailnet yet</Badge>
              ) : (
                <Badge tone="warn">Not running</Badge>
              )
            ) : null
          }
          actions={
            <Switch
              name="phoneAccess"
              checked={on}
              label="Phone access"
              onChange={(v) => void act(() => window.sb.saveSettings({ phoneAccess: v }))}
            />
          }
        >
          <div class="phone-body">
            <p class="cli-intro">
              See what every profile is working on from your phone. Switchboard serves a small app on this Mac, and
              Tailscale makes it reachable from your devices only.
            </p>
            {on && status?.error ? <Note tone="warn">{status.error}</Note> : null}
            {on && status ? (
              <ol class="phone-steps">
                <Step done={!!status.tailnet} title={status.tailnet ? 'Tailscale is connected' : 'Connect Tailscale'}>
                  <span class="hint">
                    {status.tailnet
                      ? `This Mac is ${status.tailnet.split('.')[0]} on your tailnet.`
                      : 'Open Tailscale on this Mac and sign in, then install it on your phone with the same account.'}
                  </span>
                </Step>
                <Step done={reachable} title={reachable ? 'Published on your tailnet' : 'Publish it on your tailnet'}>
                  {reachable ? (
                    <span class="hint">{status.url}</span>
                  ) : (
                    <>
                      <span class="hint">
                        Run this once in Terminal. If Tailscale asks you to enable Serve or HTTPS for your tailnet,
                        follow its link and run it again.
                      </span>
                      <span class="phone-command">
                        <code>{status.serve}</code>
                        <CopyButton text={status.serve} title="Copy command" />
                      </span>
                    </>
                  )}
                </Step>
                <Step done={devices > 0} title={devices > 0 ? 'A phone is paired' : 'Pair a phone'}>
                  <span class="hint">
                    {devices > 0
                      ? 'Pair more from the panel on the right.'
                      : 'Show a pairing code and scan it with the phone.'}
                  </span>
                </Step>
              </ol>
            ) : null}
            {on && status?.unreachable.length ? (
              <div class="phone-reach">
                <b>The phone can only watch these apps</b>
                <span class="hint">
                  They were opened from the Dock or before phone access was on. Relaunching quits the app, so anything
                  it is running stops, and opens it again ready for replies and approvals.
                </span>
                <ul class="phones">
                  {status.unreachable.map((u) => (
                    <li key={u.id}>
                      <span class="phone-name">
                        <b>{u.name}</b>
                        <span class="hint">{u.vendor === 'claude' ? 'Claude' : 'ChatGPT'}</span>
                      </span>
                      <Btn
                        variant="secondary"
                        onClick={() =>
                          void act(async () => {
                            await window.sb.relaunchForPhone(u.id);
                            await load();
                          })
                        }
                      >
                        Relaunch
                      </Btn>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {on && status ? (
              <div class="phone-default-claude">
                <span class="phone-name">
                  <b>Default Claude from the Dock</b>
                  <span class="hint">
                    Adds Switchboard's plugin to ~/.claude/settings.json, so Default Claude takes replies and approvals
                    however you open it. Turning this off takes exactly that back out.
                  </span>
                  {status.defaultClaude.error ? <Note tone="warn">{status.defaultClaude.error}</Note> : null}
                </span>
                <Switch
                  name="phoneDefaultClaude"
                  checked={status.defaultClaude.on}
                  label="Default Claude from the Dock"
                  onChange={(v) =>
                    void act(async () => {
                      await window.sb.saveSettings({ phoneDefaultClaude: v });
                      await load();
                    })
                  }
                />
              </div>
            ) : null}
          </div>
        </Panel>

        <Panel title="Paired phones" meta={devices === 1 ? '1 phone' : `${devices} phones`}>
          <div class="phone-body">
            {status?.devices.length ? (
              <ul class="phones">
                {status.devices.map((d) => (
                  <li key={d.id}>
                    <span class="phone-name">
                      <b>{d.name}</b>
                      <span class="hint">{d.lastSeenAt ? `Seen ${ago(d.lastSeenAt)}` : 'Not seen yet'}</span>
                    </span>
                    <Btn
                      variant="secondary"
                      onClick={() =>
                        void act(async () => {
                          await window.sb.unpairPhone(d.id);
                          await load();
                        })
                      }
                    >
                      Unpair
                    </Btn>
                  </li>
                ))}
              </ul>
            ) : (
              <p class="hint">No phones yet.</p>
            )}
            <p class="hint">
              Paired phones see every profile's sessions and transcripts, and can reply and approve in the profiles you
              open from Switchboard while this is on. Unpair one to shut it out at once.
            </p>
          </div>
        </Panel>
      </div>

      <Panel title="Pair a phone" class="phone-pair">
        <div class="phone-body pair-body">
          {pairing ? (
            <>
              {pairing.url ? <Qr text={pairing.url} /> : null}
              <span class="hint">
                {pairing.url
                  ? 'Scan with the phone camera, or enter this code in the app'
                  : 'Enter this code in the phone app'}
              </span>
              <span class="pair-code">{pairing.code}</span>
              <span class="hint">Works once, for the next {minutesLeft(pairing.expiresAt, now)}</span>
              <Btn variant="secondary" onClick={() => setPairing(null)}>
                Cancel
              </Btn>
            </>
          ) : (
            <>
              <span class="hint">
                Shows a QR code that opens the phone app with the code filled in. Tailscale has to be on, on the phone.
              </span>
              <Btn variant="primary" id="pair-phone" disabled={!on || !status?.listening} onClick={startPair}>
                Show pairing code
              </Btn>
              {on && status?.listening && !reachable ? (
                <span class="hint">The phone won't reach this Mac until it is published on your tailnet.</span>
              ) : null}
            </>
          )}
        </div>
      </Panel>
    </section>
  );
}
