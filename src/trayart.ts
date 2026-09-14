// Tiny drawn images for the tray: a meter for the status item and a bar
// strip beside each profile row. The main process has no canvas, so these
// are painted pixel by pixel and encoded as PNG by hand (zlib does the
// compression). Everything is drawn in black with alpha and marked as a
// template image, so macOS tints it for light and dark menu bars and dims
// it when the menu is disabled, the same as the system's own icons. This
// module stays free of Electron so it can be exercised without it.

import * as zlib from 'node:zlib';

// ---- a minimal PNG encoder (8-bit RGBA, no filtering) ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export class Canvas {
  readonly px: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.px = new Uint8Array(width * height * 4);
  }

  // Paint one pixel black at the given opacity, compositing over what is there.
  dot(x: number, y: number, alpha: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || alpha <= 0) return;
    const i = (y * this.width + x) * 4;
    const a = Math.min(255, Math.round(alpha * 255));
    const prev = this.px[i + 3];
    this.px[i + 3] = Math.max(prev, a);
  }

  rect(x: number, y: number, w: number, h: number, alpha: number): void {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.dot(i, j, alpha);
  }

  // A horizontal capsule (rounded ends) filled to `fill` of its width from
  // the left, drawn as a faint track with a solid fill, like a progress bar.
  capsule(x: number, y: number, w: number, h: number, fill: number, opts: { track: number; ink: number }): void {
    const r = h / 2;
    const fillW = Math.round(Math.max(0, Math.min(1, fill)) * w);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        // Inside the capsule when the pixel centre is within the rounded ends.
        const cx = i + 0.5;
        const cy = j + 0.5;
        const dx = cx < r ? r - cx : cx > w - r ? cx - (w - r) : 0;
        const dy = cy - r;
        if (dx * dx + dy * dy > r * r) continue;
        this.dot(x + i, y + j, i < fillW ? opts.ink : opts.track);
      }
    }
  }

  png(): Buffer {
    const raw = Buffer.alloc((this.width * 4 + 1) * this.height);
    for (let y = 0; y < this.height; y++) {
      raw[y * (this.width * 4 + 1)] = 0; // filter: none
      Buffer.from(this.px.buffer, y * this.width * 4, this.width * 4).copy(raw, y * (this.width * 4 + 1) + 1);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.width, 0);
    ihdr.writeUInt32BE(this.height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // colour type: RGBA
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}

// ---- the images ----

export interface Lane {
  fill: number; // 0..1, how much of the bar to paint
}

const SCALE = 2; // draw at 2× so it is crisp on Retina menu bars

// The status item: up to two lanes stacked in an 18pt square, like a tiny
// pair of progress bars. `stale` fades the whole thing.
export function meterPng(lanes: Lane[], stale = false): Buffer {
  const size = 18 * SCALE;
  const c = new Canvas(size, size);
  const rows = Math.max(1, Math.min(2, lanes.length));
  const barW = 15 * SCALE;
  const barH = 5 * SCALE;
  const gap = 2 * SCALE;
  const totalH = rows * barH + (rows - 1) * gap;
  const x = Math.round((size - barW) / 2);
  const y0 = Math.round((size - totalH) / 2);
  const dim = stale ? 0.5 : 1;
  for (let r = 0; r < rows; r++) {
    c.capsule(x, y0 + r * (barH + gap), barW, barH, lanes[r].fill, { track: 0.28 * dim, ink: 1 * dim });
  }
  return c.png();
}

// Beside a profile row in the menu: one thin bar per window, up to four,
// in a 16pt square.
export function stripPng(lanes: Lane[], stale = false): Buffer {
  const size = 16 * SCALE;
  const c = new Canvas(size, size);
  const rows = Math.max(1, Math.min(4, lanes.length));
  const barW = 14 * SCALE;
  const barH = 2 * SCALE;
  const gap = 1 * SCALE;
  const totalH = rows * barH + (rows - 1) * gap;
  const x = Math.round((size - barW) / 2);
  const y0 = Math.round((size - totalH) / 2);
  const dim = stale ? 0.5 : 1;
  for (let r = 0; r < rows; r++) {
    c.capsule(x, y0 + r * (barH + gap), barW, barH, lanes[r].fill, { track: 0.28 * dim, ink: 1 * dim });
  }
  return c.png();
}

// A single bar for a window line inside a submenu: wider and thin.
export function barPng(fill: number, stale = false): Buffer {
  const w = 40 * SCALE;
  const h = 16 * SCALE;
  const c = new Canvas(w, h);
  const barH = 4 * SCALE;
  const dim = stale ? 0.5 : 1;
  c.capsule(0, Math.round((h - barH) / 2), w, barH, fill, { track: 0.28 * dim, ink: 1 * dim });
  return c.png();
}
