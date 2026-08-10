const settingsSections = new Set([
  "general",
  "monitoring",
  "models",
  "notifications",
  "advanced",
]);

export function normalizeSettingsSection(section) {
  return settingsSections.has(section) ? section : "general";
}

export function createSettingsWindowOptions({ preloadPath, platform }) {
  return {
    width: 640,
    height: 480,
    minWidth: 520,
    minHeight: 360,
    title: "Teamline 设置",
    backgroundColor: "#f5f7f5",
    titleBarStyle: platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: platform === "darwin" ? { x: 14, y: 12 } : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
      sandbox: true,
    },
  };
}

export function createSettingsUrl(coreUrl, section) {
  const settingsUrl = new URL("/settings", coreUrl);
  settingsUrl.searchParams.set("section", normalizeSettingsSection(section));
  return settingsUrl;
}

export function createOpenSettingsIpcHandler(openSettingsWindow) {
  return (_event, section) => {
    openSettingsWindow(normalizeSettingsSection(section));
    return { opened: true };
  };
}
