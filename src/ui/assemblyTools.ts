/**
 * Assembly tools of the top bar: exploded view, parts list (BOM) and centre of mass.
 */
import { billOfMaterials, bomCsv, explodeOffsets, onExplode, setExplode } from '../core/assembly';
import { store } from '../core/store';
import type { Vec3 } from '../core/types';
import { el, esc, showMenu, toast } from './dom';
import { icon } from './icons';

interface MarkerView {
  showMarker(p: Vec3 | null, label?: string): void;
}

let view: MarkerView | null = null;
let explodeAmount = 0;
let comShown = false;

export function setAssemblyViewport(v: MarkerView) {
  view = v;
  // The marker follows the design while it is shown.
  store.onDoc(() => comShown && showCom());
  onExplode(() => {
    if (!explodeOffsets.size) explodeAmount = 0;
  });
}

const fmt = (v: number, d = 1) => v.toLocaleString('pt-BR', { maximumFractionDigits: d, minimumFractionDigits: d });

function showCom() {
  const b = billOfMaterials();
  view?.showMarker(b.centre, b.centre ? `Centro de massa · ${fmt(b.mass)} g` : '');
}

export function assemblyMenu(anchor: HTMLElement) {
  const slider = el(`<div class="explode-row">
      <span>Vista explodida</span>
      <input type="range" min="0" max="100" step="1" value="${explodeAmount}" aria-label="Vista explodida"/>
    </div>`);
  const range = slider.querySelector('input')!;
  range.addEventListener('input', () => {
    explodeAmount = Number(range.value);
    setExplode(explodeAmount);
  });
  showMenu(
    [
      { heading: 'Montagem' },
      { custom: slider },
      { label: 'Lista de peças e massa', icon: 'layers', action: openBom },
      { label: comShown ? 'Esconder centro de massa' : 'Mostrar centro de massa', icon: 'point', action: () => toggleCom() },
    ],
    anchor,
    'right',
  );
}

function toggleCom() {
  comShown = !comShown;
  if (comShown) {
    showCom();
    if (!billOfMaterials().centre) toast('Não há peças sólidas para calcular o centro de massa.', 'error');
  } else view?.showMarker(null);
}

/** Parts list with quantities, sizes, material and mass; CSV for spreadsheets. */
export function openBom() {
  const b = billOfMaterials();
  const back = el(`<div class="backdrop"></div>`);
  const total = b.rows.reduce((s, r) => s + r.qty, 0);
  const rows = b.rows
    .map(
      (r) => `<tr><td>${esc(r.name)}</td><td class="n">${r.qty}</td><td class="n">${r.size.map((x) => fmt(x)).join(' × ')}</td><td>${esc(r.material)}</td><td class="n">${fmt(r.volume / 1000, 2)}</td><td class="n">${fmt(r.mass)}</td></tr>`,
    )
    .join('');
  const modal = el(`
    <div class="modal bom-modal" role="dialog" aria-label="Lista de peças">
      <div class="modal-head">
        <div class="head-icon">${icon('layers', 20)}</div>
        <h2>Lista de peças</h2>
        <button class="btn icon-only" data-act="close" aria-label="Fechar">${icon('close')}</button>
      </div>
      <div class="bom-body">
        ${b.rows.length ? `<table class="bom">
          <thead><tr><th>Peça</th><th class="n">Qtd.</th><th class="n">Tamanho (mm)</th><th>Material</th><th class="n">Volume (cm³)</th><th class="n">Massa (g)</th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr><td>Total</td><td class="n">${total}</td><td></td><td></td><td></td><td class="n">${fmt(b.mass)}</td></tr></tfoot>
        </table>` : '<div class="hint">Nenhuma peça sólida visível.</div>'}
        ${b.centre ? `<div class="bom-com">${icon('point', 15)} Centro de massa: X ${fmt(b.centre[0])} · Y ${fmt(b.centre[1])} · Z ${fmt(b.centre[2])} mm</div>` : ''}
        <div class="hint">Massa estimada com peça 100% cheia, pela densidade do filamento de cada peça (PLA quando não há filamento). Peças ocultas e furos ficam de fora.</div>
      </div>
      <div class="modal-foot">
        <span style="flex:1"></span>
        <button class="btn soft" data-act="com">${icon('point', 16)}<span>${comShown ? 'Esconder centro de massa' : 'Mostrar centro de massa'}</span></button>
        <button class="btn primary" data-act="csv" ${b.rows.length ? '' : 'disabled'}>${icon('export', 16)}<span>Salvar CSV</span></button>
      </div>
    </div>`);
  back.appendChild(modal);
  document.body.appendChild(back);
  const close = () => {
    back.remove();
    removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  addEventListener('keydown', onKey, true);
  back.addEventListener('pointerdown', (e) => e.target === back && close());
  modal.querySelector<HTMLElement>('[data-act=close]')!.onclick = close;
  modal.querySelector<HTMLElement>('[data-act=com]')!.onclick = () => {
    toggleCom();
    close();
  };
  modal.querySelector<HTMLElement>('[data-act=csv]')!.onclick = () => {
    // BOM so the accents open right in spreadsheet programs.
    const blob = new Blob(['﻿' + bomCsv(b)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(store.doc.title || 'projeto').replace(/[\\/:*?"<>|]+/g, '_')} - lista de peças.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
}
