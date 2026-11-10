/**
 * OpenCascade kernel (via replicad): turns a PartDef into an exact solid and its mesh.
 * The WASM module is large (~22 MB), so it loads only when a part is first edited.
 */
import type { Drawing, Edge, Face, Shape3D } from 'replicad';
import {
  PLANES,
  pointInPolygon,
  polygonArea,
  profilePoints,
  sketchProfiles,
  type Axis3,
  type BodyOp,
  type HoleFeature,
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

function planeFor(rc: Replicad, s: SketchFeature, shift = 0) {
  const P = PLANES[s.plane];
  return new rc.Plane(scale(P.n, s.offset + shift), P.x, P.n);
}

function profileDrawing(rc: Replicad, p: Profile): Drawing {
  if (p.kind === 'circle') return rc.drawCircle(p.r).translate(p.c[0], p.c[1]);
  const pen = rc.draw(p.start);
  const segs = [...p.segs];
  // close() draws the final straight edge back to the start.
  if (segs.at(-1)?.t === 'line') segs.pop();
  for (const s of segs) {
    if (s.t === 'line') pen.lineTo(s.to);
    else pen.threePointsArcTo(s.to, s.m);
  }
  return pen.close();
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
  const P = PLANES[s.plane];
  if (f.type === 'extrude') {
    if (!(f.distance > 0)) throw new Error('A distância precisa ser maior que zero.');
    if (f.symmetric) return region.sketchOnPlane(planeFor(rc, s, -f.distance / 2)).extrude(f.distance) as Shape3D;
    const dir = f.reverse ? scale(P.n, -1) : P.n;
    return region.sketchOnPlane(planeFor(rc, s)).extrude(f.distance, { extrusionDirection: dir }) as Shape3D;
  }
  if (!(f.angle > 0 && f.angle <= 360)) throw new Error('O ângulo precisa estar entre 0 e 360°.');
  const axis = f.axis === 'x' ? P.x : P.y;
  return region.sketchOnPlane(planeFor(rc, s)).revolve(axis, { origin: scale(P.n, s.offset), angle: f.angle }) as Shape3D;
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
  if (f.kind === 'mirror') return [(s) => s.clone().mirror(f.plane, [0, 0, 0])];
  const n = Math.round(f.count);
  if (!(n >= 1 && n <= 200)) throw new Error('A quantidade precisa ficar entre 1 e 200.');
  if (f.kind === 'circular') {
    if (!(f.angle > 0 && f.angle <= 360)) throw new Error('O ângulo precisa estar entre 0 e 360°.');
    const step = f.angle >= 360 ? 360 / n : f.angle / Math.max(1, n - 1);
    for (let i = 1; i < n; i++) out.push((s) => s.clone().rotate(i * step, [0, 0, 0], AXES[f.axis]));
    return out;
  }
  const n2 = f.axis2 ? Math.round(f.count2) : 1;
  if (!(n2 >= 1 && n2 <= 200)) throw new Error('A quantidade precisa ficar entre 1 e 200.');
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n2; j++) {
      if (!i && !j) continue;
      const d = scale(AXES[f.axis], i * f.spacing);
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
export async function buildPart(part: PartDef, opts: BuildOptions = {}): Promise<BuildResult & { shape: Shape3D | null; edges?: number[][] }> {
  const rc = await loadKernel();
  const sketches = new Map<string, SketchFeature>();
  // Solids each feature added or removed, for patterns.
  const tools = new Map<string, { tool: Shape3D; op: BodyOp }>();
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
  return { shape, mesh: shape ? meshOf(shape) : null, error, edges };
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
