// The Phone tab: phone access in one place. Turn it on, then three steps in
// one column: Tailscale on this Mac, publishing on the tailnet (a button that
// runs `tailscale serve`, with the command for anyone who wants to run it
// themselves), and pairing a phone by its QR code, shown in that step. The
// checks are real: the tab asks the main process every few seconds, which
// probes the hub on this Mac and at its tailnet address. Once all three are
// done the steps fold into one status line, with the setup a click away.
//
// Below that, running apps the phone can only watch, because they were
// opened from the Dock or before phone access was on, with a Relaunch for
// each, the opt-in for Default Claude opened from the Dock
// (src/remote/reach.ts), and the paired phones.
//
// The same operations are `switchboard remote ...` in the CLI.

import qrcode from 'qrcode-generator';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { PhonePairing, PhonePublish, PhoneStatus } from '../types';
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

// A live pairing code: the QR that opens the phone app with it filled in,
// and the code itself for typing.
function PairCode({ pairing, now, onCancel }: { pairing: PhonePairing; now: number; onCancel: () => void }) {
  return (
    <div class="pair-inline">
      {pairing.url ? <Qr text={pairing.url} /> : null}
      <span class="hint">
        {pairing.url ? 'Scan with the phone camera, or enter this code in the app' : 'Enter this code in the phone app'}
      </span>
      <span class="pair-code">{pairing.code}</span>
      <span class="hint">Works once, for the next {minutesLeft(pairing.expiresAt, now)}</span>
      <Btn variant="secondary" onClick={onCancel}>
        Cancel
      </Btn>
    </div>
  );
}

export function PhoneTab({ state }: { state: State }) {
  const on = !!state.settings.phoneAccess;
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [pairing, setPairing] = useState<PhonePairing | null>(null);
  const [now, setNow] = useState(Date.now());
  // The last Publish, until the address answers.
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState<PhonePublish | null>(null);
  // The finished setup, opened again from its status line.
  const [showSetup, setShowSetup] = useState(false);
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
  const done = on && !!status?.tailnet && reachable && devices > 0;
  const startPair = () =>
    void act(async () => {
      setDevicesAtPair(devices);
      setPairing(await window.sb.pairPhone());
    });
  // The button stays busy itself: publishing can wait on Tailscale for a while.
  const publish = async () => {
    setPublishing(true);
    try {
      setPublished(await window.sb.publishPhone());
    } catch (error) {
      setPublished({ published: false, enableUrl: null, error: (error as Error).message });
    } finally {
      setPublishing(false);
    }
    // The address can take a few seconds to answer; the step ticks itself.
    void load();
  };
  const pairButton = (label: string) => (
    <Btn variant="primary" id="pair-phone" disabled={!status?.listening} onClick={startPair}>
      {label}
    </Btn>
  );

  return (
    <section class="phone-tab">
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
          {done && !showSetup ? null : (
            <p class="cli-intro">
              See what every profile is working on from your phone. Switchboard serves a small app on this Mac, and
              Tailscale makes it reachable from your devices only.
            </p>
          )}
          {on && status?.error ? <Note tone="warn">{status.error}</Note> : null}
          {on && status && done && !showSetup ? (
            <div class="phone-summary">
              <span>
                Reachable at <b>{status.url}</b> · {devices === 1 ? '1 phone paired' : `${devices} phones paired`}
              </span>
              <span class="phone-actions">
                {pairing ? null : pairButton('Pair another phone')}
                <Btn variant="ghost" onClick={() => setShowSetup(true)}>
                  Show setup
                </Btn>
              </span>
              {pairing ? <PairCode pairing={pairing} now={now} onCancel={() => setPairing(null)} /> : null}
            </div>
          ) : null}
          {on && status && (!done || showSetup) ? (
            <ol class="phone-steps">
              <Step done={!!status.tailnet} title={status.tailnet ? 'Tailscale is connected' : 'Connect Tailscale'}>
                <span class="hint">
                  {status.tailnet
                    ? `This Mac is ${status.tailnet.split('.')[0]} on your tailnet.`
                    : 'Install Tailscale from the Mac App Store and sign in, then install it on your phone with the same account.'}
                </span>
              </Step>
              <Step done={reachable} title={reachable ? 'Published on your tailnet' : 'Publish it on your tailnet'}>
                {reachable ? (
                  <span class="hint">{status.url}</span>
                ) : (
                  <>
                    <span class="hint">
                      Gives this Mac an address your phone can open. Only devices signed in to your tailnet can reach
                      it.
                    </span>
                    {published?.enableUrl ? (
                      <Note tone="warn">
                        Tailscale opened a page to allow Serve on your tailnet. Allow it there, then press Publish
                        again.
                      </Note>
                    ) : published?.error ? (
                      <Note tone="warn">{published.error}</Note>
                    ) : published?.published ? (
                      <span class="hint">Published. Waiting for the address to answer…</span>
                    ) : null}
                    <span class="phone-actions">
                      <Btn
                        variant="primary"
                        id="publish"
                        disabled={!status.tailnet || publishing}
                        onClick={() => void publish()}
                      >
                        {publishing ? 'Publishing…' : 'Publish'}
                      </Btn>
                    </span>
                    <details class="phone-manual">
                      <summary>Or run it in Terminal yourself</summary>
                      <span class="phone-command">
                        <code>{status.serve}</code>
                        <CopyButton text={status.serve} title="Copy command" />
                      </span>
                    </details>
                  </>
                )}
              </Step>
              <Step done={devices > 0} title={devices > 0 ? 'A phone is paired' : 'Pair a phone'}>
                {pairing ? (
                  <PairCode pairing={pairing} now={now} onCancel={() => setPairing(null)} />
                ) : (
                  <>
                    <span class="hint">
                      {devices > 0
                        ? 'Pair another the same way.'
                        : 'Shows a QR code that opens the phone app with the code filled in.'}
                    </span>
                    <span class="phone-actions">
                      {pairButton(devices > 0 ? 'Pair another phone' : 'Show pairing code')}
                    </span>
                    {status.listening && !reachable ? (
                      <span class="hint">The phone won't reach this Mac until it is published on your tailnet.</span>
                    ) : null}
                  </>
                )}
              </Step>
              {done ? (
                <li class="phone-steps-close">
                  <Btn variant="ghost" onClick={() => setShowSetup(false)}>
                    Hide setup
                  </Btn>
                </li>
              ) : null}
            </ol>
          ) : null}
        </div>
      </Panel>

      {on && status ? (
        <Panel title="Desktop apps">
          <div class="phone-body">
            {status.unreachable.length ? (
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
            ) : (
              <p class="hint">Every running app takes replies and approvals from the phone.</p>
            )}
            <div class="phone-default-claude">
              <span class="phone-name">
                <b>Default Claude from the Dock</b>
                <span class="hint">
                  Adds Switchboard's plugin to ~/.claude/settings.json, so Default Claude takes replies and approvals
                  however you open it, while Switchboard runs. Turning this off, or quitting Switchboard, takes exactly
                  that back out.
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
          </div>
        </Panel>
      ) : null}

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
    </section>
  );
}
