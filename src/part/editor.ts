/**
 * Part workspace: a parametric history (sketches → extrude/revolve) edited in its own
 * full-screen view, rebuilt by the OpenCascade kernel. On "Concluir" the part goes back
 * to the scene as a mesh node that remembers its history.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { el, esc, showMenu, toast } from '../ui/dom';
import { icon } from '../ui/icons';
import { manifoldApi } from '../core/geometry';
import { buildPart, exportStep, loadKernel, provideManifold, type PartMesh } from './kernel';
import {
  PLANES,
  arcPoints,
  circleThrough,
  constraintEntities,
  curveEnds,
  ellipsePoints,
  splinePoints,
  textContours,
  featureSketches,
  fid,
  isDimension,
  nextName,
  profilePoints,
  refPoint,
  sameRef,
  sketchProfiles,
  type BodyOp,
  type EdgeFeature,
  type ExtrudeFeature,
  type Feature,
  type HoleFeature,
  type ImportFeature,
  type PatternFeature,
  type ShellFeature,
  type ThreadFeature,
  type PartDef,
  type PlaneName,
  type PointRef,
  type RevolveFeature,
  type SketchConstraint,
  type SketchEntity,
  type SketchFeature,
  type V2,
  type V3,
} from './model';
import { loadSolver, solveSketch } from './solver';
import { autoConstrain, corner, extend, offset, parseDxf, slot, trim } from './sketchOps';
import { DEFAULT_FONT_ID, listFaces, loadFont, textToPolygons } from '../core/fonts';
import './part.css';

type DrawTool = 'select' | 'line' | 'rect' | 'circle' | 'arc' | 'polygon' | 'ellipse' | 'spline' | 'slot' | 'text';
type ModTool = 'trim' | 'extend' | 'offset' | 'sfillet' | 'schamfer';
type ConTool = 'dim' | 'coincident' | 'horizontal' | 'vertical' | 'parallel' | 'perpendicular' | 'equal' | 'tangent' | 'concentric' | 'midpoint' | 'onEntity' | 'fix' | 'angle' | 'symmetric';
type Tool = DrawTool | ModTool | ConTool;
/** What a constraint tool asks for, click by click: p point, l line, r circle/arc, e any curve. */
type Need = 'p' | 'l' | 'r' | 'e';
type Pick = { ref: PointRef } | { e: string };

const CTOOLS: { id: ConTool; label: string; glyph: string; key?: string; need: Need[]; hint: string }[] = [
  { id: 'dim', label: 'Cota', glyph: '↔', key: 'D', need: [], hint: 'Clique numa linha (comprimento), num círculo ou arco (diâmetro) ou em dois pontos (distância).' },
  { id: 'coincident', label: 'Coincidente', glyph: '●', need: ['p', 'p'], hint: 'Clique dois pontos para juntá-los.' },
  { id: 'horizontal', label: 'Horizontal', glyph: 'H', key: 'H', need: ['l'], hint: 'Clique uma linha para deixá-la horizontal.' },
  { id: 'vertical', label: 'Vertical', glyph: 'V', key: 'I', need: ['l'], hint: 'Clique uma linha para deixá-la vertical.' },
  { id: 'parallel', label: 'Paralela', glyph: '∥', need: ['l', 'l'], hint: 'Clique duas linhas.' },
  { id: 'perpendicular', label: 'Perpendicular', glyph: '⊥', need: ['l', 'l'], hint: 'Clique duas linhas.' },
  { id: 'equal', label: 'Igual', glyph: '=', need: ['e', 'e'], hint: 'Clique duas linhas (mesmo comprimento) ou dois círculos/arcos (mesmo raio).' },
  { id: 'tangent', label: 'Tangente', glyph: 'T', need: ['e', 'e'], hint: 'Clique uma linha e um círculo/arco, ou dois círculos/arcos.' },
  { id: 'concentric', label: 'Concêntrica', glyph: '◎', need: ['r', 'r'], hint: 'Clique dois círculos ou arcos.' },
  { id: 'midpoint', label: 'Ponto médio', glyph: '½', need: ['p', 'l'], hint: 'Clique um ponto e depois a linha.' },
  { id: 'onEntity', label: 'Ponto sobre', glyph: '∈', need: ['p', 'e'], hint: 'Clique um ponto e depois a linha, círculo ou arco onde ele fica.' },
  { id: 'fix', label: 'Fixar', glyph: '⚓', need: ['p'], hint: 'Clique um ponto para travá-lo onde está.' },
  { id: 'angle', label: 'Ângulo', glyph: '∠', need: ['l', 'l'], hint: 'Clique duas linhas.' },
  { id: 'symmetric', label: 'Simetria', glyph: '⇋', need: ['p', 'p', 'l'], hint: 'Clique dois pontos e depois a linha que fica no meio deles (o espelho).' },
];
const CLABEL: Record<SketchConstraint['t'], string> = {
  coincident: 'Coincidente', horizontal: 'Horizontal', vertical: 'Vertical', parallel: 'Paralela', perpendicular: 'Perpendicular', equal: 'Igual',
  tangent: 'Tangente', concentric: 'Concêntrica', midpoint: 'Ponto médio', onEntity: 'Ponto sobre', fix: 'Fixo', length: 'Comprimento',
  diameter: 'Diâmetro', distance: 'Distância', angle: 'Ângulo', symmetric: 'Simetria',
};
const GLYPH: Partial<Record<SketchConstraint['t'], string>> = Object.fromEntries(CTOOLS.map((t) => [t.id, t.glyph]));

const isCon = (t: Tool): t is ConTool => CTOOLS.some((c) => c.id === t);
const snapshot = (s: SketchFeature) => JSON.stringify({ entities: s.entities, constraints: s.constraints ?? [] });

const TOOLS: { id: DrawTool; label: string; key: string; hint: string }[] = [
  { id: 'select', label: 'Selecionar', key: 'V', hint: 'Clique numa linha para ver as medidas; arraste os pontos. Delete apaga.' },
  { id: 'line', label: 'Linha', key: 'L', hint: 'Clique os pontos. Volte ao primeiro ponto para fechar. Esc termina.' },
  { id: 'rect', label: 'Retângulo', key: 'R', hint: 'Clique um canto e depois o canto oposto.' },
  { id: 'circle', label: 'Círculo', key: 'C', hint: 'Clique o centro e depois um ponto da borda.' },
  { id: 'arc', label: 'Arco', key: 'A', hint: 'Clique o início, o fim e depois um ponto por onde o arco passa.' },
  { id: 'polygon', label: 'Polígono', key: 'P', hint: 'Clique o centro e depois um vértice.' },
  { id: 'ellipse', label: 'Elipse', key: 'E', hint: 'Clique o centro, depois a ponta do eixo maior e depois a altura.' },
  { id: 'spline', label: 'Spline', key: 'S', hint: 'Clique os pontos da curva. Enter ou Esc termina; clicar no primeiro ponto fecha.' },
  { id: 'slot', label: 'Rasgo', key: 'O', hint: 'Clique o centro de uma ponta, o da outra e depois a largura.' },
  { id: 'text', label: 'Texto', key: 'X', hint: 'Clique onde o texto fica. Depois edite o texto e o tamanho no painel.' },
];

const MTOOLS: { id: ModTool; label: string; icon: string; key: string; hint: string }[] = [
  { id: 'trim', label: 'Aparar', icon: 'trim', key: 'T', hint: 'Clique no pedaço de linha, arco ou círculo que sai (até onde ele cruza outras linhas).' },
  { id: 'extend', label: 'Estender', icon: 'extend', key: 'W', hint: 'Clique perto da ponta de uma linha para levá-la até a próxima linha.' },
  { id: 'offset', label: 'Offset', icon: 'offset', key: 'F', hint: 'Clique numa linha, arco ou círculo: copia o contorno ligado a ela na distância escolhida (positivo = para fora).' },
  { id: 'sfillet', label: 'Filete', icon: 'fillet', key: 'G', hint: 'Clique no canto entre duas linhas para arredondar.' },
  { id: 'schamfer', label: 'Chanfro', icon: 'chamfer', key: 'K', hint: 'Clique no canto entre duas linhas para chanfrar.' },
];
const isMod = (t: Tool): t is ModTool => MTOOLS.some((m) => m.id === t);

const OPS: [BodyOp, string][] = [
  ['join', 'Juntar'],
  ['cut', 'Recortar'],
  ['intersect', 'Interseção'],
];

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
const r2 = (v: number) => Math.round(v * 100) / 100;
const fmt = (v: number) => String(r2(v)).replace('.', ',');
const num = (s: string) => Number(String(s).replace(',', '.'));

export interface PartEditorOptions {
  title: string;
  part: PartDef;
  onDone(part: PartDef, mesh: PartMesh): void;
}

export async function openPartEditor(opts: PartEditorOptions) {
  const wait = el(`<div class="pe-loading"><div class="spinner"></div><div>Carregando o motor de modelagem…</div></div>`);
  document.body.appendChild(wait);
  try {
    await Promise.all([loadKernel(), loadSolver()]);
  } catch (e) {
    toast(`Não consegui carregar o motor de modelagem: ${(e as Error).message}`, 'error', 6000);
    return;
  } finally {
    wait.remove();
  }
  // Threads are cut on the mesh with the app's Manifold module.
  provideManifold(manifoldApi());
  new PartEditor(opts);
}

class PartEditor {
  private part: PartDef;
  private readonly original: string;
  private selected: string | null = null;
  private errors = new Map<string, string>();

  // inspect
  private measuring = false;
  private measurePts: V3[] = [];
  private measureGroup = new THREE.Group();
  private section: { axis: 'x' | 'y' | 'z'; at: number; flip: boolean } | null = null;
  private clip = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
  private sectionBar: HTMLElement | null = null;

  // sketch mode
  private sketchId: string | null = null;
  private tool: Tool = 'select';
  private pts: V2[] = [];
  /** The existing point each click in `pts` snapped to, if any (becomes a coincidence). */
  private ptRefs: (PointRef | null)[] = [];
  private chainStart: V2 | null = null;
  private hover: V2 | null = null;
  private selEntity: string | null = null;
  private selConstraint: string | null = null;
  private picks: Pick[] = [];
  private drag: { ref: PointRef; to: V2; busy: Promise<void> | null } | null = null;
  /** Free degrees left in the sketch (null when unknown). */
  private dof: number | null = null;
  private marks: HTMLElement;
  private markPos: { el: HTMLElement; pos: () => number[] | null }[] = [];
  private marksKey = '';
  private gridStep = 1;
  private polygonSides = 6;
  /** Offset distance, sketch fillet radius or chamfer size. */
  private modSize = 2;
  /** Inner point of a spline being dragged (not a solver point). */
  private splineDrag: { e: string; i: number } | null = null;
  private imageTex: { src: string; tex: THREE.Texture } | null = null;

  // view
  private root: HTMLElement;
  private side: HTMLElement;
  private status: HTMLElement;
  private host: HTMLElement;
  private renderer = new THREE.WebGLRenderer({ antialias: true });
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 0.5, 5000);
  private orbit: OrbitControls;
  private solid = new THREE.Group();
  private sketch = new THREE.Group();
  private picksGroup = new THREE.Group();
  /** Edges of the part before the selected fillet/chamfer, as line-segment pairs. */
  private pickEdges: number[][] | null = null;
  private solidFaces: PartMesh['faces'];
  private hoverPick: ReturnType<PartEditor['pickAt']> = null;
  private anim: { t0: number; from: THREE.Vector3[]; to: THREE.Vector3[]; up: THREE.Vector3 } | null = null;
  private buildSeq = 0;
  private rebuildTimer = 0;
  private resize: ResizeObserver;
  private onKey = (e: KeyboardEvent) => this.key(e);

  constructor(private opts: PartEditorOptions) {
    this.part = structuredClone(opts.part);
    this.original = JSON.stringify(opts.part);
    document.body.classList.add('part-open');
    this.root = el(`
      <div class="part-editor">
        <header class="pe-top glass">
          <div class="pe-title">${icon('part', 18)}<span>Peça: <b>${esc(opts.title)}</b></span></div>
          <div class="spacer"></div>
          <button class="btn" data-act="measure" data-tip="Medir distâncias e ver volume e peso">${icon('angle', 16)}<span class="lbl">Medir</span></button>
          <button class="btn" data-act="section" data-tip="Vista em corte">${icon('eye', 16)}<span class="lbl">Corte</span></button>
          <button class="btn" data-act="export-step" data-tip="Salvar a geometria exata para outros programas CAD">${icon('export', 16)}<span class="lbl">STEP</span></button>
          <button class="btn" data-act="cancel">Cancelar</button>
          <button class="btn primary" data-act="done">${icon('check', 16)}<span class="lbl">Concluir peça</span></button>
        </header>
        <aside class="pe-side glass"></aside>
        <div class="pe-view"><div class="pe-marks"></div></div>
        <div class="pe-status glass"></div>
      </div>`);
    this.side = this.root.querySelector('.pe-side')!;
    this.host = this.root.querySelector('.pe-view')!;
    this.marks = this.root.querySelector('.pe-marks')!;
    this.status = this.root.querySelector('.pe-status')!;
    document.body.appendChild(this.root);

    // ----- three -----
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    this.host.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(css('--bg'));
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(90, -120, 90);
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    // Same mouse as the main view: right button turns, middle pans, wheel zooms; left draws.
    this.orbit.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8580, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(60, -80, 140);
    this.scene.add(sun, this.solid, this.sketch, this.picksGroup, this.measureGroup, this.floorGrid(), new THREE.AxesHelper(20));
    this.sketch.matrixAutoUpdate = false;
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(this.host);
    this.fit();
    this.renderer.setAnimationLoop(() => this.frame());

    // ----- events -----
    this.root.querySelector('[data-act=cancel]')!.addEventListener('click', () => this.cancel());
    this.root.querySelector('[data-act=done]')!.addEventListener('click', () => this.done());
    this.root.querySelector('[data-act=export-step]')!.addEventListener('click', () => this.exportStep());
    this.root.querySelector('[data-act=measure]')!.addEventListener('click', () => this.toggleMeasure());
    this.root.querySelector('[data-act=section]')!.addEventListener('click', () => this.toggleSection());
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointermove', (e) => this.pointerMove(e));
    canvas.addEventListener('pointerdown', (e) => this.pointerDown(e));
    canvas.addEventListener('pointerup', () => this.endDrag());
    this.marks.addEventListener('pointerdown', (e) => this.markClick(e));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('keydown', this.onKey, true);
    this.side.addEventListener('change', (e) => this.fieldChange(e));
    this.side.addEventListener('click', (e) => this.sideClick(e));

    if (import.meta.env.DEV) (window as unknown as { __pe: unknown }).__pe = this;
    if (!this.part.features.length) this.status.textContent = 'Comece criando um esboço num plano.';
    this.renderSide();
    this.rebuild();
  }

  // ---------- helpers ----------

  private get sketchFeature(): SketchFeature | null {
    return (this.part.features.find((f) => f.id === this.sketchId) as SketchFeature) ?? null;
  }

  private feature(id: string | null) {
    return this.part.features.find((f) => f.id === id) ?? null;
  }

  private sketches() {
    return this.part.features.filter((f): f is SketchFeature => f.type === 'sketch');
  }

  private changed() {
    this.renderSide();
    this.drawSketch();
    this.scheduleRebuild();
  }

  // ---------- view ----------

  private fit() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private frame() {
    if (this.anim) {
      const t = Math.min(1, (performance.now() - this.anim.t0) / 450);
      const k = 1 - Math.pow(1 - t, 3);
      this.camera.position.lerpVectors(this.anim.from[0], this.anim.to[0], k);
      this.orbit.target.lerpVectors(this.anim.from[1], this.anim.to[1], k);
      this.camera.up.lerp(this.anim.up, k).normalize();
      if (t >= 1) this.anim = null;
    }
    this.orbit.update();
    this.renderer.render(this.scene, this.camera);
    for (const m of this.markPos) {
      const p = m.pos();
      m.el.style.display = p ? '' : 'none';
      if (p) m.el.style.transform = `translate(${p[0]}px, ${p[1]}px) translate(-50%, -50%)`;
    }
  }

  private look(dir: THREE.Vector3, up: THREE.Vector3, target = new THREE.Vector3(), dist = 160) {
    this.anim = {
      t0: performance.now(),
      from: [this.camera.position.clone(), this.orbit.target.clone()],
      to: [target.clone().add(dir.clone().normalize().multiplyScalar(dist)), target.clone()],
      up: up.clone(),
    };
  }

  private floorGrid() {
    const g = new THREE.GridHelper(200, 20, new THREE.Color(css('--grid-major')), new THREE.Color(css('--grid-minor')));
    g.rotation.x = Math.PI / 2;
    (g.material as THREE.Material).transparent = true;
    (g.material as THREE.Material).opacity = 0.6;
    return g;
  }

  // ---------- build ----------

  private scheduleRebuild() {
    clearTimeout(this.rebuildTimer);
    this.rebuildTimer = window.setTimeout(() => this.rebuild(), 120);
  }

  private async rebuild() {
    const seq = ++this.buildSeq;
    // While sketching, show the part as it was before this sketch.
    const idx = this.sketchId ? this.part.features.findIndex((f) => f.id === this.sketchId) : this.part.features.length;
    const part: PartDef = { version: 1, features: this.part.features.slice(0, idx) };
    const pf = this.pickFeature;
    const safe = async (o?: Parameters<typeof buildPart>[1]) => {
      try {
        return await buildPart(part, o);
      } catch (e) {
        return { mesh: null, shape: null, edges: undefined, error: { feature: '', message: (e as Error).message } };
      }
    };
    const r = await safe();
    // Fillets, shells and holes are set up on the part as it was before them.
    const view = pf ? await safe({ before: pf.id, edges: pf.type === 'fillet' || pf.type === 'chamfer' }) : r;
    if (seq !== this.buildSeq) return;
    this.errors.clear();
    if (r.error) this.errors.set(r.error.feature, r.error.message);
    this.showSolid(view.mesh);
    this.pickEdges = view.edges ?? null;
    this.drawPicks();
    if (!this.sketchId) {
      const hint = !pf
        ? ''
        : pf.type === 'hole'
          ? pf.at ? 'Clique noutra face para mudar o furo de lugar. Esc mostra o resultado.' : 'Clique na face onde vai o furo.'
          : pf.type === 'shell'
            ? 'Clique nas faces que ficam abertas. Esc mostra o resultado.'
            : pf.type === 'thread'
              ? 'Clique na face redonda que leva a rosca. Esc mostra o resultado.'
            : 'Clique nas arestas para pôr ou tirar. Esc mostra o resultado.';
      this.status.textContent = r.error ? `⚠ ${this.feature(r.error.feature)?.name ?? 'Erro'}: ${r.error.message}` : hint || (r.mesh ? 'Peça atualizada.' : 'Crie um esboço e depois extrude ou revolva.');
    }
    this.status.classList.toggle('warn', !!r.error);
    this.renderSide();
  }

  // ---------- picking edges and faces ----------

  private screenOf(p: THREE.Vector3) {
    const v = p.clone().project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return [((v.x + 1) / 2) * r.width, ((1 - v.y) / 2) * r.height, v.z];
  }

  /** What the mouse is over on the part: an edge for fillets/chamfers, a face otherwise. */
  private pickAt(e: PointerEvent): { edge?: number; face?: number; point?: V3; normal?: V3 } | null {
    const pf = this.pickFeature;
    if (!pf) return null;
    const [mx, my] = this.mouse(e);
    if (pf.type === 'fillet' || pf.type === 'chamfer') {
      if (pf.all || !this.pickEdges) return null;
      let best = -1, bd = 8;
      this.pickEdges.forEach((pts, i) => {
        for (let k = 0; k + 5 < pts.length; k += 6) {
          const a = this.screenOf(new THREE.Vector3(pts[k], pts[k + 1], pts[k + 2]));
          const b = this.screenOf(new THREE.Vector3(pts[k + 3], pts[k + 4], pts[k + 5]));
          if (a[2] > 1 || b[2] > 1) continue;
          const d = segDist(mx, my, a, b);
          if (d < bd) (bd = d), (best = i);
        }
      });
      return best >= 0 ? { edge: best } : null;
    }
    const mesh = this.solid.children[0] as THREE.Mesh | undefined;
    if (!mesh) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((mx / r.width) * 2 - 1, -(my / r.height) * 2 + 1), this.camera);
    const hit = ray.intersectObject(mesh)[0];
    if (!hit || hit.faceIndex == null || !hit.face) return null;
    const groups = this.solidFaces ?? [];
    const face = groups.findIndex((g) => hit.faceIndex! * 3 >= g.start && hit.faceIndex! * 3 < g.start + g.count);
    const n = hit.face.normal;
    return { face, point: [r2(hit.point.x), r2(hit.point.y), r2(hit.point.z)], normal: [n.x, n.y, n.z].map((v) => Math.round(v * 1e4) / 1e4) as V3 };
  }

  /** Index of the edge passing nearest to a remembered point. */
  private edgeNear(p: V3) {
    const P = new THREE.Vector3(...p);
    const seg = new THREE.Line3();
    const tmp = new THREE.Vector3();
    let best = -1, bd = Infinity;
    (this.pickEdges ?? []).forEach((pts, i) => {
      for (let k = 0; k + 5 < pts.length; k += 6) {
        seg.set(new THREE.Vector3(pts[k], pts[k + 1], pts[k + 2]), new THREE.Vector3(pts[k + 3], pts[k + 4], pts[k + 5]));
        const d = seg.closestPointToPoint(P, true, tmp).distanceTo(P);
        if (d < bd) (bd = d), (best = i);
      }
    });
    return best;
  }

  /** Index of the solid face nearest to a remembered point. */
  private faceNear(p: V3) {
    const mesh = this.solid.children[0] as THREE.Mesh | undefined;
    if (!mesh) return -1;
    const pos = mesh.geometry.getAttribute('position');
    const idx = mesh.geometry.getIndex()!;
    const P = new THREE.Vector3(...p);
    const tri = new THREE.Triangle();
    const tmp = new THREE.Vector3();
    let best = -1, bd = Infinity;
    (this.solidFaces ?? []).forEach((g, i) => {
      for (let k = g.start; k < g.start + g.count; k += 3) {
        tri.setFromAttributeAndIndices(pos, idx.getX(k), idx.getX(k + 1), idx.getX(k + 2));
        const d = tri.closestPointToPoint(P, tmp).distanceTo(P);
        if (d < bd) (bd = d), (best = i);
      }
    });
    return best;
  }

  private edgeMid(i: number): V3 {
    const pts = this.pickEdges![i];
    let total = 0;
    for (let k = 0; k + 5 < pts.length; k += 6) total += Math.hypot(pts[k + 3] - pts[k], pts[k + 4] - pts[k + 1], pts[k + 5] - pts[k + 2]);
    let walked = 0;
    for (let k = 0; k + 5 < pts.length; k += 6) {
      const l = Math.hypot(pts[k + 3] - pts[k], pts[k + 4] - pts[k + 1], pts[k + 5] - pts[k + 2]);
      if (walked + l >= total / 2) {
        const t = l ? (total / 2 - walked) / l : 0;
        return [0, 1, 2].map((j) => r2(pts[k + j] + (pts[k + 3 + j] - pts[k + j]) * t)) as V3;
      }
      walked += l;
    }
    return [pts[0], pts[1], pts[2]];
  }

  private pickClick(e: PointerEvent) {
    const pf = this.pickFeature!;
    const hit = this.pickAt(e);
    if (!hit) return;
    if ((pf.type === 'fillet' || pf.type === 'chamfer') && hit.edge != null) {
      const at = pf.edges.findIndex((p) => this.edgeNear(p) === hit.edge);
      if (at >= 0) pf.edges.splice(at, 1);
      else pf.edges.push(this.edgeMid(hit.edge));
    } else if (pf.type === 'shell' && hit.point) {
      const at = pf.faces.findIndex((p) => this.faceNear(p) === hit.face);
      if (at >= 0) pf.faces.splice(at, 1);
      else pf.faces.push(hit.point);
    } else if (pf.type === 'hole' && hit.point && hit.normal) {
      pf.at = hit.point;
      pf.n = hit.normal;
    } else if (pf.type === 'thread' && hit.point) pf.face = hit.point;
    this.hoverPick = null;
    this.changed();
  }

  /** Chosen edges and faces (and what is under the mouse) drawn over the part. */
  private drawPicks() {
    for (const c of [...this.picksGroup.children]) {
      this.picksGroup.remove(c);
      (c as THREE.Mesh).geometry?.dispose();
    }
    const pf = this.pickFeature;
    if (!pf) return;
    // Blue, so choices stand out on the (accent-coloured) part.
    const accent = new THREE.Color(0x2f8cff);
    const r = this.renderer.domElement.getBoundingClientRect();
    const thick = (pts: number[], color: THREE.Color | number, width: number, opacity = 1) => {
      const g = new LineSegmentsGeometry().setPositions(pts);
      const l = new LineSegments2(g, new LineMaterial({ color, linewidth: width, resolution: new THREE.Vector2(r.width, r.height), transparent: opacity < 1, opacity, depthTest: false }));
      l.renderOrder = 6;
      this.picksGroup.add(l);
    };
    const faceOverlay = (i: number, opacity: number) => {
      const mesh = this.solid.children[0] as THREE.Mesh | undefined;
      const g = this.solidFaces?.[i];
      if (!mesh || !g) return;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', mesh.geometry.getAttribute('position'));
      geo.setIndex(Array.from((mesh.geometry.getIndex()!.array as ArrayLike<number>)).slice(g.start, g.start + g.count));
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide }));
      this.picksGroup.add(m);
    };
    const hov = this.hoverPick;
    if (pf.type === 'fillet' || pf.type === 'chamfer') {
      if (pf.all || !this.pickEdges) return;
      const chosen = new Set(pf.edges.map((p) => this.edgeNear(p)));
      for (const i of chosen) if (i >= 0) thick(this.pickEdges[i], accent, 4);
      if (hov?.edge != null && !chosen.has(hov.edge)) thick(this.pickEdges[hov.edge], accent, 3, 0.55);
    } else if (pf.type === 'thread') {
      const chosen = pf.face ? this.faceNear(pf.face) : -1;
      if (chosen >= 0) faceOverlay(chosen, 0.55);
      if (hov?.face != null && hov.face !== chosen) faceOverlay(hov.face, 0.25);
    } else if (pf.type === 'shell') {
      const chosen = new Set(pf.faces.map((p) => this.faceNear(p)));
      for (const i of chosen) faceOverlay(i, 0.55);
      if (hov?.face != null && !chosen.has(hov.face)) faceOverlay(hov.face, 0.25);
    } else if (pf.type === 'hole') {
      if (hov?.face != null) faceOverlay(hov.face, 0.2);
      if (pf.at) {
        // Preview of the drill as a see-through cylinder going into the face.
        const depth = pf.through ? 30 : pf.depth;
        const cyl = new THREE.Mesh(
          new THREE.CylinderGeometry(pf.diameter / 2, pf.diameter / 2, depth, 32),
          new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.45, depthTest: false }),
        );
        const n = new THREE.Vector3(...pf.n).normalize();
        cyl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
        cyl.position.copy(new THREE.Vector3(...pf.at).addScaledVector(n, -depth / 2));
        cyl.renderOrder = 6;
        this.picksGroup.add(cyl);
      }
    }
  }

  private showSolid(mesh: PartMesh | null) {
    for (const c of [...this.solid.children]) {
      this.solid.remove(c);
      (c as THREE.Mesh).geometry?.dispose();
    }
    this.solidFaces = mesh?.faces;
    if (!mesh) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(mesh.positions, 3));
    g.setIndex(mesh.indices);
    g.computeVertexNormals();
    const clippingPlanes = this.section ? [this.clip] : [];
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: css('--accent'), roughness: 0.55, metalness: 0.05, transparent: !!this.sketchId, opacity: this.sketchId ? 0.35 : 1, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, clippingPlanes }));
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(g, 25), new THREE.LineBasicMaterial({ color: 0x2a2020, transparent: true, opacity: 0.55, clippingPlanes }));
    this.solid.add(m, edges);
    // In section view the inside shows through the cut in a darker shade.
    if (this.section) this.solid.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: new THREE.Color(css('--accent')).multiplyScalar(0.45), side: THREE.BackSide, clippingPlanes })));
  }

  // ---------- measure and section ----------

  /** Volume (mm³) and surface area (mm²) of the shown mesh. */
  private meshStats() {
    const mesh = this.solid.children[0] as THREE.Mesh | undefined;
    if (!mesh) return null;
    const pos = mesh.geometry.getAttribute('position');
    const idx = mesh.geometry.getIndex()!;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    let vol = 0, area = 0;
    for (let i = 0; i < idx.count; i += 3) {
      a.fromBufferAttribute(pos, idx.getX(i));
      b.fromBufferAttribute(pos, idx.getX(i + 1));
      c.fromBufferAttribute(pos, idx.getX(i + 2));
      vol += a.dot(b.clone().cross(c)) / 6;
      area += b.clone().sub(a).cross(c.clone().sub(a)).length() / 2;
    }
    return { vol: Math.abs(vol), area };
  }

  private toggleMeasure() {
    this.measuring = !this.measuring;
    this.measurePts = [];
    this.root.querySelector('[data-act=measure]')!.classList.toggle('active', this.measuring);
    this.drawMeasure();
    if (!this.measuring) return void (this.status.textContent = 'Peça atualizada.');
    const st = this.meshStats();
    const fmt1 = (v: number) => v.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
    // PLA ≈ 1,24 g/cm³; a print with walls and 15% infill weighs roughly 40–50% of the solid.
    this.status.textContent = st
      ? `Clique dois pontos na peça para medir.  Volume ${fmt1(st.vol / 1000)} cm³ · área ${fmt1(st.area / 100)} cm² · peso maciço em PLA ≈ ${fmt1((st.vol / 1000) * 1.24)} g`
      : 'Clique dois pontos na peça para medir.';
  }

  private measureClick(e: PointerEvent) {
    const mesh = this.solid.children[0] as THREE.Mesh | undefined;
    if (!mesh) return;
    const [mx, my] = this.mouse(e);
    const r = this.renderer.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((mx / r.width) * 2 - 1, -(my / r.height) * 2 + 1), this.camera);
    const hit = ray.intersectObject(mesh)[0];
    if (!hit) return;
    // Snap to a nearby corner of the mesh triangle, which is usually a real vertex of the part.
    const p = hit.point.clone();
    if (hit.face) {
      const pos = mesh.geometry.getAttribute('position');
      for (const k of [hit.face.a, hit.face.b, hit.face.c]) {
        const v = new THREE.Vector3().fromBufferAttribute(pos, k);
        const [sx, sy] = this.screenOf(v);
        if (Math.hypot(sx - mx, sy - my) < 7) p.copy(v);
      }
    }
    if (this.measurePts.length >= 2) this.measurePts = [];
    this.measurePts.push([p.x, p.y, p.z]);
    this.drawMeasure();
    if (this.measurePts.length === 2) {
      const [a, b] = this.measurePts;
      const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      this.status.textContent = `Distância ${fmt(Math.hypot(...d))} mm   (X ${fmt(Math.abs(d[0]))} · Y ${fmt(Math.abs(d[1]))} · Z ${fmt(Math.abs(d[2]))})`;
    } else this.status.textContent = 'Agora clique o segundo ponto.';
  }

  private drawMeasure() {
    for (const c of [...this.measureGroup.children]) {
      this.measureGroup.remove(c);
      (c as THREE.Mesh).geometry?.dispose();
    }
    const blue = new THREE.Color(0x2f8cff);
    for (const p of this.measurePts) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(this.camera.position.distanceTo(this.orbit.target) * 0.005, 16, 12), new THREE.MeshBasicMaterial({ color: blue, depthTest: false }));
      s.position.set(...p);
      s.renderOrder = 7;
      this.measureGroup.add(s);
    }
    if (this.measurePts.length === 2) {
      const r = this.renderer.domElement.getBoundingClientRect();
      const l = new LineSegments2(new LineSegmentsGeometry().setPositions([...this.measurePts[0], ...this.measurePts[1]]), new LineMaterial({ color: blue, linewidth: 3, resolution: new THREE.Vector2(r.width, r.height), depthTest: false }));
      l.renderOrder = 7;
      this.measureGroup.add(l);
    }
  }

  private toggleSection() {
    if (this.section) {
      this.section = null;
      this.sectionBar?.remove();
      this.sectionBar = null;
    } else {
      const box = new THREE.Box3().setFromObject(this.solid);
      const mid = box.isEmpty() ? 0 : r2((box.min.y + box.max.y) / 2);
      this.section = { axis: 'y', at: mid, flip: false };
      this.sectionBar = el(`<div class="pe-section glass">
        <span>Corte</span>
        <select data-s="axis"><option value="x">X</option><option value="y" selected>Y</option><option value="z">Z</option></select>
        <input type="range" data-s="at" step="0.1"/>
        <span class="v"></span>
        <label class="pe-check"><input type="checkbox" data-s="flip"/> Inverter</label>
      </div>`);
      this.root.appendChild(this.sectionBar);
      this.sectionBar.addEventListener('input', () => this.readSectionBar());
      this.sectionBar.addEventListener('change', () => this.readSectionBar(true));
      this.syncSectionBar();
    }
    this.root.querySelector('[data-act=section]')!.classList.toggle('active', !!this.section);
    this.updateClip();
    this.scheduleRebuild();
  }

  /** Slider range follows the part's size along the chosen axis. */
  private syncSectionBar() {
    if (!this.section || !this.sectionBar) return;
    const box = new THREE.Box3().setFromObject(this.solid);
    const k = this.section.axis;
    const lo = box.isEmpty() ? -50 : Math.floor(box.min[k]), hi = box.isEmpty() ? 50 : Math.ceil(box.max[k]);
    const range = this.sectionBar.querySelector<HTMLInputElement>('[data-s=at]')!;
    range.min = String(lo);
    range.max = String(hi);
    range.value = String(this.section.at);
    this.sectionBar.querySelector('.v')!.textContent = `${fmt(this.section.at)} mm`;
  }

  private readSectionBar(axisMayChange = false) {
    if (!this.section || !this.sectionBar) return;
    const axis = this.sectionBar.querySelector<HTMLSelectElement>('[data-s=axis]')!.value as 'x' | 'y' | 'z';
    if (axisMayChange && axis !== this.section.axis) {
      const box = new THREE.Box3().setFromObject(this.solid);
      this.section.axis = axis;
      this.section.at = box.isEmpty() ? 0 : r2((box.min[axis] + box.max[axis]) / 2);
      this.syncSectionBar();
    } else this.section.at = Number(this.sectionBar.querySelector<HTMLInputElement>('[data-s=at]')!.value);
    this.section.flip = this.sectionBar.querySelector<HTMLInputElement>('[data-s=flip]')!.checked;
    this.sectionBar.querySelector('.v')!.textContent = `${fmt(this.section.at)} mm`;
    this.updateClip();
  }

  private updateClip() {
    if (!this.section) return;
    const n = new THREE.Vector3(this.section.axis === 'x' ? 1 : 0, this.section.axis === 'y' ? 1 : 0, this.section.axis === 'z' ? 1 : 0);
    // Keep what lies on the negative side of the cut (or the other side when flipped).
    if (!this.section.flip) n.negate();
    this.clip.set(n, this.section.flip ? -this.section.at : this.section.at);
  }

  // ---------- side panel ----------

  private renderSide() {
    this.side.innerHTML = this.sketchId ? this.sketchPanel() : this.historyPanel();
  }

  private historyPanel() {
    const fs = this.part.features;
    const sel = this.feature(this.selected);
    const rows = fs
      .map((f) => {
        const err = this.errors.get(f.id);
        const ic = f.type === 'hole' ? 'drill' : f.type;
        return `<div class="pe-feat ${f.id === this.selected ? 'on' : ''} ${err ? 'bad' : ''}" data-feat="${f.id}">
          ${icon(ic, 16)}<span class="nm">${esc(f.name)}</span>${err ? `<span class="err" data-tip="${esc(err)}">${icon('warning', 14)}</span>` : ''}
          ${f.type === 'sketch' ? `<button class="btn icon-only sm" data-act="edit-sketch" data-id="${f.id}" data-tip="Editar esboço">${icon('sketch', 15)}</button>` : ''}
          <button class="btn icon-only sm danger" data-act="del" data-id="${f.id}" data-tip="Apagar">${icon('trash', 15)}</button>
        </div>`;
      })
      .join('');
    const hasSketch = this.sketches().length > 0;
    const hasSolid = fs.some((f) => ['extrude', 'revolve', 'sweep', 'loft', 'import'].includes(f.type));
    const twoSketches = this.sketches().length > 1;
    const btn = (act: string, ic: string, label: string, on: boolean) => `<button class="btn soft" data-act="${act}" ${on ? '' : 'disabled'}>${icon(ic, 16)}<span>${label}</span></button>`;
    return `
      <div class="panel-title">Histórico</div>
      <div class="pe-feats">${rows || '<div class="hint">Ainda vazio.</div>'}</div>
      <div class="pe-actions">
        ${btn('new-sketch', 'sketch', 'Esboço', true)}
        ${btn('extrude', 'extrude', 'Extrudar', hasSketch)}
        ${btn('revolve', 'revolve', 'Revolver', hasSketch)}
        ${btn('hole', 'drill', 'Furo', hasSolid)}
        ${btn('fillet', 'fillet', 'Filete', hasSolid)}
        ${btn('chamfer', 'chamfer', 'Chanfro', hasSolid)}
        ${btn('shell', 'shell', 'Casca', hasSolid)}
        ${btn('pattern', 'pattern', 'Padrão', hasSolid)}
        ${btn('sweep', 'sweep', 'Varrer', twoSketches)}
        ${btn('loft', 'loft', 'Loft', twoSketches)}
        ${btn('thread', 'thread', 'Rosca', hasSolid)}
        ${btn('import-step', 'import', 'STEP', true)}
      </div>
      ${sel ? `<div class="pe-params"><div class="panel-title">${esc(sel.name)}</div>${this.featureForm(sel)}</div>` : ''}`;
  }

  private sketchSelect(cur: string) {
    return `<select data-k="sketch">${this.sketches()
      .map((s) => `<option value="${s.id}" ${s.id === cur ? 'selected' : ''}>${esc(s.name)}</option>`)
      .join('')}</select>`;
  }

  private opSelect(cur: BodyOp) {
    return `<select data-k="op">${OPS.map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  }

  private numField(label: string, k: string, v: number, unit = 'mm') {
    return `<label class="pe-field"><span>${label}</span><span class="field"><input data-k="${k}" value="${fmt(v)}" inputmode="decimal"/><span class="unit">${unit}</span></span></label>`;
  }

  private featureForm(f: Feature) {
    if (f.type === 'sketch') {
      return `
        <label class="pe-field"><span>Plano</span><select data-k="plane">${(Object.keys(PLANES) as PlaneName[])
          .map((p) => `<option value="${p}" ${p === f.plane ? 'selected' : ''}>${PLANES[p].label}</option>`)
          .join('')}</select></label>
        ${this.numField('Deslocamento', 'offset', f.offset)}
        <button class="btn soft wide" data-act="edit-sketch" data-id="${f.id}">${icon('sketch', 15)} Editar esboço</button>`;
    }
    if (f.type === 'extrude') {
      return `
        <label class="pe-field"><span>Esboço</span>${this.sketchSelect(f.sketch)}</label>
        ${this.numField('Distância', 'distance', f.distance)}
        <label class="pe-check"><input type="checkbox" data-k="symmetric" ${f.symmetric ? 'checked' : ''}/> Para os dois lados</label>
        <label class="pe-check"><input type="checkbox" data-k="reverse" ${f.reverse ? 'checked' : ''} ${f.symmetric ? 'disabled' : ''}/> Inverter direção</label>
        <label class="pe-field"><span>Operação</span>${this.opSelect(f.op)}</label>`;
    }
    if (f.type === 'revolve')
      return `
      <label class="pe-field"><span>Esboço</span>${this.sketchSelect(f.sketch)}</label>
      <label class="pe-field"><span>Eixo</span><select data-k="axis"><option value="y" ${f.axis === 'y' ? 'selected' : ''}>Vertical do esboço (Y)</option><option value="x" ${f.axis === 'x' ? 'selected' : ''}>Horizontal do esboço (X)</option></select></label>
      ${this.numField('Ângulo', 'angle', f.angle, '°')}
      <label class="pe-field"><span>Operação</span>${this.opSelect(f.op)}</label>`;
    const sel = (k: string, cur: string, opts: [string, string][]) =>
      `<select data-k="${k}">${opts.map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    const axes: [string, string][] = [['x', 'X'], ['y', 'Y'], ['z', 'Z (para cima)']];
    if (f.type === 'fillet' || f.type === 'chamfer') {
      const n = f.edges.length;
      return `
        ${this.numField(f.type === 'fillet' ? 'Raio' : 'Distância', 'size', f.size)}
        <label class="pe-check"><input type="checkbox" data-k="all" ${f.all ? 'checked' : ''}/> Todas as arestas</label>
        ${f.all ? '' : `<div class="hint">${n ? `${n} ${n === 1 ? 'aresta escolhida' : 'arestas escolhidas'}.` : 'Nenhuma aresta ainda.'} Clique nas arestas na vista para pôr ou tirar.</div>
        ${n ? `<button class="btn soft wide" data-act="clear-picks">Limpar escolha</button>` : ''}`}`;
    }
    if (f.type === 'shell') {
      const n = f.faces.length;
      return `
        ${this.numField('Espessura da parede', 'thickness', f.thickness)}
        <div class="hint">${n ? `${n} ${n === 1 ? 'face aberta' : 'faces abertas'}.` : 'Nenhuma face ainda.'} Clique na face que fica aberta (ex.: a de cima).</div>
        ${n ? `<button class="btn soft wide" data-act="clear-picks">Limpar escolha</button>` : ''}`;
    }
    if (f.type === 'hole') {
      const xyz = f.at ? `<div class="pe-row">${this.numField('X', 'at.0', f.at[0])}${this.numField('Y', 'at.1', f.at[1])}${this.numField('Z', 'at.2', f.at[2])}</div>` : '';
      return `
        <div class="hint">${f.at ? 'Clique noutra face para mudar o lugar do furo.' : 'Clique na face onde vai o furo.'}</div>
        ${xyz}
        <label class="pe-field"><span>Tipo</span>${sel('kind', f.kind, [['simple', 'Simples'], ['counterbore', 'Com rebaixo (cabeça de parafuso)'], ['countersink', 'Escareado (cabeça chata)']])}</label>
        <div class="pe-row">${this.numField('Diâmetro', 'diameter', f.diameter)}${f.through ? '' : this.numField('Profundidade', 'depth', f.depth)}</div>
        <label class="pe-check"><input type="checkbox" data-k="through" ${f.through ? 'checked' : ''}/> Atravessar tudo</label>
        ${f.kind === 'simple' ? '' : `<div class="pe-row">${this.numField(f.kind === 'counterbore' ? 'Diâm. do rebaixo' : 'Diâm. do escareado', 'headDiameter', f.headDiameter)}${f.kind === 'counterbore' ? this.numField('Prof. do rebaixo', 'headDepth', f.headDepth) : ''}</div>`}`;
    }
    const idx = this.part.features.indexOf(f);
    const earlierSketches = this.part.features.slice(0, idx).filter((x): x is SketchFeature => x.type === 'sketch');
    const sketchOpts = (k: string, cur: string) => sel(k, cur, earlierSketches.map((s) => [s.id, s.name]));
    if (f.type === 'sweep')
      return `
        <label class="pe-field"><span>Perfil (contorno fechado)</span>${sketchOpts('sketch', f.sketch)}</label>
        <label class="pe-field"><span>Caminho (linhas e arcos)</span>${sketchOpts('path', f.path)}</label>
        <div class="hint">Desenhe o perfil num plano que corte o começo do caminho.</div>
        <label class="pe-field"><span>Operação</span>${this.opSelect(f.op)}</label>`;
    if (f.type === 'loft')
      return `
        <div class="pe-field"><span>Esboços, na ordem (um contorno cada)</span>
        ${earlierSketches.map((s) => `<label class="pe-check"><input type="checkbox" data-k="loft:${s.id}" ${f.sketches.includes(s.id) ? 'checked' : ''}/> ${esc(s.name)} <span class="hint">${PLANES[s.plane].label}, ${fmt(s.offset)} mm</span></label>`).join('')}</div>
        <label class="pe-check"><input type="checkbox" data-k="ruled" ${f.ruled ? 'checked' : ''}/> Lados retos</label>
        <label class="pe-field"><span>Operação</span>${this.opSelect(f.op)}</label>`;
    if (f.type === 'thread') {
      const iso: [string, string][] = [['', 'Outro'], ...[[3, 0.5], [4, 0.7], [5, 0.8], [6, 1], [8, 1.25], [10, 1.5], [12, 1.75], [16, 2]].map(([d, p]): [string, string] => [String(p), `M${d} (passo ${fmt(p)})`])];
      return `
        <div class="hint">${f.face ? 'Clique noutra face redonda para mudar.' : 'Clique na face redonda: o lado de um pino (parafuso) ou o de dentro de um furo (porca).'}</div>
        <label class="pe-field"><span>Padrão métrico</span>${sel('preset', iso.some(([v]) => v && Number(v) === f.pitch) ? String(f.pitch) : '', iso)}</label>
        <div class="pe-row">${this.numField('Passo', 'pitch', f.pitch)}${this.numField('Comprimento', 'length', f.length)}</div>
        <div class="hint">Comprimento 0 = a face inteira. A rosca entra na malha impressa, mas não vai para o arquivo STEP.</div>
        <label class="pe-check"><input type="checkbox" data-k="lefthand" ${f.lefthand ? 'checked' : ''}/> Rosca esquerda</label>`;
    }
    if (f.type === 'import')
      return `<div class="hint">${icon('file', 14)} ${esc(f.file)}</div><label class="pe-field"><span>Operação</span>${this.opSelect(f.op)}</label>`;
    if (f.type !== 'pattern') return '';
    const usable = this.part.features.slice(0, idx).filter((x) => ['extrude', 'revolve', 'hole', 'sweep', 'loft', 'import'].includes(x.type));
    const srcs = `<div class="pe-field"><span>O que repetir</span>
      <label class="pe-check"><input type="checkbox" data-k="src:" ${f.sources.length ? '' : 'checked'}/> A peça inteira</label>
      ${usable.map((x) => `<label class="pe-check"><input type="checkbox" data-k="src:${x.id}" ${f.sources.includes(x.id) ? 'checked' : ''}/> ${esc(x.name)}</label>`).join('')}</div>`;
    if (f.kind === 'mirror')
      return `${srcs}<label class="pe-field"><span>Plano do espelho</span>${sel('plane', f.plane, (Object.keys(PLANES) as PlaneName[]).map((p) => [p, PLANES[p].label]))}</label>`;
    if (f.kind === 'circular')
      return `${srcs}
        <label class="pe-field"><span>Eixo de giro (pela origem)</span>${sel('axis', f.axis, axes)}</label>
        <div class="pe-row">${this.numField('Quantidade', 'count', f.count, '')}${this.numField('Ângulo total', 'angle', f.angle, '°')}</div>`;
    return `${srcs}
      <label class="pe-field"><span>Direção</span>${sel('axis', f.axis, axes)}</label>
      <div class="pe-row">${this.numField('Quantidade', 'count', f.count, '')}${this.numField('Espaço', 'spacing', f.spacing)}</div>
      <label class="pe-field"><span>Segunda direção</span>${sel('axis2', f.axis2 ?? '', [['', 'Nenhuma'], ...axes])}</label>
      ${f.axis2 ? `<div class="pe-row">${this.numField('Quantidade', 'count2', f.count2, '')}${this.numField('Espaço', 'spacing2', f.spacing2)}</div>` : ''}`;
  }

  private sketchPanel() {
    const s = this.sketchFeature!;
    const tool = TOOLS.find((t) => t.id === this.tool) ?? MTOOLS.find((t) => t.id === this.tool) ?? CTOOLS.find((t) => t.id === this.tool)!;
    const modLabel = this.tool === 'offset' ? 'Distância' : this.tool === 'sfillet' ? 'Raio' : this.tool === 'schamfer' ? 'Tamanho' : '';
    const img = s.image;
    const ent = s.entities.find((e) => e.id === this.selEntity);
    const con = s.constraints?.find((c) => c.id === this.selConstraint);
    const { openEnds } = sketchProfiles(s.entities);
    const dof = !s.entities.length || this.dof === null ? '' : this.dof === 0
      ? `<div class="pe-dof ok">${icon('check', 14)} Esboço totalmente definido</div>`
      : `<div class="pe-dof">Faltam ${this.dof} ${this.dof === 1 ? 'grau' : 'graus'} de liberdade (use cotas e restrições)</div>`;
    return `
      <div class="panel-title">${esc(s.name)} · ${PLANES[s.plane].label}</div>
      ${dof}
      <div class="pe-tools">${TOOLS.map((t) => `<button class="btn ${t.id === this.tool ? 'active' : ''}" data-tool="${t.id}" data-tip="${t.label} (${t.key})">${icon(t.id === 'select' ? 'cursor' : t.id, 18)}<span>${t.label}</span></button>`).join('')}</div>
      <div class="panel-title">Modificar</div>
      <div class="pe-mtools">${MTOOLS.map((t) => `<button class="btn ${t.id === this.tool ? 'active' : ''}" data-tool="${t.id}" data-tip="${t.label} (${t.key})">${icon(t.icon, 17)}<span>${t.label}</span></button>`).join('')}</div>
      <div class="panel-title">Restrições</div>
      <div class="pe-ctools">${CTOOLS.map((t) => `<button class="btn ${t.id === this.tool ? 'active' : ''}" data-tool="${t.id}" data-tip="${t.label}${t.key ? ` (${t.key})` : ''}">${t.glyph}</button>`).join('')}</div>
      <div class="hint">${esc(tool.hint)}</div>
      <div class="pe-row">
        <label class="pe-field"><span>Grade</span><select data-k="grid">${[0, 0.5, 1, 5, 10].map((g) => `<option value="${g}" ${g === this.gridStep ? 'selected' : ''}>${g ? `${fmt(g)} mm` : 'Livre'}</option>`).join('')}</select></label>
        ${this.tool === 'polygon' ? `<label class="pe-field"><span>Lados</span><span class="field"><input data-k="sides" value="${this.polygonSides}" inputmode="numeric"/></span></label>` : ''}
        ${modLabel ? this.numField(modLabel, 'modsize', this.modSize) : ''}
      </div>
      <div class="pe-row">
        <button class="btn soft" style="flex:1" data-act="auto-constrain" data-tip="Junta pontas que se tocam e deixa retas as linhas quase retas">${icon('sparkle', 15)} Auto</button>
        <button class="btn soft" style="flex:1" data-act="import-dxf" data-tip="Trazer linhas, arcos e curvas de um arquivo DXF">${icon('import', 15)} DXF</button>
        <button class="btn soft" style="flex:1" data-act="bg-image" data-tip="Imagem de fundo para copiar o desenho por cima">${icon('image', 15)} Imagem</button>
      </div>
      ${img ? `<div class="pe-params"><div class="panel-title">Imagem de fundo</div><div class="pe-row">${this.numField('Largura', 'img.w', img.w)}${this.numField('Opacidade', 'img.opacity', Math.round(img.opacity * 100), '%')}</div><div class="pe-row">${this.numField('Centro X', 'img.c.0', img.c[0])}${this.numField('Y', 'img.c.1', img.c[1])}</div><button class="btn soft wide danger" data-act="bg-remove">${icon('trash', 15)} Tirar imagem</button></div>` : ''}
      ${con ? `<div class="pe-params"><div class="panel-title">${CLABEL[con.t]}</div>${isDimension(con) ? this.numField('Valor', 'cval', Math.abs(con.v), con.t === 'angle' ? '°' : 'mm') : ''}<button class="btn soft wide danger" data-act="del-constraint">${icon('trash', 15)} Apagar restrição</button></div>` : ''}
      ${ent ? `<div class="pe-params"><div class="panel-title">Medidas</div>${this.entityForm(ent)}<label class="pe-check"><input type="checkbox" data-k="construction" ${ent.construction ? 'checked' : ''}/> Linha de construção (não vira sólido)</label><button class="btn soft wide danger" data-act="del-entity">${icon('trash', 15)} Apagar</button></div>` : ''}
      ${openEnds.length ? `<div class="hint warn-t">${icon('warning', 14)} Há linhas que não fecham um contorno. Só contornos fechados viram sólido.</div>` : ''}
      <div class="spacer-v"></div>
      <button class="btn primary wide" data-act="finish-sketch">${icon('check', 16)} Concluir esboço</button>`;
  }

  private entityForm(e: SketchEntity) {
    const xy = (label: string, k: string, p: V2) => `<div class="pe-row">${this.numField(`${label} X`, `${k}.0`, p[0])}${this.numField('Y', `${k}.1`, p[1])}</div>`;
    switch (e.t) {
      case 'line':
        return `${this.numField('Comprimento', 'len', Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]))}${this.numField('Ângulo', 'ang', (Math.atan2(e.b[1] - e.a[1], e.b[0] - e.a[0]) * 180) / Math.PI, '°')}${xy('Início', 'a', e.a)}${xy('Fim', 'b', e.b)}`;
      case 'rect':
        return `<div class="pe-row">${this.numField('Largura', 'w', e.w)}${this.numField('Altura', 'h', e.h)}</div>${xy('Centro', 'c', e.c)}`;
      case 'circle':
        return `${this.numField('Diâmetro', 'd', e.r * 2)}${xy('Centro', 'c', e.c)}`;
      case 'polygon':
        return `<div class="pe-row">${this.numField('Lados', 'n', e.n, '')}${this.numField('Raio', 'r', e.r)}</div>${xy('Centro', 'c', e.c)}`;
      case 'arc':
        return `${this.numField('Diâmetro', 'd', (circleThrough(e.a, e.m, e.b)?.r ?? 0) * 2)}${xy('Início', 'a', e.a)}${xy('Fim', 'b', e.b)}`;
      case 'ellipse':
        return `<div class="pe-row">${this.numField('Largura', 'ew', e.rx * 2)}${this.numField('Altura', 'eh', e.ry * 2)}</div>${this.numField('Giro', 'rot', e.rot, '°')}${xy('Centro', 'c', e.c)}`;
      case 'spline':
        return `<div class="hint" style="margin:0">${e.pts.length} pontos. Arraste os pontos para mudar a curva.</div>${xy('Início', 'a', e.pts[0])}${xy('Fim', 'b', e.pts[e.pts.length - 1])}`;
      case 'text': {
        const fonts = listFaces();
        return `<label class="pe-field"><span>Texto</span><span class="field"><input data-k="text" value="${esc(e.text)}" spellcheck="false"/></span></label>
          <label class="pe-field"><span>Fonte</span><select data-k="font">${fonts.map((f) => `<option value="${esc(f.id)}" ${f.id === e.font ? 'selected' : ''}>${esc(f.family)} ${esc(f.style)}</option>`).join('')}</select></label>
          <div class="pe-row">${this.numField('Tamanho', 'size', e.size)}${this.numField('Giro', 'rot', e.rot, '°')}</div>${xy('Centro', 'c', e.c)}`;
      }
    }
  }

  private sideClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const toolBtn = t.closest<HTMLElement>('[data-tool]');
    if (toolBtn) return this.setTool(toolBtn.dataset.tool as Tool);
    const act = t.closest<HTMLElement>('[data-act]');
    if (act) {
      const id = act.dataset.id ?? '';
      switch (act.dataset.act) {
        case 'new-sketch':
          return this.planeMenu(act);
        case 'extrude':
        case 'revolve':
          return this.addFeature(act.dataset.act);
        case 'hole':
        case 'fillet':
        case 'chamfer':
        case 'shell':
          return this.addModifier(act.dataset.act);
        case 'pattern':
          return showMenu(
            [
              { heading: 'Padrão' },
              { label: 'Em linha / grade', icon: 'pattern', action: () => this.addPattern('linear') },
              { label: 'Em círculo', icon: 'revolve', action: () => this.addPattern('circular') },
              { label: 'Espelhar', icon: 'pattern', action: () => this.addPattern('mirror') },
            ],
            act,
          );
        case 'sweep':
        case 'loft':
          return this.addSweepOrLoft(act.dataset.act);
        case 'thread':
          return this.addModifier('thread');
        case 'import-step':
          return this.importStep();
        case 'clear-picks': {
          const f = this.feature(this.selected);
          if (f?.type === 'fillet' || f?.type === 'chamfer') f.edges = [];
          if (f?.type === 'shell') f.faces = [];
          return this.changed();
        }
        case 'edit-sketch':
          return this.enterSketch(id);
        case 'del':
          return this.deleteFeature(id);
        case 'finish-sketch':
          return this.exitSketch();
        case 'del-entity':
          return this.deleteEntity();
        case 'del-constraint':
          return this.deleteConstraint();
        case 'auto-constrain':
          return void this.autoConstrain();
        case 'import-dxf':
          return this.importDxf();
        case 'bg-image':
          return this.pickImage();
        case 'bg-remove':
          delete this.sketchFeature!.image;
          return this.changed();
      }
      return;
    }
    const row = t.closest<HTMLElement>('[data-feat]');
    if (row && !t.closest('select, input')) this.select(row.dataset.feat!);
  }

  /** Select a feature; fillets, shells and holes show the part before them so edges and faces can be clicked. */
  private select(id: string | null) {
    const was = this.pickFeature;
    this.selected = id;
    if (this.pickFeature !== was) this.changed();
    else this.renderSide();
  }

  /** The selected feature, when it is one that is set up by clicking the part. */
  private get pickFeature(): EdgeFeature | ShellFeature | HoleFeature | ThreadFeature | null {
    const f = this.sketchId ? null : this.feature(this.selected);
    return f && (f.type === 'fillet' || f.type === 'chamfer' || f.type === 'shell' || f.type === 'hole' || f.type === 'thread') ? f : null;
  }

  private fieldChange(e: Event) {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    const k = t.dataset.k;
    if (!k) return;
    const val = t instanceof HTMLInputElement && t.type === 'checkbox' ? t.checked : t.value;

    if (this.sketchId) {
      if (k === 'grid') this.gridStep = Number(val);
      else if (k === 'sides') this.polygonSides = Math.max(3, Math.min(64, Math.round(num(String(val))) || 6));
      else if (k === 'modsize') {
        const n = num(String(val));
        if (Number.isFinite(n) && (n > 0 || (this.tool === 'offset' && n !== 0))) this.modSize = n;
      } else if (k.startsWith('img.')) {
        const img = this.sketchFeature!.image;
        const n = num(String(val));
        if (!img || !Number.isFinite(n)) return this.renderSide();
        if (k === 'img.w' && n > 0) img.w = n;
        else if (k === 'img.opacity') img.opacity = Math.max(0.05, Math.min(1, n / 100));
        else if (k === 'img.c.0') img.c[0] = n;
        else if (k === 'img.c.1') img.c[1] = n;
        return this.changed();
      }
      else if (k === 'cval') return void this.editConstraintValue(num(String(val)));
      else return void this.editEntity(k, val);
      return this.renderSide();
    }

    const f = this.feature(this.selected);
    if (!f) return;
    const rec = f as unknown as Record<string, unknown>;
    if (k.startsWith('src:') && f.type === 'pattern') {
      const id = k.slice(4);
      if (!id) f.sources = [];
      else f.sources = val ? [...f.sources, id] : f.sources.filter((x) => x !== id);
    } else if (k.startsWith('loft:') && f.type === 'loft') {
      // Keep the sketches in history order (bottom to top, usually).
      const id = k.slice(5);
      const on = new Set(val ? [...f.sketches, id] : f.sketches.filter((x) => x !== id));
      f.sketches = this.sketches().map((s) => s.id).filter((x) => on.has(x));
    } else if (k === 'preset' && f.type === 'thread') {
      if (!val) return;
      f.pitch = Number(val);
    } else if (k.startsWith('at.') && f.type === 'hole' && f.at) {
      const n = num(String(val));
      if (!Number.isFinite(n)) return this.renderSide();
      f.at[Number(k.slice(3))] = n;
    } else if (typeof val === 'boolean') rec[k] = val;
    else if (['offset', 'distance', 'angle', 'size', 'thickness', 'diameter', 'depth', 'headDiameter', 'headDepth', 'count', 'spacing', 'count2', 'spacing2', 'pitch', 'length'].includes(k)) {
      const n = num(val);
      if (!Number.isFinite(n)) return this.renderSide();
      rec[k] = n;
    } else if (k === 'axis2') rec[k] = val || null;
    else rec[k] = val;
    this.changed();
  }

  /**
   * Measure fields: sizes become dimensions that drive the sketch; positions and the line angle
   * pull the point there as far as the constraints let it go.
   */
  private async editEntity(k: string, val: string | boolean) {
    const s = this.sketchFeature!;
    const e = s.entities.find((x) => x.id === this.selEntity);
    if (!e) return;
    if (k === 'construction') {
      e.construction = !!val || undefined;
      return this.changed();
    }
    if (e.t === 'text' && (k === 'text' || k === 'font' || k === 'size')) {
      const patch = k === 'size' ? { size: num(String(val)) } : { [k]: String(val) };
      if (k === 'size' && !(patch.size! > 0)) return this.renderSide();
      return void this.setText(e, patch);
    }
    const n = num(String(val));
    if (!Number.isFinite(n)) return this.renderSide();
    const [key, axis] = k.split('.');
    if (axis !== undefined) {
      const cur = refPoint(s.entities, { e: e.id, p: key as 'a' | 'b' | 'c' });
      if (!cur) return;
      const to: V2 = [...cur];
      to[Number(axis)] = n;
      return this.pull({ e: e.id, p: key as 'a' | 'b' | 'c' }, to);
    }
    if (e.t === 'line' && k === 'len') return this.setDimension(e.id, 'length', Math.max(0.01, n));
    if (e.t === 'line' && k === 'ang') {
      const len = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
      const ang = (n * Math.PI) / 180;
      return this.pull({ e: e.id, p: 'b' }, [e.a[0] + len * Math.cos(ang), e.a[1] + len * Math.sin(ang)]);
    }
    if ((e.t === 'circle' || e.t === 'arc') && k === 'd') return this.setDimension(e.id, 'diameter', Math.max(0.01, n));
    const before = snapshot(s);
    if (e.t === 'rect' && (k === 'w' || k === 'h')) e[k] = Math.max(0.01, n);
    else if (e.t === 'polygon' && k === 'r') e.r = Math.max(0.01, n);
    else if (e.t === 'polygon' && k === 'n') e.n = Math.max(3, Math.min(64, Math.round(n)));
    else if (e.t === 'ellipse' && (k === 'ew' || k === 'eh')) e[k === 'ew' ? 'rx' : 'ry'] = Math.max(0.005, n / 2);
    else if ((e.t === 'ellipse' || e.t === 'text') && k === 'rot') e.rot = n;
    await this.resolve(before);
  }

  /** Change a text entity and lay its outline out again with the font. */
  private async setText(e: Extract<SketchEntity, { t: 'text' }>, patch: Partial<{ text: string; font: string; size: number }>) {
    const next = { text: e.text, font: e.font, size: e.size, ...patch };
    try {
      e.outline = await textOutline(next.text, next.font, next.size);
      Object.assign(e, next);
    } catch {
      toast('Não consegui ler essa fonte.', 'error');
    }
    this.changed();
  }

  private async autoConstrain() {
    const s = this.sketchFeature!;
    const before = snapshot(s);
    const n = autoConstrain(s);
    if (!n) return toast('Nada para restringir automaticamente.');
    if (await this.resolve(before)) toast(`${n} ${n === 1 ? 'restrição adicionada' : 'restrições adicionadas'}.`);
  }

  private importDxf() {
    const input = el<HTMLInputElement>('<input type="file" accept=".dxf,.DXF" hidden />');
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file || !this.sketchId) return;
      try {
        const { ents, skipped } = parseDxf(await file.text());
        if (!ents.length) return toast('O DXF não tem linhas, arcos ou curvas que eu consiga ler.', 'error', 4000);
        const s = this.sketchFeature!;
        s.entities.push(...ents);
        const before = snapshot(s);
        autoConstrain(s);
        // The drawing comes in as it is; constraints are a bonus.
        if (!(await this.resolve(before, true))) await this.resolve();
        toast(`${ents.length} elementos importados${skipped ? ` (${skipped} ignorados: texto, cotas, blocos…)` : ''}.`, 'info', 4000);
      } catch (err) {
        toast(`Não consegui ler o DXF: ${(err as Error).message}`, 'error', 5000);
      }
    });
    document.body.appendChild(input);
    input.click();
  }

  /** Picture to trace over, shrunk so it does not bloat the project. */
  private pickImage() {
    const input = el<HTMLInputElement>('<input type="file" accept="image/png,image/jpeg,image/webp" hidden />');
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      const s = this.sketchFeature;
      if (!file || !s) return;
      try {
        const bmp = await createImageBitmap(file);
        const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
        const c = document.createElement('canvas');
        c.width = Math.round(bmp.width * k);
        c.height = Math.round(bmp.height * k);
        c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
        s.image = { src: c.toDataURL('image/jpeg', 0.85), c: [0, 0], w: 100, aspect: bmp.height / bmp.width, opacity: 0.5 };
        this.changed();
      } catch {
        toast('Não consegui abrir essa imagem.', 'error');
      }
    });
    document.body.appendChild(input);
    input.click();
  }

  // ---------- constraints ----------

  /** Solve the sketch; on failure put back `before` and say why. */
  private async resolve(before?: string, quiet = false) {
    const s = this.sketchFeature;
    if (!s) return true;
    const r = await solveSketch(s);
    if (r.ok) this.dof = r.dof;
    else if (before) {
      const b = JSON.parse(before);
      s.entities = b.entities;
      s.constraints = b.constraints;
      if (!quiet) toast(r.conflicting.length ? 'Isso entra em conflito com outras restrições do esboço. Desfeito.' : 'Não deu para resolver o esboço com essa mudança. Desfeito.', 'error', 4000);
    }
    if (this.sketchId === s.id) this.changed();
    return r.ok;
  }

  /** Move a point towards `to` while keeping every constraint. */
  private async pull(ref: PointRef, to: V2) {
    const s = this.sketchFeature!;
    const before = snapshot(s);
    const r = await solveSketch(s, { ref, to });
    if (!r.ok) {
      const b = JSON.parse(before);
      s.entities = b.entities;
    } else this.dof = r.dof;
    this.changed();
  }

  private async setDimension(e: string, t: 'length' | 'diameter', v: number) {
    const s = this.sketchFeature!;
    const before = snapshot(s);
    const cur = s.constraints?.find((c): c is Extract<SketchConstraint, { t: 'length' | 'diameter' }> => c.t === t && c.e === e);
    if (cur) cur.v = v;
    else (s.constraints ??= []).push({ id: fid(), t, e, v });
    await this.resolve(before);
  }

  private async editConstraintValue(n: number) {
    const s = this.sketchFeature!;
    const c = s.constraints?.find((x) => x.id === this.selConstraint);
    if (!c || !isDimension(c) || !Number.isFinite(n) || (c.t !== 'angle' && n <= 0)) return this.renderSide();
    const before = snapshot(s);
    c.v = c.t === 'angle' ? (c.v < 0 ? -1 : 1) * Math.abs(n) : n;
    await this.resolve(before);
  }

  private async addConstraint(c: SketchConstraint) {
    const s = this.sketchFeature!;
    const key = (x: SketchConstraint) => JSON.stringify({ ...x, id: '', v: 0, at: 0 });
    const dup = s.constraints?.find((x) => key(x) === key(c));
    if (dup) {
      this.selConstraint = dup.id;
      return this.changed();
    }
    const before = snapshot(s);
    (s.constraints ??= []).push(c);
    if (!(await this.resolve(before))) return;
    if (isDimension(c)) {
      this.selConstraint = c.id;
      this.selEntity = null;
      this.renderSide();
      const inp = this.side.querySelector<HTMLInputElement>('[data-k=cval]');
      inp?.focus();
      inp?.select();
    }
  }

  private deleteConstraint() {
    const s = this.sketchFeature;
    if (!s || !this.selConstraint) return;
    s.constraints = s.constraints?.filter((c) => c.id !== this.selConstraint);
    this.selConstraint = null;
    void this.resolve();
  }

  /** New entities with the constraints that came from snapping; those are dropped if they don't solve. */
  private async addEntities(ents: SketchEntity[], cons: SketchConstraint[]) {
    const s = this.sketchFeature!;
    s.entities.push(...ents);
    if (!cons.length) return this.resolve();
    const before = snapshot(s);
    (s.constraints ??= []).push(...cons);
    // `before` already has the entities, so a failure only drops the automatic constraints.
    if (!(await this.resolve(before, true))) await this.resolve();
  }

  /** Coincidence of a new point with the existing one it snapped to. */
  private joinTo(p: PointRef, ref: PointRef | null | undefined): SketchConstraint[] {
    return ref ? [{ id: fid(), t: 'coincident', p1: p, p2: ref }] : [];
  }

  /** Lines drawn exactly level or upright stay that way. */
  private straight(l: Extract<SketchEntity, { t: 'line' }>): SketchConstraint[] {
    if (Math.abs(l.a[1] - l.b[1]) < 1e-9) return [{ id: fid(), t: 'horizontal', e: l.id }];
    if (Math.abs(l.a[0] - l.b[0]) < 1e-9) return [{ id: fid(), t: 'vertical', e: l.id }];
    return [];
  }

  private constraintClick(e: PointerEvent) {
    const s = this.sketchFeature!;
    const hit = this.hitTest(e);
    const kind = (id: string) => s.entities.find((x) => x.id === id)?.t;
    const round = (id: string) => kind(id) === 'circle' || kind(id) === 'arc';
    const curve = (id: string) => kind(id) === 'line' || round(id);
    if (this.tool === 'dim') {
      const first = this.picks[0];
      if (first && 'ref' in first) {
        if (!hit.point || sameRef(hit.point, first.ref)) return;
        this.picks = [];
        const a = refPoint(s.entities, first.ref)!, b = refPoint(s.entities, hit.point)!;
        return void this.addConstraint({ id: fid(), t: 'distance', p1: first.ref, p2: hit.point, v: r2(Math.max(0.01, Math.hypot(b[0] - a[0], b[1] - a[1]))) });
      }
      if (hit.point) {
        this.picks = [{ ref: hit.point }];
        return this.drawSketch();
      }
      const ent = s.entities.find((x) => x.id === hit.ent);
      if (ent?.t === 'line') return void this.addConstraint({ id: fid(), t: 'length', e: ent.id, v: r2(Math.hypot(ent.b[0] - ent.a[0], ent.b[1] - ent.a[1])) });
      if (ent?.t === 'circle') return void this.addConstraint({ id: fid(), t: 'diameter', e: ent.id, v: r2(ent.r * 2) });
      if (ent?.t === 'arc') return void this.addConstraint({ id: fid(), t: 'diameter', e: ent.id, v: r2((circleThrough(ent.a, ent.m, ent.b)?.r ?? 1) * 2) });
      return;
    }
    const tool = CTOOLS.find((t) => t.id === this.tool)!;
    const need = tool.need[this.picks.length];
    let pick: Pick | null = null;
    if (need === 'p') pick = hit.point ? { ref: hit.point } : null;
    else if (hit.ent && (need === 'l' ? kind(hit.ent) === 'line' : need === 'r' ? round(hit.ent) : curve(hit.ent))) pick = { e: hit.ent };
    if (!pick) return;
    if (this.picks.some((p) => JSON.stringify(p) === JSON.stringify(pick))) return;
    this.picks.push(pick);
    if (this.picks.length < tool.need.length) return this.drawSketch();
    const [A, B, C] = this.picks as [Pick, Pick | undefined, Pick | undefined];
    this.picks = [];
    const id = fid();
    const P = (x: Pick | undefined) => (x && 'ref' in x ? x.ref : 'origin');
    const E = (x: Pick | undefined) => (x && 'e' in x ? x.e : '');
    let c: SketchConstraint | null = null;
    switch (tool.id) {
      case 'coincident':
        c = { id, t: 'coincident', p1: P(A), p2: P(B) };
        break;
      case 'fix':
        c = { id, t: 'fix', p: P(A), at: [...refPoint(s.entities, P(A))!] };
        break;
      case 'symmetric':
        c = { id, t: 'symmetric', p1: P(A), p2: P(B), e: E(C) };
        break;
      case 'horizontal':
      case 'vertical':
        c = { id, t: tool.id, e: E(A) };
        break;
      case 'equal':
      case 'tangent':
        if (kind(E(A)) === 'line' && kind(E(B)) === 'line' && tool.id === 'tangent') return void toast('Tangente precisa de um círculo ou arco.', 'info');
        if (tool.id === 'equal' && (kind(E(A)) === 'line') !== (kind(E(B)) === 'line')) return void toast('Igual vale entre duas linhas ou entre dois círculos/arcos.', 'info');
        c = { id, t: tool.id, e1: E(A), e2: E(B) };
        break;
      case 'parallel':
      case 'perpendicular':
      case 'concentric':
        c = { id, t: tool.id, e1: E(A), e2: E(B) };
        break;
      case 'midpoint':
      case 'onEntity': {
        const p = P(A);
        if (p !== 'origin' && p.e === E(B)) return void toast('Escolha um ponto de outra linha.', 'info');
        c = { id, t: tool.id, p, e: E(B) };
        break;
      }
      case 'angle': {
        const [l1, l2] = [s.entities.find((x) => x.id === E(A)), s.entities.find((x) => x.id === E(B))] as Extract<SketchEntity, { t: 'line' }>[];
        const dir = (l: typeof l1) => Math.atan2(l.b[1] - l.a[1], l.b[0] - l.a[0]);
        let v = ((dir(l2) - dir(l1)) * 180) / Math.PI;
        while (v > 180) v -= 360;
        while (v <= -180) v += 360;
        // Measure the smaller angle between the lines, the one people read off a corner.
        const flip = Math.abs(v) > 90;
        if (flip) v = v > 0 ? v - 180 : v + 180;
        c = { id, t: 'angle', e1: l1.id, e2: l2.id, v: r2(v), ...(flip ? { flip } : {}) };
        break;
      }
    }
    if (c) void this.addConstraint(c);
  }

  // ---------- history ----------

  private planeMenu(anchor: HTMLElement) {
    showMenu(
      [
        { heading: 'Novo esboço em' },
        ...(Object.keys(PLANES) as PlaneName[]).map((p) => ({ label: PLANES[p].label, icon: 'sketch', action: () => this.newSketch(p) })),
      ],
      anchor,
    );
  }

  private newSketch(plane: PlaneName) {
    const s: SketchFeature = { id: fid(), type: 'sketch', name: nextName(this.part, 'sketch'), plane, offset: 0, entities: [] };
    this.part.features.push(s);
    this.selected = s.id;
    this.enterSketch(s.id);
  }

  private addFeature(type: 'extrude' | 'revolve') {
    const sel = this.feature(this.selected);
    const sketch = sel?.type === 'sketch' ? sel : this.sketches().at(-1)!;
    const hasSolid = this.part.features.some((f) => f.type !== 'sketch');
    const base = { id: fid(), name: nextName(this.part, type), sketch: sketch.id, op: 'join' as BodyOp };
    const f: ExtrudeFeature | RevolveFeature =
      type === 'extrude' ? { ...base, type, distance: 10, symmetric: false, reverse: false } : { ...base, type, axis: 'y', angle: 360 };
    if (hasSolid && type === 'extrude') f.op = 'join';
    this.part.features.push(f);
    this.selected = f.id;
    this.changed();
  }

  private addModifier(type: 'hole' | 'fillet' | 'chamfer' | 'shell' | 'thread') {
    const base = { id: fid(), name: nextName(this.part, type) };
    const f: Feature =
      type === 'hole'
        ? { ...base, type, at: null, n: [0, 0, 1], diameter: 5, depth: 10, through: false, kind: 'simple', headDiameter: 9, headDepth: 3 }
        : type === 'shell'
          ? { ...base, type, faces: [], thickness: 2 }
          : type === 'thread'
            ? { ...base, type, face: null, pitch: 1.25, length: 0, lefthand: false }
            : { ...base, type, edges: [], all: false, size: type === 'fillet' ? 2 : 1 };
    this.part.features.push(f);
    this.select(f.id);
  }

  private addSweepOrLoft(type: 'sweep' | 'loft') {
    const sk = this.sketches();
    const base = { id: fid(), name: nextName(this.part, type), op: 'join' as BodyOp };
    // Last sketch as the profile, the one before it as the path (or the two last for a loft).
    const f: Feature =
      type === 'sweep'
        ? { ...base, type, sketch: sk.at(-1)!.id, path: sk.at(-2)!.id }
        : { ...base, type, sketches: sk.slice(-2).map((s) => s.id), ruled: false };
    if (this.part.features.some((x) => ['extrude', 'revolve', 'sweep', 'loft', 'import'].includes(x.type))) f.op = 'join';
    this.part.features.push(f);
    this.select(f.id);
    this.changed();
  }

  private importStep() {
    const input = el<HTMLInputElement>('<input type="file" accept=".step,.stp,.STEP,.STP" hidden />');
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      if (file.size > 30e6) return void toast('Arquivo STEP grande demais (máximo 30 MB).', 'error', 4000);
      const step = await file.text();
      const f: ImportFeature = { id: fid(), type: 'import', name: file.name.replace(/\.(step|stp)$/i, ''), file: file.name, step, op: 'join' };
      this.part.features.push(f);
      this.select(f.id);
      this.changed();
    });
    document.body.appendChild(input);
    input.click();
  }

  private async exportStep() {
    try {
      const blob = await exportStep(this.part);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${this.opts.title.trim().replace(/[\\/:*?"<>|]+/g, '_') || 'peca'}.step`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      if (this.part.features.some((f) => f.type === 'thread')) toast('STEP salvo. As roscas não vão no STEP (só na impressão).', 'info', 4500);
    } catch (e) {
      toast(`Não deu para salvar o STEP: ${(e as Error).message}`, 'error', 5000);
    }
  }

  private addPattern(kind: PatternFeature['kind']) {
    // Spread copies of the whole part just past its own width.
    const box = new THREE.Box3().setFromObject(this.solid);
    const w = box.isEmpty() ? 20 : r2(box.max.x - box.min.x + 5);
    const n = this.part.features.filter((x) => x.type === 'pattern' && (x.kind === 'mirror') === (kind === 'mirror')).length + 1;
    const f: PatternFeature = {
      id: fid(), type: 'pattern', name: kind === 'mirror' ? `Espelho ${n}` : `Padrão ${n}`, kind, sources: [],
      axis: kind === 'circular' ? 'z' : 'x', count: kind === 'circular' ? 4 : 3, spacing: w, angle: 360, axis2: null, count2: 2, spacing2: w, plane: 'YZ',
    };
    this.part.features.push(f);
    this.select(f.id);
    this.changed();
  }

  private deleteFeature(id: string) {
    const f = this.feature(id);
    if (!f) return;
    const users = this.part.features.filter((x) => featureSketches(x).includes(id) || (x.type === 'pattern' && x.sources.includes(id)));
    if (users.length) return toast(`“${f.name}” é usado por ${users.map((u) => `“${u.name}”`).join(', ')}. Apague essas operações antes.`, 'error', 4500);
    this.part.features = this.part.features.filter((x) => x.id !== id);
    if (this.selected === id) this.select(null);
    this.changed();
  }

  // ---------- sketch mode ----------

  private enterSketch(id: string) {
    const s = this.feature(id);
    if (!s || s.type !== 'sketch') return;
    this.sketchId = id;
    this.selected = id;
    this.tool = s.entities.length ? 'select' : 'line';
    this.pts = [];
    this.ptRefs = [];
    this.picks = [];
    this.chainStart = null;
    this.selEntity = null;
    this.selConstraint = null;
    this.dof = null;
    const P = PLANES[s.plane];
    const n = new THREE.Vector3(...P.n);
    this.look(n, new THREE.Vector3(...P.y), n.clone().multiplyScalar(s.offset));
    this.status.textContent = 'Desenhando o esboço. Botão direito gira a vista, o do meio arrasta.';
    this.status.classList.remove('warn');
    this.changed();
    void this.resolve(undefined, true);
  }

  private exitSketch() {
    this.sketchId = null;
    this.pts = [];
    this.picks = [];
    this.drag = null;
    this.selEntity = null;
    this.selConstraint = null;
    this.drawSketch();
    this.look(new THREE.Vector3(0.6, -0.8, 0.6), new THREE.Vector3(0, 0, 1));
    const sketch = this.feature(this.selected);
    // A first closed sketch is usually extruded next: offer it right away.
    if (sketch?.type === 'sketch' && sketchProfiles(sketch.entities).profiles.length && !this.part.features.some((f) => featureSketches(f).includes(sketch.id))) {
      this.addFeature('extrude');
    } else this.changed();
  }

  private setTool(t: Tool) {
    this.tool = t;
    this.pts = [];
    this.ptRefs = [];
    this.picks = [];
    this.chainStart = null;
    this.hover = null;
    if (t !== 'select') this.selEntity = this.selConstraint = null;
    this.renderSide();
    this.drawSketch();
  }

  private deleteEntity() {
    const s = this.sketchFeature;
    if (!s || !this.selEntity) return;
    const id = this.selEntity;
    s.entities = s.entities.filter((e) => e.id !== id);
    s.constraints = s.constraints?.filter((c) => !constraintEntities(c).includes(id));
    this.selEntity = null;
    void this.resolve();
  }

  /** Sketch-plane point under the mouse (unsnapped), or null when looking along the plane. */
  private planePoint(e: PointerEvent): V2 | null {
    const s = this.sketchFeature;
    if (!s) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
    const P = PLANES[s.plane];
    const n = new THREE.Vector3(...P.n);
    const hit = ray.ray.intersectPlane(new THREE.Plane(n, -s.offset), new THREE.Vector3());
    if (!hit) return null;
    return [hit.dot(new THREE.Vector3(...P.x)), hit.dot(new THREE.Vector3(...P.y))];
  }

  private toScreen(p: V2) {
    const s = this.sketchFeature!;
    const P = PLANES[s.plane];
    const w = new THREE.Vector3(...P.x).multiplyScalar(p[0]).add(new THREE.Vector3(...P.y).multiplyScalar(p[1])).add(new THREE.Vector3(...P.n).multiplyScalar(s.offset));
    w.project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return [((w.x + 1) / 2) * r.width, ((1 - w.y) / 2) * r.height];
  }

  /** Points other entities can attach to (constraints address them by reference). */
  private pointRefs(): { ref: PointRef | null; p: V2 }[] {
    const out: { ref: PointRef | null; p: V2 }[] = [{ ref: 'origin', p: [0, 0] }];
    for (const e of this.sketchFeature?.entities ?? []) {
      const ends = curveEnds(e);
      if (ends) out.push({ ref: { e: e.id, p: 'a' }, p: ends[0] }, { ref: { e: e.id, p: 'b' }, p: ends[1] });
      if (e.t === 'arc') {
        const c = circleThrough(e.a, e.m, e.b);
        if (c) out.push({ ref: { e: e.id, p: 'c' }, p: c.c });
      } else if ('c' in e) out.push({ ref: { e: e.id, p: 'c' }, p: e.c });
      if (e.t === 'rect') {
        const [x, y] = e.c, w = e.w / 2, h = e.h / 2;
        for (const p of [[x - w, y - h], [x + w, y - h], [x + w, y + h], [x - w, y + h]] as V2[]) out.push({ ref: null, p });
      }
    }
    return out;
  }

  private mouse(e: PointerEvent | MouseEvent) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  /** Existing point within a few pixels of the mouse. */
  private nearPoint(e: PointerEvent, px = 10) {
    const [mx, my] = this.mouse(e);
    let best: { ref: PointRef | null; p: V2 } | null = null;
    let bd = px;
    for (const k of this.pointRefs()) {
      const [sx, sy] = this.toScreen(k.p);
      const d = Math.hypot(sx - mx, sy - my);
      if (d < bd) (bd = d), (best = k);
    }
    return best;
  }

  private gridSnap(p: V2): V2 {
    const g = this.gridStep;
    return g ? [r2(Math.round(p[0] / g) * g), r2(Math.round(p[1] / g) * g)] : [r2(p[0]), r2(p[1])];
  }

  /** Snap to existing points within a few pixels, else to the grid. */
  private snap(p: V2, e: PointerEvent): { p: V2; ref: PointRef | null } {
    const near = this.nearPoint(e);
    if (near) return { p: [...near.p], ref: near.ref };
    return { p: this.gridSnap(p), ref: null };
  }

  /** What a click lands on: a point (preferred when close) and/or a curve. */
  private hitTest(e: PointerEvent): { point: PointRef | null; ent: string | null } {
    const near = this.nearPoint(e, 9);
    return { point: near?.ref ?? null, ent: this.pick(e) };
  }

  private pointerMove(e: PointerEvent) {
    if (this.pickFeature && e.buttons === 0) {
      const h = this.pickAt(e);
      if (JSON.stringify(h) !== JSON.stringify(this.hoverPick)) {
        this.hoverPick = h;
        this.renderer.domElement.style.cursor = h ? 'pointer' : '';
        this.drawPicks();
      }
      return;
    }
    if (!this.sketchId) return;
    const canvas = this.renderer.domElement;
    if (this.splineDrag) {
      const p = this.planePoint(e);
      const sp = this.sketchFeature!.entities.find((x) => x.id === this.splineDrag!.e);
      if (p && sp?.t === 'spline') sp.pts[this.splineDrag.i] = this.gridSnap(p);
      this.drawSketch();
      return;
    }
    if (this.drag) {
      const p = this.planePoint(e);
      if (p) this.dragTo(this.gridSnap(p));
      return;
    }
    if (this.tool === 'select') {
      const near = this.nearPoint(e, 9);
      canvas.style.cursor = near?.ref && near.ref !== 'origin' ? 'grab' : '';
      return;
    }
    canvas.style.cursor = '';
    if (isCon(this.tool)) return;
    if (isMod(this.tool)) {
      canvas.style.cursor = 'crosshair';
      return;
    }
    const p = this.planePoint(e);
    this.hover = p ? this.snap(p, e).p : null;
    this.drawSketch();
    if (this.hover) this.status.textContent = `X ${fmt(this.hover[0])}  Y ${fmt(this.hover[1])} mm${this.pts.length ? `  ·  distância ${fmt(Math.hypot(this.hover[0] - this.pts.at(-1)![0], this.hover[1] - this.pts.at(-1)![1]))} mm` : ''}`;
  }

  /** Drag a point; the solver keeps every constraint while it follows the mouse. */
  private dragTo(to: V2) {
    const d = this.drag!;
    d.to = to;
    if (d.busy) return;
    const run = async (): Promise<void> => {
      const target = d.to;
      const r = await solveSketch(this.sketchFeature!, { ref: d.ref, to: target });
      if (r.ok) this.dof = r.dof;
      this.drawSketch();
      if (d.to !== target && this.sketchId) return run();
    };
    d.busy = run().finally(() => (d.busy = null));
  }

  private async endDrag() {
    if (this.splineDrag) {
      this.splineDrag = null;
      return this.changed();
    }
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.renderer.domElement.style.cursor = '';
    await d.busy;
    this.changed();
  }

  private pointerDown(e: PointerEvent) {
    if (e.button === 0 && this.measuring && !this.sketchId) return this.measureClick(e);
    if (e.button === 0 && this.pickFeature) return this.pickClick(e);
    if (!this.sketchId || e.button !== 0) return;
    if (this.tool === 'select') {
      const near = this.nearPoint(e, 9);
      const inner = near?.ref ? null : this.splinePointNear(e);
      this.selConstraint = null;
      if (inner) {
        this.splineDrag = inner;
        this.selEntity = inner.e;
        this.renderer.domElement.setPointerCapture?.(e.pointerId);
      } else if (near?.ref && near.ref !== 'origin') {
        this.drag = { ref: near.ref, to: near.p, busy: null };
        this.selEntity = near.ref.e;
        this.renderer.domElement.setPointerCapture?.(e.pointerId);
        this.renderer.domElement.style.cursor = 'grabbing';
      } else this.selEntity = this.pick(e);
      this.renderSide();
      this.drawSketch();
      return;
    }
    if (isCon(this.tool)) return this.constraintClick(e);
    if (isMod(this.tool)) return void this.modClick(e);
    const raw = this.planePoint(e);
    if (!raw) return;
    const { p, ref } = this.snap(raw, e);
    const same = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;
    this.pts.push(p);
    this.ptRefs.push(ref);
    const refs = this.ptRefs;
    const reset = () => ((this.pts = []), (this.ptRefs = []));
    switch (this.tool) {
      case 'line': {
        if (this.pts.length === 1) {
          this.chainStart ??= p;
          return this.drawSketch();
        }
        const [a, b] = this.pts;
        reset();
        if (same(a, b)) return;
        const l = { id: fid(), t: 'line' as const, a, b };
        void this.addEntities([l], [...this.joinTo({ e: l.id, p: 'a' }, refs[0]), ...this.joinTo({ e: l.id, p: 'b' }, refs[1]), ...this.straight(l)]);
        if (this.chainStart && same(b, this.chainStart)) this.chainStart = null;
        else (this.pts = [b]), (this.ptRefs = [{ e: l.id, p: 'b' }]);
        return this.drawSketch();
      }
      case 'rect': {
        if (this.pts.length < 2) return this.drawSketch();
        const [a, b] = this.pts;
        reset();
        if (Math.abs(a[0] - b[0]) < 1e-6 || Math.abs(a[1] - b[1]) < 1e-6) return;
        // Four lines held square by constraints, so each side can be dimensioned.
        const c: V2[] = [a, [b[0], a[1]], b, [a[0], b[1]]];
        const ls = c.map((p, i) => ({ id: fid(), t: 'line' as const, a: [...p] as V2, b: [...c[(i + 1) % 4]] as V2 }));
        const cons: SketchConstraint[] = ls.map((l, i) => ({ id: fid(), t: 'coincident', p1: { e: l.id, p: 'b' }, p2: { e: ls[(i + 1) % 4].id, p: 'a' } }));
        cons.push(...ls.map((l, i): SketchConstraint => ({ id: fid(), t: i % 2 ? 'vertical' : 'horizontal', e: l.id })));
        cons.push(...this.joinTo({ e: ls[0].id, p: 'a' }, refs[0]), ...this.joinTo({ e: ls[1].id, p: 'b' }, refs[1]));
        void this.addEntities(ls, cons);
        return;
      }
      case 'circle':
      case 'polygon': {
        if (this.pts.length < 2) return this.drawSketch();
        const [a, b] = this.pts;
        reset();
        if (same(a, b)) return;
        const r = r2(Math.hypot(b[0] - a[0], b[1] - a[1]));
        const ent: SketchEntity = this.tool === 'circle' ? { id: fid(), t: 'circle', c: a, r } : { id: fid(), t: 'polygon', c: a, r, n: this.polygonSides };
        void this.addEntities([ent], this.joinTo({ e: ent.id, p: 'c' }, refs[0]));
        return;
      }
      case 'arc': {
        if (this.pts.length < 3) return this.drawSketch();
        const [a, b, m] = this.pts;
        reset();
        if (same(a, b) || !circleThrough(a, m, b)) return;
        const arc = { id: fid(), t: 'arc' as const, a, b, m };
        void this.addEntities([arc], [...this.joinTo({ e: arc.id, p: 'a' }, refs[0]), ...this.joinTo({ e: arc.id, p: 'b' }, refs[1])]);
        return;
      }
      case 'ellipse': {
        if (this.pts.length < 3) return this.drawSketch();
        const [c, major, h] = this.pts;
        reset();
        const rx = r2(Math.hypot(major[0] - c[0], major[1] - c[1])), ry = ellipseMinor(c, major, h);
        if (rx < 1e-3 || ry < 1e-3) return;
        const el: SketchEntity = { id: fid(), t: 'ellipse', c, rx, ry, rot: r2((Math.atan2(major[1] - c[1], major[0] - c[0]) * 180) / Math.PI) };
        void this.addEntities([el], this.joinTo({ e: el.id, p: 'c' }, refs[0]));
        return;
      }
      case 'spline': {
        const n = this.pts.length;
        // Clicking the first point again closes the curve; the same point twice finishes it.
        if (n > 2 && same(p, this.pts[0])) return void this.finishSpline(true);
        if (n > 1 && same(p, this.pts[n - 2])) {
          this.pts.pop();
          this.ptRefs.pop();
          return void this.finishSpline(false);
        }
        return this.drawSketch();
      }
      case 'slot': {
        if (this.pts.length < 3) return this.drawSketch();
        const [a, b, h] = this.pts;
        reset();
        const sl = slot(a, b, slotRadius(a, b, h));
        if (sl) void this.addEntities(sl.ents, sl.cons);
        return;
      }
      case 'text': {
        reset();
        const font = DEFAULT_FONT_ID;
        void textOutline('Texto', font, 10).then((outline) => {
          const t: SketchEntity = { id: fid(), t: 'text', c: p, text: 'Texto', size: 10, font, rot: 0, outline };
          this.tool = 'select';
          this.selEntity = t.id;
          return this.addEntities([t], this.joinTo({ e: t.id, p: 'c' }, refs[0]));
        }).then(() => {
          const inp = this.side.querySelector<HTMLInputElement>('[data-k=text]');
          inp?.focus();
          inp?.select();
        }).catch(() => toast('Não consegui carregar a fonte.', 'error'));
        return;
      }
    }
  }

  /** End the spline being drawn (closed: back to its first point). */
  private async finishSpline(closed: boolean) {
    const pts = [...this.pts];
    const refs = [...this.ptRefs];
    this.pts = [];
    this.ptRefs = [];
    if (closed) pts[pts.length - 1] = [...pts[0]];
    if (pts.length < 2) return this.drawSketch();
    const sp: SketchEntity = { id: fid(), t: 'spline', pts };
    const cons = closed ? [] : [...this.joinTo({ e: sp.id, p: 'a' }, refs[0]), ...this.joinTo({ e: sp.id, p: 'b' }, refs[pts.length - 1])];
    await this.addEntities([sp], cons);
  }

  /** Inner point of a spline under the mouse (its ends are ordinary solver points). */
  private splinePointNear(e: PointerEvent): { e: string; i: number } | null {
    const [mx, my] = this.mouse(e);
    for (const ent of this.sketchFeature?.entities ?? []) {
      if (ent.t !== 'spline') continue;
      for (let i = 1; i < ent.pts.length - 1; i++) {
        const [sx, sy] = this.toScreen(ent.pts[i]);
        if (Math.hypot(sx - mx, sy - my) < 9) return { e: ent.id, i };
      }
    }
    return null;
  }

  /** Trim, extend, offset and corner tools. */
  private async modClick(e: PointerEvent) {
    const s = this.sketchFeature!;
    const raw = this.planePoint(e);
    if (!raw) return;
    const before = snapshot(s);
    if (this.tool === 'sfillet' || this.tool === 'schamfer') {
      const at = this.nearPoint(e, 14)?.p ?? raw;
      const err = corner(s, at, this.modSize, this.tool === 'sfillet' ? 'fillet' : 'chamfer');
      if (err) return toast(err);
      return void this.resolve(before);
    }
    const id = this.pick(e);
    if (!id) return;
    if (this.tool === 'offset') {
      const r = offset(s, id, this.modSize);
      if (typeof r === 'string') return toast(r);
      return void this.addEntities(r.ents, r.cons);
    }
    const r = this.tool === 'trim' ? trim(s, id, raw) : extend(s, id, raw);
    if (r === 'unsupported') return toast(this.tool === 'trim' ? 'Aparar funciona em linhas, arcos e círculos.' : 'Estender funciona em linhas.');
    if (!r) return toast(this.tool === 'trim' ? 'Essa linha não cruza nenhuma outra. Para tirar tudo, selecione e aperte Delete.' : 'A linha não encontra nada nessa direção.');
    if (this.selEntity && !s.entities.some((x) => x.id === this.selEntity)) this.selEntity = null;
    void this.resolve(before);
  }

  /** Clicking a constraint symbol or dimension selects it. */
  private markClick(e: PointerEvent) {
    const m = (e.target as HTMLElement).closest<HTMLElement>('[data-c]');
    if (!m) return;
    e.stopPropagation();
    e.preventDefault();
    this.selConstraint = m.dataset.c!;
    this.selEntity = null;
    if (this.tool !== 'select') this.setTool('select');
    this.renderSide();
    this.drawSketch();
    const inp = this.side.querySelector<HTMLInputElement>('[data-k=cval]');
    if (inp) inp.focus(), inp.select();
  }

  /** Entity whose drawn outline passes closest to the mouse. */
  private pick(e: PointerEvent): string | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    let best: string | null = null;
    let bd = 8;
    for (const ent of this.sketchFeature!.entities)
      for (const line of entityLines(ent)) {
        const pts = line.map((p) => this.toScreen(p));
        for (let i = 1; i < pts.length; i++) {
          const d = segDist(mx, my, pts[i - 1], pts[i]);
          if (d < bd) (bd = d), (best = ent.id);
        }
      }
    return best;
  }

  private key(e: KeyboardEvent) {
    if ((e.target as HTMLElement).matches('input, textarea, select')) {
      if (e.key === 'Enter') (e.target as HTMLElement).blur();
      e.stopPropagation();
      return;
    }
    // The main window's shortcuts must not act on the scene behind.
    e.stopPropagation();
    const k = e.key.toLowerCase();
    if (!this.sketchId) {
      if (k === 'escape') this.measuring ? this.toggleMeasure() : this.select(null);
      return;
    }
    if ((k === 'escape' || k === 'enter') && this.tool === 'spline' && this.pts.length >= 2) return void this.finishSpline(false);
    if (k === 'escape') {
      if (this.pts.length || this.chainStart || this.picks.length) {
        this.pts = [];
        this.ptRefs = [];
        this.picks = [];
        this.chainStart = null;
      } else if (this.tool !== 'select') this.setTool('select');
      else if (this.selEntity || this.selConstraint) {
        this.selEntity = this.selConstraint = null;
        this.renderSide();
      } else this.exitSketch();
      return this.drawSketch();
    }
    if (k === 'enter') return this.exitSketch();
    if (k === 'delete' || k === 'backspace') {
      if (this.selConstraint) return e.preventDefault(), this.deleteConstraint();
      if (this.selEntity) return e.preventDefault(), this.deleteEntity();
    }
    const t = [...TOOLS, ...MTOOLS, ...CTOOLS].find((x) => x.key?.toLowerCase() === k);
    if (t && !e.ctrlKey && !e.metaKey) this.setTool(t.id);
  }

  // ---------- sketch drawing ----------

  private drawSketch() {
    for (const c of [...this.sketch.children]) {
      this.sketch.remove(c);
      (c as THREE.Mesh).geometry?.dispose();
    }
    const s = this.sketchFeature;
    this.drawMarks();
    if (!s) return;
    const P = PLANES[s.plane];
    const basis = new THREE.Matrix4().makeBasis(new THREE.Vector3(...P.x), new THREE.Vector3(...P.y), new THREE.Vector3(...P.n));
    basis.setPosition(new THREE.Vector3(...P.n).multiplyScalar(s.offset));
    this.sketch.matrix.copy(basis);
    this.sketch.matrixWorldNeedsUpdate = true;

    const accent = new THREE.Color(css('--accent'));
    const ink = new THREE.Color(css('--text'));
    // Grid of the sketch plane.
    const grid: number[] = [], major: number[] = [];
    for (let i = -100; i <= 100; i += 5) (i % 25 ? grid : major).push(i, -100, 0, i, 100, 0, -100, i, 0, 100, i, 0);
    this.sketch.add(lines(grid, new THREE.LineBasicMaterial({ color: ink, transparent: true, opacity: 0.08 })));
    this.sketch.add(lines(major, new THREE.LineBasicMaterial({ color: ink, transparent: true, opacity: 0.18 })));
    // Sketch axes, lifted off the grid so they are not hidden by it.
    this.sketch.add(lines([-100, 0, 0.005, 100, 0, 0.005], new THREE.LineBasicMaterial({ color: 0xef5a5f })));
    this.sketch.add(lines([0, -100, 0.005, 0, 100, 0.005], new THREE.LineBasicMaterial({ color: 0x2fb36b })));
    if (s.image) {
      const img = s.image;
      if (this.imageTex?.src !== img.src) {
        this.imageTex?.tex.dispose();
        const tex = new THREE.TextureLoader().load(img.src);
        tex.colorSpace = THREE.SRGBColorSpace;
        this.imageTex = { src: img.src, tex };
      }
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(img.w, img.w * img.aspect),
        new THREE.MeshBasicMaterial({ map: this.imageTex.tex, transparent: true, opacity: img.opacity, depthWrite: false, side: THREE.DoubleSide }),
      );
      m.position.set(img.c[0], img.c[1], -0.02);
      this.sketch.add(m);
    }

    // Closed outlines filled so it is clear what becomes solid.
    for (const prof of sketchProfiles(s.entities).profiles) {
      const shape = new THREE.Shape(profilePoints(prof, 32).map(([x, y]) => new THREE.Vector2(x, y)));
      const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false }));
      m.position.z = 0.01;
      this.sketch.add(m);
    }
    const con = s.constraints?.find((c) => c.id === this.selConstraint);
    const lit = new Set([...(con ? constraintEntities(con) : []), ...this.picks.flatMap((p) => ('e' in p ? [p.e] : []))]);
    for (const p of this.picks) if ('ref' in p) this.sketch.add(this.dot(refPoint(s.entities, p.ref) ?? [0, 0], accent));
    if (con && 'p' in con) this.sketch.add(this.dot(refPoint(s.entities, con.p) ?? [0, 0], accent));
    if (con && 'p1' in con) for (const r of [con.p1, con.p2]) this.sketch.add(this.dot(refPoint(s.entities, r) ?? [0, 0], accent));
    for (const ent of s.entities) {
      const on = ent.id === this.selEntity || lit.has(ent.id);
      const mat = ent.construction
        ? new THREE.LineDashedMaterial({ color: on ? accent : ink, dashSize: 2, gapSize: 1.5, transparent: true, opacity: 0.6 })
        : new THREE.LineBasicMaterial({ color: on ? accent : ink });
      for (const pts of entityLines(ent)) {
        const l = polyline(pts, mat);
        if (ent.construction) l.computeLineDistances();
        this.sketch.add(l);
      }
      // Lines are one pixel wide: mark the selected one's points too.
      if (on) for (const p of this.entityHandles(ent)) this.sketch.add(this.dot(p, accent));
    }
    // Preview of what the current tool will add.
    if (this.hover && this.tool !== 'select') {
      const pre = new THREE.LineDashedMaterial({ color: accent, dashSize: 1.5, gapSize: 1 });
      const ghost = this.ghost();
      if (ghost) {
        const l = polyline(ghost, pre);
        l.computeLineDistances();
        this.sketch.add(l);
      }
      this.sketch.add(this.dot(this.hover, accent));
    }
  }

  /** Constraint symbols and dimension labels, laid over the view (positions follow the camera every frame). */
  private drawMarks() {
    const s = this.sketchFeature;
    const key = s ? JSON.stringify([s.id, s.constraints ?? [], this.selConstraint]) : '';
    if (key === this.marksKey) return;
    this.marksKey = key;
    this.marks.innerHTML = '';
    this.markPos = [];
    if (!s) return;
    const ent = (id: string) => s.entities.find((x) => x.id === id);
    const slots = new Map<string, number>();
    const slot = (k: string) => {
      const n = slots.get(k) ?? 0;
      slots.set(k, n + 1);
      return n;
    };
    const add = (c: SketchConstraint, text: string, pos: () => number[] | null, cls = '') => {
      const el = document.createElement('div');
      el.className = `pe-mark ${cls} ${c.id === this.selConstraint ? 'on' : ''}`;
      el.dataset.c = c.id;
      el.title = CLABEL[c.t];
      el.textContent = text;
      this.marks.appendChild(el);
      this.markPos.push({ el, pos });
    };
    const lineFrame = (e: Extract<SketchEntity, { t: 'line' }>) => {
      const a = this.toScreen(e.a), b = this.toScreen(e.b);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const d = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
      return { mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], d, n: [-d[1], d[0]] };
    };
    // A symbol next to a curve; several on the same curve line up beside each other.
    const beside = (id: string) => {
      const k = slot(id);
      return () => {
        const e = ent(id);
        if (!e) return null;
        if (e.t === 'line') {
          const f = lineFrame(e);
          return [f.mid[0] + f.d[0] * k * 18 + f.n[0] * 14, f.mid[1] + f.d[1] * k * 18 + f.n[1] * 14];
        }
        const at: V2 = e.t === 'arc' ? e.m : e.t === 'circle' ? [e.c[0] + e.r * Math.SQRT1_2, e.c[1] - e.r * Math.SQRT1_2] : e.t === 'spline' ? e.pts[e.pts.length >> 1] : e.c;
        const p = this.toScreen(at);
        return [p[0] + 12 + k * 18, p[1] + 12];
      };
    };
    const atPoint = (r: PointRef) => {
      const k = slot(JSON.stringify(r));
      return () => {
        const p = refPoint(s.entities, r);
        if (!p) return null;
        const q = this.toScreen(p);
        return [q[0] + 11 + k * 16, q[1] - 11];
      };
    };
    for (const c of s.constraints ?? []) {
      switch (c.t) {
        case 'coincident':
          add(c, GLYPH.coincident!, atPoint(c.p1), 'pt');
          break;
        case 'symmetric':
          add(c, GLYPH.symmetric!, atPoint(c.p1));
          add(c, GLYPH.symmetric!, atPoint(c.p2));
          break;
        case 'horizontal':
        case 'vertical':
          add(c, GLYPH[c.t]!, beside(c.e));
          break;
        case 'parallel':
        case 'perpendicular':
        case 'equal':
        case 'tangent':
        case 'concentric':
          add(c, GLYPH[c.t]!, beside(c.e1));
          add(c, GLYPH[c.t]!, beside(c.e2));
          break;
        case 'midpoint':
        case 'onEntity':
        case 'fix':
          add(c, GLYPH[c.t]!, atPoint(c.p));
          break;
        case 'length':
          add(c, fmt(c.v), () => {
            const e = ent(c.e);
            if (e?.t !== 'line') return null;
            const f = lineFrame(e);
            return [f.mid[0] - f.n[0] * 16, f.mid[1] - f.n[1] * 16];
          }, 'dim');
          break;
        case 'diameter':
          add(c, `⌀${fmt(c.v)}`, () => {
            const e = ent(c.e);
            const circ = e?.t === 'circle' ? { c: e.c, r: e.r } : e?.t === 'arc' ? circleThrough(e.a, e.m, e.b) : null;
            if (!circ) return null;
            const o = this.toScreen(circ.c);
            const p = this.toScreen([circ.c[0] + circ.r * Math.SQRT1_2, circ.c[1] + circ.r * Math.SQRT1_2]);
            const l = Math.hypot(p[0] - o[0], p[1] - o[1]) || 1;
            return [p[0] + ((p[0] - o[0]) / l) * 20, p[1] + ((p[1] - o[1]) / l) * 20];
          }, 'dim');
          break;
        case 'distance':
          add(c, fmt(c.v), () => {
            const a = refPoint(s.entities, c.p1), b = refPoint(s.entities, c.p2);
            if (!a || !b) return null;
            const f = lineFrame({ id: '', t: 'line', a, b });
            return [f.mid[0] - f.n[0] * 16, f.mid[1] - f.n[1] * 16];
          }, 'dim');
          break;
        case 'angle':
          add(c, `${fmt(Math.abs(c.v))}°`, () => {
            const a = ent(c.e1), b = ent(c.e2);
            if (a?.t !== 'line' || b?.t !== 'line') return null;
            const fa = lineFrame(a), fb = lineFrame(b);
            return [(fa.mid[0] + fb.mid[0]) / 2, (fa.mid[1] + fb.mid[1]) / 2];
          }, 'dim');
          break;
      }
    }
  }

  /** A small disc on the sketch plane, sized for the current zoom. */
  private dot(p: V2, color: THREE.Color) {
    const d = new THREE.Mesh(new THREE.CircleGeometry(this.camera.position.distanceTo(this.orbit.target) * 0.006, 16), new THREE.MeshBasicMaterial({ color, depthTest: false }));
    d.position.set(p[0], p[1], 0.05);
    d.renderOrder = 5;
    return d;
  }

  private entityHandles(e: SketchEntity): V2[] {
    if (e.t === 'line') return [e.a, e.b];
    if (e.t === 'arc') return [e.a, e.m, e.b];
    if (e.t === 'spline') return e.pts;
    return 'c' in e ? [e.c] : [];
  }

  private ghost(): V2[] | null {
    const h = this.hover!;
    const [a, b] = this.pts;
    switch (this.tool) {
      case 'line':
        return a ? [a, h] : null;
      case 'rect':
        return a ? [a, [h[0], a[1]], h, [a[0], h[1]], a] : null;
      case 'circle':
        return a ? entityPoints({ id: '', t: 'circle', c: a, r: Math.hypot(h[0] - a[0], h[1] - a[1]) }) : null;
      case 'polygon':
        return a ? entityPoints({ id: '', t: 'polygon', c: a, r: Math.hypot(h[0] - a[0], h[1] - a[1]), n: this.polygonSides }) : null;
      case 'arc':
        if (!a) return null;
        if (!b) return [a, h];
        return arcPoints(a, h, b, 32);
      case 'ellipse': {
        if (!a) return null;
        const major = b ?? h;
        const rx = Math.hypot(major[0] - a[0], major[1] - a[1]);
        const rot = (Math.atan2(major[1] - a[1], major[0] - a[0]) * 180) / Math.PI;
        if (!b) return [a, h];
        const ry = ellipseMinor(a, b, h);
        const pts = ellipsePoints({ c: a, rx, ry: Math.max(ry, 0.01), rot }, 72);
        return [...pts, pts[0]];
      }
      case 'spline':
        return this.pts.length ? splinePoints([...this.pts, h], 12) : null;
      case 'slot': {
        if (!a) return null;
        if (!b) return [a, h];
        const sl = slot(a, b, slotRadius(a, b, h));
        return sl ? sl.ents.flatMap((e) => entityPoints(e)) : [a, b];
      }
    }
    return null;
  }

  // ---------- finish ----------

  private async done() {
    if (this.sketchId) this.exitSketch();
    clearTimeout(this.rebuildTimer);
    const r = await buildPart(this.part);
    if (r.error) return toast(`${this.feature(r.error.feature)?.name ?? 'Erro'}: ${r.error.message}`, 'error', 5000);
    if (!r.mesh) return toast('A peça ainda não tem nenhum sólido: crie um esboço fechado e extrude.', 'error', 4500);
    this.close();
    this.opts.onDone(this.part, r.mesh);
  }

  private cancel() {
    if (JSON.stringify(this.part) !== this.original && !confirm('Descartar as alterações desta peça?')) return;
    this.close();
  }

  private close() {
    clearTimeout(this.rebuildTimer);
    removeEventListener('keydown', this.onKey, true);
    this.resize.disconnect();
    this.renderer.setAnimationLoop(null);
    this.orbit.dispose();
    this.renderer.dispose();
    this.root.remove();
    document.body.classList.remove('part-open');
  }
}

// ---------- geometry helpers ----------

function entityPoints(e: SketchEntity): V2[] {
  switch (e.t) {
    case 'line':
      return [e.a, e.b];
    case 'arc':
      return arcPoints(e.a, e.m, e.b, 32);
    case 'circle':
      return [...profilePoints({ kind: 'circle', c: e.c, r: e.r }, 32), [e.c[0] + e.r, e.c[1]]];
    case 'rect': {
      const [x, y] = e.c, w = e.w / 2, h = e.h / 2;
      return [[x - w, y - h], [x + w, y - h], [x + w, y + h], [x - w, y + h], [x - w, y - h]];
    }
    case 'polygon':
      return Array.from({ length: e.n + 1 }, (_, i) => {
        const a = Math.PI / 2 + (i * 2 * Math.PI) / e.n;
        return [e.c[0] + e.r * Math.cos(a), e.c[1] + e.r * Math.sin(a)] as V2;
      });
    case 'ellipse': {
      const pts = ellipsePoints(e, 72);
      return [...pts, pts[0]];
    }
    case 'spline':
      return e.pts.length >= 2 ? splinePoints(e.pts, 16) : e.pts;
    case 'text':
      return entityLines(e)[0] ?? [e.c];
  }
}

/** Distance from p to the line through a and b. */
function lineDist(a: V2, b: V2, p: V2) {
  const d = [b[0] - a[0], b[1] - a[1]];
  const l = Math.hypot(d[0], d[1]) || 1;
  return Math.abs((p[0] - a[0]) * d[1] - (p[1] - a[1]) * d[0]) / l;
}
const ellipseMinor = (c: V2, major: V2, p: V2) => r2(lineDist(c, major, p));
const slotRadius = (a: V2, b: V2, p: V2) => r2(lineDist(a, b, p));

/** Every drawn outline of an entity (text has many). */
function entityLines(e: SketchEntity): V2[][] {
  if (e.t === 'text') return textContours(e).map((c) => [...c, c[0]]);
  return [entityPoints(e)];
}

async function textOutline(text: string, font: string, size: number): Promise<V2[][]> {
  const f = await loadFont(font || DEFAULT_FONT_ID);
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return textToPolygons(f, { text: text || ' ', size, letterSpacing: 0, lineHeight: 1.2, align: 'center' }).map((c) => c.map(([x, y]) => [r(x), r(y)] as V2));
}

function polyline(pts: V2[], mat: THREE.Material) {
  const g = new THREE.BufferGeometry().setFromPoints(pts.map(([x, y]) => new THREE.Vector3(x, y, 0.02)));
  return new THREE.Line(g, mat);
}

function lines(flat: number[], mat: THREE.Material) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(flat, 3));
  return new THREE.LineSegments(g, mat);
}

function segDist(px: number, py: number, a: number[], b: number[]) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

