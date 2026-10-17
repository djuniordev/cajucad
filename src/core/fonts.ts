import { parse, type Font, type PathCommand } from 'opentype.js';
import interRegularUrl from '@fontsource/inter/files/inter-latin-400-normal.woff?url';
import interBoldUrl from '@fontsource/inter/files/inter-latin-700-normal.woff?url';
import type { Polygons } from './types';
import { idbDelete, idbEntries, idbPut } from './idb';
import { desktop } from '../desktop';

/**
 * Text pipeline: font file -> opentype glyph outlines -> flattened polygons.
 * Fonts come from this computer (read natively by the desktop app, or via the
 * browser's Local Font Access API), from files the user uploads, or from the
 * two built-in faces.
 */

export interface FontFace {
  /** Stable id stored in documents (PostScript name for system fonts). */
  id: string;
  family: string;
  style: string;
  source: 'builtin' | 'system' | 'upload';
  /** CSS family registered for previews of uploaded fonts. */
  css?: string;
}

interface StoredFont {
  buf: ArrayBuffer;
  fileName: string;
  family: string;
  style: string;
}

interface LocalFontData {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
  blob(): Promise<Blob>;
}

declare global {
  interface Window {
    queryLocalFonts?: (opts?: { postscriptNames?: string[] }) => Promise<LocalFontData[]>;
  }
}

export const DEFAULT_FONT_ID = 'builtin:Inter-Bold';

const builtins: (FontFace & { url: string })[] = [
  { id: 'builtin:Inter-Regular', family: 'Inter', style: 'Regular', source: 'builtin', url: interRegularUrl },
  { id: 'builtin:Inter-Bold', family: 'Inter', style: 'Bold', source: 'builtin', url: interBoldUrl },
];

const faces = new Map<string, FontFace>(builtins.map((b) => [b.id, b]));
const systemData = new Map<string, LocalFontData>();
/** Installed fonts listed by the desktop app (read on demand over IPC). */
const desktopFonts = new Set<string>();
const uploads = new Map<string, ArrayBuffer>();
const parsed = new Map<string, Promise<Font>>();
const listeners = new Set<() => void>();

export const supportsLocalFonts = () => !!desktop || typeof window.queryLocalFonts === 'function';

export const onFontsChanged = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const emit = () => listeners.forEach((f) => f());

export const listFaces = () => [...faces.values()];
export const getFace = (id: string) => faces.get(id);

let systemLoaded = false;
export const systemFontsLoaded = () => systemLoaded;

/**
 * Ask the browser for the installed fonts. Must run from a user gesture the
 * first time (the browser shows a permission prompt).
 */
export async function loadSystemFonts(): Promise<number> {
  if (desktop) {
    const list = await desktop.listFonts();
    for (const f of list) {
      if (faces.has(f.id)) continue;
      desktopFonts.add(f.id);
      faces.set(f.id, { id: f.id, family: f.family, style: f.style, source: 'system' });
    }
    systemLoaded = true;
    emit();
    return list.length;
  }
  if (!window.queryLocalFonts) throw new Error('unsupported');
  const list = await window.queryLocalFonts();
  for (const f of list) {
    if (faces.has(f.postscriptName)) continue;
    systemData.set(f.postscriptName, f);
    faces.set(f.postscriptName, {
      id: f.postscriptName,
      family: f.family,
      style: f.style,
      source: 'system',
    });
  }
  systemLoaded = true;
  emit();
  return list.length;
}

/** Restore access silently when the permission was already granted. */
export async function tryRestoreSystemFonts() {
  // The desktop app reads the font folders directly: no permission needed.
  if (desktop) return void loadSystemFonts().catch(() => {});
  if (!supportsLocalFonts()) return;
  try {
    const status = await navigator.permissions.query({ name: 'local-fonts' as PermissionName });
    if (status.state === 'granted') await loadSystemFonts();
  } catch {
    /* permission name unknown in this browser: wait for a click */
  }
}

export interface UploadReport {
  added: FontFace[];
  failed: string[];
}

/**
 * Register many font files at once (files or a whole folder). Each one is
 * kept in IndexedDB, so it is available again on the next visit.
 */
export async function addUploadedFonts(files: Iterable<File>): Promise<UploadReport> {
  const report: UploadReport = { added: [], failed: [] };
  for (const file of files) {
    if (!/\.(ttf|otf|woff)$/i.test(file.name)) {
      if (/\.(woff2|ttc)$/i.test(file.name)) report.failed.push(file.name);
      continue;
    }
    try {
      const buf = await file.arrayBuffer();
      const face = registerUpload(buf, file.name);
      await idbPut('fonts', face.id, { buf, fileName: file.name, family: face.family, style: face.style } satisfies StoredFont);
      report.added.push(face);
    } catch {
      report.failed.push(file.name);
    }
  }
  if (report.added.length) emit();
  return report;
}

/** Load fonts uploaded in previous sessions. */
export async function restoreUploadedFonts() {
  try {
    const rows = await idbEntries<StoredFont>('fonts');
    // Only metadata now; the file is parsed the first time it is used.
    for (const [id, row] of rows) addFace({ id, family: row.family, style: row.style, source: 'upload' }, row.buf);
    if (rows.length) emit();
  } catch {
    /* storage unavailable */
  }
}

export async function removeUploadedFont(id: string) {
  uploads.delete(id);
  parsed.delete(id);
  faces.delete(id);
  await idbDelete('fonts', id).catch(() => {});
  emit();
}

function addFace(face: FontFace, buf: ArrayBuffer) {
  uploads.set(face.id, buf);
  face.css = `ocad-${[...face.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36)}`;
  faces.set(face.id, face);
  // Make the font usable by CSS too, so the picker previews show its design.
  try {
    const ff = new window.FontFace(face.css, buf);
    document.fonts.add(ff);
    ff.load().catch(() => {});
  } catch {
    /* preview falls back to the UI font */
  }
}

function registerUpload(buf: ArrayBuffer, fileName: string): FontFace {
  const font = parse(buf);
  const file = { name: fileName };
  // opentype.js 2 keeps names per platform; prefer the typographic family.
  const name = (k: string) => {
    try {
      return (font as unknown as { getEnglishName(k: string): string | undefined }).getEnglishName(k) || undefined;
    } catch {
      return undefined;
    }
  };
  const family = name('preferredFamily') ?? name('fontFamily') ?? file.name.replace(/\.\w+$/, '');
  const style = name('preferredSubfamily') ?? name('fontSubfamily') ?? 'Regular';
  const id = `upload:${name('postScriptName') ?? family + '-' + style}`;
  parsed.delete(id);
  const face: FontFace = { id, family, style, source: 'upload' };
  addFace(face, buf);
  parsed.set(id, Promise.resolve(font));
  return face;
}

export function loadFont(id: string): Promise<Font> {
  const cached = parsed.get(id);
  if (cached) return cached;
  const p = (async () => {
    const builtin = builtins.find((b) => b.id === id);
    if (builtin) return parse(await (await fetch(builtin.url)).arrayBuffer());
    if (desktopFonts.has(id)) return parse(await desktop!.readFont(id));
    const sys = systemData.get(id);
    if (sys) return parse(await (await sys.blob()).arrayBuffer());
    const up = uploads.get(id);
    if (up) return parse(up);
    throw new Error(`Fonte indisponível: ${id}`);
  })();
  parsed.set(id, p);
  p.catch(() => parsed.delete(id));
  return p;
}

export const isFontAvailable = (id: string) =>
  builtins.some((b) => b.id === id) || systemData.has(id) || desktopFonts.has(id) || uploads.has(id);

/** Group faces by family, families sorted, regular style first. */
export function familiesOf(list: FontFace[]) {
  const byFamily = new Map<string, FontFace[]>();
  // An uploaded copy of a font that is also installed is shown only once.
  const installed = new Set(list.filter((f) => f.source === 'system').map((f) => `${f.family}|${f.style}`.toLowerCase()));
  for (const f of list) {
    if (f.source === 'upload' && installed.has(`${f.family}|${f.style}`.toLowerCase())) continue;
    const arr = byFamily.get(f.family) ?? [];
    arr.push(f);
    byFamily.set(f.family, arr);
  }
  const rank = (s: string) => (/^(regular|normal|book|roman)$/i.test(s) ? 0 : 1);
  for (const arr of byFamily.values()) arr.sort((a, b) => rank(a.style) - rank(b.style) || a.style.localeCompare(b.style));
  return [...byFamily.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/** CSS used to preview a face in the picker (system fonts render natively). */
export function previewCss(face: FontFace) {
  if (face.source === 'builtin') return `font-family: 'Inter', sans-serif; font-weight:${face.style === 'Bold' ? 700 : 400}`;
  if (face.css) return `font-family: '${face.css}', sans-serif`;
  const weight = /black|heavy/i.test(face.style) ? 900 : /extra ?bold/i.test(face.style) ? 800 : /semi ?bold|demi/i.test(face.style) ? 600 : /bold/i.test(face.style) ? 700 : /medium/i.test(face.style) ? 500 : /light/i.test(face.style) ? 300 : /thin|hairline/i.test(face.style) ? 100 : 400;
  const italic = /italic|oblique/i.test(face.style) ? 'italic' : 'normal';
  return `font-family: '${face.family.replace(/'/g, "\\'")}', sans-serif; font-weight:${weight}; font-style:${italic}`;
}

export interface TextLayout {
  text: string;
  size: number;
  letterSpacing: number;
  lineHeight: number;
  align: 'left' | 'center' | 'right';
}

/**
 * Lay out (multi-line) text with the font's kerning and GSUB features, then
 * flatten every glyph outline into polygons centred on the origin (mm, Y up).
 */
export function textToPolygons(font: Font, opts: TextLayout): Polygons {
  const scale = opts.size / font.unitsPerEm;
  const lines = opts.text.split('\n');
  const lineAdvance = opts.size * opts.lineHeight;
  const flat: Polygons = [];
  const lineWidths: number[] = [];
  const lineContours: Polygons[] = [];

  for (const line of lines) {
    const glyphs = shapeLine(font, line);
    let x = 0;
    const contours: Polygons = [];
    glyphs.forEach((g, i) => {
      const path = g.getPath(x, 0, opts.size);
      contours.push(...flattenCommands(path.commands, opts.size));
      x += (g.advanceWidth ?? 0) * scale + opts.letterSpacing;
      const next = glyphs[i + 1];
      if (next) x += font.getKerningValue(g, next) * scale;
    });
    lineWidths.push(Math.max(0, x - opts.letterSpacing));
    lineContours.push(contours);
  }

  const maxW = Math.max(...lineWidths, 0);
  lineContours.forEach((contours, li) => {
    const w = lineWidths[li];
    const dx = opts.align === 'left' ? -maxW / 2 : opts.align === 'right' ? maxW / 2 - w : -w / 2;
    const dy = -li * lineAdvance;
    for (const c of contours) flat.push(c.map(([px, py]) => [px + dx, -py + dy]));
  });

  // Centre vertically on the actual ink bounds.
  let minY = Infinity;
  let maxY = -Infinity;
  for (const c of flat) for (const [, y] of c) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!isFinite(minY)) return [];
  const cy = (minY + maxY) / 2;
  return flat.map((c) => c.map(([x, y]) => [x, y - cy] as [number, number]));
}

/**
 * Glyphs for one line. opentype.js applies GSUB features (ligatures, Arabic
 * forms) but throws on lookup formats it does not implement yet, which some
 * popular fonts use; then fall back to plain character mapping.
 */
function shapeLine(font: Font, line: string) {
  try {
    return font.stringToGlyphs(line);
  } catch {
    try {
      return (font.stringToGlyphs as (s: string, o: object) => ReturnType<Font['stringToGlyphs']>)(line, { features: [] });
    } catch {
      return Array.from(line).map((ch) => font.charToGlyph(ch));
    }
  }
}

/** Convert path commands (font units already scaled, Y down) to polylines. */
function flattenCommands(cmds: PathCommand[], size: number): Polygons {
  // About 0.08 mm chord error on a 10 mm font; scales with the text size.
  const steps = Math.max(4, Math.min(16, Math.round(size / 1.2)));
  const out: Polygons = [];
  let cur: [number, number][] = [];
  let px = 0;
  let py = 0;
  let sx = 0;
  let sy = 0;
  const close = () => {
    if (cur.length >= 3) {
      const [fx, fy] = cur[0];
      const [lx, ly] = cur[cur.length - 1];
      if (Math.abs(fx - lx) < 1e-6 && Math.abs(fy - ly) < 1e-6) cur.pop();
      if (cur.length >= 3) out.push(cur);
    }
    cur = [];
  };
  for (const c of cmds) {
    switch (c.type) {
      case 'M':
        close();
        px = sx = c.x;
        py = sy = c.y;
        cur.push([px, py]);
        break;
      case 'L':
        px = c.x;
        py = c.y;
        cur.push([px, py]);
        break;
      case 'Q':
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const u = 1 - t;
          cur.push([u * u * px + 2 * u * t * c.x1 + t * t * c.x, u * u * py + 2 * u * t * c.y1 + t * t * c.y]);
        }
        px = c.x;
        py = c.y;
        break;
      case 'C':
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const u = 1 - t;
          cur.push([
            u * u * u * px + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x,
            u * u * u * py + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y,
          ]);
        }
        px = c.x;
        py = c.y;
        break;
      case 'Z':
        px = sx;
        py = sy;
        close();
        break;
    }
  }
  close();
  return out;
}
