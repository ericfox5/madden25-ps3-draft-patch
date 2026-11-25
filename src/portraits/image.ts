// Headshot photos -> Madden NFL 25 portraits: 256x256 RGBA, DXT5 (BC3), no mipmaps, transparent background
// (65,664-byte DDS: a 128-byte header + 65,536 bytes of blocks). Madden's own portraits put the top of the head at
// y = 60 with the head about 81 px wide 40 px below that; photos are scaled and placed to match.
import { PNG } from 'pngjs';

export interface Rgba { w: number; h: number; px: Uint8Array }
export const SIZE = 256, HEAD_TOP = 60, HEAD_WIDTH = 81;

export function decodePng(b: Buffer): Rgba { const p = PNG.sync.read(b); return { w: p.width, h: p.height, px: new Uint8Array(p.data.buffer, p.data.byteOffset, p.data.length) }; }
export function encodePng(img: Rgba): Buffer { const p = new PNG({ width: img.w, height: img.h }); Buffer.from(img.px).copy(p.data); return PNG.sync.write(p); }

const alphaAt = (img: Rgba, x: number, y: number) => img.px[(y * img.w + x) * 4 + 3]!;
function topRow(img: Rgba): number { for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) if (alphaAt(img, x, y) > 128) return y; return -1; }
function widthAt(img: Rgba, y: number): { w: number; cx: number } {
  y = Math.min(img.h - 1, Math.max(0, Math.round(y)));
  let a = -1, b = -1; for (let x = 0; x < img.w; x++) if (alphaAt(img, x, y) > 128) { if (a < 0) a = x; b = x; }
  return a < 0 ? { w: 0, cx: img.w / 2 } : { w: b - a + 1, cx: (a + b) / 2 };
}

// bilinear sample with premultiplied alpha (no dark fringes)
function sample(img: Rgba, x: number, y: number, out: number[]) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  out[0] = out[1] = out[2] = out[3] = 0;
  for (const [dx, dy, wgt] of [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)], [0, 1, (1 - fx) * fy], [1, 1, fx * fy]] as const) {
    const sx = x0 + dx, sy = y0 + dy; if (sx < 0 || sy < 0 || sx >= img.w || sy >= img.h || !wgt) continue;
    const o = (sy * img.w + sx) * 4, a = img.px[o + 3]! / 255;
    out[0]! += img.px[o]! * a * wgt; out[1]! += img.px[o + 1]! * a * wgt; out[2]! += img.px[o + 2]! * a * wgt; out[3]! += a * wgt;
  }
}
// box-filtered resample (several samples per destination pixel when shrinking)
export function framePortrait(src: Rgba): Rgba {
  const top = topRow(src); if (top < 0) throw new Error('empty photo');
  // scale so the head is HEAD_WIDTH wide 40 px (in the result) below the top of the head; two passes settle it
  let s = 0.5; for (let i = 0; i < 3; i++) { const m = widthAt(src, top + 40 / s).w; if (m > 0) s = HEAD_WIDTH / m; }
  const cx = widthAt(src, top + 40 / s).cx;
  // a photo that ends above the bottom edge moves up (head top no higher than y = 40) so more of the frame is filled
  const headTop = HEAD_TOP - Math.max(0, Math.min(20, SIZE - (HEAD_TOP + (src.h - top) * s)));
  const out: Rgba = { w: SIZE, h: SIZE, px: new Uint8Array(SIZE * SIZE * 4) };
  const n = Math.max(1, Math.min(4, Math.ceil(1 / s))), acc = [0, 0, 0, 0], tmp = [0, 0, 0, 0];
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    acc[0] = acc[1] = acc[2] = acc[3] = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const sx = cx + ((x + (i + 0.5) / n) - SIZE / 2) / s, sy = top + ((y + (j + 0.5) / n) - headTop) / s;
      // below the photo stays transparent (stretching its last row streaks)
      sample(src, sx, sy, tmp); for (let k = 0; k < 4; k++) acc[k]! += tmp[k]!;
    }
    const a = acc[3]! / (n * n), o = (y * SIZE + x) * 4;
    out.px[o + 3] = Math.round(a * 255);
    if (a > 0) for (let k = 0; k < 3; k++) out.px[o + k] = Math.min(255, Math.round(acc[k]! / (n * n) / a));
  }
  return out;
}

// ---- DXT5 (BC3) ----
const to565 = (r: number, g: number, b: number) => ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
const from565 = (c: number): [number, number, number] => { const r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31; return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)]; };
function encodeBlock(p: Uint8Array, out: Buffer, at: number) {
  // alpha: 8-value palette between the block's min and max
  let amin = 255, amax = 0; for (let i = 0; i < 16; i++) { const a = p[i * 4 + 3]!; if (a < amin) amin = a; if (a > amax) amax = a; }
  out[at] = amax; out[at + 1] = amin;
  let abits = 0n;
  if (amax > amin) {
    const pal = [amax, amin]; for (let k = 1; k < 7; k++) pal.push(Math.round(((7 - k) * amax + k * amin) / 7));
    for (let i = 0; i < 16; i++) { const a = p[i * 4 + 3]!; let best = 0, bd = 1e9; for (let k = 0; k < 8; k++) { const d = Math.abs(pal[k]! - a); if (d < bd) { bd = d; best = k; } } abits |= BigInt(best) << BigInt(3 * i); }
  }
  for (let k = 0; k < 6; k++) out[at + 2 + k] = Number((abits >> BigInt(8 * k)) & 0xffn);
  // colour: endpoints from the bounding box of the visible pixels, inset by 1/16
  const mn = [255, 255, 255], mx = [0, 0, 0]; let seen = 0;
  for (let i = 0; i < 16; i++) { if (p[i * 4 + 3]! < 16) continue; seen++; for (let k = 0; k < 3; k++) { const v = p[i * 4 + k]!; if (v < mn[k]!) mn[k] = v; if (v > mx[k]!) mx[k] = v; } }
  if (!seen) { out.writeUInt16LE(0, at + 8); out.writeUInt16LE(0, at + 10); out.writeUInt32LE(0, at + 12); return; }
  for (let k = 0; k < 3; k++) { const inset = (mx[k]! - mn[k]!) >> 4; mn[k] = Math.min(255, mn[k]! + inset); mx[k] = Math.max(0, mx[k]! - inset); }
  let c0 = to565(mx[0]!, mx[1]!, mx[2]!), c1 = to565(mn[0]!, mn[1]!, mn[2]!);
  if (c0 < c1) [c0, c1] = [c1, c0];
  out.writeUInt16LE(c0, at + 8); out.writeUInt16LE(c1, at + 10);
  if (c0 === c1) { out.writeUInt32LE(0, at + 12); return; }
  const e0 = from565(c0), e1 = from565(c1);
  const pal = [e0, e1, e0.map((v, k) => Math.round((2 * v + e1[k]!) / 3)), e0.map((v, k) => Math.round((v + 2 * e1[k]!) / 3))];
  let cbits = 0;
  for (let i = 0; i < 16; i++) {
    let best = 0, bd = 1e9;
    for (let k = 0; k < 4; k++) { const q = pal[k]!; const d = (q[0]! - p[i * 4]!) ** 2 + (q[1]! - p[i * 4 + 1]!) ** 2 + (q[2]! - p[i * 4 + 2]!) ** 2; if (d < bd) { bd = d; best = k; } }
    cbits |= best << (2 * i);
  }
  out.writeUInt32LE(cbits >>> 0, at + 12);
}
// A DDS with the given 128-byte header (taken from one of Madden's own portraits) and the image's DXT5 blocks
export function toDds(img: Rgba, header: Buffer): Buffer {
  if (img.w !== SIZE || img.h !== SIZE || header.length !== 128) throw new Error('portraits are 256x256');
  const out = Buffer.alloc(128 + SIZE * SIZE); header.copy(out);
  const blk = new Uint8Array(64); let at = 128;
  for (let by = 0; by < SIZE; by += 4) for (let bx = 0; bx < SIZE; bx += 4) {
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) { const s = ((by + j) * SIZE + bx + i) * 4, d = (j * 4 + i) * 4; for (let k = 0; k < 4; k++) blk[d + k] = img.px[s + k]!; }
    encodeBlock(blk, out, at); at += 16;
  }
  return out;
}
