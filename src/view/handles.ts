import * as THREE from 'three';
import { store } from '../core/store';
import { decompose, localBox, nodeMatrix, resizedTransform, worldBounds } from '../core/geometry';
import { settings } from '../core/settings';
import type { SceneNode, Vec3 } from '../core/types';

/**
 * Resize handles drawn on the selected object: white dots on the base, in the middle of each side,
 * change one dimension; dark dots on the base corners change width and depth together; the white
 * dot above the object changes height. Shift keeps proportions.
 * The opposite side stays in place while dragging.
 */

type Axis = 0 | 1 | 2;
interface HandleDef {
  /** Local axes this handle changes, with the direction it pulls (+1/-1). */
  axes: [Axis, 1 | -1][];
  kind: 'side' | 'corner' | 'top';
}

const DEFS: HandleDef[] = [
  { kind: 'side', axes: [[0, 1]] },
  { kind: 'side', axes: [[0, -1]] },
  { kind: 'side', axes: [[1, 1]] },
  { kind: 'side', axes: [[1, -1]] },
  { kind: 'corner', axes: [[0, 1], [1, 1]] },
  { kind: 'corner', axes: [[0, -1], [1, 1]] },
  { kind: 'corner', axes: [[0, 1], [1, -1]] },
  { kind: 'corner', axes: [[0, -1], [1, -1]] },
  { kind: 'top', axes: [[2, 1]] },
];

export interface HandleHost {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  dom: HTMLElement;
  orbit: { enabled: boolean };
  /** Live preview of a node transform without touching the store. */
  preview(id: string, t: Pick<SceneNode, 'position' | 'rotation' | 'scale'>): void;
  /** Live preview of new matrices for several nodes (several objects resized together). */
  previewMatrix(ms: Map<string, THREE.Matrix4>, box: THREE.Box3 | null): void;
  /** Gizmo is being dragged (handles hide meanwhile). */
  gizmoBusy(): boolean;
  setGizmoVisible(v: boolean): void;
  onSizeChange?: (size: Vec3) => void;
}

/** Frame of a multi-selection: the handles sit on its world box. */
const WORLD_FRAME = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } as Pick<SceneNode, 'position' | 'rotation' | 'scale'>;

interface DragState {
  node: SceneNode;
  /** Several objects: matrices at the start, and the ones to commit. */
  bases?: Map<string, THREE.Matrix4>;
  lastMs?: Map<string, THREE.Matrix4>;
  def: HandleDef;
  start: THREE.Vector3;
  box: THREE.Box3;
  size0: Vec3;
  R: THREE.Matrix4;
  last?: Pick<SceneNode, 'position' | 'rotation' | 'scale'>;
}

export class ResizeHandles {
  private group = new THREE.Group();
  private meshes: THREE.Mesh[] = [];
  private raycaster = new THREE.Raycaster();
  private hovered: THREE.Mesh | null = null;
  private drag: DragState | null = null;
  private target: SceneNode | null = null;
  /** Selection of several objects, resized together (one factor for all). */
  private crowd: SceneNode[] | null = null;
  private mats: Record<HandleDef['kind'] | 'hover', THREE.MeshBasicMaterial>;
  private ring: THREE.MeshBasicMaterial;

  constructor(private host: HandleHost) {
    const dot = new THREE.SphereGeometry(0.5, 24, 16);
    const base = { depthTest: false, transparent: true };
    this.mats = {
      side: new THREE.MeshBasicMaterial({ ...base, color: 0xffffff }),
      corner: new THREE.MeshBasicMaterial({ ...base, color: 0x1d2130 }),
      top: new THREE.MeshBasicMaterial({ ...base, color: 0xffffff }),
      hover: new THREE.MeshBasicMaterial({ ...base, color: 0x2fb52c }),
    };
    this.ring = new THREE.MeshBasicMaterial({ ...base, color: 0x2fb52c, side: THREE.BackSide });
    for (const def of DEFS) {
      const geom = dot;
      const m = new THREE.Mesh(geom, this.mats[def.kind]);
      m.userData.def = def;
      m.renderOrder = 1001;
      // Coloured rim: a slightly larger back-facing copy behind the dot.
      const rim = new THREE.Mesh(geom, this.ring);
      rim.scale.setScalar(1.35);
      rim.renderOrder = 1000;
      rim.raycast = () => {};
      m.add(rim);
      this.meshes.push(m);
      this.group.add(m);
    }
    this.group.visible = false;
    host.scene.add(this.group);

    // Capture phase: runs before OrbitControls/TransformControls see the event.
    host.dom.addEventListener('pointerdown', (e) => this.onDown(e), { capture: true });
    host.dom.addEventListener('pointermove', (e) => this.onMove(e));
    host.dom.addEventListener('pointerup', (e) => this.onUp(e), { capture: true });
  }

  setAccent(color: string) {
    this.mats.hover.color.set(color);
    this.ring.color.set(color);
  }

  /** Show handles for a single unlocked selection; hide otherwise. */
  sync() {
    if (this.drag) return;
    const sel = store.selected.filter((n) => !n.hidden);
    const free = sel.length > 0 && sel.every((n) => !n.locked);
    this.target = free && sel.length === 1 ? sel[0] : null;
    this.crowd = free && sel.length > 1 ? sel : null;
    if (this.target) return this.place(this.target, localBox(this.target, store.doc.assets));
    if (this.crowd) return this.place(WORLD_FRAME, this.crowdBox(this.crowd));
    this.group.visible = false;
  }

  private crowdBox(nodes: SceneNode[]) {
    const box = new THREE.Box3();
    for (const n of nodes) {
      const b = worldBounds(n, store.doc.assets);
      if (b) box.union(b);
    }
    return box.isEmpty() ? null : box;
  }

  get active() {
    return !!this.drag;
  }

  hide() {
    this.group.visible = false;
  }

  private place(n: Pick<SceneNode, 'position' | 'rotation' | 'scale'>, box: THREE.Box3 | null) {
    if (!box) {
      this.group.visible = false;
      return;
    }
    const m = nodeMatrix(n);
    const c = box.getCenter(new THREE.Vector3());
    for (const mesh of this.meshes) {
      const def = mesh.userData.def as HandleDef;
      const p = new THREE.Vector3(c.x, c.y, box.min.z);
      for (const [a, dir] of def.axes) p.setComponent(a, dir > 0 ? box.max.getComponent(a) : box.min.getComponent(a));
      if (def.kind === 'top') p.z = box.max.z;
      mesh.position.copy(p.applyMatrix4(m));
      if (def.kind === 'top') mesh.position.add(this.axisWorld(n, 2).multiplyScalar(this.screenScale(mesh.position) * 1.6));
      mesh.quaternion.setFromRotationMatrix(this.rotationOf(n));
    }
    this.group.visible = !this.host.gizmoBusy();
  }

  /** Keep handles a constant size on screen. */
  update() {
    if (!this.group.visible) return;
    for (const m of this.meshes) m.scale.setScalar(this.screenScale(m.position) * (m === this.hovered ? 1.3 : 1));
  }

  private screenScale(p: THREE.Vector3) {
    return Math.max(0.15, p.distanceTo(this.host.camera.position) * 0.0032);
  }

  private rotationOf(n: Pick<SceneNode, 'rotation'>) {
    return new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...(n.rotation.map(THREE.MathUtils.degToRad) as Vec3), 'XYZ'));
  }

  private axisWorld(n: Pick<SceneNode, 'rotation'>, a: Axis) {
    return new THREE.Vector3().setComponent(a, 1).applyMatrix4(this.rotationOf(n)).normalize();
  }

  private ray(e: PointerEvent) {
    const r = this.host.dom.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.host.camera);
    return this.raycaster.ray;
  }

  private hit(e: PointerEvent): THREE.Mesh | null {
    if (!this.group.visible) return null;
    // Pick by distance on screen, so the small dots are easy to grab.
    const r = this.host.dom.getBoundingClientRect();
    const v = new THREE.Vector3();
    let best: THREE.Mesh | null = null;
    let bestD = 14;
    for (const m of this.meshes) {
      m.getWorldPosition(v).project(this.host.camera);
      if (v.z > 1) continue;
      const d = Math.hypot(((v.x + 1) / 2) * r.width + r.left - e.clientX, ((1 - v.y) / 2) * r.height + r.top - e.clientY);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    return best;
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0 || (!this.target && !this.crowd)) return;
    const h = this.hit(e);
    if (!h) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    this.host.dom.setPointerCapture(e.pointerId);
    const crowd = this.crowd;
    const node = structuredClone(this.target ?? { ...WORLD_FRAME, id: '', name: '', kind: 'group', params: {}, color: '', hole: false } as SceneNode);
    const box = (crowd ? this.crowdBox(crowd) : localBox(node, store.doc.assets))!.clone();
    const s = box.getSize(new THREE.Vector3());
    this.drag = {
      node,
      def: h.userData.def,
      start: h.position.clone(),
      box,
      size0: [s.x * Math.abs(node.scale[0]), s.y * Math.abs(node.scale[1]), s.z * Math.abs(node.scale[2])],
      R: this.rotationOf(node),
      bases: crowd ? new Map(crowd.map((n) => [n.id, nodeMatrix(n)])) : undefined,
    };
    if (this.drag.def.kind === 'top') this.drag.start.sub(this.axisWorld(node, 2).multiplyScalar(this.screenScale(h.position) * 1.6));
    this.host.orbit.enabled = false;
    this.host.setGizmoVisible(false);
  }

  private onMove(e: PointerEvent) {
    if (!this.drag) {
      if (e.buttons) return;
      const h = this.hit(e);
      if (h !== this.hovered) {
        if (this.hovered) this.hovered.material = this.mats[(this.hovered.userData.def as HandleDef).kind];
        this.hovered = h;
        if (h) h.material = this.mats.hover;
        this.host.dom.style.cursor = h ? 'grab' : '';
      }
      return;
    }
    const d = this.drag;
    const ray = this.ray(e);
    const amounts = new Map<Axis, number>();
    if (d.def.kind === 'corner') {
      const normal = new THREE.Vector3(0, 0, 1).applyMatrix4(d.R);
      const p = new THREE.Vector3();
      if (!ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(normal, d.start), p)) return;
      const v = p.sub(d.start);
      for (const [a, dir] of d.def.axes) amounts.set(a, v.dot(new THREE.Vector3().setComponent(a, dir).applyMatrix4(d.R)));
    } else {
      const [a, dir] = d.def.axes[0];
      const dirW = new THREE.Vector3().setComponent(a, dir).applyMatrix4(d.R).normalize();
      amounts.set(a, closestOnLine(ray, d.start, dirW));
    }

    const snap = settings.snap || 0;
    const k: Vec3 = [1, 1, 1];
    for (const [a, t] of amounts) {
      let size = d.size0[a] + t;
      if (snap) size = Math.round(size / snap) * snap;
      k[a] = Math.max(0.1, size) / d.size0[a];
    }
    if (e.shiftKey || d.bases) {
      // Proportional (always, for several objects): follow the axis that moved the most.
      const f = [...amounts.keys()].map((a) => k[a]).reduce((m, v) => (Math.abs(v - 1) > Math.abs(m - 1) ? v : m), 1);
      k[0] = k[1] = k[2] = f;
    }

    // Fixed point: opposite side of each pulled axis; centre (x/y) or base (z) otherwise.
    const b = d.box;
    const c = b.getCenter(new THREE.Vector3());
    const fixed = new THREE.Vector3(c.x, c.y, b.min.z);
    for (const [a, dir] of d.def.axes) fixed.setComponent(a, dir > 0 ? b.min.getComponent(a) : b.max.getComponent(a));
    if (d.bases) {
      const f = k[0];
      const S = new THREE.Matrix4()
        .makeTranslation(fixed.x, fixed.y, fixed.z)
        .multiply(new THREE.Matrix4().makeScale(f, f, f))
        .multiply(new THREE.Matrix4().makeTranslation(-fixed.x, -fixed.y, -fixed.z));
      d.lastMs = new Map([...d.bases].map(([id, m]) => [id, S.clone().multiply(m)]));
      const grown = new THREE.Box3(
        b.min.clone().sub(fixed).multiplyScalar(f).add(fixed),
        b.max.clone().sub(fixed).multiplyScalar(f).add(fixed),
      );
      this.host.previewMatrix(d.lastMs, grown);
      this.place(WORLD_FRAME, grown);
      this.group.visible = true;
      this.host.onSizeChange?.([d.size0[0] * f, d.size0[1] * f, d.size0[2] * f]);
      this.host.dom.style.cursor = 'grabbing';
      return;
    }
    const t = resizedTransform(d.node, k, fixed);
    d.last = t;
    this.host.preview(d.node.id, t);
    this.place({ ...d.node, ...t }, localBox(d.node, store.doc.assets));
    this.group.visible = true;
    this.host.onSizeChange?.([d.size0[0] * k[0], d.size0[1] * k[1], d.size0[2] * k[2]]);
    this.host.dom.style.cursor = 'grabbing';
  }

  private onUp(e: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    e.stopImmediatePropagation();
    this.drag = null;
    this.host.orbit.enabled = true;
    this.host.setGizmoVisible(true);
    this.host.dom.style.cursor = '';
    if (d.lastMs) {
      const ms = d.lastMs;
      store.commit((doc) => {
        for (const n of doc.nodes) {
          const m = ms.get(n.id);
          if (m) Object.assign(n, decompose(m));
        }
      });
    } else if (d.last) {
      const t = d.last;
      store.commit((doc) => {
        const n = doc.nodes.find((x) => x.id === d.node.id);
        if (n) Object.assign(n, t);
      });
    } else this.sync();
  }
}

/** Distance along a line (point + unit dir) closest to a ray. */
function closestOnLine(ray: THREE.Ray, p: THREE.Vector3, d: THREE.Vector3) {
  const w = p.clone().sub(ray.origin);
  const b = d.dot(ray.direction);
  const denom = 1 - b * b;
  if (Math.abs(denom) < 1e-6) return 0;
  return (b * w.dot(ray.direction) - w.dot(d)) / denom;
}
