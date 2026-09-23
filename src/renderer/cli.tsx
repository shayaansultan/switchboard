// The CLI tab: whether the `switchboard` command is installed, a button to
// install it, and the commands worth knowing, each with a copy button.

import { useState } from 'preact/hooks';
import { act, type CliStatus, type State } from './lib';
import { Badge, Btn, Icon, Note, Panel, TipBtn } from './ui/primitives';

const COMMANDS: { cmd: string; what: string }[] = [
  { cmd: 'switchboard list --human', what: 'Every profile, with its running state and signed-in account.' },
  { cmd: 'switchboard pick claude', what: 'Which Claude profile has the most room right now, and why.' },
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
