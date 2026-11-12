import type { Manifold } from 'manifold-3d';
import { nodeMatrix, piecesOf, unionSolids, worldSolid } from './geometry';
import { meshToStl } from './io';
import { MATCH_DISTANCE, colorDistance, filaments, nearestByColor, type Filament } from './filaments';
import type { DesignDoc, SceneNode } from './types';

/**
 * From the design to a print job:
 *  1. every visible solid becomes one object per colour, placed on the bed (a
 *     group with several colours is split into one object for each colour);
 *  2. objects are grouped into filament "slots" by the colour they are painted with;
 *  3. slots are matched to the printer's AMS trays (nearest colour, like Bambu Studio does).
 */

/** Anything that is painted: a node, or one colour piece of a group. */
export interface Paintable {
  color: string;
  filament?: string;
}

export interface Slot {
  /** `f:<filamentId>` for a known filament, `c:<#hex>` for a bare colour. */
  key: string;
  color: string;
  type: string;
  name: string;
  filamentId?: string;
  /** Objects printed with this slot. */
  count: number;
}

export interface Tray {
  id: number;
  amsId: number;
  slot: number;
  color: string | null;
  type: string;
  name: string;
  empty: boolean;
  external?: boolean;
}

export interface PlanEntry<T extends Paintable = Paintable> {
  item: T;
  slot: number;
}

/** Colour override chosen in the dialog: object colour -> filament id or 'own'. */
export type ColorMap = Record<string, string>;

/**
 * Solid, visible leaves of the scene that carry a colour: top-level objects, and
 * the children of groups (so a multicolour group counts every colour it has).
 */
export function colorLeaves(nodes: SceneNode[]): Paintable[] {
  const out: Paintable[] = [];
  const walk = (n: SceneNode) => {
    if (n.hidden || n.hole) return;
    if (n.kind === 'group') (n.children ?? []).forEach(walk);
    else out.push({ color: n.color, filament: n.filament });
  };
  nodes.forEach(walk);
  return out;
}

export function planSlots<T extends Paintable>(items: T[], colorMap: ColorMap = {}) {
  const slots: Slot[] = [];
  const entries: PlanEntry<T>[] = [];
  const list = filaments.list;

  for (const item of items) {
    let f: Filament | undefined = filaments.get(item.filament);
    if (!f) {
      const choice = colorMap[item.color.toLowerCase()];
      if (choice && choice !== 'own') f = filaments.get(choice);
      else if (!choice && list.length) f = nearestByColor(item.color, list, MATCH_DISTANCE);
    }
    const key = f ? `f:${f.id}` : `c:${item.color.toLowerCase()}`;
    let i = slots.findIndex((s) => s.key === key);
    if (i < 0) {
      slots.push(
        f
          ? { key, color: f.color, type: f.type, name: f.name, filamentId: f.id, count: 0 }
          : { key, color: item.color, type: 'PLA', name: 'PLA', count: 0 },
      );
      i = slots.length - 1;
    }
    slots[i].count++;
    entries.push({ item, slot: i });
  }
  return { slots, entries };
}

/** Pick an AMS tray for each slot: same filament, else nearest colour of the same type, else any. */
export function autoMapTrays(slots: Slot[], trays: Tray[]): (number | null)[] {
  const usable = trays.filter((t) => !t.empty && t.color);
  const taken = new Set<number>();
  return slots.map((s) => {
    const fil = filaments.get(s.filamentId);
    const exact = fil?.tray !== undefined ? usable.find((t) => t.id === fil.tray && !taken.has(t.id)) : undefined;
    const pool = usable.filter((t) => !taken.has(t.id));
    // A filament the user registered must match material first; a bare colour
    // (type is only a guess) is matched by colour alone and takes the tray's material.
    const sameType = s.filamentId ? pool.filter((t) => t.type.toUpperCase() === s.type.toUpperCase()) : [];
    const pick = exact ?? nearestByColor(s.color, sameType.length ? sameType : pool);
    if (pick) taken.add(pick.id);
    return pick?.id ?? null;
  });
}

/**
 * What will really be loaded: when a tray is chosen its colour and material
 * replace the guess made from the painted colour.
 */
export function effectiveSlots(slots: Slot[], pick: (number | null)[], trays: Tray[]): Slot[] {
  return slots.map((s, i) => {
    const t = trays.find((x) => x.id === pick[i]);
    if (!t || t.empty) return s;
    return { ...s, color: t.color ?? s.color, type: t.type || s.type, name: t.name || t.type || s.name };
  });
}

/** Slicer preset name for a filament, following what exists for this printer. */
export function presetFor(slot: Pick<Slot, 'type' | 'name'>, available: string[], suffix: string): string {
  const has = (n: string) => available.includes(`${n} ${suffix}`);
  const pick = (n: string) => `${n} ${suffix}`;
  const type = slot.type.toUpperCase();
  const tries = [`Bambu ${slot.name}`, `Bambu ${type} Basic`, `Bambu ${type}`, `Generic ${type}`];
  for (const t of tries) if (has(t)) return pick(t);
  const starts = available.find((a) => a.startsWith(`Bambu ${type}`) || a.startsWith(`Generic ${type}`));
  return starts ?? available.find((a) => a.startsWith('Generic PLA')) ?? available[0];
}

export interface BuiltJob {
  objects: { name: string; filament: number; stl: ArrayBuffer }[];
  slots: Slot[];
  warnings: string[];
  /** Footprint of every object on the bed (mm). */
  boxes: { x0: number; y0: number; x1: number; y1: number }[];
  tower: { x: number; y: number } | null;
}

export interface Bed {
  width: number;
  depth: number;
  maxHeight: number;
}

const TOWER = 40; // prime tower footprint plus margin, mm

/** Free corner of the bed for the prime tower (needed when printing 2+ filaments). */
export function pickTowerSpot(boxes: BuiltJob['boxes'], bed: Bed) {
  const m = 8;
  const candidates = [
    { x: bed.width - TOWER - m, y: m },
    { x: m, y: m },
    { x: m, y: bed.depth - TOWER - m },
    { x: bed.width - TOWER - m, y: bed.depth - TOWER - m },
  ];
  const gap = (c: { x: number; y: number }) =>
    boxes.reduce((min, b) => {
      const dx = Math.max(b.x0 - (c.x + TOWER), c.x - b.x1, 0);
      const dy = Math.max(b.y0 - (c.y + TOWER), c.y - b.y1, 0);
      return Math.min(min, Math.hypot(dx, dy));
    }, Infinity);
  return candidates.map((c) => ({ c, g: gap(c) })).sort((a, b) => b.g - a.g)[0];
}

/** A printable body: one object, or one colour of a group. `solid` is in world space and owned by the caller. */
interface Body extends Paintable {
  name: string;
  solid: Manifold;
}

function bodiesOf(node: SceneNode, assets: DesignDoc['assets']): Body[] {
  if (node.kind !== 'group') {
    const solid = worldSolid(node, assets);
    return solid ? [{ name: node.name, color: node.color, filament: node.filament, solid }] : [];
  }
  const m = nodeMatrix(node).elements as unknown as Parameters<Manifold['transform']>[0];
  const pieces = piecesOf(node, assets);
  return pieces.map((p, i) => ({
    name: pieces.length > 1 ? `${node.name} · cor ${i + 1}` : node.name,
    color: p.color,
    filament: p.filament,
    solid: p.solid.transform(m),
  }));
}

/**
 * A colour that hangs in the air (letters on a base, a top coat...) cannot be printed as its own
 * object: the slicer drops it to the bed, over the part below. Instead it gets a column down to the
 * bed, taking that volume from the bodies underneath. The total volume does not change; only the
 * colour of the column does.
 */
/**
 * Bodies of the same colour that touch are one object (the letters of a logo cut from a base that
 * share its colour). Without this each piece would be sliced as an object of its own.
 */
function mergeTouching(bodies: Body[], slotOf: number[]): Body[] {
  const boxes = bodies.map((b) => b.solid.boundingBox());
  const parent = bodies.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const eps = 0.01;
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      if (slotOf[i] !== slotOf[j]) continue;
      const a = boxes[i], b = boxes[j];
      if (a.min[0] > b.max[0] + eps || a.max[0] < b.min[0] - eps || a.min[1] > b.max[1] + eps || a.max[1] < b.min[1] - eps || a.min[2] > b.max[2] + eps || a.max[2] < b.min[2] - eps) continue;
      parent[find(j)] = find(i);
    }
  }
  const groups = new Map<number, number[]>();
  bodies.forEach((_, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), i]));
  const out: Body[] = [];
  for (const members of groups.values()) {
    const first = bodies[members[0]];
    if (members.length === 1) {
      out.push(first);
      continue;
    }
    const solid = unionSolids(members.map((m) => bodies[m].solid));
    members.forEach((m) => bodies[m].solid.delete());
    out.push({ ...first, solid });
  }
  return out;
}

function groundBodies(bodies: Body[]) {
  const floor = (b: Body) => b.solid.boundingBox().min[2];
  const order = bodies.map((_, i) => i).sort((a, b) => floor(bodies[a]) - floor(bodies[b]));
  for (const i of order) {
    const hang = bodies[i];
    const z0 = floor(hang);
    if (z0 <= 0.05) continue;
    const shadow = hang.solid.project();
    const prism = shadow.extrude(z0);
    shadow.delete();
    const box = prism.boundingBox();
    // Everything of the other bodies that lies under this one. Only what touches the column is tested:
    // with many loose pieces (every letter of a logo) comparing all against all would take minutes.
    let column: Manifold | null = null;
    bodies.forEach((other, j) => {
      if (j === i) return;
      const ob = other.solid.boundingBox();
      if (ob.min[0] > box.max[0] || ob.max[0] < box.min[0] || ob.min[1] > box.max[1] || ob.max[1] < box.min[1] || ob.min[2] > box.max[2]) return;
      const part = other.solid.intersect(prism);
      if (part.isEmpty()) return part.delete();
      const rest = other.solid.subtract(part);
      other.solid.delete();
      other.solid = rest;
      const joined: Manifold = column ? column.add(part) : part;
      if (column) column.delete();
      if (joined !== part) part.delete();
      column = joined;
    });
    prism.delete();
    if (!column) continue;
    const grown = hang.solid.add(column);
    hang.solid.delete();
    (column as Manifold).delete();
    hang.solid = grown;
  }
  // A body that was entirely under a column has nothing left to print.
  for (let k = bodies.length - 1; k >= 0; k--) {
    if (!bodies[k].solid.isEmpty()) continue;
    bodies[k].solid.delete();
    bodies.splice(k, 1);
  }
}

export function buildJob(doc: DesignDoc, bed: Bed, colorMap: ColorMap = {}): BuiltJob {
  const warnings: string[] = [];
  const nodes = doc.nodes.filter((n) => !n.hidden && !n.hole);
  if (doc.nodes.some((n) => n.hole && !n.hidden)) warnings.push('Furos soltos não são impressos. Agrupe o furo com o objeto para recortá-lo.');

  const bodies: Body[] = [];
  for (const node of nodes) {
    const list = bodiesOf(node, doc.assets);
    if (!list.length) warnings.push(`“${node.name}” não é um sólido válido e ficou de fora.`);
    bodies.push(...list);
  }

  const merged = mergeTouching(bodies, planSlots(bodies, colorMap).entries.map((e) => e.slot));
  groundBodies(merged);
  const { slots, entries } = planSlots(merged, colorMap);
  const objects: BuiltJob['objects'] = [];
  const boxes: BuiltJob['boxes'] = [];
  const used: number[] = [];

  for (const { item, slot } of entries) {
    // Workplane origin = centre of the bed.
    const placed = item.solid.translate(bed.width / 2, bed.depth / 2, 0);
    item.solid.delete();
    const mesh = placed.getMesh();
    placed.delete();
    const p = mesh.vertProperties;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < p.length; i += mesh.numProp) {
      x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]);
      y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]);
      z0 = Math.min(z0, p[i + 2]); z1 = Math.max(z1, p[i + 2]);
    }
    if (z0 > 0.05) warnings.push(`“${item.name}” está flutuando ${z0.toFixed(1)} mm acima da mesa (use “Soltar”, tecla D).`);
    if (z0 < -0.05) warnings.push(`“${item.name}” atravessa a mesa (${(-z0).toFixed(1)} mm abaixo).`);
    if (x0 < 0 || y0 < 0 || x1 > bed.width || y1 > bed.depth) warnings.push(`“${item.name}” passa dos limites da mesa (${bed.width}×${bed.depth} mm).`);
    if (z1 > bed.maxHeight) warnings.push(`“${item.name}” é mais alto que a impressora (${bed.maxHeight} mm).`);
    objects.push({ name: item.name, filament: slot, stl: meshToStl(mesh) });
    boxes.push({ x0, y0, x1, y1 });
    used.push(slot);
  }

  // Drop slots that ended up without objects and renumber.
  const keep = [...new Set(used)].sort((a, b) => a - b);
  const remap = new Map(keep.map((old, i) => [old, i]));
  const finalSlots = keep.map((old) => ({ ...slots[old], count: used.filter((u) => u === old).length }));
  objects.forEach((o) => (o.filament = remap.get(o.filament)!));

  if (finalSlots.length > 1) {
    const { c, g } = pickTowerSpot(boxes, bed);
    if (g < 2) warnings.push('Não sobrou espaço livre na mesa para a torre de limpeza. Afaste as peças.');
    return { objects, slots: finalSlots, warnings, boxes, tower: c };
  }
  return { objects, slots: finalSlots, warnings, boxes, tower: null };
}

export const fmtDuration = (sec?: number) => {
  if (sec === undefined || !isFinite(sec)) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
};

export { colorDistance };
