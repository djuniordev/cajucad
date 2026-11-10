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
  | { id: string; t: 'polygon'; c: V2; r: number; n: number; construction?: boolean };

export type PlaneName = 'XY' | 'XZ' | 'YZ';

export interface SketchFeature {
  id: string;
  type: 'sketch';
  name: string;
  plane: PlaneName;
  /** Distance of the sketch plane along its normal, mm. */
  offset: number;
  entities: SketchEntity[];
}

/** How a feature's solid combines with the part built so far. */
export type BodyOp = 'join' | 'cut' | 'intersect';

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
  /** Sketch axis to revolve around (through the sketch origin). */
  axis: 'x' | 'y';
  angle: number;
  op: BodyOp;
}

export type Feature = SketchFeature | ExtrudeFeature | RevolveFeature;

export interface PartDef {
  version: 1;
  features: Feature[];
}

export const emptyPart = (): PartDef => ({ version: 1, features: [] });

/** Sketch planes in CajuCAD's world (Z up): origin direction, sketch X and the plane normal. */
export const PLANES: Record<PlaneName, { label: string; x: V3; y: V3; n: V3 }> = {
  XY: { label: 'Chão (XY)', x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] },
  XZ: { label: 'Frente (XZ)', x: [1, 0, 0], y: [0, 0, 1], n: [0, -1, 0] },
  YZ: { label: 'Lateral (YZ)', x: [0, 1, 0], y: [0, 0, 1], n: [1, 0, 0] },
};

/** World point of a sketch point. */
export function sketchToWorld(s: Pick<SketchFeature, 'plane' | 'offset'>, p: V2): V3 {
  const P = PLANES[s.plane];
  return [0, 1, 2].map((i) => P.x[i] * p[0] + P.y[i] * p[1] + P.n[i] * s.offset) as V3;
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

export const featureLabel: Record<Feature['type'], string> = { sketch: 'Esboço', extrude: 'Extrusão', revolve: 'Revolução' };

export function nextName(part: PartDef, type: Feature['type']) {
  const n = part.features.filter((f) => f.type === type).length + 1;
  return `${featureLabel[type]} ${n}`;
}

// ---------- profiles ----------

const EPS = 1e-4;
const same = (a: V2, b: V2) => Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS;

/** A closed outline made of line and three-point-arc segments, or a full circle. */
export type Profile =
  | { kind: 'circle'; c: V2; r: number }
  | { kind: 'path'; start: V2; segs: ({ t: 'line'; to: V2 } | { t: 'arc'; m: V2; to: V2 })[] };

/** Closed outlines of a sketch: closed entities as they are, open lines/arcs chained end to end. */
export function sketchProfiles(entities: SketchEntity[]): { profiles: Profile[]; openEnds: V2[] } {
  const profiles: Profile[] = [];
  type Seg = { a: V2; b: V2; m?: V2 };
  const open: Seg[] = [];
  for (const e of entities) {
    if (e.construction) continue;
    if (e.t === 'circle' && e.r > 0) profiles.push({ kind: 'circle', c: e.c, r: e.r });
    else if (e.t === 'rect' && e.w > 0 && e.h > 0) {
      const [x, y] = e.c, w = e.w / 2, h = e.h / 2;
      const pts: V2[] = [[x - w, y - h], [x + w, y - h], [x + w, y + h], [x - w, y + h]];
      profiles.push({ kind: 'path', start: pts[0], segs: [...pts.slice(1), pts[0]].map((to) => ({ t: 'line' as const, to })) });
    } else if (e.t === 'polygon' && e.r > 0 && e.n >= 3) {
      const pts = Array.from({ length: e.n }, (_, i) => {
        const a = Math.PI / 2 + (i * 2 * Math.PI) / e.n;
        return [e.c[0] + e.r * Math.cos(a), e.c[1] + e.r * Math.sin(a)] as V2;
      });
      profiles.push({ kind: 'path', start: pts[0], segs: [...pts.slice(1), pts[0]].map((to) => ({ t: 'line' as const, to })) });
    } else if (e.t === 'line' && !same(e.a, e.b)) open.push({ a: e.a, b: e.b });
    else if (e.t === 'arc' && !same(e.a, e.b)) open.push({ a: e.a, b: e.b, m: e.m });
  }

  // Chain open segments into loops (either direction).
  const used = new Set<number>();
  const openEnds: V2[] = [];
  for (let i = 0; i < open.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const start = open[i].a;
    const segs: ({ t: 'line'; to: V2 } | { t: 'arc'; m: V2; to: V2 })[] = [open[i].m ? { t: 'arc', m: open[i].m!, to: open[i].b } : { t: 'line', to: open[i].b }];
    let end = open[i].b;
    let closed = same(end, start);
    while (!closed) {
      let next = -1;
      let flip = false;
      for (let j = 0; j < open.length; j++) {
        if (used.has(j)) continue;
        if (same(open[j].a, end)) { next = j; break; }
        if (same(open[j].b, end)) { next = j; flip = true; break; }
      }
      if (next < 0) break;
      used.add(next);
      const s = open[next];
      const to = flip ? s.a : s.b;
      segs.push(s.m ? { t: 'arc', m: s.m, to } : { t: 'line', to });
      end = to;
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
  const pts: V2[] = [p.start];
  let cur = p.start;
  for (const s of p.segs) {
    if (s.t === 'line') pts.push(s.to);
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
