// System font index for the desktop app. Reads only the sfnt header and the
// 'name' table of each file (fast even with hundreds of fonts) and can turn a
// face inside a .ttc collection into a standalone font for opentype.js.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const EXT = /\.(ttf|otf|ttc|otc)$/i;

function fontDirs() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const win = process.env.WINDIR || 'C:\\Windows';
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [path.join(win, 'Fonts'), path.join(local, 'Microsoft', 'Windows', 'Fonts')];
  }
  if (process.platform === 'darwin') {
    return ['/System/Library/Fonts', '/Library/Fonts', path.join(home, 'Library', 'Fonts')];
  }
  return ['/usr/share/fonts', '/usr/local/share/fonts', path.join(home, '.fonts'), path.join(home, '.local', 'share', 'fonts')];
}

function walk(dir, out, depth = 0) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 4) walk(p, out, depth + 1);
    else if (EXT.test(e.name)) out.push(p);
  }
}

/** Read `len` bytes at `pos` without loading the whole file. */
function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  const n = fs.readSync(fd, b, 0, len, pos);
  return n === len ? b : b.subarray(0, n);
}

function tableDir(fd, faceOffset) {
  const head = readAt(fd, faceOffset, 12);
  const numTables = head.readUInt16BE(4);
  const dir = readAt(fd, faceOffset + 12, numTables * 16);
  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const o = i * 16;
    tables.push({
      tag: dir.toString('latin1', o, o + 4),
      checksum: dir.readUInt32BE(o + 4),
      offset: dir.readUInt32BE(o + 8),
      length: dir.readUInt32BE(o + 12),
    });
  }
  return { version: head.readUInt32BE(0), tables };
}

function faceOffsets(fd) {
  const head = readAt(fd, 0, 12);
  if (head.toString('latin1', 0, 4) !== 'ttcf') return [0];
  const n = head.readUInt32BE(8);
  const list = readAt(fd, 12, n * 4);
  return Array.from({ length: n }, (_, i) => list.readUInt32BE(i * 4));
}

function decodeName(buf, platform, encoding) {
  if (platform === 3 || platform === 0) {
    let s = '';
    for (let i = 0; i + 1 < buf.length; i += 2) s += String.fromCharCode(buf.readUInt16BE(i));
    return s;
  }
  return buf.toString('latin1');
}

/** nameID -> best string (Windows English first, then any Windows, then Mac). */
function readNames(fd, table) {
  const t = readAt(fd, table.offset, table.length);
  const count = t.readUInt16BE(2);
  const strOff = t.readUInt16BE(4);
  const best = new Map();
  const score = (p, l) => (p === 3 && l === 0x409 ? 3 : p === 3 ? 2 : p === 0 ? 1 : 0);
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    if (r + 12 > t.length) break;
    const platform = t.readUInt16BE(r);
    const encoding = t.readUInt16BE(r + 2);
    const lang = t.readUInt16BE(r + 4);
    const id = t.readUInt16BE(r + 6);
    const len = t.readUInt16BE(r + 8);
    const off = t.readUInt16BE(r + 10);
    if (![1, 2, 4, 6, 16, 17].includes(id)) continue;
    const s = score(platform, lang);
    if (best.has(id) && best.get(id).score >= s) continue;
    const raw = t.subarray(strOff + off, strOff + off + len);
    best.set(id, { score: s, value: decodeName(raw, platform, encoding).replace(/\0/g, '').trim() });
  }
  const get = (id) => best.get(id)?.value || undefined;
  return {
    family: get(16) || get(1),
    style: get(17) || get(2) || 'Regular',
    postscript: get(6),
    full: get(4),
  };
}

let index = null;

/** List every installed face: { id, family, style, file, face }. */
function listSystemFonts() {
  if (index) return [...index.values()].map(({ id, family, style }) => ({ id, family, style }));
  index = new Map();
  const files = [];
  for (const d of fontDirs()) walk(d, files);
  for (const file of files) {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      faceOffsets(fd).forEach((off, faceIdx) => {
        const { tables } = tableDir(fd, off);
        const nameT = tables.find((t) => t.tag === 'name');
        // Skip bitmap-only / unusual faces without outlines.
        if (!nameT || !tables.some((t) => t.tag === 'glyf' || t.tag === 'CFF ' || t.tag === 'CFF2')) return;
        const n = readNames(fd, nameT);
        if (!n.family) return;
        const id = n.postscript || `${n.family}-${n.style}`.replace(/\s+/g, '');
        if (!index.has(id)) index.set(id, { id, family: n.family, style: n.style, file, faceOffset: off, faceIdx });
      });
    } catch {
      /* unreadable or corrupt font: skip */
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  return listSystemFonts();
}

/** Bytes of one face as a standalone sfnt (collections are unpacked). */
function readSystemFont(id) {
  if (!index) listSystemFonts();
  const entry = index.get(id);
  if (!entry) throw new Error(`font not found: ${id}`);
  const data = fs.readFileSync(entry.file);
  if (data.toString('latin1', 0, 4) !== 'ttcf') return data;

  const fd = fs.openSync(entry.file, 'r');
  let dir;
  try {
    dir = tableDir(fd, entry.faceOffset);
  } finally {
    fs.closeSync(fd);
  }
  const n = dir.tables.length;
  const headerLen = 12 + n * 16;
  const pad = (x) => (x + 3) & ~3;
  const total = dir.tables.reduce((s, t) => s + pad(t.length), headerLen);
  const out = Buffer.alloc(total);
  let es = 0;
  while (1 << (es + 1) <= n) es++;
  out.writeUInt32BE(dir.version, 0);
  out.writeUInt16BE(n, 4);
  out.writeUInt16BE((1 << es) * 16, 6);
  out.writeUInt16BE(es, 8);
  out.writeUInt16BE(n * 16 - (1 << es) * 16, 10);
  let cursor = headerLen;
  dir.tables.forEach((t, i) => {
    const r = 12 + i * 16;
    out.write(t.tag, r, 4, 'latin1');
    out.writeUInt32BE(t.checksum, r + 4);
    out.writeUInt32BE(cursor, r + 8);
    out.writeUInt32BE(t.length, r + 12);
    data.copy(out, cursor, t.offset, t.offset + t.length);
    cursor += pad(t.length);
  });
  return out;
}

module.exports = { listSystemFonts, readSystemFont };
