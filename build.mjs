// Builds dist/madden25-draft-patch.exe: bundles src/main.ts (with data/ inlined) using esbuild and injects it into a
// copy of node.exe as a single executable application (Node SEA). Writes the exe's SHA-256 next to it.
//   npm run build
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist'); fs.mkdirSync(dist, { recursive: true });
const run = (cmd, a) => { const r = spawnSync(cmd, a, { cwd: root, stdio: 'inherit', shell: false }); if (r.status !== 0) throw new Error(`${cmd} ${a.join(' ')} failed`); };

// the draft class save files have no extension; load everything under data/draft-class as bytes
const draftFiles = { name: 'draft-files', setup(b) { b.onLoad({ filter: /draft-class[\\/]BLUS31159-/ }, (a) => ({ contents: fs.readFileSync(a.path), loader: 'binary' })); } };
const bundle = path.join(dist, 'main.cjs');
await build({ entryPoints: [path.join(root, 'src', 'main.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: bundle, logLevel: 'warning', legalComments: 'none', loader: { '.yml': 'text', '.json': 'json' }, plugins: [draftFiles] });

const cfg = path.join(dist, 'sea-config.json'), blob = path.join(dist, 'sea-prep.blob');
fs.writeFileSync(cfg, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }));
run(process.execPath, ['--experimental-sea-config', cfg]);
const exe = path.join(dist, 'madden25-draft-patch.exe');
fs.copyFileSync(process.execPath, exe);
run(process.execPath, [path.join(root, 'node_modules', 'postject', 'dist', 'cli.js'), exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2']);
for (const f of [cfg, blob]) fs.rmSync(f);
const sha = createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
fs.writeFileSync(`${exe}.sha256`, `${sha} *${path.basename(exe)}\n`);
console.log(`${exe}\nsha256 ${sha}`);
