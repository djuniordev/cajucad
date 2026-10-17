// IPC surface for slicing and printing (everything the renderer may ask for).
const { app, dialog, safeStorage, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const slicer = require('./slicer.cjs');
const printer = require('./printer.cjs');

const storeFile = () => path.join(app.getPath('userData'), 'printers.json');
const logFile = () => path.join(app.getPath('userData'), 'printer-log.txt');

/** Keep a short diagnostics log of printer conversations (never the access code). */
function logLine(line) {
  try {
    const f = logFile();
    const prev = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').slice(-20000) : '';
    fs.writeFileSync(f, `${prev}${new Date().toISOString()} ${line}
`);
  } catch {
    /* logging must never break printing */
  }
}

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(storeFile(), 'utf8').replace(/^﻿/, ''));
  } catch {
    return [];
  }
}
const writeStore = (list) => fs.writeFileSync(storeFile(), JSON.stringify(list, null, 2));

// The access code is a secret: keep it encrypted with the OS (DPAPI on Windows).
const encrypt = (code) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(code).toString('base64') : null);
const decrypt = (b64) => {
  try {
    return b64 && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(b64, 'base64')) : null;
  } catch {
    return null;
  }
};

const publicView = (p) => ({ serial: p.serial, ip: p.ip, name: p.name, model: p.model, hasCode: !!p.code });

function register(ipcMain) {
  const send = (ch, payload) => BrowserWindow.getAllWindows().forEach((w) => !w.isDestroyed() && w.webContents.send(ch, payload));
  /** Sliced projects stay on disk; the renderer only holds an id. */
  const jobs = new Map();
  let session = null;

  ipcMain.handle('bambu:info', () => slicer.info());
  ipcMain.handle('bambu:printerInfo', (_e, name) => slicer.printerInfo(String(name)));

  ipcMain.handle('bambu:slice', async (_e, job) => {
    const r = await slicer.slice(job, (m) => send('bambu:progress', m));
    const id = `${Date.now()}`;
    jobs.set(id, { file: r.file, sliced: !!job.slice });
    for (const k of [...jobs.keys()].slice(0, -6)) jobs.delete(k);
    const { dir, file, ...rest } = r;
    return { id, ...rest };
  });

  ipcMain.handle('bambu:saveProject', async (_e, { jobId, name, kind }) => {
    const j = jobs.get(jobId);
    if (!j) throw new Error('O projeto fatiado expirou. Fatie de novo.');
    const ext = kind === 'gcode' ? 'gcode.3mf' : '3mf';
    const res = await dialog.showSaveDialog({
      title: kind === 'gcode' ? 'Salvar arquivo para a impressora' : 'Salvar projeto para o Bambu Studio',
      defaultPath: path.join(app.getPath('documents'), `${name || 'cajucad'}.${ext}`),
      filters: [{ name: kind === 'gcode' ? 'Bambu G-code 3MF' : 'Projeto 3MF', extensions: ['3mf'] }],
    });
    if (res.canceled || !res.filePath) return null;
    fs.copyFileSync(j.file, res.filePath);
    return res.filePath;
  });

  // ----- printers -----
  ipcMain.handle('printers:discover', () => printer.discover(6000));
  ipcMain.handle('printers:saved', () => readStore().map(publicView));
  ipcMain.handle('printers:forget', (_e, serial) => {
    writeStore(readStore().filter((p) => p.serial !== serial));
  });

  ipcMain.handle('printers:connect', async (_e, { serial, ip, name, model, accessCode, remember }) => {
    const saved = readStore().find((p) => p.serial === serial);
    const code = accessCode || decrypt(saved?.code);
    if (!code) throw new Error('Informe o código de acesso da impressora.');
    session?.close();
    // Ports can be overridden to talk to a local simulator (development only).
    const ports = { mqttPort: Number(process.env.OPENCAD_MQTT_PORT) || undefined, ftpPort: Number(process.env.OPENCAD_FTP_PORT) || undefined };
    const s = new printer.Session({ ip: ip || saved?.ip, serial, accessCode: code }, (st) => send('printer:status', st), { ...ports, log: logLine });
    await s.connect();
    session = s;
    if (remember) {
      const list = readStore().filter((p) => p.serial !== serial);
      list.push({ serial, ip: ip || saved?.ip, name: name || saved?.name || serial, model: model || saved?.model || '', code: encrypt(code) });
      writeStore(list);
    }
    return { ok: true };
  });

  ipcMain.handle('printers:disconnect', () => {
    session?.close();
    session = null;
  });

  ipcMain.handle('printers:print', async (_e, { jobId, name }) => {
    if (!session?.connected) throw new Error('Conecte à impressora primeiro.');
    const j = jobs.get(jobId);
    if (!j?.sliced) throw new Error('Fatie o projeto antes de enviar.');
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    // The user picks the name; keep it valid for the card (no path or reserved characters).
    const base = String(name ?? '')
      .replace(/(\.gcode)?\.3mf$/i, '')
      .replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_')
      .replace(/^[. ]+|[. ]+$/g, '')
      .slice(0, 60);
    const remoteName = `${base || `cajucad_${stamp}`}.gcode.3mf`;
    logLine(`[print] enviando ${remoteName} (${j.file})`);
    let uploadedAs;
    try {
      uploadedAs = await session.upload(j.file, remoteName, (p) => send('printer:upload', p));
    } catch (e) {
      logLine(`[print] erro: ${e.message}`);
      throw new Error(`${e.message} Detalhes em: ${logFile()}`);
    }
    // Current firmware rejects unsigned MQTT commands (error 0500-0500-0001-0007), so the print is started
    // on the printer itself; we only deliver the file to its storage.
    logLine(`[print] arquivo enviado para /${uploadedAs} (início manual na impressora)`);
    return { remoteName };
  });

  ipcMain.handle('printers:control', async (_e, action) => {
    if (!session?.connected) throw new Error('Impressora desconectada.');
    if (action === 'pause') await session.pausePrint();
    else if (action === 'resume') await session.resumePrint();
    else if (action === 'stop') await session.stopPrint();
  });

  app.on('before-quit', () => session?.close());
}

module.exports = { register };
