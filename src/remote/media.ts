// Images and files from sessions, for paired phones. A transcript names each
// picture or file by a media id; the phone asks /api/media/<id> for it.
//
// An id carries its own reference (which file, and for an image stored in a
// session file, which line and block) and an HMAC of it under a key kept in
// ~/.switchboard/remote/media.key. The hub serves only references it signed,
// so a phone can fetch what a session it can read refers to, and nothing
// else on the disk. Ids stay valid across restarts because the key does.
//
// HTML is served with a sandbox policy: it runs in an origin of its own,
// without the device cookie, and cannot call the hub or anywhere else.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readJson, writeJson } from '../storage';
import { arr, obj, str, type Rec } from './jsonl';
import { remoteDir } from './pairing';

// A file on disk, or an image stored inline in a session file: the line
// starting at byte `o`, and the path to the block within the record.
export type MediaRef = { p: string } | { f: string; o: number; b: number[] };

export const MAX_BYTES = 50 * 1024 * 1024;
const MAX_LINE = 64 * 1024 * 1024;

let key: Buffer | null = null;
function signingKey(): Buffer {
  if (key) return key;
  const file = path.join(remoteDir(), 'media.key');
  try {
    key = Buffer.from(String(obj(readJson(file)).key), 'hex');
    if (key.length === 32) return key;
  } catch {
    // None yet.
  }
  key = randomBytes(32);
  writeJson(file, { key: key.toString('hex') });
  return key;
}

const sign = (body: string): string => createHmac('sha256', signingKey()).update(body).digest('base64url').slice(0, 32);

export function mediaId(ref: MediaRef): string {
  const body = Buffer.from(JSON.stringify(ref)).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function resolveMedia(id: string): MediaRef | null {
  const [body, mac] = id.split('.');
  if (!body || !mac) return null;
  const want = Buffer.from(sign(body));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const ref = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as MediaRef;
    return 'p' in ref || 'f' in ref ? ref : null;
  } catch {
    return null;
  }
}

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.json': 'application/json',
};

export type MediaKind = 'image' | 'html' | 'pdf' | 'text' | 'other';

export function kindOf(name: string): MediaKind {
  const type = TYPES[path.extname(name).toLowerCase()] ?? '';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('text/html')) return 'html';
  if (type === 'application/pdf') return 'pdf';
  if (type.startsWith('text/') || type === 'application/json') return 'text';
  return 'other';
}

// Who may load what the hub serves. HTML gets a sandbox of its own; images
// and other files are not run at all.
export const HTML_POLICY =
  "sandbox allow-scripts allow-popups; default-src 'none'; script-src 'unsafe-inline' https:; " +
  "style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob:; connect-src 'none'";

export interface MediaBody {
  type: string;
  name: string;
  size: number;
  // A file on disk opens only when it is sent: a HEAD request, or a caller
  // that only wanted its size, then holds no open stream whose error, from
  // a file that vanished meanwhile, nobody would hear.
  body: Buffer | (() => fs.ReadStream);
}

function readLine(file: string, offset: number): string | null {
  const fd = fs.openSync(file, 'r');
  try {
    const chunks: Buffer[] = [];
    let at = offset;
    let total = 0;
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const n = fs.readSync(fd, buffer, 0, buffer.length, at);
      if (n <= 0) break;
      const end = buffer.subarray(0, n).indexOf(10);
      chunks.push(Buffer.from(buffer.subarray(0, end < 0 ? n : end)));
      total += end < 0 ? n : end;
      if (end >= 0 || total > MAX_LINE) break;
      at += n;
    }
    return total > MAX_LINE ? null : Buffer.concat(chunks).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// An image block inside a record, by its path of indices: [block] in the
// message content, or [block, inner] inside a tool result's content.
function blockAt(record: Rec, at: number[]): Rec | null {
  let blocks = arr(obj(record.message).content);
  let block: Rec | null = null;
  for (const i of at) {
    block = obj(blocks[i]);
    blocks = arr(block.content);
  }
  return block;
}

export function readMedia(ref: MediaRef): MediaBody | null {
  if ('p' in ref) {
    let st: fs.Stats;
    try {
      st = fs.statSync(ref.p);
    } catch {
      return null;
    }
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    return {
      type: TYPES[path.extname(ref.p).toLowerCase()] ?? 'application/octet-stream',
      name: path.basename(ref.p),
      size: st.size,
      body: () => fs.createReadStream(ref.p),
    };
  }
  let line: string | null;
  try {
    line = readLine(ref.f, ref.o);
  } catch {
    return null;
  }
  if (!line) return null;
  let record: Rec;
  try {
    record = obj(JSON.parse(line));
  } catch {
    return null;
  }
  const source = obj(blockAt(record, ref.b)?.source);
  const data = str(source.data);
  if (source.type !== 'base64' || !data) return null;
  const body = Buffer.from(data, 'base64');
  const type = str(source.media_type) ?? 'image/png';
  return { type, name: `image${type === 'image/jpeg' ? '.jpg' : '.png'}`, size: body.length, body };
}
