import type { Params, SceneNode, ShapeKind } from './types';
import { uid } from './store';

export interface ParamSpec {
  key: string;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: 'mm' | '°' | '';
  /** Integer slider (segments, sides, points). */
  int?: boolean;
}

export interface ShapeDef {
  kind: ShapeKind;
  label: string;
  /** 24x24 SVG body drawn with currentColor. */
  icon: string;
  color: string;
  params: Params;
  specs: ParamSpec[];
}

/** Soft, modern palette (cycled for new shapes). */
export const PALETTE = ['#e80537', '#ff7500', '#43d141', '#ffffff', '#ffd300', '#009cdb', '#4747ff', '#8a5a3c', '#e64980', '#495057'];

const seg = (key = 'segments', label = 'Suavidade'): ParamSpec => ({ key, label, min: 8, max: 160, step: 1, int: true, unit: '' });

export const SHAPES: ShapeDef[] = [
  {
    kind: 'box', label: 'Caixa', color: '#f2545b',
    icon: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
    params: { width: 20, depth: 20, height: 20 },
    specs: [],
  },
  {
    kind: 'roundBox', label: 'Caixa arredondada', color: '#ff7a45',
    icon: '<rect x="4" y="5" width="16" height="14" rx="4"/><path d="M8 5c0 3 8 3 8 0" opacity=".5"/>',
    params: { width: 20, depth: 20, height: 20, radius: 3, segments: 32 },
    specs: [{ key: 'radius', label: 'Raio da borda', min: 0.2, max: 10, step: 0.1, unit: 'mm' }, seg()],
  },
  {
    kind: 'cylinder', label: 'Cilindro', color: '#f5a524',
    icon: '<ellipse cx="12" cy="6" rx="7" ry="2.6"/><path d="M5 6v12c0 1.5 3.1 2.6 7 2.6s7-1.1 7-2.6V6"/>',
    params: { radius: 10, height: 20, sides: 64 },
    specs: [seg('sides', 'Lados')],
  },
  {
    kind: 'sphere', label: 'Esfera', color: '#2fa8e0',
    icon: '<circle cx="12" cy="12" r="8"/><ellipse cx="12" cy="12" rx="8" ry="3" opacity=".5"/>',
    params: { radius: 10, segments: 64 },
    specs: [seg()],
  },
  {
    kind: 'cone', label: 'Cone', color: '#a259f7',
    icon: '<path d="M12 3L5 18c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8z"/><path d="M5 18c0-1.5 3.1-2.6 7-2.6s7 1.1 7 2.6" opacity=".5"/>',
    params: { radius: 10, topRadius: 0, height: 20, sides: 64 },
    specs: [{ key: 'topRadius', label: 'Raio do topo', min: 0, max: 50, step: 0.5, unit: 'mm' }, seg('sides', 'Lados')],
  },
  {
    kind: 'pyramid', label: 'Pirâmide', color: '#18b47b',
    icon: '<path d="M12 3l8 14-8 4-8-4z"/><path d="M12 3v18" opacity=".5"/>',
    params: { width: 20, height: 20 },
    specs: [],
  },
  {
    kind: 'wedge', label: 'Cunha', color: '#00b8a9',
    icon: '<path d="M4 18h12V6z"/><path d="M16 6l4 2.5V20.5L16 18M4 18l4 2.5h12" opacity=".6"/>',
    params: { width: 20, depth: 20, height: 20 },
    specs: [],
  },
  {
    kind: 'halfSphere', label: 'Meia esfera', color: '#e64980',
    icon: '<path d="M4 16a8 8 0 0116 0z"/><ellipse cx="12" cy="16" rx="8" ry="2.5" opacity=".5"/>',
    params: { radius: 10, segments: 64 },
    specs: [seg()],
  },
  {
    kind: 'torus', label: 'Toro', color: '#e80537',
    icon: '<ellipse cx="12" cy="12" rx="9" ry="5.5"/><ellipse cx="12" cy="11.5" rx="4" ry="1.8"/>',
    params: { radius: 10, tube: 3, segments: 64 },
    specs: [{ key: 'tube', label: 'Espessura', min: 0.5, max: 30, step: 0.1, unit: 'mm' }, seg()],
  },
  {
    kind: 'tube', label: 'Tubo', color: '#495057',
    icon: '<ellipse cx="12" cy="6" rx="7" ry="2.6"/><ellipse cx="12" cy="6" rx="3.5" ry="1.2"/><path d="M5 6v12c0 1.5 3.1 2.6 7 2.6s7-1.1 7-2.6V6"/>',
    params: { radius: 10, height: 20, wall: 2, sides: 64 },
    specs: [{ key: 'wall', label: 'Parede', min: 0.2, max: 40, step: 0.1, unit: 'mm' }, seg('sides', 'Lados')],
  },
  {
    kind: 'star', label: 'Estrela', color: '#f5a524',
    icon: '<path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6-4.5-4.2 6.1-.7z"/>',
    params: { points: 5, outer: 12, inner: 5, height: 6 },
    specs: [
      { key: 'points', label: 'Pontas', min: 3, max: 24, step: 1, int: true, unit: '' },
      { key: 'inner', label: 'Raio interno', min: 0.5, max: 50, step: 0.1, unit: 'mm' },
    ],
  },
  {
    kind: 'heart', label: 'Coração', color: '#f2545b',
    icon: '<path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0112 7.4 4.3 4.3 0 0119.5 10c0 5.4-7.5 10-7.5 10z"/>',
    params: { size: 20, height: 6 },
    specs: [],
  },
  {
    kind: 'text', label: 'Texto', color: '#e80537',
    icon: '<path d="M5 6V4.5h14V6M12 4.5V20M9 20h6"/>',
    params: { text: 'Olá', font: '', size: 14, height: 4, letterSpacing: 0, lineHeight: 1.2, align: 'center', outline: [] },
    specs: [],
  },
];

export const shapeDef = (kind: ShapeKind) => SHAPES.find((s) => s.kind === kind);

export const KIND_LABEL: Partial<Record<ShapeKind, string>> = {
  ...Object.fromEntries(SHAPES.map((s) => [s.kind, s.label])),
  svg: 'Desenho SVG',
  mesh: 'Malha importada',
  group: 'Grupo',
};

let paletteIdx = 0;
export const nextColor = () => PALETTE[paletteIdx++ % PALETTE.length];

export function createNode(kind: ShapeKind, extra: Partial<SceneNode> = {}): SceneNode {
  const def = shapeDef(kind);
  return {
    id: uid(),
    name: def?.label ?? KIND_LABEL[kind] ?? kind,
    kind,
    params: structuredClone(def?.params ?? {}),
    hole: false,
    color: def?.color ?? nextColor(),
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    ...extra,
  };
}
