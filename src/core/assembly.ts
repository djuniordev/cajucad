/**
 * Assemblies: snap a face of one part onto a face of another ("Encaixar") and keep the two
 * together with a joint (rigid, revolute, slider, cylindrical, spherical or planar). Joints are
 * solved after every commit. Also: contact (stop at collisions), motion study, exploded view,
 * bill of materials and centre of mass.
 */
import * as THREE from 'three';
import { decompose, nodeMatrix, worldBounds, worldSolid } from './geometry';
import { filaments } from './filaments';
import { clone, store, uid } from './store';
import type { DesignDoc, Joint, JointKind, SceneNode, Vec3 } from './types';

const v3 = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z].map((x) => Math.round(x * 1e5) / 1e5) as Vec3;

/** Joint's own frame: X and Y across the axis, Z along it (in b's local frame). */
function jointBasis(j: Joint) {
  const z = new THREE.Vector3(...j.axis).normalize();
  const seed = Math.abs(z.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const x = seed.sub(z.clone().multiplyScalar(seed.dot(z))).normalize();
  const y = z.clone().cross(x);
  return { x, y, z, o: new THREE.Vector3(...j.origin) };
}

/** Turn or slide of the joint, in b's local frame. */
function motion(j: Joint) {
  const { x, y, z, o } = jointBasis(j);
  const about = (ax: THREE.Vector3, deg: number) =>
    new THREE.Matrix4().makeTranslation(o.x, o.y, o.z).multiply(new THREE.Matrix4().makeRotationAxis(ax, THREE.MathUtils.degToRad(deg))).multiply(new THREE.Matrix4().makeTranslation(-o.x, -o.y, -o.z));
  const along = (ax: THREE.Vector3, d: number) => new THREE.Matrix4().makeTranslation(ax.x * d, ax.y * d, ax.z * d);
  const v2 = j.value2 ?? 0, v3_ = j.value3 ?? 0;
  switch (j.kind) {
    case 'revolute':
      return about(z, j.value);
    case 'slider':
      return along(z, j.value);
    case 'cylindrical':
      return along(z, v2).multiply(about(z, j.value));
    case 'spherical':
      return about(z, v3_).multiply(about(y, v2)).multiply(about(x, j.value));
    case 'planar':
      return along(x, j.value).multiply(along(y, v2)).multiply(about(z, v3_));
    default:
      return new THREE.Matrix4();
  }
}

/** What each value of a joint kind does, for sliders: label, unit, range. */
export const JOINT_VALUES: Record<JointKind, { key: 'value' | 'value2' | 'value3'; label: string; angle: boolean }[]> = {
  rigid: [],
  revolute: [{ key: 'value', label: 'Ângulo', angle: true }],
  slider: [{ key: 'value', label: 'Deslocamento', angle: false }],
  cylindrical: [{ key: 'value', label: 'Ângulo', angle: true }, { key: 'value2', label: 'Deslocamento', angle: false }],
  spherical: [{ key: 'value', label: 'Giro em X', angle: true }, { key: 'value2', label: 'Giro em Y', angle: true }, { key: 'value3', label: 'Giro no eixo', angle: true }],
  planar: [{ key: 'value', label: 'Deslizar X', angle: false }, { key: 'value2', label: 'Deslizar Y', angle: false }, { key: 'value3', label: 'Giro', angle: true }],
};

export const JOINT_LABEL: Record<JointKind, string> = {
  rigid: 'Rígida', revolute: 'Giratória', slider: 'Deslizante', cylindrical: 'Cilíndrica', spherical: 'Esférica', planar: 'Plana',
};

const key = (n: SceneNode) => JSON.stringify([n.position, n.rotation, n.scale]);

/** Transforms of every jointed part before a commit, to tell what the person moved. */
export function jointSnapshot(doc: DesignDoc) {
  const out = new Map<string, string>();
  for (const j of doc.joints ?? []) {
    for (const id of [j.a, j.b]) {
      const n = doc.nodes.find((x) => x.id === id);
      if (n) out.set(id, key(n));
    }
  }
  return out;
}

/**
 * Keep jointed parts together: a part follows when its base moves; moving the part itself
 * re-anchors the joint where it was dropped.
 */
export function solveJoints(doc: DesignDoc, before?: Map<string, string>) {
  if (!doc.joints?.length) return;
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  doc.joints = doc.joints.filter((j) => byId.has(j.a) && byId.has(j.b) && j.a !== j.b);
  // A few passes so chains (c on b on a) settle.
  for (let pass = 0; pass < 4; pass++) {
    for (const j of doc.joints) {
      const a = byId.get(j.a)!, b = byId.get(j.b)!;
      const B = nodeMatrix(b);
      const movedA = before && before.get(a.id) !== undefined && before.get(a.id) !== key(a);
      const movedB = before && before.get(b.id) !== undefined && before.get(b.id) !== key(b);
      if (pass === 0 && movedA && !movedB) {
        // Dropped somewhere else: that becomes the new resting place.
        j.rel = B.clone().multiply(motion(j)).invert().multiply(nodeMatrix(a)).toArray();
        continue;
      }
      const target = B.multiply(motion(j)).multiply(new THREE.Matrix4().fromArray(j.rel));
      const t = decompose(target);
      if (key({ ...a, ...t }) !== key(a)) Object.assign(a, t);
    }
  }
}

export interface SurfaceHit {
  id: string;
  point: Vec3;
  normal: Vec3;
}

/**
 * Move part `from.id` so the clicked face lies on the target face (facing it, touching at the
 * clicked points), and join the two.
 */
export function snapTogether(from: SurfaceHit, to: SurfaceHit) {
  store.commit((doc) => {
    const a = doc.nodes.find((n) => n.id === from.id);
    const b = doc.nodes.find((n) => n.id === to.id);
    if (!a || !b) return;
    const nA = new THREE.Vector3(...from.normal).normalize();
    const nB = new THREE.Vector3(...to.normal).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(nA, nB.clone().negate());
    const pA = new THREE.Vector3(...from.point), pB = new THREE.Vector3(...to.point);
    const m = new THREE.Matrix4()
      .makeTranslation(pB.x, pB.y, pB.z)
      .multiply(new THREE.Matrix4().makeRotationFromQuaternion(q))
      .multiply(new THREE.Matrix4().makeTranslation(-pA.x, -pA.y, -pA.z))
      .multiply(nodeMatrix(a));
    Object.assign(a, decompose(m));
    // The joint sits where the faces touch, turning/sliding along the target face's normal.
    const Binv = nodeMatrix(b).invert();
    const origin = pB.clone().applyMatrix4(Binv);
    const axis = nB.clone().transformDirection(Binv);
    doc.joints = (doc.joints ?? []).filter((j) => j.a !== a.id);
    doc.joints.push({ id: uid(), a: a.id, b: b.id, kind: 'rigid', rel: Binv.multiply(nodeMatrix(a)).toArray(), origin: v3(origin), axis: v3(axis), value: 0 });
  });
}

export const jointOf = (id: string) => store.doc.joints?.find((j) => j.a === id) ?? null;

type JointPatch = Partial<Pick<Joint, 'kind' | 'value' | 'value2' | 'value3' | 'contact'>>;

/** Change a joint. With contact on, a move that pushes the part into another is refused (returns the part it hit). */
export function updateJoint(id: string, patch: JointPatch): string | null {
  const j = store.doc.joints?.find((x) => x.id === id);
  if (!j) return null;
  const moves = patch.value !== undefined || patch.value2 !== undefined || patch.value3 !== undefined;
  if (j.contact && moves) {
    const hit = hitAfter(j, patch);
    if (hit) return hit;
  }
  store.commit((doc) => applyPatch(doc, id, patch));
  return null;
}

function applyPatch(doc: DesignDoc, id: string, patch: JointPatch) {
  const j = doc.joints?.find((x) => x.id === id);
  if (!j) return;
  // Switching kind keeps the part where it is now.
  if (patch.kind && patch.kind !== j.kind) {
    const b = doc.nodes.find((n) => n.id === j.b), a = doc.nodes.find((n) => n.id === j.a);
    if (a && b) j.rel = nodeMatrix(b).invert().multiply(nodeMatrix(a)).toArray();
    j.value = 0;
    j.value2 = 0;
    j.value3 = 0;
    j.kind = patch.kind;
  }
  if (patch.value !== undefined) j.value = patch.value;
  if (patch.value2 !== undefined) j.value2 = patch.value2;
  if (patch.value3 !== undefined) j.value3 = patch.value3;
  if (patch.contact !== undefined) j.contact = patch.contact;
}

/** Name of the part the jointed part would run into after the change, if any. */
function hitAfter(j: Joint, patch: JointPatch): string | null {
  const trial = clone(store.doc);
  applyPatch(trial, j.id, patch);
  solveJoints(trial);
  const others = trial.nodes.filter((n) => n.id !== j.a && !n.hole && !n.hidden).map((n) => n.id);
  return collisionsIn(trial, [j.a], others)[0]?.b ?? null;
}

export function removeJoint(id: string) {
  store.commit((doc) => {
    doc.joints = doc.joints?.filter((j) => j.id !== id);
  });
}

/** Pairs of the given parts that overlap, with the shared volume in mm³. */
export function collisions(ids: string[]) {
  return collisionsIn(store.doc, ids, ids);
}

/** Overlaps between parts of list `as` and parts of list `bs` (each pair once). */
function collisionsIn(doc: DesignDoc, as: string[], bs: string[]) {
  const solid = new Map<string, ReturnType<typeof worldSolid>>();
  const get = (id: string) => {
    if (!solid.has(id)) {
      const n = doc.nodes.find((x) => x.id === id);
      solid.set(id, n && !n.hole ? worldSolid(n, doc.assets) : null);
    }
    return solid.get(id)!;
  };
  const name = (id: string) => doc.nodes.find((n) => n.id === id)?.name ?? '?';
  const out: { a: string; b: string; volume: number }[] = [];
  const seen = new Set<string>();
  for (const a of as)
    for (const b of bs) {
      const pair = [a, b].sort().join('|');
      if (a === b || seen.has(pair)) continue;
      seen.add(pair);
      const A = get(a), B = get(b);
      if (!A || !B) continue;
      const x = A.intersect(B);
      const vol = x.volume();
      x.delete();
      if (vol > 0.01) out.push({ a: name(a), b: name(b), volume: vol });
    }
  for (const s of solid.values()) s?.delete();
  return out;
}

// ---------- motion study ----------

let stopMotion: (() => void) | null = null;

/**
 * Play a joint value from `from` to `to` and back over `seconds` (display only). With contact on,
 * the motion stops where the part runs into another. Ends where it started.
 */
export function playJoint(id: string, which: 'value' | 'value2' | 'value3', from: number, to: number, seconds: number, onEnd?: (hit: string | null) => void) {
  stopMotion?.();
  const j0 = store.doc.joints?.find((x) => x.id === id);
  if (!j0) return;
  const start = clone(store.doc.joints!.find((x) => x.id === id)!);
  const saved = new Map(store.doc.nodes.map((n) => [n.id, { position: [...n.position], rotation: [...n.rotation], scale: [...n.scale] }]));
  let raf = 0;
  let hit: string | null = null;
  const t0 = performance.now();
  const restore = () => {
    store.preview((doc) => {
      const j = doc.joints?.find((x) => x.id === id);
      if (j) Object.assign(j, { value: start.value, value2: start.value2, value3: start.value3 });
      for (const n of doc.nodes) {
        const s = saved.get(n.id);
        if (s) Object.assign(n, s);
      }
    });
  };
  const step = (now: number) => {
    const k = Math.min(1, (now - t0) / (seconds * 1000));
    // There and back again.
    const t = k < 0.5 ? k * 2 : 2 - k * 2;
    const v = from + (to - from) * (0.5 - 0.5 * Math.cos(Math.PI * t));
    const j = store.doc.joints?.find((x) => x.id === id);
    if (!j) return finish();
    if (j.contact) {
      const h = hitAfter(j, { [which]: v });
      if (h) {
        hit = h;
        return finish();
      }
    }
    store.preview(() => (j[which] = v));
    if (k < 1) raf = requestAnimationFrame(step);
    else finish();
  };
  const finish = () => {
    cancelAnimationFrame(raf);
    stopMotion = null;
    // Give the last frame a moment on screen before going back.
    setTimeout(() => {
      restore();
      onEnd?.(hit);
    }, hit ? 700 : 0);
  };
  stopMotion = () => {
    cancelAnimationFrame(raf);
    stopMotion = null;
    restore();
    onEnd?.(null);
  };
  raf = requestAnimationFrame(step);
}

export const motionPlaying = () => !!stopMotion;
export const stopJoint = () => stopMotion?.();

// ---------- exploded view ----------

/** Display offsets of the exploded view (the design itself does not move). */
export const explodeOffsets = new Map<string, Vec3>();
const explodeListeners = new Set<() => void>();
export const onExplode = (fn: () => void) => explodeListeners.add(fn);

/** Spread the top-level parts away from the middle of the assembly; 0 puts them back. */
export function setExplode(amount: number) {
  explodeOffsets.clear();
  if (amount > 0) {
    const doc = store.doc;
    const centres = doc.nodes
      .filter((n) => !n.hidden)
      .map((n) => ({ n, b: worldBounds(n, doc.assets) }))
      .filter((x): x is { n: SceneNode; b: THREE.Box3 } => !!x.b && !x.b.isEmpty());
    const all = new THREE.Box3();
    for (const c of centres) all.union(c.b);
    const mid = all.getCenter(new THREE.Vector3());
    const size = all.getSize(new THREE.Vector3()).length() || 1;
    for (const { n, b } of centres) {
      const d = b.getCenter(new THREE.Vector3()).sub(mid);
      // Parts right at the middle go up, so stacks come apart too.
      if (d.length() < 1e-3) d.set(0, 0, 1);
      const k = (amount / 100) * (0.6 + d.length() / size);
      explodeOffsets.set(n.id, v3(d.normalize().multiplyScalar(k * size)));
    }
  }
  explodeListeners.forEach((f) => f());
}

// Any real change ends the exploded view, so nothing is edited at a place it is not.
store.addCommitHook(
  () => null,
  () => {
    if (explodeOffsets.size) {
      explodeOffsets.clear();
      queueMicrotask(() => explodeListeners.forEach((f) => f()));
    }
  },
);

// ---------- bill of materials and centre of mass ----------

/** g/cm³ of the usual filaments (PLA when unknown). */
const DENSITY: Record<string, number> = { PLA: 1.24, PETG: 1.27, ABS: 1.04, ASA: 1.07, TPU: 1.21, PC: 1.2, PA: 1.14, PVA: 1.23 };

export interface BomRow {
  name: string;
  kind: string;
  qty: number;
  size: Vec3;
  volume: number;
  material: string;
  mass: number;
}

/** Volume (mm³) and centre of a closed triangle mesh. */
function volumeAndCentre(pos: ArrayLike<number>, stride: number, tri: ArrayLike<number>) {
  let vol = 0;
  const c = [0, 0, 0];
  for (let i = 0; i < tri.length; i += 3) {
    const a = tri[i] * stride, b = tri[i + 1] * stride, d = tri[i + 2] * stride;
    const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
    const bx = pos[b], by = pos[b + 1], bz = pos[b + 2];
    const cx = pos[d], cy = pos[d + 1], cz = pos[d + 2];
    const v = (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    vol += v;
    c[0] += v * (ax + bx + cx) / 4;
    c[1] += v * (ay + by + cy) / 4;
    c[2] += v * (az + bz + cz) / 4;
  }
  return { vol, centre: (vol ? c.map((x) => x / vol) : [0, 0, 0]) as Vec3 };
}

/**
 * Parts list of the design (visible solid top-level objects, the same part counted once with
 * its quantity) with total mass and centre of mass.
 */
export function billOfMaterials(doc: DesignDoc = store.doc) {
  const rows = new Map<string, BomRow>();
  let mass = 0;
  const com = new THREE.Vector3();
  for (const n of doc.nodes) {
    if (n.hidden || n.hole) continue;
    const m = worldSolid(n, doc.assets);
    if (!m) continue;
    const mesh = m.getMesh();
    const { vol, centre } = volumeAndCentre(mesh.vertProperties, mesh.numProp, mesh.triVerts);
    m.delete();
    const b = worldBounds(n, doc.assets);
    const size = b ? v3(b.getSize(new THREE.Vector3())) : ([0, 0, 0] as Vec3);
    const material = (n.filament && filaments.get(n.filament)?.type) || 'PLA';
    const g = (Math.abs(vol) / 1000) * (DENSITY[material] ?? 1.24);
    mass += g;
    com.addScaledVector(new THREE.Vector3(...centre), g);
    // Same part = same shape, size and material (linked copies are the same component).
    const sig = `${n.params.component ?? ''}|${n.name.replace(/\s*\(\d+\)$/, '')}|${size.map((x) => x.toFixed(1))}|${Math.round(vol)}|${material}`;
    const row = rows.get(sig);
    if (row) {
      row.qty++;
      row.mass += g;
    } else rows.set(sig, { name: n.name, kind: n.kind, qty: 1, size, volume: Math.abs(vol), material, mass: g });
  }
  return { rows: [...rows.values()], mass, centre: mass ? (v3(com.divideScalar(mass)) as Vec3) : null };
}

/** The list as CSV (semicolon-separated, decimal comma, for spreadsheets in pt-BR). */
export function bomCsv(b: ReturnType<typeof billOfMaterials>) {
  const f = (v: number) => v.toFixed(1).replace('.', ',');
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const lines = ['Peça;Quantidade;Largura (mm);Profundidade (mm);Altura (mm);Volume (cm³);Material;Massa (g)'];
  for (const r of b.rows) lines.push([q(r.name), r.qty, f(r.size[0]), f(r.size[1]), f(r.size[2]), f(r.volume / 1000), r.material, f(r.mass)].join(';'));
  lines.push(`Total;${b.rows.reduce((s, r) => s + r.qty, 0)};;;;;;${f(b.mass)}`);
  return lines.join('\r\n');
}

// Solve joints after every change to the design.
store.addCommitHook(jointSnapshot, solveJoints);
