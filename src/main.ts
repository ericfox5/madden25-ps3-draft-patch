// madden25-draft-patch.exe: installs the Madden NFL 25 (PS3, RPCS3) 750-prospect draft class patch.
//   madden25-draft-patch.exe [RPCS3 folder]
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { collegeState, collegeTargets, patchColleges, patchTemplate, restoreGame, templateGrown } from './game.js';
import {
  findMadden, franchises, GROWN_PLAYERS, installDraftClass, installPatch, isRpcs3, patchInstalled, prepareFranchise, removeDraftClass,
  savedataDirs, uninstallPatch, updateWarning,
} from './rpcs3.js';
import patchYml from '../data/madden-draft-750.yml';
import hed from '../data/draft-class/BLUS31159-DRAFT-FCS2026/HED-DATA';
import icon from '../data/draft-class/BLUS31159-DRAFT-FCS2026/ICON0.PNG';
import sfoFile from '../data/draft-class/BLUS31159-DRAFT-FCS2026/PARAM.SFO';
import usr from '../data/draft-class/BLUS31159-DRAFT-FCS2026/USR-DATA';

const VERSION = '1.0.0';
const DRAFT_FOLDER = 'BLUS31159-DRAFT-FCS2026';
const draftFiles = { 'HED-DATA': Buffer.from(hed), 'ICON0.PNG': Buffer.from(icon), 'PARAM.SFO': Buffer.from(sfoFile), 'USR-DATA': Buffer.from(usr) };

// answers queue up as lines arrive, so typed and piped input both work (readline drops lines nobody is waiting for)
const rl = createInterface({ input: process.stdin, terminal: false });
const lines: string[] = [], waiting: Array<(s: string) => void> = []; let closed = false;
rl.on('line', (l) => { const w = waiting.shift(); if (w) w(l); else lines.push(l); });
rl.on('close', () => { closed = true; for (const w of waiting.splice(0)) w(''); });
const ask = (q: string) => new Promise<string>((res) => {
  process.stdout.write(q);
  if (lines.length) { const l = lines.shift()!; process.stdout.write(`${l}\n`); res(l.trim()); } else if (closed) { process.stdout.write('\n'); res(''); } else waiting.push((l) => res(l.trim()));
});
const log = (s: string) => console.log(s);
async function done(code = 0): Promise<never> { await ask('\nPress Enter to close.'); rl.close(); process.exit(code); }

function rpcs3Running(): boolean {
  try { return /rpcs3\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq rpcs3.exe', '/NH'], { encoding: 'utf8' })); } catch { return false; }
}

async function main() {
  log(`Madden NFL 25 draft class patch ${VERSION} (PS3 / RPCS3)\n`);
  // RPCS3 folder: argument, the exe's folder, the current folder, else ask
  const exeDir = dirname(process.execPath);
  let rpcs3 = [process.argv[2], exeDir, process.cwd()].find((d) => d && isRpcs3(resolve(d)));
  while (!rpcs3) {
    const a = (await ask('Where is RPCS3? Paste the folder that has rpcs3.exe in it: ')).replace(/^"|"$/g, '');
    if (a && isRpcs3(resolve(a))) rpcs3 = a; else log('  rpcs3.exe and dev_hdd0 are not in that folder.');
  }
  rpcs3 = resolve(rpcs3);
  log(`RPCS3:  ${rpcs3}`);
  const games = findMadden(rpcs3);
  if (!games.length) { log('\nMadden NFL 25 (BLUS31178) was not found. Add the game to RPCS3 first (File > Add Games), as a folder, not an ISO.'); return done(1); }
  const usrdir = games[0]!;
  log(`Madden: ${dirname(dirname(usrdir))}`);
  const warn = updateWarning(rpcs3); if (warn) log(`\nWarning: ${warn}.`);
  const backupDir = join(rpcs3, 'madden25-draft-patch-backups');

  const status = () => {
    let colleges = 'not installed';
    try { const s = collegeTargets(usrdir).map(collegeState); colleges = s.every((x) => x === 'patched') ? 'installed' : s.some((x) => x !== 'stock') ? 'partly installed' : 'not installed'; } catch (e) { colleges = `unreadable (${(e as Error).message})`; }
    let template = 'not installed'; try { template = templateGrown(usrdir) ? 'installed' : 'not installed'; } catch { template = 'unreadable'; }
    log(`\n  RPCS3 patch (750 imports, memory)   ${patchInstalled(rpcs3) ? 'installed' : 'not installed'}`);
    log(`  College names + import codes        ${colleges}`);
    log(`  New-franchise template               ${template}`);
    log(`  Draft class save (${DRAFT_FOLDER})  ${savedataDirs(rpcs3).some((s) => existsSync(join(s, DRAFT_FOLDER))) ? 'installed' : 'not installed'}`);
  };
  status();

  if (rpcs3Running()) { log('\nRPCS3 is running. Close it first (the game reads these files at boot).'); await ask('Press Enter once RPCS3 is closed.'); }

  log('\n  1  Install or update everything');
  log('  2  Prepare a franchise made before this patch');
  log('  3  Uninstall (put Madden back to stock)');
  log('  Q  Quit');
  const pick = (await ask('\nChoose [1]: ')).toLowerCase() || '1';

  if (pick === '1') {
    log('');
    installPatch(rpcs3, patchYml, backupDir); log('RPCS3 patch: installed and enabled');
    patchColleges(usrdir, backupDir, log);
    patchTemplate(usrdir, backupDir, log);
    const saves = savedataDirs(rpcs3); if (!saves.length) throw new Error('no dev_hdd0/home/<user>/savedata folder; start RPCS3 once and create a user');
    log(`draft class save: ${installDraftClass(saves[0]!, draftFiles, DRAFT_FOLDER)}`);
    const old = franchises(rpcs3).filter((f) => f.players < GROWN_PLAYERS);
    log('\nDone. Start a new Connected Franchise, then in the regular season import the draft class "FCS2026" from NCAA Football 14.');
    if (old.length) log(`Franchises made before this patch need option 2 once before importing: ${old.map((f) => f.name).join(', ')}`);
    log(`Backups: ${backupDir}`);
  } else if (pick === '2') {
    const list = franchises(rpcs3);
    if (!list.length) { log('No Madden franchise saves found.'); return done(); }
    list.forEach((f, i) => log(`  ${i + 1}  ${f.name.padEnd(20)} ${f.when.toLocaleString()}  ${f.players >= GROWN_PLAYERS ? '(ready)' : ''}`));
    const n = Number(await ask('\nWhich franchise? ')); const f = list[n - 1];
    if (!f) { log('Nothing changed.'); return done(); }
    prepareFranchise(f, backupDir, log);
  } else if (pick === '3') {
    if ((await ask('Put the game files, RPCS3 patch and draft class back to stock? Type YES: ')) !== 'YES') { log('Nothing changed.'); return done(); }
    restoreGame(usrdir, backupDir, log);
    uninstallPatch(rpcs3, patchYml); log('RPCS3 patch: removed');
    for (const s of savedataDirs(rpcs3)) if (removeDraftClass(s, DRAFT_FOLDER)) log('draft class save: removed');
    log('Franchise saves are left as they are (their backups are in the backups folder).');
  }
  return done();
}

main().catch(async (e) => { console.error(`\nError: ${(e as Error).message}`); await done(1); });
