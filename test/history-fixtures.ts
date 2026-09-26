// Log lines in the shapes Claude Code and Codex write, for the usage history
// tests. The field names follow real transcripts and rollouts; the values are
// invented.

import * as fs from 'node:fs';
import * as path from 'node:path';

export const iso = (ms: number) => new Date(ms).toISOString();

export function claudeUser(o: { session: string; at: number; text: string; cwd?: string; entry?: string }) {
  return JSON.stringify({
    type: 'user',
    sessionId: o.session,
    timestamp: iso(o.at),
    cwd: o.cwd ?? '/work/app',
    entrypoint: o.entry ?? 'cli',
    isSidechain: false,
    message: { role: 'user', content: o.text },
  });
}

export function claudeToolResult(o: { session: string; at: number }) {
  return JSON.stringify({
    type: 'user',
    sessionId: o.session,
    timestamp: iso(o.at),
    cwd: '/work/app',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
  });
}

// One content block of a response, carrying the response's usage as every
// block's line does.
export function claudeAssistant(o: {
  session: string;
  at: number;
  id: string;
  request?: string;
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWriteHour?: number;
  block?: object;
  sidechain?: boolean;
  cwd?: string;
}) {
  const write = o.cacheWrite ?? 0;
  return JSON.stringify({
    type: 'assistant',
    sessionId: o.session,
    timestamp: iso(o.at),
    cwd: o.cwd ?? '/work/app',
    entrypoint: 'cli',
    isSidechain: !!o.sidechain,
    requestId: o.request ?? `req_${o.id}`,
    message: {
      id: o.id,
      model: o.model ?? 'claude-sonnet-5',
      content: [o.block ?? { type: 'text', text: 'ok' }],
      usage: {
        input_tokens: o.input ?? 0,
        output_tokens: o.output ?? 0,
        cache_read_input_tokens: o.cacheRead ?? 0,
        cache_creation_input_tokens: write,
        cache_creation: {
          ephemeral_5m_input_tokens: write - (o.cacheWriteHour ?? 0),
          ephemeral_1h_input_tokens: o.cacheWriteHour ?? 0,
        },
      },
    },
  });
}

export const codexLine = (at: number, type: string, payload: object) =>
  JSON.stringify({ timestamp: iso(at), type, payload });

export function codexUsage(input: number, cached: number, output: number) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  };
}

export function write(file: string, lines: string[], append = false): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  (append ? fs.appendFileSync : fs.writeFileSync)(file, lines.map((l) => l + '\n').join(''));
}
