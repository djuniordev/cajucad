// Checks the parametric part kernel outside the app: node scripts/test-part.mjs
import { build } from 'rolldown';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'package.json'));
const out = path.join(root, 'node_modules', '.cache', 'part-kernel.mjs');
await build({
  input: path.join(root, 'src/part/kernel.ts'),
  platform: 'node',
  external: [/^replicad/],
  output: { file: out, format: 'esm' },
  logLevel: 'silent',
});
const { buildPart, provideKernel } = await import(`file:///${out.replace(/\\/g, '/')}`);
const { default: opencascade } = await import('replicad-opencascadejs');
const rc = await import('replicad');
rc.setOC(await opencascade({ wasmBinary: readFileSync(require.resolve('replicad-opencascadejs/wasm')) }));
provideKernel(rc);

const sk = (id, plane, entities, offset = 0) => ({ id, type: 'sketch', name: id, plane, offset, entities });
const box = () => [
  sk('b', 'XY', [{ id: 'r', t: 'rect', c: [0, 0], w: 40, h: 20 }]),
  { id: 'eb', type: 'extrude', name: 'eb', sketch: 'b', distance: 10, symmetric: false, reverse: false, op: 'join' },
];
const hole = (id, at, extra = {}) => ({ id, type: 'hole', name: id, at, n: [0, 0, 1], diameter: 4, depth: 6, through: false, kind: 'simple', headDiameter: 8, headDepth: 2, ...extra });
const pattern = (id, extra) => ({ id, type: 'pattern', name: id, kind: 'linear', sources: [], axis: 'x', count: 3, spacing: 10, angle: 360, axis2: null, count2: 1, spacing2: 10, plane: 'YZ', ...extra });
const cases = {
  'filete nas 4 arestas de cima (r 3)': [...box(), { id: 'f', type: 'fillet', name: 'f', edges: [[0, 10, 10], [0, -10, 10], [20, 0, 10], [-20, 0, 10]], all: false, size: 3 }],
  'chanfro em todas (1)': [...box(), { id: 'c', type: 'chamfer', name: 'c', edges: [], all: true, size: 1 }],
  'casca aberta em cima (2)': [...box(), { id: 's', type: 'shell', name: 's', faces: [[5, 5, 10]], thickness: 2 }],
  'furo simples + rebaixo + escareado': [...box(), hole('h1', [-12, 0, 10]), hole('h2', [0, 0, 10], { kind: 'counterbore', through: true }), hole('h3', [12, 0, 10], { kind: 'countersink' })],
  'padrão linear 3x2 de furos': [...box(), hole('h', [-15, -5, 10], { through: true }), pattern('p', { sources: ['h'], count: 3, spacing: 15, axis2: 'y', count2: 2, spacing2: 10 })],
  'padrão circular do corpo (4)': [...box(), pattern('p', { kind: 'circular', axis: 'z', count: 4 })],
  'espelho do corpo em YZ': [sk('b', 'XY', [{ id: 'r', t: 'rect', c: [15, 0], w: 10, h: 10 }]), { id: 'eb', type: 'extrude', name: 'eb', sketch: 'b', distance: 5, symmetric: false, reverse: false, op: 'join' }, pattern('p', { kind: 'mirror' })],
  'erro esperado: aresta que não existe': [...box(), { id: 'f', type: 'fillet', name: 'f', edges: [[200, 200, 200]], all: false, size: 1 }],
  'retângulo com furo, extrudado': [
    sk('s1', 'XY', [{ id: 'r', t: 'rect', c: [0, 0], w: 40, h: 20 }, { id: 'c', t: 'circle', c: [0, 0], r: 5 }]),
    { id: 'e1', type: 'extrude', name: 'e1', sketch: 's1', distance: 10, symmetric: false, reverse: false, op: 'join' },
  ],
  'linhas e arco fechados + corte de frente': [
    sk('s1', 'XY', [
      { id: 'l1', t: 'line', a: [0, 0], b: [30, 0] },
      { id: 'l2', t: 'line', a: [30, 0], b: [30, 20] },
      { id: 'a1', t: 'arc', a: [30, 20], m: [15, 28], b: [0, 20] },
      { id: 'l3', t: 'line', a: [0, 20], b: [0, 0] },
    ]),
    { id: 'e1', type: 'extrude', name: 'e1', sketch: 's1', distance: 8, symmetric: false, reverse: false, op: 'join' },
    sk('s2', 'XZ', [{ id: 'c', t: 'circle', c: [15, 4], r: 3 }]),
    { id: 'e2', type: 'extrude', name: 'e2', sketch: 's2', distance: 60, symmetric: true, reverse: false, op: 'cut' },
  ],
  'revolução (vaso)': [
    sk('s1', 'XZ', [{ id: 'r', t: 'rect', c: [12, 15], w: 4, h: 30 }]),
    { id: 'v1', type: 'revolve', name: 'v1', sketch: 's1', axis: 'y', angle: 360, op: 'join' },
  ],
  'polígono extrudado para baixo': [
    sk('s1', 'XY', [{ id: 'p', t: 'polygon', c: [0, 0], r: 10, n: 6 }], 5),
    { id: 'e1', type: 'extrude', name: 'e1', sketch: 's1', distance: 5, symmetric: false, reverse: true, op: 'join' },
  ],
  'erro esperado: esboço aberto': [
    sk('s1', 'XY', [{ id: 'l1', t: 'line', a: [0, 0], b: [10, 0] }]),
    { id: 'e1', type: 'extrude', name: 'e1', sketch: 's1', distance: 5, symmetric: false, reverse: false, op: 'join' },
  ],
};
let failed = 0;
for (const [name, features] of Object.entries(cases)) {
  const r = await buildPart({ version: 1, features });
  const p = r.mesh?.positions ?? [];
  const bb = [0, 1, 2].map((a) => {
    const v = p.filter((_, i) => i % 3 === a);
    return v.length ? `${Math.min(...v).toFixed(1)}..${Math.max(...v).toFixed(1)}` : '-';
  });
  const vol = r.shape ? Math.round(rc.measureShapeVolumeProperties(r.shape).volume) : '';
  console.log(`${r.error && !name.startsWith('erro') ? 'FALHOU' : 'ok    '} ${name}: tris ${(r.mesh?.indices.length ?? 0) / 3}, x ${bb[0]} y ${bb[1]} z ${bb[2]} vol ${vol}${r.error ? ` | erro: ${r.error.message}` : ''}`);
  if (name.startsWith('erro') ? !r.error : r.error || !r.mesh) failed++;
}
process.exit(failed ? 1 : 0);
