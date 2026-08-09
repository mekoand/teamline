const { contextBridge, ipcRenderer } = require("electron");

const allowedActions = new Set(["open", "reveal", "quicklook"]);

contextBridge.exposeInMainWorld("teamlineDesktop", Object.freeze({
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
}));
