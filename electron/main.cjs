const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  nativeTheme,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
let engine, window;
app.whenReady().then(async () => {
  if (!process.env.BETTERSIM_DEV) {
    const { createServer } = await import("../server/index.mjs");
    const resources = app.isPackaged
      ? process.resourcesPath
      : path.resolve(__dirname, "..");
    engine = await createServer({
      port: 0,
      dataDir: path.join(app.getPath("userData"), "studies"),
      resourceDir: resources,
      workerExecutable: app.isPackaged
        ? path.join(resources, "runtime", "bettersim-engine")
        : null,
    });
  }
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1040,
    minHeight: 720,
    title: "BetterSim",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0d0f11" : "#f3f4f6",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const url = process.env.BETTERSIM_DEV
    ? "http://127.0.0.1:5173"
    : `http://127.0.0.1:${engine.port}`;
  window.webContents.on("will-navigate", (event, target) => {
    if (new URL(target).origin !== new URL(url).origin) event.preventDefault();
  });
  await window.loadURL(url);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "BetterSim",
        submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }],
      },
      {
        label: "Edit",
        // Undo and redo go to the renderer, which applies them to the text
        // field being edited or, otherwise, to the study history.
        submenu: [
          {
            id: "undo",
            label: "Undo",
            accelerator: "CmdOrCtrl+Z",
            click: () => window.webContents.send("menu", "undo"),
          },
          {
            id: "redo",
            label: "Redo",
            accelerator: "Shift+CmdOrCtrl+Z",
            click: () => window.webContents.send("menu", "redo"),
          },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "toggleDevTools" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { role: "togglefullscreen" },
        ],
      },
    ]),
  );
});
ipcMain.handle("save-file", async (event, { name, content, type }) => {
  if (event.sender !== window.webContents) return;
  const { filePath, canceled } = await dialog.showSaveDialog(window, {
    defaultPath: name,
  });
  if (canceled) return false;
  const data = type === "base64" ? Buffer.from(content, "base64") : content;
  await fs.writeFile(filePath, data);
  return true;
});
app.on("before-quit", () => {
  engine?.close();
});
app.on("window-all-closed", () => app.quit());
