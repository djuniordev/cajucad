/**
 * OpenCascade kernel (via replicad): turns a PartDef into an exact solid and its mesh.
 * The WASM module is large (~22 MB), so it loads only when a part is first edited.
 */
import type { Drawing, Edge, Face, Shape3D, Sketch, Wire } from 'replicad';
import { cutThreads, type ThreadCut } from './threads';
import {
  pointInPolygon,
  polygonArea,
  profilePoints,
  sketchPath,
  sketchProfiles,
  splineBeziers,
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
  const list = [...segs];
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

/** Rebuild the whole history. Stops at the first failing feature and keeps what was built before it. */
export async function buildPart(part: PartDef, opts: BuildOptions = {}): Promise<BuildResult & { shape: Shape3D | null; edges?: number[][]; refs: Refs }> {
  const rc = await loadKernel();
  refs = emptyRefs();
  const sketches = new Map<string, SketchFeature>();
  // Solids each feature added or removed, for patterns.
  const tools = new Map<string, { tool: Shape3D; op: BodyOp }>();
  const threads: ThreadCut[] = [];
  const threadIds: string[] = [];
  let shape: Shape3D | null = null;
  let error: BuildResult['error'];
  const need = (what: string) => {
    if (!shape) throw new Error(`Não há sólido para ${what} ainda.`);
    return shape;
  };
  for (const f of part.features) {
    if (f.id === opts.before) break;
    try {
      switch (f.type) {
        case 'sketch':
          sketches.set(f.id, f);
          break;
        case 'plane':
        case 'axis':
        case 'point':
          construct(rc, f, shape);
          break;
        case 'extrude':
        case 'revolve': {
          const tool = featureSolid(rc, f, sketches);
          tools.set(f.id, { tool, op: f.op });
          if (!shape) {
            if (f.op !== 'join') throw new Error('Não há sólido para recortar ainda: a primeira operação precisa ser “Juntar”.');
            shape = tool.clone();
          } else shape = combine(shape, tool.clone(), f.op);
          break;
        }
        case 'sweep':
        case 'loft':
        case 'import': {
          const tool = f.type === 'sweep' ? sweepSolid(rc, f, sketches) : f.type === 'loft' ? loftSolid(rc, f, sketches) : await importedSolid(rc, f);
          tools.set(f.id, { tool, op: f.op });
          if (!shape) {
            if (f.op !== 'join') throw new Error('Não há sólido para recortar ainda: a primeira operação precisa ser “Juntar”.');
            shape = tool.clone();
          } else shape = combine(shape, tool.clone(), f.op);
          break;
        }
        case 'thread':
          threads.push(threadOn(rc, need('roscar'), f));
          threadIds.push(f.id);
          break;
        case 'hole': {
          const body = need('furar');
          const tool = holeTool(rc, f);
          tools.set(f.id, { tool, op: 'cut' });
          shape = body.cut(tool.clone());
          break;
        }
        case 'fillet':
        case 'chamfer': {
          const body = need(f.type === 'fillet' ? 'arredondar' : 'chanfrar');
          if (!(f.size > 0)) throw new Error('A medida precisa ser maior que zero.');
          if (f.all) shape = f.type === 'fillet' ? body.fillet(f.size) : body.chamfer(f.size);
          else {
            if (!f.edges.length) throw new Error('Clique nas arestas da peça.');
            const edges = findNear(rc, body, body.edges, f.edges, 'arestas');
            shape = f.type === 'fillet' ? body.fillet(f.size, (e) => e.inList(edges)) : body.chamfer(f.size, (e) => e.inList(edges));
          }
          break;
        }
        case 'shell': {
          const body = need('esvaziar');
          if (!(f.thickness > 0)) throw new Error('A espessura precisa ser maior que zero.');
          if (!f.faces.length) throw new Error('Clique na face que fica aberta.');
          const faces = findNear(rc, body, body.faces, f.faces, 'faces');
          // Positive thickness hollows inwards, keeping the outside size.
          const vol = (s: Shape3D) => rc.measureShapeVolumeProperties(s).volume;
          const before = vol(body);
          shape = body.shell(f.thickness, (x) => x.inList(faces));
          // OpenCascade sometimes gives the solid back untouched (e.g. a fillet next to the open face).
          if (Math.abs(vol(shape) - before) < before * 1e-6)
            throw new Error('O motor não conseguiu esvaziar assim. Tente uma parede mais fina ou faça a casca antes dos filetes.');
          break;
        }
        case 'pattern': {
          const body = need('repetir');
          const copies = patternCopies(f);
          if (!f.sources.length) {
            for (const place of copies) shape = shape!.fuse(place(body));
            break;
          }
          for (const id of f.sources) {
            const src = tools.get(id);
            if (!src) throw new Error('Só dá para repetir extrusões, revoluções e furos que vêm antes do padrão.');
            for (const place of copies) shape = combine(shape!, place(src.tool), src.op);
          }
          break;
        }
      }
      if (shape && !shape.faces.length) throw new Error('A operação apagou o sólido inteiro.');
    } catch (e) {
      error = { feature: f.id, message: kernelMessage(e) };
      break;
    }
    if (f.id === opts.upTo) break;
  }
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
  return { shape, mesh, error, edges, refs };
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
