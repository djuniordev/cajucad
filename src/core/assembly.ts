/**
 * Simple assemblies: snap a face of one part onto a face of another ("Encaixar") and keep the
 * two together with a joint (rigid, revolute or slider). Joints are solved after every commit.
 */
import * as THREE from 'three';
import { decompose, nodeMatrix, worldSolid } from './geometry';
import { store, uid } from './store';
import type { DesignDoc, Joint, SceneNode, Vec3 } from './types';

const v3 = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z].map((x) => Math.round(x * 1e5) / 1e5) as Vec3;

/** Turn or slide of the joint, in b's local frame. */
function motion(j: Joint) {
  const o = new THREE.Vector3(...j.origin);
  const ax = new THREE.Vector3(...j.axis).normalize();
  if (j.kind === 'revolute') {
    const r = new THREE.Matrix4().makeRotationAxis(ax, THREE.MathUtils.degToRad(j.value));
    return new THREE.Matrix4().makeTranslation(o.x, o.y, o.z).multiply(r).multiply(new THREE.Matrix4().makeTranslation(-o.x, -o.y, -o.z));
  }
  if (j.kind === 'slider') return new THREE.Matrix4().makeTranslation(ax.x * j.value, ax.y * j.value, ax.z * j.value);
  return new THREE.Matrix4();
}

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

export function updateJoint(id: string, patch: Partial<Pick<Joint, 'kind' | 'value'>>) {
  store.commit((doc) => {
    const j = doc.joints?.find((x) => x.id === id);
    if (!j) return;
    // Switching kind keeps the part where it is now.
    if (patch.kind && patch.kind !== j.kind) {
      const b = doc.nodes.find((n) => n.id === j.b), a = doc.nodes.find((n) => n.id === j.a);
      if (a && b) j.rel = nodeMatrix(b).invert().multiply(nodeMatrix(a)).toArray();
      j.value = 0;
      j.kind = patch.kind;
    }
    if (patch.value !== undefined) j.value = patch.value;
  });
}

export function removeJoint(id: string) {
  store.commit((doc) => {
    doc.joints = doc.joints?.filter((j) => j.id !== id);
  });
}

/** Pairs of the given parts that overlap, with the shared volume in mm³. */
export function collisions(ids: string[]) {
  const doc = store.doc;
  const solids = ids
    .map((id) => doc.nodes.find((n) => n.id === id))
    .filter((n): n is SceneNode => !!n && !n.hole)
    .map((n) => ({ n, m: worldSolid(n, doc.assets) }));
  const out: { a: string; b: string; volume: number }[] = [];
  for (let i = 0; i < solids.length; i++)
    for (let k = i + 1; k < solids.length; k++) {
      const A = solids[i].m, B = solids[k].m;
      if (!A || !B) continue;
      const x = A.intersect(B);
      const vol = x.volume();
      x.delete();
      if (vol > 0.01) out.push({ a: solids[i].n.name, b: solids[k].n.name, volume: vol });
    }
  for (const s of solids) s.m?.delete();
  return out;
}

// Solve joints after every change to the design.
store.addCommitHook(jointSnapshot, solveJoints);
