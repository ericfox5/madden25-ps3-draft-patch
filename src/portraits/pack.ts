// Madden NFL 25's player portraits: QKL_BOOT.AST entry 56, a stored BGFA archive of zlib'd DDS files. Its TOC
// records (17 bytes) are a flag byte, an 8-byte key (portrait id u32 LE + group hash 02a7d8b4), then offset (3 bytes,
// in 2^byte(0x26) units), stored size (2 bytes, so at most 65,535) and size delta (3 bytes). Records are sorted by
// key and preceded by a constant 4-byte prefix; data follows the TOC in record order.
import { deflateSync, inflateSync } from 'node:zlib';

export interface Portrait { id: number; flag: number; group: Buffer; blob: Buffer; usize: number }
export interface Pack { header: Buffer; prefix: Buffer; items: Map<number, Portrait> }

export function readPack(b: Buffer): Pack {
  if (b.toString('latin1', 0, 8) !== 'BGFA1.05') throw new Error('portrait pack: not a BGFA archive');
  const count = b.readUInt32LE(0x0c), tocOff = b.readUInt32LE(0x10), tocSize = b.readUInt32LE(0x18);
  const offW = b[0x23]!, csW = b[0x24]!, deltaW = b[0x25]!, unit = 2 ** b[0x26]!, start = b.readUInt32LE(0x28) * 4;
  const rec = (tocSize - start) / count;
  if (rec !== 17 || offW !== 3 || csW !== 2 || deltaW !== 3 || start !== 4) throw new Error('portrait pack: unexpected layout');
  const t = b.subarray(tocOff, tocOff + tocSize), n = (p: number, w: number) => { let v = 0; for (let i = w - 1; i >= 0; i--) v = v * 256 + t[p + i]!; return v; };
  const items = new Map<number, Portrait>();
  for (let k = 0; k < count; k++) {
    const r = start + k * rec, off = n(r + 9, 3) * unit, cs = n(r + 12, 2), usize = cs + n(r + 14, 3);
    items.set(t.readUInt32LE(r + 1), { id: t.readUInt32LE(r + 1), flag: t[r]!, group: Buffer.from(t.subarray(r + 5, r + 9)), blob: Buffer.from(b.subarray(off, off + cs)), usize });
  }
  return { header: Buffer.from(b.subarray(0, 0x40)), prefix: Buffer.from(t.subarray(0, start)), items };
}

export const ddsOf = (p: Portrait) => (p.blob.length === p.usize ? p.blob : inflateSync(p.blob));

// add or replace one portrait (a 65,664-byte DDS); the stored form is zlib'd like Madden's own
export function setPortrait(pack: Pack, id: number, dds: Buffer): void {
  if (id < 1 || id > 8191) throw new Error(`portrait id ${id} is outside 1..8191`);
  const z = deflateSync(dds, { level: 9 });
  if (z.length > 0xffff) throw new Error(`portrait ${id}: compressed to ${z.length} bytes, over the 65,535 limit`);
  const any = pack.items.values().next().value as Portrait;
  pack.items.set(id, { id, flag: any.flag, group: any.group, blob: z, usize: dds.length });
}

// Lay the archive out again. Offsets use 16-byte units (3-byte fields: up to 256 MB) so it can grow past Madden's 128 MB.
export function writePack(pack: Pack): Buffer {
  const list = [...pack.items.values()].sort((a, b) => a.id - b.id);
  const unitExp = 4, unit = 16, rec = 17;
  const tocSize = pack.prefix.length + list.length * rec;
  let at = Math.ceil((0x40 + tocSize) / unit) * unit;
  const offs = list.map((p) => { const o = at; at = Math.ceil((at + p.blob.length) / unit) * unit; return o; });
  const end = offs.length ? offs.at(-1)! + list.at(-1)!.blob.length : at;
  if (end / unit >= 2 ** 24) throw new Error('portrait pack: too big for 3-byte offsets');
  const out = Buffer.alloc(end);
  pack.header.copy(out, 0, 0, 0x40);
  out.writeUInt32LE(list.length + 1, 0x08); out.writeUInt32LE(list.length, 0x0c); out.writeUInt32LE(0x40, 0x10); out.writeUInt32LE(tocSize, 0x18);
  out[0x26] = unitExp;
  pack.prefix.copy(out, 0x40);
  list.forEach((p, k) => {
    const r = 0x40 + pack.prefix.length + k * rec;
    out[r] = p.flag; out.writeUInt32LE(p.id, r + 1); p.group.copy(out, r + 5);
    out.writeUIntLE(offs[k]! / unit, r + 9, 3); out.writeUInt16LE(p.blob.length, r + 12); out.writeUIntLE(p.usize - p.blob.length, r + 14, 3);
    p.blob.copy(out, offs[k]!);
  });
  return out;
}
