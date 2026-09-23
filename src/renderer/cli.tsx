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

// What an agent needs to know to drive the command well: the result
// contract, how profiles are named, which commands answer which question,
// and what stays with the person. Copied as one prompt.
const AGENT_PROMPT = `You can use the \`switchboard\` command on this Mac. It manages Claude and Codex accounts as profiles, each with its own isolated home, tracks each one's rate-limit headroom, and runs commands inside a chosen account. \`switchboard --help\` lists every command.

Reading results: a command that succeeds prints JSON on stdout and exits 0. One that fails prints one JSON object on stderr, {"error": CODE, "message": ..., "hint": ...}, and exits 2 (usage), 3 (not found), 4 (refused by a safety rule) or 1 (ran and failed). Branch on the code; the hint is usually the command that unblocks. Per-profile usage carries a status of ok, stale, not-signed-in, error or none.

Naming a profile: by id (claude-work), by vendor alone (claude means that vendor's Default profile), by vendor/name, or by a name only one profile has. \`switchboard list\` shows what exists.

Choosing an account: \`switchboard pick claude\` (or codex) answers which account should run a job: the signed-in profile whose tightest window has the most left, with ranked candidates and the excluded ones with reasons. Add --window 7d to judge by one window, --min-headroom 30 for a floor, --max-age 15m to refresh only stale entries. --refresh hits the vendors' usage endpoints for every profile, so use it once when freshness matters, never in a loop.

Running inside an account: \`switchboard exec PROFILE -- claude -p "..."\` runs any command with that profile's home in its environment; \`switchboard cli PROFILE ...\` prefixes the vendor's own CLI; \`eval "$(switchboard env PROFILE)"\` moves the current shell into the profile.

Windows and buckets: \`launch\` and \`quit\` open and close a profile's desktop window. Proxy buckets are pools of accounts behind a local proxy that a Codex desktop profile can route through; \`switchboard bucket list\` shows each account's headroom.

Leave to the person: \`remove\`, \`quit-others\` and \`bucket stop\` refuse without --yes and interrupt work or delete data, so pass --yes only when asked for exactly that. \`login\` opens an interactive sign-in the person completes; report not-signed-in and stop rather than retrying. Never edit profiles.json by hand.`;

export function Cli({ state }: { state: State }) {
  const cli = state.cli;
  return (
    <section class="cli">
      <InstallCard cli={cli} />
      <AgentCard />
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

function AgentCard() {
  const [copied, setCopied] = useState(false);
  return (
    <div class="panel cli-agent">
      <div class="cli-icon">
        <Icon name="bot" size={22} />
      </div>
      <div class="cli-about">
        <div class="cli-title">
          <b>For an AI agent</b>
        </div>
        <span class="note">
          A prompt that teaches an agent the command: how results come back, how profiles are named, how to pick an
          account and run inside it, and what to leave to you. Paste it into the agent's instructions.
        </span>
      </div>
      <div class="cli-action">
        <Btn
          variant="secondary"
          icon={copied ? 'check' : 'copy'}
          onClick={() => {
            void navigator.clipboard.writeText(AGENT_PROMPT);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? 'Copied' : 'Copy agent prompt'}
        </Btn>
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
