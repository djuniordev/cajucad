import { store } from '../core/store';
import { KIND_LABEL, PALETTE, shapeDef } from '../core/shapes';
import * as cmd from '../core/commands';
import { getFace, isFontAvailable, previewCss, DEFAULT_FONT_ID } from '../core/fonts';
import { manifoldFromAsset } from '../core/geometry';
import type { SceneNode } from '../core/types';
import { el, esc, numberField, sliderRow, toast } from './dom';
import { icon } from './icons';
import { openFontPicker } from './fontPicker';
import { filaments } from '../core/filaments';

const AXES = ['x', 'y', 'z'] as const;

/** Normalise an angle to (-180, 180]. */
const wrapDeg = (v: number) => {
  const a = ((v % 360) + 360) % 360;
  return a > 180 ? a - 360 : a;
};

/** Right-hand properties panel. Rebuilt on every change; focus is restored. */
export class Inspector {
  readonly root: HTMLElement;
  private body: HTMLElement;
  private uniform = true;
  private textTimer = 0;
  private solidCache = new Map<string, boolean>();

  constructor() {
    this.root = el(`<aside class="inspector glass"><div class="insp-body"></div></aside>`);
    this.body = this.root.querySelector('.insp-body')!;
    store.onSelection(() => this.render());
    store.onDoc(() => this.render());
    filaments.on(() => this.render());
    this.render();
  }

  private render() {
    // Keep keyboard focus across rebuilds (e.g. tabbing between fields).
    const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
    const key = active && this.root.contains(active) ? active.closest<HTMLElement>('[data-key]')?.dataset.key : undefined;
    const caret = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;

    const sel = store.selected;
    this.body.innerHTML = '';
    if (!sel.length) this.body.appendChild(this.emptyState());
    else if (sel.length === 1) this.body.appendChild(this.single(sel[0]));
    else this.body.appendChild(this.multi(sel));

    if (key) {
      const target = this.body.querySelector<HTMLElement>(`[data-key="${key}"]`);
      const input = target?.matches('input,textarea') ? (target as HTMLInputElement) : target?.querySelector<HTMLInputElement>('input,textarea');
      if (input) {
        input.focus();
        if (caret && caret[0] != null) input.setSelectionRange(caret[0], caret[1] ?? caret[0]);
      }
    }
  }

  private emptyState() {
    return el(`
      <div class="empty">
        <h3>Comece a modelar</h3>
        Arraste uma forma da biblioteca para a mesa ou clique nela. Selecione um objeto para editar medidas, cor e se ele é sólido ou furo.
        <div class="shortcuts">
          <span>Girar a vista</span><span><kbd>Botão direito</kbd></span>
          <span>Mover a vista</span><span><kbd>Botão do meio</kbd></span>
          <span>Aproximar / afastar</span><span><kbd>Roda do mouse</kbd></span>
          <span>Selecionar vários</span><span><kbd>Arrastar no vazio</kbd></span>
          <span>Mover uma peça</span><span><kbd>Arrastar a peça</kbd></span>
          <span>Mover / Girar / Escalar</span><span><kbd>W</kbd> <kbd>E</kbd> <kbd>R</kbd></span>
          <span>Furo ↔ sólido</span><kbd>H</kbd>
          <span>Agrupar / desagrupar</span><span><kbd>Ctrl G</kbd> <kbd>Ctrl ⇧ G</kbd></span>
          <span>Duplicar</span><kbd>Ctrl D</kbd>
          <span>Soltar na mesa</span><kbd>D</kbd>
          <span>Mover com precisão</span><span><kbd>←↑→↓</kbd> <kbd>Ctrl ↑↓</kbd></span>
          <span>Enquadrar</span><kbd>F</kbd>
          <span>Desfazer / refazer</span><span><kbd>Ctrl Z</kbd> <kbd>Ctrl Y</kbd></span>
        </div>
      </div>`);
  }

  private head(title: string, sub: string, node?: SceneNode) {
    const wrap = el(`<div></div>`);
    const h = el(`<div class="insp-head"></div>`);
    if (node) {
      const name = el<HTMLInputElement>(`<input class="name-input" data-key="name" value="${esc(node.name)}" spellcheck="false"/>`);
      name.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') name.blur();
      });
      name.addEventListener('change', () => cmd.updateNodes([node.id], (n) => (n.name = name.value.trim() || n.name)));
      h.appendChild(name);
      h.appendChild(this.iconBtn(node.locked ? 'lock' : 'unlock', node.locked ? 'Destravar' : 'Travar', () => cmd.toggleLock(), node.locked));
      h.appendChild(this.iconBtn('eyeOff', 'Ocultar', () => cmd.hideSelection()));
    } else {
      h.appendChild(el(`<div class="name-input" style="cursor:default">${esc(title)}</div>`));
    }
    const del = this.iconBtn('trash', 'Excluir (Del)', () => cmd.deleteSelection());
    del.classList.add('danger');
    h.appendChild(del);
    wrap.appendChild(h);
    wrap.appendChild(el(`<div class="kind-tag" style="padding-left:21px">${esc(sub)}</div>`));
    return wrap;
  }

  private iconBtn(name: string, tip: string, fn: () => void, active = false) {
    const b = el<HTMLButtonElement>(`<button class="btn icon-only ${active ? 'active' : ''}" data-tip="${esc(tip)}">${icon(name, 17)}</button>`);
    b.onclick = fn;
    return b;
  }

  private typeAndColor(nodes: SceneNode[]) {
    const s = el(`<div class="section"></div>`);
    const allHole = nodes.every((n) => n.hole);
    const tt = el(`<div class="type-toggle"></div>`);
    const solid = el<HTMLButtonElement>(`<button class="btn ${!allHole ? 'active' : ''}">${icon('solid', 16)} Sólido</button>`);
    const hole = el<HTMLButtonElement>(`<button class="btn ${allHole ? 'active' : ''}">${icon('hole', 16)} Furo</button>`);
    solid.onclick = () => allHole && cmd.updateNodes(nodes.map((n) => n.id), (n) => (n.hole = false));
    hole.onclick = () => !allHole && cmd.updateNodes(nodes.map((n) => n.id), (n) => (n.hole = true));
    tt.append(solid, hole);
    s.appendChild(tt);
    if (!allHole) {
      const cur = nodes.length === 1 ? nodes[0].color.toLowerCase() : '';
      const curFil = nodes.length === 1 ? nodes[0].filament : undefined;
      if (filaments.list.length) {
        s.appendChild(el(`<div class="sub-title">Meus filamentos</div>`));
        const fc = el(`<div class="fil-chips"></div>`);
        for (const f of filaments.list) {
          const b = el<HTMLButtonElement>(`<button class="fil-chip ${curFil === f.id ? 'on' : ''}" style="background:${f.color}" data-tip="${esc(f.name)} · ${esc(f.type)}">${f.source === 'ams' ? `<span class="tag">AMS</span>` : ''}</button>`);
          b.onclick = () => cmd.setFilament(f.id);
          fc.appendChild(b);
        }
        s.appendChild(fc);
        s.appendChild(el(`<div class="sub-title">Outras cores</div>`));
      }
      const sw = el(`<div class="swatches"></div>`);
      for (const c of PALETTE) {
        const b = el<HTMLButtonElement>(`<button class="swatch ${cur === c ? 'on' : ''}" style="background:${c}" aria-label="${c}"></button>`);
        b.onclick = () => cmd.setColor(c);
        sw.appendChild(b);
      }
      const custom = el(`<label class="swatch custom ${cur && !PALETTE.includes(cur) ? 'on' : ''}" data-tip="Outra cor"><input type="color" value="${cur || '#e80537'}"/></label>`);
      custom.querySelector('input')!.addEventListener('change', (e) => cmd.setColor((e.target as HTMLInputElement).value));
      sw.appendChild(custom);
      s.appendChild(sw);
    }
    return s;
  }

  private single(n: SceneNode) {
    const frag = el(`<div class="insp-scroll"></div>`);
    const wrapper = el(`<div></div>`);
    wrapper.appendChild(this.head(n.name, KIND_LABEL[n.kind] ?? n.kind, n));
    wrapper.appendChild(frag);
    frag.appendChild(this.typeAndColor([n]));
    if (n.kind === 'text') frag.appendChild(this.textSection(n));
    frag.appendChild(this.dimensions(n));
    frag.appendChild(this.transform(n));
    const def = shapeDef(n.kind);
    if (def?.specs.length) {
      const s = el(`<div class="section"><div class="section-title">Forma</div></div>`);
      for (const spec of def.specs) {
        const v = Number(n.params[spec.key] ?? 0);
        const row = sliderRow({
          label: spec.label,
          value: v,
          min: spec.min ?? 0,
          max: Math.max(spec.max ?? 100, v),
          step: spec.step ?? 1,
          unit: spec.unit,
          int: spec.int,
          onCommit: (val) => cmd.updateNodes([n.id], (x) => (x.params[spec.key] = val)),
        });
        row.dataset.key = `p-${spec.key}`;
        s.appendChild(row);
      }
      frag.appendChild(s);
    }
    if (n.kind === 'svg') {
      const s = el(`<div class="section"><div class="section-title">Extrusão</div></div>`);
      s.appendChild(sliderRow({ label: 'Espessura', value: Number(n.params.height ?? 5), min: 0.2, max: 50, step: 0.1, unit: 'mm', onCommit: (v) => cmd.updateNodes([n.id], (x) => (x.params.height = v)) }));
      frag.appendChild(s);
    }
    if (n.kind === 'mesh' && !this.isSolidMesh(n)) {
      frag.appendChild(el(`<div class="warn">Esta malha não é um sólido fechado (tem buracos ou faces soltas). Ela é exibida, mas não entra em furos, grupos nem na exportação STL.</div>`));
    }
    frag.appendChild(this.actions(n));
    return wrapper;
  }

  private isSolidMesh(n: SceneNode) {
    const id = String(n.params.asset);
    if (!this.solidCache.has(id)) {
      const a = store.doc.assets[id];
      const m = a ? manifoldFromAsset(a) : null;
      this.solidCache.set(id, !!m);
      m?.delete();
    }
    return this.solidCache.get(id)!;
  }

  private textSection(n: SceneNode) {
    const s = el(`<div class="section"><div class="section-title">Texto</div></div>`);
    const ta = el<HTMLTextAreaElement>(`<textarea class="text-input" data-key="text" rows="2" spellcheck="false"></textarea>`);
    ta.value = String(n.params.text ?? '');
    ta.addEventListener('keydown', (e) => e.stopPropagation());
    ta.addEventListener('input', () => {
      clearTimeout(this.textTimer);
      this.textTimer = window.setTimeout(() => cmd.updateText(n.id, { text: ta.value }), 380);
    });
    s.appendChild(ta);

    const fontId = String(n.params.font || DEFAULT_FONT_ID);
    const face = getFace(fontId);
    const fb = el<HTMLButtonElement>(`
      <button class="font-button" style="margin-top:8px">
        <span class="fb-preview" style="${face ? previewCss(face) : ''}">Aa</span>
        <span class="fb-name"><b>${esc(face?.family ?? fontId.replace(/^\w+:/, ''))}</b><small>${esc(face?.style ?? 'fonte não disponível neste computador')}</small></span>
        ${icon('chevron', 16)}
      </button>`);
    fb.onclick = () =>
      openFontPicker({
        current: fontId,
        sample: String(n.params.text ?? ''),
        onPick: (f) => cmd.updateText(n.id, { font: f.id }).catch(() => toast('Não consegui ler essa fonte.', 'error')),
      });
    s.appendChild(fb);
    if (!isFontAvailable(fontId)) {
      s.appendChild(el(`<div class="warn">A forma continua salva, mas para editar o texto com esta fonte permita as fontes do computador ou escolha outra.</div>`));
    }

    const sliders = el(`<div style="margin-top:12px"></div>`);
    const p = n.params;
    sliders.appendChild(this.keyed('t-size', sliderRow({ label: 'Tamanho da fonte', value: Number(p.size ?? 14), min: 2, max: 120, step: 0.5, unit: 'mm', onCommit: (v) => cmd.updateText(n.id, { size: v }) })));
    sliders.appendChild(this.keyed('t-depth', sliderRow({ label: 'Profundidade', value: Number(p.height ?? 4), min: 0.2, max: 40, step: 0.2, unit: 'mm', onCommit: (v) => cmd.updateText(n.id, { height: v }) })));
    sliders.appendChild(this.keyed('t-sp', sliderRow({ label: 'Espaço entre letras', value: Number(p.letterSpacing ?? 0), min: -3, max: 20, step: 0.1, unit: 'mm', onCommit: (v) => cmd.updateText(n.id, { letterSpacing: v }) })));
    s.appendChild(sliders);

    if (String(n.params.text ?? '').includes('\n')) {
      const row = el(`<div class="row" style="margin-top:8px"></div>`);
      const seg = el(`<div class="segmented"></div>`);
      for (const [a, label] of [['left', 'Esquerda'], ['center', 'Centro'], ['right', 'Direita']] as const) {
        const b = el<HTMLButtonElement>(`<button class="btn ${n.params.align === a ? 'active' : ''}">${label}</button>`);
        b.onclick = () => cmd.updateText(n.id, { align: a });
        seg.appendChild(b);
      }
      row.appendChild(seg);
      row.appendChild(this.keyed('t-lh', numberField({ label: 'Linha', value: Number(n.params.lineHeight ?? 1.2), min: 0.5, step: 0.05, onCommit: (v) => cmd.updateText(n.id, { lineHeight: v }) })));
      s.appendChild(row);
    }
    return s;
  }

  private keyed(key: string, node: HTMLElement) {
    node.dataset.key = key;
    return node;
  }

  private dimensions(n: SceneNode) {
    const s = el(`<div class="section"><div class="section-title">Medidas</div></div>`);
    const size = cmd.localSize(n);
    const lockBtn = el<HTMLButtonElement>(`<button class="btn icon-only ${this.uniform ? 'active' : ''}" style="height:24px;min-width:24px" data-tip="Manter proporção">${icon('link', 14)}</button>`);
    lockBtn.onclick = () => {
      this.uniform = !this.uniform;
      this.render();
    };
    s.querySelector('.section-title')!.appendChild(lockBtn);
    const g = el(`<div class="grid3"></div>`);
    const labels = ['L', 'P', 'A'];
    AXES.forEach((ax, i) => {
      g.appendChild(
        this.keyed(`dim-${ax}`, numberField({
          label: labels[i],
          axis: ax,
          value: size ? size[i] : 0,
          min: 0.01,
          step: 1,
          onCommit: (v) => cmd.setLocalSize(n.id, i as 0 | 1 | 2, v, this.uniform),
        })),
      );
    });
    s.appendChild(g);
    s.appendChild(el(`<div class="grid3 dim-captions"><span>Largura</span><span>Profundidade</span><span>Altura</span></div>`));
    s.appendChild(el(`<div class="hint">Dica: arraste as alças brancas no objeto ou clique nas medidas na tela. <kbd>Shift</kbd> mantém a proporção.</div>`));
    return s;
  }

  private transform(n: SceneNode) {
    const s = el(`<div class="section"><div class="section-title">Posição</div></div>`);
    const pos = el(`<div class="grid3"></div>`);
    AXES.forEach((ax, i) =>
      pos.appendChild(this.keyed(`pos-${ax}`, numberField({ label: ax.toUpperCase(), axis: ax, value: n.position[i], step: 1, onCommit: (v) => cmd.updateNodes([n.id], (x) => (x.position[i] = v)) }))),
    );
    s.appendChild(pos);
    s.appendChild(el(`<div class="section-title" style="margin-top:12px">Rotação</div>`));
    const rot = el(`<div class="grid3"></div>`);
    AXES.forEach((ax, i) =>
      rot.appendChild(this.keyed(`rot-${ax}`, numberField({ label: ax.toUpperCase(), axis: ax, value: n.rotation[i], step: 15, unit: '°', onCommit: (v) => cmd.updateNodes([n.id], (x) => (x.rotation[i] = wrapDeg(v))) }))),
    );
    s.appendChild(rot);
    return s;
  }

  private actions(n: SceneNode) {
    const s = el(`<div class="section"><div class="row" style="flex-wrap:wrap"></div></div>`);
    const row = s.querySelector('.row')!;
    const add = (ic: string, label: string, fn: () => void, primary = false) => {
      const b = el<HTMLButtonElement>(`<button class="btn ${primary ? 'primary' : 'soft'}" style="flex:1">${icon(ic, 16)}<span>${label}</span></button>`);
      b.onclick = fn;
      row.appendChild(b);
    };
    if (n.kind === 'group') add('ungroup', 'Desagrupar', () => cmd.ungroupSelection(), true);
    add('copy', 'Duplicar', () => cmd.duplicateSelection([10, 10, 0]));
    add('drop', 'Soltar', () => cmd.dropToPlane());
    const mir = el(`<div class="row" style="margin-top:6px"><span style="font-size:11.5px;color:var(--text-2);flex:1">Espelhar</span></div>`);
    AXES.forEach((ax, i) => {
      const b = el<HTMLButtonElement>(`<button class="btn soft" style="height:30px">${ax.toUpperCase()}</button>`);
      b.onclick = () => cmd.mirror(i as 0 | 1 | 2);
      mir.appendChild(b);
    });
    s.appendChild(mir);
    return s;
  }

  private multi(nodes: SceneNode[]) {
    const wrapper = el(`<div></div>`);
    wrapper.appendChild(this.head(`${nodes.length} objetos`, nodes.some((n) => n.hole) ? 'Sólidos e furos' : 'Seleção múltipla'));
    const body = el(`<div class="insp-scroll"></div>`);
    wrapper.appendChild(body);
    body.appendChild(this.typeAndColor(nodes));

    const s = el(`<div class="section"></div>`);
    const g = el<HTMLButtonElement>(`<button class="btn primary" style="width:100%;height:40px">${icon('group', 17)} Agrupar <span class="kbd" style="color:rgba(255,255,255,.75)">Ctrl G</span></button>`);
    g.onclick = () => cmd.groupSelection();
    s.appendChild(g);
    s.appendChild(el(`<div style="font-size:11.5px;color:var(--text-3);margin-top:8px;line-height:1.45">Sólidos são unidos e furos são subtraídos ao agrupar.</div>`));
    body.appendChild(s);

    const al = el(`<div class="section"><div class="section-title">Alinhar</div></div>`);
    const names = [['Esq', 'Centro', 'Dir'], ['Frente', 'Centro', 'Trás'], ['Base', 'Meio', 'Topo']];
    AXES.forEach((ax, i) => {
      const row = el(`<div class="row"><span style="width:16px;font-weight:600;font-size:11px" class="field-axis">${ax.toUpperCase()}</span></div>`);
      (['min', 'center', 'max'] as const).forEach((m, j) => {
        const b = el<HTMLButtonElement>(`<button class="btn soft" style="flex:1;height:30px;font-size:12px">${names[i][j]}</button>`);
        b.onclick = () => cmd.align(i as 0 | 1 | 2, m);
        row.appendChild(b);
      });
      al.appendChild(row);
    });
    body.appendChild(al);

    const mir = el(`<div class="section"><div class="row"><span style="font-size:11.5px;color:var(--text-2);flex:1">Espelhar</span></div></div>`);
    AXES.forEach((ax, i) => {
      const b = el<HTMLButtonElement>(`<button class="btn soft" style="height:30px">${ax.toUpperCase()}</button>`);
      b.onclick = () => cmd.mirror(i as 0 | 1 | 2);
      mir.querySelector('.row')!.appendChild(b);
    });
    body.appendChild(mir);
    const tools = el(`<div class="section"><div class="row"></div></div>`);
    const dup = el<HTMLButtonElement>(`<button class="btn soft" style="flex:1">${icon('copy', 16)} Duplicar</button>`);
    dup.onclick = () => cmd.duplicateSelection([10, 10, 0]);
    const drop = el<HTMLButtonElement>(`<button class="btn soft" style="flex:1">${icon('drop', 16)} Soltar</button>`);
    drop.onclick = () => cmd.dropToPlane();
    tools.querySelector('.row')!.append(dup, drop);
    body.appendChild(tools);
    return wrapper;
  }
}

