import { desktop, type BambuInfo, type BambuPrinterInfo, type FoundPrinter, type PrinterStatus, type PrinterTray, type SavedPrinter, type SliceResult } from '../desktop';
import { store } from '../core/store';
import { FILAMENT_TYPES, filaments } from '../core/filaments';
import { autoMapTrays, buildJob, colorLeaves, effectiveSlots, fmtDuration, planSlots, presetFor, type ColorMap, type Tray } from '../core/print';
import { el, esc, toast } from './dom';
import { icon } from './icons';

/**
 * Print dialog (desktop app only): choose printer and quality, map the model's
 * colours to filaments, slice with Bambu Studio, then save the project or send
 * it to a printer on the local network.
 */

interface Settings {
  printer: string;
  process: string;
  bedType: string;
  infill: string;
  supports: boolean;
}

const settingsKey = 'opencad:print';
const loadSettings = (): Partial<Settings> => {
  try {
    return JSON.parse(localStorage.getItem(settingsKey) ?? '{}');
  } catch {
    return {};
  }
};

// Kept across openings: the printer connection outlives the dialog.
let status: PrinterStatus = { connected: false };
let connectedSerial: string | null = null;
let listening = false;
const statusListeners = new Set<() => void>();

function listen() {
  if (listening || !desktop) return;
  listening = true;
  desktop.printers.onStatus((s) => {
    status = s;
    if (!s.connected) connectedSerial = null;
    statusListeners.forEach((f) => f());
  });
}

const trayOf = (t: PrinterTray): Tray => ({ id: t.id, amsId: t.amsId, slot: t.slot, color: t.color, type: t.type, name: t.name, empty: t.empty, external: t.external });
const allTrays = (): Tray[] => [...(status.trays ?? []).map(trayOf), ...(status.external && !status.external.empty ? [trayOf(status.external)] : [])];
const trayLabel = (t: Tray) => (t.external ? 'Carretel externo' : `AMS ${t.amsId + 1} · slot ${t.slot + 1}`) + ` · ${t.name || t.type}`;

const dot = (c: string | null, size = 16) => `<span class="dot" style="width:${size}px;height:${size}px;background:${c ?? 'transparent'}"></span>`;

function select(opts: { value: string; label: string }[], value: string, attrs = '') {
  return `<select ${attrs}>${opts.map((o) => `<option value="${esc(o.value)}" ${o.value === value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
}

export async function openPrintDialog() {
  if (!desktop) return;
  listen();
  const api = desktop;

  const back = el(`<div class="backdrop"></div>`);
  const modal = el(`
    <div class="modal print-modal" role="dialog" aria-label="Imprimir">
      <div class="modal-head">
        <div class="head-icon">${icon('printer', 20)}</div>
        <h2>Imprimir</h2>
        <span class="head-sub"></span>
        <button class="btn icon-only" data-act="close">${icon('close')}</button>
      </div>
      <div class="print-body"><div class="col left"></div><div class="col right"></div></div>
    </div>`);
  back.appendChild(modal);
  document.body.appendChild(back);
  const left = modal.querySelector<HTMLElement>('.left')!;
  const right = modal.querySelector<HTMLElement>('.right')!;

  const unsub: (() => void)[] = [];
  const close = () => {
    unsub.forEach((u) => u());
    back.remove();
    removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !(e.target as HTMLElement).matches('input, select')) {
      e.stopPropagation();
      close();
    }
  };
  addEventListener('keydown', onKey, true);
  back.addEventListener('pointerdown', (e) => e.target === back && close());
  modal.querySelector<HTMLElement>('[data-act=close]')!.onclick = close;

  // ----- state -----
  let info: BambuInfo;
  let pinfo: BambuPrinterInfo | null = null;
  const saved = loadSettings();
  const s: Settings = { printer: '', process: '', bedType: '', infill: saved.infill ?? '15%', supports: saved.supports ?? false };
  const colorMap: ColorMap = {};
  let trayPick: (number | null)[] = [];
  /** Until the user picks a tray by hand, keep matching colours to the AMS as it reports. */
  let autoPick = true;
  let result: SliceResult | null = null;
  let busy: string | null = null;
  let resultStale = false;
  let uploadPct: number | null = null;
  let discovering = false;
  let found: FoundPrinter[] = [];
  let savedPrinters: SavedPrinter[] = [];
  let connecting = false;
  let confirming = false;
  let lastSent: string | null = null;
  const form = { ip: '', serial: '', code: '', remember: true, fileName: '' };
  const safeTitle = () => store.doc.title.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'cajucad';

  const persist = () => {
    try {
      localStorage.setItem(settingsKey, JSON.stringify({ ...s, printer: undefined, process: undefined, bedType: undefined }));
      localStorage.setItem(`${settingsKey}:machine`, JSON.stringify({ printer: s.printer, process: s.process, bedType: s.bedType }));
    } catch {
      /* ignore */
    }
  };

  unsub.push(api.bambu.onProgress((m) => busy && ((busy = m), renderRight())));
  unsub.push(api.printers.onUpload((p) => ((uploadPct = p), renderRight())));
  const onStatus = () => {
    // New AMS readout: re-match slots to trays unless the user already picked.
    renderLeft();
    renderRight();
  };
  statusListeners.add(onStatus);
  unsub.push(() => statusListeners.delete(onStatus));
  unsub.push(filaments.on(() => (invalidate(), renderLeft(), renderRight())));
  unsub.push(store.onDoc(() => (invalidate(), renderLeft(), renderRight())));

  function invalidate() {
    if (result) resultStale = true;
    confirming = false;
  }

  // ----- helpers -----
  const plan = () => planSlots(colorLeaves(store.doc.nodes), colorMap);
  const suffix = () => (s.process.match(/@.*$/)?.[0] ?? '@BBL A1');
  const trays = () => allTrays();
  const connected = () => status.connected && !!connectedSerial;

  async function loadPrinter(name: string) {
    s.printer = name;
    pinfo = await api.bambu.printerInfo(name);
    if (!pinfo.processes.includes(s.process)) s.process = pinfo.processes.find((p) => p.startsWith('0.20mm Standard')) ?? pinfo.processes[0];
    persist();
  }

  // ----- left column: settings, colours, filaments -----
  function renderLeft() {
    if (!info) return;
    const { slots, entries } = plan();
    const firstNode = (i: number) => entries.find((e) => e.slot === i)!.item;
    if (autoPick || trayPick.length !== slots.length) trayPick = connected() ? autoMapTrays(slots, trays()) : slots.map(() => null);
    const tr = trays();
    const q = pinfo?.processes ?? [];

    const warnAms = connected() && tr.length === 0;
    left.innerHTML = `
      <section class="card">
        <div class="card-title">${icon('printer', 16)} Impressora e qualidade</div>
        <div class="form-grid">
          <label>Modelo ${select((info.printers ?? []).map((p) => ({ value: p, label: p.replace('Bambu Lab ', '') })), s.printer, 'data-k="printer"')}</label>
          <label>Qualidade ${select(q.map((p) => ({ value: p, label: p.replace(/ @.*$/, '') })), s.process, 'data-k="process"')}</label>
          <label>Placa da mesa ${select((info.bedTypes ?? []).map((p) => ({ value: p, label: p })), s.bedType, 'data-k="bedType"')}</label>
          <label>Preenchimento ${select(['5%', '10%', '15%', '20%', '30%', '50%'].map((p) => ({ value: p, label: p })), s.infill, 'data-k="infill"')}</label>
        </div>
        <label class="check"><input type="checkbox" data-k="supports" ${s.supports ? 'checked' : ''}/> Gerar suportes onde precisar</label>
      </section>

      <section class="card">
        <div class="card-title">${icon('spool', 16)} Cores e filamentos
          <span class="spacer"></span>
          ${connected() && tr.length ? `<button class="btn soft sm" data-act="use-ams" data-tip="Cadastrar os filamentos que estão no AMS">${icon('refresh', 14)} Ler do AMS</button>` : ''}
        </div>
        ${
          slots.length
            ? `<div class="slot-list">${slots
                .map((sl, i) => {
                  const objColor = firstNode(i).color;
                  const fOpts = [{ value: 'own', label: `Usar a cor da peça (${sl.type})` }, ...filaments.list.map((f) => ({ value: f.id, label: `${f.name} · ${f.type}` }))];
                  const cur = sl.filamentId ?? 'own';
                  return `<div class="slot-row">
                    <div class="slot-swatch">${dot(sl.color, 26)}${trayPick[i] !== null && trayPick[i] !== undefined && tr.find((t) => t.id === trayPick[i])?.color ? `<span class="arrow">→</span>${dot(tr.find((t) => t.id === trayPick[i])!.color, 26)}` : ''}</div>
                    <div class="slot-main">
                      <div class="slot-name">${esc(sl.name)} <small>${sl.count} ${sl.count === 1 ? 'objeto' : 'objetos'}</small></div>
                      ${filaments.list.length && !filaments.get(firstNode(i).filament) ? select(fOpts, cur, `data-slot="${i}" data-color="${esc(objColor.toLowerCase())}"`) : ''}
                      ${connected() && tr.length ? select([{ value: '', label: 'Sem carretel' }, ...tr.map((t) => ({ value: String(t.id), label: trayLabel(t) }))], trayPick[i] === null || trayPick[i] === undefined ? '' : String(trayPick[i]), `data-tray="${i}"`) : ''}
                    </div>
                  </div>`;
                })
                .join('')}</div>`
            : `<div class="hint">Nenhum objeto sólido na cena para imprimir.</div>`
        }
        ${slots.length > 1 ? `<div class="hint">${icon('info', 14)} Com ${slots.length} cores o Bambu Studio adiciona uma torre de limpeza e o tempo aumenta bastante nas trocas.</div>` : ''}
        ${warnAms ? `<div class="hint warn-t">${icon('warning', 14)} A impressora não informou nenhum AMS. A impressão usará o carretel externo.</div>` : ''}
      </section>

      <section class="card">
        <div class="card-title">${icon('layers', 16)} Meus filamentos <span class="spacer"></span>
          <button class="btn soft sm" data-act="add-filament">${icon('plus', 14)} Adicionar</button></div>
        ${
          filaments.list.length
            ? `<div class="fil-list">${filaments.list
                .map(
                  (f) => `<div class="fil-row" data-fid="${f.id}">
                    <label class="swatch-edit" style="background:${f.color}"><input type="color" value="${f.color}" data-f="color"/></label>
                    <input class="fil-name" value="${esc(f.name)}" data-f="name" spellcheck="false"/>
                    ${select(FILAMENT_TYPES.map((t) => ({ value: t, label: t })), f.type, 'data-f="type"')}
                    ${f.source === 'ams' ? `<span class="badge" data-tip="Lido do AMS">AMS</span>` : ''}
                    <button class="btn icon-only danger sm" data-act="del-filament" data-tip="Remover">${icon('trash', 14)}</button>
                  </div>`,
                )
                .join('')}</div>`
            : `<div class="hint">Cadastre os filamentos que você tem (ou leia do AMS depois de conectar) para pintar as peças com eles. Sem isso, cada cor da peça vira um filamento PLA.</div>`
        }
      </section>`;
  }

  left.addEventListener('change', async (e) => {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    const k = t.dataset.k;
    try {
      if (k === 'printer') {
        await loadPrinter(t.value);
        invalidate();
      } else if (k === 'process') s.process = t.value;
      else if (k === 'bedType') s.bedType = t.value;
      else if (k === 'infill') s.infill = t.value;
      else if (k === 'supports') s.supports = (t as HTMLInputElement).checked;
      if (k) {
        persist();
        invalidate();
        renderLeft();
        renderRight();
        return;
      }
      if (t.dataset.slot !== undefined) {
        colorMap[t.dataset.color!] = t.value;
        trayPick = [];
        invalidate();
      } else if (t.dataset.tray !== undefined) {
        autoPick = false;
        trayPick[Number(t.dataset.tray)] = t.value === '' ? null : Number(t.value);
        invalidate();
      } else if (t.dataset.f) {
        const id = t.closest<HTMLElement>('.fil-row')!.dataset.fid!;
        filaments.update(id, { [t.dataset.f]: t.value });
        return;
      }
      renderLeft();
      renderRight();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  });
  left.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'add-filament') {
      filaments.add({ name: 'Filamento', type: 'PLA', color: '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0') });
    } else if (b.dataset.act === 'del-filament') {
      filaments.remove(b.closest<HTMLElement>('.fil-row')!.dataset.fid!);
    } else if (b.dataset.act === 'use-ams') {
      const list = filaments.syncAms(allTrays());
      toast(`${list.length} filamentos do AMS cadastrados. Agora você pode pintar as peças com eles.`);
    }
  });

  // ----- right column: result and printer -----
  function renderRight() {
    if (!info) return;
    const { slots } = plan();
    const sliceBtnDisabled = !!busy || !slots.length || !info.available;
    const r = result;
    right.innerHTML = `
      <section class="card result-card">
        <div class="card-title">${icon('clock', 16)} Resultado</div>
        ${
          busy
            ? `<div class="busy"><div class="spinner"></div><div>${esc(busy)}</div></div>`
            : r
              ? `${resultStale ? `<div class="hint warn-t">${icon('warning', 14)} Você mudou algo depois de fatiar. Fatie de novo.</div>` : ''}
                <div class="result-grid">
                  ${r.thumbnail ? `<img class="plate" src="${r.thumbnail}" alt="Prévia da mesa"/>` : ''}
                  <div class="stats">
                    <div class="stat"><span>Tempo</span><b>${fmtDuration(r.seconds)}</b></div>
                    <div class="stat"><span>Filamento</span><b>${r.weightG !== undefined ? `${r.weightG.toFixed(0)} g` : '—'}</b></div>
                    ${r.filaments
                      .map((f) => `<div class="stat-fil">${dot(f.color)}<span>${esc(f.type)}</span><b>${f.usedG !== undefined ? f.usedG.toFixed(1) : '—'} g</b></div>`)
                      .join('')}
                  </div>
                </div>
                ${r.outsideBed ? `<div class="hint warn-t">${icon('warning', 14)} O Bambu Studio avisou que algo ficou fora da mesa.</div>` : ''}
                <div class="row-btns">
                  <button class="btn soft" data-act="save-project" data-tip="Abra no Bambu Studio para conferir ou imprimir de lá">${icon('save', 16)} Projeto .3mf</button>
                  <button class="btn soft" data-act="save-gcode" data-tip="Arquivo pronto para o cartão SD ou o app da Bambu">${icon('file', 16)} G-code .3mf</button>
                </div>`
              : `<div class="hint">${info.available ? 'Fatie para ver o tempo, o peso e a prévia da mesa.' : 'Nenhum fatiador foi encontrado. Instale o Bambu Studio, ou use o instalador “completo” do CajuCAD, que já traz o fatiador.'}</div>`
        }
        <div class="row-btns">
          <button class="btn primary grow" data-act="slice" ${sliceBtnDisabled ? 'disabled' : ''}>${icon('layers', 16)} ${r && !resultStale ? 'Fatiar de novo' : 'Fatiar'}</button>
        </div>
        <div class="tiny-row"><button class="link" data-act="project-only" ${busy || !slots.length || !info.available ? 'disabled' : ''}>Só gerar o projeto para o Bambu Studio, sem fatiar</button></div>
      </section>

      ${printerCard()}`;
  }

  function printerCard() {
    const online = connected();
    const st = status;
    const tr = trays();
    const header = `<div class="card-title">${icon('wifi', 16)} Impressora na rede
      <span class="spacer"></span>
      ${online ? `<span class="pill ok">${dot('#18b47b', 8)} conectada</span>` : ''}
    </div>`;

    if (online) {
      const printing = ['RUNNING', 'PAUSE', 'PREPARE'].includes(String(st.gcodeState));
      const sel = savedPrinters.find((p) => p.serial === connectedSerial) ?? found.find((p) => p.serial === connectedSerial);
      return `<section class="card printer-card">
        ${header}
        <div class="p-name">${esc(sel?.name ?? connectedSerial ?? '')} <small>${esc(sel?.model ?? '')}</small></div>
        <div class="temps">
          <span>Bico <b>${fmtTemp(st.nozzle)}</b></span><span>Mesa <b>${fmtTemp(st.bed)}</b></span><span>Estado <b>${stateLabel(st.gcodeState)}</b></span><span>Cartão <b>${st.sdcard === true ? 'ok' : st.sdcard === false ? 'ausente' : '—'}</b></span>
        </div>
        ${
          tr.length
            ? `<div class="ams-row">${tr.map((t) => `<div class="tray ${t.empty ? 'empty' : ''}" data-tip="${esc(trayLabel(t))}">${t.empty ? '' : dot(t.color, 30)}<small>${esc(t.external ? 'Ext' : String(t.slot + 1))}</small></div>`).join('')}</div>`
            : `<div class="hint">Sem informações do AMS ainda…</div>`
        }
        ${
          printing
            ? `<div class="progress"><span style="width:${st.percent ?? 0}%"></span></div>
               <div class="temps"><span>${st.percent ?? 0}%</span><span>Camada <b>${st.layer ?? '—'}/${st.totalLayers ?? '—'}</b></span><span>Faltam <b>${st.remainingMin ?? '—'} min</b></span></div>
               <div class="row-btns">
                 <button class="btn soft" data-act="${st.gcodeState === 'PAUSE' ? 'resume' : 'pause'}">${icon(st.gcodeState === 'PAUSE' ? 'play' : 'pause', 16)} ${st.gcodeState === 'PAUSE' ? 'Continuar' : 'Pausar'}</button>
                 <button class="btn soft danger" data-act="stop">${icon('stop', 16)} Parar</button>
               </div>`
            : printBlock()
        }
        <div class="tiny-row"><button class="link" data-act="disconnect">Desconectar</button></div>
      </section>`;
    }

    const savedHtml = savedPrinters
      .map((p) => `<button class="printer-chip" data-act="use-saved" data-serial="${esc(p.serial)}">${icon('printer', 16)}<span><b>${esc(p.name)}</b><small>${esc(p.model)} · ${esc(p.ip)}</small></span></button>`)
      .join('');
    const foundHtml = found
      .filter((f) => !savedPrinters.some((p) => p.serial === f.serial))
      .map((f) => `<button class="printer-chip" data-act="use-found" data-serial="${esc(f.serial)}">${icon('wifi', 16)}<span><b>${esc(f.name)}</b><small>${esc(f.model)} · ${esc(f.ip)}${f.lanMode ? '' : ' · modo LAN desligado'}</small></span></button>`)
      .join('');
    return `<section class="card printer-card">
      ${header}
      ${savedHtml ? `<div class="chips">${savedHtml}</div>` : ''}
      <div class="row-btns"><button class="btn soft grow" data-act="discover" ${discovering ? 'disabled' : ''}>${discovering ? 'Procurando…' : `${icon('refresh', 16)} Procurar na rede`}</button></div>
      ${foundHtml ? `<div class="chips">${foundHtml}</div>` : discovering ? '' : found.length ? '' : ''}
      <div class="form-grid tight">
        <label>IP <input data-p="ip" value="${esc(form.ip)}" placeholder="192.168.0.50" spellcheck="false"/></label>
        <label>Número de série <input data-p="serial" value="${esc(form.serial)}" placeholder="01P00A…" spellcheck="false"/></label>
        <label class="span2">Código de acesso <input data-p="code" type="password" value="${esc(form.code)}" placeholder="8 caracteres" spellcheck="false"/></label>
      </div>
      <label class="check"><input type="checkbox" data-p="remember" ${form.remember ? 'checked' : ''}/> Lembrar neste computador (guardado cifrado)</label>
      <div class="row-btns"><button class="btn primary grow" data-act="connect" ${connecting ? 'disabled' : ''}>${connecting ? 'Conectando…' : 'Conectar'}</button></div>
      <details class="help"><summary>Como achar esses dados?</summary>
        <p>Na tela da impressora, abra <b>Configurações → WLAN</b> para ver o IP e o código de acesso, e <b>Configurações → Dispositivo</b> para o número de série (também está na etiqueta).</p>
        <p>Se não conectar, ative o <b>Modo LAN</b> (e o <b>Modo Desenvolvedor</b>, se o seu firmware tiver) nas configurações da impressora. O computador e a impressora precisam estar na mesma rede.</p>
      </details>
    </section>`;
  }

  function printBlock() {
    const r = result;
    if (!r || resultStale || !r.hasGcode) return `<div class="hint">Fatie o projeto para poder enviar.</div>`;
    const { slots } = plan();
    const missing = slots.some((_, i) => trayPick[i] === null || trayPick[i] === undefined);
    const dup = new Set(trayPick.filter((t) => t !== null)).size < trayPick.filter((t) => t !== null).length;
    const noCard = status.sdcard === false
      ? `<div class="hint warn-t">${icon('warning', 14)} A impressora informa que não há cartão microSD. Sem ele o envio pela rede não funciona: salve o <b>G-code .3mf</b> e imprima pelo Bambu Studio ou pelo app da Bambu.</div>`
      : '';
    const sent = lastSent ? `<div class="hint ok-t">${icon('check', 14)} Enviado: ${esc(lastSent)}. Agora inicie a impressão na tela da impressora (Armazenamento / Cartão SD).</div>` : '';
    const uploading = uploadPct !== null;
    return `
      ${noCard}
      ${missing ? `<div class="hint warn-t">${icon('warning', 14)} Alguma cor está sem carretel. Escolha um na lista de cores ou a peça sai no carretel externo.</div>` : ''}
      ${dup ? `<div class="hint warn-t">${icon('warning', 14)} Dois filamentos do modelo foram para o mesmo carretel: eles vão sair da mesma cor.</div>` : ''}
      ${uploading ? `<div class="progress"><span style="width:${Math.round((uploadPct ?? 0) * 100)}%"></span></div><div class="hint">Enviando… ${Math.round((uploadPct ?? 0) * 100)}%</div>` : ''}
      ${sent}
      <label class="file-name">Nome do arquivo na impressora
        <span class="name-row"><input data-p="fileName" value="${esc(form.fileName)}" placeholder="${esc(safeTitle())}" spellcheck="false" maxlength="60"/><span class="name-ext">.gcode.3mf</span></span>
      </label>
      <div class="row-btns">
        ${
          confirming
            ? `<button class="btn soft grow" data-act="cancel-confirm">Cancelar</button><button class="btn danger-solid grow" data-act="print-confirm">${icon('play', 16)} Confirmar e enviar</button>`
            : `<button class="btn primary grow" data-act="print" ${uploading ? 'disabled' : ''}>${icon('play', 16)} Enviar para a impressora</button>`
        }
      </div>
      ${confirming ? `<div class="hint warn-t">${icon('warning', 14)} O arquivo vai para o cartão da impressora; a impressão é iniciada na tela dela. Antes de iniciar, confira se a mesa está livre e o ${esc(s.bedType)} está colocado.</div>` : ''}`;
  }

  right.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.p) (form as Record<string, unknown>)[t.dataset.p] = t.type === 'checkbox' ? t.checked : t.value.trim();
  });
  right.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!b || b.hasAttribute('disabled')) return;
    void action(b.dataset.act!, b.dataset.serial);
  });

  async function action(act: string, serial?: string) {
    try {
      switch (act) {
        case 'slice':
          return void (await doSlice(true));
        case 'project-only': {
          const r = await doSlice(false);
          if (r) await saveFile(r.id, 'project');
          return;
        }
        case 'save-project':
          return void (result && (await saveFile(result.id, 'project')));
        case 'save-gcode':
          return void (result && (await saveFile(result.id, 'gcode')));
        case 'discover':
          discovering = true;
          renderRight();
          found = await api.printers.discover();
          discovering = false;
          if (!found.length) toast('Nenhuma impressora anunciou na rede. Use o IP manualmente.', 'info', 4000);
          return renderRight();
        case 'use-saved': {
          const p = savedPrinters.find((x) => x.serial === serial)!;
          form.ip = p.ip;
          form.serial = p.serial;
          return void (await connect(p.hasCode));
        }
        case 'use-found': {
          const f = found.find((x) => x.serial === serial)!;
          form.ip = f.ip;
          form.serial = f.serial;
          return renderRight();
        }
        case 'connect':
          return void (await connect(false));
        case 'disconnect':
          await api.printers.disconnect();
          status = { connected: false };
          connectedSerial = null;
          trayPick = [];
          renderLeft();
          return renderRight();
        case 'print':
          confirming = true;
          return renderRight();
        case 'cancel-confirm':
          confirming = false;
          return renderRight();
        case 'print-confirm':
          return void (await doPrint());
        case 'pause':
        case 'resume':
          return await api.printers.control(act);
        case 'stop':
          if (confirm('Parar a impressão em andamento?')) await api.printers.control('stop');
          return;
      }
    } catch (err) {
      busy = null;
      discovering = false;
      connecting = false;
      uploadPct = null;
      toast((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error', 5000);
      renderRight();
    }
  }

  async function connect(useSaved: boolean) {
    if (!form.serial || (!useSaved && (!form.ip || !form.code))) throw new Error('Preencha IP, número de série e código de acesso.');
    connecting = true;
    renderRight();
    try {
      const meta = found.find((f) => f.serial === form.serial);
      await api.printers.connect({ serial: form.serial, ip: form.ip || undefined, accessCode: useSaved ? undefined : form.code, remember: form.remember, name: meta?.name, model: meta?.model });
      connectedSerial = form.serial;
      form.code = '';
      savedPrinters = await api.printers.saved();
      trayPick = [];
      toast('Conectado à impressora');
    } finally {
      connecting = false;
      renderLeft();
      renderRight();
    }
  }

  async function doSlice(slice: boolean) {
    const built = buildJob(store.doc, { width: pinfo!.bed.width, depth: pinfo!.bed.depth, maxHeight: pinfo!.maxHeight }, colorMap);
    if (!built.objects.length) throw new Error('Não há nada para imprimir. Objetos ocultos e furos soltos ficam de fora.');
    built.warnings.forEach((w) => toast(w, 'info', 6000));
    busy = slice ? 'Fatiando com o Bambu Studio…' : 'Montando o projeto…';
    renderRight();
    const sfx = suffix();
    const r = await api.bambu.slice({
      printer: s.printer,
      process: s.process,
      slice,
      objects: built.objects,
      slots: effectiveSlots(built.slots, trayPick, trays()).map((sl) => ({ preset: presetFor(sl, pinfo!.filaments, sfx), color: sl.color, type: sl.type })),
      overrides: { infill: s.infill, supports: s.supports, bedType: s.bedType, tower: built.tower },
    });
    busy = null;
    if (slice) {
      result = r;
      resultStale = false;
    }
    renderRight();
    return r;
  }

  async function saveFile(jobId: string, kind: 'project' | 'gcode') {
    const path = await api.bambu.saveProject({ jobId, kind, name: store.doc.title.replace(/[\\/:*?"<>|]+/g, '_') });
    if (path) toast(`Salvo em ${path}`, 'info', 5000);
  }

  async function doPrint() {
    if (!result || !result.hasGcode) throw new Error('Fatie antes de imprimir.');
    uploadPct = 0;
    confirming = false;
    renderRight();
    const { remoteName } = await api.printers.print({ jobId: result.id, name: form.fileName || safeTitle() });
    uploadPct = null;
    lastSent = remoteName;
    toast('Arquivo enviado! Inicie a impressão na tela da impressora (Cartão SD).', 'info', 8000);
    renderRight();
  }

  // ----- boot -----
  left.innerHTML = right.innerHTML = '';
  right.appendChild(el(`<div class="busy"><div class="spinner"></div><div>Procurando o Bambu Studio…</div></div>`));
  try {
    info = await api.bambu.info();
    savedPrinters = await api.printers.saved();
    if (info.available) {
      const prev = (() => {
        try {
          return JSON.parse(localStorage.getItem(`${settingsKey}:machine`) ?? '{}');
        } catch {
          return {};
        }
      })();
      s.printer = info.printers!.includes(prev.printer) ? prev.printer : info.defaultPrinter!;
      s.process = prev.process ?? '';
      s.bedType = info.bedTypes!.includes(prev.bedType) ? prev.bedType : info.defaultBedType!;
      await loadPrinter(s.printer);
    }
    modal.querySelector('.head-sub')!.textContent = !info.available ? '' : info.engine === 'bundled' ? 'Fatiador incluído no CajuCAD' : 'Fatiamento pelo Bambu Studio instalado neste computador';
    renderLeft();
    renderRight();
  } catch (err) {
    right.innerHTML = `<div class="hint warn-t">${esc((err as Error).message)}</div>`;
  }
}

const fmtTemp = (v?: number | null) => (v === undefined || v === null ? '—' : `${Math.round(v)}°`);
const stateLabel = (g?: string | null) =>
  ({ IDLE: 'Parada', RUNNING: 'Imprimindo', PAUSE: 'Pausada', FINISH: 'Concluída', FAILED: 'Falhou', PREPARE: 'Preparando', SLICING: 'Preparando' })[String(g)] ?? '—';

