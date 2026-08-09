import { app, BrowserWindow, dialog } from "electron";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureLocalCore } from "./local-core-client.mjs";

app.setName("Teamline");
const sourceRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

let mainWindow = null;
let quitting = false;
let coreConnection = null;

function createMainWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1_280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: "Teamline",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#f5f7f5",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  void mainWindow.loadURL(coreConnection.url.toString());
  mainWindow.once("ready-to-show", () => mainWindow?.show());
}

app.whenReady().then(async () => {
  try {
    coreConnection = await ensureLocalCore({
      dataDirectory:
        process.env.TEAMLINE_DATA_DIR || resolve(sourceRoot, ".teamline"),
      url: process.env.TEAMLINE_URL || "http://127.0.0.1:4310",
      serverScript:
        process.env.TEAMLINE_SERVER_SCRIPT ||
        resolve(sourceRoot, "src/server.ts"),
    });
    createMainWindow();
  } catch (error) {
    dialog.showErrorBox(
      "Teamline 无法启动",
      error instanceof Error ? error.message : "无法连接本机 Local Core",
    );
    app.quit();
  }
});

app.on("activate", () => {
  if (coreConnection) createMainWindow();
});

app.on("before-quit", () => {
  quitting = true;
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});
