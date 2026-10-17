import Module, { type Manifold, type ManifoldToplevel, type CrossSection } from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import * as THREE from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { DesignDoc, MeshAsset, Params, Polygons, SceneNode, Vec3 } from './types';

/**
 * Solid modelling on top of Manifold (WASM). This is the local replacement for
 * Tinkercad's server-side `/evaluate`: every node becomes a Manifold in its own
 * local space, groups unite their solids and subtract their holes.
 */

let wasm: ManifoldToplevel;

export async function initGeometry() {
  wasm = await Module({ locateFile: () => wasmUrl });
  wasm.setup();
  wasm.setMinCircularAngle(6);
  wasm.setMinCircularEdgeLength(0.4);
}

const num = (p: Params, k: string, d: number) => {
  const v = p[k];
  return typeof v === 'number' && isFinite(v) ? v : d;
};
const clampSeg = (n: number) => Math.max(3, Math.min(256, Math.round(n)));

/** Local-space cache: key -> Manifold. Entries are owned by the cache. */
const solidCache = new Map<string, Manifold>();
const meshCache = new Map<string, THREE.BufferGeometry>();
const CACHE_LIMIT = 300;

function cachePut<T>(map: Map<string, T>, key: string, val: T, dispose: (v: T) => void) {
  map.set(key, val);
  if (map.size > CACHE_LIMIT) {
    const first = map.keys().next().value as string;
    const old = map.get(first)!;
    map.delete(first);
    dispose(old);
  }
}

const transformKey = (n: SceneNode) => [n.position, n.rotation, n.scale].flat().map((v) => +v.toFixed(5)).join(',');

/** Geometry identity of a node (transform excluded, as in Tinkercad's recipe hash). */
export function shapeKey(n: SceneNode, assets?: DesignDoc['assets']): string {
  if (n.kind === 'group') {
    const kids = (n.children ?? []).filter((c) => !c.hidden).map((c) => `${c.hole ? '-' : '+'}${shapeKey(c, assets)}@${transformKey(c)}`);
    return `group(${kids.join(';')})`;
  }
  const p = { ...n.params };
  return `${n.kind}:${JSON.stringify(p)}`;
}

export function nodeMatrix(n: Pick<SceneNode, 'position' | 'rotation' | 'scale'>) {
  const m = new THREE.Matrix4();
  const e = new THREE.Euler(...(n.rotation.map(THREE.MathUtils.degToRad) as Vec3), 'XYZ');
  m.compose(new THREE.Vector3(...n.position), new THREE.Quaternion().setFromEuler(e), new THREE.Vector3(...n.scale));
  return m;
}

const toMat4 = (m: THREE.Matrix4) => m.elements.slice() as unknown as Parameters<Manifold['transform']>[0];

/** Build (or fetch from cache) the node's solid in its local space. */
export function solidOf(n: SceneNode, assets: DesignDoc['assets']): Manifold | null {
  const key = shapeKey(n, assets);
  const hit = solidCache.get(key);
  if (hit) return hit;
  const built = buildLocal(n, assets);
  if (!built) return null;
  cachePut(solidCache, key, built, (m) => m.delete());
  return built;
}

/** Solid of the node with its own transform applied. Caller must delete(). */
export function worldSolid(n: SceneNode, assets: DesignDoc['assets'], parent?: THREE.Matrix4): Manifold | null {
  const local = solidOf(n, assets);
  if (!local) return null;
  const m = parent ? parent.clone().multiply(nodeMatrix(n)) : nodeMatrix(n);
  return local.transform(toMat4(m));
}

function buildLocal(n: SceneNode, assets: DesignDoc['assets']): Manifold | null {
  const { Manifold: M, CrossSection: CS } = wasm;
  const p = n.params;
  switch (n.kind) {
    case 'box': {
      const w = num(p, 'width', 20), d = num(p, 'depth', 20), h = num(p, 'height', 20);
      return M.cube([w, d, h], true).translate(0, 0, h / 2);
    }
    case 'roundBox': {
      const w = num(p, 'width', 20), d = num(p, 'depth', 20), h = num(p, 'height', 20);
      const r = Math.max(0.01, Math.min(num(p, 'radius', 3), w / 2 - 0.01, d / 2 - 0.01, h / 2 - 0.01));
      const seg = clampSeg(num(p, 'segments', 32));
      const corners: Manifold[] = [];
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1])
        corners.push(M.sphere(r, seg).translate(sx * (w / 2 - r), sy * (d / 2 - r), sz * (h / 2 - r) + h / 2));
      const out = M.hull(corners);
      corners.forEach((c) => c.delete());
      return out;
    }
    case 'cylinder': {
      const r = num(p, 'radius', 10), h = num(p, 'height', 20);
      return M.cylinder(h, r, r, clampSeg(num(p, 'sides', 64)));
    }
    case 'cone': {
      const r = num(p, 'radius', 10), rt = Math.max(0, num(p, 'topRadius', 0)), h = num(p, 'height', 20);
      return M.cylinder(h, r, rt, clampSeg(num(p, 'sides', 64)));
    }
    case 'sphere': {
      const r = num(p, 'radius', 10);
      return M.sphere(r, clampSeg(num(p, 'segments', 64))).translate(0, 0, r);
    }
    case 'halfSphere': {
      const r = num(p, 'radius', 10);
      const s = M.sphere(r, clampSeg(num(p, 'segments', 64)));
      const cut = M.cube([r * 3, r * 3, r * 1.5], true).translate(0, 0, r * 0.75);
      const out = s.intersect(cut);
      s.delete();
      cut.delete();
      return out;
    }
    case 'pyramid': {
      const w = num(p, 'width', 20), h = num(p, 'height', 20);
      const base = CS.square([w, w], true);
      const out = base.extrude(h, 0, 0, [0, 0]);
      base.delete();
      return out;
    }
    case 'wedge': {
      const w = num(p, 'width', 20), d = num(p, 'depth', 20), h = num(p, 'height', 20);
      const tri = new CS([[[-w / 2, 0], [w / 2, 0], [-w / 2, h]]]);
      const out = tri.extrude(d).rotate(90, 0, 0).translate(0, d / 2, 0);
      tri.delete();
      return out;
    }
    case 'torus': {
      const R = num(p, 'radius', 10), r = Math.min(num(p, 'tube', 3), R - 0.01);
      const seg = clampSeg(num(p, 'segments', 64));
      const c = CS.circle(r, clampSeg(seg / 2)).translate([R, 0]);
      const out = c.revolve(seg).translate(0, 0, r);
      c.delete();
      return out;
    }
    case 'tube': {
      const r = num(p, 'radius', 10), h = num(p, 'height', 20);
      const wall = Math.min(num(p, 'wall', 2), r - 0.05);
      const sides = clampSeg(num(p, 'sides', 64));
      const outer = CS.circle(r, sides);
      const inner = CS.circle(r - wall, sides);
      const ring = outer.subtract(inner);
      const out = ring.extrude(h);
      [outer, inner, ring].forEach((x) => x.delete());
      return out;
    }
    case 'star': {
      const pts = Math.max(3, Math.round(num(p, 'points', 5)));
      const ro = num(p, 'outer', 12), ri = Math.min(num(p, 'inner', 5), ro);
      const poly: [number, number][] = [];
      for (let i = 0; i < pts * 2; i++) {
        const a = Math.PI / 2 + (i * Math.PI) / pts;
        const r = i % 2 ? ri : ro;
        poly.push([Math.cos(a) * r, Math.sin(a) * r]);
      }
      return extrudePolys([poly], num(p, 'height', 6));
    }
    case 'heart': {
      const s = num(p, 'size', 20) / 34;
      const poly: [number, number][] = [];
      for (let i = 0; i < 96; i++) {
        const t = (i / 96) * Math.PI * 2;
        poly.push([16 * Math.sin(t) ** 3 * s, (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) * s]);
      }
      return extrudePolys([poly], num(p, 'height', 6));
    }
    case 'text':
    case 'svg': {
      const outline = p.outline as Polygons | undefined;
      if (!outline || outline.length === 0) return null;
      return extrudePolys(outline, num(p, 'height', 5), n.kind === 'svg' && p.fillRule === 'evenodd' ? 'EvenOdd' : 'NonZero');
    }
    case 'mesh': {
      const asset = assets[String(p.asset)];
      return asset ? manifoldFromAsset(asset) : null;
    }
    case 'group': {
      const kids = (n.children ?? []).filter((c) => !c.hidden);
      const solids: Manifold[] = [];
      const holes: Manifold[] = [];
      for (const c of kids) {
        const w = worldSolid(c, assets);
        if (w) (c.hole ? holes : solids).push(w);
      }
      if (solids.length === 0) {
        [...holes].forEach((h) => h.delete());
        return null;
      }
      const u = M.union(solids);
      let out = u;
      if (holes.length) {
        const hu = M.union(holes);
        out = u.subtract(hu);
        u.delete();
        hu.delete();
      }
      [...solids, ...holes].forEach((m) => m.delete());
      return out;
    }
  }
  return null;
}

function extrudePolys(polys: Polygons, height: number, fill: 'NonZero' | 'EvenOdd' = 'NonZero'): Manifold | null {
  const cs = new wasm.CrossSection(polys, fill);
  if (cs.isEmpty()) {
    cs.delete();
    return null;
  }
  const out = cs.extrude(Math.max(0.05, height));
  cs.delete();
  return out;
}

/** Imported triangle soup -> Manifold, merging coincident vertices first. */
export function manifoldFromAsset(asset: MeshAsset): Manifold | null {
  const mesh = new wasm.Mesh({
    numProp: 3,
    vertProperties: new Float32Array(asset.positions),
    triVerts: new Uint32Array(asset.indices),
  });
  mesh.merge();
  try {
    const m = new wasm.Manifold(mesh);
    if (m.status() !== 'NoError' || m.isEmpty()) {
      m.delete();
      return null;
    }
    return m;
  } catch {
    return null;
  }
}

/** True when the 2D outline produces a non-empty region. */
export function polygonsArea(polys: Polygons) {
  const cs: CrossSection = new wasm.CrossSection(polys, 'NonZero');
  const a = cs.area();
  cs.delete();
  return a;
}

export function toBufferGeometry(m: Manifold): THREE.BufferGeometry {
  const mesh = m.getMesh();
  const g = new THREE.BufferGeometry();
  const np = mesh.numProp;
  const pos = new Float32Array((mesh.vertProperties.length / np) * 3);
  for (let i = 0, j = 0; i < mesh.vertProperties.length; i += np, j += 3) {
    pos[j] = mesh.vertProperties[i];
    pos[j + 1] = mesh.vertProperties[i + 1];
    pos[j + 2] = mesh.vertProperties[i + 2];
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(mesh.triVerts, 1));
  // Smooth curved surfaces, keep crisp edges where faces meet at > 30 deg.
  const creased = toCreasedNormals(g, THREE.MathUtils.degToRad(30));
  g.dispose();
  creased.computeBoundingBox();
  creased.computeBoundingSphere();
  return creased;
}

/** Render geometry of a node in local space (cached by shape key). */
export function renderGeometry(n: SceneNode, assets: DesignDoc['assets']): THREE.BufferGeometry | null {
  const key = shapeKey(n, assets);
  const hit = meshCache.get(key);
  if (hit) return hit;
  const s = solidOf(n, assets);
  if (!s) return null;
  const g = toBufferGeometry(s);
  cachePut(meshCache, key, g, (x) => x.dispose());
  return g;
}

// ---------- colour pieces ----------

/**
 * One colour of an object. A group keeps the colour of every child: the group
 * is split into pieces (one per colour) that fit together without overlapping.
 */
export interface Piece {
  color: string;
  /** Filament (core/filaments.ts) the piece is painted with, if any. */
  filament?: string;
  /** Solid in the node's local space. Owned by the cache: never delete it. */
  solid: Manifold;
}

/** Colours and filaments of the solid leaves of a node, in order (cache key). */
export function colorSig(n: SceneNode): string {
  if (n.kind !== 'group') return `${n.color}/${n.filament ?? ''}`;
  return (n.children ?? []).filter((c) => !c.hidden && !c.hole).map(colorSig).join(';');
}

const piecesCache = new Map<string, Piece[]>();
const pieceMeshCache = new Map<string, { geometry: THREE.BufferGeometry; color: string; filament?: string }[]>();

const boxesOverlap = (a: { min: number[]; max: number[] }, b: { min: number[]; max: number[] }) =>
  a.min[0] <= b.max[0] && a.max[0] >= b.min[0] && a.min[1] <= b.max[1] && a.max[1] >= b.min[1] && a.min[2] <= b.max[2] && a.max[2] >= b.min[2];

/**
 * Colour pieces of a node in its local space. Where solids of different colours
 * overlap, the one listed later wins (it is "on top"); holes cut every piece.
 * Pieces of the same colour are united. The union of all pieces equals the node's
 * solid. The result is cached: do not delete the solids.
 */
export function piecesOf(n: SceneNode, assets: DesignDoc['assets']): Piece[] {
  if (n.kind !== 'group') {
    const s = solidOf(n, assets);
    return s ? [{ color: n.color, filament: n.filament, solid: s }] : [];
  }
  const key = `${shapeKey(n, assets)}#${colorSig(n)}`;
  const hit = piecesCache.get(key);
  if (hit) return hit;

  const M = wasm.Manifold;
  const items: { color: string; filament?: string; solid: Manifold }[] = [];
  const holes: Manifold[] = [];
  for (const c of (n.children ?? []).filter((x) => !x.hidden)) {
    if (c.hole) {
      const w = worldSolid(c, assets);
      if (w) holes.push(w);
      continue;
    }
    const m = toMat4(nodeMatrix(c));
    for (const p of piecesOf(c, assets)) items.push({ color: p.color, filament: p.filament, solid: p.solid.transform(m) });
  }
  const holeUnion = holes.length ? M.union(holes) : null;
  holes.forEach((h) => h.delete());
  const holeBox = holeUnion?.boundingBox();

  // Later items win over earlier ones where they overlap.
  const original = items.map((it) => it.solid);
  const cut: { color: string; filament?: string; solid: Manifold }[] = [];
  items.forEach((it, i) => {
    let s = it.solid;
    const sBox = s.boundingBox();
    for (let j = i + 1; j < original.length; j++) {
      if (!boxesOverlap(sBox, original[j].boundingBox())) continue;
      const next = s.subtract(original[j]);
      if (s !== it.solid) s.delete();
      s = next;
    }
    if (holeUnion && holeBox && boxesOverlap(sBox, holeBox)) {
      const next = s.subtract(holeUnion);
      if (s !== it.solid) s.delete();
      s = next;
    }
    if (s !== it.solid) it.solid.delete();
    if (s.isEmpty()) s.delete();
    else cut.push({ color: it.color, filament: it.filament, solid: s });
  });
  holeUnion?.delete();
  // `original` entries were deleted above when replaced; those that survived are in `cut`.

  // Unite pieces of the same colour.
  const byColor = new Map<string, { color: string; filament?: string; list: Manifold[] }>();
  for (const p of cut) {
    const k = `${p.color.toLowerCase()}|${p.filament ?? ''}`;
    const e = byColor.get(k) ?? { color: p.color, filament: p.filament, list: [] };
    e.list.push(p.solid);
    byColor.set(k, e);
  }
  const pieces: Piece[] = [...byColor.values()].map((e) => {
    if (e.list.length === 1) return { color: e.color, filament: e.filament, solid: e.list[0] };
    const u = M.union(e.list);
    e.list.forEach((s) => s.delete());
    return { color: e.color, filament: e.filament, solid: u };
  });
  cachePut(piecesCache, key, pieces, (ps) => ps.forEach((p) => p.solid.delete()));
  return pieces;
}

/** Render geometry of each colour piece of a group (local space). */
export function renderPieces(n: SceneNode, assets: DesignDoc['assets']) {
  const key = `${shapeKey(n, assets)}#${colorSig(n)}`;
  const hit = pieceMeshCache.get(key);
  if (hit) return hit;
  const list = piecesOf(n, assets).map((p) => ({ geometry: toBufferGeometry(p.solid), color: p.color, filament: p.filament }));
  cachePut(pieceMeshCache, key, list, (l) => l.forEach((x) => x.geometry.dispose()));
  return list;
}

/** Fallback render of imported meshes that are not closed solids. */
export function rawAssetGeometry(asset: MeshAsset) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(asset.positions, 3));
  g.setIndex(asset.indices);
  const c = toCreasedNormals(g, THREE.MathUtils.degToRad(30));
  c.computeBoundingBox();
  return c;
}

/** Axis-aligned bounds of a node in world space (uses the exact solid). */
export function worldBounds(n: SceneNode, assets: DesignDoc['assets']): THREE.Box3 | null {
  const g = renderGeometry(n, assets);
  if (!g) return null;
  // Exact bounds: transform every vertex (a rotated local box would be loose).
  const m = nodeMatrix(n);
  const pos = g.getAttribute('position');
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) box.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(m));
  return box;
}

/** Union of every visible, non-hole top-level node, for export. Caller deletes. */
export function exportSolid(doc: DesignDoc, onlyIds?: Set<string>): Manifold | null {
  const parts: Manifold[] = [];
  for (const n of doc.nodes) {
    if (n.hidden || n.hole) continue;
    if (onlyIds && !onlyIds.has(n.id)) continue;
    const w = worldSolid(n, doc.assets);
    if (w) parts.push(w);
  }
  if (!parts.length) return null;
  const u = wasm.Manifold.union(parts);
  parts.forEach((p) => p.delete());
  return u;
}

export const manifoldApi = () => wasm;

export function decompose(m: THREE.Matrix4): Pick<SceneNode, 'position' | 'rotation' | 'scale'> {
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  m.decompose(p, q, s);
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  const r = (v: number, k = 1e4) => Math.round(v * k) / k;
  return {
    position: [r(p.x), r(p.y), r(p.z)],
    rotation: [e.x, e.y, e.z].map((a) => r(THREE.MathUtils.radToDeg(a), 1e3)) as Vec3,
    scale: [r(s.x), r(s.y), r(s.z)],
  };
}

/** Geometry bounds of a node in its own local space (before its scale). */
export function localBox(n: SceneNode, assets: DesignDoc['assets']): THREE.Box3 | null {
  const g = renderGeometry(n, assets);
  if (!g) return null;
  if (!g.boundingBox) g.computeBoundingBox();
  return g.boundingBox!;
}

/**
 * New transform after multiplying the node's scale by `k` per local axis,
 * keeping `fixed` (a point in local, unscaled coordinates) where it is.
 */
export function resizedTransform(n: SceneNode, k: Vec3, fixed: THREE.Vector3) {
  const R = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...(n.rotation.map(THREE.MathUtils.degToRad) as Vec3), 'XYZ'));
  const s0 = new THREE.Vector3(...n.scale);
  const s1 = s0.clone().multiply(new THREE.Vector3(...k));
  const world = fixed.clone().multiply(s0).applyMatrix4(R).add(new THREE.Vector3(...n.position));
  const t1 = world.sub(fixed.clone().multiply(s1).applyMatrix4(R));
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  return {
    position: [r(t1.x), r(t1.y), r(t1.z)] as Vec3,
    rotation: [...n.rotation] as Vec3,
    scale: [r(s1.x), r(s1.y), r(s1.z)] as Vec3,
  };
}
