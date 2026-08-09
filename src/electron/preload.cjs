const { contextBridge, ipcRenderer } = require("electron");

const allowedActions = new Set(["open", "reveal", "quicklook"]);

contextBridge.exposeInMainWorld("teamlineDesktop", Object.freeze({
  nativeNotifications: process.platform === "darwin",

  onNotificationClick(listener) {
    if (typeof listener !== "function") return () => {};
    const wrapped = (_event, notification) => listener(notification);
    ipcRenderer.on("teamline:notification-click", wrapped);
    return () => ipcRenderer.removeListener("teamline:notification-click", wrapped);
  },

  openArtifact(request) {
    if (
      !request ||
      typeof request.workOrderId !== "string" ||
      typeof request.path !== "string" ||
      typeof request.action !== "string" ||
      !allowedActions.has(request.action)
    ) {
      return Promise.reject(new Error("成果操作请求无效"));
    }
    return ipcRenderer.invoke("teamline:artifact-action", {
      action: request.action,
      path: request.path,
      workOrderId: request.workOrderId,
    });
  },
  openSettings() {
    return ipcRenderer.invoke("teamline:open-settings");
  },
}));
