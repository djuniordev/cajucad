import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { mergeVertices, mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { DesignDoc, MeshAsset, Polygons, SceneNode } from './types';
import { exportSolid, manifoldApi, nodeMatrix, renderGeometry, renderPieces, manifoldFromAsset } from './geometry';
import { createNode, nextColor } from './shapes';
import { uid } from './store';
import { idbGet, idbPut } from './idb';

export const ACCEPT_IMPORT = '.stl,.obj,.3mf,.svg,.ttf,.otf,.woff';
export const FONT_EXT = /\.(ttf|otf|woff)$/i;

export interface ImportResult {
  nodes: SceneNode[];
  assets: Record<string, MeshAsset>;
  warning?: string;
}

export async function importFile(file: File): Promise<ImportResult> {
  const ext = file.name.toLowerCase().split('.').pop();
  const base = file.name.replace(/\.[^.]+$/, '');
  if (ext === 'svg') return importSvg(await file.text(), base);
  let geom: THREE.BufferGeometry;
  if (ext === 'stl') geom = new STLLoader().parse(await file.arrayBuffer());
  else if (ext === 'obj') geom = mergeObject(new OBJLoader().parse(await file.text()));
  else if (ext === '3mf') geom = mergeObject(new ThreeMFLoader().parse(await file.arrayBuffer()));
  else throw new Error('Formato não suportado. Use STL, OBJ, 3MF ou SVG.');
  return importGeometry(geom, base);
}

function mergeObject(root: THREE.Object3D): THREE.BufferGeometry {
  root.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', mesh.geometry.getAttribute('position').clone());
    if (mesh.geometry.index) g.setIndex(mesh.geometry.index.clone());
    g.applyMatrix4(mesh.matrixWorld);
    parts.push(g.index ? g.toNonIndexed() : g);
  });
  if (!parts.length) throw new Error('O arquivo não contém malhas.');
  return mergeGeometries(parts)!;
}

function importGeometry(src: THREE.BufferGeometry, name: string): ImportResult {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', src.getAttribute('position'));
  const merged = mergeVertices(g, 1e-5);
  merged.computeBoundingBox();
  const bb = merged.boundingBox!;
  const center = bb.getCenter(new THREE.Vector3());
  // Origin at bottom-centre so the object rests on the workplane.
  merged.translate(-center.x, -center.y, -bb.min.z);
  const positions = Array.from(merged.getAttribute('position').array as Float32Array);
  const indices = merged.index ? Array.from(merged.index.array) : positions.map((_, i) => i).slice(0, positions.length / 3);
  const asset: MeshAsset = { positions, indices };
  const id = uid();
  const node = createNode('mesh', { name, params: { asset: id }, color: nextColor() });
  const solid = manifoldFromAsset(asset);
  const warning = solid
    ? undefined
    : 'A malha não é um sólido fechado: ela aparece na cena, mas não participa de furos e grupos.';
  return { nodes: [node], assets: { [id]: asset }, warning };
}

type CS = InstanceType<ReturnType<typeof manifoldApi>['CrossSection']>;

interface SvgStyle {
  fill?: string;
  fillRule?: string;
  fillOpacity?: number;
  stroke?: string;
  strokeOpacity?: number;
  strokeWidth?: number;
}

/**
 * SVG -> one extruded object per colour. Shapes are processed in paint order:
 * whatever is painted later cuts the earlier colours below it, so the pieces
 * fit together without overlapping (ready for multicolour printing).
 */
function importSvg(text: string, name: string): ImportResult {
  const data = new SVGLoader().parse(text);
  const { CrossSection } = manifoldApi();
  const layers = new Map<string, CS>();
  const order: string[] = [];

  const paint = (color: string, cs: CS) => {
    if (cs.isEmpty()) return cs.delete();
    for (const [c, region] of layers) {
      if (c === color) continue;
      layers.set(c, region.subtract(cs));
      region.delete();
    }
    const prev = layers.get(color);
    if (prev) {
      layers.set(color, prev.add(cs));
      prev.delete();
      cs.delete();
    } else {
      layers.set(color, cs);
      order.push(color);
    }
  };

  const hex = (c: THREE.Color) => `#${c.getHexString()}`;
  for (const path of data.paths) {
    const style: SvgStyle = path.userData?.style ?? {};
    const visibleFill = style.fill && style.fill !== 'none' && style.fill !== 'transparent' && (style.fillOpacity ?? 1) > 0.02;
    if (visibleFill) {
      const contours: Polygons = path.subPaths
        .map((sp) => sp.getPoints(24).map((p) => [p.x, -p.y] as [number, number]))
        .filter((c) => c.length >= 3);
      if (contours.length) paint(hex(path.color), new CrossSection(contours, style.fillRule === 'evenodd' ? 'EvenOdd' : 'NonZero'));
    }
    const visibleStroke = style.stroke && style.stroke !== 'none' && (style.strokeWidth ?? 1) > 0 && (style.strokeOpacity ?? 1) > 0.02;
    if (visibleStroke) {
      const stroke = strokeRegion(path, style);
      if (stroke) paint(hex(new THREE.Color().setStyle(style.stroke!)), stroke);
    }
  }

  const live = order.filter((c) => {
    const r = layers.get(c)!;
    if (r.area() > 1e-3) return true;
    r.delete();
    layers.delete(c);
    return false;
  });
  if (!live.length) throw new Error('Nenhuma forma visível no SVG.');

  // Shared frame: px -> mm at 96 dpi, fitted to 60 mm when very large/small.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of live) {
    const b = layers.get(c)!.bounds();
    minX = Math.min(minX, b.min[0]); minY = Math.min(minY, b.min[1]);
    maxX = Math.max(maxX, b.max[0]); maxY = Math.max(maxY, b.max[1]);
  }
  let s = 25.4 / 96;
  const span = Math.max(maxX - minX, maxY - minY);
  if (span * s > 200 || span * s < 5) s = 60 / span;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  const multi = live.length > 1;
  const nodes = live.map((color, i) => {
    const region = layers.get(color)!;
    const outline: Polygons = region.toPolygons().map((c) => c.map(([x, y]) => [(x - cx) * s, (y - cy) * s] as [number, number]));
    region.delete();
    // Keep the drawing's real colours; a single black icon gets a friendlier tone.
    const nodeColor = multi || !/^#(0{6}|1{6}|2{6})$/.test(color) ? color : nextColor();
    return createNode('svg', {
      name: multi ? `${name} · cor ${i + 1}` : name,
      params: { outline, height: 5 },
      color: nodeColor,
    });
  });
  return {
    nodes,
    assets: {},
    warning: multi ? `${nodes.length} cores separadas em objetos. Agrupe (Ctrl G) se quiser uma peça só.` : undefined,
  };
}

/** Stroke outline as a filled region (triangulated by three, re-united here). */
function strokeRegion(path: ReturnType<SVGLoader['parse']>['paths'][number], style: SvgStyle): CS | null {
  const { CrossSection } = manifoldApi();
  const tris: [number, number][][] = [];
  for (const sp of path.subPaths) {
    const g = SVGLoader.pointsToStroke(sp.getPoints(24), style as never);
    if (!g) continue;
    const pos = g.getAttribute('position');
    const idx = g.index;
    const count = idx ? idx.count : pos.count;
    for (let i = 0; i < count; i += 3) {
      const v = [0, 1, 2].map((k) => {
        const j = idx ? idx.getX(i + k) : i + k;
        return [pos.getX(j), -pos.getY(j)] as [number, number];
      });
      // Orient counter-clockwise so a 'Positive' fill unites them all.
      const area = (v[1][0] - v[0][0]) * (v[2][1] - v[0][1]) - (v[2][0] - v[0][0]) * (v[1][1] - v[0][1]);
      if (Math.abs(area) < 1e-9) continue;
      tris.push(area > 0 ? v : [v[0], v[2], v[1]]);
    }
    g.dispose();
  }
  return tris.length ? new CrossSection(tris, 'Positive') : null;
}

// ---------- Export ----------

function download(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const safeName = (t: string) => t.trim().replace(/[\\/:*?"<>|]+/g, '_') || 'modelo';

/** Binary STL of a Manifold mesh (millimetres, as modelled). */
export function meshToStl(mesh: { numProp: number; vertProperties: Float32Array; triVerts: Uint32Array }): ArrayBuffer {
  const np = mesh.numProp;
  const pos = mesh.vertProperties;
  const tri = mesh.triVerts;
  const n = tri.length / 3;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  const header = 'CajuCAD export';
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, n, true);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), nn = new THREE.Vector3();
  let o = 84;
  for (let t = 0; t < n; t++) {
    const [i0, i1, i2] = [tri[t * 3] * np, tri[t * 3 + 1] * np, tri[t * 3 + 2] * np];
    a.set(pos[i0], pos[i0 + 1], pos[i0 + 2]);
    b.set(pos[i1], pos[i1 + 1], pos[i1 + 2]);
    c.set(pos[i2], pos[i2 + 1], pos[i2 + 2]);
    nn.subVectors(c, b).cross(a.clone().sub(b)).normalize();
    for (const v of [nn, a, b, c]) {
      dv.setFloat32(o, v.x, true);
      dv.setFloat32(o + 4, v.y, true);
      dv.setFloat32(o + 8, v.z, true);
      o += 12;
    }
    o += 2;
  }
  return buf;
}

export type ExportFormat = 'stl' | 'obj' | 'glb';

export async function exportDesign(doc: DesignDoc, format: ExportFormat, only?: Set<string>) {
  const name = safeName(doc.title);
  if (format === 'glb') return download(await toGlb(doc, only), `${name}.glb`);
  const solid = exportSolid(doc, only);
  if (!solid) throw new Error('Nada para exportar (furos soltos e objetos ocultos não entram).');
  const mesh = solid.getMesh();
  solid.delete();
  const np = mesh.numProp;
  const pos = mesh.vertProperties;
  const tri = mesh.triVerts;
  if (format === 'stl') return download(new Blob([meshToStl(mesh)], { type: 'model/stl' }), `${name}.stl`);
  const lines = ['# CajuCAD export', `o ${name}`];
  for (let i = 0; i < pos.length; i += np) lines.push(`v ${pos[i]} ${pos[i + 1]} ${pos[i + 2]}`);
  for (let t = 0; t < tri.length; t += 3) lines.push(`f ${tri[t] + 1} ${tri[t + 1] + 1} ${tri[t + 2] + 1}`);
  download(new Blob([lines.join('\n')], { type: 'text/plain' }), `${name}.obj`);
}

/** GLB keeps one mesh per object with its colour (good for multicolour prints/AR). */
async function toGlb(doc: DesignDoc, only?: Set<string>): Promise<Blob> {
  const scene = new THREE.Scene();
  for (const n of doc.nodes) {
    if (n.hidden || n.hole || (only && !only.has(n.id))) continue;
    // A group keeps one mesh per colour; everything else is a single mesh.
    const parts = n.kind === 'group' ? renderPieces(n, doc.assets).map((p) => ({ g: p.geometry, color: p.color })) : [{ g: renderGeometry(n, doc.assets), color: n.color }];
    parts.forEach((part, i) => {
      if (!part.g) return;
      const m = new THREE.Mesh(part.g, new THREE.MeshStandardMaterial({ color: part.color, roughness: 0.5 }));
      m.name = parts.length > 1 ? `${n.name} ${i + 1}` : n.name;
      m.applyMatrix4(nodeMatrix(n));
      scene.add(m);
    });
  }
  // glTF is Y-up; rotate our Z-up design.
  scene.rotation.x = -Math.PI / 2;
  const out = (await new GLTFExporter().parseAsync(scene, { binary: true })) as ArrayBuffer;
  return new Blob([out], { type: 'model/gltf-binary' });
}

// ---------- Project files ----------

export function saveProjectFile(doc: DesignDoc) {
  download(new Blob([JSON.stringify(doc)], { type: 'application/json' }), `${safeName(doc.title)}.ocad.json`);
}

export async function openProjectFile(file: File): Promise<DesignDoc> {
  const doc = JSON.parse(await file.text()) as DesignDoc;
  if (doc?.version !== 1 || !Array.isArray(doc.nodes)) throw new Error('Arquivo de projeto inválido.');
  doc.assets ??= {};
  return doc;
}

// ---------- Autosave (IndexedDB) ----------

export async function autosave(doc: DesignDoc) {
  try {
    await idbPut('docs', 'current', doc);
  } catch {
    /* private mode or quota: autosave is best effort */
  }
}

export async function restoreAutosave(): Promise<DesignDoc | null> {
  try {
    return (await idbGet<DesignDoc>('docs', 'current')) ?? null;
  } catch {
    return null;
  }
}
