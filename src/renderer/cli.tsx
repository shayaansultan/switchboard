// The CLI tab: whether the `switchboard` command is installed, a button to
// install it, and the commands worth knowing, each with a copy button.

import { useState } from 'preact/hooks';
import { act, type CliStatus, type State } from './lib';
import { Badge, Btn, Icon, Note } from './ui/primitives';

const COMMANDS: { cmd: string; what: string }[] = [
  { cmd: 'switchboard list --human', what: 'Every profile, with its running state and signed-in account.' },
  { cmd: 'switchboard pick claude', what: 'Which Claude account has the most room right now, and why.' },
  { cmd: 'switchboard usage --refresh', what: 'Fresh rate-limit numbers for every profile.' },
  { cmd: 'switchboard exec claude/work -- claude', what: 'Run a command inside the Work profile.' },
  { cmd: 'eval "$(switchboard env claude/work)"', what: 'Move the current shell into a profile.' },
  { cmd: 'switchboard launch codex/client', what: 'Open a profile’s desktop window.' },
  { cmd: 'switchboard bucket list', what: 'Each proxy bucket and the headroom of every account in it.' },
  { cmd: 'switchboard doctor', what: 'Installed apps, CLIs, proxy, store and cache health.' },
];

export function Cli({ state }: { state: State }) {
  const cli = state.cli;
  return (
    <section class="cli">
      <InstallCard cli={cli} />
      <div class="panel">
        <div class="panel-head">
          <span>Commands</span>
          <span class="na">Results are JSON unless --human, so agents can use them too.</span>
        </div>
        <div class="panel-body">
          {COMMANDS.map((c) => (
            <Command key={c.cmd} cmd={c.cmd} what={c.what} />
          ))}
        </div>
      </div>
    </section>
  );
}

function InstallCard({ cli }: { cli: CliStatus | undefined }) {
  const [busy, setBusy] = useState(false);
  if (!cli) {
    return (
      <div class="panel cli-install">
        <Note>Checking for the command…</Note>
      </div>
    );
  }
  const install = () =>
    act(async () => {
      setBusy(true);
      try {
        await window.sb.installCli();
      } finally {
        setBusy(false);
      }
    });
  return (
    <div class="panel cli-install">
      <div class="cli-icon">
        <Icon name="code" size={22} />
      </div>
      <div class="cli-about">
        <div class="cli-title">
          <b>The switchboard command</b>
          {cli.installed && cli.ours ? <Badge tone="ok">Installed</Badge> : null}
          {cli.installed && !cli.ours ? <Badge tone="mute">Another launcher</Badge> : null}
        </div>
        {cli.installed && cli.ours ? (
          <span class="note">
            Runs on the app’s own runtime from <code>{cli.file}</code>, so it is always the same version as the app.
          </span>
        ) : cli.installed ? (
          <span class="note">
            <code>{cli.file}</code> exists but was not written by this app. Remove it, then install again, or leave it
            if you put it there.
          </span>
        ) : (
          <span class="note">
            Everything the window can do, from a terminal or an agent. Installs a tiny launcher at{' '}
            <code>{cli.file}</code>. Nothing else is written.
          </span>
        )}
        {cli.installed && cli.ours && !cli.onPath ? (
          <Note tone="warn">
            <code>~/.local/bin</code> is not on your PATH. Add <code>export PATH="$HOME/.local/bin:$PATH"</code> to your
            shell profile, then open a new terminal.
          </Note>
        ) : null}
        {!cli.appInstalled ? (
          <Note>Install Switchboard into /Applications first; the launcher points at the installed app.</Note>
        ) : null}
      </div>
      <div class="cli-action">
        {cli.installed && cli.ours ? null : (
          <Btn variant="primary" disabled={busy || cli.installed} onClick={install}>
            Install command
          </Btn>
        )}
      </div>
    </div>
  );
}

function Command({ cmd, what }: { cmd: string; what: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div class="cmd">
      <div class="cmd-about">
        <code>{cmd}</code>
        <span class="note">{what}</span>
      </div>
      <Btn
        variant="icon"
        class={`copy-btn ${copied ? 'copied' : ''}`}
        aria-label={`Copy: ${cmd}`}
        title="Copy"
        onClick={() => {
          void navigator.clipboard.writeText(cmd);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        <Icon name="copy" />
        <Icon name="check" />
      </Btn>
    </div>
  );
}
