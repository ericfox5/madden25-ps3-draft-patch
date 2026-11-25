// Madden NFL 25 Connected Franchise save (BLUS31178-CAREER-*): USR-DATA = zlib(FrTk image), zero-padded to 3 MB;
// HED-DATA word at 0x34 = compressed length. The FrTk image is a 0x80-byte header, 8-byte entries up to the first table,
// then table chunks back to back:
//   name (0x80 bytes, NUL padded) | typeId, 0, 0x40, 1 | 'SPBF' block (0x2c: ..., typeId @+0x10, capacity @+0x14,
//   BSFT length @+0x1c) | 'BSFT' body
// BSFT body: 'BSFT', length @+4, length2 @+8, field count @+0xc, capacity @+0x10, data start in words @+0x18,
// rows used @+0x1c, then the rows. A free row's first word is the index of the next free row; the chain ends at the
// capacity. Rows are (length - dataStart) / capacity bytes; length2 - length is a per-row string area (Player: 89 bytes).
import { inflateSync, deflateSync } from 'node:zlib';

export interface FrTkTable { name: string; typeId: number; at: number; spbf: number; bsft: number; len: number; len2: number; cap: number; used: number; dataStart: number; rec: number; strRec: number; end: number }

export function parseFrTk(u: Buffer): FrTkTable[] {
  if (u.toString('latin1', 0, 4) !== 'FrTk') throw new Error('not an FrTk image');
  const out: FrTkTable[] = [];
  let spbf = u.indexOf('SPBF', 0, 'latin1');
  let at = spbf - 0x90;
  while (at >= 0 && at + 0x90 < u.length) {
    spbf = at + 0x90;
    if (u.toString('latin1', spbf, spbf + 4) !== 'SPBF') throw new Error(`no SPBF at ${spbf.toString(16)}`);
    let name = ''; for (let k = 0; k < 0x80 && u[at + k]; k++) name += String.fromCharCode(u[at + k]!);
    const bsft = spbf + 0x2c;
    if (u.toString('latin1', bsft, bsft + 4) !== 'BSFT') throw new Error(`${name}: no BSFT at ${bsft.toString(16)}`);
    const w = (k: number) => u.readUInt32BE(bsft + k);
    const len = w(4), len2 = w(8), cap = w(0x10), dataStart = w(0x18) * 4;
    const rec = cap ? (len - dataStart) / cap : 0, strRec = cap ? (len2 - len) / cap : 0;
    const end = bsft + len + u.readUInt32BE(spbf + 0x20);
    out.push({ name, typeId: u.readUInt32BE(spbf + 0x10), at, spbf, bsft, len, len2, cap, used: w(0x1c), dataStart, rec, strRec, end });
    at = end;
    if (at >= u.length || u.toString('latin1', at + 0x90, at + 0x94) !== 'SPBF') break;
  }
  return out;
}

// A table chunk by exact name (the name block starts the chunk and SPBF follows at +0x90). physicalRows is the row
// count the body really holds: the stored capacity can be larger when the 600-prospect patch's load hook raised it
// without allocating, so it is taken from the lengths, as the given candidate that divides both the record and the
// string area evenly (the stock capacity).
// rec: the table's row size in bytes when known (then the row count is simply body / rec, whatever the header says).
export function findTable(u: Buffer, name: string, stockCap: number, rec?: number): FrTkTable {
  const needle = Buffer.concat([Buffer.from(name, 'latin1'), Buffer.alloc(1)]);
  for (let i = u.indexOf(needle); i >= 0; i = u.indexOf(needle, i + 1)) {
    const spbf = i + 0x90;
    if (u.toString('latin1', spbf, spbf + 4) !== 'SPBF') continue;
    let full = ''; for (let k = 0; k < 0x80 && u[i + k]; k++) full += String.fromCharCode(u[i + k]!);
    if (full !== name) continue;
    const bsft = spbf + 0x2c, w = (k: number) => u.readUInt32BE(bsft + k);
    const len = w(4), len2 = w(8), dataStart = w(0x18) * 4;
    let cap = stockCap;
    if (rec) {
      if ((len - dataStart) % rec !== 0) throw new Error(`${name}: body ${len - dataStart} bytes is not a whole number of ${rec}-byte rows`);
      cap = (len - dataStart) / rec;
    } else for (const c of [stockCap, w(0x10)]) if (c && (len - dataStart) % c === 0 && (len2 - len) % c === 0 && (len - dataStart) / c >= 4) { cap = c; break; }
    if ((len - dataStart) % cap !== 0) throw new Error(`${name}: body ${len - dataStart} bytes is not a whole number of ${cap} rows`);
    return { name, typeId: u.readUInt32BE(spbf + 0x10), at: i, spbf, bsft, len, len2, cap, used: w(0x1c), dataStart, rec: (len - dataStart) / cap, strRec: (len2 - len) / cap, end: bsft + len + u.readUInt32BE(spbf + 0x20) };
  }
  throw new Error(`no table ${name}`);
}

// Grow one table to newCap rows. Chunk layout (from the game's builder 0x9dd224 and the stock saves):
//   BSFT body: header + row area, `len` bytes (BSFT+4); SPBF+0x1c repeats len
//   data heap: SPBF+0x20 bytes right after the body (0 for most tables); fixed-size records, one per row, in use up to
//              len2 (BSFT+8) = len + rows x recordBytes, the rest zero slack; the next chunk starts at body + heap
// Appended rows chain to the next index (the last to newCap); appended records are zero; the heap grows to fit.
export function growTable(u: Buffer, t: FrTkTable, newCap: number): Buffer {
  if (newCap <= t.cap) return u;
  if (!Number.isInteger(t.rec) || !Number.isInteger(t.strRec)) throw new Error(`${t.name}: rows are not a whole number of bytes`);
  const extra = newCap - t.cap;
  const rows = Buffer.alloc(extra * t.rec);
  for (let k = 0; k < extra; k++) rows.writeUInt32BE(t.cap + k + 1, k * t.rec);
  const heap = u.readUInt32BE(t.spbf + 0x20);
  const usedData = t.len2 - t.len, newData = newCap * t.strRec;
  if (usedData > heap) throw new Error(`${t.name}: data in use (${usedData}) exceeds the heap (${heap})`);
  const newHeap = Math.max(heap, newData);
  const bodyEnd = t.bsft + t.len, chunkEnd = bodyEnd + heap;
  const data = Buffer.alloc(newHeap); u.copy(data, 0, bodyEnd, bodyEnd + usedData);
  const out = Buffer.concat([u.subarray(0, bodyEnd), rows, data, u.subarray(chunkEnd)]);
  const len = t.len + rows.length, len2 = len + newData;
  out.writeUInt32BE(len, t.bsft + 4); out.writeUInt32BE(len2, t.bsft + 8); out.writeUInt32BE(newCap, t.bsft + 0x10);
  out.writeUInt32BE(newCap, t.spbf + 0x14); out.writeUInt32BE(len, t.spbf + 0x1c); out.writeUInt32BE(newHeap, t.spbf + 0x20);
  return out;
}

// Array stores: 'ASTO' header (0x2c: ..., typeId @+0x10, rows @+0x14, elements @+0x18, CMPC length @+0x1c) followed by a
// 'CMPC' body: length @+4 and +8, words per row @+0xc, rows @+0x10, elements @+0x14, header words @+0x18 (0x20 + 4
// per row), then rows x words-per-row data words. Widens every single-row array of `from` 32-bit elements to `to`,
// appending zero elements. Returns the new image and the type ids changed.
export function widenArrays(u: Buffer, from: number | number[], to: number): { image: Buffer; changed: number[] } {
  const changed: number[] = [];
  const froms = Array.isArray(from) ? from : [from];
  let out = u;
  for (let i = out.indexOf('ASTO', 0, 'latin1'); i >= 0; i = out.indexOf('ASTO', i + 1, 'latin1')) {
    const c = i + 0x2c;
    if (out.toString('latin1', c, c + 4) !== 'CMPC') continue;
    const A = (k: number) => out.readUInt32BE(i + 4 * k), C = (k: number) => out.readUInt32BE(c + 4 * k);
    const rows = A(5), elems = A(6), len = C(1), wpr = C(3);
    if (rows !== 1 || !froms.includes(elems) || wpr !== elems || C(4) !== 1 || C(5) !== elems || len !== C(6) * 4 + wpr * 4 || A(7) !== len) continue;
    const extra = Buffer.alloc((to - elems) * 4);
    out = Buffer.concat([out.subarray(0, c + len), extra, out.subarray(c + len)]);
    const nlen = len + extra.length;
    out.writeUInt32BE(to, i + 0x18); out.writeUInt32BE(nlen, i + 0x1c);
    out.writeUInt32BE(nlen, c + 4); out.writeUInt32BE(nlen, c + 8); out.writeUInt32BE(to, c + 0xc); out.writeUInt32BE(to, c + 0x14);
    changed.push(A(4));
  }
  return { image: out, changed };
}

export function readSave(usr: Buffer): Buffer { return inflateSync(usr); }
export function writeSave(image: Buffer, size: number): { usr: Buffer; compressed: number } {
  const z = deflateSync(image, { level: 6 });
  if (z.length > size) throw new Error(`compressed franchise is ${z.length} bytes; the save holds ${size}`);
  const usr = Buffer.alloc(size); z.copy(usr);
  return { usr, compressed: z.length };
}
