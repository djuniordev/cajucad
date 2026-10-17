// Slicing through the installed Bambu Studio command line. CajuCAD sends the
// objects as STL (world coordinates, mm, already placed on the bed) together
// with the filament of each object; Studio does the slicing and G-code.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { unzipSync, strFromU8 } = require('fflate');
const presets = require('./bambu-presets.cjs');

const BED_TYPES = ['Cool Plate', 'Engineering Plate', 'High Temp Plate', 'Textured PEI Plate', 'Supertack Plate'];

const jobsDir = () => path.join(app.getPath('temp'), 'cajucad-slice');

/** Reduce an object name to something safe for a command line argument. */
const safeName = (s, i) => (String(s).normalize('NFD').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') || 'peca').slice(0, 40) + `_${i + 1}`;

function info() {
  const eng = presets.engine();
  if (!eng) return { available: false };
  const printers = presets.listPrinters();
  const printer = presets.studioPrinter();
  return {
    available: true,
    exe: eng.exe,
    engine: eng.kind,
    printers,
    defaultPrinter: printers.includes(printer) ? printer : printers[0],
    bedTypes: BED_TYPES,
    defaultBedType: presets.studioBedType(BED_TYPES),
  };
}

/** Options that depend on the printer model: bed size, qualities, filament presets. */
function printerInfo(printer) {
  const machine = presets.flatten('machine', `${printer} 0.4 nozzle`);
  const area = (machine.printable_area || []).map((p) => p.split('x').map(Number));
  const xs = area.map((p) => p[0]);
  const ys = area.map((p) => p[1]);
  return {
    bed: { width: Math.max(...xs) - Math.min(...xs), depth: Math.max(...ys) - Math.min(...ys) },
    maxHeight: Number(machine.printable_height) || 250,
    processes: presets.listProcesses(printer),
    filaments: presets.listFilaments(printer),
  };
}

function run(exe, args, { timeoutMs, onLine }) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { windowsHide: true });
    let out = '';
    const feed = (b) => {
      const t = b.toString();
      out += t;
      if (onLine) t.split(/\r?\n/).filter(Boolean).forEach(onLine);
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out: String(e) });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

const num = (v) => (v === undefined || v === '' ? undefined : Number(v));

/** Read the interesting parts of a sliced project (.gcode.3mf). */
function readResult(file) {
  const zip = unzipSync(new Uint8Array(fs.readFileSync(file)));
  const text = (n) => (zip[n] ? strFromU8(zip[n]) : '');
  const sliceInfo = text('Metadata/slice_info.config');
  const meta = (k) => sliceInfo.match(new RegExp(`<metadata key="${k}" value="([^"]*)"`))?.[1];
  const filaments = [...sliceInfo.matchAll(/<filament ([^>]*)\/>/g)].map((m) => {
    const a = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    return { id: Number(a.id), type: a.type, color: a.color, usedG: num(a.used_g), usedM: num(a.used_m) };
  });
  const png = zip['Metadata/plate_1.png'];
  let plate = null;
  try {
    plate = JSON.parse(text('Metadata/plate_1.json'));
  } catch {
    /* absent in unsliced projects */
  }
  return {
    seconds: num(meta('prediction')),
    weightG: num(meta('weight')),
    filaments,
    thumbnail: png ? `data:image/png;base64,${Buffer.from(png).toString('base64')}` : null,
    hasGcode: !!zip['Metadata/plate_1.gcode'],
    outsideBed: meta('outside') === 'true',
    towerBox: plate?.bbox_objects?.find((o) => o.name === 'wipe_tower')?.bbox ?? null,
  };
}

/**
 * job: {
 *   printer, process, slice: boolean,
 *   objects: [{ name, filament: 0-based slot, stl: ArrayBuffer }],
 *   slots:   [{ preset, color, type }],
 *   overrides: { infill?: '15%', supports?: boolean, tower?: {x, y} }
 * }
 */
async function slice(job, onProgress = () => {}) {
  const exe = presets.findExe();
  if (!exe) throw new Error('Bambu Studio não foi encontrado neste computador.');
  if (!job.objects?.length) throw new Error('Não há objetos para fatiar.');

  const dir = path.join(jobsDir(), String(Date.now()));
  fs.mkdirSync(dir, { recursive: true });
  // Keep only a handful of recent jobs.
  try {
    const old = fs.readdirSync(jobsDir()).sort().slice(0, -6);
    old.forEach((d) => fs.rmSync(path.join(jobsDir(), d), { recursive: true, force: true }));
  } catch {
    /* best effort */
  }

  onProgress('Preparando arquivos…');
  const files = job.objects.map((o, i) => {
    const f = path.join(dir, `${safeName(o.name, i)}.stl`);
    fs.writeFileSync(f, Buffer.from(o.stl));
    return f;
  });

  const flat = presets.writeFlatPresets(path.join(dir, 'presets'), {
    printer: job.printer,
    process: job.process,
    filaments: job.slots.map((s) => ({ preset: s.preset, color: s.color })),
    processOverrides: processOverrides(job.overrides),
  });

  const args = [
    ...(job.slice ? ['--slice', '0'] : []),
    '--arrange', '0',
    '--load-settings', `${flat.machine};${flat.process}`,
    '--load-filaments', flat.filaments.join(';'),
    '--load-filament-ids', job.objects.map((o) => o.filament + 1).join(','),
    '--outputdir', dir,
    '--export-3mf', 'project.gcode.3mf',
    ...files,
  ];

  onProgress(job.slice ? 'Fatiando com o Bambu Studio…' : 'Montando o projeto…');
  const r = await run(exe, args, { timeoutMs: 10 * 60 * 1000 });
  const resultPath = path.join(dir, 'result.json');
  let result = null;
  try {
    result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  } catch {
    /* no result.json: the process died before writing it */
  }
  const file = path.join(dir, 'project.gcode.3mf');
  if (r.code !== 0 || !fs.existsSync(file)) {
    const msg = result?.error_string && result.error_string !== 'Success.' ? result.error_string : `O Bambu Studio fechou com erro (código ${r.code}).`;
    throw new Error(msg);
  }
  if (result && result.return_code && result.error_string !== 'Success.') throw new Error(result.error_string);

  return { dir, file, size: fs.statSync(file).size, ...readResult(file) };
}

function processOverrides(o = {}) {
  const out = {};
  if (o.infill) out.sparse_infill_density = o.infill;
  if (typeof o.supports === 'boolean') out.enable_support = o.supports ? '1' : '0';
  if (o.bedType) out.curr_bed_type = o.bedType;
  if (o.tower) {
    out.wipe_tower_x = [String(Math.round(o.tower.x))];
    out.wipe_tower_y = [String(Math.round(o.tower.y))];
  }
  return out;
}

module.exports = { info, printerInfo, slice };
