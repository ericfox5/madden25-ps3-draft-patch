// RPCS3 side: finding the emulator and Madden, merging the PPU patch into RPCS3's patch files, the draft class save,
// and preparing existing franchise saves.
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { findTable, readSave, writeSave } from './frtk.js';
import { growImage, GROW } from './game.js';

export const MADDEN = 'BLUS31178';
export const PATCH_NAME = 'Madden 25: 750-prospect draft class import';

export function isRpcs3(dir: string): boolean { return existsSync(join(dir, 'rpcs3.exe')) && existsSync(join(dir, 'dev_hdd0')); }

// Madden's USRDIR (the folder with QKL_MISC.AST): games.yml entries first, then dev_hdd0/disc
export function findMadden(rpcs3: string): string[] {
  const roots = new Set<string>();
  for (const yml of [join(rpcs3, 'config', 'games.yml'), join(rpcs3, 'games.yml')]) {
    if (!existsSync(yml)) continue;
    for (const line of readFileSync(yml, 'utf8').split(/\r?\n/)) { const m = new RegExp(`^${MADDEN}:\\s*"?(.+?)"?\\s*$`).exec(line); if (m) roots.add(m[1]!.replace(/[\\/]+$/, '')); }
  }
  const disc = join(rpcs3, 'dev_hdd0', 'disc'); if (existsSync(disc)) for (const d of readdirSync(disc)) roots.add(join(disc, d));
  const out: string[] = [];
  for (const r of roots) { const u = join(r, 'PS3_GAME', 'USRDIR'); if (existsSync(join(u, 'QKL_MISC.AST')) && sfoTitleId(join(r, 'PS3_GAME', 'PARAM.SFO')) === MADDEN) out.push(u); }
  return out;
}

export function sfo(file: string): Record<string, string | number> {
  const b = readFileSync(file); const out: Record<string, string | number> = {};
  if (b.readUInt32LE(0) !== 0x46535000) throw new Error(`${file}: not a PARAM.SFO`);
  const kt = b.readUInt32LE(8), dt = b.readUInt32LE(12), n = b.readUInt32LE(16);
  for (let i = 0; i < n; i++) {
    const o = 20 + 16 * i, ko = b.readUInt16LE(o), fmt = b.readUInt16LE(o + 2), len = b.readUInt32LE(o + 4), dofs = b.readUInt32LE(o + 12);
    const key = b.toString('latin1', kt + ko, b.indexOf(0, kt + ko));
    out[key] = fmt === 0x404 ? b.readUInt32LE(dt + dofs) : b.toString('utf8', dt + dofs, dt + dofs + len).replace(/\0+$/, '');
  }
  return out;
}
const sfoTitleId = (f: string) => { try { return String(sfo(f).TITLE_ID); } catch { return ''; } };

// A game update changes the executable, and the patch only matches disc version 01.00.
export function updateWarning(rpcs3: string): string | null {
  const p = join(rpcs3, 'dev_hdd0', 'game', MADDEN, 'PARAM.SFO');
  if (!existsSync(p)) return null;
  const v = String(sfo(p).APP_VER ?? '');
  return existsSync(join(rpcs3, 'dev_hdd0', 'game', MADDEN, 'USRDIR', 'EBOOT.BIN')) ? `a Madden game update (version ${v}) is installed; the patch only works on disc version 01.00` : null;
}

// ---- RPCS3 patch files: our block under the Madden PPU hash, replacing any older copy of it ----
function mergeYaml(text: string, hashLine: string, name: string, block: string | null): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const top = lines.findIndex((l) => l === hashLine);
  if (top < 0) {
    if (!block) return text;
    const body = lines.join('\n').replace(/\n*$/, '\n');
    return `${body}\n${hashLine}\n${block}`;
  }
  let end = top + 1; while (end < lines.length && (lines[end] === '' || lines[end]!.startsWith(' '))) end++;
  const section = lines.slice(top + 1, end), keep: string[] = [];
  for (let i = 0; i < section.length; i++) {
    if (section[i] === `  "${name}":`) { i++; while (i < section.length && (section[i]!.startsWith('    ') || section[i] === '')) i++; i--; continue; }
    keep.push(section[i]!);
  }
  while (keep.length && keep.at(-1) === '') keep.pop();
  const newSection = block ? [...keep, ...block.replace(/\n$/, '').split('\n')] : keep;
  const out = newSection.length ? [...lines.slice(0, top + 1), ...newSection, '', ...lines.slice(end)] : [...lines.slice(0, top), ...lines.slice(end)];
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}
function backupOnce(file: string, backupDir: string) {
  mkdirSync(backupDir, { recursive: true });
  const b = join(backupDir, file.split(/[\\/]/).slice(-2).join('_') + '.orig');
  if (existsSync(file) && !existsSync(b)) copyFileSync(file, b);
}
export function installPatch(rpcs3: string, patchYml: string, backupDir: string): void {
  const hashLine = /^(PPU-[0-9a-f]{40}:)$/m.exec(patchYml)![1]!;
  const block = patchYml.slice(patchYml.indexOf(hashLine) + hashLine.length + 1);
  const imported = join(rpcs3, 'patches', 'imported_patch.yml');
  mkdirSync(dirname(imported), { recursive: true }); backupOnce(imported, backupDir);
  writeFileSync(imported, mergeYaml(existsSync(imported) ? readFileSync(imported, 'utf8') : 'Version: 1.2\n', hashLine, PATCH_NAME, block));
  const config = join(rpcs3, 'config', 'patch_config.yml');
  mkdirSync(dirname(config), { recursive: true }); backupOnce(config, backupDir);
  const enable = `  "${PATCH_NAME}":\n    Madden NFL 25:\n      ${MADDEN}:\n        01.00:\n          Enabled: true\n`;
  writeFileSync(config, mergeYaml(existsSync(config) ? readFileSync(config, 'utf8') : '', hashLine, PATCH_NAME, enable));
}
export function uninstallPatch(rpcs3: string, patchYml: string): void {
  const hashLine = /^(PPU-[0-9a-f]{40}:)$/m.exec(patchYml)![1]!;
  for (const f of [join(rpcs3, 'patches', 'imported_patch.yml'), join(rpcs3, 'config', 'patch_config.yml')])
    if (existsSync(f)) writeFileSync(f, mergeYaml(readFileSync(f, 'utf8'), hashLine, PATCH_NAME, null));
}
export function patchInstalled(rpcs3: string): boolean {
  const f = join(rpcs3, 'config', 'patch_config.yml');
  return existsSync(f) && readFileSync(f, 'utf8').includes(`"${PATCH_NAME}"`) && existsSync(join(rpcs3, 'patches', 'imported_patch.yml')) && readFileSync(join(rpcs3, 'patches', 'imported_patch.yml'), 'utf8').includes(`"${PATCH_NAME}"`);
}

// ---- saves ----
export function savedataDirs(rpcs3: string): string[] {
  const home = join(rpcs3, 'dev_hdd0', 'home'); if (!existsSync(home)) return [];
  return readdirSync(home).filter((u) => /^\d{8}$/.test(u)).map((u) => join(home, u, 'savedata')).filter(existsSync);
}
export function installDraftClass(savedata: string, files: Record<string, Buffer>, folder: string): 'installed' | 'already' | 'updated' {
  const dir = join(savedata, folder);
  const same = existsSync(dir) && Object.entries(files).every(([n, b]) => existsSync(join(dir, n)) && readFileSync(join(dir, n)).equals(b));
  if (same) return 'already';
  const had = existsSync(dir); mkdirSync(dir, { recursive: true });
  for (const [n, b] of Object.entries(files)) writeFileSync(join(dir, n), b);
  return had ? 'updated' : 'installed';
}
export function removeDraftClass(savedata: string, folder: string): boolean { const d = join(savedata, folder); if (!existsSync(d)) return false; rmSync(d, { recursive: true }); return true; }

export interface Franchise { dir: string; name: string; players: number; when: Date }
export function franchises(rpcs3: string): Franchise[] {
  const out: Franchise[] = [];
  for (const s of savedataDirs(rpcs3)) for (const f of readdirSync(s).filter((n) => n.startsWith(`${MADDEN}-CAREER-`))) {
    const dir = join(s, f);
    try { out.push({ dir, name: f.slice(`${MADDEN}-CAREER-`.length), players: findTable(inflateSync(readFileSync(join(dir, 'USR-DATA'))), 'Player', 3100, 204).cap, when: statSync(join(dir, 'USR-DATA')).mtime }); } catch { /* not a readable franchise */ }
  }
  return out.sort((a, b) => b.when.getTime() - a.when.getTime());
}
// Grow one existing franchise save (made before this patch) the same way the template is grown.
export function prepareFranchise(f: Franchise, backupRoot: string, log: (s: string) => void): void {
  const usr = readFileSync(join(f.dir, 'USR-DATA')), hed = readFileSync(join(f.dir, 'HED-DATA'));
  const before = readSave(usr), img = growImage(Buffer.from(before), log);
  if (img.equals(before)) { log(`${f.name}: already prepared`); return; }
  const { usr: out, compressed } = writeSave(img, usr.length);
  const backup = join(backupRoot, 'franchises', `${f.dir.split(/[\\/]/).pop()}-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}`);
  mkdirSync(backup, { recursive: true }); cpSync(f.dir, backup, { recursive: true });
  const h = Buffer.from(hed); h.writeUInt32BE(compressed, 0x34);
  writeFileSync(join(f.dir, 'USR-DATA'), out); writeFileSync(join(f.dir, 'HED-DATA'), h);
  log(`${f.name}: prepared (backup in ${backup})`);
}
export const GROWN_PLAYERS = GROW.find(([n]) => n === 'Player')![2];
