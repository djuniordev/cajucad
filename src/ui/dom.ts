import { icon } from './icons';

export function el<T extends HTMLElement = HTMLElement>(html: string): T {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as T;
}

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

let toastHost: HTMLElement | null = null;
export function toast(msg: string, kind: 'info' | 'error' = 'info', ms = 2600) {
  toastHost ??= document.body.appendChild(el('<div class="toasts"></div>'));
  const t = el(`<div class="toast ${kind}">${esc(msg)}</div>`);
  toastHost.appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 260);
  }, ms);
}

export interface MenuItem {
  label?: string;
  icon?: string;
  kbd?: string;
  danger?: boolean;
  disabled?: boolean;
  action?: () => void;
  sep?: boolean;
  heading?: string;
  /** Raw element (e.g. a button grid). */
  custom?: HTMLElement;
}

let openMenu: HTMLElement | null = null;
export function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}

/** Floating menu anchored at a point or below an element. */
export function showMenu(items: MenuItem[], at: { x: number; y: number } | HTMLElement, align: 'left' | 'right' = 'left') {
  closeMenu();
  const m = el('<div class="menu"></div>');
  for (const it of items) {
    if (it.sep) m.appendChild(el('<div class="menu-sep"></div>'));
    else if (it.heading) m.appendChild(el(`<div class="menu-label">${esc(it.heading)}</div>`));
    else if (it.custom) m.appendChild(it.custom);
    else {
      const b = el<HTMLButtonElement>(
        `<button class="menu-item ${it.danger ? 'danger' : ''}" ${it.disabled ? 'disabled style="opacity:.4"' : ''}>${it.icon ? icon(it.icon, 16) : ''}<span>${esc(it.label ?? '')}</span>${it.kbd ? `<kbd>${esc(it.kbd)}</kbd>` : ''}</button>`,
      );
      b.onclick = () => {
        closeMenu();
        it.action?.();
      };
      m.appendChild(b);
    }
  }
  document.body.appendChild(m);
  let x: number, y: number;
  if (at instanceof HTMLElement) {
    const r = at.getBoundingClientRect();
    x = align === 'right' ? r.right - m.offsetWidth : r.left;
    y = r.bottom + 8;
  } else {
    x = at.x;
    y = at.y;
  }
  x = Math.max(8, Math.min(x, innerWidth - m.offsetWidth - 8));
  y = Math.max(8, Math.min(y, innerHeight - m.offsetHeight - 8));
  m.style.left = `${x}px`;
  m.style.top = `${y}px`;
  openMenu = m;
  setTimeout(() => {
    const off = (e: Event) => {
      if (!m.contains(e.target as Node)) {
        closeMenu();
        removeEventListener('pointerdown', off, true);
      }
    };
    addEventListener('pointerdown', off, true);
  });
  return m;
}

const fmt = (v: number, digits = 2) => String(+v.toFixed(digits));

export interface NumberFieldOpts {
  label: string;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  axis?: 'x' | 'y' | 'z';
  digits?: number;
  onCommit: (v: number) => void;
  /** Live updates while scrubbing (optional). */
  onInput?: (v: number) => void;
}

/** Compact numeric field: type a value or drag the label to scrub. */
export function numberField(o: NumberFieldOpts) {
  const f = el(`<div class="field"><label class="${o.axis ?? ''}">${esc(o.label)}</label><input inputmode="decimal" spellcheck="false"/>${o.unit ? `<span class="unit">${esc(o.unit)}</span>` : ''}</div>`);
  const input = f.querySelector('input')!;
  const label = f.querySelector('label')!;
  const clamp = (v: number) => Math.min(o.max ?? Infinity, Math.max(o.min ?? -Infinity, v));
  input.value = fmt(o.value, o.digits);
  const commit = () => {
    // Accept simple maths: "20*2", "10+5.5".
    let v = Number(input.value.replace(',', '.'));
    if (!isFinite(v) && /^[\d+\-*/(). ,]+$/.test(input.value)) {
      try {
        v = Function(`"use strict";return (${input.value.replace(/,/g, '.')})`)();
      } catch {
        v = NaN;
      }
    }
    if (!isFinite(v)) {
      input.value = fmt(o.value, o.digits);
      return;
    }
    v = clamp(v);
    input.value = fmt(v, o.digits);
    if (Math.abs(v - o.value) > 1e-9) o.onCommit(v);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      input.value = fmt(o.value, o.digits);
      input.blur();
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const s = (o.step ?? 1) * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
      input.value = fmt(clamp(Number(input.value) + s), o.digits);
    }
  });
  input.addEventListener('focus', () => input.select());
  input.addEventListener('blur', commit);

  label.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    label.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const v0 = Number(input.value) || 0;
    let v = v0;
    const move = (ev: PointerEvent) => {
      const step = (o.step ?? 1) * (ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1);
      v = clamp(Math.round((v0 + ((ev.clientX - x0) / 4) * step) / step) * step);
      input.value = fmt(v, o.digits);
      o.onInput?.(v);
    };
    const up = () => {
      label.removeEventListener('pointermove', move);
      label.removeEventListener('pointerup', up);
      if (Math.abs(v - o.value) > 1e-9) o.onCommit(v);
    };
    label.addEventListener('pointermove', move);
    label.addEventListener('pointerup', up);
  });
  return f;
}

export interface SliderOpts {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  int?: boolean;
  onCommit: (v: number) => void;
}

/** Slider + numeric field, committing once when the user releases. */
export function sliderRow(o: SliderOpts) {
  const row = el(`<div class="slider-row"><div class="slider-label">${esc(o.label)}</div><input type="range" min="${o.min}" max="${o.max}" step="${o.step}"/></div>`);
  const range = row.querySelector<HTMLInputElement>('input')!;
  const paint = () => range.style.setProperty('--p', `${((Number(range.value) - o.min) / (o.max - o.min)) * 100}%`);
  range.value = String(Math.min(o.max, Math.max(o.min, o.value)));
  paint();
  let field: HTMLElement;
  const setField = (v: number) => {
    const inp = field.querySelector('input')!;
    inp.value = fmt(v, o.int ? 0 : 2);
  };
  field = numberField({
    label: '',
    value: o.value,
    step: o.step,
    min: o.int ? Math.max(o.min, 1) : o.min,
    unit: o.unit,
    digits: o.int ? 0 : 2,
    onCommit: (v) => o.onCommit(o.int ? Math.round(v) : v),
  });
  field.querySelector('label')!.remove();
  range.addEventListener('input', () => {
    paint();
    setField(Number(range.value));
  });
  range.addEventListener('change', () => o.onCommit(Number(range.value)));
  row.appendChild(field);
  return row;
}
