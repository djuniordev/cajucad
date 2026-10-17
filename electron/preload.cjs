// Narrow, explicit API exposed to the page as window.opencad (no Node access).
const { contextBridge, ipcRenderer } = require('electron');

/** Subscribe to a main-process event; returns an unsubscribe function. */
const on = (channel, fn) => {
  const h = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('opencad', {
  platform: process.platform,
  listFonts: () => ipcRenderer.invoke('fonts:list'),
  readFont: (id) => ipcRenderer.invoke('fonts:read', id),
  setTheme: (dark) => ipcRenderer.send('theme:changed', !!dark),

  update: {
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    onState: (fn) => on('update:state', fn),
  },

  // Bambu Studio: slicing and projects
  bambu: {
    info: () => ipcRenderer.invoke('bambu:info'),
    printerInfo: (name) => ipcRenderer.invoke('bambu:printerInfo', name),
    slice: (job) => ipcRenderer.invoke('bambu:slice', job),
    saveProject: (args) => ipcRenderer.invoke('bambu:saveProject', args),
    onProgress: (fn) => on('bambu:progress', fn),
  },

  // Printers on the local network
  printers: {
    discover: () => ipcRenderer.invoke('printers:discover'),
    saved: () => ipcRenderer.invoke('printers:saved'),
    forget: (serial) => ipcRenderer.invoke('printers:forget', serial),
    connect: (args) => ipcRenderer.invoke('printers:connect', args),
    disconnect: () => ipcRenderer.invoke('printers:disconnect'),
    print: (args) => ipcRenderer.invoke('printers:print', args),
    control: (action) => ipcRenderer.invoke('printers:control', action),
    onStatus: (fn) => on('printer:status', fn),
    onUpload: (fn) => on('printer:upload', fn),
  },
});
