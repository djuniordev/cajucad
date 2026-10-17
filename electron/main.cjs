// CajuCAD desktop shell: one window running the same app as the web build,
// plus native services (system fonts today; slicing and printing next).
const { app, BrowserWindow, ipcMain, protocol, net, shell, nativeTheme } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { listSystemFonts, readSystemFont } = require('./fonts.cjs');
const bambu = require('./ipc-bambu.cjs');

const DEV_URL = process.env.OPENCAD_DEV_URL;
const DIST = path.join(__dirname, '..', 'dist');

// Serve the built app from app://opencad/ (fetch, WASM and IndexedDB work like on the web).
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const overlay = (dark) => ({
  color: '#00000000',
  symbolColor: dark ? '#c9cdd8' : '#3a3f4f',
  height: 44,
});

let win = null;

function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors;
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 620,
    show: false,
    title: 'CajuCAD',
    backgroundColor: dark ? '#0f1117' : '#eef0f5',
    titleBarStyle: 'hidden',
    titleBarOverlay: overlay(dark),
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Keep navigation inside the app.
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(DEV_URL ?? 'app://opencad/')) e.preventDefault();
  });
  win.loadURL(DEV_URL ?? 'app://opencad/index.html');
}

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(DIST, decodeURIComponent(pathname)));
    if (!file.startsWith(DIST)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  ipcMain.handle('fonts:list', () => listSystemFonts());
  ipcMain.handle('fonts:read', (_e, id) => {
    const b = readSystemFont(String(id));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  });
  bambu.register(ipcMain);
  require('./updater.cjs').register(ipcMain);
  ipcMain.on('theme:changed', (_e, dark) => {
    if (!win) return;
    win.setTitleBarOverlay(overlay(!!dark));
    win.setBackgroundColor(dark ? '#0f1117' : '#eef0f5');
  });

  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
