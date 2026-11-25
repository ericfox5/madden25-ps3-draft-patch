// Real player portraits: ESPN headshots for the roster save's NFL players and the draft class's college prospects,
// converted to Madden portraits, added to the portrait pack, and pointed at from the roster and franchise saves.
//   roster save  PLAY.PSXP (13 bits)
//   franchise    Player row (204 bytes): the low 13 bits of the big-endian word at byte 84
// Portrait ids: first ones the pack does not use, then ones no save points at. state.json keeps each player's id so
// later runs reuse it (and only fetch what is new).
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseTdb, serializeTdb } from '../tdb/index.js';
import { readEntry, relocateEntry } from '../archive.js';
import { findTable, readSave, writeSave } from '../frtk.js';
import { decodePng, framePortrait, toDds } from './image.js';
import { ddsOf, readPack, setPortrait, writePack } from './pack.js';
import { Espn, normName, normTeam, pool, TEAM_ALIASES, type Athlete } from './espn.js';
import collegesJson from '../../data/colleges.json';

const PACK_ENTRY = 56, MAX_ID = 8191;
type Log = (s: string) => void;
interface State { ids: Record<string, number>; written: Record<string, string> }

interface RosterSave { dir: string; tdb: ReturnType<typeof parseTdb>; rows: Array<{ i: number; first: string; last: string; team: string }> }
interface FranchiseSave { dir: string; img: Buffer; base: number; heap: number; cap: number }

const colleges = collegesJson as unknown as { modTeams: Array<{ tgid: number; name: string }>; fbs: Array<{ code: number; name: string }>; small: Array<{ code: number; name: string }> };
const schoolOf = new Map<number, string>([...colleges.modTeams.map((t) => [t.tgid, t.name] as const), ...colleges.fbs.map((t) => [t.code, t.name] as const), ...colleges.small.map((t) => [t.code, t.name] as const)]);

function readRosters(savedata: string[]): RosterSave[] {
  const out: RosterSave[] = [];
  for (const s of savedata) for (const f of readdirSync(s).filter((n) => n.startsWith('BLUS31178-ROSTER-'))) {
    const dir = join(s, f);
    try {
      const tdb = parseTdb(new Uint8Array(readFileSync(join(dir, 'USR-DATA')))); const p = tdb.table('PLAY'), t = tdb.table('TEAM');
      const team = new Map<number, string>(); for (let i = 0; i < t.recordCount; i++) team.set(Number(t.get(i, 'TGID')), String(t.get(i, 'TDNA')));
      out.push({ dir, tdb, rows: Array.from({ length: p.recordCount }, (_, i) => ({ i, first: String(p.get(i, 'PFNA')), last: String(p.get(i, 'PLNA')), team: team.get(Number(p.get(i, 'TGID'))) ?? '' })) });
    } catch { /* not a roster we can read */ }
  }
  return out;
}
function readFranchises(savedata: string[]): FranchiseSave[] {
  const out: FranchiseSave[] = [];
  for (const s of savedata) for (const f of readdirSync(s).filter((n) => n.startsWith('BLUS31178-CAREER-'))) {
    const dir = join(s, f);
    try { const img = readSave(readFileSync(join(dir, 'USR-DATA'))); const p = findTable(img, 'Player', 3100, 204); out.push({ dir, img, base: p.bsft + p.dataStart, heap: p.bsft + p.len, cap: p.cap }); } catch { /* skip */ }
  }
  return out;
}
const cstr = (b: Buffer, o: number, n: number) => { let s = ''; for (let k = 0; k < n && b[o + k]; k++) s += String.fromCharCode(b[o + k]!); return s; };
const franchiseName = (f: FranchiseSave, r: number) => ({ first: cstr(f.img, f.heap + r * 89, 14), last: cstr(f.img, f.heap + r * 89 + 14, 20) });
const franchiseLive = (f: FranchiseSave, r: number) => { const o = f.base + r * 204; for (let k = 4; k < 204; k++) if (f.img[o + k]) return true; return false; };

// draft class rows (the NCAA 14 export): name, school, OVR
function classRows(usr: Buffer) {
  const g = (o: number, n: number) => cstr(usr, o, n);
  return Array.from({ length: 1600 }, (_, r) => { const o = r * 0x474; return { first: g(o + 4, 12), last: g(o + 16, 14), school: schoolOf.get(usr.readUInt16BE(o + 2)) ?? '', ovr: usr[o + 0x54]! }; }).filter((x) => x.last);
}
// truncated NCAA names ("HonoreJr") still match "Brook Honore Jr."
const sameName = (aFirst: string, aLast: string, full: string) => {
  const n = normName(full).replace(/ /g, ''), f = normName(aFirst).replace(/ /g, ''), l = normName(aLast).replace(/ /g, '');
  return n === f + l || (n.startsWith(f) && n.slice(f.length).startsWith(l) && l.length >= 4);
};
const sameSchool = (a: string, b: string) => { const x = normTeam(a), y = normTeam(b); return !!x && !!y && (x.includes(y) || y.includes(x)); };

// Custom portraits: <customDir>/<First Last>.dds (a 256x256 DXT5 DDS, used as is) or .png (framed like the ESPN photos
// unless it is already 256x256). Each goes to every roster and franchise player with that name.
function readCustom(customDir: string | undefined, log: Log): Array<{ name: string; dds: Buffer | null; png: Buffer | null }> {
  if (!customDir || !existsSync(customDir)) return [];
  const out: Array<{ name: string; dds: Buffer | null; png: Buffer | null }> = [];
  for (const f of readdirSync(customDir)) {
    const m = /^(.+)\.(dds|png)$/i.exec(f); if (!m) continue;
    const b = readFileSync(join(customDir, f)), name = m[1]!.replace(/[-_]headshot$/i, '').replace(/[-_]+/g, ' ');
    if (m[2]!.toLowerCase() === 'dds') {
      if (b.length !== 65664 || b.toString('latin1', 0, 4) !== 'DDS ' || b.readUInt32LE(12) !== 256 || b.readUInt32LE(16) !== 256 || b.toString('latin1', 84, 88) !== 'DXT5') { log(`  ${f}: skipped (needs a 256x256 DXT5 DDS without mipmaps, 65,664 bytes)`); continue; }
      out.push({ name, dds: b, png: null });
    } else out.push({ name, dds: null, png: b });
  }
  return out;
}

export async function runPortraits(o: { usrdir: string; savedata: string[]; backupDir: string; draftClass: Buffer; customDir?: string; log: Log }): Promise<void> {
  const { usrdir, savedata, backupDir, log } = o;
  const dir = join(backupDir, 'portraits'); mkdirSync(dir, { recursive: true });
  const statePath = join(dir, 'state.json');
  const state: State = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { ids: {}, written: {} };
  // downloads are cached outside the RPCS3 folder (often synced): %LOCALAPPDATA%/madden25-draft-patch/portrait-cache
  const espn = new Espn(join(process.env.LOCALAPPDATA ?? dir, ...(process.env.LOCALAPPDATA ? ['madden25-draft-patch', 'portrait-cache'] : ['cache'])));
  const boot = join(usrdir, 'QKL_BOOT.AST');
  const pack = readPack(readEntry(boot, PACK_ENTRY));
  const ddsHeader = ddsOf(pack.items.get(233) ?? [...pack.items.values()][1]!).subarray(0, 128);

  const rosters = readRosters(savedata), franchises = readFranchises(savedata);
  log(`roster saves: ${rosters.length}, franchise saves: ${franchises.length}, portraits in the game: ${pack.items.size}`);

  // ---- who gets which photo ----
  const want = new Map<string, Athlete>();        // key -> athlete (key = nfl:<espn id> | cfb:<espn id>)
  const rosterKey = new Map<string, string>();     // "<roster dir>#<row>" -> key
  const nameKey = new Map<string, string | null>(); // normalized full name -> key (null when two players share it)
  const noteName = (first: string, last: string, key: string) => { const n = normName(`${first} ${last}`); nameKey.set(n, nameKey.has(n) && nameKey.get(n) !== key ? null : key); };

  log('looking up NFL players on ESPN...');
  const nfl = await espn.nflRosters();
  const byTeamName = new Map(nfl.map((a) => [`${normTeam(a.team)}|${normName(a.name)}`, a]));
  const byName = new Map<string, Athlete | null>(); for (const a of nfl) { const k = normName(a.name); byName.set(k, byName.has(k) ? null : a); }
  const unmatched: Array<{ r: RosterSave; row: RosterSave['rows'][number] }> = [];
  for (const r of rosters) for (const row of r.rows) {
    const n = normName(`${row.first} ${row.last}`), t = normTeam(row.team), team = TEAM_ALIASES[t] ?? t;
    const a = byTeamName.get(`${team}|${n}`) ?? byName.get(n) ?? undefined;
    if (a) { const key = `nfl:${a.id}`; want.set(key, a); rosterKey.set(`${r.dir}#${row.i}`, key); noteName(row.first, row.last, key); } else unmatched.push({ r, row });
  }
  log(`  ${rosterKey.size} roster players matched on team rosters; searching for ${unmatched.length} more (free agents and others)...`);
  await pool(unmatched, 3, async ({ r, row }) => {
    const hits = (await espn.search(`${row.first} ${row.last}`, 'nfl')).filter((a) => normName(a.name) === normName(`${row.first} ${row.last}`));
    if (hits.length !== 1) return;
    const key = `nfl:${hits[0]!.id}`; want.set(key, hits[0]!); rosterKey.set(`${r.dir}#${row.i}`, key); noteName(row.first, row.last, key);
  }, (d) => log(`    ${d} / ${unmatched.length}`));
  log(`  roster players with an ESPN photo: ${rosterKey.size}`);

  // draft prospects: the ones already in a franchise, else the class's best 750
  const cls = classRows(o.draftClass);
  const inFranchise = new Set<string>(); for (const f of franchises) for (let r = 0; r < f.cap; r++) { const { first, last } = franchiseName(f, r); if (last) inFranchise.add(normName(`${first} ${last}`)); }
  let prospects = cls.filter((c) => inFranchise.has(normName(`${c.first} ${c.last}`)));
  if (prospects.length < 100) prospects = [...cls].sort((a, b) => b.ovr - a.ovr).slice(0, 750);
  log(`looking up ${prospects.length} draft prospects on ESPN...`);
  const prospectKey = new Map<string, string>();
  await pool(prospects, 3, async (c) => {
    const hits = (await espn.search(`${c.first} ${c.last}`, 'college-football')).filter((a) => sameName(c.first, c.last, a.name));
    const pick = hits.filter((a) => sameSchool(a.team, c.school)); const a = pick.length === 1 ? pick[0] : hits.length === 1 && !c.school ? hits[0] : pick[0];
    if (!a) return;
    const key = `cfb:${a.id}`; want.set(key, a); prospectKey.set(normName(`${c.first} ${c.last}`), key);
  }, (d) => log(`    ${d} / ${prospects.length}`));
  log(`  prospects with an ESPN photo: ${prospectKey.size} of ${prospects.length}`);
  if (espn.failedSearches) log(`  ESPN turned away ${espn.failedSearches} searches (busy); run this again later to fill those in`);

  // custom photos win over ESPN for the same name
  const custom = readCustom(o.customDir, log), customFiles = new Map<string, { dds: Buffer | null; png: Buffer | null }>();
  for (const c of custom) {
    const key = `custom:${normName(c.name)}`; customFiles.set(key, c);
    want.set(key, { id: key, name: c.name, team: '', headshot: `custom:${createHash('sha1').update(c.dds ?? c.png!).digest('hex')}` });
    nameKey.set(normName(c.name), key); prospectKey.delete(normName(c.name));
    for (const [rk, k] of rosterKey) if (k !== key) { const [d, i] = rk.split('#'); const r = rosters.find((x) => x.dir === d); const row = r?.rows[Number(i)]; if (row && normName(`${row.first} ${row.last}`) === normName(c.name)) rosterKey.set(rk, key); }
    for (const r of rosters) for (const row of r.rows) if (normName(`${row.first} ${row.last}`) === normName(c.name)) rosterKey.set(`${r.dir}#${row.i}`, key);
  }
  if (custom.length) log(`custom portraits: ${custom.map((c) => c.name).join(', ')}`);

  // ---- ids ----
  const owned = new Set(Object.values(state.ids));
  const referenced = new Set<number>();
  for (const r of rosters) { const p = r.tdb.table('PLAY'); for (let i = 0; i < p.recordCount; i++) referenced.add(Number(p.get(i, 'PSXP'))); }
  for (const f of franchises) for (let r = 0; r < f.cap; r++) if (franchiseLive(f, r)) referenced.add(f.img.readUInt32BE(f.base + r * 204 + 84) & 0x1fff);
  const free: number[] = [];
  for (let id = 1; id <= MAX_ID; id++) if (!pack.items.has(id) && !owned.has(id)) free.push(id);
  const reusable: number[] = []; for (const id of [...pack.items.keys()].sort((a, b) => b - a)) if (id > 0 && !owned.has(id) && !referenced.has(id)) reusable.push(id);
  for (const key of want.keys()) if (state.ids[key] === undefined) {
    const id = free.shift() ?? reusable.shift(); if (id === undefined) { log('out of portrait ids; the rest keep their current faces'); break; }
    state.ids[key] = id;
  }

  // ---- photos -> portraits ----
  const jobs = [...want.entries()].filter(([key, a]) => state.ids[key] !== undefined && state.written[key] !== a.headshot);
  log(`converting ${jobs.length} photos (${want.size - jobs.length} already done)...`);
  let failed = 0;
  await pool(jobs, 6, async ([key, a]) => {
    try {
      const c = customFiles.get(key);
      if (c?.dds) { setPortrait(pack, state.ids[key]!, c.dds); state.written[key] = a.headshot; return; }
      const png = c?.png ?? await espn.image(a.headshot); if (!png) { failed++; return; }
      const img = decodePng(png);
      setPortrait(pack, state.ids[key]!, toDds(c && img.w === 256 && img.h === 256 ? img : framePortrait(img), ddsHeader)); state.written[key] = a.headshot;
    } catch { failed++; }
  }, (d) => log(`    ${d} / ${jobs.length}`));
  if (failed) log(`  ${failed} photos could not be used`);
  if (jobs.length) {
    const bytes = writePack(pack);
    relocateEntry(boot, PACK_ENTRY, bytes, backupDir);
    log(`portrait pack: ${pack.items.size} portraits (${(bytes.length / 1048576).toFixed(0)} MB)`);
  }
  writeFileSync(statePath, JSON.stringify(state));
  const idOf = (key: string | undefined | null) => (key && state.written[key] ? state.ids[key] : undefined);

  // ---- saves ----
  const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const backupSave = (d: string) => { const b = join(backupDir, 'saves', `${d.split(/[\\/]/).pop()}-${stamp}`); mkdirSync(b, { recursive: true }); cpSync(d, b, { recursive: true }); };
  for (const r of rosters) {
    const p = r.tdb.table('PLAY'); let n = 0;
    for (const row of r.rows) { const id = idOf(rosterKey.get(`${r.dir}#${row.i}`)); if (id !== undefined && Number(p.get(row.i, 'PSXP')) !== id) { p.set(row.i, 'PSXP', id); n++; } }
    if (!n) continue;
    const usr = readFileSync(join(r.dir, 'USR-DATA')); backupSave(r.dir);
    writeFileSync(join(r.dir, 'USR-DATA'), serializeTdb(r.tdb, { padTo: usr.length }));
    log(`${r.dir.split(/[\\/]/).pop()}: ${n} portraits set`);
  }
  for (const f of franchises) {
    let n = 0;
    for (let r = 0; r < f.cap; r++) {
      if (!franchiseLive(f, r)) continue;
      const { first, last } = franchiseName(f, r); if (!last) continue;
      const nn = normName(`${first} ${last}`), id = idOf(prospectKey.get(nn) ?? nameKey.get(nn));
      if (id === undefined) continue;
      const at = f.base + r * 204 + 84, w = f.img.readUInt32BE(at);
      if ((w & 0x1fff) !== id) { f.img.writeUInt32BE(((w & ~0x1fff) | id) >>> 0, at); n++; }
    }
    if (!n) continue;
    const usr = readFileSync(join(f.dir, 'USR-DATA')), hed = readFileSync(join(f.dir, 'HED-DATA')); backupSave(f.dir);
    const { usr: out, compressed } = writeSave(f.img, usr.length); const h = Buffer.from(hed); h.writeUInt32BE(compressed, 0x34);
    writeFileSync(join(f.dir, 'USR-DATA'), out); writeFileSync(join(f.dir, 'HED-DATA'), h);
    log(`${f.dir.split(/[\\/]/).pop()}: ${n} portraits set`);
  }
}
