/**
 * Named parameters with formulas (`largura = 40`, `furo = largura / 4 + 1`), configurations that
 * override some of them, and number fields of features driven by formulas.
 */
import { isDimension, type Feature, type PartDef } from './model';

export interface Param {
  name: string;
  expr: string;
}

/** A named set of parameter overrides (e.g. "Pequena", "Grande"). */
export interface Config {
  id: string;
  name: string;
  values: Record<string, string>;
}

// ---------- formulas ----------

const FUNCS: Record<string, (...a: number[]) => number> = {
  sin: (x) => Math.sin((x * Math.PI) / 180),
  cos: (x) => Math.cos((x * Math.PI) / 180),
  tan: (x) => Math.tan((x * Math.PI) / 180),
  asin: (x) => (Math.asin(x) * 180) / Math.PI,
  acos: (x) => (Math.acos(x) * 180) / Math.PI,
  atan: (x) => (Math.atan(x) * 180) / Math.PI,
  sqrt: Math.sqrt,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  min: Math.min,
  max: Math.max,
};
const CONSTS: Record<string, number> = { pi: Math.PI };

export const NAME_RE = /^[A-Za-z_À-ÿ][\wÀ-ÿ]*$/;

/** A plain number (with a comma or a dot), as opposed to a formula. */
export const isPlainNumber = (s: string) => /^\s*[-+]?(\d+([.,]\d*)?|[.,]\d+)\s*$/.test(s);

/**
 * Value of a formula: + - * / ^, parentheses, numbers (comma or dot), parameter names and
 * sin/cos/tan (degrees), sqrt, abs, round, floor, ceil, min, max, pi. `get` gives a name's value.
 */
export function evalExpr(src: string, get: (name: string) => number): number {
  const s = src.trim().replace(/^=/, '');
  let i = 0;
  const ws = () => {
    while (s[i] === ' ' || s[i] === '\t') i++;
  };
  const fail = (msg: string): never => {
    throw new Error(msg);
  };
  const atom = (): number => {
    ws();
    const c = s[i];
    if (c === '(') {
      i++;
      const v = sum();
      ws();
      if (s[i] !== ')') fail('Falta fechar um parêntese.');
      i++;
      return v;
    }
    if (c === '-' || c === '+') {
      i++;
      const v = power();
      return c === '-' ? -v : v;
    }
    const num = /^(\d+(?:[.,]\d*)?|[.,]\d+)/.exec(s.slice(i));
    if (num) {
      i += num[0].length;
      return Number(num[0].replace(',', '.'));
    }
    const id = /^[A-Za-z_À-ÿ][\wÀ-ÿ]*/.exec(s.slice(i));
    if (!id) return fail(c === undefined ? 'A fórmula terminou no meio.' : `Não entendi “${c}”.`);
    i += id[0].length;
    const name = id[0];
    ws();
    if (s[i] === '(') {
      const fn = FUNCS[name.toLowerCase()];
      if (!fn) fail(`Função desconhecida: ${name}.`);
      i++;
      const args: number[] = [];
      ws();
      if (s[i] !== ')')
        for (;;) {
          args.push(sum());
          ws();
          // A semicolon also separates arguments (the comma is the decimal mark in pt-BR).
          if (s[i] === ';' || (s[i] === ',' && !/\d/.test(s[i + 1] ?? ''))) {
            i++;
            continue;
          }
          break;
        }
      if (s[i] !== ')') fail('Falta fechar um parêntese.');
      i++;
      return fn(...args);
    }
    if (name.toLowerCase() in CONSTS) return CONSTS[name.toLowerCase()];
    return get(name);
  };
  const power = (): number => {
    const b = atom();
    ws();
    if (s[i] === '^') {
      i++;
      return Math.pow(b, power());
    }
    return b;
  };
  const product = (): number => {
    let v = power();
    for (;;) {
      ws();
      const c = s[i];
      if (c !== '*' && c !== '/') return v;
      i++;
      const r = power();
      v = c === '*' ? v * r : v / r;
    }
  };
  const sum = (): number => {
    let v = product();
    for (;;) {
      ws();
      const c = s[i];
      if (c !== '+' && c !== '-') return v;
      i++;
      const r = product();
      v = c === '+' ? v + r : v - r;
    }
  };
  if (!s) fail('A fórmula está vazia.');
  const v = sum();
  ws();
  if (i < s.length) fail(`Não entendi “${s.slice(i)}”.`);
  if (!Number.isFinite(v)) fail('A conta não dá um número (divisão por zero?).');
  return v;
}

/** Every parameter's value under the active configuration; a broken one gets an error instead. */
export function paramValues(part: PartDef): { values: Record<string, number>; errors: Record<string, string> } {
  const params = part.params ?? [];
  const cfg = part.configs?.find((c) => c.id === part.config);
  const exprOf = new Map(params.map((p) => [p.name, cfg?.values[p.name] ?? p.expr]));
  const values: Record<string, number> = {};
  const errors: Record<string, string> = {};
  const visiting = new Set<string>();
  const get = (name: string): number => {
    if (name in values) return values[name];
    if (name in errors) throw new Error(`“${name}” está com erro.`);
    const e = exprOf.get(name);
    if (e === undefined) throw new Error(`Não existe o parâmetro “${name}”.`);
    if (visiting.has(name)) throw new Error(`“${name}” depende dele mesmo.`);
    visiting.add(name);
    try {
      return (values[name] = evalExpr(e, get));
    } finally {
      visiting.delete(name);
    }
  };
  for (const p of params) {
    try {
      get(p.name);
    } catch (e) {
      errors[p.name] = (e as Error).message;
    }
  }
  return { values, errors };
}

/** Value of a formula with the part's parameters. */
export function evalWith(part: PartDef, expr: string) {
  const { values } = paramValues(part);
  return evalExpr(expr, (n) => {
    if (!(n in values)) throw new Error(`Não existe o parâmetro “${n}” (ou ele está com erro).`);
    return values[n];
  });
}

// ---------- fields driven by formulas ----------

/** Constraint dimensions are keyed `c:<constraint id>` under their sketch. */
export const constraintKey = (id: string) => `c:${id}`;

/** Put a number into a feature field (`distance`, `at.0`, `offset.2`, `c:<constraint>`). */
export function setField(f: Feature, key: string, v: number) {
  if (key.startsWith('c:')) {
    if (f.type !== 'sketch') return false;
    const c = f.constraints?.find((x) => x.id === key.slice(2));
    if (!c || !isDimension(c)) return false;
    const nv = c.t === 'angle' ? (c.v < 0 ? -1 : 1) * Math.abs(v) : v;
    if (nv === c.v) return false;
    c.v = nv;
    return true;
  }
  const rec = f as unknown as Record<string, unknown>;
  const [k, idx] = key.split('.');
  if (idx !== undefined) {
    const arr = rec[k] as number[] | null;
    if (!Array.isArray(arr) || arr[Number(idx)] === v) return false;
    arr[Number(idx)] = v;
    return true;
  }
  if (typeof rec[k] !== 'number' || rec[k] === v) return false;
  rec[k] = v;
  return true;
}

/**
 * Re-evaluate every formula field with the current parameters. Returns the features whose
 * values changed (sketches among them need solving again) and the fields that failed.
 */
export function applyParams(part: PartDef): { changed: Feature[]; errors: { feature: string; key: string; message: string }[] } {
  const changed = new Set<Feature>();
  const errors: { feature: string; key: string; message: string }[] = [];
  for (const [fidKey, fields] of Object.entries(part.exprs ?? {})) {
    const f = part.features.find((x) => x.id === fidKey);
    if (!f) {
      delete part.exprs![fidKey];
      continue;
    }
    for (const [key, expr] of Object.entries(fields)) {
      try {
        if (setField(f, key, evalWith(part, expr))) changed.add(f);
      } catch (e) {
        errors.push({ feature: f.id, key, message: (e as Error).message });
      }
    }
  }
  return { changed: [...changed], errors };
}

/** Formulas that mention a parameter name (to stop it from being deleted or renamed blindly). */
export function usesOf(part: PartDef, name: string): number {
  const re = new RegExp(`(^|[^\\wÀ-ÿ])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\wÀ-ÿ])`);
  let n = 0;
  for (const p of part.params ?? []) if (p.name !== name && re.test(p.expr)) n++;
  for (const fields of Object.values(part.exprs ?? {})) for (const e of Object.values(fields)) if (re.test(e)) n++;
  return n;
}
