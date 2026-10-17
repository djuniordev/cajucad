// Build the Windows installer.
//   node scripts/dist.mjs          light installer (uses an installed Bambu Studio to slice)
//   node scripts/dist.mjs --full   complete installer: ships the slicing engine too
//
// The output goes to %LOCALAPPDATA%\cajucad-build because Windows Defender's
// protected folders can block electron-builder from renaming its staging
// directory inside Documents (EPERM).
import { build, Platform } from 'electron-builder';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const full = process.argv.includes('--full');
const release = process.argv.includes('--release');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

if (release) {
  if (!process.env.GH_TOKEN) {
    console.error('Falta o GH_TOKEN (token do GitHub com permissão de escrita em Releases). Veja as instruções antes de publicar.');
    process.exit(1);
  }
  const { owner, repo } = pkg.build.publish[0];
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`, { headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, 'User-Agent': 'cajucad-release' } });
  if (!res.ok) {
    console.error(`Não consegui consultar o GitHub (${res.status}). Confira o token.`);
    process.exit(1);
  }
  if ((await res.json()).some((r) => r.tag_name === `v${pkg.version}`)) {
    console.error(`Já existe uma Release v${pkg.version}. Aumente o "version" no package.json.`);
    process.exit(1);
  }
}
// Separate folders so a running copy of one build never blocks building the other.
let output = path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), full ? 'cajucad-build-completo' : 'cajucad-build');
// A copy of the app running from win-unpacked locks that folder: build somewhere else then.
try {
  fs.rmSync(path.join(output, 'win-unpacked'), { recursive: true, force: true });
} catch {
  output = `${output}-${new Date().toISOString().replace(/\D/g, '').slice(0, 12)}`;
  console.log(`Pasta em uso por um CajuCAD aberto. Gerando em ${output}`);
}

if (full) {
  // Reuse build/slicer-engine when it exists: it may be the only copy left if Bambu
  // Studio was uninstalled. Pass --rebuild-engine to copy it again from an installed Studio.
  const engineExe = path.join(root, 'build', 'slicer-engine', 'bambu-studio.exe');
  if (!fs.existsSync(engineExe) || process.argv.includes('--rebuild-engine')) {
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'prepare-engine.mjs')], { stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status ?? 1);
  } else {
    console.log('Usando o fatiador já preparado em build/slicer-engine.');
  }
}

const config = {
  ...(release ? { publish: [{ ...pkg.build.publish[0], releaseType: 'draft' }] } : {}),
  directories: { output, buildResources: 'build' },
  nsis: { artifactName: full ? 'CajuCAD-Setup-${version}-completo.${ext}' : 'CajuCAD-Setup-${version}.${ext}' },
  ...(full ? { extraResources: [{ from: 'build/slicer-engine', to: 'slicer' }] } : {}),
};

const files = await build({ targets: Platform.WINDOWS.createTarget('nsis'), config, publish: release ? 'always' : 'never' });
const exes = files.filter((f) => f.endsWith('.exe'));
console.log('\nInstalador pronto:');
for (const f of exes) console.log(`  ${f}  (${(fs.statSync(f).size / 1048576).toFixed(0)} MB)`);
if (release) console.log(`
Rascunho criado. Revise e clique em Publish em: https://github.com/${pkg.build.publish[0].owner}/${pkg.build.publish[0].repo}/releases`);
