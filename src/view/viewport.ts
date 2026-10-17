import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { store } from '../core/store';
import { colorSig, decompose, nodeMatrix, rawAssetGeometry, renderGeometry, renderPieces, shapeKey, worldBounds } from '../core/geometry';
import { ResizeHandles } from './handles';
import type { SceneNode, Vec3 } from '../core/types';
import { settings } from '../core/settings';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export type GizmoMode = 'translate' | 'rotate' | 'scale';

/** One coloured mesh of an object (a group has one per colour). */
interface ViewPart {
  mesh: THREE.Mesh;
  edges: THREE.LineSegments;
  color: string;
}

interface NodeView {
  key: string;
  style: string;
  root: THREE.Group;
  parts: ViewPart[];
}

const WORKPLANE = 240;

/** Theme-aware colours read from CSS variables. */
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly orbit: OrbitControls;
  readonly gizmo: TransformControls;
  private labels: CSS2DRenderer;
  private views = new Map<string, NodeView>();
  private pivot = new THREE.Object3D();
  private selBox: THREE.LineSegments;
  private dimLabels: CSS2DObject[] = [];
  private gridMat: THREE.ShaderMaterial;
  private raycaster = new THREE.Raycaster();
  private hovered: string | null = null;
  private dragStart: { pivot: THREE.Matrix4; nodes: Map<string, THREE.Matrix4> } | null = null;
  private anim: { from: [THREE.Vector3, THREE.Vector3]; to: [THREE.Vector3, THREE.Vector3]; t0: number } | null = null;
  private edgeCache = new WeakMap<THREE.BufferGeometry, THREE.EdgesGeometry>();
  private holeMat: THREE.MeshStandardMaterial;
  private handles: ResizeHandles;
  /** Rubber-band rectangle drawn while selecting with the left button. */
  private marquee: HTMLElement;
  /** Object being dragged along the workplane with the left button. */
  private moveDrag: { ids: string[]; base: Map<string, Vec3>; plane: THREE.Plane; start: THREE.Vector3; delta: THREE.Vector3 } | null = null;
  /** Called when the user types a size into an on-screen dimension (world axis, mm). */
  onDimensionEdit?: (axis: 0 | 1 | 2, mm: number) => void;
  onContextMenu?: (x: number, y: number) => void;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    host.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'labels-layer';
    host.appendChild(this.labels.domElement);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.5, 5000);
    this.camera.position.set(170, -210, 170);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;

    const hemi = new THREE.HemisphereLight(0xffffff, 0xb8c0d0, 1.1);
    hemi.position.set(0, 0, 1);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(120, -160, 300);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.radius = 6;
    sun.shadow.bias = -0.0004;
    const sc = sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = sc.bottom = -220;
    sc.right = sc.top = 220;
    sc.near = 10;
    sc.far = 900;
    this.scene.add(sun);

    this.gridMat = makeGridMaterial();
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(WORKPLANE * 2.2, WORKPLANE * 2.2), this.gridMat);
    plane.renderOrder = -1;
    plane.name = 'workplane';
    this.scene.add(plane);
    const catcher = new THREE.Mesh(new THREE.PlaneGeometry(WORKPLANE * 2, WORKPLANE * 2), new THREE.ShadowMaterial({ opacity: 0.12 }));
    catcher.position.z = 0.02;
    catcher.receiveShadow = true;
    this.scene.add(catcher);

    this.holeMat = new THREE.MeshStandardMaterial({
      color: 0x8a94a6,
      transparent: true,
      opacity: 0.32,
      roughness: 0.6,
      depthWrite: false,
    });

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.09;
    this.orbit.zoomToCursor = true;
    this.orbit.screenSpacePanning = true;
    this.orbit.maxDistance = 2500;
    // Same scheme as Tinkercad: right button orbits, middle button pans (Shift + right
    // also pans), the wheel zooms. The left button is for selecting and moving objects.
    this.orbit.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    this.orbit.target.set(0, 0, 10);

    this.scene.add(this.pivot);
    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSize(0.7);
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.orbit.enabled = !e.value;
      if (e.value) this.beginDrag();
      else this.endDrag();
    });
    this.gizmo.addEventListener('objectChange', () => this.applyDrag());
    this.scene.add(this.gizmo.getHelper());

    this.selBox = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ dashSize: 2.2, gapSize: 1.6, transparent: true, opacity: 0.9 }));
    this.selBox.visible = false;
    this.scene.add(this.selBox);
    for (let i = 0; i < 3; i++) {
      const el = document.createElement('div');
      el.className = 'dim-pill';
      el.title = 'Clique para digitar a medida';
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
      el.addEventListener('click', () => this.editDimension(i as 0 | 1 | 2));
      const o = new CSS2DObject(el);
      o.visible = false;
      this.dimLabels.push(o);
      this.scene.add(o);
    }

    this.handles = new ResizeHandles({
      scene: this.scene,
      camera: this.camera,
      dom: this.renderer.domElement,
      orbit: this.orbit,
      preview: (id, t) => this.previewTransform(id, t),
      gizmoBusy: () => !!this.dragStart || !!this.moveDrag,
      setGizmoVisible: (v) => (this.gizmo.getHelper().visible = v),
    });

    this.marquee = document.createElement('div');
    this.marquee.className = 'marquee';
    host.appendChild(this.marquee);

    this.bindPointer();
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.applyTheme();
    store.onDoc(() => this.sync());
    store.onSelection(() => this.updateSelection());
    settings.on(() => this.applySettings());
    this.applySettings();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ---------- frame & theme ----------

  private frame() {
    if (this.anim) {
      const t = Math.min(1, (performance.now() - this.anim.t0) / 450);
      const k = 1 - Math.pow(1 - t, 3);
      this.camera.position.lerpVectors(this.anim.from[0], this.anim.to[0], k);
      this.orbit.target.lerpVectors(this.anim.from[1], this.anim.to[1], k);
      if (t >= 1) this.anim = null;
    }
    this.orbit.update();
    this.handles.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
  }

  applyTheme() {
    const u = this.gridMat.uniforms;
    u.uBase.value.set(css('--plane'));
    u.uMinor.value.set(css('--grid-minor'));
    u.uMajor.value.set(css('--grid-major'));
    u.uAccent.value.set(css('--accent'));
    (this.selBox.material as THREE.LineDashedMaterial).color.set(css('--accent'));
    this.handles?.setAccent(css('--accent'));
    for (const id of this.views.keys()) this.styleView(id);
  }

  private applySettings() {
    this.gizmo.setTranslationSnap(settings.snap || null);
    this.gizmo.setRotationSnap(settings.snapAngle ? THREE.MathUtils.degToRad(settings.snapAngle) : null);
    this.gridMat.uniforms.uMinorSize.value = settings.snap >= 1 ? settings.snap : 1;
    this.gizmo.setSpace(settings.localSpace ? 'local' : 'world');
  }

  setMode(mode: GizmoMode) {
    this.gizmo.setMode(mode);
  }

  // ---------- scene sync ----------

  /** Cache key of what is drawn: geometry plus, for groups, the colour of each piece. */
  private viewKey(n: SceneNode) {
    const k = shapeKey(n, store.doc.assets);
    return n.kind === 'group' ? `${k}#${colorSig(n)}` : k;
  }

  private sync() {
    const seen = new Set<string>();
    for (const n of store.doc.nodes) {
      seen.add(n.id);
      let v = this.views.get(n.id);
      const key = this.viewKey(n);
      if (!v || v.key !== key) {
        if (v) this.disposeView(n.id);
        v = this.buildView(n, key);
        this.views.set(n.id, v);
      }
      v.root.matrix.copy(nodeMatrix(n));
      v.root.matrixWorldNeedsUpdate = true;
      v.root.visible = !n.hidden;
      const style = `${n.color}|${n.hole}|${n.locked}`;
      if (v.style !== style) {
        v.style = style;
        this.styleView(n.id);
      }
    }
    for (const id of [...this.views.keys()]) if (!seen.has(id)) this.disposeView(id);
    this.updateSelection();
  }

  private makePart(geom: THREE.BufferGeometry, color: string, nodeId: string): ViewPart {
    const mesh = new THREE.Mesh(geom, new THREE.MeshPhysicalMaterial({ roughness: 0.42, clearcoat: 0.35, clearcoatRoughness: 0.4 }));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.nodeId = nodeId;
    let eg = this.edgeCache.get(geom);
    if (!eg) {
      eg = new THREE.EdgesGeometry(geom, 32);
      this.edgeCache.set(geom, eg);
    }
    const edges = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ transparent: true }));
    edges.raycast = () => {};
    return { mesh, edges, color };
  }

  private buildView(n: SceneNode, key: string): NodeView {
    const parts: ViewPart[] = [];
    // A solid group keeps the colour of each of its children: one mesh per colour.
    if (n.kind === 'group' && !n.hole) {
      for (const p of renderPieces(n, store.doc.assets)) parts.push(this.makePart(p.geometry, p.color, n.id));
    }
    if (!parts.length) {
      let geom = renderGeometry(n, store.doc.assets);
      if (!geom && n.kind === 'mesh') {
        const asset = store.doc.assets[String(n.params.asset)];
        if (asset) geom = rawAssetGeometry(asset);
      }
      parts.push(this.makePart(geom ?? new THREE.BufferGeometry(), n.color, n.id));
    }
    const root = new THREE.Group();
    root.matrixAutoUpdate = false;
    for (const p of parts) root.add(p.mesh, p.edges);
    this.scene.add(root);
    return { key, style: '', root, parts };
  }

  private styleView(id: string) {
    const v = this.views.get(id);
    const n = store.find(id);
    if (!v || !n) return;
    const selected = store.selection.has(id);
    const hovered = this.hovered === id;
    for (const part of v.parts) {
      const edgeMat = part.edges.material as THREE.LineBasicMaterial;
      if (n.hole) {
        part.mesh.material = this.holeMat;
        part.mesh.castShadow = false;
        edgeMat.color.set(selected ? css('--accent') : css('--hole-edge'));
        edgeMat.opacity = selected ? 1 : 0.85;
      } else {
        if (!(part.mesh.material instanceof THREE.MeshPhysicalMaterial)) {
          part.mesh.material = new THREE.MeshPhysicalMaterial({ roughness: 0.42, clearcoat: 0.35, clearcoatRoughness: 0.4 });
        }
        // Groups paint each piece with its own colour; single objects follow the node.
        const color = n.kind === 'group' ? part.color : n.color;
        const mat = part.mesh.material as THREE.MeshPhysicalMaterial;
        mat.color.set(color);
        mat.emissive.set(hovered && !selected ? 0x222233 : 0x000000);
        part.mesh.castShadow = true;
        edgeMat.color.set(selected ? css('--accent') : new THREE.Color(color).multiplyScalar(0.55).getStyle());
        edgeMat.opacity = selected ? 1 : 0.55;
      }
    }
  }

  private disposeView(id: string) {
    const v = this.views.get(id);
    if (!v) return;
    this.scene.remove(v.root);
    // Geometries live in the shared cache; only per-view materials are freed.
    for (const part of v.parts) {
      if (part.mesh.material !== this.holeMat) (part.mesh.material as THREE.Material).dispose();
      (part.edges.material as THREE.Material).dispose();
    }
    this.views.delete(id);
  }

  // ---------- selection, gizmo ----------

  private updateSelection() {
    for (const id of this.views.keys()) this.styleView(id);
    if (this.handles.active) return;
    this.handles.sync();
    const sel = store.selected.filter((n) => !n.hidden);
    const box = this.selectionBounds(sel);
    if (!box) {
      this.gizmo.detach();
      this.selBox.visible = false;
      this.dimLabels.forEach((l) => (l.visible = false));
      return;
    }
    const unlocked = sel.filter((n) => !n.locked);
    if (unlocked.length && !this.dragStart) {
      const c = box.getCenter(new THREE.Vector3());
      if (sel.length === 1) {
        // Single object: gizmo follows the object's own frame.
        const n = sel[0];
        this.pivot.position.set(...n.position);
        this.pivot.rotation.set(...(n.rotation.map(THREE.MathUtils.degToRad) as Vec3), 'XYZ');
        this.pivot.scale.set(...n.scale);
      } else {
        this.pivot.position.set(c.x, c.y, box.min.z);
        this.pivot.rotation.set(0, 0, 0);
        this.pivot.scale.set(1, 1, 1);
      }
      this.pivot.updateMatrixWorld(true);
      this.gizmo.attach(this.pivot);
    } else if (!unlocked.length) this.gizmo.detach();
    this.drawSelectionBox(box);
  }

  private selectionBounds(nodes: SceneNode[]) {
    const box = new THREE.Box3();
    for (const n of nodes) {
      const b = worldBounds(n, store.doc.assets);
      if (b) box.union(b);
    }
    return box.isEmpty() ? null : box;
  }

  private drawSelectionBox(box: THREE.Box3) {
    const { min: a, max: b } = box;
    const p = [
      [a.x, a.y, a.z], [b.x, a.y, a.z], [b.x, b.y, a.z], [a.x, b.y, a.z],
      [a.x, a.y, b.z], [b.x, a.y, b.z], [b.x, b.y, b.z], [a.x, b.y, b.z],
    ];
    const e = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
    const g = new THREE.BufferGeometry().setFromPoints(e.map((i) => new THREE.Vector3(...(p[i] as Vec3))));
    this.selBox.geometry.dispose();
    this.selBox.geometry = g;
    this.selBox.computeLineDistances();
    this.selBox.visible = true;
    const size = box.getSize(new THREE.Vector3());
    const fmt = (v: number) => `${+v.toFixed(2)} mm`;
    const [lx, ly, lz] = this.dimLabels;
    lx.position.set((a.x + b.x) / 2, a.y - 4, a.z);
    lx.element.textContent = fmt(size.x);
    ly.position.set(b.x + 4, (a.y + b.y) / 2, a.z);
    ly.element.textContent = fmt(size.y);
    lz.position.set(b.x + 3, a.y - 3, (a.z + b.z) / 2);
    lz.element.textContent = fmt(size.z);
    this.dimLabels.forEach((l) => (l.visible = true));
  }

  /** Show a transform live (resize handles) without committing it. */
  private previewTransform(id: string, t: Pick<SceneNode, 'position' | 'rotation' | 'scale'>) {
    const v = this.views.get(id);
    const n = store.find(id);
    if (!v || !n) return;
    const tmp = { ...n, ...t };
    v.root.matrix.copy(nodeMatrix(tmp));
    v.root.matrixWorldNeedsUpdate = true;
    this.gizmo.detach();
    const box = worldBounds(tmp, store.doc.assets);
    if (box) this.drawSelectionBox(box);
  }

  /** Turn an on-screen size label into an input. */
  private editDimension(axis: 0 | 1 | 2) {
    const pill = this.dimLabels[axis].element;
    if (pill.querySelector('input')) return;
    const current = parseFloat(pill.textContent ?? '') || 0;
    pill.classList.add('editing');
    pill.innerHTML = '';
    const input = document.createElement('input');
    input.value = String(current);
    input.inputMode = 'decimal';
    pill.appendChild(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (apply: boolean) => {
      if (done) return;
      done = true;
      pill.classList.remove('editing');
      const v = Number(input.value.replace(',', '.'));
      pill.textContent = `${current} mm`;
      if (apply && v > 0 && Math.abs(v - current) > 1e-6) this.onDimensionEdit?.(axis, v);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  private beginDrag() {
    const nodes = new Map<string, THREE.Matrix4>();
    for (const n of store.selected) if (!n.locked) nodes.set(n.id, nodeMatrix(n));
    this.pivot.updateMatrixWorld(true);
    this.dragStart = { pivot: this.pivot.matrixWorld.clone(), nodes };
  }

  /** Live preview: move the three.js objects only; the store changes on release. */
  private applyDrag() {
    if (!this.dragStart) return;
    this.pivot.updateMatrixWorld(true);
    const delta = this.pivot.matrixWorld.clone().multiply(this.dragStart.pivot.clone().invert());
    for (const [id, m0] of this.dragStart.nodes) {
      const v = this.views.get(id);
      if (!v) continue;
      v.root.matrix.copy(delta.clone().multiply(m0));
      v.root.matrixWorldNeedsUpdate = true;
    }
    this.selBox.visible = false;
    this.dimLabels.forEach((l) => (l.visible = false));
  }

  private endDrag() {
    const start = this.dragStart;
    this.dragStart = null;
    if (!start) return;
    this.pivot.updateMatrixWorld(true);
    const delta = this.pivot.matrixWorld.clone().multiply(start.pivot.clone().invert());
    if (delta.equals(new THREE.Matrix4())) return this.updateSelection();
    store.commit((doc) => {
      for (const n of doc.nodes) {
        const m0 = start.nodes.get(n.id);
        if (!m0) continue;
        Object.assign(n, decompose(delta.clone().multiply(m0)));
      }
    });
  }

  // ---------- picking ----------

  /**
   * Mouse, as in Tinkercad:
   *  - left click selects (Shift/Ctrl adds or removes);
   *  - left drag on an object moves it along the workplane;
   *  - left drag on empty space draws a selection rectangle;
   *  - right drag orbits, middle drag pans, wheel zooms (OrbitControls);
   *  - a right click that did not move opens the context menu.
   */
  private bindPointer() {
    const el = this.renderer.domElement;
    const THRESHOLD = 4;
    type Press = {
      x: number;
      y: number;
      id: string | null;
      hit: THREE.Vector3 | null;
      additive: boolean;
      wasSelected: boolean;
      mode: 'pending' | 'move' | 'marquee';
    };
    let press: Press | null = null;
    let rightDown: { x: number; y: number } | null = null;
    let rightMoved = false;

    const gizmoActive = () => this.gizmo.dragging || !!(this.gizmo as unknown as { axis: string | null }).axis;

    el.addEventListener('pointerdown', (e) => {
      if (e.button === 2) {
        rightDown = { x: e.clientX, y: e.clientY };
        rightMoved = false;
        return;
      }
      if (e.button !== 0 || gizmoActive() || this.handles.active) return;
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      this.raycaster.setFromCamera(this.ndc(e.clientX, e.clientY), this.camera);
      const meshes = [...this.views.values()].filter((v) => v.root.visible).flatMap((v) => v.parts.map((p) => p.mesh));
      const hit = this.raycaster.intersectObjects(meshes, false)[0];
      const id = (hit?.object.userData.nodeId as string) ?? null;
      const wasSelected = !!id && store.selection.has(id);
      // Pressing an unselected object selects it right away, so it can be dragged.
      if (id && !wasSelected) store.select([id], additive);
      press = { x: e.clientX, y: e.clientY, id, hit: hit ? hit.point.clone() : null, additive, wasSelected, mode: 'pending' };
      el.setPointerCapture(e.pointerId);
    });

    el.addEventListener('pointermove', (e) => {
      if (rightDown && !rightMoved && Math.hypot(e.clientX - rightDown.x, e.clientY - rightDown.y) > THRESHOLD) rightMoved = true;

      if (press) {
        if (press.mode === 'pending' && Math.hypot(e.clientX - press.x, e.clientY - press.y) > THRESHOLD) {
          if (press.id && press.hit) {
            const started = this.startMove(press.id, press.hit);
            press.mode = started ? 'move' : 'pending';
            if (started) el.style.cursor = 'grabbing';
          } else if (!press.id) press.mode = 'marquee';
        }
        if (press.mode === 'move') this.updateMove(e.clientX, e.clientY);
        else if (press.mode === 'marquee') this.drawMarquee(press.x, press.y, e.clientX, e.clientY);
        return;
      }

      if (e.buttons) return;
      const id = this.pick(e.clientX, e.clientY);
      if (id !== this.hovered) {
        const prev = this.hovered;
        this.hovered = id;
        if (prev) this.styleView(prev);
        if (id) this.styleView(id);
        el.style.cursor = id ? (store.find(id)?.locked ? 'not-allowed' : 'grab') : '';
      }
    });

    const finish = (e: PointerEvent, cancelled: boolean) => {
      if (e.button === 2) {
        rightDown = null;
        return;
      }
      const p = press;
      press = null;
      if (!p) return;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      el.style.cursor = '';
      if (p.mode === 'move') return this.endMove(cancelled);
      if (p.mode === 'marquee') {
        this.marquee.style.display = 'none';
        if (!cancelled) this.selectInRect(p.x, p.y, e.clientX, e.clientY, p.additive);
        return;
      }
      // A plain click.
      if (cancelled) return;
      if (p.id) {
        if (p.additive && p.wasSelected) store.select([p.id], true); // Shift-click toggles off
        else if (!p.additive && p.wasSelected && store.selection.size > 1) store.select([p.id]);
      } else if (!p.additive) store.clearSelection();
    };
    el.addEventListener('pointerup', (e) => finish(e, false));
    el.addEventListener('pointercancel', (e) => finish(e, true));

    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // Right button drags orbit the camera; only a still right click opens the menu.
      if (rightMoved) return;
      const id = this.pick(e.clientX, e.clientY);
      if (id && !store.selection.has(id)) store.select([id]);
      if (id || store.selection.size) this.onContextMenu?.(e.clientX, e.clientY);
    });
    el.addEventListener('dblclick', () => this.frameSelection());
  }

  // ---------- left-drag: move objects along the workplane ----------

  private startMove(pressedId: string, hit: THREE.Vector3) {
    const nodes = store.selected.filter((n) => !n.locked && !n.hidden);
    if (!nodes.length || !nodes.some((n) => n.id === pressedId)) return false;
    // Slide on the horizontal plane through the point that was grabbed.
    this.moveDrag = {
      ids: nodes.map((n) => n.id),
      base: new Map(nodes.map((n) => [n.id, [...n.position] as Vec3])),
      plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), -hit.z),
      start: hit.clone(),
      delta: new THREE.Vector3(),
    };
    this.gizmo.detach();
    this.handles.hide();
    this.selBox.visible = false;
    this.dimLabels.forEach((l) => (l.visible = false));
    return true;
  }

  private updateMove(x: number, y: number) {
    const d = this.moveDrag;
    if (!d) return;
    this.raycaster.setFromCamera(this.ndc(x, y), this.camera);
    const p = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(d.plane, p)) return;
    const delta = p.sub(d.start);
    delta.z = 0;
    // Snap so the first object lands on the grid; the others keep their offsets.
    const step = settings.snap || 0;
    if (step) {
      const b0 = d.base.get(d.ids[0])!;
      delta.x = Math.round((b0[0] + delta.x) / step) * step - b0[0];
      delta.y = Math.round((b0[1] + delta.y) / step) * step - b0[1];
    }
    d.delta.copy(delta);
    for (const id of d.ids) {
      const n = store.find(id);
      const v = this.views.get(id);
      const b = d.base.get(id);
      if (!n || !v || !b) continue;
      v.root.matrix.copy(nodeMatrix({ ...n, position: [b[0] + delta.x, b[1] + delta.y, b[2]] }));
      v.root.matrixWorldNeedsUpdate = true;
    }
  }

  private endMove(cancelled: boolean) {
    const d = this.moveDrag;
    this.moveDrag = null;
    if (!d) return;
    const r = (v: number) => Math.round(v * 1e4) / 1e4;
    if (cancelled || (Math.abs(d.delta.x) < 1e-6 && Math.abs(d.delta.y) < 1e-6)) {
      this.sync(); // put the previews back
      return;
    }
    store.commit((doc) => {
      for (const n of doc.nodes) {
        const b = d.base.get(n.id);
        if (b) n.position = [r(b[0] + d.delta.x), r(b[1] + d.delta.y), b[2]];
      }
    });
  }

  // ---------- left-drag on empty space: selection rectangle ----------

  private drawMarquee(x0: number, y0: number, x1: number, y1: number) {
    const r = this.host.getBoundingClientRect();
    const m = this.marquee.style;
    m.display = 'block';
    m.left = `${Math.min(x0, x1) - r.left}px`;
    m.top = `${Math.min(y0, y1) - r.top}px`;
    m.width = `${Math.abs(x1 - x0)}px`;
    m.height = `${Math.abs(y1 - y0)}px`;
  }

  /** Select every visible object whose on-screen box touches the rectangle. */
  private selectInRect(x0: number, y0: number, x1: number, y1: number, additive: boolean) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const [minX, maxX] = [Math.min(x0, x1), Math.max(x0, x1)];
    const [minY, maxY] = [Math.min(y0, y1), Math.max(y0, y1)];
    const v = new THREE.Vector3();
    const ids: string[] = [];
    for (const n of store.doc.nodes) {
      if (n.hidden) continue;
      const b = worldBounds(n, store.doc.assets);
      if (!b) continue;
      let sx0 = Infinity, sy0 = Infinity, sx1 = -Infinity, sy1 = -Infinity;
      for (const cx of [b.min.x, b.max.x]) for (const cy of [b.min.y, b.max.y]) for (const cz of [b.min.z, b.max.z]) {
        v.set(cx, cy, cz).project(this.camera);
        const px = ((v.x + 1) / 2) * r.width + r.left;
        const py = ((1 - v.y) / 2) * r.height + r.top;
        sx0 = Math.min(sx0, px); sx1 = Math.max(sx1, px);
        sy0 = Math.min(sy0, py); sy1 = Math.max(sy1, py);
      }
      if (sx1 >= minX && sx0 <= maxX && sy1 >= minY && sy0 <= maxY) ids.push(n.id);
    }
    // With Shift/Ctrl only add: objects already selected stay selected.
    if (additive) store.select(ids.filter((id) => !store.selection.has(id)), true);
    else store.select(ids);
  }

  private ndc(x: number, y: number) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
  }

  pick(x: number, y: number): string | null {
    this.raycaster.setFromCamera(this.ndc(x, y), this.camera);
    const meshes = [...this.views.values()].filter((v) => v.root.visible).flatMap((v) => v.parts.map((p) => p.mesh));
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    return (hit?.object.userData.nodeId as string) ?? null;
  }

  /** Point on the workplane (z = 0) under the cursor, snapped to the grid. */
  workplanePoint(x: number, y: number): Vec3 {
    this.raycaster.setFromCamera(this.ndc(x, y), this.camera);
    const p = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), p)) return [0, 0, 0];
    const s = settings.snap || 0;
    const snap = (v: number) => (s ? Math.round(v / s) * s : v);
    return [snap(p.x), snap(p.y), 0];
  }

  // ---------- camera ----------

  private flyTo(pos: THREE.Vector3, target: THREE.Vector3) {
    this.anim = {
      from: [this.camera.position.clone(), this.orbit.target.clone()],
      to: [pos, target],
      t0: performance.now(),
    };
  }

  view(name: 'home' | 'top' | 'front' | 'right' | 'iso') {
    const box = this.selectionBounds(store.doc.nodes.filter((n) => !n.hidden)) ?? new THREE.Box3(new THREE.Vector3(-50, -50, 0), new THREE.Vector3(50, 50, 30));
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(box.getSize(new THREE.Vector3()).length() * 0.5, 40);
    const d = r / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.1;
    const dirs: Record<string, Vec3> = {
      home: [0.55, -0.68, 0.5],
      iso: [0.577, -0.577, 0.577],
      top: [0, -0.0001, 1],
      front: [0, -1, 0.0001],
      right: [1, 0, 0.0001],
    };
    const dir = new THREE.Vector3(...dirs[name]).normalize();
    this.flyTo(c.clone().addScaledVector(dir, d), c);
  }

  frameSelection() {
    const sel = store.selected;
    const box = this.selectionBounds(sel.length ? sel : store.doc.nodes.filter((n) => !n.hidden));
    if (!box) return this.view('home');
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(box.getSize(new THREE.Vector3()).length() * 0.5, 8);
    const d = (r / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 1.15;
    const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
    this.flyTo(c.clone().addScaledVector(dir, d), c);
  }

  zoom(factor: number) {
    const t = this.orbit.target.clone();
    const pos = t.clone().add(this.camera.position.clone().sub(t).multiplyScalar(factor));
    this.flyTo(pos, t);
  }

  /** PNG thumbnail of the current view. */
  snapshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
}

/** Anti-aliased procedural grid with soft radial fade (no texture, no aliasing). */
function makeGridMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    extensions: { derivatives: true } as never,
    uniforms: {
      uBase: { value: new THREE.Color() },
      uMinor: { value: new THREE.Color() },
      uMajor: { value: new THREE.Color() },
      uAccent: { value: new THREE.Color() },
      uMinorSize: { value: 1 },
      uHalf: { value: WORKPLANE / 2 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vP;
      void main() {
        vP = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uBase, uMinor, uMajor, uAccent;
      uniform float uMinorSize, uHalf;
      varying vec2 vP;
      float line(vec2 p, float size, float w) {
        vec2 c = p / size;
        vec2 g = abs(fract(c - 0.5) - 0.5) / fwidth(c);
        return 1.0 - min(min(g.x, g.y) / w, 1.0);
      }
      void main() {
        vec2 q = abs(vP);
        float inside = 1.0 - smoothstep(uHalf - 0.5, uHalf + 0.5, max(q.x, q.y));
        float fade = 1.0 - smoothstep(uHalf * 0.9, uHalf * 2.2, length(vP));
        // Minor lines vanish when they would be denser than ~6 px.
        vec2 d = fwidth(vP);
        float minorVis = 1.0 - smoothstep(0.08, 0.22, max(d.x, d.y) / uMinorSize);
        float minor = line(vP, uMinorSize, 1.0) * minorVis * 0.55;
        float major = line(vP, 10.0, 1.1);
        vec3 col = uBase;
        col = mix(col, uMinor, minor * inside);
        col = mix(col, uMajor, major * inside);
        float axisX = (1.0 - smoothstep(0.0, 1.5 * d.y, abs(vP.y))) * step(0.0, vP.x);
        float axisY = (1.0 - smoothstep(0.0, 1.5 * d.x, abs(vP.x))) * step(0.0, vP.y);
        col = mix(col, vec3(0.93, 0.33, 0.36), axisX * inside * 0.8);
        col = mix(col, vec3(0.24, 0.72, 0.45), axisY * inside * 0.8);
        // Outside the plate, only a faint continuation of the major grid.
        float alpha = inside > 0.5 ? 1.0 : major * fade * 0.35;
        col = inside > 0.5 ? col : uMajor;
        gl_FragColor = vec4(col, alpha);
        #include <colorspace_fragment>
      }`,
  });
}
