import './styles.css';
import './print.css';
import { initGeometry, worldBounds } from './core/geometry';
import { store } from './core/store';
import { emptyDoc, type SceneNode, type ShapeKind } from './core/types';
import { SHAPES } from './core/shapes';
import { settings, SNAP_STEPS, type Theme } from './core/settings';
import * as cmd from './core/commands';
import { ACCEPT_IMPORT, FONT_EXT, autosave, exportDesign, importFile, openProjectFile, restoreAutosave, saveProjectFile, type ExportFormat } from './core/io';
import { restoreUploadedFonts, tryRestoreSystemFonts } from './core/fonts';
import { importFontFiles } from './ui/fontPicker';
import { desktop } from './desktop';
import { openPrintDialog } from './ui/printDialog';
import { Viewport, type GizmoMode } from './view/viewport';
import { Inspector } from './ui/inspector';
import { el, esc, showMenu, toast, closeMenu, type MenuItem } from './ui/dom';
import { brandLogo, icon, shapeIcon } from './ui/icons';
import { initUpdateBanner } from './ui/updateBanner';

const app = document.getElementById('app')!;
const loading = document.body.appendChild(
  el(`<div class="loading"><div class="splash">${brandLogo(64)}<div class="splash-name wordmark">caju<b>cad</b></div><div class="splash-bar"><span></span></div></div></div>`),
);

// ---------- theme ----------
const media = matchMedia('(prefers-color-scheme: dark)');
const resolvedTheme = () => (settings.theme === 'system' ? (media.matches ? 'dark' : 'light') : settings.theme);
let viewport: Viewport;
if (desktop) document.documentElement.classList.add('desktop', `os-${desktop.platform}`);
function applyTheme() {
  document.documentElement.dataset.theme = resolvedTheme();
  desktop?.setTheme(resolvedTheme() === 'dark');
  viewport?.applyTheme();
  const b = document.querySelector('[data-act=theme]');
  if (b) b.innerHTML = icon(resolvedTheme() === 'dark' ? 'sun' : 'moon');
}
media.addEventListener('change', applyTheme);
applyTheme();
initUpdateBanner();

// ---------- layout ----------
const stage = el(`<div class="stage"></div>`);
const topbar = el(`
  <header class="topbar glass">
    <div class="brand">
      <div class="logo">${brandLogo(34)}</div>
      <span class="wordmark">caju<b>cad</b></span>
      <div class="sep"></div>
      <input class="title-input" spellcheck="false" aria-label="Nome do projeto" data-tip="Nome do projeto" />
      <span class="save-state"></span>
    </div>
    <div class="spacer"></div>
    <div class="segmented" data-role="modes">
      <button class="btn active" data-mode="translate" data-tip="Mover (W)">${icon('move', 17)}<span class="lbl">Mover</span></button>
      <button class="btn" data-mode="rotate" data-tip="Girar (E)">${icon('rotate', 17)}<span class="lbl">Girar</span></button>
      <button class="btn" data-mode="scale" data-tip="Escalar (R)">${icon('scale', 17)}<span class="lbl">Escalar</span></button>
    </div>
    <div class="sep"></div>
    <div class="cluster">
      <button class="btn icon-only" data-act="undo" data-tip="Desfazer (Ctrl Z)">${icon('undo')}</button>
      <button class="btn icon-only" data-act="redo" data-tip="Refazer (Ctrl Y)">${icon('redo')}</button>
    </div>
    <div class="sep"></div>
    <div class="cluster">
      <button class="btn" data-act="group" data-tip="Agrupar (Ctrl G)">${icon('group')}<span class="lbl">Agrupar</span></button>
      <button class="btn icon-only" data-act="ungroup" data-tip="Desagrupar (Ctrl ⇧ G)">${icon('ungroup')}</button>
      <button class="btn icon-only" data-act="hole" data-tip="Furo / sólido (H)">${icon('hole')}</button>
      <button class="btn icon-only" data-act="align" data-tip="Alinhar">${icon('align')}</button>
      <button class="btn icon-only" data-act="mirror" data-tip="Espelhar">${icon('mirror')}</button>
    </div>
    <div class="spacer"></div>
    <div class="cluster">
      <button class="btn" data-act="import">${icon('import')}<span class="lbl">Importar</span></button>
      ${desktop ? `<button class="btn" data-act="print" data-tip="Fatiar e imprimir">${icon('printer')}<span class="lbl">Imprimir</span></button>` : ''}
      <button class="btn primary" data-act="export">${icon('export', 17)}<span class="lbl">Exportar</span></button>
      <button class="btn icon-only" data-act="theme" data-tip="Tema"></button>
      <button class="btn icon-only" data-act="menu" data-tip="Projeto">${icon('menu')}</button>
    </div>
  </header>`);

const library = el(`
  <aside class="library glass">
    <div class="panel-head"><span class="panel-title">Formas</span></div>
    <div class="lib-scroll">
      <div class="shape-grid"></div>
      <div class="lib-section">
        <span class="panel-title">Importar</span>
        <div class="drop-hint">${icon('upload', 20).replace('class="ic"', 'class="ic" style="margin:0 auto 6px"')}Solte STL, OBJ, 3MF, SVG ou arquivos de fonte aqui na tela, ou clique</div>
      </div>
    </div>
  </aside>`);
const grid = library.querySelector('.shape-grid')!;
for (const s of SHAPES) {
  const tile = el(`<button class="shape-tile" draggable="true" style="--tile:${s.color}" data-tip="${esc(s.label)}">${shapeIcon(s.icon)}<span>${esc(s.label)}</span></button>`);
  tile.removeAttribute('data-tip');
  tile.addEventListener('click', () => cmd.addShape(s.kind, viewTarget()));
  tile.addEventListener('dragstart', (e) => {
    e.dataTransfer!.setData('application/x-open-cad-shape', s.kind);
    e.dataTransfer!.effectAllowed = 'copy';
  });
  grid.appendChild(tile);
}

const viewbar = el(`
  <div class="viewbar glass">
    <button class="btn icon-only" data-view="home" data-tip="Vista inicial">${icon('home')}</button>
    <button class="btn icon-only" data-view="fit" data-tip="Enquadrar (F)">${icon('fit')}</button>
    <div class="sep"></div>
    <button class="btn" data-view="top" data-tip="Vista de cima">Topo</button>
    <button class="btn" data-view="front" data-tip="Vista de frente">Frente</button>
    <button class="btn" data-view="right" data-tip="Vista lateral">Lado</button>
    <div class="sep"></div>
    <button class="btn icon-only" data-view="in" data-tip="Aproximar">${icon('plus')}</button>
    <button class="btn icon-only" data-view="out" data-tip="Afastar">${icon('minus')}</button>
  </div>`);

const snapbar = el(`
  <div class="snapbar glass">
    <span class="snap-label" data-tip="Grade de encaixe">${icon('magnet', 15)}</span>
    <select data-set="snap">${SNAP_STEPS.map((s) => `<option value="${s}">${s ? `${s} mm` : 'Livre'}</option>`).join('')}</select>
    <span class="snap-label" data-tip="Encaixe de ângulo">${icon('angle', 15)}</span>
    <select data-set="snapAngle">${[0, 5, 15, 22.5, 45, 90].map((s) => `<option value="${s}">${s ? `${s}°` : 'Livre'}</option>`).join('')}</select>
    <div class="sep"></div>
    <button class="btn" data-act="space" data-tip="Eixos do gizmo">${icon('globe', 16)}<span class="space-lbl"></span></button>
  </div>`);

const fileDrop = el(`<div class="file-drop">Solte para importar</div>`);
const fileInput = el<HTMLInputElement>(`<input type="file" hidden multiple accept="${ACCEPT_IMPORT}" />`);
const projectInput = el<HTMLInputElement>(`<input type="file" hidden accept=".json,.ocad.json" />`);
const inspector = new Inspector();

app.append(stage, topbar, library, inspector.root, viewbar, snapbar, fileDrop, fileInput, projectInput);

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;

function viewportWorldSize(n: SceneNode, axis: 0 | 1 | 2) {
  const b = worldBounds(n, store.doc.assets);
  return b ? b.max.getComponent(axis) - b.min.getComponent(axis) : 0;
}

function viewTarget(): [number, number, number] {
  const t = viewport.orbit.target;
  const s = settings.snap || 1;
  return [Math.round(t.x / s) * s, Math.round(t.y / s) * s, 0];
}

// ---------- boot ----------
async function boot() {
  await initGeometry();
  viewport = new Viewport(stage);
  applyTheme();
  viewport.onContextMenu = (x, y) => contextMenu(x, y);
  viewport.onDimensionEdit = (axis, mm) => {
    const sel = store.selected;
    if (sel.length !== 1) return toast('Selecione um objeto só para digitar a medida.');
    const n = sel[0];
    const a = cmd.localAxisFor(n, axis);
    const local = cmd.localSize(n);
    const world = viewportWorldSize(n, axis);
    if (!local || !world) return;
    cmd.setLocalSize(n.id, a, local[a] * (mm / world), false);
  };
  const saved = await restoreAutosave();
  store.load(saved ?? emptyDoc());
  if (!saved || !saved.nodes.length) await seedDemo().catch((e) => console.error('demo scene', e));
  viewport.view('home');
  restoreUploadedFonts();
  tryRestoreSystemFonts();
  refreshChrome();
  if (import.meta.env.DEV) Object.assign(window, { __oc: { store, cmd, viewport } });
  loading.classList.add('done');
  setTimeout(() => loading.remove(), 500);
}

async function seedDemo() {
  await cmd.addShape('box', [-25, 0, 0]);
  await cmd.addShape('cylinder', [10, 0, 0]);
  const t = await cmd.addShape('text', [0, -30, 0]);
  await cmd.updateText(t.id, { text: 'CajuCAD', size: 14 });
  store.load(store.doc);
}

// ---------- chrome state ----------
const titleInput = $<HTMLInputElement>('.title-input', topbar);
const saveState = $('.save-state', topbar);
titleInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') titleInput.blur();
});
titleInput.addEventListener('change', () => {
  store.doc.title = titleInput.value.trim() || 'Projeto sem título';
  scheduleSave();
});

function refreshChrome() {
  if (document.activeElement !== titleInput) titleInput.value = store.doc.title;
  $<HTMLButtonElement>('[data-act=undo]', topbar).disabled = !store.canUndo;
  $<HTMLButtonElement>('[data-act=redo]', topbar).disabled = !store.canRedo;
  const sel = store.selected;
  $<HTMLButtonElement>('[data-act=group]', topbar).disabled = sel.length < 2;
  $<HTMLButtonElement>('[data-act=ungroup]', topbar).disabled = !sel.some((n) => n.kind === 'group');
  for (const a of ['hole', 'mirror']) $<HTMLButtonElement>(`[data-act=${a}]`, topbar).disabled = !sel.length;
  $<HTMLButtonElement>('[data-act=align]', topbar).disabled = sel.length < 2;
  $<HTMLSelectElement>('[data-set=snap]', snapbar).value = String(settings.snap);
  $<HTMLSelectElement>('[data-set=snapAngle]', snapbar).value = String(settings.snapAngle);
  $('.space-lbl', snapbar).textContent = settings.localSpace ? 'Local' : 'Global';
}
store.onSelection(refreshChrome);
settings.on(refreshChrome);

let saveTimer = 0;
function scheduleSave() {
  saveState.textContent = 'Salvando…';
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    await autosave(store.doc);
    saveState.textContent = 'Salvo neste navegador';
  }, 600);
}
store.onDoc(() => {
  refreshChrome();
  scheduleSave();
});

// ---------- actions ----------
function setMode(mode: GizmoMode) {
  viewport.setMode(mode);
  topbar.querySelectorAll<HTMLElement>('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
}
topbar.querySelectorAll<HTMLElement>('[data-mode]').forEach((b) => (b.onclick = () => setMode(b.dataset.mode as GizmoMode)));

function alignMenu(anchor: HTMLElement) {
  const g = el(`<div class="menu-grid"></div>`);
  const names = [['Esq', 'Centro X', 'Dir'], ['Frente', 'Centro Y', 'Trás'], ['Base', 'Meio Z', 'Topo']];
  names.forEach((row, ax) =>
    (['min', 'center', 'max'] as const).forEach((m, j) => {
      const b = el<HTMLButtonElement>(`<button class="btn">${row[j]}</button>`);
      b.onclick = () => {
        closeMenu();
        cmd.align(ax as 0 | 1 | 2, m);
      };
      g.appendChild(b);
    }),
  );
  showMenu([{ heading: 'Alinhar seleção' }, { custom: g }], anchor);
}

const mirrorItems = (): MenuItem[] => [
  { heading: 'Espelhar' },
  { label: 'Eixo X (esquerda ↔ direita)', icon: 'mirror', action: () => cmd.mirror(0) },
  { label: 'Eixo Y (frente ↔ trás)', icon: 'mirror', action: () => cmd.mirror(1) },
  { label: 'Eixo Z (cima ↔ baixo)', icon: 'mirror', action: () => cmd.mirror(2) },
];

async function doExport(fmt: ExportFormat, onlySelection = false) {
  try {
    await exportDesign(store.doc, fmt, onlySelection ? new Set(store.selection) : undefined);
    toast(`Exportado como ${fmt.toUpperCase()}`);
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

function exportMenu(anchor: HTMLElement) {
  const sel = store.selection.size > 0;
  showMenu(
    [
      { heading: 'Impressão 3D' },
      { label: 'STL', icon: 'file', kbd: '.stl', action: () => doExport('stl') },
      { label: 'OBJ', icon: 'file', kbd: '.obj', action: () => doExport('obj') },
      { heading: 'Com cores' },
      { label: 'GLB (glTF)', icon: 'file', kbd: '.glb', action: () => doExport('glb') },
      ...(sel ? [{ sep: true }, { label: 'Só a seleção como STL', icon: 'export', action: () => doExport('stl', true) }] : []),
    ],
    anchor,
    'right',
  );
}

function projectMenu(anchor: HTMLElement) {
  const themes: [Theme, string][] = [['system', 'Tema do sistema'], ['light', 'Tema claro'], ['dark', 'Tema escuro']];
  showMenu(
    [
      { label: 'Novo projeto', icon: 'newDoc', action: newProject },
      { label: 'Abrir projeto…', icon: 'folder', kbd: 'Ctrl O', action: () => projectInput.click() },
      { label: 'Salvar arquivo do projeto', icon: 'save', kbd: 'Ctrl S', action: () => saveProjectFile(store.doc) },
      { sep: true },
      { label: 'Mostrar objetos ocultos', icon: 'eye', action: cmd.showAll, disabled: !store.doc.nodes.some((n) => n.hidden) },
      { sep: true },
      ...themes.map(([t, label]) => ({ label: label + (settings.theme === t ? '  ✓' : ''), icon: t === 'dark' ? 'moon' : 'sun', action: () => { settings.set('theme', t); applyTheme(); } })),
    ],
    anchor,
    'right',
  );
}

function newProject() {
  if (store.doc.nodes.length && !confirm('Começar um projeto novo? O atual será substituído (salve o arquivo antes se quiser guardá-lo).')) return;
  store.load(emptyDoc());
  viewport.view('home');
}

function contextMenu(x: number, y: number) {
  const sel = store.selected;
  showMenu(
    [
      { label: 'Duplicar', icon: 'copy', kbd: 'Ctrl D', action: () => cmd.duplicateSelection([10, 10, 0]) },
      { label: sel.every((n) => n.hole) ? 'Tornar sólido' : 'Tornar furo', icon: 'hole', kbd: 'H', action: cmd.toggleHole },
      ...(sel.length > 1 ? [{ label: 'Agrupar', icon: 'group', kbd: 'Ctrl G', action: cmd.groupSelection }] : []),
      ...(sel.some((n) => n.kind === 'group') ? [{ label: 'Desagrupar', icon: 'ungroup', kbd: 'Ctrl ⇧ G', action: cmd.ungroupSelection }] : []),
      { label: 'Soltar na mesa', icon: 'drop', kbd: 'D', action: cmd.dropToPlane },
      { label: sel.every((n) => n.locked) ? 'Destravar' : 'Travar', icon: 'lock', kbd: 'L', action: cmd.toggleLock },
      { label: 'Ocultar', icon: 'eyeOff', action: cmd.hideSelection },
      { label: 'Exportar seleção (STL)', icon: 'export', action: () => doExport('stl', true) },
      { sep: true },
      { label: 'Excluir', icon: 'trash', kbd: 'Del', danger: true, action: cmd.deleteSelection },
    ],
    { x, y },
  );
}

topbar.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!b) return;
  switch (b.dataset.act) {
    case 'undo': return store.undo();
    case 'redo': return store.redo();
    case 'group': return cmd.groupSelection();
    case 'ungroup': return cmd.ungroupSelection();
    case 'hole': return cmd.toggleHole();
    case 'align': return alignMenu(b);
    case 'mirror': return showMenu(mirrorItems(), b);
    case 'import': return fileInput.click();
    case 'export': return exportMenu(b);
    case 'print': return void openPrintDialog();
    case 'menu': return projectMenu(b);
    case 'theme':
      settings.set('theme', resolvedTheme() === 'dark' ? 'light' : 'dark');
      return applyTheme();
  }
});

viewbar.addEventListener('click', (e) => {
  const v = (e.target as HTMLElement).closest<HTMLElement>('[data-view]')?.dataset.view;
  if (!v) return;
  if (v === 'fit') viewport.frameSelection();
  else if (v === 'in') viewport.zoom(0.7);
  else if (v === 'out') viewport.zoom(1.4);
  else viewport.view(v as 'home' | 'top' | 'front' | 'right');
});

snapbar.addEventListener('change', (e) => {
  const s = e.target as HTMLSelectElement;
  if (s.dataset.set === 'snap') settings.set('snap', Number(s.value));
  if (s.dataset.set === 'snapAngle') settings.set('snapAngle', Number(s.value));
});
$('[data-act=space]', snapbar).onclick = () => settings.set('localSpace', !settings.localSpace);
$('.drop-hint', library).onclick = () => fileInput.click();

// ---------- import / files ----------
async function importFiles(files: FileList | File[]) {
  const all = Array.from(files);
  const fonts = all.filter((f) => FONT_EXT.test(f.name) || /\.(woff2|ttc)$/i.test(f.name));
  if (fonts.length) await importFontFiles(fonts);
  for (const f of all.filter((x) => !fonts.includes(x))) {
    if (/\.json$/i.test(f.name)) {
      try {
        store.load(await openProjectFile(f));
        viewport.view('home');
        toast('Projeto aberto');
      } catch (e) {
        toast((e as Error).message, 'error');
      }
      continue;
    }
    try {
      const r = await importFile(f);
      cmd.addImported(r.nodes, r.assets);
      if (r.warning) toast(r.warning, 'info', 5000);
      else toast(`“${f.name}” importado`);
      viewport.frameSelection();
    } catch (e) {
      toast((e as Error).message || `Não consegui importar ${f.name}`, 'error', 4500);
    }
  }
}
fileInput.onchange = () => {
  if (fileInput.files) importFiles(fileInput.files);
  fileInput.value = '';
};
projectInput.onchange = () => {
  if (projectInput.files) importFiles(projectInput.files);
  projectInput.value = '';
};

let dragDepth = 0;
const isFileDrag = (e: DragEvent) => e.dataTransfer?.types.includes('Files');
addEventListener('dragenter', (e) => {
  if (!isFileDrag(e)) return;
  dragDepth++;
  fileDrop.classList.add('on');
});
addEventListener('dragleave', (e) => {
  if (!isFileDrag(e)) return;
  if (--dragDepth <= 0) fileDrop.classList.remove('on');
});
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  fileDrop.classList.remove('on');
  const kind = e.dataTransfer?.getData('application/x-open-cad-shape');
  if (kind) {
    cmd.addShape(kind as ShapeKind, viewport.workplanePoint(e.clientX, e.clientY));
    return;
  }
  if (e.dataTransfer?.files.length) importFiles(e.dataTransfer.files);
});

// ---------- keyboard ----------
addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t.matches('input, textarea, select')) return;
  const k = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  const step = (settings.snap || 1) * (e.shiftKey ? 10 : 1);
  const handled = () => e.preventDefault();

  if (mod) {
    if (k === 'z' && !e.shiftKey) return handled(), store.undo();
    if (k === 'y' || (k === 'z' && e.shiftKey)) return handled(), store.redo();
    if (k === 'g' && e.shiftKey) return handled(), cmd.ungroupSelection();
    if (k === 'g') return handled(), cmd.groupSelection();
    if (k === 'd') return handled(), cmd.duplicateSelection([10, 10, 0]);
    if (k === 'c') return cmd.copySelection();
    if (k === 'v') return handled(), cmd.paste();
    if (k === 'a') return handled(), cmd.selectAll();
    if (k === 's') return handled(), saveProjectFile(store.doc);
    if (k === 'o') return handled(), projectInput.click();
    if (k === 'arrowup') return handled(), cmd.nudge([0, 0, step]);
    if (k === 'arrowdown') return handled(), cmd.nudge([0, 0, -step]);
    return;
  }
  switch (k) {
    case 'delete':
    case 'backspace': return handled(), cmd.deleteSelection();
    case 'escape': closeMenu(); return store.clearSelection();
    case 'w': return setMode('translate');
    case 'e': return setMode('rotate');
    case 'r': return setMode('scale');
    case 'h': return cmd.toggleHole();
    case 'd': return cmd.dropToPlane();
    case 'l': return cmd.toggleLock();
    case 'f': return viewport.frameSelection();
    case 'arrowleft': return handled(), cmd.nudge([-step, 0, 0]);
    case 'arrowright': return handled(), cmd.nudge([step, 0, 0]);
    case 'arrowup': return handled(), cmd.nudge([0, step, 0]);
    case 'arrowdown': return handled(), cmd.nudge([0, -step, 0]);
  }
});

boot().catch((err) => {
  console.error(err);
  loading.innerHTML = `<div style="text-align:center;max-width:420px;line-height:1.5"><b>Não foi possível iniciar o editor.</b><br/>${esc(String(err?.message ?? err))}</div>`;
});
