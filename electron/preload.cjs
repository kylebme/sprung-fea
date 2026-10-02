const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("desktop", {
  saveFile: (args) => ipcRenderer.invoke("save-file", args),
  platform: process.platform,
});
