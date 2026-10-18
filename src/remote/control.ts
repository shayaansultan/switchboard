// Replying and approving from the phone. The hub cannot drive the desktop
// apps itself; something inside each one does it and asks the hub what to do:
//
//   Claude  a Claude Code plugin (plugins/switchboard-remote), loaded into
//           every Code session of a profile Switchboard launched. It types a
//           reply in with $.prompt.submit and decides tool approvals and
//           questions at tool.check and tool.call.
//   Codex   the wrapper Switchboard puts around the ChatGPT app's Codex
//           engine (codex-tap.ts). It sits on the app's own connection to
//           the engine, so a turn it starts shows in the app at once, and it
//           sees each approval the engine asks the app for.
//
// Both reach the hub over HTTP on a Unix socket in ~/.switchboard/remote/,
// which only this user can open, and both pull: each holds a request open
// until there is something for it (a long poll), since Claude's plugin can
// only make requests. Nothing is kept on disk; a request waiting on the
// phone lives as long as the app and the session do.
//
// Approvals differ by app. The Codex engine asks the desktop and the hub at
// once and takes the first answer; the desktop's card clears when the phone
// answers. A Claude plugin has to hold the call to wait for the phone, which
// would hide the desktop's own dialog, so it only routes a call to the phone
// while the Mac is away (locked or idle), and hands it back to the desktop
// the moment someone is at the Mac again.

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { z } from 'zod';
import type { Vendor } from '../types';
import { remoteDir } from './pairing';

// A long poll answers within this, inside the plugin's 30 s fetch limit.
export const HOLD_MS = 20_000;
// A plugin or wrapper that has not asked for this long is gone.
const ALIVE_MS = 45_000;

export const controlSocket = (): string => path.join(remoteDir(), 'control.sock');

export interface Choice {
  value: string;
  label: string;
}

export interface Question {
  id: string;
  text: string;
  options: { label: string; hint: string | null }[];
  multi: boolean;
}

// One field of a form an MCP server asks the person to fill in.
export interface Field {
  id: string;
  label: string;
  hint: string | null;
  type: 'text' | 'number' | 'boolean' | 'choice' | 'multi';
  options: Choice[];
  required: boolean;
  default: FieldValue | null;
}
export type FieldValue = string | number | boolean | string[];

// What the phone shows for a request waiting on the person: an approval
// (pick a choice), questions (pick or type answers), or a form from an MCP
// server (fill in fields, or open a link, then pick a choice).
export interface Pending {
  id: string;
  profileId: string;
  vendor: Vendor;
  sessionId: string;
  kind: 'approval' | 'question' | 'form';
  title: string;
  detail: string;
  choices: Choice[];
  questions: Question[];
  fields: Field[];
  url: string | null;
  createdAt: string;
}

export type Decision = { choice: string; form?: Record<string, FieldValue> } | { answers: Record<string, string[]> };

type ClaudeCommand = { type: 'prompt'; text: string };
type CodexCommand =
  | { type: 'prompt'; id: string; threadId: string; text: string; images: string[] }
  | { type: 'answer'; requestId: string | number; result: unknown };

interface Waiter<T> {
  resolve(value: T): void;
}

// A command not collected within this long is dropped: the session it was
// for has stopped asking, and typing it in later would surprise.
export const COMMAND_TTL_MS = 2 * 60_000;

// A queue a long poll drains: answers at once when something is queued,
// otherwise when the next thing arrives or HOLD_MS passes.
class Inbox<T> {
  private items: { value: T; at: number }[] = [];
  private waiter: Waiter<T[]> | null = null;
  seenAt = 0;

  push(item: T): void {
    this.items.push({ value: item, at: Date.now() });
    this.flush();
  }

  // Puts back what a poll took but could not deliver (its connection had
  // closed), ahead of anything newer.
  restore(items: T[]): void {
    this.items.unshift(...items.map((value) => ({ value, at: Date.now() })));
  }

  private flush(): void {
    const fresh = Date.now() - COMMAND_TTL_MS;
    this.items = this.items.filter((i) => i.at > fresh);
    if (!this.waiter || !this.items.length) return;
    const w = this.waiter;
    this.waiter = null;
    w.resolve(this.items.splice(0).map((i) => i.value));
  }

  // Answers a waiting long poll with nothing, so its connection can close.
  end(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.resolve([]);
  }

  take(holdMs: number): Promise<T[]> {
    this.seenAt = Date.now();
    // A newer poll replaces a stale one (the plugin timed out and asked again).
    this.waiter?.resolve([]);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiter?.resolve === done) this.waiter = null;
        resolve([]);
      }, holdMs);
      const done = (items: T[]) => {
        clearTimeout(timer);
        resolve(items);
      };
      this.waiter = { resolve: done };
      this.flush();
    });
  }
}

const ClaudeHello = z.object({ profileId: z.string().min(1).max(200), sessionId: z.string().min(1).max(200) });
const ClaudeAsk = ClaudeHello.extend({
  kind: z.enum(['approval', 'question']),
  tool: z.string().max(200),
  input: z.unknown(),
});
const Wait = z.object({ id: z.string() });
const CodexHello = z.object({ profileId: z.string().min(1).max(200) });
const CodexRequest = CodexHello.extend({
  requestId: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.record(z.string(), z.unknown()),
});
const CodexFailed = CodexHello.extend({ threadId: z.string().max(200), error: z.string().max(500) });
const CodexResolved = CodexHello.extend({ requestId: z.union([z.string(), z.number()]) });

type ClaudeOutcome =
  | { status: 'pending' }
  | { status: 'decided'; decision: Decision }
  | { status: 'release' }
  | { status: 'gone' };

interface Held {
  pending: Pending;
  // Claude: the plugin's wait, answered with the decision or a release.
  waiter?: Waiter<ClaudeOutcome> | null;
  // Codex: the engine's own request id, to answer it by, and what it asked.
  requestId?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const CLAUDE_ALLOW: Choice[] = [
  { value: 'allow', label: 'Allow' },
  { value: 'deny', label: 'Deny' },
];

// How a Claude tool call reads on the phone.
function describeClaude(tool: string, input: unknown): { title: string; detail: string } {
  const i = obj(input);
  if (tool === 'Bash') return { title: 'Run a command', detail: str(i.command) ?? '' };
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit')
    return {
      title: tool === 'Write' ? 'Write a file' : 'Edit a file',
      detail: str(i.file_path) ?? str(i.notebook_path) ?? '',
    };
  if (tool === 'WebFetch') return { title: 'Fetch a page', detail: str(i.url) ?? '' };
  if (tool.startsWith('mcp__')) {
    const [, server, name] = tool.split('__');
    return {
      title: `Use ${server}`,
      detail: `${name}${Object.keys(i).length ? ` ${clip(JSON.stringify(i), 300)}` : ''}`,
    };
  }
  return { title: `Use ${tool}`, detail: clip(JSON.stringify(i), 400) };
}

function claudeQuestions(input: unknown): Question[] {
  return (Array.isArray(obj(input).questions) ? (obj(input).questions as unknown[]) : []).map((q, i) => {
    const o = obj(q);
    return {
      id: str(o.question) ?? String(i),
      text: str(o.question) ?? '',
      options: (Array.isArray(o.options) ? o.options : []).map((x) => ({
        label: str(obj(x).label) ?? '',
        hint: str(obj(x).description),
      })),
      multi: o.multiSelect === true,
    };
  });
}

const CODEX_APPROVAL: Choice[] = [
  { value: 'accept', label: 'Allow' },
  { value: 'acceptForSession', label: 'Allow for this session' },
  { value: 'decline', label: 'Decline' },
];

const CODEX_PERMISSIONS: Choice[] = [
  { value: 'turn', label: 'Allow for this turn' },
  { value: 'session', label: 'Allow for this session' },
  { value: 'decline', label: 'Decline' },
];

// What a Codex permissions request asks for, in words.
function permissionsText(params: Record<string, unknown>): string {
  const p = obj(params.permissions);
  const fs = obj(p.fileSystem);
  const lines: string[] = [];
  if (obj(p.network).enabled === true) lines.push('Network access');
  const paths = (key: string) =>
    Array.isArray(fs[key]) ? (fs[key] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  for (const path of paths('write')) lines.push(`Write ${path}`);
  for (const path of paths('read')) lines.push(`Read ${path}`);
  for (const e of Array.isArray(fs.entries) ? fs.entries : []) {
    const entry = obj(e);
    const where = obj(entry.path);
    const target = str(where.path) ?? str(where.pattern) ?? str(where.value) ?? '';
    const access = str(entry.access) ?? 'read';
    lines.push(`${access === 'write' ? 'Write' : access === 'deny' ? 'No access to' : 'Read'} ${target}`);
  }
  const reason = str(params.reason);
  return [...(reason ? [reason] : []), ...lines].join('\n');
}

// The fields of an MCP form, from its JSON schema (MCP elicitation's subset:
// strings, numbers, booleans, single and multiple choices).
function formFields(schema: unknown): Field[] | null {
  const s = obj(schema);
  const props = obj(s.properties);
  const required = new Set(
    Array.isArray(s.required) ? s.required.filter((x): x is string => typeof x === 'string') : [],
  );
  const fields: Field[] = [];
  for (const [id, raw] of Object.entries(props)) {
    const f = obj(raw);
    const label = str(f.title) ?? id;
    const hint = str(f.description);
    const base = { id, label, hint, required: required.has(id) };
    const titled = (list: unknown): Choice[] =>
      (Array.isArray(list) ? list : []).map((o) => ({
        value: str(obj(o).const) ?? '',
        label: str(obj(o).title) ?? str(obj(o).const) ?? '',
      }));
    const plain = (list: unknown, names?: unknown): Choice[] =>
      (Array.isArray(list) ? list : []).map((v, i) => ({
        value: String(v),
        label: Array.isArray(names) && typeof names[i] === 'string' ? (names[i] as string) : String(v),
      }));
    if (f.type === 'boolean')
      fields.push({
        ...base,
        type: 'boolean',
        options: [],
        default: typeof f.default === 'boolean' ? f.default : null,
      });
    else if (f.type === 'number' || f.type === 'integer')
      fields.push({ ...base, type: 'number', options: [], default: typeof f.default === 'number' ? f.default : null });
    else if (f.type === 'array') {
      const items = obj(f.items);
      const options = Array.isArray(items.anyOf) ? titled(items.anyOf) : plain(items.enum);
      fields.push({
        ...base,
        type: 'multi',
        options,
        default: Array.isArray(f.default) ? (f.default as string[]) : null,
      });
    } else if (f.type === 'string' && (Array.isArray(f.oneOf) || Array.isArray(f.enum)))
      fields.push({
        ...base,
        type: 'choice',
        options: Array.isArray(f.oneOf) ? titled(f.oneOf) : plain(f.enum, f.enumNames),
        default: str(f.default),
      });
    else if (f.type === 'string') fields.push({ ...base, type: 'text', options: [], default: str(f.default) });
    else return null;
  }
  return fields;
}

const MCP_FORM: Choice[] = [
  { value: 'accept', label: 'Submit' },
  { value: 'decline', label: 'Decline' },
];
const MCP_LINK: Choice[] = [
  { value: 'accept', label: 'Done' },
  { value: 'decline', label: 'Decline' },
];

function describeCodex(
  method: string,
  params: Record<string, unknown>,
): Omit<Pending, 'id' | 'profileId' | 'vendor' | 'sessionId' | 'createdAt'> | null {
  const none = { questions: [], fields: [], url: null };
  if (method === 'item/permissions/requestApproval')
    return {
      ...none,
      kind: 'approval',
      title: 'Get more access',
      detail: permissionsText(params),
      choices: CODEX_PERMISSIONS,
    };
  if (method === 'mcpServer/elicitation/request') {
    const server = str(params.serverName) ?? 'A connector';
    const message = str(params.message) ?? '';
    if (params.mode === 'url' && str(params.url))
      return {
        ...none,
        kind: 'form',
        title: `${server} asks you to open a link`,
        detail: message,
        choices: MCP_LINK,
        url: str(params.url),
      };
    if (params.mode === 'form' || params.mode === 'openai/form' || params.mode === 'openaiForm') {
      const fields = formFields(params.requestedSchema);
      // A form the phone cannot draw, or a device check, stays on the Mac.
      if (!fields) return null;
      return { ...none, kind: 'form', title: `${server} asks for details`, detail: message, choices: MCP_FORM, fields };
    }
    return null;
  }
  if (method === 'item/commandExecution/requestApproval')
    return {
      ...none,
      kind: 'approval',
      title: 'Run a command',
      detail: str(params.command) ?? '',
      choices: CODEX_APPROVAL,
    };
  if (method === 'item/fileChange/requestApproval')
    return {
      ...none,
      kind: 'approval',
      title: 'Change files',
      detail: str(params.reason) ?? str(params.grantRoot) ?? 'Apply the proposed edits',
      choices: CODEX_APPROVAL,
    };
  if (method === 'item/tool/requestUserInput') {
    const questions = (Array.isArray(params.questions) ? params.questions : []).map((q, i) => {
      const o = obj(q);
      return {
        id: str(o.id) ?? String(i),
        text: str(o.question) ?? str(o.header) ?? '',
        options: (Array.isArray(o.options) ? o.options : []).map((x) => ({
          label: str(obj(x).label) ?? '',
          hint: str(obj(x).description),
        })),
        multi: false,
      };
    });
    // A secret answer is typed on the Mac.
    if ((Array.isArray(params.questions) ? params.questions : []).some((q) => obj(q).isSecret === true)) return null;
    return { ...none, kind: 'question', title: 'A question for you', detail: '', choices: [], questions };
  }
  return null;
}

// The engine's answer for a decision, in the shape its request asked for.
function codexResult(held: Held, decision: Decision): unknown {
  if ('answers' in decision)
    return { answers: Object.fromEntries(Object.entries(decision.answers).map(([q, a]) => [q, { answers: a }])) };
  if (held.method === 'item/permissions/requestApproval')
    return decision.choice === 'decline'
      ? { permissions: {} }
      : { permissions: obj(held.params?.permissions), scope: decision.choice };
  if (held.method === 'mcpServer/elicitation/request')
    return decision.choice === 'accept'
      ? { action: 'accept', content: held.pending.url ? null : (decision.form ?? {}) }
      : { action: decision.choice };
  return { decision: decision.choice };
}

export interface ControlOptions {
  // Whether nobody is at the Mac: Claude approvals go to the phone only then.
  away(): boolean;
  // Called whenever what the phone shows here changes.
  onChange(): void;
  socket?: string;
  // How long a long poll is held; tests shorten it.
  holdMs?: number;
}

export class Control {
  private claude = new Map<string, Inbox<ClaudeCommand>>();
  private codex = new Map<string, Inbox<CodexCommand>>();
  private held = new Map<string, Held>();
  // A reply that reached the app but could not be delivered, by session key,
  // for the phone to show for a while.
  private problems = new Map<string, { error: string; at: number }>();
  // Claude outcomes the plugin has not collected yet: it may be between waits.
  private outcomes = new Map<string, ClaudeOutcome>();
  private server: http.Server | null = null;

  constructor(private options: ControlOptions) {}

  // ---- what the phone sees ----

  // Recent replies that did not go through: `${profileId}/${sessionId}` → why.
  failures(): Record<string, string> {
    const fresh = Date.now() - COMMAND_TTL_MS;
    for (const [key, p] of this.problems) if (p.at <= fresh) this.problems.delete(key);
    return Object.fromEntries([...this.problems].map(([key, p]) => [key, p.error]));
  }

  pending(): Pending[] {
    this.sweep();
    return [...this.held.values()].map((h) => h.pending).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // Sessions a reply can reach: a Claude session whose plugin is polling, or
  // any thread of a Codex profile whose wrapper is.
  reachable(): { claude: string[]; codex: string[] } {
    const now = Date.now();
    const alive = (m: Map<string, Inbox<unknown>>) =>
      [...m.entries()].filter(([, i]) => now - i.seenAt < ALIVE_MS).map(([k]) => k);
    return { claude: alive(this.claude), codex: alive(this.codex) };
  }

  // `files` are uploads (uploads.ts) to pass on: Codex takes pictures as
  // images of the turn; anything else, and everything for Claude, whose
  // plugin cannot attach bytes, is named by path for the agent to open.
  reply(
    vendor: Vendor,
    profileId: string,
    sessionId: string,
    text: string,
    files: { name: string; type: string; path: string }[] = [],
  ): void {
    const { claude, codex } = this.reachable();
    const listed = (list: typeof files) =>
      list.length
        ? `${text ? `${text}\n\n` : ''}Attached from my phone${vendor === 'claude' ? ' (open with the Read tool)' : ''}:\n${list.map((f) => `- ${f.path}`).join('\n')}`
        : text;
    if (vendor === 'claude') {
      const key = `${profileId}/${sessionId}`;
      if (!claude.includes(key)) throw new Error('not-reachable');
      this.claude.get(key)!.push({ type: 'prompt', text: listed(files) });
    } else {
      if (!codex.includes(profileId)) throw new Error('not-reachable');
      this.problems.delete(`${profileId}/${sessionId}`);
      const images = files.filter((f) => f.type.startsWith('image/'));
      this.codex.get(profileId)!.push({
        type: 'prompt',
        id: randomUUID(),
        threadId: sessionId,
        text: listed(files.filter((f) => !f.type.startsWith('image/'))),
        images: images.map((f) => f.path),
      });
    }
  }

  decide(id: string, decision: Decision): void {
    const held = this.held.get(id);
    if (!held) throw new Error('no-such-request');
    const { pending } = held;
    if (
      pending.kind !== 'question' &&
      !('choice' in decision && pending.choices.some((c) => c.value === decision.choice))
    )
      throw new Error('bad-choice');
    if (pending.kind === 'question' && !('answers' in decision)) throw new Error('bad-answers');
    this.held.delete(id);
    if (pending.vendor === 'claude') {
      this.settle(held, { status: 'decided', decision });
    } else {
      this.codex
        .get(pending.profileId)
        ?.push({ type: 'answer', requestId: held.requestId!, result: codexResult(held, decision) });
    }
    this.options.onChange();
  }

  // ---- the plugin's and the wrapper's side ----

  private inbox<T>(map: Map<string, Inbox<T>>, key: string): Inbox<T> {
    let inbox = map.get(key);
    if (!inbox) map.set(key, (inbox = new Inbox<T>()));
    return inbox;
  }

  private add(pending: Omit<Pending, 'id' | 'createdAt'>, extra: Partial<Held> = {}): Held {
    const held: Held = { pending: { ...pending, id: randomUUID(), createdAt: new Date().toISOString() }, ...extra };
    this.held.set(held.pending.id, held);
    this.options.onChange();
    return held;
  }

  private settle(held: Held, outcome: ClaudeOutcome): void {
    const w = held.waiter;
    held.waiter = null;
    if (w) w.resolve(outcome);
    else this.outcomes.set(held.pending.id, outcome);
  }

  // Drops what a gone plugin or wrapper left, and hands Claude's held calls
  // back to the desktop once someone is at the Mac.
  private sweep(): void {
    const now = Date.now();
    const away = this.options.away();
    let changed = false;
    for (const [id, h] of this.held) {
      const p = h.pending;
      const inbox =
        p.vendor === 'claude' ? this.claude.get(`${p.profileId}/${p.sessionId}`) : this.codex.get(p.profileId);
      const gone = !inbox || now - inbox.seenAt > ALIVE_MS;
      if (gone || (p.vendor === 'claude' && !away)) {
        this.held.delete(id);
        if (p.vendor === 'claude') this.settle(h, { status: gone ? 'gone' : 'release' });
        changed = true;
      }
    }
    if (changed) this.options.onChange();
  }

  // `gone` says whether the asker's connection has closed, so a long poll
  // that outlived its client hands its commands back instead of losing them.
  private async route(pathname: string, body: unknown, gone: () => boolean = () => false): Promise<unknown> {
    switch (pathname) {
      case '/claude/poll': {
        const hello = ClaudeHello.parse(body);
        const inbox = this.inbox(this.claude, `${hello.profileId}/${hello.sessionId}`);
        const commands = await inbox.take(this.options.holdMs ?? HOLD_MS);
        if (gone() && commands.length) inbox.restore(commands);
        return { commands };
      }
      case '/claude/ask': {
        const ask = ClaudeAsk.parse(body);
        this.inbox(this.claude, `${ask.profileId}/${ask.sessionId}`).seenAt = Date.now();
        if (!this.options.away()) return { route: 'desk' };
        const shown =
          ask.kind === 'question'
            ? {
                title: 'A question for you',
                detail: '',
                choices: [],
                questions: claudeQuestions(ask.input),
                fields: [],
                url: null,
              }
            : { ...describeClaude(ask.tool, ask.input), choices: CLAUDE_ALLOW, questions: [], fields: [], url: null };
        const held = this.add({
          profileId: ask.profileId,
          vendor: 'claude',
          sessionId: ask.sessionId,
          kind: ask.kind,
          ...shown,
        });
        return { route: 'phone', id: held.pending.id };
      }
      case '/claude/wait': {
        const { id } = Wait.parse(body);
        const held = this.held.get(id);
        if (held) {
          const p = held.pending;
          this.inbox(this.claude, `${p.profileId}/${p.sessionId}`).seenAt = Date.now();
        }
        this.sweep();
        const outcome = this.outcomes.get(id);
        if (outcome) {
          this.outcomes.delete(id);
          return outcome;
        }
        if (!held || !this.held.has(id)) return { status: 'gone' };
        return new Promise<ClaudeOutcome>((resolve) => {
          const timer = setTimeout(
            () => {
              held.waiter = null;
              resolve({ status: 'pending' });
            },
            Math.min(HOLD_MS, 2000),
          );
          held.waiter = {
            resolve: (o) => {
              clearTimeout(timer);
              resolve(o);
            },
          };
        });
      }
      case '/claude/done': {
        // The plugin stopped waiting (the turn was stopped): forget the request.
        const { id } = Wait.parse(body);
        if (this.held.delete(id)) this.options.onChange();
        return { ok: true };
      }
      case '/codex/poll': {
        const hello = CodexHello.parse(body);
        const inbox = this.inbox(this.codex, hello.profileId);
        const commands = await inbox.take(this.options.holdMs ?? HOLD_MS);
        if (gone() && commands.length) inbox.restore(commands);
        return { commands };
      }
      case '/codex/request': {
        const req = CodexRequest.parse(body);
        this.inbox(this.codex, req.profileId).seenAt = Date.now();
        const shown = describeCodex(req.method, req.params);
        const threadId = str(req.params.threadId);
        if (!shown || !threadId) return { ok: false };
        this.add(
          { profileId: req.profileId, vendor: 'codex', sessionId: threadId, ...shown },
          { requestId: req.requestId, method: req.method, params: req.params },
        );
        return { ok: true };
      }
      case '/codex/failed': {
        const failed = CodexFailed.parse(body);
        this.problems.set(`${failed.profileId}/${failed.threadId}`, { error: failed.error, at: Date.now() });
        this.options.onChange();
        return { ok: true };
      }
      case '/codex/resolved': {
        const res = CodexResolved.parse(body);
        for (const [id, h] of this.held)
          if (h.pending.profileId === res.profileId && h.requestId === res.requestId) {
            this.held.delete(id);
            this.options.onChange();
          }
        return { ok: true };
      }
    }
    throw Object.assign(new Error('not-found'), { status: 404 });
  }

  listen(): Promise<string> {
    const socket = this.options.socket ?? controlSocket();
    fs.mkdirSync(path.dirname(socket), { recursive: true, mode: 0o700 });
    fs.rmSync(socket, { force: true });
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 1024 * 1024) req.destroy();
        else chunks.push(c);
      });
      req.on('end', () => {
        let body: unknown;
        try {
          body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        } catch {
          body = {};
        }
        const url = new URL(req.url ?? '/', 'http://control');
        this.route(url.pathname, body, () => res.destroyed || req.destroyed).then(
          (out) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out)),
          (error: Error & { status?: number }) =>
            res
              .writeHead(error.status ?? (error instanceof z.ZodError ? 400 : 500), {
                'content-type': 'application/json',
              })
              .end(JSON.stringify({ error: error.message.slice(0, 200) })),
        );
      });
    });
    // Long polls must outlive Node's default request timeouts.
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 10_000;
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(socket, () => {
        fs.chmodSync(socket, 0o600);
        resolve(socket);
      });
    });
  }

  close(): Promise<void> {
    for (const h of this.held.values()) this.settle(h, { status: 'gone' });
    this.held.clear();
    this.outcomes.clear();
    // Long polls hold their connections open; answer them so the server can
    // close without waiting out HOLD_MS.
    for (const inbox of [...this.claude.values(), ...this.codex.values()]) inbox.end();
    const server = this.server;
    this.server = null;
    if (!server) return Promise.resolve();
    return new Promise((done) => {
      // A connection a runtime will not close for us must not hang shutdown.
      const timer = setTimeout(done, 1000);
      server.close(() => {
        clearTimeout(timer);
        done();
      });
      server.closeAllConnections?.();
    });
  }
}
