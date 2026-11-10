/**
 * Sketch editing operations that change geometry rather than add constraints: trim, extend,
 * offset, corner fillet/chamfer, automatic constraints and DXF import.
 */
import {
  circleThrough,
  constraintEntities,
  curveEnds,
  ellipsePoints,
  fid,
  splinePoints,
  textContours,
  type SketchConstraint,
  type SketchEntity,
  type SketchFeature,
  type V2,
} from './model';

const EPS = 1e-6;
const TAU = Math.PI * 2;
const sub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: V2, b: V2): V2 => [a[0] + b[0], a[1] + b[1]];
const mul = (a: V2, k: number): V2 => [a[0] * k, a[1] * k];
const dot = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1];
const cross = (a: V2, b: V2) => a[0] * b[1] - a[1] * b[0];
const len = (a: V2) => Math.hypot(a[0], a[1]);
const norm = (a: V2): V2 => mul(a, 1 / (len(a) || 1));
const dist = (a: V2, b: V2) => len(sub(a, b));
const near = (a: V2, b: V2, tol = 1e-4) => dist(a, b) < tol;
const wrap = (x: number) => ((x % TAU) + TAU) % TAU;
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const rp = (p: V2): V2 => [r4(p[0]), r4(p[1])];

// ---------- primitives ----------

/** Pieces a curve is made of, for intersections: straight segments and (parts of) circles. */
type Prim = { k: 'seg'; a: V2; b: V2 } | { k: 'circ'; c: V2; r: number; from: number; sweep: number };

/** Arc as centre, radius, start angle and signed sweep (from a through m to b). */
export function arcGeom(a: V2, m: V2, b: V2) {
  const circ = circleThrough(a, m, b);
  if (!circ) return null;
  const ang = (p: V2) => Math.atan2(p[1] - circ.c[1], p[0] - circ.c[0]);
  const from = ang(a);
  let sweep = wrap(ang(b) - from);
  if (wrap(ang(m) - from) > sweep) sweep -= TAU;
  return { c: circ.c, r: circ.r, from, sweep };
}

const polySegs = (pts: V2[], closed: boolean): Prim[] => {
  const out: Prim[] = [];
  for (let i = 0; i < pts.length - 1; i++) out.push({ k: 'seg', a: pts[i], b: pts[i + 1] });
  if (closed && pts.length > 2) out.push({ k: 'seg', a: pts[pts.length - 1], b: pts[0] });
  return out;
};

function prims(e: SketchEntity): Prim[] {
  switch (e.t) {
    case 'line':
      return [{ k: 'seg', a: e.a, b: e.b }];
    case 'circle':
      return [{ k: 'circ', c: e.c, r: e.r, from: 0, sweep: TAU }];
    case 'arc': {
      const g = arcGeom(e.a, e.m, e.b);
      return g ? [{ k: 'circ', ...g }] : [{ k: 'seg', a: e.a, b: e.b }];
    }
    case 'rect': {
      const [x, y] = e.c, w = e.w / 2, h = e.h / 2;
      return polySegs([[x - w, y - h], [x + w, y - h], [x + w, y + h], [x - w, y + h]], true);
    }
    case 'polygon':
      return polySegs(Array.from({ length: e.n }, (_, i) => {
        const a = Math.PI / 2 + (i * TAU) / e.n;
        return [e.c[0] + e.r * Math.cos(a), e.c[1] + e.r * Math.sin(a)] as V2;
      }), true);
    case 'ellipse':
      return polySegs(ellipsePoints(e, 96), true);
    case 'spline':
      return polySegs(splinePoints(e.pts, 24), false);
    case 'text':
      return textContours(e).flatMap((c) => polySegs(c, true));
  }
}

/** Where on a circle prim an angle falls (0..1 along its sweep), or null when outside. */
function onCirc(p: Extract<Prim, { k: 'circ' }>, angle: number) {
  if (p.sweep >= TAU - EPS) return wrap(angle) / TAU;
  const d = p.sweep > 0 ? wrap(angle - p.from) : wrap(p.from - angle);
  const s = Math.abs(p.sweep);
  return d <= s + 1e-9 ? d / s : null;
}

/** Intersections of two prims, each with its parameter (0..1) along each prim. */
function intersect(p: Prim, q: Prim): { pt: V2; tp: number; tq: number }[] {
  if (p.k === 'seg' && q.k === 'seg') {
    const r = sub(p.b, p.a), s = sub(q.b, q.a);
    const d = cross(r, s);
    if (Math.abs(d) < EPS) return [];
    const t = cross(sub(q.a, p.a), s) / d, u = cross(sub(q.a, p.a), r) / d;
    return t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9 ? [{ pt: add(p.a, mul(r, t)), tp: t, tq: u }] : [];
  }
  if (p.k === 'circ' && q.k === 'seg') return intersect(q, p).map((x) => ({ pt: x.pt, tp: x.tq, tq: x.tp }));
  if (p.k === 'seg' && q.k === 'circ') {
    return lineCircle(p.a, p.b, q.c, q.r).flatMap((t) => {
      if (t < -1e-9 || t > 1 + 1e-9) return [];
      const pt = add(p.a, mul(sub(p.b, p.a), t));
      const tq = onCirc(q, Math.atan2(pt[1] - q.c[1], pt[0] - q.c[0]));
      return tq === null ? [] : [{ pt, tp: t, tq }];
    });
  }
  if (p.k === 'circ' && q.k === 'circ') {
    return circleCircle(p.c, p.r, q.c, q.r).flatMap((pt) => {
      const tp = onCirc(p, Math.atan2(pt[1] - p.c[1], pt[0] - p.c[0]));
      const tq = onCirc(q, Math.atan2(pt[1] - q.c[1], pt[0] - q.c[0]));
      return tp === null || tq === null ? [] : [{ pt, tp, tq }];
    });
  }
  return [];
}

/** Parameters t along a→b (infinite line) where it meets the circle. */
function lineCircle(a: V2, b: V2, c: V2, r: number): number[] {
  const d = sub(b, a), f = sub(a, c);
  const A = dot(d, d), B = 2 * dot(f, d), C = dot(f, f) - r * r;
  const disc = B * B - 4 * A * C;
  if (disc < -1e-9 || A < EPS) return [];
  const sq = Math.sqrt(Math.max(0, disc));
  return disc < 1e-12 ? [-B / (2 * A)] : [(-B - sq) / (2 * A), (-B + sq) / (2 * A)];
}

function circleCircle(c1: V2, r1: number, c2: V2, r2: number): V2[] {
  const d = dist(c1, c2);
  if (d < EPS || d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const u = norm(sub(c2, c1)), m = add(c1, mul(u, a));
  const n: V2 = [-u[1], u[0]];
  return h < 1e-9 ? [m] : [add(m, mul(n, h)), sub(m, mul(n, h))];
}

// ---------- trim ----------

/** Where a target curve is cut by every other curve, as parameters along it (0..1). */
function cuts(s: SketchFeature, target: SketchEntity, tp: Prim) {
  const out: number[] = [];
  for (const o of s.entities) {
    if (o.id === target.id) continue;
    for (const q of prims(o)) for (const x of intersect(tp, q)) out.push(x.tp);
  }
  return out;
}

/**
 * Remove the piece of a line, arc or circle between the two cuts around `at` (or up to its end).
 * Returns false when there is nothing to trim with.
 */
export function trim(s: SketchFeature, id: string, at: V2): boolean | 'unsupported' {
  const e = s.entities.find((x) => x.id === id);
  if (!e) return false;
  if (e.t !== 'line' && e.t !== 'arc' && e.t !== 'circle') return 'unsupported';
  const tp = prims(e)[0];
  const ts = [...new Set(cuts(s, e, tp).map((t) => Math.round(t * 1e7) / 1e7))].sort((a, b) => a - b);
  // Parameter of the click.
  let tc: number;
  if (tp.k === 'seg') {
    const d = sub(tp.b, tp.a);
    tc = dot(sub(at, tp.a), d) / dot(d, d);
  } else tc = onCirc(tp, Math.atan2(at[1] - tp.c[1], at[0] - tp.c[0])) ?? 0;
  const inner = e.t === 'circle' ? ts : ts.filter((t) => t > 1e-6 && t < 1 - 1e-6);
  const before = inner.filter((t) => t < tc).at(-1);
  const after = inner.find((t) => t > tc);

  const pieces: SketchEntity[] = [];
  if (e.t === 'circle') {
    if (inner.length < 2) return false;
    // Keep the rest of the circle as an arc from `after` round to `before`.
    const lo = before ?? inner.at(-1)!, hi = after ?? inner[0];
    const a0 = hi * TAU;
    let sw = wrap(lo * TAU - a0);
    if (sw < 1e-6) sw = TAU;
    const P = (ang: number): V2 => rp([e.c[0] + e.r * Math.cos(ang), e.c[1] + e.r * Math.sin(ang)]);
    pieces.push({ id: fid(), t: 'arc', a: P(a0), m: P(a0 + sw / 2), b: P(a0 + sw), construction: e.construction });
  } else {
    if (before === undefined && after === undefined) return false;
    const piece = (t0: number, t1: number): SketchEntity => {
      if (tp.k === 'seg') {
        const d = sub(tp.b, tp.a);
        return { id: fid(), t: 'line', a: rp(add(tp.a, mul(d, t0))), b: rp(add(tp.a, mul(d, t1))), construction: e.construction };
      }
      const P = (t: number): V2 => {
        const ang = tp.from + tp.sweep * t;
        return rp([tp.c[0] + tp.r * Math.cos(ang), tp.c[1] + tp.r * Math.sin(ang)]);
      };
      return { id: fid(), t: 'arc', a: P(t0), m: P((t0 + t1) / 2), b: P(t1), construction: e.construction };
    };
    if (before !== undefined) pieces.push(piece(0, before));
    if (after !== undefined) pieces.push(piece(after, 1));
  }
  // A piece that keeps one of the original ends keeps the entity's id, so constraints on that end
  // (and on its direction, centre and radius) still hold; the moved end loses its constraints.
  const moved: 'a' | 'b' | null = e.t === 'circle' ? null : before !== undefined ? 'b' : 'a';
  if (moved) pieces[0].id = e.id;
  s.entities = s.entities.flatMap((x) => (x.id === id ? pieces : [x]));
  s.constraints = (s.constraints ?? []).filter((c) => {
    if (!constraintEntities(c).includes(id)) return true;
    if (!moved) return false;
    if (JSON.stringify(c).includes(`{"e":"${id}","p":"${moved}"}`)) return false;
    if (e.t === 'line' && (c.t === 'length' || c.t === 'midpoint' || c.t === 'equal')) return false;
    return true;
  });
  return true;
}

// ---------- extend ----------

/** Lengthen a line from its end nearest `at` up to the next curve it would meet. */
export function extend(s: SketchFeature, id: string, at: V2): boolean | 'unsupported' {
  const e = s.entities.find((x) => x.id === id);
  if (!e) return false;
  if (e.t !== 'line') return 'unsupported';
  const fromB = dist(at, e.b) < dist(at, e.a);
  const end = fromB ? e.b : e.a, other = fromB ? e.a : e.b;
  const dir = norm(sub(end, other));
  const ray: Prim = { k: 'seg', a: end, b: add(end, mul(dir, 1e5)) };
  let best: V2 | null = null;
  let bd = Infinity;
  for (const o of s.entities) {
    if (o.id === id) continue;
    for (const q of prims(o))
      for (const x of intersect(ray, q)) {
        const d = x.tp * 1e5;
        if (d > 1e-4 && d < bd) (bd = d), (best = x.pt);
      }
  }
  if (!best) return false;
  if (fromB) e.b = rp(best);
  else e.a = rp(best);
  // A length dimension would pull it straight back.
  s.constraints = s.constraints?.filter((c) => !(c.t === 'length' && c.e === id));
  return true;
}

// ---------- offset ----------

type Piece = { t: 'line'; a: V2; b: V2 } | { t: 'arc'; a: V2; m: V2; b: V2 };

/** Lines and arcs joined end to end with the clicked one, in order. */
function chainOf(s: SketchFeature, id: string): { pieces: Piece[]; closed: boolean } | null {
  const curves = s.entities.filter((x): x is Extract<SketchEntity, { t: 'line' | 'arc' }> => (x.t === 'line' || x.t === 'arc') && !!x.construction === !!s.entities.find((y) => y.id === id)?.construction);
  const start = curves.find((x) => x.id === id);
  if (!start) return null;
  const used = new Set([start.id]);
  const asPiece = (x: (typeof curves)[number], rev: boolean): Piece =>
    x.t === 'line' ? { t: 'line', a: rev ? x.b : x.a, b: rev ? x.a : x.b } : { t: 'arc', a: rev ? x.b : x.a, m: x.m, b: rev ? x.a : x.b };
  const pieces: Piece[] = [asPiece(start, false)];
  const grow = (forward: boolean) => {
    for (;;) {
      const tip = forward ? pieces.at(-1)!.b : pieces[0].a;
      const links = curves.filter((x) => !used.has(x.id) && (near(x.a, tip) || near(x.b, tip)));
      if (links.length !== 1) return;
      const x = links[0];
      used.add(x.id);
      if (forward) pieces.push(asPiece(x, !near(x.a, tip)));
      else pieces.unshift(asPiece(x, !near(x.b, tip)));
    }
  };
  grow(true);
  const closed = near(pieces.at(-1)!.b, pieces[0].a) && pieces.length > 1;
  if (!closed) grow(false);
  return { pieces, closed };
}

const pieceDir = (p: Piece, atEnd: boolean): V2 => {
  if (p.t === 'line') return norm(sub(p.b, p.a));
  const g = arcGeom(p.a, p.m, p.b)!;
  const ang = g.from + (atEnd ? g.sweep : 0);
  const sgn = Math.sign(g.sweep) || 1;
  return [-Math.sin(ang) * sgn, Math.cos(ang) * sgn];
};

/**
 * Copy of the clicked curve (with the lines and arcs joined to it) moved sideways by `d` mm.
 * On closed outlines a positive distance goes outwards. Returns the new entities.
 */
export function offset(s: SketchFeature, id: string, d: number): { ents: SketchEntity[]; cons: SketchConstraint[] } | string {
  const e = s.entities.find((x) => x.id === id);
  if (!e) return 'Clique numa linha, arco ou círculo.';
  if (e.t === 'circle') {
    if (e.r + d <= 0) return 'O círculo ficaria sem tamanho.';
    const c: SketchEntity = { id: fid(), t: 'circle', c: [...e.c], r: r4(e.r + d) };
    return { ents: [c], cons: [{ id: fid(), t: 'concentric', e1: e.id, e2: c.id }] };
  }
  if (e.t === 'rect') {
    if (e.w + 2 * d <= 0 || e.h + 2 * d <= 0) return 'O retângulo ficaria sem tamanho.';
    return { ents: [{ id: fid(), t: 'rect', c: [...e.c], w: r4(e.w + 2 * d), h: r4(e.h + 2 * d) }], cons: [] };
  }
  if (e.t !== 'line' && e.t !== 'arc') return 'Offset funciona em linhas, arcos, círculos e retângulos.';
  const chain = chainOf(s, id)!;
  // Closed outlines: positive = outwards. The right-hand side of a counter-clockwise loop is outside.
  let side = 1;
  if (chain.closed) {
    let area = 0;
    for (const p of chain.pieces) area += cross(p.a, p.b);
    side = area > 0 ? 1 : -1;
  }
  const moved: (Piece & { c?: V2; r?: number })[] = [];
  for (const p of chain.pieces) {
    if (p.t === 'line') {
      const t = norm(sub(p.b, p.a));
      const n = mul([t[1], -t[0]], side * d);
      moved.push({ t: 'line', a: add(p.a, n), b: add(p.b, n) });
    } else {
      const g = arcGeom(p.a, p.m, p.b)!;
      const t = pieceDir(p, false);
      const n: V2 = [t[1] * side, -t[0] * side];
      const out = dot(n, sub(p.a, g.c)) > 0 ? 1 : -1;
      const r = g.r + out * d;
      if (r <= 0) return 'Um arco ficaria sem tamanho com essa distância.';
      const k = (q: V2) => add(g.c, mul(norm(sub(q, g.c)), r));
      moved.push({ t: 'arc', a: k(p.a), m: k(p.m), b: k(p.b), c: g.c, r });
    }
  }
  // Meet neighbours where their new curves cross (closest to the old joint), so corners stay sharp.
  const joints = chain.closed ? moved.length : moved.length - 1;
  for (let i = 0; i < joints; i++) {
    const A = moved[i], B = moved[(i + 1) % moved.length];
    if (near(A.b, B.a)) continue;
    const old = chain.pieces[i].b;
    let cands: V2[] = [];
    if (A.t === 'line' && B.t === 'line') {
      const r = sub(A.b, A.a), q = sub(B.b, B.a), den = cross(r, q);
      if (Math.abs(den) > EPS) cands = [add(A.a, mul(r, cross(sub(B.a, A.a), q) / den))];
    } else if (A.t === 'line' && B.c) cands = lineCircle(A.a, A.b, B.c, B.r!).map((t) => add(A.a, mul(sub(A.b, A.a), t)));
    else if (B.t === 'line' && A.c) cands = lineCircle(B.a, B.b, A.c, A.r!).map((t) => add(B.a, mul(sub(B.b, B.a), t)));
    else if (A.c && B.c) cands = circleCircle(A.c, A.r!, B.c, B.r!);
    const best = cands.sort((x, y) => dist(x, old) - dist(y, old))[0] ?? mul(add(A.b, B.a), 0.5);
    A.b = best;
    B.a = best;
  }
  const ents: SketchEntity[] = moved.map((p) => {
    if (p.t === 'line') return { id: fid(), t: 'line', a: rp(p.a), b: rp(p.b) };
    // Keep the arc's middle point halfway along its (possibly shortened) sweep.
    const g = arcGeom(p.a, p.m, p.b);
    const m = g ? rp([g.c[0] + g.r * Math.cos(g.from + g.sweep / 2), g.c[1] + g.r * Math.sin(g.from + g.sweep / 2)]) : p.m;
    return { id: fid(), t: 'arc', a: rp(p.a), m, b: rp(p.b) };
  });
  const cons: SketchConstraint[] = [];
  for (let i = 0; i < joints; i++) cons.push({ id: fid(), t: 'coincident', p1: { e: ents[i].id, p: 'b' }, p2: { e: ents[(i + 1) % ents.length].id, p: 'a' } });
  return { ents, cons };
}

// ---------- corner fillet / chamfer ----------

/**
 * Round (or bevel) the corner where two lines meet at `at`: both lines are shortened and an arc
 * (or a line) joins them.
 */
export function corner(s: SketchFeature, at: V2, size: number, kind: 'fillet' | 'chamfer'): string | null {
  const lines = s.entities.filter((x): x is Extract<SketchEntity, { t: 'line' }> => x.t === 'line' && (near(x.a, at, 1e-3) || near(x.b, at, 1e-3)));
  if (lines.length !== 2) return 'Clique num canto onde duas linhas se encontram.';
  const [l1, l2] = lines;
  const end1: 'a' | 'b' = near(l1.a, at, 1e-3) ? 'a' : 'b', end2: 'a' | 'b' = near(l2.a, at, 1e-3) ? 'a' : 'b';
  const P = l1[end1];
  const far1 = l1[end1 === 'a' ? 'b' : 'a'], far2 = l2[end2 === 'a' ? 'b' : 'a'];
  const u1 = norm(sub(far1, P)), u2 = norm(sub(far2, P));
  const theta = Math.acos(Math.max(-1, Math.min(1, dot(u1, u2))));
  if (theta < 1e-3 || Math.PI - theta < 1e-3) return 'As linhas estão alinhadas: não há canto.';
  const t = kind === 'fillet' ? size / Math.tan(theta / 2) : size;
  if (!(size > 0) || t >= dist(P, far1) - 1e-6 || t >= dist(P, far2) - 1e-6) return 'O tamanho é maior que as linhas do canto.';
  const T1 = rp(add(P, mul(u1, t))), T2 = rp(add(P, mul(u2, t)));
  l1[end1] = T1;
  l2[end2] = T2;
  // Constraints tying the old corner (and lengths, which changed) go.
  const atCorner = (c: SketchConstraint) => {
    const j = JSON.stringify(c);
    return j.includes(`{"e":"${l1.id}","p":"${end1}"}`) || j.includes(`{"e":"${l2.id}","p":"${end2}"}`) || (c.t === 'length' && (c.e === l1.id || c.e === l2.id));
  };
  s.constraints = (s.constraints ?? []).filter((c) => !atCorner(c));
  const id = fid();
  let ent: SketchEntity;
  const cons: SketchConstraint[] = [];
  if (kind === 'fillet') {
    const bis = norm(add(u1, u2));
    const C = add(P, mul(bis, size / Math.sin(theta / 2)));
    ent = { id, t: 'arc', a: T1, m: rp(sub(C, mul(bis, size))), b: T2 };
    cons.push({ id: fid(), t: 'tangent', e1: l1.id, e2: id }, { id: fid(), t: 'tangent', e1: l2.id, e2: id }, { id: fid(), t: 'diameter', e: id, v: r4(size * 2) });
  } else ent = { id, t: 'line', a: T1, b: T2 };
  cons.push({ id: fid(), t: 'coincident', p1: { e: l1.id, p: end1 }, p2: { e: id, p: 'a' } }, { id: fid(), t: 'coincident', p1: { e: l2.id, p: end2 }, p2: { e: id, p: 'b' } });
  s.entities.push(ent);
  (s.constraints ??= []).push(...cons);
  return null;
}

// ---------- automatic constraints ----------

/** Add the obvious constraints: touching ends coincide, nearly level/upright lines become so. */
export function autoConstrain(s: SketchFeature): number {
  const list = (s.constraints ??= []);
  const has = (pred: (c: SketchConstraint) => boolean) => list.some(pred);
  let added = 0;
  const ends: { ref: { e: string; p: 'a' | 'b' }; p: V2 }[] = [];
  for (const e of s.entities) {
    const ce = curveEnds(e);
    if (ce) ends.push({ ref: { e: e.id, p: 'a' }, p: ce[0] }, { ref: { e: e.id, p: 'b' }, p: ce[1] });
    if (e.t === 'line') {
      const d = sub(e.b, e.a), l = len(d);
      if (l < EPS || has((c) => (c.t === 'horizontal' || c.t === 'vertical') && c.e === e.id)) continue;
      const tol = Math.sin((0.5 * Math.PI) / 180) * l;
      if (Math.abs(d[1]) < tol) list.push({ id: fid(), t: 'horizontal', e: e.id }), added++;
      else if (Math.abs(d[0]) < tol) list.push({ id: fid(), t: 'vertical', e: e.id }), added++;
    }
  }
  const linked = (a: { e: string; p: string }, b: { e: string; p: string }) =>
    has((c) => c.t === 'coincident' && ((JSON.stringify(c.p1) === JSON.stringify(a) && JSON.stringify(c.p2) === JSON.stringify(b)) || (JSON.stringify(c.p1) === JSON.stringify(b) && JSON.stringify(c.p2) === JSON.stringify(a))));
  for (let i = 0; i < ends.length; i++)
    for (let j = i + 1; j < ends.length; j++) {
      const A = ends[i], B = ends[j];
      if (A.ref.e === B.ref.e || !near(A.p, B.p, 0.01) || linked(A.ref, B.ref)) continue;
      // Already joined through a third point?
      if (ends.some((C, k) => k !== i && k !== j && near(C.p, A.p, 0.01) && linked(A.ref, C.ref) && linked(C.ref, B.ref))) continue;
      list.push({ id: fid(), t: 'coincident', p1: A.ref, p2: B.ref });
      added++;
    }
  return added;
}

// ---------- DXF ----------

/** Lines, arcs, circles, polylines, ellipses and splines of a DXF file, in millimetres. */
export function parseDxf(text: string): { ents: SketchEntity[]; skipped: number } {
  const lines = text.split(/\r?\n/);
  const pairs: [number, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i].trim(), 10), lines[i + 1].trim()]);
  // Units from the header ($INSUNITS): 1 inch, 2 feet, 4 mm, 5 cm, 6 m.
  let scale = 1;
  const iu = pairs.findIndex(([c, v]) => c === 9 && v === '$INSUNITS');
  if (iu >= 0) scale = ({ 1: 25.4, 2: 304.8, 5: 10, 6: 1000 } as Record<number, number>)[Number(pairs[iu + 1]?.[1])] ?? 1;
  const start = pairs.findIndex(([c, v]) => c === 2 && v === 'ENTITIES');
  if (start < 0) throw new Error('Não achei a seção de desenhos (ENTITIES) no DXF.');

  // Group the entity records.
  const recs: { type: string; codes: [number, string][] }[] = [];
  for (let i = start + 1; i < pairs.length; i++) {
    const [c, v] = pairs[i];
    if (c === 0) {
      if (v === 'ENDSEC') break;
      recs.push({ type: v, codes: [] });
    } else recs.at(-1)?.codes.push([c, v]);
  }
  const P = (x: number, y: number): V2 => rp([x * scale, y * scale]);
  const ents: SketchEntity[] = [];
  let skipped = 0;
  const get = (codes: [number, string][], c: number, d = 0) => {
    const f = codes.find(([k]) => k === c);
    return f ? Number(f[1]) : d;
  };
  const all = (codes: [number, string][], c: number) => codes.filter(([k]) => k === c).map(([, v]) => Number(v));
  const bulgeArc = (a: V2, b: V2, bulge: number): SketchEntity => {
    const ch = sub(b, a), l = len(ch);
    const m = add(mul(add(a, b), 0.5), mul([ch[1] / l, -ch[0] / l], (bulge * l) / 2));
    return { id: fid(), t: 'arc', a, m: rp(m), b };
  };
  const polyline = (pts: V2[], bulges: number[], closed: boolean) => {
    const n = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (near(a, b)) continue;
      ents.push(Math.abs(bulges[i] ?? 0) > 1e-9 ? bulgeArc(a, b, bulges[i]) : { id: fid(), t: 'line', a, b });
    }
  };
  for (let i = 0; i < recs.length; i++) {
    const { type, codes } = recs[i];
    switch (type) {
      case 'LINE':
        ents.push({ id: fid(), t: 'line', a: P(get(codes, 10), get(codes, 20)), b: P(get(codes, 11), get(codes, 21)) });
        break;
      case 'CIRCLE':
        ents.push({ id: fid(), t: 'circle', c: P(get(codes, 10), get(codes, 20)), r: r4(get(codes, 40) * scale) });
        break;
      case 'ARC': {
        const c: V2 = [get(codes, 10), get(codes, 20)], r = get(codes, 40);
        const a0 = (get(codes, 50) * Math.PI) / 180;
        let a1 = (get(codes, 51) * Math.PI) / 180;
        while (a1 <= a0) a1 += TAU;
        const at = (t: number) => P(c[0] + r * Math.cos(t), c[1] + r * Math.sin(t));
        ents.push({ id: fid(), t: 'arc', a: at(a0), m: at((a0 + a1) / 2), b: at(a1) });
        break;
      }
      case 'LWPOLYLINE': {
        const xs = all(codes, 10), ys = all(codes, 20);
        // Bulges belong to the vertex they follow; walk the codes in order to pair them up.
        const bulges: number[] = [];
        let vi = -1;
        for (const [k, v] of codes) {
          if (k === 10) (vi++, (bulges[vi] = 0));
          else if (k === 42 && vi >= 0) bulges[vi] = Number(v);
        }
        polyline(xs.map((x, k) => P(x, ys[k])), bulges, (get(codes, 70) & 1) === 1);
        break;
      }
      case 'POLYLINE': {
        const pts: V2[] = [], bulges: number[] = [];
        const closed = (get(codes, 70) & 1) === 1;
        while (recs[i + 1]?.type === 'VERTEX') {
          i++;
          pts.push(P(get(recs[i].codes, 10), get(recs[i].codes, 20)));
          bulges.push(get(recs[i].codes, 42));
        }
        if (recs[i + 1]?.type === 'SEQEND') i++;
        polyline(pts, bulges, closed);
        break;
      }
      case 'ELLIPSE': {
        const c: V2 = [get(codes, 10), get(codes, 20)], major: V2 = [get(codes, 11), get(codes, 21)];
        const ratio = get(codes, 40, 1), t0 = get(codes, 41, 0), t1 = get(codes, 42, TAU);
        const rx = len(major), ry = rx * ratio, rot = (Math.atan2(major[1], major[0]) * 180) / Math.PI;
        if (Math.abs(wrap(t1 - t0)) < 1e-6 || Math.abs(t1 - t0 - TAU) < 1e-6) {
          ents.push({ id: fid(), t: 'ellipse', c: P(c[0], c[1]), rx: r4(rx * scale), ry: r4(ry * scale), rot: r4(rot) });
        } else {
          // Part of an ellipse: a smooth curve through points on it.
          let sweep = t1 - t0;
          while (sweep <= 0) sweep += TAU;
          const n = Math.max(4, Math.ceil((sweep / TAU) * 16));
          const ellipse = { c, rx, ry, rot };
          const pts = Array.from({ length: n + 1 }, (_, k) => {
            const t = t0 + (sweep * k) / n;
            const ca = Math.cos((rot * Math.PI) / 180), sa = Math.sin((rot * Math.PI) / 180);
            const x = ellipse.rx * Math.cos(t), y = ellipse.ry * Math.sin(t);
            return P(c[0] + x * ca - y * sa, c[1] + x * sa + y * ca);
          });
          ents.push({ id: fid(), t: 'spline', pts });
        }
        break;
      }
      case 'SPLINE': {
        // Fit points when the file has them, otherwise the control points (close enough to trace).
        let xs = all(codes, 11), ys = all(codes, 21);
        if (xs.length < 2) (xs = all(codes, 10)), (ys = all(codes, 20));
        const pts = xs.map((x, k) => P(x, ys[k]));
        if (pts.length >= 2) ents.push({ id: fid(), t: 'spline', pts });
        else skipped++;
        break;
      }
      case 'VERTEX':
      case 'SEQEND':
        break;
      default:
        skipped++;
    }
  }
  return { ents, skipped };
}

// ---------- slot ----------

/** Rounded slot between two centres: two lines and two half circles, held together. */
export function slot(c1: V2, c2: V2, r: number): { ents: SketchEntity[]; cons: SketchConstraint[] } | null {
  const u = norm(sub(c2, c1));
  if (dist(c1, c2) < EPS || r <= 0) return null;
  const n: V2 = [-u[1], u[0]];
  const p = (c: V2, k: V2, s: number) => rp(add(c, mul(k, s)));
  const top: SketchEntity = { id: fid(), t: 'line', a: p(c1, n, r), b: p(c2, n, r) };
  const right: SketchEntity = { id: fid(), t: 'arc', a: p(c2, n, r), m: p(c2, u, r), b: p(c2, n, -r) };
  const bottom: SketchEntity = { id: fid(), t: 'line', a: p(c2, n, -r), b: p(c1, n, -r) };
  const left: SketchEntity = { id: fid(), t: 'arc', a: p(c1, n, -r), m: p(c1, u, -r), b: p(c1, n, r) };
  const ents = [top, right, bottom, left];
  const cons: SketchConstraint[] = ents.map((e, i) => ({ id: fid(), t: 'coincident', p1: { e: e.id, p: 'b' }, p2: { e: ents[(i + 1) % 4].id, p: 'a' } }));
  cons.push(
    { id: fid(), t: 'tangent', e1: top.id, e2: right.id },
    { id: fid(), t: 'tangent', e1: bottom.id, e2: right.id },
    { id: fid(), t: 'tangent', e1: top.id, e2: left.id },
    { id: fid(), t: 'tangent', e1: bottom.id, e2: left.id },
    { id: fid(), t: 'equal', e1: right.id, e2: left.id },
  );
  return { ents, cons };
}
