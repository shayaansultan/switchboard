// The phone's way into a Codex desktop profile: a tap on the line between
// the ChatGPT app and its Codex engine (the app-server, JSON-RPC as JSON
// lines), inside the wrapper Switchboard launches the engine through.
//
// The tap passes every line through untouched, and:
// - writes requests of its own into the engine on the app's connection, so
//   a turn the phone starts is the app's turn too and the app shows it live.
//   Their replies are the tap's and never reach the app;
// - tells the hub about each approval or question the engine asks the app,
//   and answers one when the phone does. The engine then tells the app the
//   request was resolved, which clears the app's card;
// - tells the hub when the app answered first.
//
// It reaches the hub over the control socket (control.ts) and asks for
// commands with a long poll. The app starts more than one engine (a network
// check, Computer Use); only one that the app has asked for threads takes
// commands, so a reply never lands in an engine without the thread.

import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import { Transform, type TransformCallback, type Writable } from 'node:stream';

// What the engine asks the app that the phone can answer.
const ASKS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
]);
const RETRY_MS = 5000;

type Message = {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};

// A line stream whose handler may drop a line by returning null.
class Lines extends Transform {
  private decoder = new StringDecoder('utf8');
  private buffered = '';
  constructor(private handle: (line: string) => string | null) {
    super();
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.buffered += this.decoder.write(chunk);
    let end: number;
    while ((end = this.buffered.indexOf('\n')) !== -1) {
      const line = this.buffered.slice(0, end);
      this.buffered = this.buffered.slice(end + 1);
      const out = this.handle(line);
      if (out !== null) this.push(out + '\n');
    }
    callback();
  }
  override _flush(callback: TransformCallback): void {
    this.buffered += this.decoder.end();
    if (this.buffered) {
      const out = this.handle(this.buffered);
      if (out !== null) this.push(out);
    }
    callback();
  }
}

function parse(line: string): Message | null {
  if (!line.startsWith('{')) return null;
  try {
    return JSON.parse(line) as Message;
  } catch {
    return null;
  }
}

export function post(
  socket: string,
  path: string,
  body: unknown,
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        socketPath: socket,
        path,
        method: 'POST',
        // A fresh connection each time: a pooled one outlives a hub that
        // restarted (a port change, a reinstall) and fails its next write.
        agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
        timeout: timeoutMs,
        signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

export interface Tap {
  // Lines from the app to the engine.
  fromApp: Transform;
  // Lines from the engine to the app.
  fromEngine: Transform;
  stop(): void;
}

// `engine` is the engine's stdin; `fromApp` must be piped into it too, so
// both write whole lines.
export function codexTap(options: { profileId: string; socket: string; engine: Writable }): Tap {
  const { profileId, socket, engine } = options;
  // Requests the tap made, by id: what to do with each reply.
  const own = new Map<string, (reply: Message) => void>();
  // The engine's open requests to the app that the hub knows about.
  const asked = new Set<string | number>();
  // Threads with a turn running: a reply to one waits in the thread's queue.
  const running = new Set<string>();
  let serving = false;
  let stopped = false;
  // Ends the long poll and the retry wait when the engine goes.
  const quit = new AbortController();

  const send = (message: Message): void => {
    engine.write(JSON.stringify(message) + '\n');
  };
  const request = (method: string, params: unknown): Promise<Message> =>
    new Promise((resolve) => {
      const id = `sb-${randomUUID()}`;
      own.set(id, resolve);
      send({ id, method, params: params as Record<string, unknown> });
    });
  const tell = (path: string, body: Record<string, unknown>) =>
    void post(socket, path, { profileId, ...body }, 5000).catch(() => {});

  const errorText = (m: Message): string => {
    const e = m.error as { message?: unknown } | undefined;
    return typeof e?.message === 'string' ? e.message : 'Codex refused the message';
  };

  // A reply typed on the phone. Mid-turn it joins the thread's queue, as a
  // message typed in the app would, and runs when the turn ends; otherwise
  // it starts a turn, loading the thread into the engine first if the app
  // has not opened it since it started. The hub hears when it fails.
  async function deliver(threadId: string, text: string, images: string[] = []): Promise<void> {
    const input = [...(text ? [{ type: 'text', text }] : []), ...images.map((path) => ({ type: 'localImage', path }))];
    let reply: Message;
    if (running.has(threadId)) {
      reply = await request('thread/queue/add', { threadId, clientUserMessageId: randomUUID(), input });
    } else {
      reply = await request('turn/start', { threadId, input });
      if (reply.error) {
        const resumed = await request('thread/resume', { threadId });
        if (!resumed.error) reply = await request('turn/start', { threadId, input });
      }
    }
    if (reply.error) tell('/codex/failed', { threadId, error: errorText(reply) });
  }

  async function serve(): Promise<void> {
    while (!stopped) {
      let reply: {
        commands?: {
          type: string;
          threadId?: string;
          text?: string;
          images?: string[];
          requestId?: string | number;
          result?: unknown;
        }[];
      };
      try {
        reply = (await post(socket, '/codex/poll', { profileId }, 30_000, quit.signal)) as typeof reply;
      } catch {
        if (stopped) return;
        // Phone access is off or the app is restarting.
        await new Promise<void>((r) => {
          const timer = setTimeout(r, RETRY_MS);
          quit.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            r();
          });
        });
        continue;
      }
      for (const c of reply.commands ?? []) {
        if (c.type === 'prompt' && c.threadId && (c.text || c.images?.length))
          void deliver(c.threadId, c.text ?? '', c.images ?? []);
        else if (c.type === 'answer' && c.requestId !== undefined && asked.has(c.requestId)) {
          asked.delete(c.requestId);
          send({ id: c.requestId, result: c.result });
        }
      }
    }
  }

  const fromApp = new Lines((line) => {
    const m = parse(line);
    if (!m) return line;
    // The app asked this engine for threads: it is the one to serve.
    if (!serving && typeof m.method === 'string' && m.method.startsWith('thread/')) {
      serving = true;
      void serve();
    }
    // The app answered one of the engine's requests before the phone did.
    if (m.method === undefined && m.id !== undefined && asked.has(m.id)) {
      asked.delete(m.id);
      tell('/codex/resolved', { requestId: m.id });
    }
    return line;
  });

  const fromEngine = new Lines((line) => {
    const m = parse(line);
    if (!m) return line;
    if (m.method === undefined && typeof m.id === 'string' && own.has(m.id)) {
      own.get(m.id)!(m);
      own.delete(m.id);
      return null;
    }
    const thread = m.params?.threadId;
    if (m.method === 'turn/started' && typeof thread === 'string') running.add(thread);
    else if (m.method === 'turn/completed' && typeof thread === 'string') running.delete(thread);
    if (m.method && m.id !== undefined && ASKS.has(m.method)) {
      asked.add(m.id);
      tell('/codex/request', { requestId: m.id, method: m.method, params: m.params ?? {} });
    } else if (m.method === 'serverRequest/resolved') {
      const id = m.params?.requestId as string | number | undefined;
      if (id !== undefined && asked.delete(id)) tell('/codex/resolved', { requestId: id });
    }
    return line;
  });

  return {
    fromApp,
    fromEngine,
    stop() {
      stopped = true;
      quit.abort();
    },
  };
}
