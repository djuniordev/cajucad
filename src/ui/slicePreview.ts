import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { desktop, type SliceResult, type Toolpaths } from '../desktop';
import { el, esc, toast } from './dom';
import { icon } from './icons';

/** What each kind of line is called, and the colour it gets when painting by type. */
const TYPES: Record<string, { label: string; color: string }> = {
  'Outer wall': { label: 'Parede externa', color: '#ff9d3a' },
  'Inner wall': { label: 'Parede interna', color: '#d9722b' },
  'Overhang wall': { label: 'Parede em balanço', color: '#3a8bff' },
  'Sparse infill': { label: 'Preenchimento', color: '#b4443a' },
  'Internal solid infill': { label: 'Preenchimento sólido', color: '#a050c8' },
  'Top surface': { label: 'Superfície de cima', color: '#e84a4a' },
  'Bottom surface': { label: 'Base', color: '#8a8a94' },
  Bridge: { label: 'Ponte', color: '#4a6fe8' },
  'Gap infill': { label: 'Vãos', color: '#f5d34a' },
  Support: { label: 'Suporte', color: '#12c4a0' },
  'Support interface': { label: 'Suporte (contato)', color: '#8fe3d2' },
  'Support transition': { label: 'Suporte (transição)', color: '#5fb3a5' },
  Skirt: { label: 'Saia', color: '#9aa0ac' },
  Brim: { label: 'Borda de aderência', color: '#9aa0ac' },
  'Prime tower': { label: 'Torre de limpeza', color: '#c8a064' },
  Custom: { label: 'Outros', color: '#888d98' },
  'Floating vertical shell': { label: 'Parede solta', color: '#d9722b' },
};
const isSupport = (name: string) => name.startsWith('Support');
const info = (name: string) => TYPES[name] ?? { label: name, color: '#888d98' };

export type PaintMode = 'filament' | 'type';
type Bed = { width: number; depth: number };

/** Reads the toolpaths of a sliced job (null, with a message, when it cannot). */
export async function loadToolpaths(jobId: string, bed: Bed): Promise<Toolpaths | null> {
  if (!desktop) return null;
  try {
    const tp = await desktop.bambu.toolpaths(jobId, bed);
    return tp.count ? tp : null;
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Não foi possível ler as camadas.', 'error', 5000);
    return null;
  }
}

/** The sliced job drawn in 3D, layer by layer. One renderer per view. */
class SliceView {
  readonly el = el(`<div class="sv-canvas"></div>`);
  readonly nLayers: number;
  layer: number;
  mode: PaintMode;
  private renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 1, 4000);
  private orbit: OrbitControls;
  private groups: { type: number; lines: THREE.LineSegments; seg: number[]; ends: Uint32Array }[] = [];
  private visible = new Set<number>();
  private extra: { dispose(): void }[] = [];
  private raf = 0;
  private ro: ResizeObserver;
  /** Segments of every type, in print order. */
  readonly buckets: number[][];

  constructor(readonly tp: Toolpaths, readonly result: SliceResult, bed: Bed, mode: PaintMode, onLayer?: () => void) {
    this.mode = mode;
    this.nLayers = tp.layerZ.length;
    this.layer = this.nLayers - 1;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.el.appendChild(this.renderer.domElement);

    const cx = bed.width / 2, cy = bed.depth / 2;
    // Frame what is printed (not the whole bed): centre and size of the toolpaths.
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < tp.count; i += 3) {
      lo.min(new THREE.Vector3(tp.pos[i * 6], tp.pos[i * 6 + 1], 0));
      hi.max(new THREE.Vector3(tp.pos[i * 6], tp.pos[i * 6 + 1], tp.pos[i * 6 + 2]));
    }
    const mid = lo.clone().add(hi).multiplyScalar(0.5);
    const radius = Math.max(20, lo.distanceTo(hi) / 2);
    this.camera.up.set(0, 0, 1);
    this.camera.position.copy(mid).add(new THREE.Vector3(0.5, -0.85, 0.62).normalize().multiplyScalar(radius * 2.6));
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.target.copy(mid);
    this.orbit.screenSpacePanning = true;
    this.orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.orbit.addEventListener('change', () => this.invalidate());

    const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#999';
    const planeGeo = new THREE.PlaneGeometry(bed.width, bed.depth);
    const plane = new THREE.Mesh(planeGeo, new THREE.MeshBasicMaterial({ color: css('--plane'), transparent: true, opacity: 0.9 }));
    plane.position.set(cx, cy, -0.1);
    const edgeGeo = new THREE.EdgesGeometry(planeGeo);
    const edge = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: css('--text-3') }));
    edge.position.copy(plane.position);
    this.scene.add(plane, edge);
    this.extra.push(planeGeo, edgeGeo, plane.material as THREE.Material, edge.material as THREE.Material);

    // One line object per type so each can be hidden; segments come in layer order, so a layer
    // limit is a prefix of each one.
    this.buckets = tp.types.map(() => []);
    for (let i = 0; i < tp.count; i++) this.buckets[tp.type[i]]?.push(i);
    this.buckets.forEach((seg, type) => {
      if (!seg.length) return;
      this.visible.add(type);
      const pos = new Float32Array(seg.length * 6);
      seg.forEach((s, k) => pos.set(tp.pos.subarray(s * 6, s * 6 + 6), k * 6));
      const ends = new Uint32Array(this.nLayers);
      for (const s of seg) ends[tp.layer[s]]++;
      for (let l = 1; l < this.nLayers; l++) ends[l] += ends[l - 1];
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(seg.length * 6), 3));
      const lines = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ vertexColors: true }));
      lines.frustumCulled = false;
      this.scene.add(lines);
      this.groups.push({ type, lines, seg, ends });
    });
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.el);
    this.paint();
    this.apply();
    this.onLayer = onLayer; // set last: the callback may refer to the view being built
  }

  private onLayer?: () => void;

  toolColor(t: number) {
    return this.result.filaments.find((f) => f.id === t + 1)?.color ?? '#9aa0ac';
  }

  /** Filaments that print support lines. */
  supportTools() {
    const used = new Set<number>();
    this.buckets.forEach((seg, t) => {
      if (isSupport(this.tp.types[t])) for (const s of seg) used.add(this.tp.tool[s]);
    });
    return [...used].sort();
  }

  hasSupport() {
    return this.buckets.some((seg, t) => seg.length && isSupport(this.tp.types[t]));
  }

  setMode(m: PaintMode) {
    this.mode = m;
    this.paint();
    this.invalidate();
  }

  setLayer(l: number) {
    this.layer = Math.max(0, Math.min(this.nLayers - 1, l));
    this.apply();
    this.invalidate();
  }

  setTypeVisible(type: number, on: boolean) {
    if (on) this.visible.add(type);
    else this.visible.delete(type);
    this.apply();
    this.invalidate();
  }

  private paint() {
    const tmp = new THREE.Color();
    for (const g of this.groups) {
      const col = g.lines.geometry.getAttribute('color') as THREE.BufferAttribute;
      const base = info(this.tp.types[g.type]).color;
      g.seg.forEach((s, k) => {
        tmp.set(this.mode === 'type' ? base : this.toolColor(this.tp.tool[s]));
        col.setXYZ(k * 2, tmp.r, tmp.g, tmp.b);
        col.setXYZ(k * 2 + 1, tmp.r, tmp.g, tmp.b);
      });
      col.needsUpdate = true;
    }
  }

  private apply() {
    for (const g of this.groups) {
      g.lines.visible = this.visible.has(g.type);
      g.lines.geometry.setDrawRange(0, g.ends[this.layer] * 2);
    }
    this.onLayer?.();
  }

  /** "12 de 40 · 2.40 mm" */
  layerText() {
    return `${this.layer + 1} de ${this.nLayers} · ${(this.tp.layerZ[this.layer] ?? 0).toFixed(2)} mm`;
  }

  invalidate() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.renderer.render(this.scene, this.camera);
    });
  }

  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.invalidate();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.orbit.dispose();
    for (const g of this.groups) {
      g.lines.geometry.dispose();
      (g.lines.material as THREE.Material).dispose();
    }
    this.extra.forEach((x) => x.dispose());
    this.renderer.dispose();
    this.el.remove();
  }
}

const legendChip = (name: string) => `<span class="mv-chip"><i style="background:${info(name).color}"></i>${esc(info(name).label)}</span>`;

/** Small preview that sits in the print result; "Ampliar" opens the big one. */
export function createMiniPreview(tp: Toolpaths, result: SliceResult, bed: Bed): { el: HTMLElement; dispose(): void } {
  const root = el(`
    <div class="mini-view">
      <div class="mv-stage">
        <button class="btn soft mv-expand" data-tip="Ampliar para girar e mover">${icon('layers', 15)} Ampliar</button>
      </div>
      <div class="mv-bar">
        <input type="range" class="sp-slider" min="0" max="${tp.layerZ.length - 1}" step="1"/>
        <span class="mv-layer"></span>
      </div>
      <div class="mv-legend"></div>
    </div>`);
  const stage = root.querySelector<HTMLElement>('.mv-stage')!;
  const slider = root.querySelector<HTMLInputElement>('.sp-slider')!;
  const label = root.querySelector<HTMLElement>('.mv-layer')!;
  const view = new SliceView(tp, result, bed, 'type', () => {
    label.textContent = view.layerText();
    slider.value = String(view.layer);
  });
  stage.prepend(view.el);
  slider.value = String(view.layer);
  label.textContent = view.layerText();
  slider.addEventListener('input', () => view.setLayer(Number(slider.value)));

  // What is on screen: the line types of the print, supports first and highlighted.
  const types = tp.types.map((n, i) => ({ n, i })).filter((t) => view.buckets[t.i].length);
  types.sort((a, b) => Number(isSupport(b.n)) - Number(isSupport(a.n)));
  const legend = root.querySelector<HTMLElement>('.mv-legend')!;
  legend.innerHTML = view.hasSupport()
    ? types.filter((t) => isSupport(t.n)).map((t) => legendChip(t.n)).join('') + `<span class="mv-chip dim">Suportes aparecem em verde</span>`
    : `<span class="mv-chip dim">Esta fatia não tem suportes.</span>`;

  const expand = () => openSlicePreview(tp, result, bed);
  root.querySelector<HTMLElement>('.mv-expand')!.onclick = expand;
  view.el.addEventListener('dblclick', expand);
  requestAnimationFrame(() => view.resize());
  setTimeout(() => view.resize(), 120); // once it is in the page
  return { el: root, dispose: () => view.dispose() };
}

/** Full screen view: turn it, move it, scrub the layers, hide kinds of line. */
export function openSlicePreview(tp: Toolpaths, result: SliceResult, bed: Bed) {
  const root = el(`
    <div class="slice-preview" tabindex="-1">
      <div class="sp-head">
        <h2>${icon('layers', 18)} Prévia do fatiamento</h2>
        <span class="sp-tip">Arraste para girar · botão direito para mover · roda para aproximar</span>
        <button class="btn icon-only" data-act="close" data-tip="Fechar (Esc)">${icon('close', 18)}</button>
      </div>
      <div class="sp-body">
        <div class="sp-view"></div>
        <aside class="sp-side">
          <div class="sp-block">
            <div class="sp-title">Camada <b class="sp-layer"></b></div>
            <input type="range" class="sp-slider" min="0" max="${tp.layerZ.length - 1}" step="1"/>
            <div class="sp-hint">Arraste, ou use as setas ↑ ↓ (Shift pula 10).</div>
          </div>
          <div class="sp-block">
            <div class="sp-title">Pintar por</div>
            <div class="segmented sp-mode">
              <button class="btn" data-mode="filament">Filamento</button>
              <button class="btn active" data-mode="type">Tipo de linha</button>
            </div>
          </div>
          <div class="sp-block sp-types"></div>
          <div class="sp-block sp-support"></div>
        </aside>
      </div>
    </div>`);
  document.body.appendChild(root);
  const slider = root.querySelector<HTMLInputElement>('.sp-slider')!;
  const label = root.querySelector<HTMLElement>('.sp-layer')!;
  const view = new SliceView(tp, result, bed, 'type', () => {
    label.textContent = view.layerText();
    slider.value = String(view.layer);
  });
  root.querySelector('.sp-view')!.appendChild(view.el);
  slider.value = String(view.layer);
  label.textContent = view.layerText();

  const typesBox = root.querySelector<HTMLElement>('.sp-types')!;
  typesBox.innerHTML = `<div class="sp-title">Mostrar</div>`;
  const order = tp.types.map((n, i) => ({ n, i })).filter((t) => view.buckets[t.i].length).sort((a, b) => Number(isSupport(b.n)) - Number(isSupport(a.n)));
  for (const { n, i } of order) {
    const row = el(`<label class="sp-type ${isSupport(n) ? 'sup' : ''}"><input type="checkbox" checked/><i style="background:${info(n).color}"></i><span>${esc(info(n).label)}</span></label>`);
    row.querySelector('input')!.addEventListener('change', (e) => view.setTypeVisible(i, (e.target as HTMLInputElement).checked));
    typesBox.appendChild(row);
  }

  const supportBox = root.querySelector<HTMLElement>('.sp-support')!;
  if (!view.hasSupport()) supportBox.innerHTML = `<div class="sp-title">Suportes</div><div class="sp-hint">Esta fatia não tem suportes.</div>`;
  else {
    const used = view.supportTools();
    supportBox.innerHTML = `<div class="sp-title">Suportes impressos com</div>
      <div class="sp-hint">${used.map((t) => `<span class="sp-dot" style="background:${view.toolColor(t)}"></span>`).join('')}
      ${used.length > 1 ? '<br>Mais de um filamento imprime suporte (pode ser o certo, se as peças têm cores diferentes).' : ''}</div>`;
  }

  slider.addEventListener('input', () => view.setLayer(Number(slider.value)));
  root.querySelectorAll<HTMLButtonElement>('.sp-mode [data-mode]').forEach((b) => {
    b.onclick = () => {
      view.setMode(b.dataset.mode as PaintMode);
      root.querySelectorAll('.sp-mode .btn').forEach((x) => x.classList.toggle('active', x === b));
    };
  });

  const close = () => {
    removeEventListener('keydown', onKey, true);
    view.dispose();
    root.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation(); // the editor behind must not react (Delete, arrows...)
    if (e.key === 'Escape') {
      e.stopImmediatePropagation();
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      view.setLayer(view.layer + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1));
    }
  };
  addEventListener('keydown', onKey, true);
  root.querySelector<HTMLElement>('[data-act=close]')!.onclick = close;
  root.focus();
  requestAnimationFrame(() => view.resize());
  setTimeout(() => view.resize(), 120);
}
