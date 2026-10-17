// Locate Bambu Studio and its presets, and flatten them: the slicer CLI does
// not follow `inherits` when a preset file is loaded directly (the bed would
// fall back to 200x200 mm, for example), so each preset is merged with its
// parents into one standalone file.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const KINDS = ['machine', 'process', 'filament'];

function appData() {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

/** Slicing engine shipped inside CajuCAD (build/slicer-engine, packed as resources/slicer). */
function bundledDir() {
  const candidates = [
    process.env.OPENCAD_ENGINE_DIR,
    process.resourcesPath && path.join(process.resourcesPath, 'slicer'),
    path.join(__dirname, '..', 'build', 'slicer-engine'),
  ].filter(Boolean);
  return candidates.find((d) => fs.existsSync(path.join(d, 'bambu-studio.exe'))) ?? null;
}

/** A Bambu Studio installed on this computer. */
function installedDir() {
  const candidates = [
    process.env.OPENCAD_BAMBU_STUDIO_DIR,
    path.join(process.env.ProgramFiles || 'C:\Program Files', 'Bambu Studio'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Bambu Studio'),
  ].filter(Boolean);
  return candidates.find((d) => fs.existsSync(path.join(d, 'bambu-studio.exe'))) ?? null;
}

let engineCache;
/**
 * Which slicer to use: the installed Bambu Studio when there is one (its presets
 * are kept up to date by Studio), otherwise the engine bundled with CajuCAD.
 * OPENCAD_PREFER_BUNDLED=1 forces the bundled one (testing).
 */
function engine() {
  if (engineCache !== undefined) return engineCache;
  const bundled = bundledDir();
  const installed = installedDir();
  const pick = process.env.OPENCAD_PREFER_BUNDLED && bundled ? 'bundled' : installed ? 'installed' : bundled ? 'bundled' : null;
  if (!pick) return (engineCache = null);
  const dir = pick === 'bundled' ? bundled : installed;
  const downloaded = path.join(appData(), 'BambuStudio', 'system', 'BBL');
  const root = pick === 'installed' && fs.existsSync(downloaded) ? downloaded : path.join(dir, 'resources', 'profiles', 'BBL');
  return (engineCache = { kind: pick === 'bundled' ? 'bundled' : 'studio', dir, exe: path.join(dir, 'bambu-studio.exe'), root });
}

const findExe = () => engine()?.exe ?? null;
const presetRoot = () => engine()?.root ?? null;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

// name -> file, per kind (preset names are what `inherits` refers to).
const indexCache = new Map();
function nameIndex(kind) {
  if (indexCache.has(kind)) return indexCache.get(kind);
  const root = presetRoot();
  const map = new Map();
  if (root) {
    const dir = path.join(root, kind);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      // File names equal preset names in the system bundle; avoids parsing hundreds of files.
      map.set(f.slice(0, -5), path.join(dir, f));
    }
  }
  indexCache.set(kind, map);
  return map;
}

/** Merge a preset with all its ancestors (child wins). */
function flatten(kind, name, depth = 0) {
  const file = nameIndex(kind).get(name);
  if (!file) throw new Error(`Preset não encontrado: ${kind}/${name}`);
  const own = readJson(file);
  if (!own.inherits || depth > 8) return own;
  const parent = flatten(kind, own.inherits, depth + 1);
  return { ...parent, ...own };
}

function listPrinters() {
  const names = [...nameIndex('machine').keys()].filter((n) => / 0\.4 nozzle$/.test(n));
  return names.map((n) => n.replace(/ 0\.4 nozzle$/, '')).sort();
}

/** Short model key used in names like "... @BBL A1": the part after the last "Bambu Lab ". */
const modelKey = (printer) => printer.replace(/^Bambu Lab /, '');

function listProcesses(printer) {
  const key = modelKey(printer);
  return [...nameIndex('process').keys()].filter((n) => n.endsWith(`@BBL ${key}`)).sort();
}

function listFilaments(printer) {
  const key = modelKey(printer);
  return [...nameIndex('filament').keys()].filter((n) => n.endsWith(`@BBL ${key}`)).sort();
}

/** Which printer the user selected in Bambu Studio (falls back to the A1). */
function studioPrinter() {
  try {
    const conf = JSON.parse(fs.readFileSync(path.join(appData(), 'BambuStudio', 'BambuStudio.conf'), 'utf8'));
    const m = conf?.presets?.machine;
    if (m) return m.replace(/ \d(\.\d+)? nozzle$/, '');
  } catch {
    /* no Studio config yet */
  }
  return 'Bambu Lab A1';
}

/** Bed plate selected in Studio (conf stores an index: 1 = first plate type). */
function studioBedType(types) {
  try {
    const conf = JSON.parse(fs.readFileSync(path.join(appData(), 'BambuStudio', 'BambuStudio.conf'), 'utf8'));
    const i = Number(conf.curr_bed_type);
    if (i >= 1 && i <= types.length) return types[i - 1];
  } catch {
    /* no Studio config */
  }
  return 'Textured PEI Plate';
}

/**
 * Write flattened machine/process/filament presets to `dir` and return the
 * paths in the form the CLI expects. Filament colour/type are overridden.
 */
function writeFlatPresets(dir, { printer, process: processName, filaments, processOverrides = {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const out = { machine: '', process: '', filaments: [] };

  const m = flatten('machine', `${printer} 0.4 nozzle`);
  delete m.inherits;
  out.machine = path.join(dir, 'machine.json');
  fs.writeFileSync(out.machine, JSON.stringify(m));

  const p = { ...flatten('process', processName), ...processOverrides };
  delete p.inherits;
  out.process = path.join(dir, 'process.json');
  fs.writeFileSync(out.process, JSON.stringify(p));

  filaments.forEach((f, i) => {
    const preset = flatten('filament', f.preset);
    delete preset.inherits;
    if (f.color) {
      preset.default_filament_colour = [f.color];
      preset.filament_colour = [f.color];
    }
    const file = path.join(dir, `filament${i + 1}.json`);
    fs.writeFileSync(file, JSON.stringify(preset));
    out.filaments.push(file);
  });
  return out;
}

module.exports = { engine, findExe, presetRoot, listPrinters, listProcesses, listFilaments, studioPrinter, studioBedType, writeFlatPresets, flatten };
