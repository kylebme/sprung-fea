const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("desktop", {
  saveFile: (args) => ipcRenderer.invoke("save-file", args),
  platform: process.platform,
  onMenu: (handler) => {
    const listener = (_event, command) => handler(command);
    ipcRenderer.on("menu", listener);
    return () => ipcRenderer.removeListener("menu", listener);
  },
});
