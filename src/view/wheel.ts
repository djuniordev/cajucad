import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { store } from '../core/store';
import { decompose, nodeMatrix } from '../core/geometry';
import { settings } from '../core/settings';
import type { SceneNode } from '../core/types';

/**
 * Turning wheel: a ring on the table around the selected objects. Drag it to turn them around the
 * vertical axis (Shift snaps to 15°, or to the angle set in the snap bar).
 */

export interface WheelHost {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  dom: HTMLElement;
  orbit: { enabled: boolean };
  /** Show new matrices for some nodes without touching the store. */
  previewMatrix(ms: Map<string, THREE.Matrix4>, box: THREE.Box3 | null): void;
  /** Another drag (gizmo, move, resize) is going on. */
  busy(): boolean;
  /** Put the previews back after a cancelled drag. */
  restore(): void;
  setGizmoVisible(v: boolean): void;
}

interface Drag {
  bases: Map<string, THREE.Matrix4>;
  a0: number;
  ms?: Map<string, THREE.Matrix4>;
}

export class TurnWheel {
  private ring: THREE.Mesh;
  private mat = new THREE.MeshBasicMaterial({ depthTest: false, transparent: true, opacity: 0.6, side: THREE.DoubleSide });
  private pill: CSS2DObject;
  private raycaster = new THREE.Raycaster();
  private center = new THREE.Vector3();
  private radius = 10;
  private builtW = 0;
  private builtR = 0;
  private shown = false;
  private hovered = false;
  private drag: Drag | null = null;
  private nodes: SceneNode[] = [];

  constructor(private host: WheelHost) {
    this.ring = new THREE.Mesh(new THREE.BufferGeometry(), this.mat);
    this.ring.renderOrder = 998;
    this.ring.visible = false;
    this.ring.raycast = () => {};
    host.scene.add(this.ring);

    const el = document.createElement('div');
    el.className = 'dim-pill';
    el.style.pointerEvents = 'none';
    this.pill = new CSS2DObject(el);
    this.pill.visible = false;
    host.scene.add(this.pill);

    host.dom.addEventListener('pointerdown', (e) => this.onDown(e), { capture: true });
    host.dom.addEventListener('pointermove', (e) => this.onMove(e));
    host.dom.addEventListener('pointerup', (e) => this.onUp(e, false), { capture: true });
    host.dom.addEventListener('pointercancel', (e) => this.onUp(e, true), { capture: true });
  }

  get active() {
    return !!this.drag;
  }

  setColor(color: string) {
    this.mat.color.set(color);
  }

  /** Place the wheel around `box` for these nodes, or hide it when `nodes` is empty. */
  show(box: THREE.Box3 | null, nodes: SceneNode[]) {
    if (this.drag) return;
    this.nodes = nodes;
    if (!box || !nodes.length) return this.hide();
    const size = box.getSize(new THREE.Vector3());
    this.center.set((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, box.min.z + 0.05);
    this.radius = Math.hypot(size.x, size.y) / 2 + 7;
    this.shown = true;
    this.ring.visible = !this.host.busy();
  }

  hide() {
    this.shown = false;
    this.ring.visible = false;
    this.pill.visible = false;
  }

  /** Called every frame: the ring keeps a constant thickness on screen. */
  update() {
    if (!this.shown) return;
    this.ring.visible = !!this.drag || !this.host.busy();
    if (!this.ring.visible) return;
    const w = this.thickness();
    if (Math.abs(w - this.builtW) > this.builtW * 0.05 || Math.abs(this.radius - this.builtR) > 0.01) {
      this.ring.geometry.dispose();
      this.ring.geometry = new THREE.RingGeometry(this.radius - w, this.radius + w, 96);
      this.builtW = w;
      this.builtR = this.radius;
    }
    this.ring.position.copy(this.center);
    this.mat.opacity = this.drag || this.hovered ? 0.95 : 0.55;
  }

  private thickness() {
    const d = this.center.distanceTo(this.host.camera.position);
    return Math.max(0.35, d * 0.0042) * (this.drag || this.hovered ? 1.5 : 1);
  }

  private ray(e: PointerEvent) {
    const r = this.host.dom.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.host.camera);
    return this.raycaster.ray;
  }

  /** Point of the table under the pointer, relative to the wheel centre. */
  private onTable(e: PointerEvent) {
    const p = new THREE.Vector3();
    if (!this.ray(e).intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -this.center.z), p)) return null;
    return p.sub(this.center);
  }

  private hit(e: PointerEvent) {
    if (!this.shown || !this.ring.visible) return false;
    const p = this.onTable(e);
    if (!p) return false;
    const tol = Math.max(this.thickness() * 2.4, 2.5);
    return Math.abs(Math.hypot(p.x, p.y) - this.radius) < tol;
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0 || this.drag || !this.hit(e)) return;
    const nodes = this.nodes.filter((n) => !n.locked && !n.hidden);
    if (!nodes.length) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    const p = this.onTable(e)!;
    this.host.dom.setPointerCapture(e.pointerId);
    this.drag = { bases: new Map(nodes.map((n) => [n.id, nodeMatrix(n)])), a0: Math.atan2(p.y, p.x) };
    this.host.orbit.enabled = false;
    this.host.setGizmoVisible(false);
    this.host.dom.style.cursor = 'grabbing';
  }

  private onMove(e: PointerEvent) {
    const d = this.drag;
    if (!d) {
      if (e.buttons) return;
      const h = this.hit(e);
      if (h !== this.hovered) {
        this.hovered = h;
        this.host.dom.style.cursor = h ? 'grab' : '';
      }
      return;
    }
    const p = this.onTable(e);
    if (!p) return;
    let a = Math.atan2(p.y, p.x) - d.a0;
    a = Math.atan2(Math.sin(a), Math.cos(a)); // shortest way round
    const step = e.shiftKey ? 15 : settings.snapAngle || 0;
    if (step) a = THREE.MathUtils.degToRad(Math.round(THREE.MathUtils.radToDeg(a) / step) * step);
    const c = this.center;
    const R = new THREE.Matrix4()
      .makeTranslation(c.x, c.y, 0)
      .multiply(new THREE.Matrix4().makeRotationZ(a))
      .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, 0));
    d.ms = new Map([...d.bases].map(([id, m]) => [id, R.clone().multiply(m)]));
    this.host.previewMatrix(d.ms, null);
    const deg = Math.round(THREE.MathUtils.radToDeg(a) * 10) / 10;
    this.pill.element.textContent = `${deg}°`;
    this.pill.position.set(c.x + this.radius * Math.cos(d.a0 + a), c.y + this.radius * Math.sin(d.a0 + a), c.z);
    this.pill.visible = true;
  }

  private onUp(e: PointerEvent, cancelled: boolean) {
    const d = this.drag;
    if (!d) return;
    e.stopImmediatePropagation();
    this.drag = null;
    this.hovered = false;
    this.pill.visible = false;
    this.host.orbit.enabled = true;
    this.host.setGizmoVisible(true);
    this.host.dom.style.cursor = '';
    if (this.host.dom.hasPointerCapture(e.pointerId)) this.host.dom.releasePointerCapture(e.pointerId);
    const ms = d.ms;
    if (cancelled || !ms) return this.host.restore();
    store.commit((doc) => {
      for (const n of doc.nodes) {
        const m = ms.get(n.id);
        if (m) Object.assign(n, decompose(m));
      }
    });
  }
}
