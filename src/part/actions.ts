import { store, uid } from '../core/store';
import { createNode } from '../core/shapes';
import type { SceneNode, Vec3 } from '../core/types';
import { openPartEditor } from './editor';
import type { PartMesh } from './kernel';
import { emptyPart, parsePart, type PartDef } from './model';

/** A scene node that carries a parametric part history. */
export const isPart = (n: SceneNode | undefined) => !!n && n.kind === 'mesh' && !!parsePart(n.params.part);

/** Open the part workspace for a new part; it lands in the scene at `at` when finished. */
export function newPart(at: Vec3 = [0, 0, 0]) {
  const count = store.doc.nodes.filter(isPart).length + 1;
  const name = `Peça ${count}`;
  openPartEditor({
    title: name,
    part: emptyPart(),
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
        n.params.asset = asset;
        n.params.part = JSON.stringify(next);
      });
    },
  });
}

const toAsset = (m: PartMesh) => ({ positions: m.positions, indices: m.indices });

function findIn(nodes: SceneNode[], id: string): SceneNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const c = n.children && findIn(n.children, id);
    if (c) return c;
  }
}
