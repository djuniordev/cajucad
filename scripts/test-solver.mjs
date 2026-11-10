// Checks sketch constraint solving outside the app: node scripts/test-solver.mjs
import { build } from 'rolldown';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'node_modules', '.cache', 'part-solver.mjs');
await build({ input: path.join(root, 'src/part/solver.ts'), platform: 'node', external: [/^@salusoft89/], output: { file: out, format: 'esm' }, logLevel: 'silent' });
const { solveSketch, provideSolver } = await import(`file:///${out.replace(/\\/g, '/')}`);
const gcs = await import('@salusoft89/planegcs');
const mod = await gcs.init_planegcs_module();
provideSolver(() => new gcs.GcsWrapper(new mod.GcsSystem(), mod));

const r = (p) => p.map((v) => Math.round(v * 1000) / 1000);
let failed = 0;
const check = (name, cond, info) => {
  console.log(`${cond ? 'ok    ' : 'FALHOU'} ${name}${info ? ` | ${info}` : ''}`);
  if (!cond) failed++;
};
const near = (a, b) => Math.abs(a - b) < 1e-3;

// Rough quadrilateral -> 30 x 20 rectangle with a corner on the origin.
{
  const L = (id, a, b) => ({ id, t: 'line', a, b });
  const s = {
    id: 's', type: 'sketch', name: 's', plane: 'XY', offset: 0,
    entities: [L('l1', [1, 0.5], [28, 2]), L('l2', [28, 2], [29, 18]), L('l3', [29, 18], [2, 21]), L('l4', [2, 21], [1, 0.5])],
    constraints: [
      { id: 'c1', t: 'coincident', p1: { e: 'l1', p: 'b' }, p2: { e: 'l2', p: 'a' } },
      { id: 'c2', t: 'coincident', p1: { e: 'l2', p: 'b' }, p2: { e: 'l3', p: 'a' } },
      { id: 'c3', t: 'coincident', p1: { e: 'l3', p: 'b' }, p2: { e: 'l4', p: 'a' } },
      { id: 'c4', t: 'coincident', p1: { e: 'l4', p: 'b' }, p2: { e: 'l1', p: 'a' } },
      { id: 'h1', t: 'horizontal', e: 'l1' }, { id: 'h2', t: 'horizontal', e: 'l3' },
      { id: 'v1', t: 'vertical', e: 'l2' }, { id: 'v2', t: 'vertical', e: 'l4' },
      { id: 'o', t: 'coincident', p1: { e: 'l1', p: 'a' }, p2: 'origin' },
      { id: 'w', t: 'length', e: 'l1', v: 30 }, { id: 'h', t: 'length', e: 'l2', v: 20 },
    ],
  };
  const res = await solveSketch(s);
  const [l1, l2] = s.entities;
  check('retângulo por restrições', res.ok && near(l1.a[0], 0) && near(l1.a[1], 0) && near(l1.b[0], 30) && near(l2.b[1], 20), `l1 ${r(l1.a)}→${r(l1.b)} l2 →${r(l2.b)} dof ${res.dof}`);
}

// Circle diameter, concentric, tangent line.
{
  const s = {
    id: 's', type: 'sketch', name: 's', plane: 'XY', offset: 0,
    entities: [{ id: 'c', t: 'circle', c: [3, 2], r: 4 }, { id: 'd', t: 'circle', c: [1, 1], r: 9 }, { id: 'l', t: 'line', a: [-20, 12], b: [20, 11] }],
    constraints: [
      { id: 'k1', t: 'coincident', p1: { e: 'c', p: 'c' }, p2: 'origin' },
      { id: 'k2', t: 'diameter', e: 'c', v: 10 },
      { id: 'k3', t: 'concentric', e1: 'c', e2: 'd' },
      { id: 'k4', t: 'diameter', e: 'd', v: 24 },
      { id: 'k5', t: 'horizontal', e: 'l' },
      { id: 'k6', t: 'tangent', e1: 'l', e2: 'd' },
    ],
  };
  const res = await solveSketch(s);
  const [c, d, l] = s.entities;
  check('círculos concêntricos + reta tangente', res.ok && near(c.r, 5) && near(d.c[0], 0) && near(d.r, 12) && near(Math.abs(l.a[1]), 12) && near(l.a[1], l.b[1]), `c r=${r([c.r])} d ${r(d.c)} r=${r([d.r])} reta y=${r([l.a[1]])}`);
}

// Arc tangent to a line at its end, radius driven.
{
  const s = {
    id: 's', type: 'sketch', name: 's', plane: 'XY', offset: 0,
    entities: [{ id: 'l', t: 'line', a: [0, 0], b: [20, 0] }, { id: 'a', t: 'arc', a: [20, 0], m: [26, 5], b: [21, 11] }],
    constraints: [
      { id: 'f', t: 'fix', p: { e: 'l', p: 'a' }, at: [0, 0] },
      { id: 'h', t: 'horizontal', e: 'l' },
      { id: 'len', t: 'length', e: 'l', v: 20 },
      { id: 'j', t: 'coincident', p1: { e: 'l', p: 'b' }, p2: { e: 'a', p: 'a' } },
      { id: 't', t: 'tangent', e1: 'l', e2: 'a' },
      { id: 'r', t: 'diameter', e: 'a', v: 12 },
    ],
  };
  const res = await solveSketch(s);
  const [, a] = s.entities;
  const ctr = [(a.a[0]), a.a[1]];
  check('arco tangente à reta', res.ok && near(a.a[0], 20) && near(a.a[1], 0), `arco ${r(a.a)} m ${r(a.m)} b ${r(a.b)} (início ${r(ctr)})`);
}

// Conflict: a horizontal line with a 45° angle to another horizontal line.
{
  const s = {
    id: 's', type: 'sketch', name: 's', plane: 'XY', offset: 0,
    entities: [{ id: 'l1', t: 'line', a: [0, 0], b: [10, 0] }, { id: 'l2', t: 'line', a: [0, 5], b: [10, 5] }],
    constraints: [{ id: 'h1', t: 'horizontal', e: 'l1' }, { id: 'h2', t: 'horizontal', e: 'l2' }, { id: 'ang', t: 'angle', e1: 'l1', e2: 'l2', v: 45 }],
  };
  const before = JSON.stringify(s.entities);
  const res = await solveSketch(s);
  check('conflito detectado e esboço intacto', !res.ok && JSON.stringify(s.entities) === before, `conflitos: ${res.conflicting.join(',')}`);
}

// Drag: pulling a free end of a horizontal line keeps it horizontal.
{
  const s = {
    id: 's', type: 'sketch', name: 's', plane: 'XY', offset: 0,
    entities: [{ id: 'l', t: 'line', a: [0, 0], b: [10, 0] }],
    constraints: [{ id: 'f', t: 'fix', p: { e: 'l', p: 'a' }, at: [0, 0] }, { id: 'h', t: 'horizontal', e: 'l' }],
  };
  const res = await solveSketch(s, { ref: { e: 'l', p: 'b' }, to: [15, 7] });
  const l = s.entities[0];
  check('arrastar respeita a horizontal', res.ok && near(l.b[1], 0) && l.b[0] > 12, `fim ${r(l.b)}`);
}
// Horizontal + vertical on one line would squeeze it to a point: refused.
{
  const s = { id: 's', type: 'sketch', name: 's', plane: 'XY', offset: 0, entities: [{ id: 'l', t: 'line', a: [0, 0], b: [10, 0] }], constraints: [{ id: 'h', t: 'horizontal', e: 'l' }, { id: 'v', t: 'vertical', e: 'l' }] };
  const res = await solveSketch(s);
  check('linha degenerada recusada', !res.ok && s.entities[0].b[0] === 10);
}
// No constraints: solves without moving anything and reports the free degrees.
{
  const s = { id: 's', type: 'sketch', name: 's', plane: 'XY', offset: 0, entities: [{ id: 'l', t: 'line', a: [1, 2], b: [7, 3] }] };
  const res = await solveSketch(s);
  const l = s.entities[0];
  check('sem restrições', res.ok && near(l.a[0], 1) && near(l.b[1], 3) && res.dof === 4, `dof ${res.dof}`);
}
// Slot drawn by the tool: 5 free degrees (two centres and the width), nothing redundant.
{
  const ops = path.join(root, 'node_modules', '.cache', 'sketch-ops-s.mjs');
  await build({ input: path.join(root, 'src/part/sketchOps.ts'), platform: 'node', output: { file: ops, format: 'esm' }, logLevel: 'silent' });
  const { slot, corner } = await import(`file:///${ops.replace(/\\/g, '/')}`);
  const sl = slot([0, 0], [20, 0], 4);
  const s = { id: 's', type: 'sketch', name: 's', plane: 'XY', offset: 0, entities: sl.ents, constraints: sl.cons };
  const res = await solveSketch(s);
  check('rasgo com 5 graus livres', res.ok && res.dof === 5, `dof ${res.dof}`);
  // Rounded corner on a constrained rectangle stays solvable.
  const pts = [[0, 0], [30, 0], [30, 20], [0, 20]];
  const ls = pts.map((p, i) => ({ id: `l${i}`, t: 'line', a: p, b: pts[(i + 1) % 4] }));
  const cons = ls.map((l, i) => ({ id: `c${i}`, t: 'coincident', p1: { e: l.id, p: 'b' }, p2: { e: ls[(i + 1) % 4].id, p: 'a' } }));
  cons.push(...ls.map((l, i) => ({ id: `hv${i}`, t: i % 2 ? 'vertical' : 'horizontal', e: l.id })));
  const r2 = { id: 's', type: 'sketch', name: 's', plane: 'XY', offset: 0, entities: ls, constraints: cons };
  await solveSketch(r2);
  const err = corner(r2, [30, 20], 5, 'fillet');
  const res2 = await solveSketch(r2);
  check('filete de canto num retângulo restrito', !err && res2.ok, `dof ${res2.dof}`);
}
process.exit(failed ? 1 : 0);
