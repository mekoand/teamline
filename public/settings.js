const sections = [...document.querySelectorAll("[data-settings-section]")];
const panels = [...document.querySelectorAll("[data-settings-panel]")];
let modelSettings = { sources: {} };
let restorePreview = null;
let settingsLocale = "zh-CN";

const settingsTextMap = new Map(Object.entries({
  "偏好设置": "Settings",
  "关闭": "Close",
  "常规": "General",
  "会话监控": "Session monitoring",
  "模型": "Models",
  "通知": "Notifications",
  "高级": "Advanced",
  "设置分类": "Settings sections",
  "客户端显示": "Client display",
  "界面语言": "Language",
  "外观": "Appearance",
  "跟随系统": "System",
  "浅色": "Light",
  "深色": "Dark",
  "自动更新": "Automatic updates",
  "自动更新会话状态": "Update monitored sessions automatically",
  "关闭自动更新。": "Disable automatic updates.",
  "会话整理模型": "Session organization model",
  "Codex 来源": "Codex source",
  "自动模型": "Automatic model",
  "深度模型": "Deep model",
  "明确替代模型": "Explicit fallback",
  "指定账号": "Account",
  "来源已配置的低成本模型": "Low-cost source model",
  "手动深度整理模型": "Manual deep-organization model",
  "自动模型未配置时使用": "Used when the automatic model is unavailable",
  "留空使用当前账号": "Use the current account",
  "Claude Code 来源": "Claude Code source",
  "保存模型设置": "Save model settings",
  "提醒偏好": "Notification preferences",
  "需响应": "Needs response",
  "有需要你处理的本地状态时提醒。": "Alert when local state needs attention.",
  "运行失败": "Run failed",
  "目标运行出现失败状态时提醒。": "Alert when a goal run fails.",
  "目标待验收": "Goal ready for review",
  "目标完成并等待验收时提醒。": "Alert when a goal is ready for review.",
  "账号或额度不可用": "Account or quota unavailable",
  "当前来源账号或额度无法使用时提醒。": "Alert when the current account or quota is unavailable.",
  "保存通知偏好": "Save notification preferences",
  "诊断与本地数据": "Diagnostics and local data",
  "服务状态": "Service status",
  "正在读取本地服务状态…": "Reading local service status…",
  "刷新诊断": "Refresh",
  "导出本地数据": "Export local data",
  "导出目标、项目和账号信息。": "Export goals, projects, and account information.",
  "导出": "Export",
  "恢复本地数据": "Restore local data",
  "先预览冲突，再确认恢复。": "Preview conflicts before restoring.",
  "选择文件后只做预览，不会立即写入。": "The file is previewed before anything is written.",
  "确认恢复": "Confirm restore",
  "设置冲突处理": "Settings conflict handling",
  "语言设置已保存。": "Language saved.",
  "会话监控设置已保存。": "Session monitoring settings saved.",
  "模型设置已保存。": "Model settings saved.",
  "通知偏好已保存。": "Notification preferences saved.",
  "本地数据已导出。": "Local data exported.",
  "无法导出本地数据": "Unable to export local data",
  "恢复完成：导入": "Restore complete: imported",
  "无法读取本地服务状态。": "Unable to read local service status.",
}));
const settingsReverseTextMap = new Map(
  [...settingsTextMap.entries()].map(([zh, en]) => [en, zh]),
);

function settingsText(zh) {
  return settingsLocale === "en" ? settingsTextMap.get(zh) || zh : zh;
}

function applySettingsLanguage(locale) {
  settingsLocale = locale === "en" ? "en" : "zh-CN";
  document.documentElement.lang = settingsLocale;
  const map = settingsLocale === "en" ? settingsTextMap : settingsReverseTextMap;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const current = node.nodeValue || "";
    const trimmed = current.trim();
    const translated = map.get(trimmed);
    if (translated) {
      node.nodeValue = current.replace(trimmed, translated);
    }
    node = walker.nextNode();
  }
  for (const input of document.querySelectorAll("input[placeholder]")) {
    const translated = map.get(input.placeholder);
    if (translated) input.placeholder = translated;
  }
  for (const element of document.querySelectorAll("[aria-label]")) {
    const translated = map.get(element.getAttribute("aria-label"));
    if (translated) element.setAttribute("aria-label", translated);
  }
  const optionLabels = settingsLocale === "en"
    ? {
        "#settings-language": { "zh-CN": "简体中文", en: "English" },
        "#settings-theme": { system: "System", light: "Light", dark: "Dark" },
        "#restore-settings-resolution": { keep_existing: "Keep existing settings", use_imported: "Use imported settings" },
      }
    : {
        "#settings-language": { "zh-CN": "简体中文", en: "English" },
        "#settings-theme": { system: "跟随系统", light: "浅色", dark: "深色" },
        "#restore-settings-resolution": { keep_existing: "保留现有设置", use_imported: "使用导入设置" },
      };
  for (const [selector, labels] of Object.entries(optionLabels)) {
    for (const option of document.querySelectorAll(`${selector} option`)) {
      const label = labels[option.value];
      if (label) option.textContent = label;
    }
  }
  document.title = settingsText("偏好设置");
}

function requestJson(path, options) {
  return fetch(path, options).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "设置请求失败");
    return payload;
  });
}

function setFeedback(id, message, isError = false) {
  const element = document.querySelector(`#${id}`);
  if (!element) return;
  element.textContent = message;
  element.dataset.error = String(isError);
}

function selectSection(name) {
  const normalizedName = panels.some((panel) => panel.dataset.settingsPanel === name) ? name : "general";
  for (const button of sections) {
    const selected = button.dataset.settingsSection === normalizedName;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-current", selected ? "page" : "false");
  }
  for (const panel of panels) {
    const visible = panel.dataset.settingsPanel === normalizedName;
    panel.hidden = !visible;
    panel.classList.toggle("is-visible", visible);
  }
}

function requestedSettingsSection() {
  return new URL(window.location.href).searchParams.get("section") || "general";
}

function applyTheme(theme) {
  const normalized = ["system", "light", "dark"].includes(theme) ? theme : "system";
  document.documentElement.dataset.themePreference = normalized;
  document.documentElement.dataset.theme = normalized === "system"
    ? matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
    : normalized;
  localStorage.setItem("teamline-theme", normalized);
}

async function loadSettings() {
  applySettingsLanguage(localStorage.getItem("teamline-language") || "zh-CN");
  try {
    const { language } = await requestJson("/api/preferences/language");
    if (language) {
      const normalizedLanguage = language === "en" ? "en" : "zh-CN";
      localStorage.setItem("teamline-language", normalizedLanguage);
      document.querySelector("#settings-language").value = normalizedLanguage;
      applySettingsLanguage(normalizedLanguage);
    }
  } catch (error) {
    setFeedback("general-feedback", error.message, true);
  }
  document.querySelector("#settings-theme").value = localStorage.getItem("teamline-theme") || "system";
  try {
    const { enabled } = await requestJson("/api/session-monitoring/automatic");
    document.querySelector("#monitoring-automatic").checked = enabled === true;
  } catch (error) {
    setFeedback("monitoring-feedback", error.message, true);
  }
  try {
    const { settings } = await requestJson("/api/preferences/models");
    modelSettings = settings || { sources: {} };
    const codex = modelSettings.sources?.codex || {};
    document.querySelector("#model-codex-automatic").value = codex.automaticModel || "";
    document.querySelector("#model-codex-deep").value = codex.deepModel || "";
    document.querySelector("#model-codex-fallback").value = codex.fallbackModel || "";
    document.querySelector("#model-codex-account").value = codex.accountId || "";
  } catch (error) {
    setFeedback("model-feedback", error.message, true);
  }
  try {
    const { settings } = await requestJson("/api/preferences/notifications");
    const form = document.querySelector("#notification-preferences-form");
    for (const name of ["needsResponse", "runFailed", "goalPendingAcceptance", "resourceUnavailable"]) {
      form.elements[name].checked = settings?.[name] === true;
    }
  } catch (error) {
    setFeedback("notification-feedback", error.message, true);
  }
  await refreshDiagnostics();
}

async function saveLanguage(event) {
  const locale = event.currentTarget.value;
  applySettingsLanguage(locale);
  void refreshDiagnostics();
  localStorage.setItem("teamline-language", locale);
  try {
    await requestJson("/api/preferences/language", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ language: locale }),
    });
    setFeedback("general-feedback", settingsText("语言设置已保存。"), false);
  } catch (error) {
    setFeedback("general-feedback", error.message, true);
  }
}

async function saveMonitoring(event) {
  try {
    await requestJson("/api/session-monitoring/automatic", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: event.currentTarget.checked }),
    });
    setFeedback("monitoring-feedback", settingsText("会话监控设置已保存。"), false);
  } catch (error) {
    setFeedback("monitoring-feedback", error.message, true);
  }
}

async function saveModels(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const value = (name) => form.elements[name].value.trim() || null;
  try {
    const { settings } = await requestJson("/api/preferences/models", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sources: {
          ...modelSettings.sources,
          codex: {
            automaticModel: value("automaticModel"),
            deepModel: value("deepModel"),
            fallbackModel: value("fallbackModel"),
            accountId: value("accountId"),
          },
        },
      }),
    });
    modelSettings = settings || modelSettings;
    setFeedback("model-feedback", settingsText("模型设置已保存。"), false);
  } catch (error) {
    setFeedback("model-feedback", error.message, true);
  }
}

async function saveNotifications(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const settings = Object.fromEntries(
    ["needsResponse", "runFailed", "goalPendingAcceptance", "resourceUnavailable"]
      .map((name) => [name, form.elements[name].checked]),
  );
  try {
    await requestJson("/api/preferences/notifications", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(settings),
    });
    setFeedback("notification-feedback", settingsText("通知偏好已保存。"), false);
  } catch (error) {
    setFeedback("notification-feedback", error.message, true);
  }
}

async function refreshDiagnostics() {
  try {
    const health = await requestJson("/api/local-core/health");
    document.querySelector("#diagnostics-state").textContent = settingsLocale === "en"
      ? `Local service running · ${health.identity || "Local instance"}`
      : `本地服务运行 · ${health.identity || "本地实例"}`;
  } catch (error) {
    document.querySelector("#diagnostics-state").textContent = error.message;
  }
}

async function exportLocalState() {
  try {
    const response = await fetch("/api/local-state/export");
    if (!response.ok) throw new Error("无法导出本地数据");
    const blob = await response.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "teamline-state.json";
    link.click();
    URL.revokeObjectURL(link.href);
    setFeedback("restore-feedback", settingsText("本地数据已导出。"), false);
  } catch (error) {
    setFeedback("restore-feedback", error.message, true);
  }
}

async function previewRestore(event) {
  const file = event.currentTarget.files?.[0];
  if (!file) return;
  try {
    const bundle = JSON.parse(await file.text());
    restorePreview = await requestJson("/api/local-state/restore/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundle }),
    });
    document.querySelector("#restore-actions").hidden = false;
    setFeedback(
      "restore-feedback",
      `已预览 ${restorePreview.summary.total} 个目标，冲突 ${restorePreview.summary.conflicts} 个。`,
      false,
    );
  } catch (error) {
    restorePreview = null;
    document.querySelector("#restore-actions").hidden = true;
    setFeedback("restore-feedback", error.message, true);
  }
}

async function confirmRestore() {
  if (!restorePreview?.previewId) return;
  const resolutions = Object.fromEntries(
    restorePreview.workOrders.map((workOrder) => [workOrder.sourceId, "keep_existing"]),
  );
  try {
    const result = await requestJson("/api/local-state/restore/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        previewId: restorePreview.previewId,
        resolutions,
        settingsResolution: document.querySelector("#restore-settings-resolution").value,
      }),
    });
    setFeedback("restore-feedback", `恢复完成：导入 ${result.imported} 项。`, false);
    document.querySelector("#restore-actions").hidden = true;
    restorePreview = null;
  } catch (error) {
    setFeedback("restore-feedback", error.message, true);
  }
}

for (const button of sections) {
  button.addEventListener("click", () => selectSection(button.dataset.settingsSection));
}
document.querySelector("#settings-language").addEventListener("change", saveLanguage);
document.querySelector("#monitoring-automatic").addEventListener("change", saveMonitoring);
document.querySelector("#model-settings-form").addEventListener("submit", saveModels);
document.querySelector("#notification-preferences-form").addEventListener("submit", saveNotifications);
document.querySelector("#settings-theme").addEventListener("change", (event) => applyTheme(event.currentTarget.value));
document.querySelector("#settings-close").addEventListener("click", () => window.close());
selectSection(requestedSettingsSection());
window.teamlineDesktop?.onSettingsSection?.((section) => selectSection(section));
document.querySelector("#refresh-diagnostics").addEventListener("click", refreshDiagnostics);
document.querySelector("#export-local-state").addEventListener("click", exportLocalState);
document.querySelector("#restore-state-file").addEventListener("change", previewRestore);
document.querySelector("#confirm-state-restore").addEventListener("click", confirmRestore);

loadSettings();

window.addEventListener("storage", (event) => {
  if (event.key === "teamline-theme" && ["system", "light", "dark"].includes(event.newValue)) {
    applyTheme(event.newValue);
    document.querySelector("#settings-theme").value = event.newValue;
  }
  if (event.key === "teamline-language" && ["en", "zh-CN"].includes(event.newValue)) {
    document.querySelector("#settings-language").value = event.newValue;
    applySettingsLanguage(event.newValue);
    void refreshDiagnostics();
  }
});

matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
  if (document.documentElement.dataset.themePreference === "system") applyTheme("system");
});
