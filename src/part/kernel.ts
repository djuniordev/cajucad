/**
 * OpenCascade kernel (via replicad): turns a PartDef into an exact solid and its mesh.
 * The WASM module is large (~22 MB), so it loads only when a part is first edited.
 */
import type { Drawing, Shape3D } from 'replicad';
import {
  PLANES,
  pointInPolygon,
  polygonArea,
  profilePoints,
  sketchProfiles,
  type Feature,
  type PartDef,
  type Profile,
  type SketchFeature,
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

function featureSolid(rc: Replicad, f: Exclude<Feature, SketchFeature>, sketches: Map<string, SketchFeature>): Shape3D {
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

/** Rebuild the whole history. Stops at the first failing feature and keeps what was built before it. */
export async function buildPart(part: PartDef, upTo?: string): Promise<BuildResult & { shape: Shape3D | null }> {
  const rc = await loadKernel();
  const sketches = new Map<string, SketchFeature>();
  let shape: Shape3D | null = null;
  let error: BuildResult['error'];
  for (const f of part.features) {
    if (f.type === 'sketch') sketches.set(f.id, f);
    else {
      try {
        const tool = featureSolid(rc, f, sketches);
        if (!shape) {
          if (f.op === 'cut' || f.op === 'intersect') throw new Error('Não há sólido para recortar ainda: a primeira operação precisa ser “Juntar”.');
          shape = tool;
        } else if (f.op === 'join') shape = shape.fuse(tool);
        else if (f.op === 'cut') shape = shape.cut(tool);
        else shape = shape.intersect(tool) as Shape3D;
      } catch (e) {
        error = { feature: f.id, message: e instanceof Error ? e.message : String(e) };
        break;
      }
    }
    if (f.id === upTo) break;
  }
  return { shape, mesh: shape ? meshOf(shape) : null, error };
}

function meshOf(shape: Shape3D): PartMesh {
  const m = shape.mesh({ tolerance: 0.02, angularTolerance: 0.2 });
  return { positions: Array.from(m.vertices), indices: Array.from(m.triangles) };
}
