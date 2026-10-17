// A Claude Code mod that lets Switchboard's phone app act in this session.
// Switchboard passes it to every Claude profile it launches while phone
// access is on (CLAUDE_CODE_PLUGIN_DIRS, see src/launch.ts), with the
// control socket and the profile's id in the environment; without them it
// does nothing.
//
// - A reply typed on the phone comes in as the person's own prompt
//   ($.prompt.submit with asUser), a turn of its own once the session is
//   idle. The plugin asks the hub for replies with a long poll.
// - A tool call that would ask the person (tool.check settles on "ask") and
//   a question the model puts to them (AskUserQuestion) go to the phone, but
//   only while nobody is at the Mac: the hub says so. Holding the call is the
//   only way to wait for the phone, and it keeps the desktop's own dialog
//   from showing, so the hub hands it back the moment someone is at the Mac
//   again, and the dialog shows as usual. Anything that goes wrong does the
//   same: the desktop is always the fallback.
//
// The hub side is src/remote/control.ts.

import type { EngineInterface, Register } from 'claude-code';

type Decision = { choice: string } | { answers: Record<string, string[]> };
type Ask = { route: 'desk' } | { route: 'phone'; id: string };
type Outcome =
  | { status: 'pending' }
  | { status: 'decided'; decision: Decision }
  | { status: 'release' }
  | { status: 'gone' };

interface Link {
  socket: string;
  profileId: string;
  sessionId: string;
}

// After the hub cannot be reached, wait this long before asking again.
const QUIET_MS = 10_000;

let link: Link | null = null;
let polling = false;
let quietUntil = 0;

async function call<T>($: EngineInterface, path: string, body: unknown): Promise<T | null> {
  if (!link) return null;
  const res = await $.http.fetch(`http://switchboard${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    socketPath: link.socket,
  });
  return res.ok ? (JSON.parse(res.text) as T) : null;
}

async function poll($: EngineInterface): Promise<void> {
  if (!link || Date.now() < quietUntil) return;
  try {
    const reply = await call<{ commands: { type: string; text?: string }[] }>($, '/claude/poll', {
      profileId: link.profileId,
      sessionId: link.sessionId,
    });
    for (const c of reply?.commands ?? [])
      if (c.type === 'prompt' && c.text) await $.prompt.submit({ text: c.text, asUser: true });
  } catch {
    quietUntil = Date.now() + QUIET_MS;
  }
}

// Puts a call to the phone and waits for its answer; null hands it back to
// the desktop.
async function viaPhone(
  $: EngineInterface,
  kind: 'approval' | 'question',
  tool: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<Decision | null> {
  if (!link) return null;
  try {
    const ask = await call<Ask>($, '/claude/ask', {
      profileId: link.profileId,
      sessionId: link.sessionId,
      kind,
      tool,
      input,
    });
    if (!ask || ask.route !== 'phone') return null;
    for (;;) {
      if (signal?.aborted) {
        await call($, '/claude/done', { id: ask.id });
        return null;
      }
      const out = await call<Outcome>($, '/claude/wait', { id: ask.id });
      if (!out) return null;
      if (out.status === 'decided') return out.decision;
      if (out.status !== 'pending') return null;
    }
  } catch {
    return null;
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const socket = await $.env.get('SWITCHBOARD_CONTROL_SOCKET');
    const profileId = await $.env.get('SWITCHBOARD_PROFILE');
    if (socket && profileId) {
      link = { socket, profileId, sessionId: await $.session.id() };
      $.clock.every(1000, () => {
        if (polling) return;
        polling = true;
        void poll($).finally(() => {
          polling = false;
        });
      });
    }
    return next(e);
  });

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e);
    // Only what would ask the person; a question or a plan is theirs to see.
    if (verdict.decision !== 'ask' || !link || e.tool === 'AskUserQuestion' || e.tool === 'ExitPlanMode')
      return verdict;
    const decision = await viaPhone($, 'approval', e.tool, e.input, next.signal);
    if (!decision || !('choice' in decision)) return verdict;
    return decision.choice === 'allow'
      ? { decision: 'allow', reason: 'Allowed from your phone' }
      : { decision: 'deny', reason: 'Denied from your phone' };
  }).catch(($, e, next) => next(e));

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (!link) return next(e);
    // A tool call's arguments sit on the event itself.
    const questions = e.questions;
    const decision = await viaPhone($, 'question', e.tool, { questions }, next.signal);
    if (!decision || !('answers' in decision)) return next(e);
    const answers: Record<string, string> = {};
    for (const q of questions) {
      const picked = decision.answers[q.question];
      if (picked?.length) answers[q.question] = picked.join(', ');
    }
    return { result: { questions, answers } };
  }).catch(($, e, next) => next(e));
};
