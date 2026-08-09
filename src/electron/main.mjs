import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Tray,
} from "electron";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureLocalCore } from "./local-core-client.mjs";
import { requestLocalCoreStop } from "./local-core-control.mjs";
import { resolveClientDataDirectory } from "./data-directory.mjs";

app.setName("Teamline");
const sourceRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

let mainWindow = null;
let settingsWindow = null;
let tray = null;
let quitting = false;
let stoppingCore = false;
let coreConnection = null;

const artifactActions = new Set(["open", "reveal", "quicklook"]);

function installArtifactActionBridge() {
  ipcMain.handle("teamline:artifact-action", async (_event, request) => {
    const workOrderId = request?.workOrderId;
    const path = request?.path;
    const action = request?.action;
    if (
      typeof workOrderId !== "string" ||
      !workOrderId.trim() ||
      typeof path !== "string" ||
      !path.trim() ||
      typeof action !== "string" ||
      !artifactActions.has(action)
    ) {
      throw new Error("成果操作请求无效");
    }
    if (!coreConnection) throw new Error("Local Core 尚未连接");

    const response = await fetch(
      new URL(`/api/work-orders/${encodeURIComponent(workOrderId)}/artifacts/open`, coreConnection.url),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, delegate: true, path }),
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "无法确认这个成果路径");
    }
    if (
      payload.action !== action ||
      typeof payload.authorizedPath !== "string" ||
      !payload.authorizedPath.startsWith("/")
    ) {
      throw new Error("Local Core 没有返回可用的成果路径");
    }
    await executeArtifactAction(payload.authorizedPath, action);
    return { opened: true };
  });
}

async function executeArtifactAction(path, action) {
  if (action === "quicklook") {
    if (process.platform !== "darwin" || !existsSync("/usr/bin/qlmanage")) {
      throw new Error("Quick Look 当前不可用");
    }
    const child = spawn("/usr/bin/qlmanage", ["-p", path], {
      detached: true,
      stdio: "ignore",
    });
    await new Promise((resolve, reject) => {
      let settled = false;
      let launchTimer;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        if (launchTimer) clearTimeout(launchTimer);
        reject(error);
      };
      child.once("spawn", () => {
        launchTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.unref();
          resolve();
        }, 250);
      });
      child.once("close", (code) => {
        if (settled) return;
        if (launchTimer) clearTimeout(launchTimer);
        if (code === 0) {
          settled = true;
          resolve();
          return;
        }
        fail(new Error("Quick Look 无法打开这个成果"));
      });
      child.once("error", fail);
    });
    return;
  }

  if (process.platform !== "darwin") {
    throw new Error("系统文件操作当前仅支持 macOS");
  }
  const args = action === "reveal" ? ["-R", path] : [path];
  await new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/open", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || "无法执行这个成果操作"));
    });
  });
}

function createMainWindow() {
  if (mainWindow) {
    showMainWindow();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1_280,
    height: 860,
    minWidth: 860,
    minHeight: 600,
    show: false,
    title: "Teamline",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: process.platform === "darwin" ? { x: 14, y: 12 } : undefined,
    backgroundColor: "#f5f7f5",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: resolve(sourceRoot, "src/electron/preload.cjs"),
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

function showMainWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    if (mainWindow.isMinimized()) mainWindow.restore();
    return;
  }
  createMainWindow();
}

function createTray() {
  if (tray || !coreConnection) return;
  const icon = nativeImage.createFromPath(resolve(sourceRoot, "public/teamline-logo.png"));
  tray = new Tray(icon);
  tray.setToolTip("Teamline");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示 Teamline", click: showMainWindow },
      { type: "separator" },
      { label: "退出客户端", role: "quit" },
      { label: "退出并停止后台服务", click: () => void stopCoreAndQuit() },
    ]),
  );
  tray.on("click", showMainWindow);
}

function installApplicationMenu() {
  const appMenu = [
    { label: "显示 Teamline", click: showMainWindow },
    { label: "设置…", click: openSettingsWindow },
    { type: "separator" },
    { label: "退出并停止后台服务", click: () => void stopCoreAndQuit() },
    { label: "退出 Teamline", role: "quit" },
  ];
  const template = process.platform === "darwin"
    ? [{ label: app.getName(), submenu: appMenu }]
    : [{ label: "Teamline", submenu: appMenu }];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function openSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 640,
    height: 480,
    minWidth: 520,
    minHeight: 360,
    title: "Teamline 设置",
    parent: mainWindow ?? undefined,
    backgroundColor: "#f5f7f5",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
  const markup = `<!doctype html><meta charset="utf-8"><title>Teamline 设置</title><style>body{margin:0;padding:32px;font:14px -apple-system,BlinkMacSystemFont,sans-serif;color:#20211f;background:#f7f7f4}h1{font-size:22px;font-weight:650}section{margin-top:24px;padding:16px;border:1px solid #dedfda;border-radius:10px;background:#fff}p{color:#555852;line-height:1.6}</style><h1>Teamline 设置</h1><section><strong>客户端</strong><p>主窗口、Local Core 与本地数据目录彼此独立。详细诊断和恢复入口仍保留在主窗口的本地数据面板。</p></section>`;
  void settingsWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(markup)}`);
}

async function choosePackagedDataDirectory({ canonicalDirectory, candidates }) {
  const hasCandidates = candidates.length > 0;
  const response = await dialog.showMessageBox(mainWindow, {
    type: "question",
    title: "选择 Teamline 数据",
    message: hasCandidates
      ? "Teamline 找到了可选择的旧数据目录"
      : "Teamline 还没有绑定本地数据目录",
    detail: hasCandidates
      ? `${candidates.join("、")}\n\n可以选择旧数据，或确认在 ${canonicalDirectory} 新建。`
      : `确认后将在 ${canonicalDirectory} 新建本地数据目录。`,
    buttons: hasCandidates ? ["选择现有数据", "新建空数据", "取消"] : ["新建空数据", "取消"],
    defaultId: hasCandidates ? 0 : 1,
    cancelId: hasCandidates ? 2 : 1,
  });
  const createIndex = hasCandidates ? 1 : 0;
  if (response.response === createIndex) return { action: "create" };
  if (!hasCandidates || response.response !== 0) return { action: "cancel" };

  const selected = await dialog.showOpenDialog(mainWindow, {
    title: "选择 Teamline 数据目录",
    message: "选择包含 teamline.db 的现有 .teamline 目录",
    properties: ["openDirectory"],
    buttonLabel: "使用此数据目录",
  });
  return selected.canceled || !selected.filePaths[0]
    ? { action: "cancel" }
    : { action: "use", dataDirectory: selected.filePaths[0] };
}

async function stopCoreAndQuit() {
  if (stoppingCore || !coreConnection) return;
  stoppingCore = true;
  try {
    const result = await requestLocalCoreStop({
      url: coreConnection.url,
      confirmStop: async (activeWorkOrders) => {
        const confirmation = await dialog.showMessageBox(mainWindow, {
          type: "warning",
          title: "退出并停止后台服务",
          message: "仍有运行中的目标",
          detail: `停止后台服务会先安全中断 ${activeWorkOrders.length} 个运行中的目标。Local Core 停止后，自动监控也会暂停。`,
          buttons: ["取消", "退出并停止"],
          defaultId: 0,
          cancelId: 0,
        });
        return confirmation.response === 1;
      },
    });
    if (result.cancelled) return;
    quitting = true;
    app.quit();
  } catch (error) {
    dialog.showErrorBox(
      "无法停止后台服务",
      error instanceof Error ? error.message : "Local Core 没有安全停止",
    );
  } finally {
    stoppingCore = false;
  }
}

app.whenReady().then(async () => {
  try {
    const dataDirectory = await resolveClientDataDirectory({
      environment: process.env,
      packaged: app.isPackaged,
      projectRoot: sourceRoot,
      userDataPath: app.isPackaged ? app.getPath("userData") : undefined,
      legacyDirectories: [resolve(sourceRoot, ".teamline")],
      chooseDataDirectory: choosePackagedDataDirectory,
    });
    coreConnection = await ensureLocalCore({
      dataDirectory: dataDirectory.dataDirectory,
      url: process.env.TEAMLINE_URL || "http://127.0.0.1:4310",
      serverScript:
        process.env.TEAMLINE_SERVER_SCRIPT ||
        resolve(sourceRoot, "src/server.ts"),
    });
    installApplicationMenu();
    installArtifactActionBridge();
    createTray();
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
