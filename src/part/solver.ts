/**
 * Sketch constraint solving with planegcs (FreeCAD's 2D solver compiled to WASM).
 * Entities keep their own coordinates; the solver moves them so every constraint holds.
 */
import type { GcsWrapper, SketchPrimitive } from '@salusoft89/planegcs';
import { circleThrough, type PointRef, type SketchConstraint, type SketchEntity, type SketchFeature, type V2 } from './model';

let loading: Promise<{ make: () => GcsWrapper }> | null = null;

export function loadSolver() {
  loading ??= (async () => {
    const [gcs, { default: wasmUrl }] = await Promise.all([import('@salusoft89/planegcs'), import('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url')]);
    const mod = await gcs.init_planegcs_module({ locateFile: () => wasmUrl });
    return { make: () => new gcs.GcsWrapper(new mod.GcsSystem(), mod) };
  })();
  loading.catch(() => (loading = null));
  return loading;
}

/** Use an already initialised planegcs (scripts and tests running outside Vite). */
export function provideSolver(make: () => GcsWrapper) {
  loading = Promise.resolve({ make });
}

export interface SolveResult {
  ok: boolean;
  /** Remaining degrees of freedom (0 = fully defined), when the solver reports it. */
  dof: number | null;
  /** Ids of constraints the solver found in conflict. */
  conflicting: string[];
}

const pid = (r: PointRef) => (r === 'origin' ? 'O' : `${r.e}:${r.p}`);
const TAU = Math.PI * 2;

/** Arc as planegcs wants it: counter-clockwise from start to end. */
function arcParams(e: Extract<SketchEntity, { t: 'arc' }>) {
  const circ = circleThrough(e.a, e.m, e.b);
  if (!circ) return null;
  const ang = (p: V2) => Math.atan2(p[1] - circ.c[1], p[0] - circ.c[0]);
  const norm = (x: number) => ((x % TAU) + TAU) % TAU;
  const ccw = norm(ang(e.m) - ang(e.a)) < norm(ang(e.b) - ang(e.a));
  const [s, t] = ccw ? (['a', 'b'] as const) : (['b', 'a'] as const);
  const sa = ang(e[s]);
  let ea = ang(e[t]);
  while (ea <= sa) ea += TAU;
  return { c: circ.c, r: circ.r, start: s, end: t, sa, ea };
}

function primitives(s: SketchFeature, drag?: { ref: PointRef; to: V2 }): SketchPrimitive[] {
  const out: SketchPrimitive[] = [{ id: 'O', type: 'point', x: 0, y: 0, fixed: true }];
  const point = (id: string, p: V2) => out.push({ id, type: 'point', x: p[0], y: p[1], fixed: false });
  const kind = new Map<string, SketchEntity['t']>();
  for (const e of s.entities) {
    kind.set(e.id, e.t);
    if (e.t === 'line') {
      point(`${e.id}:a`, e.a);
      point(`${e.id}:b`, e.b);
      out.push({ id: e.id, type: 'line', p1_id: `${e.id}:a`, p2_id: `${e.id}:b` });
    } else if (e.t === 'circle') {
      point(`${e.id}:c`, e.c);
      out.push({ id: e.id, type: 'circle', c_id: `${e.id}:c`, radius: e.r });
    } else if (e.t === 'arc') {
      const a = arcParams(e);
      if (!a) continue;
      point(`${e.id}:a`, e.a);
      point(`${e.id}:b`, e.b);
      point(`${e.id}:c`, a.c);
      out.push({ id: e.id, type: 'arc', c_id: `${e.id}:c`, start_id: `${e.id}:${a.start}`, end_id: `${e.id}:${a.end}`, radius: a.r, start_angle: a.sa, end_angle: a.ea });
      out.push({ id: `${e.id}:rules`, type: 'arc_rules', a_id: e.id });
    } else {
      // Rectangles and polygons only expose their centre.
      point(`${e.id}:c`, e.c);
    }
  }
  for (const c of s.constraints ?? []) {
    const p = constraintPrims(c, kind);
    out.push(...p);
  }
  if (drag) {
    out.push({ id: 'drag:x', type: 'coordinate_x', p_id: pid(drag.ref), x: drag.to[0], temporary: true });
    out.push({ id: 'drag:y', type: 'coordinate_y', p_id: pid(drag.ref), y: drag.to[1], temporary: true });
  }
  return out;
}

function constraintPrims(c: SketchConstraint, kind: Map<string, SketchEntity['t']>): SketchPrimitive[] {
  const id = c.id;
  const k = (e: string) => kind.get(e);
  const round = (e: string) => k(e) === 'circle' || k(e) === 'arc';
  switch (c.t) {
    case 'coincident':
      return [{ id, type: 'p2p_coincident', p1_id: pid(c.p1), p2_id: pid(c.p2) }];
    case 'horizontal':
      return k(c.e) === 'line' ? [{ id, type: 'horizontal_l', l_id: c.e }] : [];
    case 'vertical':
      return k(c.e) === 'line' ? [{ id, type: 'vertical_l', l_id: c.e }] : [];
    case 'parallel':
      return [{ id, type: 'parallel', l1_id: c.e1, l2_id: c.e2 }];
    case 'perpendicular':
      return [{ id, type: 'perpendicular_ll', l1_id: c.e1, l2_id: c.e2 }];
    case 'equal': {
      const [a, b] = [k(c.e1), k(c.e2)];
      if (a === 'line' && b === 'line') return [{ id, type: 'equal_length', l1_id: c.e1, l2_id: c.e2 }];
      if (a === 'circle' && b === 'circle') return [{ id, type: 'equal_radius_cc', c1_id: c.e1, c2_id: c.e2 }];
      if (a === 'arc' && b === 'arc') return [{ id, type: 'equal_radius_aa', a1_id: c.e1, a2_id: c.e2 }];
      if (a === 'circle' && b === 'arc') return [{ id, type: 'equal_radius_ca', c1_id: c.e1, a2_id: c.e2 }];
      if (a === 'arc' && b === 'circle') return [{ id, type: 'equal_radius_ca', c1_id: c.e2, a2_id: c.e1 }];
      return [];
    }
    case 'tangent': {
      let [e1, e2] = [c.e1, c.e2];
      if (k(e1) !== 'line' && k(e2) === 'line') [e1, e2] = [e2, e1];
      if (k(e1) === 'circle' && k(e2) === 'arc') [e1, e2] = [e1, e2];
      else if (k(e1) === 'arc' && k(e2) === 'circle') [e1, e2] = [e2, e1];
      const pair = `${k(e1)}-${k(e2)}`;
      if (pair === 'line-circle') return [{ id, type: 'tangent_lc', l_id: e1, c_id: e2 }];
      if (pair === 'line-arc') return [{ id, type: 'tangent_la', l_id: e1, a_id: e2 }];
      if (pair === 'circle-circle') return [{ id, type: 'tangent_cc', c1_id: e1, c2_id: e2 }];
      if (pair === 'circle-arc') return [{ id, type: 'tangent_ca', c_id: e1, a_id: e2 }];
      if (pair === 'arc-arc') return [{ id, type: 'tangent_aa', a1_id: e1, a2_id: e2 }];
      return [];
    }
    case 'concentric':
      return round(c.e1) && round(c.e2) ? [{ id, type: 'p2p_coincident', p1_id: `${c.e1}:c`, p2_id: `${c.e2}:c` }] : [];
    case 'midpoint':
      return k(c.e) === 'line' ? [{ id, type: 'p2p_symmetric_ppp', p1_id: `${c.e}:a`, p2_id: `${c.e}:b`, p_id: pid(c.p) }] : [];
    case 'onEntity': {
      if (k(c.e) === 'line') return [{ id, type: 'point_on_line_pl', p_id: pid(c.p), l_id: c.e }];
      if (k(c.e) === 'circle') return [{ id, type: 'point_on_circle', p_id: pid(c.p), c_id: c.e }];
      if (k(c.e) === 'arc') return [{ id, type: 'point_on_arc', p_id: pid(c.p), a_id: c.e }];
      return [];
    }
    case 'fix':
      return [
        { id: `${id}:x`, type: 'coordinate_x', p_id: pid(c.p), x: c.at[0] },
        { id: `${id}:y`, type: 'coordinate_y', p_id: pid(c.p), y: c.at[1] },
      ];
    case 'length':
      return k(c.e) === 'line' ? [{ id, type: 'p2p_distance', p1_id: `${c.e}:a`, p2_id: `${c.e}:b`, distance: c.v }] : [];
    case 'diameter':
      if (k(c.e) === 'circle') return [{ id, type: 'circle_diameter', c_id: c.e, diameter: c.v }];
      if (k(c.e) === 'arc') return [{ id, type: 'arc_radius', a_id: c.e, radius: c.v / 2 }];
      return [];
    case 'distance':
      return [{ id, type: 'p2p_distance', p1_id: pid(c.p1), p2_id: pid(c.p2), distance: c.v }];
    case 'angle': {
      const angle = (c.v * Math.PI) / 180;
      if (!c.flip) return [{ id, type: 'l2l_angle_ll', l1_id: c.e1, l2_id: c.e2, angle }];
      return [{ id, type: 'l2l_angle_pppp', l1p1_id: `${c.e1}:a`, l1p2_id: `${c.e1}:b`, l2p1_id: `${c.e2}:b`, l2p2_id: `${c.e2}:a`, angle }];
    }
  }
}

/**
 * Solve the sketch in place. With `drag`, the point is pulled towards `to` as far as the
 * constraints allow. On failure the entities are left untouched.
 */
export async function solveSketch(s: SketchFeature, drag?: { ref: PointRef; to: V2 }): Promise<SolveResult> {
  if (!s.entities.length) return { ok: true, dof: 0, conflicting: [] };
  const { make } = await loadSolver();
  const w = make();
  try {
    w.push_primitives_and_params(primitives(s, drag));
    const status = w.solve();
    const conflicting = w.has_gcs_conflicting_constraints() ? w.get_gcs_conflicting_constraints().map((x) => x.split(':')[0]) : [];
    // 0 Success, 1 Converged; anything else leaves the sketch as it was.
    if (status > 1 || conflicting.length) return { ok: false, dof: null, conflicting };
    w.apply_solution();
    const prims = new Map(w.sketch_index.get_primitives().map((p) => [p.id, p]));
    const pt = (id: string): V2 | null => {
      const p = prims.get(id);
      return p && p.type === 'point' ? [p.x, p.y] : null;
    };
    // A line squeezed to a point or a circle to nothing "satisfies" e.g. horizontal + vertical:
    // that is a conflict for the person drawing.
    const tiny = 1e-4;
    for (const e of s.entities) {
      const p = prims.get(e.id);
      const a = pt(`${e.id}:a`), b = pt(`${e.id}:b`);
      if (e.t === 'line' && a && b && Math.hypot(a[0] - b[0], a[1] - b[1]) < tiny) return { ok: false, dof: null, conflicting: [] };
      if ((p?.type === 'circle' || p?.type === 'arc') && p.radius < tiny) return { ok: false, dof: null, conflicting: [] };
    }
    for (const e of s.entities) {
      if (e.t === 'line') {
        e.a = pt(`${e.id}:a`) ?? e.a;
        e.b = pt(`${e.id}:b`) ?? e.b;
      } else if (e.t === 'circle') {
        const c = prims.get(e.id);
        e.c = pt(`${e.id}:c`) ?? e.c;
        if (c?.type === 'circle') e.r = c.radius;
      } else if (e.t === 'arc') {
        const a = prims.get(e.id);
        const c = pt(`${e.id}:c`);
        if (a?.type !== 'arc' || !c) continue;
        e.a = pt(`${e.id}:a`) ?? e.a;
        e.b = pt(`${e.id}:b`) ?? e.b;
        const mid = (a.start_angle + a.end_angle) / 2;
        e.m = [c[0] + a.radius * Math.cos(mid), c[1] + a.radius * Math.sin(mid)];
      } else e.c = pt(`${e.id}:c`) ?? e.c;
    }
    let dof: number | null = null;
    try {
      dof = w.gcs.dof();
    } catch {
      /* not reported by this build */
    }
    return { ok: true, dof, conflicting: [] };
  } finally {
    w.destroy_gcs_module();
  }
}
