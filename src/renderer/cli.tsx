// The CLI tab: whether the `switchboard` command is installed, a button to
// install it, and the commands worth knowing, each with a copy button.

import AGENT_PROMPT from '../../skills/switchboard/SKILL.md' with { type: 'text' };
import { useState } from 'preact/hooks';
import { act, type CliStatus, type State } from './lib';
import { Badge, Btn, Icon, Note, Panel, TipBtn } from './ui/primitives';

const COMMANDS: { cmd: string; what: string }[] = [
  { cmd: 'switchboard list --human', what: 'Every profile, with its running state and signed-in account.' },
  { cmd: 'switchboard pick claude', what: 'Which Claude profile has the most room right now, and why.' },
  { cmd: 'switchboard resets claude', what: 'Available reset grants for the native Claude account; spends nothing.' },
  {
    cmd: 'switchboard bucket resets BUCKET ACCOUNT',
    what: 'Available reset grants for one proxy account; spends nothing.',
  },
  { cmd: 'switchboard usage --refresh', what: 'Fresh rate-limit numbers for every profile.' },
  { cmd: 'switchboard exec claude/work -- claude', what: 'Run a command inside the Work profile.' },
  { cmd: 'eval "$(switchboard env claude/work)"', what: 'Move the current shell into a profile.' },
  { cmd: 'switchboard launch codex/client', what: 'Open a profile’s desktop window.' },
  { cmd: 'switchboard bucket list', what: 'Each proxy bucket and the headroom of every account in it.' },
  { cmd: 'switchboard doctor', what: 'Installed apps, CLIs, proxy, store and cache health.' },
];

export function Cli({ state }: { state: State }) {
  const cli = state.cli;
  const ours = !!cli?.installed && cli.ours;
  return (
    <section class="cli">
      <Panel
        title="The switchboard command"
        status={
          cli ? (
            ours ? (
              <Badge tone="ok">Installed</Badge>
            ) : cli.installed ? (
              <Badge tone="mute">Another launcher</Badge>
            ) : (
              <Badge tone="mute">Not installed</Badge>
            )
          ) : null
        }
        actions={
          <>
            <CopyButton
              text={AGENT_PROMPT}
              label="Copy agent prompt"
              title="Copy a prompt that teaches an agent this command"
            />
            {cli && !ours ? <InstallButton cli={cli} /> : null}
          </>
        }
      >
        <div class="cli-body">
          <p class="cli-intro">
            Everything the window can do, from a terminal or an agent. Results are JSON unless you add{' '}
            <code>--human</code>, so an agent can branch on them; the agent prompt above teaches one the rules.
          </p>
          {cli && ours ? (
            <p class="note">
              Runs on the app’s own runtime from <code>{cli.file}</code>, so it is always the same version as the app.
            </p>
          ) : null}
          {cli && cli.installed && !ours ? (
            <Note tone="warn">
              <code>{cli.file}</code> exists but was not written by this app. Remove it and install again, or leave it
              if you put it there.
            </Note>
          ) : null}
          {cli && !cli.installed ? (
            <p class="note">
              Installing writes one small launcher at <code>{cli.file}</code>. Nothing else changes.
            </p>
          ) : null}
          {cli && ours && !cli.onPath ? (
            <Note tone="warn">
              <code>~/.local/bin</code> is not on your PATH. Add <code>export PATH="$HOME/.local/bin:$PATH"</code> to
              your shell profile and open a new terminal.
            </Note>
          ) : null}
          {cli && !cli.appInstalled ? (
            <Note>Install Switchboard into /Applications first; the launcher points at the installed app.</Note>
          ) : null}
          <div class="term">
            {COMMANDS.map((c) => (
              <div class="term-line" key={c.cmd}>
                <span class="term-cmt"># {c.what}</span>
                <span class="term-cmd">
                  <span class="term-prompt">$</span> {c.cmd}
                </span>
                <CopyButton text={c.cmd} title={`Copy: ${c.cmd}`} />
              </div>
            ))}
          </div>
        </div>
      </Panel>
    </section>
  );
}

function InstallButton({ cli }: { cli: CliStatus }) {
  const [busy, setBusy] = useState(false);
  return (
    <Btn
      variant="primary"
      disabled={busy || cli.installed}
      onClick={() =>
        act(async () => {
          setBusy(true);
          try {
            await window.sb.installCli();
          } finally {
            setBusy(false);
          }
        })
      }
    >
      Install command
    </Btn>
  );
}

// Copies on click and flips its icon to a tick for a moment. The label never
// changes, so nothing around it moves.
function CopyButton({ text, label, title }: { text: string; label?: string; title: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <TipBtn
      variant={label ? 'outline' : 'icon'}
      class={`copy-btn ${copied ? 'copied' : ''}`}
      aria-label={label ?? title}
      tip={[copied ? 'Copied' : title]}
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      <Icon name="copy" />
      <Icon name="check" />
      {label}
    </TipBtn>
  );
}
