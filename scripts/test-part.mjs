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
const cases = {
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
  const vol = r.shape ? r.shape.volume ?? '' : '';
  console.log(`${r.error && !name.startsWith('erro') ? 'FALHOU' : 'ok    '} ${name}: tris ${(r.mesh?.indices.length ?? 0) / 3}, x ${bb[0]} y ${bb[1]} z ${bb[2]}${r.error ? ` | erro: ${r.error.message}` : ''}`);
  if (name.startsWith('erro') ? !r.error : r.error || !r.mesh) failed++;
}
process.exit(failed ? 1 : 0);
