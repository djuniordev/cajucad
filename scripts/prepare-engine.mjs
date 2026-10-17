// Build build/slicer-engine/: the slicing engine of the Bambu Studio installed on
// this computer, trimmed to what the command line needs, so CajuCAD can slice on
// machines where Bambu Studio cannot be installed.
//
// Left out on purpose: the user interface data (images, web, i18n, hms...), the
// WebView2/VC++ installers, and Bambu's proprietary network plugin. CajuCAD talks
// to the printer with its own code and does not need that plugin.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'build', 'slicer-engine');

const candidates = [
  process.env.OPENCAD_BAMBU_STUDIO_DIR,
  path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Bambu Studio'),
  path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Bambu Studio'),
].filter(Boolean);
const src = candidates.find((d) => fs.existsSync(path.join(d, 'bambu-studio.exe')));
if (!src) {
  console.error('Bambu Studio não encontrado. Instale-o neste computador só para montar o pacote (ou defina OPENCAD_BAMBU_STUDIO_DIR).');
  process.exit(1);
}

// resources/* directories the CLI slicer needs. Everything else is GUI-only.
const KEEP_RESOURCES = ['profiles', 'printers', 'data', 'flush', 'filament_mixing', 'shaders', 'info', 'cert', 'profiles_template'];
// Microsoft C++ runtime, deployed next to the executable (app-local) so it also
// runs on a PC where the Visual C++ redistributable was never installed.
const VC_RUNTIME = ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll', 'msvcp140_codecvt_ids.dll', 'concrt140.dll'];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const copyFile = (from, to) => (fs.mkdirSync(path.dirname(to), { recursive: true }), fs.copyFileSync(from, to));

// Root: the launcher, every DLL it links, the mesa software OpenGL used for the plate preview.
for (const f of fs.readdirSync(src, { withFileTypes: true })) {
  if (f.isFile() && !/^uninstall/i.test(f.name) && /\.(exe|dll|txt)$/i.test(f.name)) copyFile(path.join(src, f.name), path.join(out, f.name));
}
fs.cpSync(path.join(src, 'mesa'), path.join(out, 'mesa'), { recursive: true });

for (const d of KEEP_RESOURCES) {
  const from = path.join(src, 'resources', d);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(out, 'resources', d), { recursive: true });
}
// Only Bambu's own printers; other vendors' profiles are not used.
const profiles = path.join(out, 'resources', 'profiles');
for (const e of fs.readdirSync(profiles)) {
  if (e !== 'BBL' && e !== 'BBL.json') fs.rmSync(path.join(profiles, e), { recursive: true, force: true });
}

const sys32 = path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32');
const missing = [];
for (const dll of VC_RUNTIME) {
  const from = path.join(sys32, dll);
  if (fs.existsSync(from)) copyFile(from, path.join(out, dll));
  else missing.push(dll);
}
if (missing.length) console.warn('Aviso: faltam no System32 (instale o Visual C++ 2015-2022 x64):', missing.join(', '));

fs.writeFileSync(
  path.join(out, 'NOTICE-CajuCAD.txt'),
  `Slicing engine bundled with CajuCAD
===================================

This folder contains the command line slicing engine of Bambu Studio, built by
Bambu Lab, copied from an official Bambu Studio installation and trimmed to what
slicing needs. Bambu Studio is free software released under the GNU Affero
General Public License v3.0 (AGPL-3.0), derived from PrusaSlicer, Slic3r and CuraEngine.

  Source code:  https://github.com/bambulab/BambuStudio
  License text: https://github.com/bambulab/BambuStudio/blob/master/LICENSE.txt

CajuCAD starts this engine as a separate program (bambu-studio.exe) and does not
modify it. Components shipped inside it keep their own licenses (see LICENSE.txt in
this folder for MCUT, plus Open CASCADE, FFmpeg and others).

The Microsoft Visual C++ runtime DLLs (vcruntime140, msvcp140, concrt140...) are
redistributed unmodified under the Microsoft Visual C++ Redistributable terms.

Not included: Bambu Lab's proprietary network plugin (bambu_networking.dll).
"Bambu Studio" and "Bambu Lab" are trademarks of Bambu Lab.
`,
);

const size = (d) => fs.readdirSync(d, { withFileTypes: true, recursive: true }).reduce((s, e) => s + (e.isFile() ? fs.statSync(path.join(e.parentPath, e.name)).size : 0), 0);
console.log(`Fatiador preparado em ${out}\n  origem: ${src}\n  tamanho: ${(size(out) / 1048576).toFixed(0)} MB`);
