// Madden NFL 25 (BLUS31178) BGFA 1.05 archives (QKL_*.AST). Header: entry count u32 @0x0c, TOC offset @0x10 and size
// @0x18; byte widths of a record's offset @0x23, stored size @0x24 and size delta (unpacked - stored) @0x25; offsets
// count in 2^byte(0x26) units; records start 4 * word(0x28) bytes into the TOC and end with offset, stored size, delta.
// Entries can be archives themselves; an entry path like [1458, 624] walks into one (every level stored).
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync, writeSync } from 'node:fs';
import { basename, join } from 'node:path';

export interface Entry { index: number; off: number; csize: number; usize: number }
export type EntryPath = number | number[];
export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const pathOf = (p: EntryPath) => (Array.isArray(p) ? p : [p]);
export const pathName = (p: EntryPath) => pathOf(p).join('-');

interface Layout { count: number; tocOff: number; tocSize: number; offW: number; csW: number; deltaW: number; unit: number; start: number; rec: number }
function layout(fd: number, base: number): Layout {
  const head = Buffer.alloc(0x40); readSync(fd, head, 0, 0x40, base);
  if (head.toString('latin1', 0, 8) !== 'BGFA1.05') throw new Error('not a BGFA 1.05 archive');
  const count = head.readUInt32LE(0x0c), tocOff = head.readUInt32LE(0x10), tocSize = head.readUInt32LE(0x18);
  const start = head.readUInt32LE(0x28) * 4, rec = count ? (tocSize - start) / count : 0;
  if (!Number.isInteger(rec)) throw new Error(`TOC of ${tocSize} bytes does not hold ${count} whole records`);
  return { count, tocOff, tocSize, offW: head[0x23]!, csW: head[0x24]!, deltaW: head[0x25]!, unit: 2 ** head[0x26]!, start, rec };
}

// the TOC of the archive whose header sits at file offset `base` (entry offsets returned are absolute)
export function toc(fd: number, base = 0): Entry[] {
  const L = layout(fd, base);
  const t = Buffer.alloc(L.tocSize); readSync(fd, t, 0, L.tocSize, base + L.tocOff);
  const n = (p: number, w: number) => { let v = 0; for (let i = w - 1; i >= 0; i--) v = v * 256 + t[p + i]!; return v; };
  const out: Entry[] = [];
  for (let k = 0; k < L.count; k++) {
    let q = L.start + k * L.rec + L.rec - L.offW - L.csW - L.deltaW;
    const off = n(q, L.offW) * L.unit; q += L.offW; const csize = n(q, L.csW); q += L.csW; const usize = csize + n(q, L.deltaW);
    out.push({ index: k, off: base + off, csize, usize });
  }
  return out;
}

function locate(fd: number, path: EntryPath): Entry {
  let base = 0, e: Entry | undefined;
  for (const index of pathOf(path)) {
    e = toc(fd, base)[index];
    if (!e) throw new Error(`no entry ${pathName(path)}`);
    if (e.csize !== e.usize) throw new Error(`entry ${pathName(path)} is compressed; not rewritable in place`);
    base = e.off;
  }
  return e!;
}

export function readEntry(archive: string, path: EntryPath): Buffer {
  const fd = openSync(archive, 'r');
  try { const e = locate(fd, path); const b = Buffer.alloc(e.csize); readSync(fd, b, 0, e.csize, e.off); return b; } finally { closeSync(fd); }
}

const backupName = (archive: string, path: EntryPath) => `${basename(archive)}.${pathName(path)}.orig`;

// Rewrite a stored entry with same-length bytes. The bytes it held before the first rewrite go to
// <backupDir>/<archive>.<path>.orig (kept if already there); the write is read back and undone on a mismatch.
export function rewriteEntry(archive: string, path: EntryPath, bytes: Uint8Array, backupDir: string): 'written' | 'already' {
  const fd = openSync(archive, 'r+');
  try {
    const e = locate(fd, path);
    if (bytes.length !== e.csize) throw new Error(`entry ${pathName(path)} is ${e.csize} bytes; rewrite is ${bytes.length}`);
    const cur = Buffer.alloc(e.csize); readSync(fd, cur, 0, e.csize, e.off);
    if (cur.equals(Buffer.from(bytes))) return 'already';
    mkdirSync(backupDir, { recursive: true });
    const backup = join(backupDir, backupName(archive, path));
    if (!existsSync(backup)) writeFileSync(backup, cur);
    writeSync(fd, bytes, 0, bytes.length, e.off);
    const back = Buffer.alloc(e.csize); readSync(fd, back, 0, e.csize, e.off);
    if (!back.equals(Buffer.from(bytes))) { writeSync(fd, cur, 0, cur.length, e.off); throw new Error(`entry ${pathName(path)}: read-back mismatch, original restored`); }
    return 'written';
  } finally { closeSync(fd); }
}

// Put an entry rewritten by rewriteEntry back from its backup. false when there is no backup.
export function restoreEntry(archive: string, path: EntryPath, backupDir: string): boolean {
  const backup = join(backupDir, backupName(archive, path));
  if (!existsSync(backup)) return false;
  const fd = openSync(archive, 'r+');
  try { const e = locate(fd, path); const b = readFileSync(backup); if (b.length !== e.csize) throw new Error(`${backup}: wrong size`); writeSync(fd, b, 0, b.length, e.off); } finally { closeSync(fd); }
  return true;
}

// A top-level stored entry that has to grow: append the new bytes (aligned) to the end of the archive and point its TOC
// record there. The old bytes stay where they were, so the backup is just the original TOC record.
export function relocateEntry(archive: string, index: number, bytes: Uint8Array, backupDir: string): void {
  const fd = openSync(archive, 'r+');
  try {
    const L = layout(fd, 0), at = L.tocOff + L.start + index * L.rec;
    const r = Buffer.alloc(L.rec); readSync(fd, r, 0, L.rec, at);
    const q = L.rec - L.offW - L.csW - L.deltaW;
    const num = (o: number, w: number) => { let v = 0; for (let i = w - 1; i >= 0; i--) v = v * 256 + r[o + i]!; return v; };
    if (num(q + L.offW + L.csW, L.deltaW) !== 0) throw new Error(`entry ${index} is compressed; not relocatable`);
    mkdirSync(backupDir, { recursive: true });
    const backup = join(backupDir, `${basename(archive)}.${index}.toc.orig`);
    if (!existsSync(backup)) writeFileSync(backup, JSON.stringify({ at, record: r.toString('hex') }));
    const size = fstatSync(fd).size, end = Math.ceil(size / L.unit) * L.unit;
    if (end / L.unit >= 2 ** (8 * L.offW) || bytes.length >= 2 ** (8 * L.csW)) throw new Error('the relocated entry does not fit the TOC field widths');
    if (end > size) writeSync(fd, Buffer.alloc(end - size), 0, end - size, size);
    writeSync(fd, bytes, 0, bytes.length, end);
    const put = (o: number, w: number, v: number) => { for (let i = 0; i < w; i++) { r[o + i] = v % 256; v = Math.floor(v / 256); } };
    put(q, L.offW, end / L.unit); put(q + L.offW, L.csW, bytes.length);
    writeSync(fd, r, 0, L.rec, at);
  } finally { closeSync(fd); }
  if (!readEntry(archive, index).equals(Buffer.from(bytes))) throw new Error(`entry ${index}: relocated bytes do not read back`);
}

// Undo relocateEntry: put the original TOC record back (the appended bytes stay in the file, unreferenced).
export function unrelocateEntry(archive: string, index: number, backupDir: string): boolean {
  const backup = join(backupDir, `${basename(archive)}.${index}.toc.orig`);
  if (!existsSync(backup)) return false;
  const { at, record } = JSON.parse(readFileSync(backup, 'utf8')) as { at: number; record: string };
  const fd = openSync(archive, 'r+');
  try { const r = Buffer.from(record, 'hex'); writeSync(fd, r, 0, r.length, at); } finally { closeSync(fd); }
  return true;
}
