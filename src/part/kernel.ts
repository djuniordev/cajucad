/**
 * OpenCascade kernel (via replicad): turns a PartDef into an exact solid and its mesh.
 * The WASM module is large (~22 MB), so it loads only when a part is first edited.
 */
import type { Drawing, Edge, Face, Shape3D, Shell, Sketch, Wire } from 'replicad';
import { cutThreads, type ThreadCut } from './threads';
import {
  pointInPolygon,
  polygonArea,
  profilePoints,
  sketchPath,
  sketchProfiles,
  splineBeziers,
  splinePoints,
  curveEnds,
  circleThrough,
  axisLine,
  axisOf,
  emptyRefs,
  frameFromNormal,
  frameOf,
  planeFrame,
  sketchFrame,
  v3,
  type AxisLine,
  type ConstructionFeature,
  type Frame,
  type Refs,
  type Seg,
  type V2,
  type Axis3,
  type BodyOp,
  type HoleFeature,
  type ImportFeature,
  type LoftFeature,
  type SweepFeature,
  type RibFeature,
  type PipeFeature,
  type CoilFeature,
  type EmbossFeature,
  type SurfaceFeature,
  type FlangeFeature,
  type BendFeature,
  type Feature,
  type SketchEntity,
  frameToWorld,
  type ThreadFeature,
  type PartDef,
  type PatternFeature,
  type Profile,
  type SketchFeature,
  type SolidFeature,
  type V3,
} from './model';

type Replicad = typeof import('replicad');
let loading: Promise<Replicad> | null = null;

export function loadKernel(): Promise<Replicad> {
  loading ??= (async () => {
    const [{ default: opencascade }, { default: wasmUrl }, rc] = await Promise.all([
      import('replicad-opencascadejs'),
      import('replicad-opencascadejs/wasm?url'),
      import('replicad'),
    ]);
    const OC = await opencascade({ locateFile: () => wasmUrl });
    rc.setOC(OC);
    return rc;
  })();
  loading.catch(() => (loading = null));
  return loading;
}

/** Use an already initialised replicad (scripts and tests running outside Vite). */
export function provideKernel(rc: Replicad) {
  loading = Promise.resolve(rc);
}

export interface PartMesh {
  positions: number[];
  indices: number[];
  /** Ranges of `indices` that belong to each face of the solid (for picking faces). */
  faces?: { start: number; count: number }[];
}

export interface BuildResult {
  mesh: PartMesh | null;
  /** Id of the feature that failed, with the message; features after it were skipped. */
  error?: { feature: string; message: string };
}

const scale = (v: V3, k: number): V3 => [v[0] * k, v[1] * k, v[2] * k];

/** Construction geometry of the history being built (set at the start of buildPart). */
let refs: Refs = emptyRefs();

function frameFor(s: SketchFeature): Frame {
  const f = sketchFrame(s, refs);
  if (!f) throw new Error(`O plano de “${s.name}” foi apagado ou vem depois do esboço.`);
  return f;
}

function planeFor(rc: Replicad, s: SketchFeature, shift = 0) {
  const f = frameFor(s);
  return new rc.Plane(v3.add(f.o, v3.mul(f.n, shift)), f.x, f.n);
}

/** Draw a chain of segments; a closed one ends with close() (which draws a last straight edge itself). */
function drawSegs(rc: Replicad, start: V2, segs: Seg[], closed: boolean): Drawing {
  const pen = rc.draw(start);
  // Zero-length pieces (repeated points, e.g. in font outlines) break the kernel's curves.
  const near = (a: V2, b: V2) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
  const list = segs.filter((s, i) => s.t !== 'line' || !near(s.to, i ? segs[i - 1].to : start));
  if (closed && list.at(-1)?.t === 'line') list.pop();
  let cur = start;
  for (const s of list) {
    if (s.t === 'line') pen.lineTo(s.to);
    else if (s.t === 'arc') pen.threePointsArcTo(s.to, s.m);
    else for (const [, c1, c2, to] of splineBeziers([cur, ...s.via, s.to])) pen.cubicBezierCurveTo(to, c1, c2);
    cur = s.to;
  }
  return closed ? pen.close() : pen.done();
}

function profileDrawing(rc: Replicad, p: Profile): Drawing {
  if (p.kind === 'circle') return rc.drawCircle(p.r).translate(p.c[0], p.c[1]);
  if (p.kind === 'ellipse') {
    // drawEllipse wants the long radius first, along X.
    const d = p.rx >= p.ry ? rc.drawEllipse(p.rx, p.ry) : rc.drawEllipse(p.ry, p.rx).rotate(90, [0, 0]);
    return d.rotate(p.rot, [0, 0]).translate(p.c[0], p.c[1]);
  }
  return drawSegs(rc, p.start, p.segs, true);
}

/** One 2D region of a sketch: outlines inside an odd number of others become holes. */
export function sketchDrawing(rc: Replicad, s: SketchFeature): Drawing {
  const { profiles } = sketchProfiles(s.entities);
  if (!profiles.length) throw new Error(`“${s.name}” não tem nenhum contorno fechado.`);
  const polys = profiles.map((p) => profilePoints(p, 12));
  const order = profiles.map((_, i) => i).sort((a, b) => polygonArea(polys[b]) - polygonArea(polys[a]));
  let region: Drawing | null = null;
  for (const i of order) {
    const depth = polys.filter((other, j) => j !== i && polys[i].filter((pt) => pointInPolygon(pt, other)).length > polys[i].length / 2).length;
    const d = profileDrawing(rc, profiles[i]);
    region = region === null ? d : depth % 2 ? region.cut(d) : region.fuse(d);
  }
  return region!;
}

function featureSolid(rc: Replicad, f: SolidFeature, sketches: Map<string, SketchFeature>): Shape3D {
  const s = sketches.get(f.sketch);
  if (!s) throw new Error('O esboço desta operação foi apagado.');
  const region = sketchDrawing(rc, s);
  const P = frameFor(s);
  if (f.type === 'extrude') {
    if (!(f.distance > 0)) throw new Error('A distância precisa ser maior que zero.');
    if (f.symmetric) return region.sketchOnPlane(planeFor(rc, s, -f.distance / 2)).extrude(f.distance) as Shape3D;
    const dir = f.reverse ? scale(P.n, -1) : P.n;
    return region.sketchOnPlane(planeFor(rc, s)).extrude(f.distance, { extrusionDirection: dir }) as Shape3D;
  }
  if (!(f.angle > 0 && f.angle <= 360)) throw new Error('O ângulo precisa estar entre 0 e 360°.');
  let ax: AxisLine;
  if (f.axis === 'x' || f.axis === 'y') ax = { o: P.o, d: f.axis === 'x' ? P.x : P.y };
  else {
    const a = refs.axes[f.axis];
    if (!a) throw new Error('O eixo desta revolução foi apagado ou vem depois dela.');
    ax = a;
  }
  return region.sketchOnPlane(planeFor(rc, s)).revolve(ax.d, { origin: ax.o, angle: f.angle }) as Shape3D;
}

/** Each closed outline of a sketch as a wire on its plane, largest first, marked when it is a hole. */
function sketchWires(rc: Replicad, s: SketchFeature): { wire: Wire; hole: boolean }[] {
  const { profiles } = sketchProfiles(s.entities);
  if (!profiles.length) throw new Error(`“${s.name}” não tem nenhum contorno fechado.`);
  const polys = profiles.map((p) => profilePoints(p, 12));
  const order = profiles.map((_, i) => i).sort((a, b) => polygonArea(polys[b]) - polygonArea(polys[a]));
  return order.map((i) => {
    const depth = polys.filter((other, j) => j !== i && polys[i].filter((pt) => pointInPolygon(pt, other)).length > polys[i].length / 2).length;
    return { wire: (profileDrawing(rc, profiles[i]).sketchOnPlane(planeFor(rc, s)) as Sketch).wire, hole: depth % 2 === 1 };
  });
}

function sweepSolid(rc: Replicad, f: SweepFeature, sketches: Map<string, SketchFeature>): Shape3D {
  const s = sketches.get(f.sketch), p = sketches.get(f.path);
  if (!s || !p) throw new Error('Um dos esboços desta varredura foi apagado ou vem depois dela.');
  if (s.id === p.id) throw new Error('O perfil e o caminho precisam ser esboços diferentes.');
  const path = sketchPath(p.entities);
  if (!path) throw new Error(`“${p.name}” precisa ter um caminho só (linhas e arcos ligados, ou um círculo).`);
  let d: Drawing;
  if ('circle' in path) d = rc.drawCircle(path.circle.r).translate(path.circle.c[0], path.circle.c[1]);
  else d = drawSegs(rc, path.start, path.segs, path.closed);
  const spine = (d.sketchOnPlane(planeFor(rc, p)) as Sketch).wire;
  let out: Shape3D | null = null;
  for (const { wire, hole } of sketchWires(rc, s)) {
    const solid = rc.genericSweep(wire, spine, { transitionMode: 'right' });
    out = !out ? solid : hole ? out.cut(solid) : out.fuse(solid);
  }
  return out!;
}

function loftSolid(rc: Replicad, f: LoftFeature, sketches: Map<string, SketchFeature>): Shape3D {
  if (f.sketches.length < 2) throw new Error('Escolha pelo menos dois esboços.');
  const wires = f.sketches.map((id) => {
    const s = sketches.get(id);
    if (!s) throw new Error('Um dos esboços deste loft foi apagado ou vem depois dele.');
    const ws = sketchWires(rc, s);
    if (ws.length !== 1) throw new Error(`“${s.name}” precisa ter um contorno fechado só.`);
    return ws[0].wire;
  });
  return rc.loft(wires, { ruled: f.ruled });
}

/** Plane, axis or point of a construction feature (the solid is needed for faces and edges). */
function construct(rc: Replicad, f: ConstructionFeature, body: Shape3D | null) {
  if (f.type === 'point') {
    refs.points[f.id] = f.at;
    return;
  }
  if (f.type === 'plane') {
    if (f.kind !== 'face') {
      refs.frames[f.id] = planeFrame(f, refs);
      return;
    }
    if (!f.face) throw new Error('Clique numa face plana da peça.');
    if (!body) throw new Error('Ainda não há peça para escolher uma face.');
    const [face] = findNear(rc, body, body.faces, [f.face], 'faces');
    if (face.geomType !== 'PLANE') throw new Error('Esta face não é plana. Escolha uma face reta.');
    const n = face.normalAt(f.face);
    const N: V3 = [n.x, n.y, n.z];
    // Keep the clicked point on the (possibly moved) face.
    const c = face.center;
    const o = v3.sub(f.face, v3.mul(N, v3.dot(v3.sub(f.face, [c.x, c.y, c.z]), N)));
    const fr = frameFromNormal(o, f.flip ? v3.mul(N, -1) : N);
    refs.frames[f.id] = fr;
    return;
  }
  const line = axisLine(f, refs);
  if (line) {
    refs.axes[f.id] = line;
    return;
  }
  if (!f.pick) throw new Error(f.kind === 'edge' ? 'Clique numa aresta reta da peça.' : 'Clique numa face redonda da peça.');
  if (!body) throw new Error('Ainda não há peça para escolher.');
  if (f.kind === 'edge') {
    const [edge] = findNear(rc, body, body.edges, [f.pick], 'arestas');
    if (edge.geomType !== 'LINE') throw new Error('Esta aresta não é reta.');
    const a = edge.startPoint, b = edge.endPoint;
    refs.axes[f.id] = { o: [a.x, a.y, a.z], d: v3.unit([b.x - a.x, b.y - a.y, b.z - a.z]) };
    return;
  }
  const [face] = findNear(rc, body, body.faces, [f.pick], 'faces');
  const c = cylinderOf(rc, face);
  if (!c) throw new Error('Esta face não é redonda (cilíndrica).');
  refs.axes[f.id] = { o: c.loc, d: c.axis };
}

/** Axis and radius of a cylindrical face, with its extent along the axis (V parameters). */
function cylinderOf(rc: Replicad, face: Face) {
  const oc = rc.getOC();
  const ad = new oc.BRepAdaptor_Surface(face.wrapped, true);
  try {
    if (ad.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) return null;
    const cyl = ad.Cylinder();
    const loc = cyl.Location(), dir = cyl.Axis().Direction();
    return { loc: [loc.X(), loc.Y(), loc.Z()] as V3, axis: [dir.X(), dir.Y(), dir.Z()] as V3, radius: cyl.Radius(), v0: ad.FirstVParameter(), v1: ad.LastVParameter() };
  } finally {
    ad.delete();
  }
}

/** Where a thread goes: axis, radius and length of the picked cylindrical face (cut later, on the mesh). */
function threadOn(rc: Replicad, body: Shape3D, f: ThreadFeature): ThreadCut {
  if (!f.face) throw new Error('Clique na face redonda (o lado do pino ou o de dentro do furo).');
  if (!(f.pitch > 0)) throw new Error('O passo precisa ser maior que zero.');
  const [face] = findNear(rc, body, body.faces, [f.face], 'faces');
  const oc = rc.getOC();
  const ad = new oc.BRepAdaptor_Surface(face.wrapped, true);
  try {
    if (ad.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) throw new Error('A rosca vai numa face redonda (cilíndrica).');
    const cyl = ad.Cylinder();
    const R = cyl.Radius();
    const loc = cyl.Location(), dir = cyl.Axis().Direction();
    const axis: V3 = [dir.X(), dir.Y(), dir.Z()];
    // On a cylinder V runs along the axis, so the face's V range is its length.
    const v0 = ad.FirstVParameter(), v1 = ad.LastVParameter();
    const total = v1 - v0;
    const len = f.length > 0 ? Math.min(f.length, total) : total;
    if (!(len > f.pitch)) throw new Error('A face é mais curta que um passo da rosca.');
    const c0: V3 = [loc.X() + axis[0] * v0, loc.Y() + axis[1] * v0, loc.Z() + axis[2] * v0];
    // Outside of a pin or inside of a hole: compare the face normal with the way out from the axis.
    const p = f.face;
    const rel: V3 = [p[0] - c0[0], p[1] - c0[1], p[2] - c0[2]];
    const along = rel[0] * axis[0] + rel[1] * axis[1] + rel[2] * axis[2];
    const radial: V3 = [rel[0] - axis[0] * along, rel[1] - axis[1] * along, rel[2] - axis[2] * along];
    const nrm = face.normalAt(p);
    const outside = nrm.x * radial[0] + nrm.y * radial[1] + nrm.z * radial[2] > 0;
    return { origin: c0, axis, radius: R, length: len, pitch: f.pitch, outside, lefthand: f.lefthand };
  } finally {
    ad.delete();
  }
}

const imported = new Map<string, Shape3D>();

async function importedSolid(rc: Replicad, f: ImportFeature): Promise<Shape3D> {
  const key = `${f.id}:${f.step.length}`;
  let s = imported.get(key);
  if (!s) {
    const any = await rc.importSTEP(new Blob([f.step]));
    if (!('faces' in any) || !any.faces.length) throw new Error('O arquivo STEP não tem sólidos.');
    s = any as Shape3D;
    imported.set(key, s);
  }
  return s.clone();
}

/** STEP file of the finished part (exact geometry, for other CAD programs). */
export async function exportStep(part: PartDef): Promise<Blob> {
  const r = await buildPart(part);
  if (r.error) throw new Error(r.error.message);
  if (!r.shape) throw new Error('A peça ainda não tem sólido.');
  return r.shape.blobSTEP();
}


const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const AXES: Record<Axis3, V3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** Cutting tool of a hole: its half section revolved around the hole axis. */
function holeTool(rc: Replicad, f: HoleFeature): Shape3D {
  if (!f.at) throw new Error('Clique na face onde vai o furo.');
  const r = f.diameter / 2;
  if (!(r > 0)) throw new Error('O diâmetro precisa ser maior que zero.');
  const depth = f.through ? 1000 : f.depth;
  if (!(depth > 0)) throw new Error('A profundidade precisa ser maior que zero.');
  const down = unit(scale(f.n, -1));
  const u = unit(cross(Math.abs(down[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], down));
  // Sketch X runs outwards from the axis and sketch Y goes down into the material.
  const plane = new rc.Plane(f.at, u, cross(u, down));
  const e = 0.05; // start just above the face so the cut is clean
  let pts: [number, number][];
  if (f.kind === 'counterbore') {
    const R = f.headDiameter / 2;
    if (!(R > r)) throw new Error('O diâmetro do rebaixo precisa ser maior que o do furo.');
    if (!(f.headDepth > 0 && f.headDepth < depth)) throw new Error('A profundidade do rebaixo precisa ficar entre zero e a do furo.');
    pts = [[0, -e], [R, -e], [R, f.headDepth], [r, f.headDepth], [r, depth], [0, depth]];
  } else if (f.kind === 'countersink') {
    const R = f.headDiameter / 2;
    if (!(R > r)) throw new Error('O diâmetro do escareado precisa ser maior que o do furo.');
    if (!(R - r < depth)) throw new Error('O furo é raso demais para esse escareado.');
    pts = [[0, -e], [R + e, -e], [r, R - r], [r, depth], [0, depth]];
  } else pts = [[0, -e], [r, -e], [r, depth], [0, depth]];
  const pen = rc.draw(pts[0]);
  for (const p of pts.slice(1)) pen.lineTo(p);
  return pen.close().sketchOnPlane(plane).revolve(down, { origin: f.at }) as Shape3D;
}

/** The edges (or faces) nearest to each remembered point; fails when one has gone away. */
function findNear<T extends Edge | Face>(rc: Replicad, shape: Shape3D, items: T[], points: V3[], what: string): T[] {
  const box = shape.boundingBox;
  const tol = Math.max(0.5, 0.25 * Math.hypot(box.width, box.height, box.depth));
  const out: T[] = [];
  for (const p of points) {
    const v = rc.makeVertex(p);
    let best: T | null = null;
    let bd = Infinity;
    for (const it of items) {
      const d = rc.measureDistanceBetween(it, v);
      if (d < bd) (bd = d), (best = it);
    }
    if (!best || bd > tol) throw new Error(`Não achei mais uma das ${what} escolhidas. Escolha de novo.`);
    if (!out.some((o) => o.isSame(best!))) out.push(best);
  }
  return out;
}

/** Placements of the copies of a pattern (the original excluded). */
function patternCopies(f: PatternFeature): ((s: Shape3D) => Shape3D)[] {
  const out: ((s: Shape3D) => Shape3D)[] = [];
  if (f.kind === 'mirror') {
    const fr = frameOf(f.plane, refs);
    if (!fr) throw new Error('O plano do espelho foi apagado ou vem depois do padrão.');
    return [(s) => s.clone().mirror(fr.n, fr.o)];
  }
  const ax = axisOf(f.axis, refs);
  if (!ax) throw new Error('O eixo do padrão foi apagado ou vem depois dele.');
  const n = Math.round(f.count);
  if (!(n >= 1 && n <= 200)) throw new Error('A quantidade precisa ficar entre 1 e 200.');
  if (f.kind === 'circular') {
    if (!(f.angle > 0 && f.angle <= 360)) throw new Error('O ângulo precisa estar entre 0 e 360°.');
    const step = f.angle >= 360 ? 360 / n : f.angle / Math.max(1, n - 1);
    for (let i = 1; i < n; i++) out.push((s) => s.clone().rotate(i * step, ax.o, ax.d));
    return out;
  }
  const n2 = f.axis2 ? Math.round(f.count2) : 1;
  if (!(n2 >= 1 && n2 <= 200)) throw new Error('A quantidade precisa ficar entre 1 e 200.');
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n2; j++) {
      if (!i && !j) continue;
      const d = scale(ax.d, i * f.spacing);
      const d2 = f.axis2 ? scale(AXES[f.axis2], j * f.spacing2) : ([0, 0, 0] as V3);
      out.push((s) => s.clone().translate([d[0] + d2[0], d[1] + d2[1], d[2] + d2[2]]));
    }
  return out;
}

const combine = (shape: Shape3D, tool: Shape3D, op: BodyOp): Shape3D =>
  op === 'join' ? shape.fuse(tool) : op === 'cut' ? shape.cut(tool) : (shape.intersect(tool) as Shape3D);

export interface BuildOptions {
  /** Stop after this feature. */
  upTo?: string;
  /** Stop just before this feature (what it will work on). */
  before?: string;
  /** Also return the edges as polylines (for picking edges). */
  edges?: boolean;
}

/** A separate solid of the part, named by the feature that created it. */
export interface Body {
  id: string;
  shape: Shape3D;
}

type Built = BuildResult & { shape: Shape3D | null; edges?: number[][]; refs: Refs; bodies: string[]; surfaces: string[] };

/** Rebuild the whole history. Stops at the first failing feature and keeps what was built before it. */
export async function buildPart(part: PartDef, opts: BuildOptions = {}): Promise<Built> {
  const rc = await loadKernel();
  const fl = part.features.findIndex((f) => f.type === 'flatten' && f.on);
  const stop = opts.before ? part.features.findIndex((f) => f.id === opts.before) : -1;
  if (fl < 0 || (stop >= 0 && stop <= fl)) return buildCore(rc, part, opts, null);
  // Points picked on the folded sheet are unfolded with the folds of a folded build first.
  const folds: Fold[] = [];
  const pre = await buildCore(rc, { ...part, features: part.features.slice(0, fl) }, {}, { until: -1, folds });
  if (pre.error) return { ...pre, mesh: null, shape: null, bodies: [], surfaces: [] };
  return buildCore(rc, part, opts, { until: fl, folds });
}

/** What a bend or flange did, to lay points picked on the folded sheet flat again. */
interface Fold {
  id: string;
  /** Edge point on the inside face, sheet across (unit), bend side normal and bend axis direction. */
  P: V3;
  U: V3;
  Nb: V3;
  w: V3;
  /** Bend centre is P + Nb·c; inside radius, thickness, angle (degrees) and flat length of the bend. */
  c: number;
  r: number;
  t: number;
  angle: number;
  ba: number;
}

/** Folded → flat position of a point. */
function unfold(F: Fold, q: V3): V3 {
  const eps = 0.05;
  const d = v3.sub(q, F.P);
  const u = v3.dot(d, F.U), v = v3.dot(d, F.Nb), wv = v3.dot(d, F.w);
  const th = (F.angle * Math.PI) / 180;
  const R = Math.hypot(u, F.c - v);
  const phi = Math.atan2(u, F.c - v);
  const world = (uu: number, vv: number) => v3.add(F.P, v3.add(v3.mul(F.U, uu), v3.add(v3.mul(F.Nb, vv), v3.mul(F.w, wv))));
  if (R >= F.r - eps && R <= F.r + F.t + eps && phi >= -eps && phi <= th + eps && u > -eps) return world((Math.max(0, phi) / th) * F.ba, F.c - R);
  const lo = F.c - F.r - F.t, hi = F.c - F.r;
  if (u <= eps && v >= lo - eps && v <= hi + eps) return q;
  const C = v3.add(F.P, v3.mul(F.Nb, F.c));
  const back = v3.add(C, v3.rotate(v3.sub(q, C), F.w, -F.angle));
  if (v3.dot(v3.sub(back, F.P), F.U) >= -eps) return v3.add(back, v3.mul(F.U, F.ba));
  return q;
}

async function buildCore(rc: Replicad, part: PartDef, opts: BuildOptions, flat: { until: number; folds: Fold[] } | null): Promise<Built> {
  refs = emptyRefs();
  // Sheet metal in effect: thickness, default bend radius, K factor.
  let sheet: { t: number; r: number; k: number } | null = null;
  const sketches = new Map<string, SketchFeature>();
  // Solids each feature added or removed, for patterns.
  const tools = new Map<string, { tool: Shape3D; op: BodyOp }>();
  const threads: ThreadCut[] = [];
  const threadIds: string[] = [];
  const bodies: Body[] = [];
  // The body the next operation works on (the last one made, or the one clicked).
  let cur = -1;
  let error: BuildResult['error'];
  const need = (what: string, at?: V3 | null) => {
    if (!bodies.length) throw new Error(`Não há sólido para ${what} ainda.`);
    if (at && bodies.length > 1) cur = nearestBody(rc, bodies, at);
    return bodies[cur].shape;
  };
  const set = (s: Shape3D) => (bodies[cur].shape = s);
  const add = (id: string, tool: Shape3D, op: BodyOp) => {
    tools.set(id, { tool, op: op === 'new' ? 'join' : op });
    if (op === 'new' || !bodies.length) {
      if (op !== 'join' && op !== 'new') throw new Error('Não há sólido para recortar ainda: a primeira operação precisa ser “Juntar”.');
      bodies.push({ id, shape: tool.clone() });
      cur = bodies.length - 1;
    } else set(combine(bodies[cur].shape, tool.clone(), op));
  };
  for (const [fi, f0] of part.features.entries()) {
    if (f0.id === opts.before) break;
    const flatNow = !!flat && fi < flat.until;
    const f = flatNow ? unfoldPicks(f0, flat!.folds.filter((x) => part.features.findIndex((g) => g.id === x.id) < fi)) : f0;
    try {
      switch (f.type) {
        case 'sheet': {
          if (!(f.thickness > 0)) throw new Error('A espessura precisa ser maior que zero.');
          if (!(f.radius >= 0)) throw new Error('O raio de dobra não pode ser negativo.');
          if (!(f.kfactor >= 0 && f.kfactor <= 1)) throw new Error('O fator K fica entre 0 e 1.');
          sheet = { t: f.thickness, r: f.radius, k: f.kfactor };
          const plate = featureSolid(rc, { id: f.id, type: 'extrude', name: f.name, sketch: f.sketch, distance: f.thickness, symmetric: false, reverse: f.reverse, op: f.op }, sketches);
          add(f.id, plate, f.op);
          break;
        }
        case 'flange': {
          const body = need('fazer a aba', f.edge);
          const out = flangeOn(rc, body, f, sheet, flatNow);
          set(out.shape);
          if (flat && flat.until < 0) flat.folds.push(out.fold);
          break;
        }
        case 'bend': {
          const body = need('dobrar');
          const out = bendOn(rc, body, f, sheet, sketches, flatNow);
          set(out.shape);
          if (flat && flat.until < 0) flat.folds.push(out.fold);
          break;
        }
        case 'flatten':
          break;
        case 'sketch':
          sketches.set(f.id, f);
          break;
        case 'plane':
        case 'axis':
        case 'point': {
          const at = f.type === 'plane' ? f.face : f.type === 'axis' ? f.pick : null;
          construct(rc, f, bodies.length ? need('escolher', at) : null);
          break;
        }
        case 'extrude':
        case 'revolve':
          add(f.id, featureSolid(rc, f, sketches), f.op);
          break;
        case 'sweep':
        case 'loft':
        case 'import':
          add(f.id, f.type === 'sweep' ? sweepSolid(rc, f, sketches) : f.type === 'loft' ? loftSolid(rc, f, sketches) : await importedSolid(rc, f), f.op);
          break;
        case 'rib':
          add(f.id, ribSolid(rc, f, sketches), f.op);
          break;
        case 'pipe':
          add(f.id, pipeSolid(rc, f, sketches), f.op);
          break;
        case 'coil':
          add(f.id, coilSolid(rc, f), f.op);
          break;
        case 'thread':
          threads.push(threadOn(rc, need('roscar', f.face), f));
          threadIds.push(f.id);
          break;
        case 'hole': {
          const body = need('furar', f.at);
          const tool = holeTool(rc, f);
          tools.set(f.id, { tool, op: 'cut' });
          set(body.cut(tool.clone()));
          break;
        }
        case 'fillet':
        case 'chamfer': {
          const body = need(f.type === 'fillet' ? 'arredondar' : 'chanfrar', f.all ? null : f.edges[0]);
          if (!(f.size > 0)) throw new Error('A medida precisa ser maior que zero.');
          if (f.all) set(f.type === 'fillet' ? body.fillet(f.size) : body.chamfer(f.size));
          else {
            if (!f.edges.length) throw new Error('Clique nas arestas da peça.');
            const edges = findNear(rc, body, body.edges, f.edges, 'arestas');
            set(f.type === 'fillet' ? body.fillet(f.size, (e) => e.inList(edges)) : body.chamfer(f.size, (e) => e.inList(edges)));
          }
          break;
        }
        case 'shell': {
          const body = need('esvaziar', f.faces[0]);
          if (!(f.thickness > 0)) throw new Error('A espessura precisa ser maior que zero.');
          if (!f.faces.length) throw new Error('Clique na face que fica aberta.');
          const faces = findNear(rc, body, body.faces, f.faces, 'faces');
          // Positive thickness hollows inwards, keeping the outside size.
          const before = volume(rc, body);
          const out = body.shell(f.thickness, (x) => x.inList(faces));
          // OpenCascade sometimes gives the solid back untouched (e.g. a fillet next to the open face).
          if (Math.abs(volume(rc, out) - before) < before * 1e-6)
            throw new Error('O motor não conseguiu esvaziar assim. Tente uma parede mais fina ou faça a casca antes dos filetes.');
          set(out);
          break;
        }
        case 'pattern': {
          const body = need('repetir');
          const copies = patternCopies(f);
          if (!f.sources.length) {
            let out = body;
            for (const place of copies) out = out.fuse(place(body));
            set(out);
            break;
          }
          for (const id of f.sources) {
            const src = tools.get(id);
            if (!src) throw new Error('Só dá para repetir extrusões, revoluções e furos que vêm antes do padrão.');
            for (const place of copies) set(combine(bodies[cur].shape, place(src.tool), src.op));
          }
          break;
        }
        case 'draft': {
          const body = need('inclinar', f.faces[0]);
          if (!f.faces.length) throw new Error('Clique nas faces que vão inclinar.');
          if (!(Math.abs(f.angle) > 0 && Math.abs(f.angle) < 45)) throw new Error('O ângulo precisa ficar entre 0 e 45°.');
          const fr = frameOf(f.plane, refs);
          if (!fr) throw new Error('O plano neutro foi apagado ou vem depois desta operação.');
          const faces = findNear(rc, body, body.faces, f.faces, 'faces');
          set(body.draft(f.angle, (x) => x.inList(faces), new rc.Plane(fr.o, fr.x, fr.n)));
          break;
        }
        case 'emboss': {
          const body = need('gravar', f.face);
          const { tool, n } = embossTool(rc, f, body);
          // Raised text grows out of the face; engraved text is cut from just above it.
          const solid = tool.extrude(f.depth + (f.engrave ? 0.05 : 0), { extrusionDirection: f.engrave ? v3.mul(n, -1) : n }) as Shape3D;
          set(f.engrave ? body.cut(solid) : body.fuse(solid));
          break;
        }
        case 'pushpull': {
          const body = need('empurrar', f.face);
          if (!f.face) throw new Error('Clique numa face plana da peça.');
          if (!f.distance) throw new Error('A distância não pode ser zero.');
          const [face] = findNear(rc, body, body.faces, [f.face], 'faces');
          if (face.geomType !== 'PLANE') throw new Error('Esta face não é plana. Escolha uma face reta.');
          const nv = face.normalAt(f.face);
          const n: V3 = [nv.x, nv.y, nv.z];
          const slab = rc.basicFaceExtrusion(face, new rc.Vector(v3.mul(n, f.distance)));
          set(f.distance > 0 ? body.fuse(slab) : body.cut(slab));
          break;
        }
        case 'split': {
          const body = need('dividir');
          const fr = frameOf(f.plane, refs);
          if (!fr) throw new Error('O plano da divisão foi apagado ou vem depois dela.');
          const r = body.split(new rc.Plane(fr.o, fr.x, fr.n));
          if (!r.positive || !r.negative) throw new Error('O plano não atravessa o corpo.');
          set((f.keep === 'below' ? r.negative : r.positive) as Shape3D);
          if (f.keep === 'both') {
            bodies.push({ id: f.id, shape: r.negative as Shape3D });
            cur = bodies.length - 1;
          }
          break;
        }
        case 'scale': {
          const body = need('escalar');
          if (!(f.factor > 0)) throw new Error('A escala precisa ser maior que zero.');
          const at = f.point ? refs.points[f.point] : ([0, 0, 0] as V3);
          if (!at) throw new Error('O ponto de referência foi apagado ou vem depois da escala.');
          set(body.scale(f.factor, at));
          break;
        }
        case 'move': {
          const body = need('mover');
          let out = body.clone();
          if (f.angle) {
            const ax = axisOf(f.axis, refs);
            if (!ax) throw new Error('O eixo de giro foi apagado ou vem depois desta operação.');
            out = out.rotate(f.angle, ax.o, ax.d);
          }
          out = out.translate(f.offset);
          if (f.copy) {
            bodies.push({ id: f.id, shape: out });
            cur = bodies.length - 1;
          } else set(out);
          break;
        }
        case 'surface': {
          const sheet = surfaceOf(rc, f, sketches);
          bodies.push({ id: f.id, shape: sheet });
          cur = bodies.length - 1;
          break;
        }
        case 'fill': {
          const body = need('remendar', f.edges[0]);
          if (f.edges.length < 2) throw new Error('Clique nas arestas que fecham o buraco (pelo menos duas).');
          const edges = findNear(rc, body, body.edges, f.edges, 'arestas');
          bodies.push({ id: f.id, shape: fillEdges(rc, edges) });
          cur = bodies.length - 1;
          break;
        }
        case 'stitch': {
          const idx = f.bodies.map((id) => bodies.findIndex((b) => b.id === id));
          if (idx.length < 1) throw new Error('Escolha as superfícies que vão ser costuradas.');
          if (idx.some((i) => i < 0)) throw new Error('Uma das superfícies não existe mais (ou vem depois desta operação).');
          const parts = idx.map((i) => bodies[i].shape) as unknown as (Face | Shell)[];
          let out: Shape3D = rc.weldShellsAndFaces(parts) as Shape3D;
          if (f.solid) {
            try {
              out = rc.makeSolid([out as Shell]);
            } catch {
              throw new Error('As superfícies não fecham um volume: não dá para virar sólido. Desmarque “Virar sólido” ou feche os buracos.');
            }
            if (!(volume(rc, out) > 0)) throw new Error('As superfícies não fecham um volume: não dá para virar sólido.');
          }
          const first = bodies[Math.min(...idx)];
          first.shape = out;
          for (const i of [...idx].sort((a, b) => b - a)) if (bodies[i] !== first) bodies.splice(i, 1);
          cur = bodies.indexOf(first);
          break;
        }
        case 'trim': {
          const t = bodies.findIndex((b) => b.id === f.target);
          if (t < 0) throw new Error('O corpo a aparar não existe mais (ou vem depois desta operação).');
          const target = bodies[t];
          if (f.by === 'plane') {
            const fr = frameOf(f.plane, refs);
            if (!fr) throw new Error('O plano de corte foi apagado ou vem depois desta operação.');
            target.shape = target.shape.cut(halfSpace(rc, target.shape, fr, f.flip));
          } else {
            const k = bodies.findIndex((b) => b.id === f.tool);
            if (k < 0 || k === t) throw new Error('Escolha outro corpo para cortar.');
            target.shape = target.shape.cut(bodies[k].shape.clone());
            if (!f.keepTool) bodies.splice(k, 1);
          }
          cur = bodies.indexOf(target);
          break;
        }
        case 'thicken': {
          const t = bodies.findIndex((b) => b.id === f.target);
          if (t < 0) throw new Error('A superfície não existe mais (ou vem depois desta operação).');
          if (!f.thickness) throw new Error('A espessura não pode ser zero.');
          bodies[t].shape = thicken(rc, bodies[t].shape, f.thickness);
          cur = t;
          break;
        }
        case 'combine': {
          const t = bodies.findIndex((b) => b.id === f.target);
          if (t < 0) throw new Error('O corpo de destino não existe mais (ou vem depois desta operação).');
          const used = f.tools.filter((id) => id !== f.target).map((id) => bodies.findIndex((b) => b.id === id));
          if (!used.length) throw new Error('Escolha pelo menos um corpo para combinar.');
          if (used.some((i) => i < 0)) throw new Error('Um dos corpos não existe mais (ou vem depois desta operação).');
          const target = bodies[t];
          for (const i of used) target.shape = combine(target.shape, bodies[i].shape.clone(), f.op);
          if (!f.keepTools) for (const i of [...used].sort((a, b) => b - a)) bodies.splice(i, 1);
          cur = bodies.indexOf(target);
          break;
        }
      }
      if (cur >= 0 && !bodies[cur].shape.faces.length) throw new Error('A operação apagou o sólido inteiro.');
    } catch (e) {
      error = { feature: f.id, message: kernelMessage(e) };
      break;
    }
    if (f.id === opts.upTo) break;
  }
  // (makeCompound below frees the bodies' shapes.)
  const surfaces = bodies.filter((b) => !isSolid(b.shape)).map((b) => b.id);
  const shape = !bodies.length ? null : bodies.length === 1 ? bodies[0].shape : (rc.makeCompound(bodies.map((b) => b.shape)) as Shape3D);
  const edges = shape && opts.edges ? edgeLines(shape) : undefined;
  let mesh = shape ? meshOf(shape) : null;
  // Threads go on last, on the mesh, so faces stay pickable in the views before them.
  if (mesh && threads.length && !opts.before) {
    try {
      mesh = cutThreads(mesh, threads);
    } catch (e) {
      error ??= { feature: threadIds.at(-1)!, message: kernelMessage(e) };
    }
  }
  return { shape, mesh, error, edges, refs, bodies: bodies.map((b) => b.id), surfaces };
}

/** Points picked on the folded sheet, laid flat (newest fold first). */
function unfoldPicks<T extends Feature>(f: T, folds: Fold[]): T {
  if (!folds.length) return f;
  const m = (p: V3 | null) => (p ? [...folds].reverse().reduce((q, F) => unfold(F, q), p) : p);
  const g = structuredClone(f) as Feature;
  if (g.type === 'flange') g.edge = m(g.edge);
  else if (g.type === 'fillet' || g.type === 'chamfer' || g.type === 'fill') g.edges = g.edges.map((p) => m(p)!);
  else if (g.type === 'shell' || g.type === 'draft') g.faces = g.faces.map((p) => m(p)!);
  else if (g.type === 'thread' || g.type === 'emboss' || g.type === 'pushpull' || g.type === 'plane') g.face = m(g.face);
  else if (g.type === 'axis') g.pick = m(g.pick);
  else if (g.type === 'hole' && g.at) {
    const a = m(g.at)!;
    g.n = v3.unit(v3.sub(m(v3.add(g.at, v3.mul(g.n, 0.01)))!, a));
    g.at = a;
  }
  return g as T;
}

/** The thin end face at a picked straight edge of a sheet, and the faces' directions there. */
function sheetEdge(rc: Replicad, body: Shape3D, at: V3) {
  const [edge] = findNear(rc, body, body.edges, [at], 'arestas');
  if (edge.geomType !== 'LINE') throw new Error('A aba vai numa aresta reta.');
  const a0 = edge.startPoint, b0 = edge.endPoint;
  const A: V3 = [a0.x, a0.y, a0.z], B: V3 = [b0.x, b0.y, b0.z];
  const mid = v3.mul(v3.add(A, B), 0.5);
  const vm = rc.makeVertex(mid);
  const faces = body.faces.filter((f) => f.geomType === 'PLANE' && rc.measureDistanceBetween(f, vm) < 1e-4);
  if (faces.length !== 2) throw new Error('Escolha uma aresta da borda da chapa (entre a face grande e a lateral fina).');
  const [side, big] = [...faces].sort((x, y) => rc.measureArea(x) - rc.measureArea(y));
  const nrm = (f: Face): V3 => {
    const n = f.normalAt(mid);
    return [n.x, n.y, n.z];
  };
  const U = nrm(side), N = nrm(big);
  if (Math.abs(v3.dot(U, N)) > 1e-3) throw new Error('A lateral da chapa precisa ser reta (90°) nessa aresta.');
  const len = v3.len(v3.sub(B, A));
  return { side, A, B, U, N, t: rc.measureArea(side) / len };
}

/** Bend frame shared by flanges and bends. */
function foldFrame(id: string, A: V3, B: V3, U: V3, N: V3, t: number, r: number, angle: number, k: number, flip: boolean): Fold {
  const Nb = flip ? v3.mul(N, -1) : N;
  const w = v3.cross(U, Nb);
  const P = v3.dot(v3.sub(B, A), w) >= 0 ? A : B;
  return { id, P, U, Nb, w, c: flip ? t + r : r, r, t, angle, ba: ((angle * Math.PI) / 180) * (r + k * t) };
}

function flangeOn(rc: Replicad, body: Shape3D, f: FlangeFeature, sheet: { t: number; r: number; k: number } | null, flat: boolean) {
  if (!f.edge) throw new Error('Clique numa aresta da borda da chapa.');
  if (!(f.length > 0)) throw new Error('O comprimento precisa ser maior que zero.');
  if (!(f.angle > 0 && f.angle <= 180)) throw new Error('O ângulo fica entre 0 e 180°.');
  if (!(f.radius >= 0)) throw new Error('O raio de dobra não pode ser negativo.');
  const e = sheetEdge(rc, body, f.edge);
  const fold = foldFrame(f.id, e.A, e.B, e.U, e.N, e.t, f.radius, f.angle, sheet?.k ?? 0.44, f.flip);
  if (flat) return { shape: body.fuse(rc.basicFaceExtrusion(e.side, new rc.Vector(v3.mul(e.U, fold.ba + f.length)))), fold };
  const C = v3.add(fold.P, v3.mul(fold.Nb, fold.c));
  const out = body.fuse(rc.revolution(e.side.clone(), C, fold.w, f.angle));
  const end = e.side.clone().rotate(f.angle, C, fold.w) as Face;
  const d = v3.rotate(e.U, fold.w, f.angle);
  return { shape: out.fuse(rc.basicFaceExtrusion(end, new rc.Vector(v3.mul(d, f.length)))), fold };
}

function bendOn(rc: Replicad, body: Shape3D, f: BendFeature, sheet: { t: number; r: number; k: number } | null, sketches: Map<string, SketchFeature>, flat: boolean) {
  if (!sheet) throw new Error('A dobra é para chapas: comece a peça com “Chapa”.');
  const s = sketches.get(f.sketch);
  if (!s) throw new Error('O esboço da linha de dobra foi apagado ou vem depois da dobra.');
  const lines = s.entities.filter((e): e is Extract<SketchEntity, { t: 'line' }> => e.t === 'line' && !e.construction);
  if (lines.length !== 1) throw new Error(`“${s.name}” precisa ter uma linha só (a linha de dobra).`);
  if (!(f.angle > 0 && f.angle <= 180)) throw new Error('O ângulo fica entre 0 e 180°.');
  if (!(f.radius >= 0)) throw new Error('O raio de dobra não pode ser negativo.');
  const fr = frameFor(s);
  const A = frameToWorld(fr, lines[0].a), B = frameToWorld(fr, lines[0].b);
  // The line lies on a face of the sheet; that face's outward normal is "up".
  const mid = v3.mul(v3.add(A, B), 0.5);
  const [face] = findNear(rc, body, body.faces, [mid], 'faces');
  if (face.geomType !== 'PLANE' || rc.measureDistanceBetween(face, rc.makeVertex(mid)) > 1e-3) throw new Error('Desenhe a linha de dobra sobre uma face plana da chapa.');
  const nv = face.normalAt(mid);
  const N: V3 = [nv.x, nv.y, nv.z];
  const along = v3.unit(v3.sub(B, A));
  let U = v3.unit(v3.cross(along, N));
  if (f.side) U = v3.mul(U, -1);
  const fold = foldFrame(f.id, A, B, U, N, sheet.t, f.radius, f.angle, sheet.k, f.flip);
  if (flat) return { shape: body, fold };
  const cut = (o: V3) => new rc.Plane(o, fold.w, U);
  const halves = body.split(cut(fold.P));
  if (!halves.negative || !halves.positive) throw new Error('A linha de dobra não atravessa a chapa.');
  const fixed = halves.negative as Shape3D;
  // The strip that becomes the bend is taken out, so the flat length stays the same.
  const rest = (halves.positive as Shape3D).split(cut(v3.add(fold.P, v3.mul(U, fold.ba))));
  if (!rest.positive) throw new Error('A dobra é maior que o lado que dobra.');
  const C = v3.add(fold.P, v3.mul(fold.Nb, fold.c));
  const moving = (rest.positive as Shape3D).translate(v3.mul(U, -fold.ba)).rotate(f.angle, C, fold.w);
  // The bend itself: the cut section of the fixed side turned around the bend axis.
  let out: Shape3D = fixed;
  for (const sec of fixed.faces.filter((x) => x.geomType === 'PLANE' && Math.abs(v3.dot(v3.sub([x.center.x, x.center.y, x.center.z], fold.P), U)) < 1e-4))
    out = out.fuse(rc.revolution(sec.clone(), C, fold.w, f.angle));
  return { shape: out.fuse(moving), fold };
}

/** Whether a body encloses volume (as opposed to a surface with no thickness). */
const isSolid = (s: Shape3D) => {
  try {
    return s.solids.length > 0;
  } catch {
    return false;
  }
};

/** Every curve of a sketch as wires on its plane: open chains one by one, closed outlines whole. */
function sketchCurveWires(rc: Replicad, s: SketchFeature): Wire[] {
  const plane = planeFor(rc, s);
  const out: Wire[] = [];
  for (const e of s.entities) {
    if (e.construction || e.t === 'text') continue;
    let d: Drawing;
    if (e.t === 'line' || e.t === 'arc' || e.t === 'spline') {
      const ends = curveEnds(e)!;
      const seg: Seg = e.t === 'line' ? { t: 'line', to: e.b } : e.t === 'arc' ? { t: 'arc', m: e.m, to: e.b } : { t: 'spline', via: e.pts.slice(1, -1), to: ends[1] };
      d = drawSegs(rc, ends[0], [seg], false);
    } else {
      const { profiles } = sketchProfiles([e]);
      if (!profiles.length) continue;
      d = profileDrawing(rc, profiles[0]);
    }
    out.push((d.sketchOnPlane(plane) as Sketch).wire);
  }
  if (!out.length) throw new Error(`“${s.name}” não tem linhas para virar superfície.`);
  return out;
}

function surfaceOf(rc: Replicad, f: SurfaceFeature, sketches: Map<string, SketchFeature>): Shape3D {
  const s = sketches.get(f.sketch);
  if (!s) throw new Error('O esboço desta superfície foi apagado ou vem depois dela.');
  const P = frameFor(s);
  const oc = rc.getOC();
  if (f.kind === 'patch') {
    const ws = sketchWires(rc, s);
    const outer = ws.filter((w) => !w.hole);
    if (outer.length !== 1) throw new Error('O remendo precisa de um contorno fechado só (furos dentro dele podem).');
    return rc.makeFace(outer[0].wire, ws.filter((w) => w.hole).map((w) => w.wire)) as unknown as Shape3D;
  }
  const wires = sketchCurveWires(rc, s);
  const pieces: Shape3D[] = [];
  if (f.kind === 'extrude') {
    if (!(f.distance > 0)) throw new Error('A distância precisa ser maior que zero.');
    const dir = f.symmetric || !f.reverse ? P.n : v3.mul(P.n, -1);
    const shift = f.symmetric ? v3.mul(P.n, -f.distance / 2) : null;
    for (let w of wires) {
      if (shift) w = w.translate(shift);
      const vec = new rc.Vector(v3.mul(dir, f.distance));
      const mk = new oc.BRepPrimAPI_MakePrism(w.wrapped, vec.wrapped, false, true);
      pieces.push(rc.cast(mk.Shape()) as Shape3D);
      mk.delete();
      vec.delete();
    }
  } else {
    if (!(f.angle > 0 && f.angle <= 360)) throw new Error('O ângulo precisa estar entre 0 e 360°.');
    const ax = f.axis === 'x' || f.axis === 'y' ? { o: P.o, d: f.axis === 'x' ? P.x : P.y } : refs.axes[f.axis];
    if (!ax) throw new Error('O eixo desta revolução foi apagado ou vem depois dela.');
    for (const w of wires) {
      const a1 = rc.makeAx1(ax.o, ax.d);
      const mk = new oc.BRepPrimAPI_MakeRevol(w.wrapped, a1, (f.angle * Math.PI) / 180, false);
      pieces.push(rc.cast(mk.Shape()) as Shape3D);
      mk.delete();
      a1.delete();
    }
  }
  return pieces.length === 1 ? pieces[0] : (rc.weldShellsAndFaces(pieces as unknown as (Face | Shell)[], true) as Shape3D);
}

/** A smooth face spanning a closed loop of edges. */
function fillEdges(rc: Replicad, edges: Edge[]): Shape3D {
  const oc = rc.getOC();
  const mk = new oc.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, 1e-4, 1e-2, 0.1, 8, 9);
  try {
    for (const e of edges) mk.Add(e.wrapped, oc.GeomAbs_Shape.GeomAbs_C0, true);
    mk.Build(new oc.Message_ProgressRange());
    if (!mk.IsDone()) throw new Error('fill');
    return rc.cast(mk.Shape()) as Shape3D;
  } catch {
    throw new Error('Não deu para remendar: as arestas escolhidas precisam fechar um contorno.');
  } finally {
    mk.delete();
  }
}

/** Big block on one side of a plane (the side the normal points to when `front`). */
function halfSpace(rc: Replicad, near: Shape3D, fr: Frame, front: boolean): Shape3D {
  const b = near.boundingBox;
  const L = 4 * Math.max(1, Math.hypot(b.width, b.height, b.depth)) + v3.len(v3.sub([b.center[0], b.center[1], b.center[2]], fr.o));
  const dir = front ? fr.n : v3.mul(fr.n, -1);
  return rc.drawRectangle(2 * L, 2 * L).sketchOnPlane(new rc.Plane(fr.o, fr.x, fr.n)).extrude(L, { extrusionDirection: dir }) as Shape3D;
}

/** Solid wall grown from a surface. */
function thicken(rc: Replicad, s: Shape3D, t: number): Shape3D {
  if (isSolid(s)) throw new Error('Este corpo já é sólido: espessar é para superfícies.');
  const oc = rc.getOC();
  const mk = new oc.BRepOffsetAPI_MakeThickSolid();
  try {
    mk.MakeThickSolidBySimple(s.wrapped, t);
    mk.Build(new oc.Message_ProgressRange());
    let out = rc.cast(mk.Shape()) as Shape3D;
    if (!isSolid(out)) throw new Error('thick');
    // Thickening to the back of the surface leaves the solid inside out.
    if (volume(rc, out) < 0) out = rc.cast(out.wrapped.Reversed()) as Shape3D;
    return out;
  } catch {
    throw new Error('O motor não conseguiu espessar esta superfície (tente uma espessura menor).');
  } finally {
    mk.delete();
  }
}

const volume = (rc: Replicad, s: Shape3D) => rc.measureShapeVolumeProperties(s).volume;

/** Index of the body closest to a picked point. */
function nearestBody(rc: Replicad, bodies: Body[], p: V3) {
  const v = rc.makeVertex(p);
  let best = 0, bd = Infinity;
  bodies.forEach((b, i) => {
    const d = rc.measureDistanceBetween(b.shape, v);
    if (d < bd) (bd = d), (best = i);
  });
  return best;
}

/** Thin wall: every open line, arc and curve of the sketch thickened in its plane, then extruded. */
function ribSolid(rc: Replicad, f: RibFeature, sketches: Map<string, SketchFeature>): Shape3D {
  const s = sketches.get(f.sketch);
  if (!s) throw new Error('O esboço desta nervura foi apagado ou vem depois dela.');
  if (!(f.thickness > 0)) throw new Error('A espessura precisa ser maior que zero.');
  if (!(f.distance > 0)) throw new Error('A altura precisa ser maior que zero.');
  const h = f.thickness / 2;
  let region: Drawing | null = null;
  const put = (d: Drawing) => (region = region ? region.fuse(d) : d);
  const joints: V2[] = [];
  const bar = (a: V2, b: V2) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-6) return;
    const nx = (-(b[1] - a[1]) / L) * h, ny = ((b[0] - a[0]) / L) * h;
    put(rc.draw([a[0] + nx, a[1] + ny]).lineTo([b[0] + nx, b[1] + ny]).lineTo([b[0] - nx, b[1] - ny]).lineTo([a[0] - nx, a[1] - ny]).close());
  };
  for (const e of s.entities) {
    if (e.construction) continue;
    if (e.t === 'line') bar(e.a, e.b);
    else if (e.t === 'arc') {
      const c = circleThrough(e.a, e.m, e.b);
      if (!c) bar(e.a, e.b);
      else {
        if (!(c.r > h)) throw new Error('A espessura é maior que o raio de um arco.');
        const at = (p: V2, k: number): V2 => [c.c[0] + ((p[0] - c.c[0]) * k) / c.r, c.c[1] + ((p[1] - c.c[1]) * k) / c.r];
        const o = c.r + h, i = c.r - h;
        put(rc.draw(at(e.a, o)).threePointsArcTo(at(e.b, o), at(e.m, o)).lineTo(at(e.b, i)).threePointsArcTo(at(e.a, i), at(e.m, i)).close());
      }
    } else if (e.t === 'spline') {
      const pts = splinePoints(e.pts, 8);
      for (let i = 0; i < pts.length - 1; i++) bar(pts[i], pts[i + 1]);
      joints.push(...pts.slice(1, -1));
    } else continue;
    const ends = curveEnds(e);
    if (ends) joints.push(...ends);
  }
  if (!region) throw new Error(`“${s.name}” não tem linhas abertas para a nervura.`);
  // Round joints so the walls meet without gaps.
  for (const p of joints) put(rc.drawCircle(h).translate(p[0], p[1]));
  const P = frameFor(s);
  const r = region as Drawing;
  if (f.symmetric) return r.sketchOnPlane(planeFor(rc, s, -f.distance / 2)).extrude(f.distance) as Shape3D;
  return r.sketchOnPlane(planeFor(rc, s)).extrude(f.distance, { extrusionDirection: f.reverse ? scale(P.n, -1) : P.n }) as Shape3D;
}

/** The single path of a sketch as a wire in space. */
function pathWire(rc: Replicad, p: SketchFeature): Wire {
  const path = sketchPath(p.entities);
  if (!path) throw new Error(`“${p.name}” precisa ter um caminho só (linhas e arcos ligados, ou um círculo).`);
  const d = 'circle' in path ? rc.drawCircle(path.circle.r).translate(path.circle.c[0], path.circle.c[1]) : drawSegs(rc, path.start, path.segs, path.closed);
  return (d.sketchOnPlane(planeFor(rc, p)) as Sketch).wire;
}

/** Round section swept along a wire, hollow when `inner` > 0. */
function tubeAlong(rc: Replicad, spine: Wire, outer: number, inner: number, frenet: boolean): Shape3D {
  const p = spine.startPoint, t = spine.tangentAt(0);
  const ring = (r: number) => rc.assembleWire([rc.makeCircle(r, p, t)]);
  const solid = rc.genericSweep(ring(outer), spine, { frenet, transitionMode: 'round' });
  return inner > 0 ? solid.cut(rc.genericSweep(ring(inner), spine, { frenet, transitionMode: 'round' })) : solid;
}

function pipeSolid(rc: Replicad, f: PipeFeature, sketches: Map<string, SketchFeature>): Shape3D {
  const p = sketches.get(f.path);
  if (!p) throw new Error('O esboço do caminho foi apagado ou vem depois do cano.');
  const R = f.diameter / 2;
  if (!(R > 0)) throw new Error('O diâmetro precisa ser maior que zero.');
  if (!(f.wall >= 0 && f.wall < R)) throw new Error('A parede precisa ficar entre zero e o raio do cano.');
  return tubeAlong(rc, pathWire(rc, p), R, f.wall > 0 ? R - f.wall : 0, false);
}

function coilSolid(rc: Replicad, f: CoilFeature): Shape3D {
  const ax = axisOf(f.axis, refs);
  if (!ax) throw new Error('O eixo da mola foi apagado ou vem depois dela.');
  const R = f.diameter / 2, r = f.wire / 2;
  if (!(R > 0 && r > 0)) throw new Error('Os diâmetros precisam ser maiores que zero.');
  if (!(r < R)) throw new Error('O arame é mais grosso que a mola.');
  if (!(f.wire < f.pitch)) throw new Error('O passo precisa ser maior que a espessura do arame (as voltas se encostam).');
  if (!(f.turns > 0 && f.turns <= 200)) throw new Error('As voltas precisam ficar entre 0 e 200.');
  const helix = rc.makeHelix(f.pitch, f.pitch * f.turns, R, ax.o, ax.d);
  return tubeAlong(rc, helix, r, 0, true);
}

/** Text outline laid on the picked face, as a sketch on that face. */
function embossTool(rc: Replicad, f: EmbossFeature, body: Shape3D) {
  if (!f.face) throw new Error('Clique numa face plana da peça.');
  if (!(f.depth > 0)) throw new Error('A profundidade precisa ser maior que zero.');
  if (!f.outline.length) throw new Error('Escreva um texto.');
  const [face] = findNear(rc, body, body.faces, [f.face], 'faces');
  if (face.geomType !== 'PLANE') throw new Error('Esta face não é plana. Escolha uma face reta.');
  const nv = face.normalAt(f.face);
  const n: V3 = [nv.x, nv.y, nv.z];
  refs.frames[f.id] = frameFromNormal(f.face, n);
  const sk = {
    id: f.id, type: 'sketch', name: f.name, plane: f.id, offset: 0,
    entities: [{ id: 't', t: 'text', c: [0, 0], text: f.text, size: f.size, font: f.font, rot: f.rot, outline: f.outline }],
    constraints: [],
  } as unknown as SketchFeature;
  const plane = planeFor(rc, sk, f.engrave ? 0.05 : 0);
  return { tool: sketchDrawing(rc, sk).sketchOnPlane(plane) as Sketch, n };
}

/** OpenCascade failures come out as bare numbers or English; say something useful. */
function kernelMessage(e: unknown) {
  const m = e instanceof Error ? e.message : String(e);
  if (/^\d+$/.test(m) || /BRep|Standard_|StdFail|failed|WebAssembly|\[object/i.test(m)) return 'O motor não conseguiu fazer essa operação com essas medidas (tente um valor menor ou outras arestas).';
  return m;
}

function edgeLines(shape: Shape3D): number[][] {
  const m = shape.meshEdges({ tolerance: 0.02, angularTolerance: 0.2 });
  return m.edgeGroups.map((g) => m.lines.slice(g.start * 3, (g.start + g.count) * 3));
}

function meshOf(shape: Shape3D): PartMesh {
  const m = shape.mesh({ tolerance: 0.02, angularTolerance: 0.2 });
  return { positions: Array.from(m.vertices), indices: Array.from(m.triangles), faces: m.faceGroups.map((g) => ({ start: g.start, count: g.count })) };
}

export { provideManifold } from './threads';
