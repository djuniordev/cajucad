/**
 * Parametric part: a history of sketches and features that the OpenCascade kernel
 * (part/kernel.ts) rebuilds into an exact solid. Stored as JSON in a mesh node's
 * `params.part`, next to the tessellated mesh the rest of the app uses.
 */

export type V2 = [number, number];
export type V3 = [number, number, number];

export type SketchEntity =
  | { id: string; t: 'line'; a: V2; b: V2; construction?: boolean }
  /** Arc through three points: start, a point on the arc, end. */
  | { id: string; t: 'arc'; a: V2; m: V2; b: V2; construction?: boolean }
  | { id: string; t: 'circle'; c: V2; r: number; construction?: boolean }
  | { id: string; t: 'rect'; c: V2; w: number; h: number; construction?: boolean }
  /** Regular polygon: centre, circumradius, number of sides. */
  | { id: string; t: 'polygon'; c: V2; r: number; n: number; construction?: boolean }
  /** Ellipse: centre, half-width and half-height before turning `rot` degrees. */
  | { id: string; t: 'ellipse'; c: V2; rx: number; ry: number; rot: number; construction?: boolean }
  /** Smooth curve through the points (ends are its `a` and `b`). */
  | { id: string; t: 'spline'; pts: V2[]; construction?: boolean }
  /** Text outline, kept centred on the origin and placed at `c`, turned `rot` degrees. */
  | { id: string; t: 'text'; c: V2; text: string; size: number; font: string; rot: number; outline: V2[][]; construction?: boolean };

/** Picture traced over in a sketch (data URL), centred at `c`, `w` mm wide. */
export interface SketchImage {
  src: string;
  c: V2;
  w: number;
  /** Height / width of the picture. */
  aspect: number;
  opacity: number;
}

export type PlaneName = 'XY' | 'XZ' | 'YZ';

/** A point of an entity: line/arc ends `a`/`b`, centre `c`; or the sketch origin. */
export type PointRef = { e: string; p: 'a' | 'b' | 'c' } | 'origin';

export type SketchConstraint =
  | { id: string; t: 'coincident'; p1: PointRef; p2: PointRef }
  | { id: string; t: 'horizontal' | 'vertical'; e: string }
  | { id: string; t: 'parallel' | 'perpendicular' | 'equal' | 'tangent' | 'concentric'; e1: string; e2: string }
  /** Point on the middle of a line. */
  | { id: string; t: 'midpoint'; p: PointRef; e: string }
  /** p1 and p2 mirror each other across line e. */
  | { id: string; t: 'symmetric'; p1: PointRef; p2: PointRef; e: string }
  /** Point lying on a line, circle or arc. */
  | { id: string; t: 'onEntity'; p: PointRef; e: string }
  | { id: string; t: 'fix'; p: PointRef; at: V2 }
  // Dimensions (values in mm or degrees).
  | { id: string; t: 'length'; e: string; v: number }
  | { id: string; t: 'diameter'; e: string; v: number }
  | { id: string; t: 'distance'; p1: PointRef; p2: PointRef; v: number }
  /** Angle from e1 to e2 (signed, degrees); `flip` measures against e2 reversed (the angle seen inside a corner). */
  | { id: string; t: 'angle'; e1: string; e2: string; v: number; flip?: boolean };

export const isDimension = (c: SketchConstraint): c is Extract<SketchConstraint, { v: number }> => 'v' in c;

export interface SketchFeature {
  id: string;
  type: 'sketch';
  name: string;
  /** A main plane, or the id of a construction plane. */
  plane: PlaneName | string;
  /** Distance of the sketch plane along its normal, mm. */
  offset: number;
  entities: SketchEntity[];
  constraints?: SketchConstraint[];
  image?: SketchImage;
}

/** Ends of an open curve (lines, arcs, splines). */
export function curveEnds(e: SketchEntity): [V2, V2] | null {
  if (e.t === 'line' || e.t === 'arc') return [e.a, e.b];
  if (e.t === 'spline' && e.pts.length >= 2) return [e.pts[0], e.pts[e.pts.length - 1]];
  return null;
}

/** Turn a point by `deg` degrees around the origin. */
export const rot2 = (p: V2, deg: number): V2 => {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
};

/**
 * Cubic Bézier pieces of a smooth curve through `pts` (Catmull-Rom): [start, control 1, control 2, end].
 * The kernel and the preview both use these, so what you see is what gets built.
 */
export function splineBeziers(pts: V2[]): [V2, V2, V2, V2][] {
  const out: [V2, V2, V2, V2][] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    out.push([p1, [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6], p2]);
  }
  return out;
}

export function splinePoints(pts: V2[], steps = 16): V2[] {
  const out: V2[] = [pts[0]];
  for (const [a, b, c, d] of splineBeziers(pts))
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, u = 1 - t;
      const k = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
      out.push([k[0] * a[0] + k[1] * b[0] + k[2] * c[0] + k[3] * d[0], k[0] * a[1] + k[1] * b[1] + k[2] * c[1] + k[3] * d[1]]);
    }
  return out;
}

export function ellipsePoints(e: { c: V2; rx: number; ry: number; rot: number }, steps = 64): V2[] {
  return Array.from({ length: steps }, (_, i) => {
    const t = (i / steps) * 2 * Math.PI;
    const p = rot2([e.rx * Math.cos(t), e.ry * Math.sin(t)], e.rot);
    return [p[0] + e.c[0], p[1] + e.c[1]] as V2;
  });
}

/** Text outlines placed in the sketch. */
export const textContours = (e: { c: V2; rot: number; outline: V2[][] }): V2[][] =>
  e.outline.map((c) => c.map((p) => {
    const q = rot2(p, e.rot);
    return [q[0] + e.c[0], q[1] + e.c[1]] as V2;
  }));

/** Coordinates of a referenced point, or null when its entity is gone. */
export function refPoint(entities: SketchEntity[], r: PointRef): V2 | null {
  if (r === 'origin') return [0, 0];
  const e = entities.find((x) => x.id === r.e);
  if (!e) return null;
  if (r.p === 'c') {
    if (e.t === 'arc') return circleThrough(e.a, e.m, e.b)?.c ?? null;
    return 'c' in e ? e.c : null;
  }
  const ends = curveEnds(e);
  return ends ? ends[r.p === 'a' ? 0 : 1] : null;
}

export const sameRef = (a: PointRef, b: PointRef) => (a === 'origin' || b === 'origin' ? a === b : a.e === b.e && a.p === b.p);

/** Constraints that mention an entity. */
export function constraintEntities(c: SketchConstraint): string[] {
  const ids: string[] = [];
  const ref = (r: PointRef) => r !== 'origin' && ids.push(r.e);
  if ('e' in c) ids.push(c.e);
  if ('e1' in c) ids.push(c.e1, c.e2);
  if ('p' in c) ref(c.p);
  if ('p1' in c) ref(c.p1), ref(c.p2);
  return ids;
}

/** How a feature's solid combines with the part built so far (`new`: a separate body). */
export type BodyOp = 'join' | 'cut' | 'intersect' | 'new';

export interface ExtrudeFeature {
  id: string;
  type: 'extrude';
  name: string;
  sketch: string;
  distance: number;
  /** Extrude half the distance to each side of the sketch plane. */
  symmetric: boolean;
  /** Extrude against the plane normal. */
  reverse: boolean;
  op: BodyOp;
}

export interface RevolveFeature {
  id: string;
  type: 'revolve';
  name: string;
  sketch: string;
  /** Sketch axis to revolve around (through the sketch origin), or a construction axis id. */
  axis: 'x' | 'y' | string;
  angle: number;
  op: BodyOp;
}

/**
 * Rounded (fillet) or bevelled (chamfer) edges. Edges are remembered by a point on them, so they
 * are found again after the part before them changes; `all` takes every edge.
 */
export interface EdgeFeature {
  id: string;
  type: 'fillet' | 'chamfer';
  name: string;
  edges: V3[];
  all: boolean;
  /** Fillet radius or chamfer distance, mm. */
  size: number;
}

/** Hollow the part, leaving the picked faces open. */
export interface ShellFeature {
  id: string;
  type: 'shell';
  name: string;
  faces: V3[];
  thickness: number;
}

export type HoleKind = 'simple' | 'counterbore' | 'countersink';

/** Drilled hole: starts at `at` on a face and goes against the face normal `n`. */
export interface HoleFeature {
  id: string;
  type: 'hole';
  name: string;
  at: V3 | null;
  n: V3;
  diameter: number;
  depth: number;
  through: boolean;
  kind: HoleKind;
  /** Counterbore: wider top diameter and its depth. Countersink: top diameter (90° cone). */
  headDiameter: number;
  headDepth: number;
}

export type Axis3 = 'x' | 'y' | 'z';

/** Copies of earlier features (or of the whole part when `sources` is empty). */
export interface PatternFeature {
  id: string;
  type: 'pattern';
  name: string;
  kind: 'linear' | 'circular' | 'mirror';
  sources: string[];
  /** Direction (linear) or turning axis through the origin (circular), or a construction axis id. */
  axis: Axis3 | string;
  count: number;
  /** Linear: distance between copies, mm. Circular: total angle, degrees. */
  spacing: number;
  angle: number;
  /** Linear: optional second direction. */
  axis2: Axis3 | null;
  count2: number;
  spacing2: number;
  /** Mirror plane through the origin, or a construction plane id. */
  plane: PlaneName | string;
}

/** Placement of a plane in the world: origin, in-plane X and Y, and normal. */
export interface Frame {
  o: V3;
  x: V3;
  y: V3;
  n: V3;
}
export interface AxisLine {
  o: V3;
  d: V3;
}

/**
 * Construction plane: `offset` from another plane, turned `angle` degrees about one of that
 * plane's axes, through three construction points, or on a flat face of the part.
 */
export interface PlaneFeature {
  id: string;
  type: 'plane';
  name: string;
  kind: 'offset' | 'angle' | 'points' | 'face';
  /** Main plane or construction plane it starts from (offset, angle). */
  ref: string;
  offset: number;
  angle: number;
  hinge: 'x' | 'y';
  points: string[];
  /** Point on the picked face. */
  face: V3 | null;
  flip: boolean;
}

/** Construction axis: a main axis, through two points, along a straight edge or through a round face. */
export interface AxisFeature {
  id: string;
  type: 'axis';
  name: string;
  kind: 'world' | 'points' | 'edge' | 'cylinder';
  world: Axis3;
  points: string[];
  pick: V3 | null;
}

/** Construction point: typed in, or clicked on the part. */
export interface PointFeature {
  id: string;
  type: 'point';
  name: string;
  at: V3;
}

export type ConstructionFeature = PlaneFeature | AxisFeature | PointFeature;

/** Faces tilted by `angle` degrees from where they cross the neutral plane (mould release). */
export interface DraftFeature {
  id: string;
  type: 'draft';
  name: string;
  faces: V3[];
  angle: number;
  plane: string;
}

/** Thin wall along the open lines of a sketch. */
export interface RibFeature {
  id: string;
  type: 'rib';
  name: string;
  sketch: string;
  thickness: number;
  distance: number;
  symmetric: boolean;
  reverse: boolean;
  op: BodyOp;
}

/** Round tube along the path of a sketch (`wall` 0 = solid rod). */
export interface PipeFeature {
  id: string;
  type: 'pipe';
  name: string;
  path: string;
  diameter: number;
  wall: number;
  op: BodyOp;
}

/** Spring: round wire wound around an axis. */
export interface CoilFeature {
  id: string;
  type: 'coil';
  name: string;
  axis: string;
  diameter: number;
  pitch: number;
  turns: number;
  wire: number;
  op: BodyOp;
}

/** Text raised from (or cut into) a flat face. */
export interface EmbossFeature {
  id: string;
  type: 'emboss';
  name: string;
  face: V3 | null;
  text: string;
  font: string;
  size: number;
  rot: number;
  /** Text outline centred on the origin (laid out by the editor). */
  outline: V2[][];
  depth: number;
  engrave: boolean;
}

/** Cut the current body in two with a plane. */
export interface SplitFeature {
  id: string;
  type: 'split';
  name: string;
  plane: string;
  keep: 'both' | 'above' | 'below';
}

/** Move a flat face along its normal (adds or removes material). */
export interface PushPullFeature {
  id: string;
  type: 'pushpull';
  name: string;
  face: V3 | null;
  distance: number;
}

/** Uniform scale of the current body about a point (origin when empty). */
export interface ScaleFeature {
  id: string;
  type: 'scale';
  name: string;
  factor: number;
  point: string;
}

/** Move (or copy, as a new body) the current body. */
export interface MoveFeature {
  id: string;
  type: 'move';
  name: string;
  offset: V3;
  angle: number;
  axis: string;
  copy: boolean;
}

/** Join, cut or intersect bodies. */
export interface CombineFeature {
  id: string;
  type: 'combine';
  name: string;
  /** Bodies are named by the feature that created them. */
  target: string;
  tools: string[];
  op: 'join' | 'cut' | 'intersect';
  keepTools: boolean;
}

/**
 * Surface (zero thickness) made from a sketch: its lines and curves pulled straight (`extrude`)
 * or turned around an axis (`revolve`), or its closed outline filled flat (`patch`).
 * Always a new body.
 */
export interface SurfaceFeature {
  id: string;
  type: 'surface';
  name: string;
  kind: 'extrude' | 'revolve' | 'patch';
  sketch: string;
  distance: number;
  symmetric: boolean;
  reverse: boolean;
  axis: 'x' | 'y' | string;
  angle: number;
}

/** Curved patch filling a closed loop of picked edges (e.g. the open end of a surface). */
export interface FillFeature {
  id: string;
  type: 'fill';
  name: string;
  edges: V3[];
}

/** Sew surfaces along shared edges into one; closed ones can become a solid. */
export interface StitchFeature {
  id: string;
  type: 'stitch';
  name: string;
  bodies: string[];
  solid: boolean;
}

/** Cut away part of a body (usually a surface) with a plane or with another body. */
export interface TrimFeature {
  id: string;
  type: 'trim';
  name: string;
  target: string;
  by: 'plane' | 'body';
  plane: string;
  tool: string;
  /** Plane: keep the side behind the plane instead of the one in front. */
  flip: boolean;
  keepTool: boolean;
}

/** Turn a surface into a solid wall of the given thickness (negative = the other side). */
export interface ThickenFeature {
  id: string;
  type: 'thicken';
  name: string;
  target: string;
  thickness: number;
}

/** Sheet metal plate from a closed sketch; later flanges and bends take its thickness and K factor. */
export interface SheetFeature {
  id: string;
  type: 'sheet';
  name: string;
  sketch: string;
  thickness: number;
  /** Default inside bend radius for flanges and bends. */
  radius: number;
  /** Where the neutral line sits across the thickness (0..1), for the flat length of bends. */
  kfactor: number;
  reverse: boolean;
  op: BodyOp;
}

/** Wall bent up from a straight edge of the sheet. */
export interface FlangeFeature {
  id: string;
  type: 'flange';
  name: string;
  edge: V3 | null;
  length: number;
  angle: number;
  radius: number;
  /** Bend to the other side of the sheet. */
  flip: boolean;
}

/** Bend the sheet along the line of a sketch drawn on it. */
export interface BendFeature {
  id: string;
  type: 'bend';
  name: string;
  sketch: string;
  angle: number;
  radius: number;
  flip: boolean;
  /** Which side of the line moves. */
  side: boolean;
}

/** Show (and print) the sheet unfolded: bends and flanges before it are laid flat. */
export interface FlattenFeature {
  id: string;
  type: 'flatten';
  name: string;
  on: boolean;
}

export type SheetMetalFeature = SheetFeature | FlangeFeature | BendFeature | FlattenFeature;

export type SurfaceOpFeature =SurfaceFeature | FillFeature | StitchFeature | TrimFeature | ThickenFeature;

export type SolidModFeature =DraftFeature | RibFeature | PipeFeature | CoilFeature | EmbossFeature | SplitFeature | PushPullFeature | ScaleFeature | MoveFeature | CombineFeature;

/** A closed profile carried along a path (open or closed lines/arcs of another sketch). */
export interface SweepFeature {
  id: string;
  type: 'sweep';
  name: string;
  sketch: string;
  path: string;
  op: BodyOp;
}

/** Solid blending through the outlines of two or more sketches, in order. */
export interface LoftFeature {
  id: string;
  type: 'loft';
  name: string;
  sketches: string[];
  /** Straight sides between sections instead of smooth ones. */
  ruled: boolean;
  op: BodyOp;
}

/** Screw thread (60° metric profile) cut into a cylindrical face, outside (screw) or inside (nut). */
export interface ThreadFeature {
  id: string;
  type: 'thread';
  name: string;
  /** Point on the cylindrical face. */
  face: V3 | null;
  pitch: number;
  /** Thread length from the face's start; 0 = the whole face. */
  length: number;
  lefthand: boolean;
}

/** Solid read from a STEP file (kept inside the part). */
export interface ImportFeature {
  id: string;
  type: 'import';
  name: string;
  file: string;
  step: string;
  op: BodyOp;
}

export type SolidFeature = ExtrudeFeature | RevolveFeature;
export type Feature =
  | SketchFeature
  | SolidFeature
  | EdgeFeature
  | ShellFeature
  | HoleFeature
  | PatternFeature
  | SweepFeature
  | LoftFeature
  | ThreadFeature
  | ImportFeature
  | ConstructionFeature
  | SolidModFeature
  | SurfaceOpFeature
  | SheetMetalFeature;

/** Sketches a feature is built from. */
export function featureSketches(f: Feature): string[] {
  if (f.type === 'extrude' || f.type === 'revolve') return [f.sketch];
  if (f.type === 'sweep') return [f.sketch, f.path];
  if (f.type === 'loft') return f.sketches;
  if (f.type === 'rib') return [f.sketch];
  if (f.type === 'pipe') return [f.path];
  if (f.type === 'surface' || f.type === 'sheet' || f.type === 'bend') return [f.sketch];
  return [];
}

/** Every other feature a feature depends on (sketches, construction geometry, pattern sources). */
export function featureRefs(f: Feature): string[] {
  const out = [...featureSketches(f)];
  if (f.type === 'sketch') out.push(f.plane);
  if (f.type === 'revolve') out.push(f.axis);
  if (f.type === 'pattern') out.push(...f.sources, f.axis, f.plane);
  if (f.type === 'plane') out.push(f.ref, ...f.points);
  if (f.type === 'axis') out.push(...f.points);
  if (f.type === 'draft' || f.type === 'split') out.push(f.plane);
  if (f.type === 'coil' || f.type === 'move') out.push(f.axis);
  if (f.type === 'scale') out.push(f.point);
  if (f.type === 'combine') out.push(f.target, ...f.tools);
  if (f.type === 'surface' && f.kind === 'revolve') out.push(f.axis);
  if (f.type === 'stitch') out.push(...f.bodies);
  if (f.type === 'trim') out.push(f.target, f.by === 'plane' ? f.plane : f.tool);
  if (f.type === 'thicken') out.push(f.target);
  return out;
}

export const isConstruction = (f: Feature): f is ConstructionFeature => f.type === 'plane' || f.type === 'axis' || f.type === 'point';

// ---------- 3D vectors and frames ----------

export const v3 = {
  add: (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k],
  dot: (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a: V3) => Math.hypot(a[0], a[1], a[2]),
  unit: (a: V3): V3 => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
  /** Turn v by `deg` degrees around the unit axis k (Rodrigues). */
  rotate: (v: V3, k: V3, deg: number): V3 => {
    const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
    const kv = v3.cross(k, v), kd = v3.dot(k, v);
    return [0, 1, 2].map((i) => v[i] * c + kv[i] * s + k[i] * kd * (1 - c)) as V3;
  },
};

export const worldFrame = (p: PlaneName): Frame => ({ o: [0, 0, 0], x: PLANES[p].x, y: PLANES[p].y, n: PLANES[p].n });

/** In-plane X for a plane with normal n: world X (or Y) laid onto the plane. */
export function frameFromNormal(o: V3, n: V3): Frame {
  const N = v3.unit(n);
  const seed: V3 = Math.abs(N[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const x = v3.unit(v3.sub(seed, v3.mul(N, v3.dot(seed, N))));
  return { o, x, y: v3.cross(N, x), n: N };
}

/** Construction geometry known so far while (re)building the history. */
export interface Refs {
  frames: Record<string, Frame>;
  axes: Record<string, AxisLine>;
  points: Record<string, V3>;
}
export const emptyRefs = (): Refs => ({ frames: {}, axes: {}, points: {} });

/** A main plane or a construction plane. */
export function frameOf(ref: string, refs: Refs): Frame | null {
  if (ref in PLANES) return worldFrame(ref as PlaneName);
  return refs.frames[ref] ?? null;
}

/** Where a sketch lies, its offset included. */
export function sketchFrame(s: Pick<SketchFeature, 'plane' | 'offset'>, refs: Refs): Frame | null {
  const f = frameOf(s.plane, refs);
  return f && { ...f, o: v3.add(f.o, v3.mul(f.n, s.offset)) };
}

export const AXIS_DIR: Record<Axis3, V3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** Frame of a construction plane that does not need the solid (all kinds but `face`). */
export function planeFrame(f: PlaneFeature, refs: Refs): Frame {
  if (f.kind === 'points') {
    const ps = f.points.map((id) => refs.points[id]);
    if (ps.length !== 3 || ps.some((p) => !p)) throw new Error('Escolha três pontos de construção.');
    const n = v3.cross(v3.sub(ps[1], ps[0]), v3.sub(ps[2], ps[0]));
    if (v3.len(n) < 1e-9) throw new Error('Os três pontos estão em linha: não formam um plano.');
    const x = v3.unit(v3.sub(ps[1], ps[0]));
    const N = v3.unit(f.flip ? v3.mul(n, -1) : n);
    return { o: ps[0], x, y: v3.cross(N, x), n: N };
  }
  const base = frameOf(f.ref, refs);
  if (!base) throw new Error('O plano de base foi apagado ou vem depois deste.');
  let fr: Frame = base;
  if (f.kind === 'angle') {
    const k = f.hinge === 'x' ? base.x : base.y;
    fr = { o: base.o, x: v3.rotate(base.x, k, f.angle), y: v3.rotate(base.y, k, f.angle), n: v3.rotate(base.n, k, f.angle) };
  }
  fr = { ...fr, o: v3.add(fr.o, v3.mul(fr.n, f.kind === 'offset' ? f.offset : 0)) };
  return f.flip ? { o: fr.o, x: fr.x, y: v3.mul(fr.y, -1), n: v3.mul(fr.n, -1) } : fr;
}

/** Axis that does not need the solid (main axes and two points). */
export function axisLine(f: AxisFeature, refs: Refs): AxisLine | null {
  if (f.kind === 'world') return { o: [0, 0, 0], d: AXIS_DIR[f.world] };
  if (f.kind === 'points') {
    const ps = f.points.map((id) => refs.points[id]);
    if (ps.length !== 2 || ps.some((p) => !p)) throw new Error('Escolha dois pontos de construção.');
    const d = v3.sub(ps[1], ps[0]);
    if (v3.len(d) < 1e-9) throw new Error('Os dois pontos são o mesmo.');
    return { o: ps[0], d: v3.unit(d) };
  }
  return null;
}

/** Main axis name or construction axis id, as a line. */
export function axisOf(ref: string, refs: Refs): AxisLine | null {
  if (ref === 'x' || ref === 'y' || ref === 'z') return { o: [0, 0, 0], d: AXIS_DIR[ref] };
  return refs.axes[ref] ?? null;
}

export interface PartDef {
  version: 1;
  features: Feature[];
  /** Named values with formulas (see params.ts). */
  params?: { name: string; expr: string }[];
  /** Parameter overrides by name, and the active one (none = the parameters as written). */
  configs?: { id: string; name: string; values: Record<string, string> }[];
  config?: string;
  /** Number fields driven by formulas: feature id → field key → formula. */
  exprs?: Record<string, Record<string, string>>;
}

export const emptyPart = (): PartDef => ({ version: 1, features: [] });

/** Sketch planes in CajuCAD's world (Z up): origin direction, sketch X and the plane normal. */
export const PLANES: Record<PlaneName, { label: string; x: V3; y: V3; n: V3 }> = {
  XY: { label: 'Chão (XY)', x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] },
  XZ: { label: 'Frente (XZ)', x: [1, 0, 0], y: [0, 0, 1], n: [0, -1, 0] },
  YZ: { label: 'Lateral (YZ)', x: [0, 1, 0], y: [0, 0, 1], n: [1, 0, 0] },
};

/** World point of a point on a frame. */
export const frameToWorld = (f: Frame, p: V2): V3 => v3.add(f.o, v3.add(v3.mul(f.x, p[0]), v3.mul(f.y, p[1])));

/** Name of a main or construction plane, for lists. */
export function planeLabel(ref: string, features: Feature[]) {
  if (ref in PLANES) return PLANES[ref as PlaneName].label;
  return features.find((f) => f.id === ref)?.name ?? '(plano apagado)';
}

export const fid = () => Math.random().toString(36).slice(2, 9);

export function parsePart(json: unknown): PartDef | null {
  if (typeof json !== 'string' || !json) return null;
  try {
    const p = JSON.parse(json) as PartDef;
    return p && p.version === 1 && Array.isArray(p.features) ? p : null;
  } catch {
    return null;
  }
}

export const featureLabel: Record<Feature['type'], string> = {
  sketch: 'Esboço', extrude: 'Extrusão', revolve: 'Revolução', fillet: 'Filete', chamfer: 'Chanfro', shell: 'Casca', hole: 'Furo', pattern: 'Padrão',
  sweep: 'Varredura', loft: 'Loft', thread: 'Rosca', import: 'Importado', plane: 'Plano', axis: 'Eixo', point: 'Ponto',
  draft: 'Ângulo de saída', rib: 'Nervura', pipe: 'Cano', coil: 'Mola', emboss: 'Gravação', split: 'Divisão', pushpull: 'Empurrar/puxar', scale: 'Escala',
  move: 'Mover', combine: 'Combinar',
  sheet: 'Chapa', flange: 'Aba', bend: 'Dobra', flatten: 'Planificação',
  surface: 'Superfície', fill: 'Remendo', stitch: 'Costura', trim: 'Aparar', thicken: 'Espessar',
};

export function nextName(part: PartDef, type: Feature['type']) {
  const n = part.features.filter((f) => f.type === type).length + 1;
  return `${featureLabel[type]} ${n}`;
}

// ---------- profiles ----------

const EPS = 1e-4;
const same = (a: V2, b: V2) => Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS;

/** A closed outline made of line and three-point-arc segments, or a full circle. */
export type Seg = { t: 'line'; to: V2 } | { t: 'arc'; m: V2; to: V2 } | { t: 'spline'; via: V2[]; to: V2 };
export type Profile =
  | { kind: 'circle'; c: V2; r: number }
  | { kind: 'ellipse'; c: V2; rx: number; ry: number; rot: number }
  | { kind: 'path'; start: V2; segs: Seg[] };

/** An open curve as a segment going from `from` (one of its ends) to the other end. */
function curveSeg(e: SketchEntity, from: V2): Seg | null {
  if (e.t === 'line') return { t: 'line', to: same(e.a, from) ? e.b : e.a };
  if (e.t === 'arc') return { t: 'arc', m: e.m, to: same(e.a, from) ? e.b : e.a };
  if (e.t === 'spline') {
    const pts = same(e.pts[0], from) ? e.pts : [...e.pts].reverse();
    return { t: 'spline', via: pts.slice(1, -1), to: pts[pts.length - 1] };
  }
  return null;
}

/**
 * The one path of a sketch for a sweep: its lines and arcs chained end to end from a free end
 * (or around, when they close), or a lone circle. Null when there is no single path.
 */
export function sketchPath(entities: SketchEntity[]): { start: V2; segs: Seg[]; closed: boolean } | { circle: { c: V2; r: number } } | null {
  const segs = entities.flatMap((e) => {
    const ends = e.construction ? null : curveEnds(e);
    return ends && !same(ends[0], ends[1]) ? [{ e, a: ends[0], b: ends[1] }] : [];
  });
  if (!segs.length) {
    const c = entities.find((e) => !e.construction && e.t === 'circle');
    return c && c.t === 'circle' ? { circle: { c: c.c, r: c.r } } : null;
  }
  const degree = (p: V2) => segs.filter((s) => same(s.a, p) || same(s.b, p)).length;
  const free = segs.flatMap((s) => [s.a, s.b]).find((p) => degree(p) === 1);
  const start = free ?? segs[0].a;
  const used = new Set<number>();
  const out: Seg[] = [];
  let end = start;
  for (;;) {
    const j = segs.findIndex((s, k) => !used.has(k) && (same(s.a, end) || same(s.b, end)));
    if (j < 0) break;
    used.add(j);
    const seg = curveSeg(segs[j].e, end)!;
    out.push(seg);
    end = seg.to;
  }
  if (used.size !== segs.length) return null;
  return { start, segs: out, closed: same(end, start) };
}

/** Closed outlines of a sketch: closed entities as they are, open lines/arcs chained end to end. */
export function sketchProfiles(entities: SketchEntity[]): { profiles: Profile[]; openEnds: V2[] } {
  const profiles: Profile[] = [];
  const open: { e: SketchEntity; a: V2; b: V2 }[] = [];
  const poly = (pts: V2[]): Profile => ({ kind: 'path', start: pts[0], segs: [...pts.slice(1), pts[0]].map((to) => ({ t: 'line' as const, to })) });
  for (const e of entities) {
    if (e.construction) continue;
    if (e.t === 'circle' && e.r > 0) profiles.push({ kind: 'circle', c: e.c, r: e.r });
    else if (e.t === 'ellipse' && e.rx > 0 && e.ry > 0) profiles.push({ kind: 'ellipse', c: e.c, rx: e.rx, ry: e.ry, rot: e.rot });
    else if (e.t === 'text') {
      for (const c of textContours(e)) if (c.length >= 3) profiles.push(poly(c));
    } else if (e.t === 'spline' && e.pts.length >= 3 && same(e.pts[0], e.pts[e.pts.length - 1])) {
      profiles.push({ kind: 'path', start: e.pts[0], segs: [curveSeg(e, e.pts[0])!] });
    } else if (e.t === 'rect' && e.w > 0 && e.h > 0) {
      const [x, y] = e.c, w = e.w / 2, h = e.h / 2;
      profiles.push(poly([[x - w, y - h], [x + w, y - h], [x + w, y + h], [x - w, y + h]]));
    } else if (e.t === 'polygon' && e.r > 0 && e.n >= 3) {
      profiles.push(poly(Array.from({ length: e.n }, (_, i) => {
        const a = Math.PI / 2 + (i * 2 * Math.PI) / e.n;
        return [e.c[0] + e.r * Math.cos(a), e.c[1] + e.r * Math.sin(a)] as V2;
      })));
    } else {
      const ends = curveEnds(e);
      if (ends && !same(ends[0], ends[1])) open.push({ e, a: ends[0], b: ends[1] });
    }
  }

  // Chain open segments into loops (either direction).
  const used = new Set<number>();
  const openEnds: V2[] = [];
  for (let i = 0; i < open.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const start = open[i].a;
    const segs: Seg[] = [curveSeg(open[i].e, start)!];
    let end = open[i].b;
    let closed = same(end, start);
    while (!closed) {
      const next = open.findIndex((s, j) => !used.has(j) && (same(s.a, end) || same(s.b, end)));
      if (next < 0) break;
      used.add(next);
      const seg = curveSeg(open[next].e, end)!;
      segs.push(seg);
      end = seg.to;
      closed = same(end, start);
    }
    if (closed) profiles.push({ kind: 'path', start, segs });
    else openEnds.push(start, end);
  }
  return { profiles, openEnds };
}

/** Polygon approximation of a profile (for containment tests and previews). */
export function profilePoints(p: Profile, steps = 24): V2[] {
  if (p.kind === 'circle') return Array.from({ length: steps * 2 }, (_, i) => [p.c[0] + p.r * Math.cos((i / (steps * 2)) * 2 * Math.PI), p.c[1] + p.r * Math.sin((i / (steps * 2)) * 2 * Math.PI)] as V2);
  if (p.kind === 'ellipse') return ellipsePoints(p, steps * 2);
  const pts: V2[] = [p.start];
  let cur = p.start;
  for (const s of p.segs) {
    if (s.t === 'line') pts.push(s.to);
    else if (s.t === 'spline') pts.push(...splinePoints([cur, ...s.via, s.to], Math.max(4, steps >> 1)).slice(1));
    else pts.push(...arcPoints(cur, s.m, s.to, steps).slice(1));
    cur = s.to;
  }
  return pts;
}

/** Circle through three points, or null when they are in line. */
export function circleThrough(a: V2, m: V2, b: V2): { c: V2; r: number } | null {
  const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
  if (Math.abs(d) < 1e-9) return null;
  const sq = (p: V2) => p[0] * p[0] + p[1] * p[1];
  const cx = (sq(a) * (m[1] - b[1]) + sq(m) * (b[1] - a[1]) + sq(b) * (a[1] - m[1])) / d;
  const cy = (sq(a) * (b[0] - m[0]) + sq(m) * (a[0] - b[0]) + sq(b) * (m[0] - a[0])) / d;
  return { c: [cx, cy], r: Math.hypot(a[0] - cx, a[1] - cy) };
}

/** Points along the arc from a through m to b. */
export function arcPoints(a: V2, m: V2, b: V2, steps = 24): V2[] {
  const circ = circleThrough(a, m, b);
  if (!circ) return [a, b];
  const { c, r } = circ;
  const ang = (p: V2) => Math.atan2(p[1] - c[1], p[0] - c[0]);
  const a0 = ang(a);
  const norm = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  let sweep = norm(ang(b) - a0);
  // Go the way that passes through m.
  if (norm(ang(m) - a0) > sweep) sweep -= 2 * Math.PI;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = a0 + (sweep * i) / steps;
    return [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)] as V2;
  });
}

export function pointInPolygon(p: V2, poly: V2[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polygonArea(poly: V2[]) {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  return Math.abs(s / 2);
}
