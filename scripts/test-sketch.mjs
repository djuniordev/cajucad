// Checks sketch operations (trim, extend, offset, corners, DXF, slot): node scripts/test-sketch.mjs
import { build } from 'rolldown';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'node_modules', '.cache', 'sketch-ops.mjs');
await build({ input: path.join(root, 'src/part/sketchOps.ts'), platform: 'node', output: { file: out, format: 'esm' }, logLevel: 'silent' });
const ops = await import(`file:///${out.replace(/\\/g, '/')}`);

let failed = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'ok    ' : 'FALHOU'} ${name}${info ? ` | ${info}` : ''}`);
  if (!ok) failed++;
};
const sk = (entities, constraints = []) => ({ id: 's', type: 'sketch', name: 's', plane: 'XY', offset: 0, entities, constraints });
const close = (a, b, t = 1e-3) => Math.abs(a - b) < t;
const P = (p) => p.map((v) => +v.toFixed(3)).join(',');

{
  // A cross: trimming the right half of the horizontal line.
  const s = sk([{ id: 'h', t: 'line', a: [-10, 0], b: [10, 0] }, { id: 'v', t: 'line', a: [0, -10], b: [0, 10] }]);
  const r = ops.trim(s, 'h', [5, 0.1]);
  const h = s.entities.find((e) => e.id === 'h');
  check('aparar metade da linha', r === true && s.entities.length === 2 && close(h.b[0], 0) && close(h.a[0], -10), `h ${P(h.a)} → ${P(h.b)}`);
}
{
  // Middle piece between two verticals: the line splits in two.
  const s = sk([{ id: 'h', t: 'line', a: [-10, 0], b: [10, 0] }, { id: 'v1', t: 'line', a: [-5, -5], b: [-5, 5] }, { id: 'v2', t: 'line', a: [5, -5], b: [5, 5] }]);
  ops.trim(s, 'h', [0, 0]);
  const hs = s.entities.filter((e) => e.t === 'line' && Math.abs(e.a[1]) < 1e-6 && Math.abs(e.b[1]) < 1e-6);
  check('aparar o meio divide em duas', hs.length === 2, hs.map((e) => `${P(e.a)}→${P(e.b)}`).join(' '));
}
{
  // Circle cut by a line through it: keeping one half as an arc.
  const s = sk([{ id: 'c', t: 'circle', c: [0, 0], r: 10 }, { id: 'l', t: 'line', a: [-20, 0], b: [20, 0] }]);
  ops.trim(s, 'c', [0, 10]);
  const arc = s.entities.find((e) => e.t === 'arc');
  check('aparar círculo vira arco de baixo', !!arc && arc.m[1] < -9.9, arc ? `m ${P(arc.m)}` : 'sem arco');
}
check('aparar sem cruzamento avisa', ops.trim(sk([{ id: 'l', t: 'line', a: [0, 0], b: [1, 0] }]), 'l', [0.5, 0]) === false);
{
  const s = sk([{ id: 'l', t: 'line', a: [0, 0], b: [5, 0] }, { id: 'w', t: 'line', a: [12, -5], b: [12, 5] }]);
  ops.extend(s, 'l', [5, 0]);
  check('estender até a parede', close(s.entities[0].b[0], 12), P(s.entities[0].b));
}
{
  const s = sk([{ id: 'l', t: 'line', a: [0, 0], b: [5, 0] }, { id: 'c', t: 'circle', c: [20, 0], r: 4 }]);
  ops.extend(s, 'l', [5, 0]);
  check('estender até o círculo', close(s.entities[0].b[0], 16), P(s.entities[0].b));
}
{
  // Square drawn counter-clockwise, offset 2 outwards → 14×14.
  const pts = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const s = sk(pts.map((p, i) => ({ id: `l${i}`, t: 'line', a: p, b: pts[(i + 1) % 4] })));
  const r = ops.offset(s, 'l0', 2);
  const xs = r.ents.flatMap((e) => [e.a[0], e.b[0]]), ys = r.ents.flatMap((e) => [e.a[1], e.b[1]]);
  check('offset do quadrado para fora', r.ents.length === 4 && close(Math.min(...xs), -2) && close(Math.max(...ys), 12) && r.cons.length === 4, `x ${Math.min(...xs)}..${Math.max(...xs)}`);
  const cw = sk(pts.reverse().map((p, i, a) => ({ id: `l${i}`, t: 'line', a: p, b: a[(i + 1) % 4] })));
  const r2 = ops.offset(cw, 'l0', 2);
  const xs2 = r2.ents.flatMap((e) => [e.a[0], e.b[0]]);
  check('offset para fora também no sentido horário', close(Math.min(...xs2), -2), `x ${Math.min(...xs2)}..${Math.max(...xs2)}`);
}
{
  // Rounded rectangle side: line + arc; offset inwards keeps them joined.
  const s = sk([
    { id: 'l1', t: 'line', a: [0, 0], b: [10, 0] },
    { id: 'a1', t: 'arc', a: [10, 0], m: [15, 5], b: [10, 10] },
    { id: 'l2', t: 'line', a: [10, 10], b: [0, 10] },
    { id: 'l3', t: 'line', a: [0, 10], b: [0, 0] },
  ]);
  const r = ops.offset(s, 'a1', -1);
  const arc = r.ents.find((e) => e.t === 'arc');
  check('offset com arco para dentro', typeof r !== 'string' && r.ents.length === 4 && arc && close(Math.hypot(arc.m[0] - 10, arc.m[1] - 5), 4, 0.01), arc ? `m ${P(arc.m)}` : String(r));
}
{
  const s = sk([{ id: 'c', t: 'circle', c: [0, 0], r: 5 }]);
  const r = ops.offset(s, 'c', 3);
  check('offset do círculo', r.ents[0].r === 8 && r.cons[0].t === 'concentric');
}
{
  const s = sk([{ id: 'a', t: 'line', a: [0, 0], b: [10, 0] }, { id: 'b', t: 'line', a: [0, 0], b: [0, 10] }]);
  const err = ops.corner(s, [0, 0], 3, 'fillet');
  const arc = s.entities.find((e) => e.t === 'arc');
  check('filete de canto r3', !err && arc && close(arc.a[0], 3) && close(arc.b[1], 3) && close(Math.hypot(arc.m[0] - 3, arc.m[1] - 3), 3), err ?? `m ${P(arc.m)}`);
  const s2 = sk([{ id: 'a', t: 'line', a: [0, 0], b: [10, 0] }, { id: 'b', t: 'line', a: [0, 0], b: [0, 10] }]);
  ops.corner(s2, [0, 0], 2, 'chamfer');
  check('chanfro de canto 2', s2.entities.length === 3 && close(s2.entities[0].a[0], 2));
  check('filete grande demais avisa', typeof ops.corner(sk([{ id: 'a', t: 'line', a: [0, 0], b: [1, 0] }, { id: 'b', t: 'line', a: [0, 0], b: [0, 1] }]), [0, 0], 5, 'fillet') === 'string');
}
{
  const s = sk([{ id: 'a', t: 'line', a: [0, 0], b: [10, 0.01] }, { id: 'b', t: 'line', a: [10, 0.01], b: [10, 10] }]);
  const n = ops.autoConstrain(s);
  check('restrições automáticas', n === 3 && s.constraints.some((c) => c.t === 'coincident'), `${n}: ${s.constraints.map((c) => c.t).join(', ')}`);
  check('não repete restrições', ops.autoConstrain(s) === 0);
}
{
  const dxf = [
    '0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '10', '21', '0',
    '0', 'CIRCLE', '8', '0', '10', '5', '20', '5', '40', '2',
    '0', 'ARC', '8', '0', '10', '0', '20', '0', '40', '5', '50', '0', '51', '90',
    '0', 'LWPOLYLINE', '8', '0', '90', '3', '70', '1', '10', '0', '20', '0', '10', '10', '20', '0', '42', '1', '10', '10', '20', '10',
    '0', 'TEXT', '8', '0', '1', 'oi',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\n');
  const { ents, skipped } = ops.parseDxf(dxf);
  const kinds = ents.map((e) => e.t).join(',');
  const arc = ents[2];
  check('DXF: linha, círculo, arco, polilinha com bulge', kinds === 'line,circle,arc,line,arc,line' && skipped === 1 && close(arc.m[0], 5 * Math.SQRT1_2), kinds);
  const bulge = ents[4];
  check('DXF: bulge vira semicírculo', close(Math.hypot(bulge.m[0] - 10, bulge.m[1] - 5), 5) && bulge.m[0] > 14.9, P(bulge.m));
}
{
  const r = ops.slot([0, 0], [20, 0], 4);
  check('rasgo: 2 linhas + 2 arcos', r.ents.map((e) => e.t).join(',') === 'line,arc,line,arc' && close(r.ents[1].m[0], 24), P(r.ents[1].m));
}
process.exit(failed ? 1 : 0);
