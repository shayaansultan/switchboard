// Pictures and files a paired phone attaches to a reply. The phone uploads
// each one to the hub (POST /api/upload), which keeps it under
// ~/.switchboard/remote/uploads/ and hands back an id; the reply then names
// ids, never paths, so a phone cannot point a session at anything else on the
// disk. control.ts passes the files on: Codex takes a picture as a local
// image of the turn, and Claude gets the paths in the message, which its Read
// tool opens (pictures included), since a plugin cannot attach bytes to a
// prompt.
//
// Uploads are kept for a week, long enough for a session to look at them
// again, and swept when the hub starts.

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { remoteDir } from './pairing';

export const MAX_UPLOAD = 25 * 1024 * 1024;
const KEEP_MS = 7 * 24 * 3600_000;

export interface Upload {
  id: string;
  name: string;
  type: string;
  size: number;
  path: string;
}

const dir = () => path.join(remoteDir(), 'uploads');

// A file name that is safe on disk and still reads as what was sent.
function safeName(name: string): string {
  const base = path
    .basename(name)
    .replace(/[^\w.\- ]+/g, '_')
    .trim();
  // '.' and '..' would name the folder itself or its parent.
  return (/^\.*$/.test(base) ? 'file' : base).slice(0, 120);
}

export function saveUpload(name: string, type: string, body: Buffer): Upload {
  const id = randomUUID();
  const folder = path.join(dir(), id);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, safeName(name));
  fs.writeFileSync(file, body, { mode: 0o600 });
  return { id, name: path.basename(file), type: type || 'application/octet-stream', size: body.length, path: file };
}

// The upload an id names, read back from disk so ids survive a restart.
export function findUpload(id: string): Upload | null {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const folder = path.join(dir(), id);
  let names: string[];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return null;
  }
  const name = names[0];
  if (!name) return null;
  const file = path.join(folder, name);
  const ext = path.extname(name).toLowerCase();
  const image = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic'].includes(ext);
  return {
    id,
    name,
    type: image ? `image/${ext === '.jpg' ? 'jpeg' : ext.slice(1)}` : 'application/octet-stream',
    size: fs.statSync(file).size,
    path: file,
  };
}

export function sweepUploads(now = Date.now()): void {
  let ids: string[];
  try {
    ids = fs.readdirSync(dir());
  } catch {
    return;
  }
  for (const id of ids) {
    const folder = path.join(dir(), id);
    try {
      if (now - fs.statSync(folder).mtimeMs > KEEP_MS) fs.rmSync(folder, { recursive: true, force: true });
    } catch {
      // Gone already.
    }
  }
}
