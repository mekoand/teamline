const sections = [...document.querySelectorAll("[data-settings-section]")];
const panels = [...document.querySelectorAll("[data-settings-panel]")];
let restorePreview = null;

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
  for (const button of sections) {
    const selected = button.dataset.settingsSection === name;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-current", selected ? "page" : "false");
  }
  for (const panel of panels) {
    const visible = panel.dataset.settingsPanel === name;
    panel.hidden = !visible;
    panel.classList.toggle("is-visible", visible);
  }
}

function applyTheme(theme) {
  const normalized = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = normalized;
  localStorage.setItem("teamline-theme", normalized);
}

async function loadSettings() {
  try {
    const { language } = await requestJson("/api/preferences/language");
    if (language) document.querySelector("#settings-language").value = language;
  } catch (error) {
    setFeedback("general-feedback", error.message, true);
  }
  try {
    const { enabled } = await requestJson("/api/session-monitoring/automatic");
    document.querySelector("#monitoring-automatic").checked = enabled === true;
  } catch (error) {
    setFeedback("monitoring-feedback", error.message, true);
  }
  try {
    const { settings } = await requestJson("/api/preferences/models");
    const codex = settings?.sources?.codex || {};
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
  try {
    localStorage.setItem("teamline-language", event.currentTarget.value);
    await requestJson("/api/preferences/language", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ language: event.currentTarget.value }),
    });
    setFeedback("general-feedback", "语言设置已保存。", false);
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
    setFeedback("monitoring-feedback", "会话监控设置已保存。", false);
  } catch (error) {
    setFeedback("monitoring-feedback", error.message, true);
  }
}

async function saveModels(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const value = (name) => form.elements[name].value.trim() || null;
  try {
    await requestJson("/api/preferences/models", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sources: {
          codex: {
            automaticModel: value("automaticModel"),
            deepModel: value("deepModel"),
            fallbackModel: value("fallbackModel"),
            accountId: value("accountId"),
          },
        },
      }),
    });
    setFeedback("model-feedback", "模型设置已保存。", false);
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
    setFeedback("notification-feedback", "通知偏好已保存。", false);
  } catch (error) {
    setFeedback("notification-feedback", error.message, true);
  }
}

async function refreshDiagnostics() {
  try {
    const health = await requestJson("/api/local-core/health");
    document.querySelector("#diagnostics-state").textContent =
      `Local Core 正在运行 · ${health.identity || "本地实例"}`;
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
    setFeedback("restore-feedback", "本地数据已导出。", false);
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
document.querySelector("#settings-theme-toggle").addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});
document.querySelector("#settings-close").addEventListener("click", () => window.close());
document.querySelector("#refresh-diagnostics").addEventListener("click", refreshDiagnostics);
document.querySelector("#export-local-state").addEventListener("click", exportLocalState);
document.querySelector("#restore-state-file").addEventListener("change", previewRestore);
document.querySelector("#confirm-state-restore").addEventListener("click", confirmRestore);

loadSettings();
