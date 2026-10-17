import * as THREE from 'three';
import { store, uid, clone } from './store';
import { decompose, localBox, nodeMatrix, renderGeometry, resizedTransform, worldBounds } from './geometry';
import { createNode } from './shapes';
import { filaments } from './filaments';
import { DEFAULT_FONT_ID, loadFont, textToPolygons } from './fonts';
import type { MeshAsset, Params, SceneNode, ShapeKind, Vec3 } from './types';
import { settings } from './settings';

/** Every editing action of the app. Each one is a single undo step. */

const reid = (n: SceneNode): SceneNode => ({ ...n, id: uid(), children: n.children?.map(reid) });

let lastFont = DEFAULT_FONT_ID;
export const getLastFont = () => lastFont;

export async function addShape(kind: ShapeKind, at: Vec3 = [0, 0, 0]) {
  const node = createNode(kind, { position: at });
  if (kind === 'text') {
    node.params.font = lastFont;
    node.params.outline = await computeTextOutline(node.params);
  }
  // Every primitive is built with its base on z = 0, so it lands on the plane.
  store.commit((doc) => doc.nodes.push(node));
  store.select([node.id]);
  return node;
}

export function addImported(nodes: SceneNode[], assets: Record<string, MeshAsset>) {
  store.commit((doc) => {
    Object.assign(doc.assets, assets);
    doc.nodes.push(...nodes);
  });
  store.select(nodes.map((n) => n.id));
}

export async function computeTextOutline(p: Params) {
  const font = await loadFont(String(p.font || DEFAULT_FONT_ID));
  return textToPolygons(font, {
    text: String(p.text ?? '') || ' ',
    size: Number(p.size) || 10,
    letterSpacing: Number(p.letterSpacing) || 0,
    lineHeight: Number(p.lineHeight) || 1.2,
    align: (p.align as 'left' | 'center' | 'right') ?? 'center',
  });
}

/** Change text parameters; re-flattens the glyphs before committing. */
export async function updateText(id: string, patch: Params) {
  const n = store.find(id);
  if (!n || n.kind !== 'text') return;
  const params = { ...n.params, ...patch };
  if (patch.font) lastFont = String(patch.font);
  const layoutChanged = ['text', 'font', 'size', 'letterSpacing', 'lineHeight', 'align'].some((k) => k in patch);
  if (layoutChanged) params.outline = await computeTextOutline(params);
  store.commit((doc) => {
    const t = doc.nodes.find((x) => x.id === id);
    if (t) t.params = params;
  });
}

export function updateNodes(ids: string[], fn: (n: SceneNode) => void) {
  if (!ids.length) return;
  store.commit((doc) => doc.nodes.filter((n) => ids.includes(n.id)).forEach(fn));
}

const selIds = () => [...store.selection];

export function deleteSelection() {
  const ids = new Set(selIds().filter((id) => !store.find(id)?.locked));
  if (!ids.size) return;
  store.commit((doc) => (doc.nodes = doc.nodes.filter((n) => !ids.has(n.id))));
}

export function duplicateSelection(offset: Vec3 = [0, 0, 0]) {
  const src = store.selected;
  if (!src.length) return;
  const copies = src.map((n) => {
    const c = reid(clone(n));
    c.position = c.position.map((v, i) => v + offset[i]) as Vec3;
    c.locked = false;
    return c;
  });
  store.commit((doc) => doc.nodes.push(...copies));
  store.select(copies.map((c) => c.id));
}

let clipboard: SceneNode[] = [];
export const copySelection = () => (clipboard = clone(store.selected));
export function paste() {
  if (!clipboard.length) return;
  const copies = clipboard.map((n) => reid(clone(n)));
  const step = Math.max(settings.snap, 1) * 5;
  copies.forEach((c) => (c.position = [c.position[0] + step, c.position[1] + step, c.position[2]]));
  clipboard = clone(copies);
  store.commit((doc) => doc.nodes.push(...copies));
  store.select(copies.map((c) => c.id));
}

export function toggleHole() {
  const sel = store.selected;
  if (!sel.length) return;
  const makeHole = !sel.every((n) => n.hole);
  updateNodes(selIds(), (n) => (n.hole = makeHole));
}

/** Paint a node; a group paints every solid inside it. */
function paint(n: SceneNode, color: string, filament?: string) {
  n.color = color;
  n.filament = filament;
  if (n.kind === 'group') for (const c of n.children ?? []) if (!c.hole) paint(c, color, filament);
}

export function setColor(color: string) {
  updateNodes(selIds(), (n) => {
    paint(n, color);
    n.hole = false;
  });
}

/** Paint with one of the user's filaments (the colour follows the filament). */
export function setFilament(id: string) {
  const f = filaments.get(id);
  if (!f) return;
  updateNodes(selIds(), (n) => {
    paint(n, f.color, f.id);
    n.hole = false;
  });
}

export function toggleLock() {
  const lock = !store.selected.every((n) => n.locked);
  updateNodes(selIds(), (n) => (n.locked = lock));
}

export function hideSelection() {
  updateNodes(selIds(), (n) => (n.hidden = true));
  store.clearSelection();
}

export function showAll() {
  if (!store.doc.nodes.some((n) => n.hidden)) return;
  store.commit((doc) => doc.nodes.forEach((n) => (n.hidden = false)));
}

function boundsOf(nodes: SceneNode[]) {
  const box = new THREE.Box3();
  nodes.forEach((n) => {
    const b = worldBounds(n, store.doc.assets);
    if (b) box.union(b);
  });
  return box;
}

/** Tinkercad-style group: solids are united, holes are subtracted. */
export function groupSelection() {
  const sel = store.selected.filter((n) => !n.locked);
  if (sel.length < 2) return;
  const box = boundsOf(sel);
  const c = box.getCenter(new THREE.Vector3());
  const origin: Vec3 = [c.x, c.y, box.min.z];
  const solids = sel.filter((n) => !n.hole);
  const group: SceneNode = {
    id: uid(),
    name: 'Grupo',
    kind: 'group',
    params: {},
    hole: solids.length === 0,
    color: solids[0]?.color ?? '#8a94a6',
    position: origin,
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    children: sel.map((n) => ({
      ...clone(n),
      hidden: false,
      position: n.position.map((v, i) => v - origin[i]) as Vec3,
    })),
  };
  const ids = new Set(sel.map((n) => n.id));
  store.commit((doc) => {
    const at = doc.nodes.findIndex((n) => ids.has(n.id));
    doc.nodes = doc.nodes.filter((n) => !ids.has(n.id));
    doc.nodes.splice(Math.max(0, at), 0, group);
  });
  store.select([group.id]);
}

export function ungroupSelection() {
  const groups = store.selected.filter((n) => n.kind === 'group' && !n.locked);
  if (!groups.length) return;
  const released: string[] = [];
  store.commit((doc) => {
    for (const g of groups) {
      const gm = nodeMatrix(g);
      const kids = (g.children ?? []).map((c) => {
        const out = { ...c, ...decompose(gm.clone().multiply(nodeMatrix(c))) };
        released.push(out.id);
        return out;
      });
      const at = doc.nodes.findIndex((n) => n.id === g.id);
      doc.nodes.splice(at, 1, ...kids);
    }
  });
  store.select(released);
}

export type AlignMode = 'min' | 'center' | 'max';

export function align(axis: 0 | 1 | 2, mode: AlignMode) {
  const sel = store.selected.filter((n) => !n.locked);
  if (sel.length < 2) return;
  const all = boundsOf(sel);
  const key = (['x', 'y', 'z'] as const)[axis];
  const target = mode === 'min' ? all.min[key] : mode === 'max' ? all.max[key] : (all.min[key] + all.max[key]) / 2;
  const shifts = new Map<string, number>();
  for (const n of sel) {
    const b = worldBounds(n, store.doc.assets);
    if (!b) continue;
    const cur = mode === 'min' ? b.min[key] : mode === 'max' ? b.max[key] : (b.min[key] + b.max[key]) / 2;
    shifts.set(n.id, target - cur);
  }
  updateNodes([...shifts.keys()], (n) => (n.position[axis] += shifts.get(n.id)!));
}

export function mirror(axis: 0 | 1 | 2) {
  const sel = store.selected.filter((n) => !n.locked);
  if (!sel.length) return;
  const c = boundsOf(sel).getCenter(new THREE.Vector3());
  const s = new THREE.Vector3(1, 1, 1).setComponent(axis, -1);
  const m = new THREE.Matrix4()
    .makeTranslation(c.x, c.y, c.z)
    .multiply(new THREE.Matrix4().makeScale(s.x, s.y, s.z))
    .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
  updateNodes(sel.map((n) => n.id), (n) => Object.assign(n, decompose(m.clone().multiply(nodeMatrix(n)))));
}

/** Rest objects on the workplane (lowest point at z = 0). */
export function dropToPlane() {
  const shifts = new Map<string, number>();
  for (const n of store.selected) {
    const b = worldBounds(n, store.doc.assets);
    if (b && !n.locked && Math.abs(b.min.z) > 1e-6) shifts.set(n.id, -b.min.z);
  }
  updateNodes([...shifts.keys()], (n) => (n.position[2] = +(n.position[2] + shifts.get(n.id)!).toFixed(4)));
}

export function nudge(delta: Vec3) {
  updateNodes(store.selected.filter((n) => !n.locked).map((n) => n.id), (n) => {
    n.position = n.position.map((v, i) => +(v + delta[i]).toFixed(4)) as Vec3;
  });
}

/** Size of the node's own geometry along its local axes (mm, scale included). */
export function localSize(n: SceneNode): Vec3 | null {
  const g = renderGeometry(n, store.doc.assets);
  if (!g?.boundingBox) return null;
  const s = g.boundingBox.getSize(new THREE.Vector3());
  return [s.x * Math.abs(n.scale[0]), s.y * Math.abs(n.scale[1]), s.z * Math.abs(n.scale[2])];
}

/**
 * Resize along a local axis to `mm`. The object stays centred in X/Y and keeps
 * its base, so it does not jump around while you type sizes.
 */
export function setLocalSize(id: string, axis: 0 | 1 | 2, mm: number, uniform = false) {
  const n = store.find(id);
  const size = n && localSize(n);
  const box = n && localBox(n, store.doc.assets);
  if (!n || !size || !box || !(mm > 0) || !(size[axis] > 0)) return;
  const f = mm / size[axis];
  const k: Vec3 = uniform ? [f, f, f] : [axis === 0 ? f : 1, axis === 1 ? f : 1, axis === 2 ? f : 1];
  const c = box.getCenter(new THREE.Vector3());
  const fixed = new THREE.Vector3(c.x, c.y, box.min.z);
  updateNodes([id], (x) => Object.assign(x, resizedTransform(x, k, fixed)));
}

/** Local axis of a node that best matches a world axis (for on-screen sizes). */
export function localAxisFor(n: SceneNode, worldAxis: 0 | 1 | 2): 0 | 1 | 2 {
  const R = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...(n.rotation.map(THREE.MathUtils.degToRad) as Vec3), 'XYZ'));
  const e = R.elements;
  let best: 0 | 1 | 2 = 0;
  let bestV = -1;
  for (const a of [0, 1, 2] as const) {
    const v = Math.abs(e[a * 4 + worldAxis]);
    if (v > bestV) {
      bestV = v;
      best = a;
    }
  }
  return best;
}

export function selectAll() {
  store.select(store.doc.nodes.filter((n) => !n.hidden).map((n) => n.id));
}
