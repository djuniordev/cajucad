// Auto-update from GitHub Releases: checks on startup, the user decides when to download and install.
const { app, BrowserWindow } = require('electron');

function register(ipcMain) {
  const send = (state) => BrowserWindow.getAllWindows().forEach((w) => !w.isDestroyed() && w.webContents.send('update:state', state));
  // Only an installed build has update metadata; `npm run desktop` has nothing to compare against.
  if (!app.isPackaged) {
    ipcMain.handle('update:download', () => {});
    ipcMain.handle('update:install', () => {});
    return;
  }

  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (i) => send({ status: 'available', version: i.version }));
  autoUpdater.on('download-progress', (p) => send({ status: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => send({ status: 'ready', version: i.version }));
  // Being offline or having no release yet is normal: stay quiet unless the download itself fails.
  let downloading = false;
  autoUpdater.on('error', (e) => {
    if (downloading) send({ status: 'error', message: e.message });
    downloading = false;
  });

  ipcMain.handle('update:download', async () => {
    downloading = true;
    await autoUpdater.downloadUpdate();
  });
  ipcMain.handle('update:install', () => autoUpdater.quitAndInstall());

  app.whenReady().then(() => setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000));
}

module.exports = { register };
