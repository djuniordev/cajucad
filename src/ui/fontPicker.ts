import {
  addUploadedFonts,
  removeUploadedFont,
  familiesOf,
  getFace,
  listFaces,
  loadSystemFonts,
  onFontsChanged,
  previewCss,
  supportsLocalFonts,
  systemFontsLoaded,
  type FontFace,
} from '../core/fonts';
import { el, esc, toast } from './dom';
import { icon } from './icons';

type Filter = 'all' | 'system' | 'builtin' | 'upload';

/**
 * Modal to choose any font installed on this computer. Families are listed
 * with a live sample of the user's own text rendered in that font.
 */
export function openFontPicker(opts: { current: string; sample: string; onPick: (face: FontFace) => void }) {
  const back = el(`<div class="backdrop"></div>`);
  const modal = el(`
    <div class="modal" role="dialog" aria-label="Escolher fonte">
      <div class="modal-head">
        <h2>Fontes</h2>
        <button class="btn soft" data-act="upload" data-tip="Vários .ttf, .otf ou .woff">${icon('upload', 16)}Arquivos</button>
        <button class="btn soft" data-act="folder" data-tip="Todas as fontes de uma pasta">${icon('folder', 16)}Pasta</button>
        <button class="btn icon-only" data-act="close">${icon('close')}</button>
      </div>
      <div class="cta-slot"></div>
      <label class="search">${icon('search', 16)}<input placeholder="Buscar fonte…" /></label>
      <div class="font-tabs"></div>
      <div class="font-list"></div>
      <div class="modal-foot"><span class="count"></span><span class="spacer"></span><span>Clique num estilo para aplicar</span></div>
      <input type="file" data-in="files" accept=".ttf,.otf,.woff" multiple hidden />
      <input type="file" data-in="folder" webkitdirectory multiple hidden />
    </div>`);
  back.appendChild(modal);
  document.body.appendChild(back);

  const search = modal.querySelector<HTMLInputElement>('.search input')!;
  const list = modal.querySelector<HTMLElement>('.font-list')!;
  const tabs = modal.querySelector<HTMLElement>('.font-tabs')!;
  const cta = modal.querySelector<HTMLElement>('.cta-slot')!;
  const fileInput = modal.querySelector<HTMLInputElement>('[data-in=files]')!;
  const folderInput = modal.querySelector<HTMLInputElement>('[data-in=folder]')!;
  const sample = opts.sample.split('\n')[0].slice(0, 40) || 'Aa Bb 123';
  let filter: Filter = 'all';
  let expanded: string | null = getFace(opts.current)?.family ?? null;

  const close = () => {
    off();
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
  modal.querySelector<HTMLElement>('[data-act=upload]')!.onclick = () => fileInput.click();
  modal.querySelector<HTMLElement>('[data-act=folder]')!.onclick = () => folderInput.click();
  const ingest = async (input: HTMLInputElement) => {
    const files = [...(input.files ?? [])];
    input.value = '';
    if (!files.length) return;
    const r = await importFontFiles(files);
    if (r.added.length) {
      filter = 'upload';
      expanded = null;
      renderTabs();
      renderList();
    }
  };
  fileInput.onchange = () => ingest(fileInput);
  folderInput.onchange = () => ingest(folderInput);

  const renderCta = () => {
    cta.innerHTML = '';
    if (systemFontsLoaded()) return;
    if (!supportsLocalFonts()) {
      cta.appendChild(el(`<div class="font-cta">${icon('font', 22)}<p><b>Seu navegador não lista as fontes do computador.</b><br/>Use Chrome ou Edge, ou carregue um arquivo de fonte pelo botão acima.</p></div>`));
      return;
    }
    const box = el(`<div class="font-cta">${icon('sparkle', 22)}<p><b>Use as fontes instaladas no seu computador.</b><br/>O navegador vai pedir sua permissão uma vez.</p><button class="btn primary">Permitir</button></div>`);
    box.querySelector('button')!.onclick = async () => {
      try {
        const n = await loadSystemFonts();
        toast(`${n} estilos de fonte encontrados`);
      } catch {
        toast('Permissão negada. Você pode liberar nas configurações do site.', 'error', 4000);
      }
    };
    cta.appendChild(box);
  };

  const renderTabs = () => {
    const faces = listFaces();
    const count = (s: Filter) => (s === 'all' ? faces.length : faces.filter((f) => f.source === s).length);
    const defs: [Filter, string][] = [['all', 'Todas'], ['system', 'Do computador'], ['builtin', 'Incluídas'], ['upload', 'Carregadas']];
    tabs.innerHTML = '';
    for (const [k, label] of defs) {
      if (k !== 'all' && !count(k)) continue;
      const b = el(`<button class="chip ${filter === k ? 'active' : ''}">${label}</button>`);
      b.onclick = () => {
        filter = k;
        renderTabs();
        renderList();
      };
      tabs.appendChild(b);
    }
  };

  const renderList = () => {
    const q = search.value.trim().toLowerCase();
    const faces = listFaces().filter((f) => (filter === 'all' || f.source === filter) && (!q || f.family.toLowerCase().includes(q)));
    const fams = familiesOf(faces);
    modal.querySelector('.count')!.textContent = `${fams.length} famílias`;
    list.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const [family, styles] of fams) {
      const isCurrent = styles.some((s) => s.id === opts.current);
      const row = el(`
        <div class="font-row ${isCurrent ? 'current' : ''}">
          <div class="fr-top"><span class="fr-name">${esc(family)}</span><span class="fr-count">${styles.length > 1 ? `${styles.length} estilos` : esc(styles[0].style)}</span></div>
          <div class="fr-sample" style="${previewCss(styles[0])}">${esc(sample)}</div>
        </div>`);
      if (styles.every((f) => f.source === 'upload')) {
        const del = el<HTMLButtonElement>(`<button class="btn icon-only danger fr-del" data-tip="Remover fonte">${icon('trash', 15)}</button>`);
        del.onclick = (e) => {
          e.stopPropagation();
          styles.forEach((f) => removeUploadedFont(f.id));
        };
        row.querySelector('.fr-top')!.appendChild(del);
      }
      row.onclick = () => {
        if (styles.length === 1) {
          opts.onPick(styles[0]);
          close();
          return;
        }
        expanded = expanded === family ? null : family;
        renderList();
      };
      if (expanded === family) {
        const st = el('<div class="styles"></div>');
        for (const s of styles) {
          const c = el(`<button class="chip ${s.id === opts.current ? 'on' : ''}" style="${previewCss(s)}">${esc(s.style)}</button>`);
          c.onclick = (e) => {
            e.stopPropagation();
            opts.onPick(s);
            close();
          };
          st.appendChild(c);
        }
        row.appendChild(st);
      }
      frag.appendChild(row);
    }
    if (!fams.length) frag.appendChild(el(`<div class="empty">Nenhuma fonte encontrada.</div>`));
    list.appendChild(frag);
  };

  search.addEventListener('input', renderList);
  search.addEventListener('keydown', (e) => e.stopPropagation());
  const off = onFontsChanged(() => {
    renderCta();
    renderTabs();
    renderList();
  });
  renderCta();
  renderTabs();
  renderList();
  // Open scrolled to the font in use.
  list.querySelector('.font-row.current')?.scrollIntoView({ block: 'center' });
  setTimeout(() => search.focus(), 30);
}

/** Shared by the picker and by dropping font files on the editor. */
export async function importFontFiles(files: File[]) {
  const r = await addUploadedFonts(files);
  const fams = new Set(r.added.map((f) => f.family)).size;
  if (r.added.length) toast(`${r.added.length} ${r.added.length === 1 ? 'estilo' : 'estilos'} de ${fams} ${fams === 1 ? 'família' : 'famílias'} adicionados`);
  if (r.failed.length) toast(`Não consegui ler: ${r.failed.slice(0, 3).join(', ')}${r.failed.length > 3 ? ` e mais ${r.failed.length - 3}` : ''} (WOFF2 e TTC ainda não são suportados)`, 'error', 5000);
  if (!r.added.length && !r.failed.length) toast('Nenhum arquivo de fonte (.ttf, .otf, .woff) encontrado.', 'error');
  return r;
}
