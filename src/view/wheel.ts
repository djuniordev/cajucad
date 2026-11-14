import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { store } from '../core/store';
import { decompose, nodeMatrix } from '../core/geometry';
import { settings } from '../core/settings';
import type { SceneNode } from '../core/types';

/**
 * Turning handles: three small markers around the selection (flat, front and side). Drag one to turn the
 * objects around that axis (Shift snaps to 15°, or to the angle set in the snap bar).
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
  axis: number;
  bases: Map<string, THREE.Matrix4>;
  a0: number;
  ms?: Map<string, THREE.Matrix4>;
}

// Ring i turns around world axis i; it lies in the plane spanned by U[i] and V[i].
const U = [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)];
const V = [new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)];
const AXIS = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];

const SPOT = Math.PI / 5;

/** A small curved double arrow lying in the ring's plane: radial = +x, tangent = +y. */
function arrowGeometry() {
  const rho = 2.2, w = 0.13, a = 0.62, h = 0.5, hw = 0.5;
  const pts: number[] = [];
  const P = (th: number, r: number) => [-rho + r * Math.cos(th), r * Math.sin(th), 0];
  const tri = (...v: number[][]) => v.forEach((q) => pts.push(...q));
  const n = 12;
  for (let k = 0; k < n; k++) {
    const t0 = -a + (2 * a * k) / n, t1 = -a + (2 * a * (k + 1)) / n;
    tri(P(t0, rho - w), P(t1, rho - w), P(t1, rho + w));
    tri(P(t0, rho - w), P(t1, rho + w), P(t0, rho + w));
  }
  for (const sgn of [1, -1]) {
    tri(P(sgn * a, rho - hw), P(sgn * a, rho + hw), P(sgn * (a + h), rho));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}

export class TurnWheel {
  private rings: THREE.Mesh[] = [];
  private mat = new THREE.MeshBasicMaterial({ depthTest: false, transparent: true, opacity: 0.4, side: THREE.DoubleSide });
  private pill: CSS2DObject;
  private raycaster = new THREE.Raycaster();
  private center = new THREE.Vector3();
  private radius = 10;
  private shown = false;
  private hovered = -1;
  private drag: Drag | null = null;
  private nodes: SceneNode[] = [];

  constructor(private host: WheelHost) {
    for (let i = 0; i < 3; i++) {
      const r = new THREE.Mesh(arrowGeometry(), this.mat);
      r.renderOrder = 998;
      r.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(
        U[i].clone().multiplyScalar(Math.cos(SPOT)).addScaledVector(V[i], Math.sin(SPOT)),
        V[i].clone().multiplyScalar(Math.cos(SPOT)).addScaledVector(U[i], -Math.sin(SPOT)),
        AXIS[i],
      ));
      r.visible = false;
      r.raycast = () => {};
      host.scene.add(r);
      this.rings.push(r);
    }

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

  /** Place the rings around `box` for these nodes, or hide them when `nodes` is empty. */
  show(box: THREE.Box3 | null, nodes: SceneNode[]) {
    if (this.drag) return;
    this.nodes = nodes;
    if (!box || !nodes.length) return this.hide();
    const size = box.getSize(new THREE.Vector3());
    box.getCenter(this.center);
    this.radius = size.length() / 2 + 1;
    this.shown = true;
    this.setVisible(!this.host.busy());
  }

  hide() {
    this.shown = false;
    this.setVisible(false);
    this.pill.visible = false;
  }

  private setVisible(v: boolean) {
    for (const r of this.rings) r.visible = v;
  }

  /** Where the handle of ring i sits: on the ring, off the axes so it stays clear of the resize dots. */
  private spot(i: number, out = new THREE.Vector3()) {
    const t = SPOT;
    return out.copy(this.center).addScaledVector(U[i], this.radius * Math.cos(t)).addScaledVector(V[i], this.radius * Math.sin(t));
  }

  private unit() {
    const d = this.center.distanceTo(this.host.camera.position);
    return Math.max(0.45, d * 0.0042);
  }

  /** Called every frame: the handles keep a small constant size on screen. */
  update() {
    if (!this.shown) return;
    const vis = !!this.drag || !this.host.busy();
    this.setVisible(vis);
    if (!vis) return;
    this.rings.forEach((r, i) => {
      this.spot(i, r.position);
      r.scale.setScalar(this.unit() * (this.drag || this.hovered === i ? 1.4 : 1));
      r.visible = !this.drag || this.drag.axis === i;
    });
    this.mat.opacity = this.drag || this.hovered >= 0 ? 0.95 : 0.6;
  }

  private ray(e: PointerEvent) {
    const r = this.host.dom.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.host.camera);
    return this.raycaster.ray;
  }

  /** Point of the plane of ring i under the pointer, relative to the centre. */
  private onPlane(e: PointerEvent, i: number) {
    const ray = this.ray(e);
    if (Math.abs(ray.direction.dot(AXIS[i])) < 0.12) return null; // plane seen edge-on
    const p = new THREE.Vector3();
    if (!ray.intersectPlane(new THREE.Plane(AXIS[i], -AXIS[i].dot(this.center)), p)) return null;
    return p.sub(this.center);
  }

  private angle(p: THREE.Vector3, i: number) {
    return Math.atan2(p.dot(V[i]), p.dot(U[i]));
  }

  /** Which handle is under the pointer (-1: none). */
  private hit(e: PointerEvent) {
    if (!this.shown || !this.rings[0].visible) return -1;
    const r = this.host.dom.getBoundingClientRect();
    const v = new THREE.Vector3();
    let best = -1;
    let bestD = 11;
    for (let i = 0; i < 3; i++) {
      this.spot(i, v).project(this.host.camera);
      if (v.z > 1) continue;
      const d = Math.hypot(((v.x + 1) / 2) * r.width + r.left - e.clientX, ((1 - v.y) / 2) * r.height + r.top - e.clientY);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0 || this.drag) return;
    const axis = this.hit(e);
    if (axis < 0) return;
    const nodes = this.nodes.filter((n) => !n.locked && !n.hidden);
    if (!nodes.length) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    const p = this.onPlane(e, axis)!;
    this.host.dom.setPointerCapture(e.pointerId);
    this.drag = { axis, bases: new Map(nodes.map((n) => [n.id, nodeMatrix(n)])), a0: this.angle(p, axis) };
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
        this.host.dom.style.cursor = h >= 0 ? 'grab' : '';
      }
      return;
    }
    const p = this.onPlane(e, d.axis);
    if (!p) return;
    let a = this.angle(p, d.axis) - d.a0;
    a = Math.atan2(Math.sin(a), Math.cos(a)); // shortest way round
    const step = e.shiftKey ? 15 : settings.snapAngle || 0;
    if (step) a = THREE.MathUtils.degToRad(Math.round(THREE.MathUtils.radToDeg(a) / step) * step);
    const c = this.center;
    const R = new THREE.Matrix4()
      .makeTranslation(c.x, c.y, c.z)
      .multiply(new THREE.Matrix4().makeRotationAxis(AXIS[d.axis], a))
      .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
    d.ms = new Map([...d.bases].map(([id, m]) => [id, R.clone().multiply(m)]));
    this.host.previewMatrix(d.ms, null);
    const deg = Math.round(THREE.MathUtils.radToDeg(a) * 10) / 10;
    this.pill.element.textContent = `${deg}°`;
    const t = this.angle(p, d.axis);
    this.pill.position.copy(c).addScaledVector(U[d.axis], this.radius * Math.cos(t)).addScaledVector(V[d.axis], this.radius * Math.sin(t));
    this.pill.visible = true;
  }

  private onUp(e: PointerEvent, cancelled: boolean) {
    const d = this.drag;
    if (!d) return;
    e.stopImmediatePropagation();
    this.drag = null;
    this.hovered = -1;
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
