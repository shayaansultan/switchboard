// Reading JSON-lines session files without reading them whole. Claude and
// Codex append one record per line, and a long session reaches hundreds of
// megabytes, so the readers take a slice from the start (where a session
// says what it is) and slices from the end (where it says what it is doing),
// and page further back by byte position when the phone scrolls up.
//
// A slice that starts or ends mid-line drops the partial line; a line being
// written at that moment fails to parse and is skipped.

import * as fs from 'node:fs';

export interface FileInfo {
  file: string;
  mtimeMs: number;
  size: number;
}

export type Rec = Record<string, unknown>;

export const obj = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
export const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function stat(file: string): FileInfo | null {
  try {
    const s = fs.statSync(file);
    return s.isFile() ? { file, mtimeMs: s.mtimeMs, size: s.size } : null;
  } catch {
    return null;
  }
}

export function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function readBytes(file: string, start: number, length: number): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const n = fs.readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function readSlice(file: string, start: number, length: number): string {
  return readBytes(file, start, length).toString('utf8');
}

// Where in its file each record parsed from a known position starts, so an
// image stored inline can be found again by its line (see media.ts).
const offsets = new WeakMap<Rec, number>();
export const offsetOf = (r: Rec): number | undefined => offsets.get(r);

// `base` is the byte position of the first line, when known.
export function parseLines(lines: string[], base?: number): Rec[] {
  const out: Rec[] = [];
  let at = base ?? 0;
  for (const line of lines) {
    const start = at;
    if (base !== undefined) at += Buffer.byteLength(line) + 1;
    if (!line || line.charCodeAt(0) !== 123 /* { */) continue;
    try {
      const r = obj(JSON.parse(line));
      if (base !== undefined) offsets.set(r, start);
      out.push(r);
    } catch {
      // Half-written, or not a record.
    }
  }
  return out;
}

// Records in the first `bytes` of the file.
export function head(info: FileInfo, bytes: number): Rec[] {
  const length = Math.min(bytes, info.size);
  const lines = readSlice(info.file, 0, length).split('\n');
  if (info.size > length) lines.pop();
  return parseLines(lines, 0);
}

// Records that end at or before `end`, starting no earlier than `end - bytes`.
// `start` is where the first returned record begins: pass it as the next
// `end` to read the page before.
export function window(info: FileInfo, end: number, bytes: number): { records: Rec[]; start: number } {
  const stop = Math.min(end, info.size);
  const from = Math.max(0, stop - bytes);
  // Find the first whole line in bytes: the slice may start inside a character.
  const bytes_ = readBytes(info.file, from, stop - from);
  let offset = 0;
  if (from > 0) {
    const first = bytes_.indexOf(10);
    if (first < 0) return { records: [], start: from };
    offset = first + 1;
  }
  const start = from + offset;
  return { records: parseLines(bytes_.subarray(offset).toString('utf8').split('\n'), start), start };
}

export function tail(info: FileInfo, bytes: number): Rec[] {
  return window(info, info.size, bytes).records;
}

export function clip(text: string, limit: number): string {
  const t = text.trim();
  return t.length > limit ? t.slice(0, limit - 1).trimEnd() + '…' : t;
}

export function oneLine(text: string, limit: number): string {
  return clip(text.replace(/\s+/g, ' '), limit);
}

// Text the person typed, without what the app or a hook attached to it.
export function cleanPrompt(text: string): string {
  return (
    text
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .replace(/<(command-[a-z-]+|local-command-[a-z-]+)>[\s\S]*?<\/\1>/g, '')
      // What the person was looking at in an artifact, for the model only.
      .replace(/<artifact-view-context[^>]*>[\s\S]*?<\/artifact-view-context>/g, '')
      // Pasted text keeps its words, without the wrapper.
      .replace(/<\/?pasted_content[^>]*>/g, '')
      .trim()
  );
}

// Unified-diff lines counted the way a reviewer would.
export function diffCounts(lines: string[]): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const l of lines) {
    if (l.startsWith('+') && !l.startsWith('+++')) adds++;
    else if (l.startsWith('-') && !l.startsWith('---')) dels++;
  }
  return { adds, dels };
}

// A connector's tool, mcp__<server>__<tool>, as people name it. Claude
// Desktop's connectors are servers named by an id, so the service name falls
// back to the tool's own prefix ("notion-search" is Notion).
export function mcpName(full: string): { name: string; service: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(full);
  if (!m) return null;
  const [, server, tool] = m;
  const opaque = /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(server) || /^[0-9a-f]{8}-/i.test(server);
  const fromTool = /^([a-z]+)[-_]/i.exec(tool)?.[1];
  const raw = opaque ? (fromTool ?? 'Connector') : server.replace(/^ccd_/, '');
  const service = raw.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return { name: tool.replace(/[-_]+/g, ' '), service };
}
