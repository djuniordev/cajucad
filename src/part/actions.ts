import { store, uid } from '../core/store';
import { createNode } from '../core/shapes';
import type { SceneNode, Vec3 } from '../core/types';
import { openPartEditor } from './editor';
import type { PartMesh } from './kernel';
import { emptyPart, parsePart, type PartDef } from './model';

/** A scene node that carries a parametric part history. */
export const isPart = (n: SceneNode | undefined) => !!n && n.kind === 'mesh' && !!parsePart(n.params.part);

/** Open the part workspace for a new part; it lands in the scene at `at` when finished. */
export function newPart(at: Vec3 = [0, 0, 0], startSketch?: string) {
  const count = store.doc.nodes.filter(isPart).length + 1;
  const name = `Peça ${count}`;
  openPartEditor({
    title: name,
    part: emptyPart(),
    startSketch,
    onDone: (part, mesh) => {
      const asset = uid();
      // Rest the part on the workplane even when it was modelled below it.
      let minZ = Infinity;
      for (let i = 2; i < mesh.positions.length; i += 3) minZ = Math.min(minZ, mesh.positions[i]);
      const node = createNode('mesh', { name, position: [at[0], at[1], at[2] - minZ], params: { asset, part: JSON.stringify(part) } });
      store.commit((doc) => {
        doc.assets[asset] = toAsset(mesh);
        doc.nodes.push(node);
      });
      store.select([node.id]);
    },
  });
}

/** Re-open a part's history; finishing replaces its geometry as one undo step. */
export function editPart(id: string) {
  const node = store.find(id);
  const part = node && parsePart(node.params.part);
  if (!node || !part) return;
  openPartEditor({
    title: node.name,
    part,
    onDone: (next: PartDef, mesh) => {
      const asset = uid();
      store.commit((doc) => {
        const n = findIn(doc.nodes, id);
        if (!n) return;
        doc.assets[asset] = toAsset(mesh);
        // Linked copies of a component all take the new geometry.
        const comp = n.params.component;
        for (const x of comp ? allNodes(doc.nodes).filter((m) => m.params.component === comp) : [n]) {
          x.params.asset = asset;
          x.params.part = JSON.stringify(next);
        }
      });
    },
  });
}

/** A copy of a part that stays linked to it: editing any copy changes all of them. */
export function insertLinkedCopy(id: string) {
  const src = store.find(id);
  if (!src || !isPart(src)) return;
  const comp = String(src.params.component || uid());
  const copy = structuredClone(src);
  copy.id = uid();
  copy.params.component = comp;
  copy.position = [src.position[0] + 10, src.position[1] + 10, src.position[2]];
  const base = src.name.replace(/\s*\(\d+\)$/, '');
  const count = allNodes(store.doc.nodes).filter((n) => n.params.component === comp).length || 1;
  copy.name = `${base} (${count + 1})`;
  store.commit((doc) => {
    const s = doc.nodes.find((n) => n.id === id);
    if (s) s.params.component = comp;
    doc.nodes.push(copy);
  });
  store.select([copy.id]);
}

/** How many linked copies share this part's component (1 = not linked). */
export function componentCount(n: SceneNode) {
  const comp = n.params.component;
  return comp ? allNodes(store.doc.nodes).filter((x) => x.params.component === comp).length : 1;
}

/** Make this copy independent again. */
export function unlinkCopy(id: string) {
  store.commit((doc) => {
    const n = findIn(doc.nodes, id);
    if (n) delete n.params.component;
    // A component left with a single copy is just a part.
    const left = new Map<string, SceneNode[]>();
    for (const x of allNodes(doc.nodes)) if (x.params.component) left.set(String(x.params.component), [...(left.get(String(x.params.component)) ?? []), x]);
    for (const list of left.values()) if (list.length === 1) delete list[0].params.component;
  });
}

function allNodes(nodes: SceneNode[]): SceneNode[] {
  return nodes.flatMap((n) => [n, ...(n.children ? allNodes(n.children) : [])]);
}

const toAsset = (m: PartMesh) => ({ positions: m.positions, indices: m.indices });

function findIn(nodes: SceneNode[], id: string): SceneNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const c = n.children && findIn(n.children, id);
    if (c) return c;
  }
}
