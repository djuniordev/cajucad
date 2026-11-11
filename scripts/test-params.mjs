// Checks parameters and formulas: node scripts/test-params.mjs
import { build } from 'rolldown';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'node_modules', '.cache', 'part-params.mjs');
await build({ input: path.join(root, 'src/part/params.ts'), platform: 'node', output: { file: out, format: 'esm' }, logLevel: 'silent' });
const P = await import(`file:///${out.split(path.sep).join('/')}`);

let failed = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'ok    ' : 'FALHOU'} ${name} | ${got}`);
  if (!ok) failed++;
};
const ev = (s, vars = {}) => {
  try {
    return P.evalExpr(s, (n) => {
      if (!(n in vars)) throw new Error(`sem ${n}`);
      return vars[n];
    });
  } catch (e) {
    return 'ERRO ' + e.message;
  }
};
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;

check('precedência e potência', near(ev('2 + 3 * 4 ^ 2 / 8'), 8), ev('2 + 3 * 4 ^ 2 / 8'));
check('vírgula decimal e menos', near(ev('-1,5 * (2 - 4)'), 3), ev('-1,5 * (2 - 4)'));
check('funções em graus', near(ev('sin(30) + cos(60) + sqrt(16)'), 5), ev('sin(30) + cos(60) + sqrt(16)'));
check('max com ;', near(ev('max(2; 7; 3)'), 7), ev('max(2; 7; 3)'));
check('max com vírgula e espaço', near(ev('max(a, b)', { a: 2, b: 9 }), 9), ev('max(a, b)', { a: 2, b: 9 }));
check('erro: lixo no fim', String(ev('2 3')).startsWith('ERRO'), ev('2 3'));
check('erro: parêntese', String(ev('(2 + 3')).startsWith('ERRO'), ev('(2 + 3'));
check('número simples', P.isPlainNumber('12,5') && !P.isPlainNumber('a+1'), 'ok');

const part = {
  version: 1,
  params: [
    { name: 'largura', expr: '40' },
    { name: 'furo', expr: 'largura / 4 + 1' },
    { name: 'a', expr: 'b' },
    { name: 'b', expr: 'a' },
  ],
  configs: [{ id: 'g', name: 'Grande', values: { largura: '80' } }],
  features: [
    { id: 'e', type: 'extrude', name: 'e', sketch: 's', distance: 1, symmetric: false, reverse: false, op: 'join' },
    { id: 's', type: 'sketch', name: 's', plane: 'XY', offset: 0, entities: [], constraints: [{ id: 'k', t: 'length', e: 'l', v: 5 }] },
    { id: 'm', type: 'move', name: 'm', offset: [0, 0, 0], angle: 0, axis: 'z', copy: false },
  ],
  exprs: { e: { distance: 'furo * 2' }, s: { 'c:k': 'largura' }, m: { 'offset.2': 'furo' } },
};
let v = P.paramValues(part);
check('dependência entre parâmetros', near(v.values.furo, 11), v.values.furo);
check('ciclo vira erro', !!v.errors.a && !!v.errors.b, v.errors.a);
let r = P.applyParams(part);
check('campos recebem as fórmulas', part.features[0].distance === 22 && part.features[1].constraints[0].v === 40 && part.features[2].offset[2] === 11, `${part.features[0].distance} ${part.features[1].constraints[0].v} ${part.features[2].offset}`);
check('mudou 3 operações', r.changed.length === 3, r.changed.length);
part.config = 'g';
r = P.applyParams(part);
check('configuração “Grande”', part.features[0].distance === 42 && part.features[1].constraints[0].v === 80, `${part.features[0].distance} ${part.features[1].constraints[0].v}`);
check('usos de largura', P.usesOf(part, 'largura') === 2, P.usesOf(part, 'largura'));
process.exit(failed ? 1 : 0);
