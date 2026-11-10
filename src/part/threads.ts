/**
 * Screw threads are cut into the final mesh with Manifold: OpenCascade booleans with long
 * helical sweeps are unreliable (they silently do nothing or wipe the solid).
 */
import type { ManifoldToplevel } from 'manifold-3d';
import type { V3 } from './model';

export interface ThreadCut {
  /** Axis start point (where the face begins), axis direction and face radius. */
  origin: V3;
  axis: V3;
  radius: number;
  length: number;
  pitch: number;
  /** Outside of a pin (screw) or inside of a hole (nut). */
  outside: boolean;
  lefthand: boolean;
}

let wasm: ManifoldToplevel | null = null;

/** The app passes its already-initialised Manifold module (tests pass their own). */
export function provideManifold(m: ManifoldToplevel) {
  wasm = m;
}

const STEPS = 48; // per turn

/** Closed mesh of the 60° groove swept along the helix. */
function grooveMesh(t: ThreadCut) {
  const a = t.axis;
  const ref: V3 = Math.abs(a[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  let u: V3 = [ref[1] * a[2] - ref[2] * a[1], ref[2] * a[0] - ref[0] * a[2], ref[0] * a[1] - ref[1] * a[0]];
  const l = Math.hypot(...u);
  u = [u[0] / l, u[1] / l, u[2] / l];
  const v: V3 = [a[1] * u[2] - a[2] * u[1], a[2] * u[0] - a[0] * u[2], a[0] * u[1] - a[1] * u[0]];
  const h = (t.outside ? 0.6134 : 0.5413) * t.pitch;
  const e = 0.15;
  const w = (h + e) * Math.tan(Math.PI / 6) * 0.95;
  const base = t.outside ? t.radius + e : t.radius - e;
  const tip = t.outside ? t.radius - h : t.radius + h;
  // Profile in (distance from axis, offset along axis).
  const prof: [number, number][] = [[base, -w], [tip, 0], [base, w]];
  const turns = t.length / t.pitch;
  const n = Math.max(2, Math.ceil(turns * STEPS));
  const pos: number[] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const ang = (t.lefthand ? -1 : 1) * f * turns * Math.PI * 2;
    const z = f * t.length;
    const c = Math.cos(ang), s = Math.sin(ang);
    for (const [r, dy] of prof) {
      for (let k = 0; k < 3; k++) pos.push(t.origin[k] + a[k] * (z + dy) + r * (c * u[k] + s * v[k]));
    }
  }
  const tri: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = i * 3, q = p + 3;
    for (let j = 0; j < 3; j++) {
      const j2 = (j + 1) % 3;
      tri.push(p + j, q + j, q + j2, p + j, q + j2, p + j2);
    }
  }
  // End caps, wound against the side quads they close.
  tri.push(0, 1, 2, n * 3, n * 3 + 2, n * 3 + 1);
  // Make the triangles face outwards (positive volume).
  let vol = 0;
  for (let i = 0; i < tri.length; i += 3) {
    const [A, B, C] = [tri[i], tri[i + 1], tri[i + 2]].map((x) => [pos[x * 3], pos[x * 3 + 1], pos[x * 3 + 2]]);
    vol += A[0] * (B[1] * C[2] - B[2] * C[1]) - A[1] * (B[0] * C[2] - B[2] * C[0]) + A[2] * (B[0] * C[1] - B[1] * C[0]);
  }
  if (vol < 0) for (let i = 0; i < tri.length; i += 3) [tri[i + 1], tri[i + 2]] = [tri[i + 2], tri[i + 1]];
  return { pos, tri };
}

/** Cut the threads into the part mesh. */
export function cutThreads(mesh: { positions: number[]; indices: number[] }, threads: ThreadCut[]) {
  if (!threads.length) return mesh;
  if (!wasm) throw new Error('O módulo de malhas não está pronto para fazer roscas.');
  const toManifold = (pos: ArrayLike<number>, tri: ArrayLike<number>) => {
    const m = new wasm!.Mesh({ numProp: 3, vertProperties: new Float32Array(pos), triVerts: new Uint32Array(tri) });
    m.merge();
    return new wasm!.Manifold(m);
  };
  let body = toManifold(mesh.positions, mesh.indices);
  if (body.status() !== 'NoError') throw new Error('A malha da peça não está fechada; não deu para fazer a rosca.');
  for (const t of threads) {
    const g = grooveMesh(t);
    const groove = toManifold(g.pos, g.tri);
    const next = body.subtract(groove);
    body.delete();
    groove.delete();
    body = next;
  }
  const out = body.getMesh();
  body.delete();
  const np = out.numProp;
  const positions: number[] = [];
  for (let i = 0; i < out.vertProperties.length; i += np) positions.push(out.vertProperties[i], out.vertProperties[i + 1], out.vertProperties[i + 2]);
  return { positions, indices: Array.from(out.triVerts) };
}
