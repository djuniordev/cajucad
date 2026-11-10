/**
 * Part workspace: a parametric history (sketches → extrude/revolve) edited in its own
 * full-screen view, rebuilt by the OpenCascade kernel. On "Concluir" the part goes back
 * to the scene as a mesh node that remembers its history.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { el, esc, showMenu, toast } from '../ui/dom';
import { icon } from '../ui/icons';
import { buildPart, loadKernel, type PartMesh } from './kernel';
import {
  PLANES,
  arcPoints,
  fid,

  nextName,
  profilePoints,
  sketchProfiles,
  type BodyOp,
  type ExtrudeFeature,
  type Feature,
  type PartDef,
  type PlaneName,
  type RevolveFeature,
  type SketchEntity,
  type SketchFeature,
  type V2,
} from './model';
import './part.css';

type Tool = 'select' | 'line' | 'rect' | 'circle' | 'arc' | 'polygon';

const TOOLS: { id: Tool; label: string; key: string; hint: string }[] = [
  { id: 'select', label: 'Selecionar', key: 'V', hint: 'Clique numa linha para ver e mudar as medidas. Delete apaga.' },
  { id: 'line', label: 'Linha', key: 'L', hint: 'Clique os pontos. Volte ao primeiro ponto para fechar. Esc termina.' },
  { id: 'rect', label: 'Retângulo', key: 'R', hint: 'Clique um canto e depois o canto oposto.' },
  { id: 'circle', label: 'Círculo', key: 'C', hint: 'Clique o centro e depois um ponto da borda.' },
  { id: 'arc', label: 'Arco', key: 'A', hint: 'Clique o início, o fim e depois um ponto por onde o arco passa.' },
  { id: 'polygon', label: 'Polígono', key: 'P', hint: 'Clique o centro e depois um vértice.' },
];

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
    await loadKernel();
  } catch (e) {
    toast(`Não consegui carregar o motor de modelagem: ${(e as Error).message}`, 'error', 6000);
    return;
  } finally {
    wait.remove();
  }
  new PartEditor(opts);
}

class PartEditor {
  private part: PartDef;
  private readonly original: string;
  private selected: string | null = null;
  private errors = new Map<string, string>();

  // sketch mode
  private sketchId: string | null = null;
  private tool: Tool = 'select';
  private pts: V2[] = [];
  private chainStart: V2 | null = null;
  private hover: V2 | null = null;
  private selEntity: string | null = null;
  private gridStep = 1;
  private polygonSides = 6;

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
          <button class="btn" data-act="cancel">Cancelar</button>
          <button class="btn primary" data-act="done">${icon('check', 16)}<span class="lbl">Concluir peça</span></button>
        </header>
        <aside class="pe-side glass"></aside>
        <div class="pe-view"></div>
        <div class="pe-status glass"></div>
      </div>`);
    this.side = this.root.querySelector('.pe-side')!;
    this.host = this.root.querySelector('.pe-view')!;
    this.status = this.root.querySelector('.pe-status')!;
    document.body.appendChild(this.root);

    // ----- three -----
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
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
    this.scene.add(sun, this.solid, this.sketch, this.floorGrid(), new THREE.AxesHelper(20));
    this.sketch.matrixAutoUpdate = false;
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(this.host);
    this.fit();
    this.renderer.setAnimationLoop(() => this.frame());

    // ----- events -----
    this.root.querySelector('[data-act=cancel]')!.addEventListener('click', () => this.cancel());
    this.root.querySelector('[data-act=done]')!.addEventListener('click', () => this.done());
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointermove', (e) => this.pointerMove(e));
    canvas.addEventListener('pointerdown', (e) => this.pointerDown(e));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('keydown', this.onKey, true);
    this.side.addEventListener('change', (e) => this.fieldChange(e));
    this.side.addEventListener('click', (e) => this.sideClick(e));

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
    let r;
    try {
      r = await buildPart(part);
    } catch (e) {
      r = { mesh: null, error: { feature: '', message: (e as Error).message } };
    }
    if (seq !== this.buildSeq) return;
    this.errors.clear();
    if (r.error) this.errors.set(r.error.feature, r.error.message);
    this.showSolid(r.mesh);
    if (!this.sketchId) this.status.textContent = r.error ? `⚠ ${this.feature(r.error.feature)?.name ?? 'Erro'}: ${r.error.message}` : r.mesh ? 'Peça atualizada.' : 'Crie um esboço e depois extrude ou revolva.';
    this.status.classList.toggle('warn', !!r.error);
    this.renderSide();
  }

  private showSolid(mesh: PartMesh | null) {
    for (const c of [...this.solid.children]) {
      this.solid.remove(c);
      (c as THREE.Mesh).geometry?.dispose();
    }
    if (!mesh) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(mesh.positions, 3));
    g.setIndex(mesh.indices);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: css('--accent'), roughness: 0.55, metalness: 0.05, transparent: !!this.sketchId, opacity: this.sketchId ? 0.35 : 1, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(g, 25), new THREE.LineBasicMaterial({ color: 0x2a2020, transparent: true, opacity: 0.55 }));
    this.solid.add(m, edges);
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
        const ic = f.type === 'sketch' ? 'sketch' : f.type;
        return `<div class="pe-feat ${f.id === this.selected ? 'on' : ''} ${err ? 'bad' : ''}" data-feat="${f.id}">
          ${icon(ic, 16)}<span class="nm">${esc(f.name)}</span>${err ? `<span class="err" data-tip="${esc(err)}">${icon('warning', 14)}</span>` : ''}
          ${f.type === 'sketch' ? `<button class="btn icon-only sm" data-act="edit-sketch" data-id="${f.id}" data-tip="Editar esboço">${icon('sketch', 15)}</button>` : ''}
          <button class="btn icon-only sm danger" data-act="del" data-id="${f.id}" data-tip="Apagar">${icon('trash', 15)}</button>
        </div>`;
      })
      .join('');
    const hasSketch = this.sketches().length > 0;
    return `
      <div class="panel-title">Histórico</div>
      <div class="pe-feats">${rows || '<div class="hint">Ainda vazio.</div>'}</div>
      <div class="pe-actions">
        <button class="btn soft" data-act="new-sketch">${icon('sketch', 16)}<span>Esboço</span></button>
        <button class="btn soft" data-act="extrude" ${hasSketch ? '' : 'disabled'}>${icon('extrude', 16)}<span>Extrudar</span></button>
        <button class="btn soft" data-act="revolve" ${hasSketch ? '' : 'disabled'}>${icon('revolve', 16)}<span>Revolver</span></button>
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
    return `
      <label class="pe-field"><span>Esboço</span>${this.sketchSelect(f.sketch)}</label>
      <label class="pe-field"><span>Eixo</span><select data-k="axis"><option value="y" ${f.axis === 'y' ? 'selected' : ''}>Vertical do esboço (Y)</option><option value="x" ${f.axis === 'x' ? 'selected' : ''}>Horizontal do esboço (X)</option></select></label>
      ${this.numField('Ângulo', 'angle', f.angle, '°')}
      <label class="pe-field"><span>Operação</span>${this.opSelect(f.op)}</label>`;
  }

  private sketchPanel() {
    const s = this.sketchFeature!;
    const tool = TOOLS.find((t) => t.id === this.tool)!;
    const ent = s.entities.find((e) => e.id === this.selEntity);
    const { openEnds } = sketchProfiles(s.entities);
    return `
      <div class="panel-title">${esc(s.name)} · ${PLANES[s.plane].label}</div>
      <div class="pe-tools">${TOOLS.map((t) => `<button class="btn ${t.id === this.tool ? 'active' : ''}" data-tool="${t.id}" data-tip="${t.label} (${t.key})">${icon(t.id === 'select' ? 'cursor' : t.id, 18)}<span>${t.label}</span></button>`).join('')}</div>
      <div class="hint">${esc(tool.hint)}</div>
      <div class="pe-row">
        <label class="pe-field"><span>Grade</span><select data-k="grid">${[0, 0.5, 1, 5, 10].map((g) => `<option value="${g}" ${g === this.gridStep ? 'selected' : ''}>${g ? `${fmt(g)} mm` : 'Livre'}</option>`).join('')}</select></label>
        ${this.tool === 'polygon' ? `<label class="pe-field"><span>Lados</span><span class="field"><input data-k="sides" value="${this.polygonSides}" inputmode="numeric"/></span></label>` : ''}
      </div>
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
        return `${xy('Início', 'a', e.a)}${xy('Fim', 'b', e.b)}${xy('Passa por', 'm', e.m)}`;
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
        case 'edit-sketch':
          return this.enterSketch(id);
        case 'del':
          return this.deleteFeature(id);
        case 'finish-sketch':
          return this.exitSketch();
        case 'del-entity':
          return this.deleteEntity();
      }
      return;
    }
    const row = t.closest<HTMLElement>('[data-feat]');
    if (row && !t.closest('select, input')) {
      this.selected = row.dataset.feat!;
      this.renderSide();
    }
  }

  private fieldChange(e: Event) {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    const k = t.dataset.k;
    if (!k) return;
    const val = t instanceof HTMLInputElement && t.type === 'checkbox' ? t.checked : t.value;

    if (this.sketchId) {
      if (k === 'grid') this.gridStep = Number(val);
      else if (k === 'sides') this.polygonSides = Math.max(3, Math.min(64, Math.round(num(String(val))) || 6));
      else this.editEntity(k, val);
      return this.changed();
    }

    const f = this.feature(this.selected);
    if (!f) return;
    if (typeof val === 'boolean') (f as unknown as Record<string, unknown>)[k] = val;
    else if (['offset', 'distance', 'angle'].includes(k)) {
      const n = num(val);
      if (!Number.isFinite(n)) return this.renderSide();
      (f as unknown as Record<string, unknown>)[k] = n;
    } else (f as unknown as Record<string, unknown>)[k] = val;
    this.changed();
  }

  private editEntity(k: string, val: string | boolean) {
    const s = this.sketchFeature!;
    const e = s.entities.find((x) => x.id === this.selEntity);
    if (!e) return;
    if (k === 'construction') {
      e.construction = !!val || undefined;
      return;
    }
    const n = num(String(val));
    if (!Number.isFinite(n)) return;
    const [key, axis] = k.split('.');
    if (axis !== undefined) {
      (e as unknown as Record<string, V2>)[key][Number(axis)] = n;
      return;
    }
    if (e.t === 'line' && (k === 'len' || k === 'ang')) {
      const len = k === 'len' ? Math.max(0.01, n) : Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
      const ang = k === 'ang' ? (n * Math.PI) / 180 : Math.atan2(e.b[1] - e.a[1], e.b[0] - e.a[0]);
      const old = [...e.b] as V2;
      e.b = [r2(e.a[0] + len * Math.cos(ang)), r2(e.a[1] + len * Math.sin(ang))];
      // Keep connected lines attached to the moved end.
      for (const o of s.entities) {
        if (o === e || (o.t !== 'line' && o.t !== 'arc')) continue;
        if (Math.hypot(o.a[0] - old[0], o.a[1] - old[1]) < 1e-4) o.a = [...e.b];
        if (Math.hypot(o.b[0] - old[0], o.b[1] - old[1]) < 1e-4) o.b = [...e.b];
      }
    } else if (e.t === 'rect' && (k === 'w' || k === 'h')) e[k] = Math.max(0.01, n);
    else if (e.t === 'circle' && k === 'd') e.r = Math.max(0.005, n / 2);
    else if (e.t === 'polygon' && k === 'r') e.r = Math.max(0.01, n);
    else if (e.t === 'polygon' && k === 'n') e.n = Math.max(3, Math.min(64, Math.round(n)));
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

  private deleteFeature(id: string) {
    const f = this.feature(id);
    if (!f) return;
    const users = this.part.features.filter((x) => x.type !== 'sketch' && x.sketch === id);
    if (users.length) return toast(`“${f.name}” é usado por ${users.map((u) => `“${u.name}”`).join(', ')}. Apague essas operações antes.`, 'error', 4500);
    this.part.features = this.part.features.filter((x) => x.id !== id);
    if (this.selected === id) this.selected = null;
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
    this.chainStart = null;
    this.selEntity = null;
    const P = PLANES[s.plane];
    const n = new THREE.Vector3(...P.n);
    this.look(n, new THREE.Vector3(...P.y), n.clone().multiplyScalar(s.offset));
    this.status.textContent = 'Desenhando o esboço. Botão direito gira a vista, o do meio arrasta.';
    this.status.classList.remove('warn');
    this.changed();
  }

  private exitSketch() {
    this.sketchId = null;
    this.pts = [];
    this.selEntity = null;
    this.drawSketch();
    this.look(new THREE.Vector3(0.6, -0.8, 0.6), new THREE.Vector3(0, 0, 1));
    const sketch = this.feature(this.selected);
    // A first closed sketch is usually extruded next: offer it right away.
    if (sketch?.type === 'sketch' && sketchProfiles(sketch.entities).profiles.length && !this.part.features.some((f) => f.type !== 'sketch' && f.sketch === sketch.id)) {
      this.addFeature('extrude');
    } else this.changed();
  }

  private setTool(t: Tool) {
    this.tool = t;
    this.pts = [];
    this.chainStart = null;
    if (t !== 'select') this.selEntity = null;
    this.renderSide();
    this.drawSketch();
  }

  private deleteEntity() {
    const s = this.sketchFeature;
    if (!s || !this.selEntity) return;
    s.entities = s.entities.filter((e) => e.id !== this.selEntity);
    this.selEntity = null;
    this.changed();
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

  private keyPoints(): V2[] {
    const out: V2[] = [[0, 0]];
    for (const e of this.sketchFeature?.entities ?? []) {
      if (e.t === 'line') out.push(e.a, e.b);
      else if (e.t === 'arc') out.push(e.a, e.b);
      else if (e.t === 'circle') out.push(e.c);
      else if (e.t === 'polygon') out.push(e.c);
      else if (e.t === 'rect') {
        const [x, y] = e.c, w = e.w / 2, h = e.h / 2;
        out.push(e.c, [x - w, y - h], [x + w, y - h], [x + w, y + h], [x - w, y + h]);
      }
    }
    if (this.chainStart) out.push(this.chainStart);
    return out;
  }

  /** Snap to existing points within a few pixels, else to the grid. */
  private snap(p: V2, e: PointerEvent): V2 {
    const r = this.renderer.domElement.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    let best: V2 | null = null;
    let bd = 10;
    for (const k of this.keyPoints()) {
      const [sx, sy] = this.toScreen(k);
      const d = Math.hypot(sx - mx, sy - my);
      if (d < bd) (bd = d), (best = k);
    }
    if (best) return [...best];
    const g = this.gridStep;
    return g ? [r2(Math.round(p[0] / g) * g), r2(Math.round(p[1] / g) * g)] : [r2(p[0]), r2(p[1])];
  }

  private pointerMove(e: PointerEvent) {
    if (!this.sketchId || this.tool === 'select') return;
    const p = this.planePoint(e);
    this.hover = p ? this.snap(p, e) : null;
    this.drawSketch();
    if (this.hover) this.status.textContent = `X ${fmt(this.hover[0])}  Y ${fmt(this.hover[1])} mm${this.pts.length ? `  ·  distância ${fmt(Math.hypot(this.hover[0] - this.pts.at(-1)![0], this.hover[1] - this.pts.at(-1)![1]))} mm` : ''}`;
  }

  private pointerDown(e: PointerEvent) {
    if (!this.sketchId || e.button !== 0) return;
    const s = this.sketchFeature!;
    if (this.tool === 'select') {
      this.selEntity = this.pick(e);
      this.renderSide();
      this.drawSketch();
      return;
    }
    const raw = this.planePoint(e);
    if (!raw) return;
    const p = this.snap(raw, e);
    const same = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;
    const add = (ent: SketchEntity) => {
      s.entities.push(ent);
      this.changed();
    };
    this.pts.push(p);
    switch (this.tool) {
      case 'line': {
        if (this.pts.length === 1) {
          this.chainStart ??= p;
          return this.drawSketch();
        }
        const [a, b] = this.pts;
        this.pts = [];
        if (same(a, b)) return;
        add({ id: fid(), t: 'line', a, b });
        if (this.chainStart && same(b, this.chainStart)) this.chainStart = null;
        else this.pts = [b];
        return this.drawSketch();
      }
      case 'rect':
      case 'circle':
      case 'polygon': {
        if (this.pts.length < 2) return this.drawSketch();
        const [a, b] = this.pts;
        this.pts = [];
        if (same(a, b)) return;
        if (this.tool === 'rect') add({ id: fid(), t: 'rect', c: [r2((a[0] + b[0]) / 2), r2((a[1] + b[1]) / 2)], w: r2(Math.abs(b[0] - a[0])), h: r2(Math.abs(b[1] - a[1])) });
        else if (this.tool === 'circle') add({ id: fid(), t: 'circle', c: a, r: r2(Math.hypot(b[0] - a[0], b[1] - a[1])) });
        else add({ id: fid(), t: 'polygon', c: a, r: r2(Math.hypot(b[0] - a[0], b[1] - a[1])), n: this.polygonSides });
        return;
      }
      case 'arc': {
        if (this.pts.length < 3) return this.drawSketch();
        const [a, b, m] = this.pts;
        this.pts = [];
        if (same(a, b)) return;
        add({ id: fid(), t: 'arc', a, b, m });
        return;
      }
    }
  }

  /** Entity whose drawn outline passes closest to the mouse. */
  private pick(e: PointerEvent): string | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    let best: string | null = null;
    let bd = 8;
    for (const ent of this.sketchFeature!.entities) {
      const pts = entityPoints(ent).map((p) => this.toScreen(p));
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
      if (k === 'escape') this.selected = null, this.renderSide();
      return;
    }
    if (k === 'escape') {
      if (this.pts.length || this.chainStart) {
        this.pts = [];
        this.chainStart = null;
      } else if (this.tool !== 'select') this.setTool('select');
      else this.exitSketch();
      return this.drawSketch();
    }
    if (k === 'enter') return this.exitSketch();
    if ((k === 'delete' || k === 'backspace') && this.selEntity) return e.preventDefault(), this.deleteEntity();
    const t = TOOLS.find((x) => x.key.toLowerCase() === k);
    if (t && !e.ctrlKey && !e.metaKey) this.setTool(t.id);
  }

  // ---------- sketch drawing ----------

  private drawSketch() {
    for (const c of [...this.sketch.children]) {
      this.sketch.remove(c);
      (c as THREE.Mesh).geometry?.dispose();
    }
    const s = this.sketchFeature;
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

    // Closed outlines filled so it is clear what becomes solid.
    for (const prof of sketchProfiles(s.entities).profiles) {
      const shape = new THREE.Shape(profilePoints(prof, 32).map(([x, y]) => new THREE.Vector2(x, y)));
      const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false }));
      m.position.z = 0.01;
      this.sketch.add(m);
    }
    for (const ent of s.entities) {
      const on = ent.id === this.selEntity;
      const mat = ent.construction
        ? new THREE.LineDashedMaterial({ color: on ? accent : ink, dashSize: 2, gapSize: 1.5, transparent: true, opacity: 0.6 })
        : new THREE.LineBasicMaterial({ color: on ? accent : ink });
      const l = polyline(entityPoints(ent), mat);
      if (ent.construction) l.computeLineDistances();
      this.sketch.add(l);
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
    return [e.c];
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
  }
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

