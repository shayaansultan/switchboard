// The tray images are hand-encoded PNGs. Check the encoder produces files
// other readers accept, and that the bars fill the way the numbers say.

import { test, expect } from 'bun:test';
import * as zlib from 'node:zlib';
import { Canvas, meterPng, stripPng, barPng } from '../src/trayart';

function decode(png: Buffer): { width: number; height: number; alpha: (x: number, y: number) => number } {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const idatLen = png.readUInt32BE(33);
  expect(png.subarray(37, 41).toString('ascii')).toBe('IDAT');
  const raw = zlib.inflateSync(png.subarray(41, 41 + idatLen));
  const stride = width * 4 + 1;
  return { width, height, alpha: (x, y) => raw[y * stride + 1 + x * 4 + 3] };
}

test('a canvas encodes to a PNG of its own size with the pixels it was given', () => {
  const c = new Canvas(4, 3);
  c.rect(1, 1, 2, 1, 1);
  const img = decode(c.png());
  expect([img.width, img.height]).toEqual([4, 3]);
  expect(img.alpha(1, 1)).toBe(255);
  expect(img.alpha(2, 1)).toBe(255);
  expect(img.alpha(0, 0)).toBe(0);
  expect(img.alpha(3, 2)).toBe(0);
});

test('the meter is 18pt at 2x, and its fill grows with the number', () => {
  const opaque = (png: Buffer) => {
    const img = decode(png);
    let n = 0;
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) if (img.alpha(x, y) === 255) n++;
    return { n, img };
  };
  const empty = opaque(meterPng([{ fill: 0 }, { fill: 0 }]));
  const half = opaque(meterPng([{ fill: 0.5 }, { fill: 0.5 }]));
  const full = opaque(meterPng([{ fill: 1 }, { fill: 1 }]));
  expect([empty.img.width, empty.img.height]).toEqual([36, 36]);
  expect(empty.n).toBe(0);
  expect(half.n).toBeGreaterThan(0);
  expect(full.n).toBeGreaterThan(half.n * 1.8);
});

test('stale images are drawn fainter, never fully opaque', () => {
  const img = decode(meterPng([{ fill: 1 }], true));
  let max = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) max = Math.max(max, img.alpha(x, y));
  expect(max).toBeLessThan(255);
  expect(max).toBeGreaterThan(0);
});

test('the strip and bar have the sizes the menu expects', () => {
  expect([decode(stripPng([{ fill: 0.3 }])).width, decode(stripPng([{ fill: 0.3 }])).height]).toEqual([32, 32]);
  expect([decode(barPng(0.3)).width, decode(barPng(0.3)).height]).toEqual([80, 32]);
});
