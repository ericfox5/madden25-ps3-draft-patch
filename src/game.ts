// The Madden NFL 25 game-file changes, all computed from the player's own files (nothing from the game ships here):
//  * college names and draft-import codes, in every place Madden keeps its college list
//  * the new-franchise template, grown so a new Connected Franchise holds a 750-prospect class and twice the free agents
import { deflateSync, inflateSync } from 'node:zlib';
import { join } from 'node:path';
import { parseTdb, readBits, serializeTdb, writeBits, type TdbTable } from './tdb/index.js';
import { readEntry, relocateEntry, restoreEntry, rewriteEntry, unrelocateEntry, pathName, type EntryPath } from './archive.js';
import { findTable, growTable, widenArrays } from './frtk.js';
import { scaleFreeAgentLimits } from './free-agent-limits.js';
import collegesJson from '../data/colleges.json';

interface College { coid: number; name: string; stockName: string; stockCoti: number; coti: number }
const want = new Map((collegesJson as { colleges: College[] }).colleges.map((c) => [c.coid, c]));

type Kind = 'tdb' | 'xml' | 'frtk';
interface Target { file: string; index: EntryPath; kind: Kind; what: string }
export const collegeTargets = (usrdir: string): Target[] => [
  { file: join(usrdir, 'QKL_BOOT.AST'), index: 404, kind: 'tdb', what: 'college table + draft-import codes' },
  { file: join(usrdir, 'QKL_BOOT.AST'), index: 732, kind: 'tdb', what: 'college names (copy 2)' },
  { file: join(usrdir, 'QKL_FE2IG.AST'), index: 3928, kind: 'tdb', what: 'college names (copy 3)' },
  { file: join(usrdir, 'QKL_INTERFACE.AST'), index: [1458, 624], kind: 'tdb', what: 'college names (copy 4)' },
  { file: join(usrdir, 'QKL_MISC.AST'), index: 2936, kind: 'frtk', what: 'franchise college names (player cards)' },
  { file: join(usrdir, 'QKL_MISC.AST'), index: 2937, kind: 'xml', what: 'franchise college source file' },
];
export const TEMPLATE = (usrdir: string) => ({ file: join(usrdir, 'QKL_MISC.AST'), index: 2934 });

// ---- COLL tables ----
const STOCK_COTI = { bitOffset: 232, bits: 8 }, WIDE_COTI = { bitOffset: 266, bits: 10 };
function widenCoti(t: TdbTable): number {
  // COTI is 8 bits at bit 232; codes past 255 need more. Every row has 22 zero bits after COID (bits 265..286), so the
  // definition moves to bit 266 with 10 bits (the low byte stays at 232 for any reader with the old layout).
  const k = t.fields.findIndex((f) => f.name === 'COTI'), f = t.fields[k]!;
  if (f.bitOffset === WIDE_COTI.bitOffset && f.bits === WIDE_COTI.bits) return 0;
  if (f.bitOffset !== STOCK_COTI.bitOffset || f.bits !== STOCK_COTI.bits) throw new Error(`COLL.COTI is ${f.bits} bits at ${f.bitOffset}; not the stock layout`);
  for (let i = 0; i < t.recordCount; i++) {
    const base = i * t.header.lengthBytes * 8;
    if (readBits(t.data, base + WIDE_COTI.bitOffset, WIDE_COTI.bits)) throw new Error(`COLL row ${i}: bits ${WIDE_COTI.bitOffset}+ are not free`);
    writeBits(t.data, base + WIDE_COTI.bitOffset, WIDE_COTI.bits, readBits(t.data, base + STOCK_COTI.bitOffset, STOCK_COTI.bits));
  }
  const dv = new DataView(t.fieldDefsRaw.buffer, t.fieldDefsRaw.byteOffset, t.fieldDefsRaw.byteLength);
  dv.setUint32(k * 16 + 4, WIDE_COTI.bitOffset, false); dv.setUint32(k * 16 + 12, WIDE_COTI.bits, false);
  f.bitOffset = WIDE_COTI.bitOffset; f.bits = WIDE_COTI.bits;
  return 1;
}
function patchTdb(bytes: Buffer): { bytes: Uint8Array; diffs: number } {
  const file = parseTdb(new Uint8Array(bytes)); const t = file.table('COLL'); const hasCoti = t.fieldMap.has('COTI');
  let diffs = hasCoti ? widenCoti(t) : 0;
  for (let i = 0; i < t.recordCount; i++) {
    const c = want.get(Number(t.get(i, 'COID'))); if (!c) throw new Error(`college ${t.get(i, 'COID')} unknown`);
    if (String(t.get(i, 'CONA')) !== c.name) { t.set(i, 'CONA', c.name); diffs++; }
    if (hasCoti) {
      if (Number(t.get(i, 'COTI')) !== c.coti) { t.set(i, 'COTI', c.coti); diffs++; }
      const low = c.coti > 255 ? 0 : c.coti, at = i * t.header.lengthBytes * 8 + STOCK_COTI.bitOffset;
      if (readBits(t.data, at, 8) !== low) { writeBits(t.data, at, 8, low); diffs++; }
    }
  }
  const out = serializeTdb(file, { padTo: bytes.length });
  if (out.length !== bytes.length) throw new Error(`COLL rewrite changed the entry size`);
  return { bytes: out, diffs };
}
const tdbNames = (b: Buffer) => { const t = parseTdb(new Uint8Array(b)).table('COLL'); return Array.from({ length: t.recordCount }, (_, i) => ({ coid: Number(t.get(i, 'COID')), name: String(t.get(i, 'CONA')) })); };

// ---- franchise XML (QKL_MISC 2937): Name attributes; a longer name borrows indentation spaces from its own record ----
const RECORD = /<record name="[^"]*\((\d+)\)\.College"[^>]*>([\s\S]*?)<\/record>/g;
const NAME_ATTR = /(<attribute name="Name" value=")([^"]*)(" \/>)/;
const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xmlUnesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function xmlNames(b: Buffer) { const out: Array<{ coid: number; name: string }> = []; for (const m of b.toString('latin1').matchAll(RECORD)) { const n = NAME_ATTR.exec(m[2]!); if (n) out.push({ coid: Number(m[1]), name: xmlUnesc(n[2]!) }); } return out; }
function patchXml(bytes: Buffer): { bytes: Uint8Array; diffs: number } {
  let diffs = 0, seen = 0;
  const out = bytes.toString('latin1').replace(RECORD, (rec, id: string) => {
    seen++;
    const c = want.get(Number(id)); const n = NAME_ATTR.exec(rec);
    if (!c || !n) throw new Error(`franchise XML: college ${id} not understood`);
    const value = xmlEsc(c.name); if (n[2] === value) return rec;
    diffs++;
    let r = rec.slice(0, n.index) + n[1] + value + n[3] + rec.slice(n.index + n[0].length), delta = r.length - rec.length;
    while (delta > 0) {
      const run = [...r.matchAll(/\n( +)</g)].sort((a, b) => b[1]!.length - a[1]!.length)[0];
      if (!run || run[1]!.length <= 1) throw new Error(`franchise XML: no room for "${c.name}"`);
      const take = Math.min(delta, run[1]!.length - 1); r = r.slice(0, run.index! + 1) + r.slice(run.index! + 1 + take); delta -= take;
    }
    if (delta < 0) { const at = r.lastIndexOf('\n'); r = r.slice(0, at + 1) + ' '.repeat(-delta) + r.slice(at + 1); }
    return r;
  });
  if (seen !== want.size) throw new Error(`franchise XML: ${seen} colleges, expected ${want.size}`);
  const b = Buffer.from(out, 'latin1'); if (b.length !== bytes.length) throw new Error('franchise XML changed size');
  return { bytes: b, diffs };
}

// ---- compiled franchise assets (QKL_MISC 2936, a zlib'd FrTk image): CollegeStore rows (16 bytes: name offset in
// word 0, college id in bits 74..82) and their packed names; renames are repacked into the same heap ----
function collegeStore(img: Buffer) {
  const at = img.indexOf('CollegeStore\0', 0, 'latin1'); if (at < 0) throw new Error('no CollegeStore');
  const bsft = at + 0x2c; if (img.toString('latin1', bsft, bsft + 4) !== 'BSFT') throw new Error('CollegeStore: unexpected layout');
  return { bsft, heapAt: bsft + img.readUInt32BE(bsft + 4), heapLen: img.readUInt32BE(at + 0x20), rows: img.readUInt32BE(bsft + 0x10) };
}
const rowAt = (cs: { bsft: number }, r: number) => cs.bsft + 0x50 + 16 * r;
const rowCoid = (img: Buffer, cs: { bsft: number }, r: number) => Number((img.readBigUInt64BE(rowAt(cs, r)) >> 10n) & 0x1ffn);
function frtkNames(entry: Buffer) {
  const img = inflateSync(entry), cs = collegeStore(img);
  return Array.from({ length: cs.rows }, (_, r) => { const o = cs.heapAt + img.readUInt32BE(rowAt(cs, r)); return { coid: rowCoid(img, cs, r), name: img.toString('latin1', o, img.indexOf(0, o)) }; });
}
function patchFrtkImage(entry: Buffer): { image: Buffer; diffs: number } {
  const img = Buffer.from(inflateSync(entry)), cs = collegeStore(img), heap = Buffer.alloc(cs.heapLen); let at = 0, diffs = 0;
  for (let r = 0; r < cs.rows; r++) {
    const c = want.get(rowCoid(img, cs, r)); if (!c) throw new Error('CollegeStore: unknown college');
    const o = cs.heapAt + img.readUInt32BE(rowAt(cs, r));
    if (img.toString('latin1', o, img.indexOf(0, o)) !== c.name) diffs++;
    if (at + c.name.length + 1 > heap.length) throw new Error('CollegeStore: names do not fit');
    img.writeUInt32BE(at, rowAt(cs, r)); heap.write(c.name, at, 'latin1'); at += c.name.length + 1;
  }
  heap.copy(img, cs.heapAt);
  return { image: img, diffs };
}

// write a zlib'd image back: in place when it fits the entry (zero filled after the stream), else appended + repointed
function writeImage(file: string, index: number, image: Buffer, slot: number, backupDir: string): string {
  const z = deflateSync(image, { level: 9 });
  if (z.length <= slot) { const out = Buffer.alloc(slot); z.copy(out); rewriteEntry(file, index, out, backupDir); return 'written'; }
  relocateEntry(file, index, z, backupDir); return 'written (moved to the end of the archive)';
}

const names = (kind: Kind, b: Buffer) => (kind === 'tdb' ? tdbNames(b) : kind === 'xml' ? xmlNames(b) : frtkNames(b));
export function collegeState(t: Target): 'patched' | 'stock' | 'mixed' {
  const rows = names(t.kind, readEntry(t.file, t.index));
  const patched = rows.every((r) => r.name === want.get(r.coid)!.name), stock = rows.every((r) => r.name === want.get(r.coid)!.stockName);
  if (t.kind === 'tdb' && t.index === 404) {
    const tb = parseTdb(new Uint8Array(readEntry(t.file, t.index))).table('COLL');
    const codes = Array.from({ length: tb.recordCount }, (_, i) => Number(tb.get(i, 'COTI')) === want.get(Number(tb.get(i, 'COID')))!.coti).every(Boolean);
    return patched && codes ? 'patched' : stock ? 'stock' : 'mixed';
  }
  return patched ? 'patched' : stock ? 'stock' : 'mixed';
}

export function patchColleges(usrdir: string, backupDir: string, log: (s: string) => void): void {
  for (const t of collegeTargets(usrdir)) {
    const cur = readEntry(t.file, t.index);
    if (t.kind === 'frtk') {
      const p = patchFrtkImage(cur);
      log(p.diffs ? `${t.what}: ${writeImage(t.file, t.index as number, p.image, cur.length, backupDir)}` : `${t.what}: already done`);
      continue;
    }
    const p = t.kind === 'tdb' ? patchTdb(cur) : patchXml(cur);
    log(p.diffs ? `${t.what}: ${rewriteEntry(t.file, t.index, p.bytes, backupDir)}` : `${t.what}: already done`);
  }
}

// ---- new-franchise template (QKL_MISC 2934): the tables a 750-prospect import fills, grown; free agents kept 2x ----
// [table, stock rows, rows, row bytes]
export const GROW: Array<[string, number, number, number]> = [['DraftPlayer', 300, 750, 8], ['DraftBoardPlayerEvaluation', 9600, 24000, 20], ['Player', 3100, 5000, 204],
  ['StaffPersonContractOffer', 300, 750, 16], ['CareerDefensiveKPReturnStats', 300, 750, 40]];
export function growImage(image: Buffer, log: (s: string) => void, faFactor = 2): Buffer {
  let img = image;
  for (const [name, stock, rows, rec] of GROW) {
    const t = findTable(img, name, stock, rec);
    if (t.cap >= rows) continue;
    if (t.used < t.cap) { let ends = 0; for (let r = 0; r < t.cap; r++) if (img.readUInt32BE(t.bsft + t.dataStart + r * t.rec) === t.cap) ends++; if (!ends) throw new Error(`${name}: free rows not understood`); }
    img = growTable(img, t, rows);
    const after = findTable(img, name, rows, rec);
    if (after.cap !== rows || img.readUInt32BE(after.bsft + after.dataStart + (rows - 1) * after.rec) !== rows) throw new Error(`${name}: grow check failed`);
    log(`  ${name}: ${t.cap} -> ${rows} rows`);
  }
  img = widenArrays(img, [300, 600], 750).image;
  const fa = scaleFreeAgentLimits(img, faFactor);
  if (fa.changed) log(`  free agents kept each offseason: ${fa.was}x -> ${faFactor}x the stock limit`);
  return img;
}
export function templateGrown(usrdir: string): boolean {
  const { file, index } = TEMPLATE(usrdir);
  return findTable(inflateSync(readEntry(file, index)), 'Player', 3100, 204).cap >= 5000;
}
export function patchTemplate(usrdir: string, backupDir: string, log: (s: string) => void): void {
  const { file, index } = TEMPLATE(usrdir);
  const cur = readEntry(file, index), before = inflateSync(cur);
  const img = growImage(Buffer.from(before), log);
  if (img.equals(before)) { log('new-franchise template: already done'); return; }
  log(`new-franchise template: ${writeImage(file, index, img, cur.length, backupDir)}`);
}

export function restoreGame(usrdir: string, backupDir: string, log: (s: string) => void): void {
  for (const t of [...collegeTargets(usrdir), { ...TEMPLATE(usrdir), kind: 'frtk' as Kind, what: 'new-franchise template' }, { file: join(usrdir, 'QKL_BOOT.AST'), index: 56, kind: 'frtk' as Kind, what: 'player portraits' }]) {
    const undone = (typeof t.index === 'number' && unrelocateEntry(t.file, t.index, backupDir)) || restoreEntry(t.file, t.index, backupDir);
    log(`${t.what}: ${undone ? 'restored' : `no backup for entry ${pathName(t.index)} (left as is)`}`);
  }
}

