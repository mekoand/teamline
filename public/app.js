import { gitArtifactPaths } from "./result-artifacts.js";
import {
  clearContextInspector,
  closeContextInspector,
  createContextInspectorState,
  refreshContextInspector,
  selectContextInspector,
  setContextInspectorBusy,
} from "./context-inspector.js";
import {
  completedGoalHighlights,
  defaultGoalWorkbenchView,
  visibleGoalConversation,
} from "./goal-workbench.js";
import {
  applyStaticTranslations,
  normalizeLocale,
  resolveLocale,
  translate,
} from "./i18n.js";

let visibleStatusLabels = {};
let allGoalStatusGroups = [];
let homeHistoryFilters = [];

const state = {
  workOrders: [],
  projects: [],
  projectDetail: null,
  projectCreateOpen: false,
  createProjectMaterials: null,
  goalProjectMaterials: null,
  selected: null,
  selectedStageIndex: 0,
  followCurrentStage: true,
  draftStages: null,
  contextTab: "artifacts",
  homeHistoryFilter: "7",
  primaryView: null,
  progressView: "map",
  inspector: createContextInspectorState(),
  events: [],
  executionSettings: { maxConcurrency: 2 },
  resources: null,
  executionIdentities: { defaultIdentityId: null, currentIdentityId: null, identities: [] },
  identityLoginStates: {},
  identityLoginTimers: new Map(),
  identityLoginChecks: new Set(),
  resourceError: "",
  resourceRefreshInFlight: false,
  autoRunCheckRequested: true,
  resourceProgressTimer: null,
  sessionDiscovery: null,
  sessionSource: "codex",
  sessionSearch: "",
  sessionSelectedIds: new Set(),
  sourceStatus: null,
  notifications: [],
  unreadNotificationCount: 0,
  notificationSettings: { autoRunStarted: true, autoRunStopped: true },
  nativeNotificationCheckInFlight: false,
  restorePreview: null,
  refreshTimer: null,
  theme: readTheme(),
  locale: resolveLocale({
    saved: localStorage.getItem("teamline-language"),
    browserLanguages: navigator.languages,
  }),
};

const listElement = document.querySelector("#work-order-list");
const countElement = document.querySelector("#work-order-count");
const workspaceElement = document.querySelector("#work-order-workspace");
const contextElement = document.querySelector("#context-panel");
const contextBackdrop = document.querySelector("#context-backdrop");
const createDialog = document.querySelector("#create-dialog");
const createForm = document.querySelector("#create-form");
const formError = document.querySelector("#form-error");
const createButton = document.querySelector("#submit-create");
const resourceSummaryElement = document.querySelector("#resource-summary");
const sessionImportDialog = document.querySelector("#session-import-dialog");
const sessionImportForm = document.querySelector("#session-import-form");
const sessionImportError = document.querySelector("#session-import-error");
const notificationDialog = document.querySelector("#notification-dialog");
const localStateDialog = document.querySelector("#local-state-dialog");

applyTheme(state.theme);
applyLanguage(state.locale);
bindShellEvents();
initializeLanguage().finally(refreshConsole);

function bindShellEvents() {
  document.querySelector("#language-select").addEventListener("change", async (event) => {
    const locale = normalizeLocale(event.currentTarget.value);
    if (!locale) return;
    state.locale = locale;
    localStorage.setItem("teamline-language", locale);
    applyLanguage(locale);
    renderConsole();
    try {
      await requestJson("/api/preferences/language", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ language: locale }),
      });
    } catch (error) {
      console.warn("Unable to save Teamline language", error);
    }
  });

  document.querySelector("#theme-toggle").addEventListener("click", () => {
    state.theme = state.theme === "dark" ? "light" : "dark";
    localStorage.setItem("teamline-theme", state.theme);
    applyTheme(state.theme);
  });

  document.querySelector("#open-notifications").addEventListener("click", () => {
    renderNotificationShell();
    notificationDialog.showModal();
  });
  document.querySelector("#close-notifications").addEventListener("click", () => {
    notificationDialog.close();
  });
  document.querySelector("#enable-notifications").addEventListener("click", enableNativeNotifications);
  document
    .querySelector("#auto-run-started-notifications")
    .addEventListener("change", saveNotificationSettings);
  document
    .querySelector("#auto-run-stopped-notifications")
    .addEventListener("change", saveNotificationSettings);

  document.querySelector("#open-create").addEventListener("click", openCreateDialog);
  document.querySelector("#open-all-goals").addEventListener("click", () => {
    history.pushState({}, "", "/");
    resetGoalSelection();
    refreshConsole();
  });
  document.querySelector("#open-projects").addEventListener("click", () => {
    history.pushState({}, "", "/projects");
    resetGoalSelection();
    refreshConsole();
  });
  document.querySelector("#open-resources").addEventListener("click", () => {
    history.pushState({}, "", "/resources");
    resetGoalSelection();
    refreshConsole();
  });
  document.querySelector("#open-local-state").addEventListener("click", () => {
    resetRestorePreview();
    localStateDialog.showModal();
  });
  document.querySelector("#close-local-state").addEventListener("click", closeLocalState);
  document.querySelector("#cancel-local-state").addEventListener("click", closeLocalState);
  document.querySelector("#export-local-state").addEventListener("click", exportLocalState);
  document.querySelector("#restore-state-file").addEventListener("change", previewStateRestore);
  document.querySelector("#confirm-state-restore").addEventListener("click", confirmStateRestore);
  document.querySelector("#open-session-import").addEventListener("click", () => {
    closeCreateDialog();
    openSessionImport();
  });
  document.querySelector("#close-session-import").addEventListener("click", closeSessionImport);
  document.querySelector("#cancel-session-import").addEventListener("click", closeSessionImport);
  document.querySelector("#session-search").addEventListener("input", (event) => {
    state.sessionSearch = event.currentTarget.value;
    renderSessionCandidates();
  });
  document.querySelector("#session-import-source").addEventListener("change", async (event) => {
    state.sessionSource = event.currentTarget.value;
    state.sessionSelectedIds = new Set();
    state.sessionSearch = "";
    document.querySelector("#session-search").value = "";
    document.querySelector("#session-import-name").value = "";
    document.querySelector("#session-candidate-list").innerHTML =
      '<div class="loading-state">正在读取本机会话…</div>';
    document.querySelector("#session-source-message").textContent = "";
    await loadSessionDiscovery();
  });
  sessionImportForm.addEventListener("submit", importSelectedSessions);
  document.querySelector("#close-create").addEventListener("click", closeCreateDialog);
  document.querySelector("#cancel-create").addEventListener("click", closeCreateDialog);
  createForm.addEventListener("submit", createWorkOrder);
  document.querySelector("#add-material").addEventListener("click", () => addMaterialRow());
  document.querySelector("#create-project-select").addEventListener("change", refreshCreateProjectMaterials);
  createForm.querySelector('[name="name"]').addEventListener("blur", refreshCreateProjectMaterials);
  createForm.querySelector('[name="description"]').addEventListener("blur", refreshCreateProjectMaterials);
  contextBackdrop.addEventListener("click", () => dismissContextInspector());
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || document.querySelector("dialog[open]")) return;
    dismissContextInspector();
  });
  window.addEventListener("popstate", () => {
    resetGoalSelection();
    refreshConsole();
  });
}

async function initializeLanguage() {
  try {
    const saved = await requestJson("/api/preferences/language");
    const locale = normalizeLocale(saved.language);
    if (locale) {
      state.locale = locale;
      localStorage.setItem("teamline-language", locale);
    }
  } catch {
    // Browser preference remains the initial choice until the user saves one.
  }
  applyLanguage(state.locale);
}

function applyLanguage(locale) {
  visibleStatusLabels = {
    planning: translate(locale, "status.planning"),
    running: translate(locale, "status.running"),
    queued: translate(locale, "status.queued"),
    response: translate(locale, "status.response"),
    review: translate(locale, "status.review"),
    completed: translate(locale, "status.completed"),
  };
  allGoalStatusGroups = [
    ["response", visibleStatusLabels.response],
    ["review", visibleStatusLabels.review],
    ["running", visibleStatusLabels.running],
    ["planning", visibleStatusLabels.planning],
    ["queued", visibleStatusLabels.queued],
    ["completed", visibleStatusLabels.completed],
  ];
  homeHistoryFilters = state.locale === "zh-CN"
    ? [["current", "当前"], ["7", "7 天"], ["30", "30 天"], ["all", "全部"]]
    : [["current", "Current"], ["7", "7 days"], ["30", "30 days"], ["all", "All"]];
  document.querySelector("#language-select").value = locale;
  applyStaticTranslations(document, locale);
}

function openCreateDialog() {
  populateProjectSelect(document.querySelector("#create-project-select"));
  state.createProjectMaterials = null;
  renderCreateProjectMaterials();
  createDialog.showModal();
  createDialog.querySelector('[name="name"]').focus();
}

function resetGoalSelection() {
  state.selected = null;
  state.draftStages = null;
  state.primaryView = null;
  state.progressView = "map";
  state.contextTab = "artifacts";
  state.inspector = clearContextInspector();
}

function openContextInspector(selection) {
  state.inspector = selectContextInspector(state.inspector, selection);
}

function dismissContextInspector() {
  if (!state.inspector.open || state.inspector.busy) return;
  state.inspector = closeContextInspector(state.inspector);
  renderConsole();
}

function closeLocalState() {
  localStateDialog.close();
}

function resetRestorePreview() {
  state.restorePreview = null;
  document.querySelector("#restore-state-file").value = "";
  document.querySelector("#restore-preview").innerHTML = "";
  document.querySelector("#confirm-state-restore").hidden = true;
  setFeedback("local-state-feedback", "", false);
}

async function exportLocalState() {
  const button = document.querySelector("#export-local-state");
  button.disabled = true;
  try {
    const response = await fetch("/api/local-state/export", { cache: "no-store" });
    if (!response.ok) throw new Error("无法导出本地状态");
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") ?? "";
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? "teamline-state.json";
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
    setFeedback("local-state-feedback", "已生成本地状态文件。", false);
  } catch (error) {
    setFeedback("local-state-feedback", messageFrom(error, "无法导出本地状态。"), true);
  } finally {
    button.disabled = false;
  }
}

async function previewStateRestore(event) {
  const file = event.currentTarget.files?.[0];
  if (!file) return;
  state.restorePreview = null;
  document.querySelector("#confirm-state-restore").hidden = true;
  document.querySelector("#restore-preview").innerHTML = '<div class="loading-state">正在检查恢复内容…</div>';
  setFeedback("local-state-feedback", "", false);
  try {
    const bundle = JSON.parse(await file.text());
    const preview = await requestJson("/api/local-state/restore/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundle }),
    });
    state.restorePreview = preview;
    renderRestorePreview();
    document.querySelector("#confirm-state-restore").hidden = false;
  } catch (error) {
    document.querySelector("#restore-preview").innerHTML = "";
    setFeedback("local-state-feedback", messageFrom(error, "无法预览这个文件。"), true);
  }
}

function renderRestorePreview() {
  const preview = state.restorePreview;
  if (!preview) return;
  const rows = preview.workOrders.map((workOrder) => {
    const attention = workOrder.attention;
    return `
      <article class="restore-order-card">
        <div class="restore-order-heading">
          <strong>${escapeHtml(workOrder.title)}</strong>
          <span class="status-pill ${workOrder.conflict || attention.length ? "response" : ""}">${workOrder.conflict ? "有冲突" : attention.length ? "需处理" : "可恢复"}</span>
        </div>
        ${attention.length
          ? `<ul class="restore-attention-list">${attention.map((item) => `<li><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.reason)}</span><code>${escapeHtml(shortPath(item.location))}</code></li>`).join("")}</ul>`
          : '<p class="muted">没有发现缺失的位置引用。</p>'}
        ${workOrder.conflict
          ? `<label class="restore-conflict-choice"><span>已有同一目标</span><select data-restore-resolution="${escapeHtml(workOrder.sourceId)}"><option value="">请选择</option><option value="keep_existing">保留现有，不导入</option><option value="import_copy">另存为副本</option></select></label>`
          : ""}
      </article>`;
  }).join("");
  const projectMaterialRows = (preview.projectMaterials ?? [])
    .filter((material) => material.attention.length)
    .map((material) => `<article class="restore-order-card"><div class="restore-order-heading"><strong>${escapeHtml(material.label)}</strong><span class="status-pill response">项目素材</span></div><ul class="restore-attention-list">${material.attention.map((item) => `<li><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.reason)}</span><code>${escapeHtml(shortPath(item.location))}</code></li>`).join("")}</ul></article>`)
    .join("");
  document.querySelector("#restore-preview").innerHTML = `
    <div class="restore-summary">
      <strong>将恢复 ${preview.summary.total} 个目标</strong>
      <span>${preview.summary.conflicts} 项冲突 · ${preview.summary.needsAttention} 项恢复后需处理</span>
    </div>
    ${preview.settingsConflict
      ? `<label class="restore-conflict-choice settings-choice"><span>本机设置不同</span><select id="restore-settings-resolution"><option value="">请选择</option><option value="keep_existing">保留现有设置</option><option value="use_imported">使用导入设置</option></select></label>`
      : ""}
    <div class="restore-order-list">${rows || '<p class="muted">文件中没有目标。</p>'}${projectMaterialRows}</div>
    <p class="restore-safety-note">确认后也不会覆盖已有目标；缺失位置会保留并标为需处理。</p>`;
}

async function confirmStateRestore() {
  const preview = state.restorePreview;
  if (!preview) return;
  const button = document.querySelector("#confirm-state-restore");
  const resolutions = Object.fromEntries(
    [...document.querySelectorAll("[data-restore-resolution]")]
      .filter((select) => select.value)
      .map((select) => [select.dataset.restoreResolution, select.value]),
  );
  const settingsResolution = document.querySelector("#restore-settings-resolution")?.value || undefined;
  button.disabled = true;
  try {
    const result = await requestJson("/api/local-state/restore/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ previewId: preview.previewId, resolutions, settingsResolution }),
    });
    state.restorePreview = null;
    button.hidden = true;
    document.querySelector("#restore-preview").innerHTML = `
      <section class="restore-complete">
        <strong>恢复完成</strong>
        <p>已恢复 ${result.imported} 项，另存副本 ${result.copied} 项，保留现有 ${result.skipped} 项。</p>
      </section>`;
    setFeedback("local-state-feedback", "请处理预览中标出的缺失位置后再继续运行。", false);
    await refreshConsole();
  } catch (error) {
    setFeedback("local-state-feedback", messageFrom(error, "无法恢复本地状态。"), true);
  } finally {
    button.disabled = false;
  }
}

async function refreshConsole({
  polling = false,
  checkAutoRun = state.autoRunCheckRequested || isResourceView(),
} = {}) {
  clearTimeout(state.refreshTimer);
  if (!polling && state.workOrders.length === 0) {
    workspaceElement.innerHTML = '<div class="loading-state">正在读取本地目标…</div>';
    contextElement.innerHTML = '<div class="loading-state">正在准备详情…</div>';
  }

  try {
    const [consoleState, notificationState, projectState, executionIdentityState] = await Promise.all([
      requestJson("/api/console"),
      requestJson("/api/notifications"),
      requestJson("/api/projects"),
      requestJson("/api/execution-identities"),
    ]);
    const { workOrders, executionSettings } = consoleState;
    state.workOrders = workOrders;
    state.projects = projectState.projects;
    state.executionIdentities = executionIdentityState;
    resumeIdentityLoginChecks();
    state.executionSettings = executionSettings;
    state.notifications = notificationState.notifications;
    state.unreadNotificationCount = notificationState.unreadCount;
    state.notificationSettings = notificationState.settings;
    renderNotificationShell();
    void showPendingNativeNotifications();
    void refreshResources({ checkAutoRun });
    state.autoRunCheckRequested = false;
    if (isProjectsView()) {
      state.selected = null;
      state.sourceStatus = null;
      state.events = [];
      const projectId = selectedProjectIdFromPath();
      state.projectDetail = projectId
        ? await requestJson(`/api/projects/${encodeURIComponent(projectId)}`)
        : null;
      renderConsole();
      scheduleRefresh();
      return;
    }
    if (isResourceView() || isAllGoalsView()) {
      state.selected = null;
      state.sourceStatus = null;
      state.events = [];
      renderConsole();
      scheduleRefresh();
      return;
    }
    const requestedId = selectedIdFromPath();
    const selectedId = requestedId ?? null;

    if (selectedId) {
      const detail = await requestJson(
        `/api/work-orders/${encodeURIComponent(selectedId)}`,
      );
      const { workOrder } = detail;
      state.selected = workOrder;
      state.sourceStatus = detail.sourceStatus ?? null;
      state.inspector = refreshContextInspector(state.inspector);
      await refreshGoalProjectMaterials(workOrder);
      const requestedStageId = selectedStageFromPath();
      if (requestedStageId) {
        const requestedStageIndex = workOrder.plan?.stages.findIndex(
          (stage) => stage.id === requestedStageId,
        );
        if (requestedStageIndex >= 0) {
          state.selectedStageIndex = requestedStageIndex;
          state.followCurrentStage = false;
          openContextInspector({ type: "stage", id: requestedStageId });
          const canonicalUrl = new URL(window.location.href);
          canonicalUrl.searchParams.delete("stage");
          history.replaceState(
            {},
            "",
            `${canonicalUrl.pathname}${canonicalUrl.search}`,
          );
        }
      }
      if (state.followCurrentStage) {
        state.selectedStageIndex = preferredStageIndex(workOrder);
      }
      state.events = workOrder.runNumber > 0
        ? (await requestJson(`/api/work-orders/${encodeURIComponent(selectedId)}/events`)).events
        : [];
    } else {
      state.selected = null;
      state.sourceStatus = null;
      state.events = [];
    }

    renderConsole();
    scheduleRefresh();
  } catch (error) {
    if (polling) {
      state.refreshTimer = setTimeout(() => refreshConsole({ polling: true }), 4_000);
      return;
    }
    workspaceElement.innerHTML = `
      <section class="empty-console error-state">
        <span class="empty-symbol">!</span>
        <h2>无法连接本地服务</h2>
        <p>${escapeHtml(messageFrom(error, "请确认 Teamline 正在运行。"))}</p>
        <button class="secondary-button" id="retry-load" type="button">重新读取</button>
      </section>`;
    contextElement.innerHTML = '<div class="loading-state">本地状态暂时不可用</div>';
    document.querySelector("#retry-load")?.addEventListener("click", () => refreshConsole());
  }
}

function renderNotificationShell() {
  const count = document.querySelector("#notification-count");
  count.textContent = String(state.unreadNotificationCount);
  count.hidden = state.unreadNotificationCount === 0;
  document
    .querySelector("#open-notifications")
    .classList.toggle("has-unread", state.unreadNotificationCount > 0);

  document.querySelector("#auto-run-started-notifications").checked =
    state.notificationSettings.autoRunStarted;
  document.querySelector("#auto-run-stopped-notifications").checked =
    state.notificationSettings.autoRunStopped;
  renderNotificationPermission();

  const list = document.querySelector("#notification-list");
  list.innerHTML = state.notifications.length
    ? state.notifications
        .map(
          (notification) => `
            <button class="notification-item ${notification.readAt ? "" : "unread"}" data-notification-id="${notification.id}" type="button">
              <span class="notification-item-heading">
                <strong>${escapeHtml(notification.title)}</strong>
                <time>${formatDate(notification.createdAt)}</time>
              </span>
              <span>${escapeHtml(notification.body)}</span>
            </button>`,
        )
        .join("")
    : '<p class="muted">还没有通知。</p>';
  list.querySelectorAll("[data-notification-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const notification = state.notifications.find(
        (candidate) => candidate.id === Number(button.dataset.notificationId),
      );
      if (notification) void openLocalNotification(notification);
    });
  });
}

function renderNotificationPermission() {
  const stateElement = document.querySelector("#notification-permission-state");
  const button = document.querySelector("#enable-notifications");
  if (!("Notification" in window)) {
    stateElement.textContent = "当前浏览器不支持";
    button.hidden = true;
    return;
  }
  const labels = {
    granted: "已开启",
    denied: "已被浏览器关闭",
    default: "开启后显示在系统通知中心",
  };
  stateElement.textContent = labels[Notification.permission];
  button.hidden = Notification.permission === "granted";
  button.textContent = Notification.permission === "denied" ? "查看浏览器设置" : "开启";
  button.disabled = Notification.permission === "denied";
}

async function enableNativeNotifications() {
  if (!("Notification" in window)) return;
  try {
    await Notification.requestPermission();
    renderNotificationPermission();
    await showPendingNativeNotifications();
  } catch {
    setFeedback("notification-feedback", "无法开启本机通知，请检查浏览器设置。", true);
  }
}

async function saveNotificationSettings() {
  const settings = {
    autoRunStarted: document.querySelector("#auto-run-started-notifications").checked,
    autoRunStopped: document.querySelector("#auto-run-stopped-notifications").checked,
  };
  try {
    const result = await requestJson("/api/notification-settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(settings),
    });
    state.notificationSettings = result.settings;
    setFeedback("notification-feedback", "通知设置已保存。", false);
  } catch (error) {
    renderNotificationShell();
    setFeedback("notification-feedback", messageFrom(error, "无法保存通知设置。"), true);
  }
}

async function showPendingNativeNotifications() {
  if (
    !("Notification" in window) ||
    Notification.permission !== "granted" ||
    state.nativeNotificationCheckInFlight
  ) {
    return;
  }
  state.nativeNotificationCheckInFlight = true;
  try {
    const { notifications } = await requestJson("/api/notifications/claim", {
      method: "POST",
    });
    for (const localNotification of notifications) {
      try {
        const systemNotification = new Notification(localNotification.title, {
          body: localNotification.body,
          tag: `teamline-${localNotification.id}`,
        });
        systemNotification.addEventListener("click", () => {
          window.focus();
          void openLocalNotification(localNotification);
          systemNotification.close();
        });
      } catch {
        await requestJson("/api/notifications/release", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: localNotification.id }),
        });
      }
    }
  } catch {
    // 网页内未读通知仍会保留。
  } finally {
    state.nativeNotificationCheckInFlight = false;
  }
}

async function openLocalNotification(notification) {
  try {
    await requestJson("/api/notifications/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: notification.id }),
    });
  } finally {
    notificationDialog.close();
    state.selectedStageIndex = 0;
    state.followCurrentStage = true;
    state.inspector = clearContextInspector();
    history.pushState({}, "", notification.targetUrl);
    await refreshConsole();
  }
}

async function saveMaxConcurrency(event) {
  const input = event.currentTarget;
  const previousValue = state.executionSettings.maxConcurrency;
  input.disabled = true;
  try {
    const { executionSettings } = await requestJson("/api/execution-settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxConcurrency: Number(input.value) }),
    });
    state.executionSettings = executionSettings;
    await refreshConsole({ polling: true });
  } catch (error) {
    input.value = String(previousValue);
    input.title = messageFrom(error, "无法保存最大并发数");
  } finally {
    input.disabled = false;
  }
}

async function refreshResources({ checkAutoRun = false } = {}) {
  if (state.resourceRefreshInFlight) return;
  clearTimeout(state.resourceProgressTimer);
  state.resourceRefreshInFlight = true;
  try {
    state.resources = await requestJson("/api/resources");
    state.resourceError = "";
    if (checkAutoRun) {
      await requestJson("/api/resources/run-once", { method: "POST" });
    }
  } catch (error) {
    state.resources = null;
    state.resourceError = messageFrom(error, "资源状态读取失败，请稍后重试。");
  } finally {
    state.resourceRefreshInFlight = false;
    renderResourceSummary();
    if (isResourceView()) renderConsole();
    if (state.resources?.openaiApi.status === "loading") {
      state.resourceProgressTimer = setTimeout(() => void refreshResources(), 500);
    } else if (checkAutoRun) {
      void refreshConsole({ polling: true, checkAutoRun: false });
    }
  }
}

function renderConsole(feedback = "") {
  renderWorkOrderList();
  const shell = document.querySelector(".console-shell");
  shell.className = [
    "console-shell",
    isAllGoalsView() ? "view-home" : "",
    isProjectsView() ? "view-projects" : "",
    isResourceView() ? "view-resources" : "",
    state.selected ? "view-goal" : "",
    state.inspector.open ? "context-open" : "",
  ].filter(Boolean).join(" ");
  contextElement.setAttribute("aria-hidden", String(!state.inspector.open));
  contextElement.setAttribute("aria-busy", String(state.inspector.busy));
  contextElement.toggleAttribute("inert", state.inspector.busy);
  document.querySelector("#open-all-goals")?.classList.toggle("selected", isAllGoalsView());
  document.querySelector("#open-projects")?.classList.toggle("selected", isProjectsView());
  document.querySelector("#open-resources")?.classList.toggle("selected", isResourceView());
  if (isAllGoalsView()) {
    workspaceElement.innerHTML = renderAllGoalsWorkspace();
    contextElement.innerHTML = "";
    bindOverviewEvents();
    return;
  }
  if (isProjectsView()) {
    workspaceElement.innerHTML = renderProjectsWorkspace();
    contextElement.innerHTML = state.inspector.open ? renderProjectContext() : "";
    bindOverviewEvents();
    return;
  }
  if (isResourceView()) {
    workspaceElement.innerHTML = renderResourceWorkspace();
    contextElement.innerHTML = state.inspector.open ? renderResourceContext() : "";
    document.querySelector("#retry-resources")?.addEventListener("click", () => {
      state.resourceError = "";
      state.resources = null;
      renderConsole();
      void refreshResources();
    });
    bindResourceEvents();
    return;
  }
  if (!state.selected) {
    workspaceElement.innerHTML = `
      <section class="empty-console">
        <span class="empty-symbol">↗</span>
        <h2>新建第一个目标</h2>
        <p>写下目标，生成计划，再确认并开始。</p>
        <button class="primary-button" id="empty-create" type="button">新建目标</button>
      </section>`;
    contextElement.innerHTML = "";
    document.querySelector("#empty-create")?.addEventListener("click", () => createDialog.showModal());
    return;
  }

  workspaceElement.innerHTML = renderWorkspace(state.selected, feedback);
  contextElement.innerHTML = state.inspector.open ? renderContext(state.selected) : "";
  bindRenderedEvents();
}

function renderWorkOrderList() {
  countElement.textContent = String(state.workOrders.length);
  if (state.workOrders.length === 0) {
    listElement.innerHTML = '<p class="sidebar-empty">暂无目标</p>';
    return;
  }

  listElement.innerHTML = state.workOrders.slice(0, 8).map(renderOrderRow).join("");

  document.querySelectorAll("[data-work-order-id]").forEach((button) => {
    button.addEventListener("click", () => selectWorkOrder(button.dataset.workOrderId));
  });
}

function renderAllGoalsWorkspace() {
  const groups = allGoalStatusGroups;
  const counts = Object.fromEntries(groups.map(([status]) => [
    status,
    state.workOrders.filter(
      (workOrder) => visibleStatus(workOrder, state.workOrders).status === status,
    ).length,
  ]));
  const visibleOrders = homeVisibleWorkOrders();
  const projectGroups = homeProjectGroups(visibleOrders);
  return `
    <section class="workspace-content all-goals-workspace">
      <header class="overview-heading">
        <div><p class="overline">工作台</p><h1>全部目标</h1></div>
        <div class="overview-actions">
          <button class="secondary-button" id="open-session-import-home" type="button">导入会话</button>
          <button class="primary-button" id="open-create-home" type="button">新建目标</button>
        </div>
      </header>
      <nav class="home-mobile-nav" aria-label="工作台导航">
        <button type="button" data-overview-path="/projects">项目</button>
        <button type="button" data-overview-path="/resources">资源</button>
        <button type="button" id="open-local-state-home">本地数据</button>
      </nav>
      <div class="status-summary" aria-label="目标状态摘要">
        ${groups
          .filter(([status]) => ["response", "review", "running", "completed"].includes(status))
          .map(([status, label]) => `<div data-home-status="${status}"><strong>${counts[status]}</strong><span>${label}</span></div>`)
          .join("")}
      </div>
      <div class="home-history-toolbar">
        <div><strong>按项目查看</strong><span>活动目标始终显示</span></div>
        <div class="home-history-filter" role="group" aria-label="历史目标范围">
          ${homeHistoryFilters.map(([value, label]) => `<button type="button" data-home-history="${value}" class="${state.homeHistoryFilter === value ? "active" : ""}" aria-pressed="${state.homeHistoryFilter === value}">${label}</button>`).join("")}
        </div>
      </div>
      ${visibleOrders.length
        ? `<div class="home-project-groups">${projectGroups.map(renderHomeProjectGroup).join("")}</div>`
        : `<section class="home-empty"><h2>还没有目标</h2><button class="primary-button" id="empty-create" type="button">新建目标</button></section>`}
    </section>`;
}

function renderHomeGoalRow(workOrder) {
  const presentation = visibleStatus(workOrder, state.workOrders);
  const stage = currentStageForGoal(workOrder);
  const accountLabel = homeAccountLabel(workOrder);
  return `
    <button class="home-goal-row" data-work-order-id="${escapeHtml(workOrder.id)}" type="button">
      <span class="status-dot ${presentation.status}"></span>
      <span class="home-goal-title"><strong>${escapeHtml(workOrder.title)}</strong>${accountLabel ? `<small class="goal-account-tag">${escapeHtml(accountLabel)}</small>` : ""}</span>
      <span class="home-goal-fact" data-label="当前节点"><strong>${escapeHtml(stage?.outcome || homeCurrentNodeFallback(workOrder))}</strong><small>${escapeHtml(stage?.statusReason || workOrder.currentSummary)}</small></span>
      <span class="home-goal-fact" data-label="状态"><span class="status-pill ${presentation.status}">${visibleStatusLabels[presentation.status]}</span><small>${escapeHtml(waitingReasonLabel(presentation))}</small></span>
      <span class="home-goal-fact" data-label="下一步"><strong>${escapeHtml(homeNextStep(workOrder, presentation))}</strong><small>更新于 ${formatDate(workOrder.updatedAt)}</small></span>
      <span class="row-arrow" aria-hidden="true">›</span>
    </button>`;
}

function homeVisibleWorkOrders() {
  const historyDays = Number(state.homeHistoryFilter);
  const cutoff = Number.isFinite(historyDays)
    ? Date.now() - historyDays * 24 * 60 * 60_000
    : null;
  return state.workOrders.filter((workOrder) => {
    const active = visibleStatus(workOrder, state.workOrders).status !== "completed";
    if (active || state.homeHistoryFilter === "all") return true;
    if (state.homeHistoryFilter === "current") return false;
    return Date.parse(workOrder.updatedAt) >= cutoff;
  });
}

function homeProjectGroups(workOrders) {
  const projectById = new Map(state.projects.map((project) => [project.id, project]));
  const grouped = new Map();
  for (const workOrder of workOrders) {
    const key = projectById.has(workOrder.projectId) ? workOrder.projectId : "unassigned";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(workOrder);
  }
  const orderedKeys = [
    ...state.projects.map((project) => project.id).filter((id) => grouped.has(id)),
    ...(grouped.has("unassigned") ? ["unassigned"] : []),
  ];
  return orderedKeys.map((key) => ({
    id: key,
    name: key === "unassigned" ? "独立目标" : projectById.get(key).name,
    orders: grouped.get(key).sort(compareHomeGoals),
  }));
}

function renderHomeProjectGroup(group) {
  return `
    <section class="home-project-section" data-home-project="${escapeHtml(group.id)}">
      <header><div><p class="overline">项目</p><h2>${escapeHtml(group.name)}</h2></div><span>${group.orders.length} 个目标</span></header>
      <div class="home-goal-table">
        <div class="home-goal-table-heading" aria-hidden="true"><span>目标</span><span>当前节点</span><span>状态与等待</span><span>下一步</span></div>
        ${group.orders.map(renderHomeGoalRow).join("")}
      </div>
    </section>`;
}

function compareHomeGoals(left, right) {
  const order = { response: 0, review: 1, running: 2, planning: 3, queued: 4, completed: 5 };
  const leftStatus = visibleStatus(left, state.workOrders).status;
  const rightStatus = visibleStatus(right, state.workOrders).status;
  return order[leftStatus] - order[rightStatus] || right.updatedAt.localeCompare(left.updatedAt);
}

function currentStageForGoal(workOrder) {
  const stages = workOrder.plan?.stages ?? [];
  return stages[preferredStageIndex(workOrder)] ?? null;
}

function homeCurrentNodeFallback(workOrder) {
  if (workOrder.importContext && !workOrder.plan) return "整理来源会话";
  return workOrder.plan ? "等待开始" : "尚未生成计划";
}

function waitingReasonLabel(presentation) {
  return ["queued", "response"].includes(presentation.status)
    ? presentation.reason
    : `当前：${presentation.reason}`;
}

function homeNextStep(workOrder, presentation) {
  if (presentation.status === "completed") return "查看成果";
  if (presentation.status === "review") return "验收成果与验证";
  if (presentation.status === "running") return "查看执行进展";
  if (presentation.status === "response") {
    if (presentation.reason.includes("外部节点")) return "登记外部成果";
    if (presentation.reason.includes("验证") || presentation.reason.includes("节点结果")) return "确认验证结果";
    if (presentation.reason.includes("关键信息")) return "补充关键信息";
    return "处理并继续";
  }
  if (presentation.status === "queued") {
    if (presentation.reason.includes("工作空间")) return "选择工作空间";
    if (presentation.reason === "等待账号") return "切换到目标账号";
    if (presentation.reason === "可以开始运行") return "确认并启动";
    return "等待资源可用";
  }
  if (workOrder.plan?.confirmationRequired) return "确认执行计划";
  if (workOrder.plan) return "准备开始";
  return workOrder.importContext ? "生成后续计划" : "生成执行计划";
}

function homeAccountLabel(workOrder) {
  const identities = state.executionIdentities.identities;
  if (new Set(identities.map((identity) => identity.id)).size <= 1) return "";
  const id = workOrder.executionIdentityId ?? state.executionIdentities.defaultIdentityId;
  const identity = identities.find((candidate) => candidate.id === id);
  if (!identity) return "未选账号";
  return `${identity.label}${identity.status === "removed" ? " · 已移除" : ""}`;
}

function renderProjectsWorkspace() {
  if (state.projectDetail) return renderProjectDetailWorkspace(state.projectDetail);
  return `
    <section class="workspace-content projects-workspace">
      <header class="overview-heading">
        <div><p class="overline">工作台</p><h1>项目</h1></div>
        <button class="secondary-button" id="toggle-project-create" type="button">新建项目</button>
      </header>
      <nav class="home-mobile-nav" aria-label="工作台导航">
        <button type="button" data-overview-path="/">全部目标</button>
        <button type="button" data-overview-path="/resources">资源</button>
      </nav>
      ${state.projectCreateOpen ? `
        <form class="project-create-form" id="project-create-form">
          <label><span>项目名称</span><input name="name" required placeholder="例如：发布 Personal Beta" autocomplete="off" /></label>
          <div><button class="primary-button" type="submit">创建项目</button><button class="text-button" id="cancel-project-create" type="button">取消</button></div>
          <p class="inline-feedback" id="project-feedback" role="status"></p>
        </form>` : ""}
      ${state.projects.length
        ? `<div class="project-list">${state.projects.map((project) => {
            const goals = state.workOrders.filter((workOrder) => workOrder.projectId === project.id);
            const completed = goals.filter((goal) => goal.userStatus === "completed").length;
            return `<button class="project-row" data-project-id="${escapeHtml(project.id)}" type="button"><span><strong>${escapeHtml(project.name)}</strong><small>${goals.length} 个目标${completed ? ` · ${completed} 个已完成` : ""}</small></span><span class="row-arrow" aria-hidden="true">›</span></button>`;
          }).join("")}</div>`
        : '<section class="home-empty"><h2>还没有项目</h2><p>项目只用来整理相关目标、素材和成果。</p></section>'}
    </section>`;
}

function renderProjectDetailWorkspace(detail) {
  const { project, summary, goals, materials, results } = detail;
  const focusGoals = goals.filter((goal) => ["running", "response", "review"].includes(visibleStatus(goal, state.workOrders).status));
  const recentGoals = [...goals].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 6);
  const completedGoals = state.workOrders.filter((goal) => goal.status === "delivered");
  return `
    <section class="workspace-content project-detail-workspace">
      <button class="mobile-back-button project-back-button" id="back-to-projects" type="button">‹ 全部项目</button>
      <header class="project-detail-heading">
        <div><p class="overline">项目</p><h1>${escapeHtml(project.name)}</h1></div>
        <dl><div><dt>目标</dt><dd>${summary.totalGoals}</dd></div><div><dt>已完成</dt><dd>${summary.completedGoals}</dd></div></dl>
      </header>
      <section class="project-section">
        <div class="section-heading compact"><div><p class="overline">当前</p><h2>需要关注</h2></div></div>
        ${focusGoals.length ? `<div class="project-goal-list">${focusGoals.map(renderProjectGoalRow).join("")}</div>` : '<p class="project-empty-copy">当前没有运行中、需响应或待验收的目标。</p>'}
      </section>
      <section class="project-section">
        <div class="section-heading compact"><div><p class="overline">目标</p><h2>最近更新</h2></div><button class="secondary-button" id="create-goal-in-project" type="button">新建目标</button></div>
        ${recentGoals.length ? `<div class="project-goal-list">${recentGoals.map(renderProjectGoalRow).join("")}</div>` : '<p class="project-empty-copy">这个项目还没有目标。</p>'}
      </section>
      <section class="project-section project-material-section">
        <div class="section-heading compact"><div><p class="overline">项目素材</p><h2>可供目标使用</h2></div><span class="subtle-label">${materials.length} 项</span></div>
        ${materials.length ? `<div class="project-material-grid">${materials.map(renderProjectMaterialCard).join("")}</div>` : '<p class="project-empty-copy">还没有素材，可以新建、引用或上传。</p>'}
        <details class="project-add-disclosure">
          <summary>添加项目素材</summary>
          <form id="project-material-form" class="project-material-form">
            <label><span>类型</span><select name="kind"><option value="text">文本</option><option value="repository">Git 仓库</option><option value="folder">文件夹</option><option value="file">文件路径</option><option value="image">图片路径</option><option value="link">链接</option><option value="goal">目标引用</option></select></label>
            <label><span>名称</span><input name="label" required placeholder="简短名称" autocomplete="off" /></label>
            <label data-project-material-value><span>内容或位置</span><textarea name="value" rows="3" required placeholder="写下文本，或填写本地路径和链接"></textarea></label>
            <label data-project-goal-value hidden><span>引用已完成目标</span><select name="goalId">${completedGoals.length
              ? completedGoals.map((goal) => `<option value="${escapeHtml(goal.id)}">${escapeHtml(goal.name)}</option>`).join("")
              : '<option value="" disabled selected>还没有已完成目标</option>'}</select></label>
            <button class="primary-button" type="submit">添加素材</button>
          </form>
          <form id="project-upload-form" class="project-upload-form">
            <label><span>上传文件或图片</span><input name="file" type="file" required /></label>
            <button class="secondary-button" type="submit">上传</button>
          </form>
          <p class="inline-feedback" id="project-material-feedback" role="status"></p>
        </details>
      </section>
      <section class="project-section">
        <div class="section-heading compact"><div><p class="overline">成果</p><h2>主要成果</h2></div></div>
        ${results.length ? `<div class="project-result-list">${results.map(renderProjectResultCard).join("")}</div>` : '<p class="project-empty-copy">项目内目标产生成果后，会汇总在这里。</p>'}
      </section>
    </section>`;
}

function renderProjectGoalRow(goal) {
  const presentation = visibleStatus(goal, state.workOrders);
  return `<button class="project-goal-row" data-work-order-id="${escapeHtml(goal.id)}" type="button"><span class="status-dot ${presentation.status}"></span><span><strong>${escapeHtml(goal.name)}</strong><small>${escapeHtml(formatVisibleStatus(presentation.status, presentation.reason))}</small></span><time>${formatDate(goal.updatedAt)}</time><span class="row-arrow" aria-hidden="true">›</span></button>`;
}

function renderProjectMaterialCard(material) {
  return `<button class="project-material-card" data-project-material-id="${escapeHtml(material.id)}" type="button"><span>${escapeHtml(projectMaterialKindLabel(material.kind))}${material.sourceGoalId ? " · 来自目标" : ""}</span><strong>${escapeHtml(material.label)}</strong><code>${escapeHtml(material.kind === "text" ? truncateText(material.value, 64) : shortPath(material.value))}</code></button>`;
}

function renderProjectResultCard(result) {
  const goal = state.workOrders.find((candidate) => candidate.id === result.workOrderId);
  const presentation = goal ? visibleStatus(goal, state.workOrders) : { status: "completed", reason: "已产生结果" };
  const artifact = result.artifacts?.[0];
  return `<button class="project-result-card" data-project-result-id="${escapeHtml(result.workOrderId)}" type="button"><span>${escapeHtml(visibleStatusLabels[presentation.status] || presentation.reason)}</span><strong>${escapeHtml(result.title)}</strong><p>${escapeHtml(artifact?.label || result.gitSummary || result.summary)}</p></button>`;
}

function bindOverviewEvents() {
  document.querySelector("#open-create-home")?.addEventListener("click", openCreateDialog);
  document.querySelector("#empty-create")?.addEventListener("click", openCreateDialog);
  document.querySelector("#open-session-import-home")?.addEventListener("click", openSessionImport);
  document.querySelector("#open-local-state-home")?.addEventListener("click", () => {
    resetRestorePreview();
    localStateDialog.showModal();
  });
  document.querySelectorAll("[data-overview-path]").forEach((button) => {
    button.addEventListener("click", () => {
      history.pushState({}, "", button.dataset.overviewPath);
      resetGoalSelection();
      refreshConsole();
    });
  });
  document.querySelectorAll(".home-goal-row").forEach((button) => {
    button.addEventListener("click", () => selectWorkOrder(button.dataset.workOrderId));
  });
  document.querySelectorAll("[data-home-history]").forEach((button) => {
    button.addEventListener("click", () => {
      state.homeHistoryFilter = button.dataset.homeHistory;
      renderConsole();
    });
  });
  document.querySelector("#toggle-project-create")?.addEventListener("click", () => {
    state.projectCreateOpen = !state.projectCreateOpen;
    renderConsole();
  });
  document.querySelector("#cancel-project-create")?.addEventListener("click", () => {
    state.projectCreateOpen = false;
    renderConsole();
  });
  document.querySelector("#project-create-form")?.addEventListener("submit", createProject);
  document.querySelectorAll("[data-project-id]").forEach((button) => {
    button.addEventListener("click", () => openProject(button.dataset.projectId));
  });
  document.querySelector("#back-to-projects")?.addEventListener("click", openProjects);
  document.querySelector("#create-goal-in-project")?.addEventListener("click", () => {
    openCreateDialog();
    document.querySelector("#create-project-select").value = state.projectDetail.project.id;
    void refreshCreateProjectMaterials();
  });
  document.querySelectorAll(".project-goal-row").forEach((button) => {
    button.addEventListener("click", () => selectWorkOrder(button.dataset.workOrderId));
  });
  document.querySelectorAll("[data-project-material-id]").forEach((button) => {
    button.addEventListener("click", () => {
      openContextInspector({ type: "project-material", id: button.dataset.projectMaterialId });
      renderConsole();
    });
  });
  document.querySelectorAll("[data-project-result-id]").forEach((button) => {
    button.addEventListener("click", () => {
      openContextInspector({ type: "project-result", id: button.dataset.projectResultId });
      renderConsole();
    });
  });
  document.querySelector("[data-open-project-result-goal]")?.addEventListener("click", (event) => {
    selectWorkOrder(event.currentTarget.dataset.openProjectResultGoal);
  });
  document.querySelector("#close-context-inspector")?.addEventListener("click", dismissContextInspector);
  document.querySelector("#project-material-form [name=kind]")?.addEventListener("change", toggleProjectMaterialValue);
  document.querySelector("#project-material-form")?.addEventListener("submit", createProjectMaterial);
  document.querySelector("#project-upload-form")?.addEventListener("submit", uploadProjectMaterial);
}

async function createProject(event) {
  event.preventDefault();
  const button = event.submitter;
  setBusy(button, "正在创建…");
  try {
    const { project } = await requestJson("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: new FormData(event.currentTarget).get("name") }),
    });
    state.projectCreateOpen = false;
    history.pushState({}, "", `/projects/${encodeURIComponent(project.id)}`);
    await refreshConsole();
  } catch (error) {
    resetBusy(button, "创建项目");
    setFeedback("project-feedback", messageFrom(error, "无法创建项目"), true);
  }
}

function openProject(id) {
  history.pushState({}, "", `/projects/${encodeURIComponent(id)}`);
  state.projectDetail = null;
  state.inspector = clearContextInspector();
  refreshConsole();
}

function renderProjectContext() {
  const selection = state.inspector.selection;
  if (!selection || !state.projectDetail) return renderUnavailableContext();
  if (selection.type === "project-material") {
    const material = state.projectDetail.materials.find((candidate) => candidate.id === selection.id);
    if (!material) return renderUnavailableContext();
    const sourceGoal = material.sourceGoalId
      ? state.workOrders.find((goal) => goal.id === material.sourceGoalId)
      : null;
    return `
      <section class="context-content">
        <div class="context-heading">
          <div><p class="overline">项目素材</p><h2>${escapeHtml(material.label)}</h2></div>
          ${renderContextCloseButton()}
        </div>
        <dl class="context-list">
          <div><dt>类型</dt><dd>${escapeHtml(projectMaterialKindLabel(material.kind))}</dd></div>
          <div><dt>来源</dt><dd>${escapeHtml(sourceGoal ? `目标 · ${sourceGoal.name}` : "项目内添加")}</dd></div>
          <div><dt>更新于</dt><dd>${formatDate(material.updatedAt)}</dd></div>
        </dl>
        <div class="context-section project-context-value">
          <span>${material.kind === "text" ? "内容" : material.kind === "goal" ? "引用目标" : "位置"}</span>
          ${material.kind === "text" || material.kind === "goal"
            ? `<p>${escapeHtml(material.kind === "goal" ? sourceGoal?.name || "原目标已不可用" : material.value)}</p>`
            : `<code>${escapeHtml(material.value)}</code>`}
        </div>
      </section>`;
  }
  if (selection.type === "project-result") {
    const result = state.projectDetail.results.find((candidate) => candidate.workOrderId === selection.id);
    if (!result) return renderUnavailableContext();
    return `
      <section class="context-content">
        <div class="context-heading">
          <div><p class="overline">项目成果</p><h2>${escapeHtml(result.title)}</h2></div>
          ${renderContextCloseButton()}
        </div>
        <p class="context-summary">${escapeHtml(result.summary)}</p>
        ${result.gitSummary ? `<div class="context-section"><span>文件变化</span><p>${escapeHtml(result.gitSummary)}</p></div>` : ""}
        ${result.artifacts?.length
          ? `<div class="context-section"><span>成果位置</span><ul class="context-reference-list">${result.artifacts.map((artifact) => `<li><strong>${escapeHtml(artifact.label || shortPath(artifact.location))}</strong><code>${escapeHtml(artifact.location)}</code></li>`).join("")}</ul></div>`
          : ""}
        <div class="context-section"><button class="secondary-button" type="button" data-open-project-result-goal="${escapeHtml(result.workOrderId)}">查看目标</button></div>
      </section>`;
  }
  return renderUnavailableContext();
}

function openProjects() {
  history.pushState({}, "", "/projects");
  state.projectDetail = null;
  state.inspector = clearContextInspector();
  refreshConsole();
}

function toggleProjectMaterialValue(event) {
  const isGoal = event.currentTarget.value === "goal";
  document.querySelector("[data-project-material-value]").hidden = isGoal;
  document.querySelector("[data-project-material-value] textarea").required = !isGoal;
  document.querySelector("[data-project-goal-value]").hidden = !isGoal;
  document.querySelector("[data-project-goal-value] select").required = isGoal;
}

async function createProjectMaterial(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const kind = String(data.get("kind"));
  const button = event.submitter;
  setBusy(button, "正在添加…");
  try {
    await requestJson(`/api/projects/${encodeURIComponent(state.projectDetail.project.id)}/materials`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind,
        label: data.get("label"),
        value: kind === "goal" ? data.get("goalId") : data.get("value"),
      }),
    });
    await refreshConsole();
  } catch (error) {
    resetBusy(button, "添加素材");
    setFeedback("project-material-feedback", messageFrom(error, "无法添加素材"), true);
  }
}

async function uploadProjectMaterial(event) {
  event.preventDefault();
  const button = event.submitter;
  setBusy(button, "正在上传…");
  try {
    await requestJson(`/api/projects/${encodeURIComponent(state.projectDetail.project.id)}/uploads`, {
      method: "POST",
      body: new FormData(event.currentTarget),
    });
    await refreshConsole();
  } catch (error) {
    resetBusy(button, "上传");
    setFeedback("project-material-feedback", messageFrom(error, "无法上传文件"), true);
  }
}

function renderResourceSummary() {
  if (!state.resources) {
    resourceSummaryElement.innerHTML = state.resourceError
      ? `<button type="button" data-open-resource-summary><strong>Codex 额度读取失败</strong><span>工作台仍可使用</span></button>`
      : "<span>Codex 额度正在读取…</span>";
    resourceSummaryElement.querySelector("button")?.addEventListener("click", () => {
      history.pushState({}, "", "/resources");
      resetGoalSelection();
      renderConsole();
    });
    return;
  }
  const { codex } = state.resources;
  const accounts = state.resources.codexAccounts ?? [];
  const current = accounts.find(({ backupStatus }) => backupStatus === "current");
  const shownQuota = current?.quota ?? codex;
  resourceSummaryElement.innerHTML = `
    <details class="topbar-quota-control">
      <summary>
        <span>Codex 额度</span>
        ${shownQuota.status === "available"
          ? `<strong>5 小时 ${formatRemaining(shownQuota.shortWindow)}</strong><i>周 ${formatRemaining(shownQuota.longWindow)}</i>`
          : `<strong>${resourceStatusLabel(shownQuota.status)}</strong>`}
      </summary>
      <div class="topbar-quota-popover">
        ${accounts.length
          ? accounts.map(renderTopbarAccountQuota).join("")
          : `<article><strong>Codex</strong><span>${resourceStatusLabel(codex.status)}</span></article>`}
        <button class="text-button" type="button" data-open-resource-summary>管理账号与额度</button>
      </div>
    </details>`;
  resourceSummaryElement.querySelector("[data-open-resource-summary]")?.addEventListener("click", () => {
    resourceSummaryElement.querySelector(".topbar-quota-control")?.removeAttribute("open");
    history.pushState({}, "", "/resources");
    resetGoalSelection();
    renderConsole();
  });
}

function renderTopbarAccountQuota({ identity, quota, backupLabel }) {
  return `
    <article>
      <div><strong>${escapeHtml(identity.label)}</strong><span>${escapeHtml(compactBackupLabel(backupLabel))}</span></div>
      <dl><div><dt>5 小时</dt><dd>${formatRemaining(quota.shortWindow)}</dd></div><div><dt>周</dt><dd>${formatRemaining(quota.longWindow)}</dd></div></dl>
    </article>`;
}

function renderResourceWorkspace() {
  const resources = state.resources;
  if (state.resourceError) {
    return `<section class="empty-console error-state resource-workspace"><span class="empty-symbol">!</span><h2>资源状态读取失败</h2><p>${escapeHtml(state.resourceError)}</p><button class="secondary-button" id="retry-resources" type="button">重新读取资源</button></section>`;
  }
  if (!resources) return '<div class="loading-state">正在读取资源状态…</div>';
  return `
    <section class="workspace-content resource-workspace">
      <header class="workspace-heading">
        <div><p class="overline">资源</p><h1>额度状态</h1></div>
        <span class="saved-state">更新于 ${formatDate(resources.observedAt)}</span>
      </header>
      <section class="resource-overview">
        ${renderCodexResourceCard(resources.codex, resources.runningCount)}
        ${renderApiResourceCard(resources.openaiApi, resources.paidApi)}
      </section>
      ${Array.isArray(resources.codexAccounts) ? renderCodexAccountQuota(resources.codexAccounts) : ""}
      <section class="resource-runtime-panel">
        <div><p class="overline">运行设置</p><h2>本机并发</h2></div>
        <div class="resource-runtime-controls">
          <label class="resource-concurrency-control" title="同时运行的目标上限">
            <span>最大并发目标数</span>
            <input id="max-concurrency" type="number" min="1" step="1" value="${state.executionSettings.maxConcurrency}" inputmode="numeric" aria-label="本机最大并发数" />
          </label>
          <form id="paid-api-budget-form" class="resource-budget-control">
            <label><span>API 月度预算</span><input name="monthlyBudgetUsd" type="number" min="0.01" step="0.01" value="${resources.paidApi?.budget?.monthlyBudgetUsd ?? ""}" placeholder="未设置" inputmode="decimal" aria-label="API 月度预算（美元）" /></label>
            <button class="text-button" type="submit">保存</button>
          </form>
        </div>
        ${resources.paidApi?.pending ? `<div class="paid-api-pending"><span>上一笔 API 费用仍在回传，新的付费执行已暂缓。</span><button class="text-button" type="button" data-clear-paid-api-pending="${escapeHtml(resources.paidApi.pending.workOrderId)}">确认无待回传费用并解除</button></div>` : ""}
      </section>
      <section class="resource-orders-panel">
        <div class="section-heading compact">
          <div><p class="overline">安排</p><h2>目标资源</h2></div>
          <span class="subtle-label">${resources.workOrders.length} 个目标</span>
        </div>
        ${resources.workOrders.length
          ? `<div class="resource-order-list">${resources.workOrders.map(renderResourceOrder).join("")}</div>`
          : '<p class="muted">新建目标后，可在这里安排优先级、执行节奏和自动运行。</p>'}
      </section>
    </section>`;
}

function renderCodexResourceCard(codex, runningCount) {
  const available = codex.status === "available";
  return `
    <article class="resource-card ${available ? "available" : "unavailable"}">
      <div class="resource-card-heading"><div><p class="overline">Codex 订阅</p><h2>${available ? "额度可读取" : resourceStatusLabel(codex.status)}</h2></div><span class="status-pill ${available ? "running" : "response"}">${runningCount} 项运行中</span></div>
      ${available
        ? `<div class="quota-windows">${renderQuotaWindow("5 小时", codex.shortWindow)}${renderQuotaWindow("周额度", codex.longWindow)}</div>`
        : `<p class="resource-message">${escapeHtml(codex.message || "暂时没有可用额度数据")}</p>`}
    </article>`;
}

function renderCodexAccountQuota(accounts) {
  return `
    <section class="identity-quota-panel">
      <div class="section-heading compact">
        <div><p class="overline">Codex 账号</p><h2>账号与额度</h2></div>
        <div class="identity-panel-tools">
          <span class="subtle-label">${accounts.length} 个已启用</span>
          <details class="identity-add-disclosure">
            <summary>添加账号</summary>
            <form id="add-identity-form">
              <label><span>账号名称</span><input name="label" required maxlength="40" placeholder="例如：备用" autocomplete="off" /></label>
              <button class="primary-button" type="submit">添加并登录</button>
              <p class="inline-feedback" id="identity-create-feedback" role="status"></p>
            </form>
          </details>
        </div>
      </div>
      <div class="identity-quota-list">
        ${accounts.length ? accounts.map(({ identity, quota, backupLabel, backupStatus }) => {
          const login = state.identityLoginStates[identity.id];
          return `
          <article class="identity-quota-row">
            <button class="identity-quota-heading inspector-selection-button" type="button" data-resource-account-id="${escapeHtml(identity.id)}">
              <div><strong>${escapeHtml(identity.label)}</strong><small>${resourceStatusLabel(quota.status)}</small></div>
              <span class="status-pill ${backupStatus === "available" ? "running" : backupStatus === "unknown" ? "response" : "queued"}">${escapeHtml(compactBackupLabel(backupLabel))}</span>
            </button>
            <div class="quota-windows compact">
              ${renderQuotaWindow("5 小时", quota.shortWindow)}
              ${renderQuotaWindow("周额度", quota.longWindow)}
            </div>
            ${quota.message ? `<p class="resource-message compact">${escapeHtml(quota.message)}</p>` : ""}
            <div class="identity-actions">
              ${identity.homeKind === "managed" && ["signed_out", "expired"].includes(identity.loginState) ? `<button class="secondary-button" type="button" data-login-identity="${escapeHtml(identity.id)}" ${login?.status === "in_progress" ? "disabled" : ""}>${login?.status === "in_progress" ? "登录中…" : "登录"}</button>` : ""}
              <button class="text-button" type="button" data-refresh-identity="${escapeHtml(identity.id)}">刷新状态</button>
              <span data-identity-login-message>${escapeHtml(identityLoginMessage(login, identity))}</span>
            </div>
          </article>`;
        }).join("") : '<p class="muted identity-empty">还没有可用账号，可以先添加一个。</p>'}
      </div>
    </section>`;
}

function compactBackupLabel(label) {
  return {
    "备用账号可用": "备用可用",
    "备用账号额度未知": "备用未知",
    "备用账号额度不足": "备用不足",
  }[label] ?? label;
}

function identityLoginMessage(login, identity) {
  if (login?.status === "in_progress") return "请在打开的页面完成登录";
  if (login?.status === "failed") return login.error || "登录失败";
  if (login?.status === "completed") return "登录已完成，正在确认账号";
  return {
    ready: "已登录",
    signed_out: "未登录",
    expired: "登录已失效",
    pending: "等待登录",
    unknown: "状态未知",
  }[identity.loginState] ?? "";
}

function renderQuotaWindow(label, window) {
  if (!window) {
    return `<div><span>${label}</span><strong>不可用</strong><small>暂无数据</small></div>`;
  }
  return `<div><span>${label}</span><strong>${formatRemaining(window)}</strong><small>${formatReset(window.resetsAt)}</small></div>`;
}

function renderApiResourceCard(api, paidApi) {
  const available = api.status === "available" && api.usage;
  return `
    <article class="resource-card ${available ? "available" : "unavailable"}">
      <div class="resource-card-heading"><div><p class="overline">OpenAI API</p><h2>${available ? "账户用量" : resourceStatusLabel(api.status)}</h2></div><span class="subtle-label">${paidApi?.available ? "可用于付费执行" : "仅显示用量"}</span></div>
      ${available
        ? `<strong class="account-usage">${formatUsage(api.usage)}</strong><p class="resource-message">${scopeLabel(api.scope)}账户用量</p>`
        : `<p class="resource-message">${escapeHtml(api.message || "连接后可查看 API 用量和费用")}</p>`}
      ${paidApi?.budget?.monthlyBudgetUsd ? `<p class="resource-message compact">月度预算 ${formatUsage({ amount: paidApi.budget.monthlyBudgetUsd, unit: "usd" })}。用量可能延迟，达到限额后停止后续节点。</p>` : ""}
    </article>`;
}

function renderResourceOrder(workOrder) {
  const locked = workOrder.importOnly || workOrder.status === "completed";
  const usage = workOrder.usage.status === "available"
    ? formatUsage(workOrder.usage)
    : escapeHtml(workOrder.usage.message || "不可用");
  return `
    <article class="resource-order-row">
      <button class="resource-order-title inspector-selection-button" type="button" data-resource-work-order-id="${escapeHtml(workOrder.id)}"><span class="status-dot ${workOrder.status}"></span><span><strong>${escapeHtml(workOrder.title)}</strong><small>${visibleStatusLabels[workOrder.status] || workOrder.status}</small></span><i class="row-arrow" aria-hidden="true">›</i></button>
      <dl>
        ${workOrder.importOnly ? "" : `<div><dt>优先级</dt><dd><select data-resource-priority data-work-order-id="${escapeHtml(workOrder.id)}" ${locked ? "disabled" : ""}>${resourceOptions([
          ["high", "优先推进"],
          ["normal", "正常推进"],
          ["background", "后台推进"],
        ], workOrder.priority)}</select></dd></div>
        <div><dt>执行节奏</dt><dd><select data-resource-pace data-work-order-id="${escapeHtml(workOrder.id)}" ${locked ? "disabled" : ""}>${resourceOptions([
          ["fast", "尽快完成"],
          ["balanced", "均匀推进"],
          ["saving", "节省额度"],
        ], workOrder.pace)}</select></dd></div>
        <div><dt>单轮上限</dt><dd>${formatRunLimit(workOrder.maxRunMinutes)}</dd></div>`}
        <div><dt>当前用量</dt><dd>${usage}</dd></div>
        <div><dt>运行建议</dt><dd>${escapeHtml(workOrder.recommendation)}</dd></div>
      </dl>
      ${workOrder.importOnly ? '<p class="source-import-only">这个目标仅保留导入状态，不会自动运行。</p>' : workOrder.status === "completed" ? '<p class="source-import-only">已完成目标保留当时的资源设置。</p>' : `<label class="auto-run-toggle">
        <input type="checkbox" data-resource-auto-run data-work-order-id="${escapeHtml(workOrder.id)}" ${workOrder.runWhenQuotaAvailable ? "checked" : ""} ${locked ? "disabled" : ""} />
        <span><strong>额度充足时运行</strong><small>${escapeHtml(workOrder.autoRunReason || "每次只开始一轮，并受本轮时长限制")}</small></span>
      </label>
      <div class="paid-api-row">
        <label class="auto-run-toggle compact">
          <input type="checkbox" data-resource-paid-api data-work-order-id="${escapeHtml(workOrder.id)}" ${workOrder.paidApiFallbackEnabled ? "checked" : ""} ${locked ? "disabled" : ""} />
          <span><strong>订阅额度不足时使用付费 API</strong><small>默认关闭，只依据实际用量继续</small></span>
        </label>
        <label><span>目标限额（美元）</span><input data-resource-paid-limit data-work-order-id="${escapeHtml(workOrder.id)}" type="number" min="0.01" step="0.01" value="${workOrder.paidApiLimitUsd ?? ""}" placeholder="未设置" ${locked ? "disabled" : ""} /></label>
      </div>`}
    </article>`;
}

function resourceOptions(options, selected) {
  return options
    .map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`)
    .join("");
}

function bindResourceEvents() {
  document.querySelector("#max-concurrency")?.addEventListener("change", saveMaxConcurrency);
  document.querySelector("#paid-api-budget-form")?.addEventListener("submit", savePaidApiBudget);
  document.querySelector("[data-clear-paid-api-pending]")?.addEventListener("click", clearPaidApiPending);
  document.querySelector("#add-identity-form")?.addEventListener("submit", createAndLoginIdentity);
  document.querySelectorAll("[data-resource-priority], [data-resource-pace], [data-resource-auto-run], [data-resource-paid-api], [data-resource-paid-limit]")
    .forEach((control) => control.addEventListener("change", () => saveResourcePlan(control.dataset.workOrderId)));
  document.querySelectorAll("[data-login-identity]").forEach((button) => {
    button.addEventListener("click", () => startIdentityLogin(button.dataset.loginIdentity));
  });
  document.querySelectorAll("[data-refresh-identity]").forEach((button) => {
    button.addEventListener("click", () => refreshExecutionIdentity(button.dataset.refreshIdentity, button));
  });
  document.querySelectorAll("[data-resource-account-id]").forEach((button) => {
    button.addEventListener("click", () => {
      openContextInspector({ type: "resource-account", id: button.dataset.resourceAccountId });
      renderConsole();
    });
  });
  document.querySelectorAll("[data-resource-work-order-id]").forEach((button) => {
    button.addEventListener("click", () => {
      openContextInspector({ type: "resource-work-order", id: button.dataset.resourceWorkOrderId });
      renderConsole();
    });
  });
  document.querySelector("#close-context-inspector")?.addEventListener("click", dismissContextInspector);
}

async function clearPaidApiPending(event) {
  const button = event.currentTarget;
  const workOrderId = button.dataset.clearPaidApiPending;
  if (!workOrderId) return;
  const confirmed = window.confirm(
    "只有确认这次执行没有尚未回传的 API 费用时再解除。解除后，其他付费执行可能继续。",
  );
  if (!confirmed) return;
  setBusy(button, "解除中…");
  try {
    await requestJson("/api/resources/paid-api-attribution/clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workOrderId, confirmNoPendingCharge: true }),
    });
    await refreshConsole({ polling: true });
  } catch (error) {
    resetBusy(button, "确认无待回传费用并解除");
    state.resourceError = messageFrom(error, "无法解除 API 用量等待");
    renderConsole();
  }
}

async function createAndLoginIdentity(event) {
  event.preventDefault();
  const button = event.submitter;
  const label = String(new FormData(event.currentTarget).get("label") ?? "").trim();
  setBusy(button, "正在添加…");
  let identity;
  try {
    ({ identity } = await requestJson("/api/execution-identities", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label }),
    }));
  } catch (error) {
    resetBusy(button, "添加并登录");
    setFeedback("identity-create-feedback", messageFrom(error, "无法添加 Codex 账号"), true);
    return;
  }
  try {
    state.identityLoginChecks.add(identity.id);
    const result = await requestJson(
      `/api/execution-identities/${encodeURIComponent(identity.id)}/login`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      },
    );
    state.identityLoginStates[identity.id] = result.login;
    await refreshConsole({ polling: true, checkAutoRun: false });
    scheduleIdentityLoginPoll(identity.id);
  } catch (error) {
    state.identityLoginStates[identity.id] = {
      status: "failed",
      error: messageFrom(error, "账号已添加，但无法开始登录"),
    };
    await refreshConsole({ polling: true, checkAutoRun: false });
  }
}

async function startIdentityLogin(id) {
  const button = document.querySelector(`[data-login-identity="${CSS.escape(id)}"]`);
  setBusy(button, "正在检查…");
  try {
    state.identityLoginChecks.add(id);
    const current = await requestJson(`/api/execution-identities/${encodeURIComponent(id)}/login`);
    if (current.login.status === "in_progress") {
      state.identityLoginStates[id] = current.login;
      renderConsole();
      scheduleIdentityLoginPoll(id);
      return;
    }
    if (current.login.status === "completed") {
      const identity = await refreshIdentityAfterLogin(id);
      if (identity.loginState === "ready") {
        delete state.identityLoginStates[id];
        await refreshConsole({ polling: true, checkAutoRun: false });
        return;
      }
    }
    const result = await requestJson(`/api/execution-identities/${encodeURIComponent(id)}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    state.identityLoginStates[id] = result.login;
    renderConsole();
    scheduleIdentityLoginPoll(id);
  } catch (error) {
    resetBusy(button, "登录");
    state.identityLoginStates[id] = { status: "failed", error: messageFrom(error, "无法开始登录") };
    renderConsole();
  }
}

function resumeIdentityLoginChecks() {
  state.executionIdentities.identities
    .filter(
      (identity) =>
        identity.homeKind === "managed" &&
        identity.status === "enabled" &&
        ["signed_out", "expired"].includes(identity.loginState) &&
        !state.identityLoginChecks.has(identity.id),
    )
    .forEach((identity) => {
      state.identityLoginChecks.add(identity.id);
      void recoverIdentityLoginState(identity.id);
    });
}

async function recoverIdentityLoginState(id) {
  try {
    const { login } = await requestJson(
      `/api/execution-identities/${encodeURIComponent(id)}/login`,
    );
    state.identityLoginStates[id] = login;
    if (login.status === "in_progress") {
      scheduleIdentityLoginPoll(id);
      if (isResourceView()) renderConsole();
      return;
    }
    if (login.status === "completed") {
      const identity = await refreshIdentityAfterLogin(id);
      if (identity.loginState === "ready") {
        delete state.identityLoginStates[id];
      } else {
        state.identityLoginStates[id] = {
          status: "failed",
          error: "登录已结束，但账号仍未就绪，请重新登录",
        };
      }
      await refreshConsole({ polling: true, checkAutoRun: false });
      return;
    }
    if (isResourceView()) renderConsole();
  } catch (error) {
    state.identityLoginStates[id] = {
      status: "failed",
      error: messageFrom(error, "无法恢复登录状态"),
    };
    if (isResourceView()) renderConsole();
  }
}

async function refreshIdentityAfterLogin(id) {
  const { identity } = await requestJson(
    `/api/execution-identities/${encodeURIComponent(id)}/refresh`,
    { method: "POST" },
  );
  state.executionIdentities.identities = state.executionIdentities.identities.map(
    (candidate) => candidate.id === id ? identity : candidate,
  );
  return identity;
}

function scheduleIdentityLoginPoll(id) {
  clearTimeout(state.identityLoginTimers.get(id));
  state.identityLoginTimers.set(id, setTimeout(() => void pollIdentityLogin(id), 1_500));
}

async function pollIdentityLogin(id) {
  try {
    const result = await requestJson(`/api/execution-identities/${encodeURIComponent(id)}/login`);
    state.identityLoginStates[id] = result.login;
    if (result.login.status === "in_progress") {
      if (isResourceView()) renderConsole();
      scheduleIdentityLoginPoll(id);
      return;
    }
    if (result.login.status === "completed") {
      const identity = await refreshIdentityAfterLogin(id);
      if (identity.loginState === "ready") {
        delete state.identityLoginStates[id];
      } else {
        state.identityLoginStates[id] = {
          status: "failed",
          error: "登录已结束，但账号仍未就绪，请重新登录",
        };
      }
      await refreshConsole({ polling: true, checkAutoRun: false });
      return;
    }
    if (isResourceView()) renderConsole();
  } catch (error) {
    state.identityLoginStates[id] = { status: "failed", error: messageFrom(error, "无法读取登录状态") };
    if (isResourceView()) renderConsole();
  }
}

async function refreshExecutionIdentity(id, button) {
  setBusy(button, "刷新中…");
  try {
    await requestJson(`/api/execution-identities/${encodeURIComponent(id)}/refresh`, {
      method: "POST",
    });
    await refreshConsole({ polling: true, checkAutoRun: false });
  } catch (error) {
    resetBusy(button, "刷新状态");
    state.identityLoginStates[id] = { status: "failed", error: messageFrom(error, "无法刷新账号状态") };
    renderConsole();
  }
}

async function saveResourcePlan(id) {
  const priority = document.querySelector(`[data-resource-priority][data-work-order-id="${CSS.escape(id)}"]`);
  const pace = document.querySelector(`[data-resource-pace][data-work-order-id="${CSS.escape(id)}"]`);
  const autoRun = document.querySelector(`[data-resource-auto-run][data-work-order-id="${CSS.escape(id)}"]`);
  const paidApi = document.querySelector(`[data-resource-paid-api][data-work-order-id="${CSS.escape(id)}"]`);
  const paidLimit = document.querySelector(`[data-resource-paid-limit][data-work-order-id="${CSS.escape(id)}"]`);
  if (!priority || !pace || !autoRun || !paidApi || !paidLimit) return;
  for (const control of [priority, pace, autoRun, paidApi, paidLimit]) control.disabled = true;
  try {
    await requestJson(`/api/work-orders/${encodeURIComponent(id)}/resource-plan`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        priority: priority.value,
        pace: pace.value,
        runWhenQuotaAvailable: autoRun.checked,
        paidApiFallbackEnabled: paidApi.checked,
        paidApiLimitUsd: paidLimit.value ? Number(paidLimit.value) : null,
      }),
    });
    if (autoRun.checked) {
      await requestJson("/api/resources/run-once", { method: "POST" });
    }
    await refreshConsole({ polling: true });
  } catch (error) {
    state.resourceError = messageFrom(error, "无法保存资源安排");
    await refreshConsole({ polling: true });
  }
}

async function savePaidApiBudget(event) {
  event.preventDefault();
  const button = event.submitter;
  const value = new FormData(event.currentTarget).get("monthlyBudgetUsd");
  setBusy(button, "保存中…");
  try {
    await requestJson("/api/resources/paid-api-budget", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ monthlyBudgetUsd: value ? Number(value) : null }),
    });
    await refreshConsole({ polling: true });
  } catch (error) {
    resetBusy(button, "保存");
    state.resourceError = messageFrom(error, "无法保存 API 月度预算");
    renderConsole();
  }
}

function renderResourceContext() {
  if (state.resourceError) {
    return `<section class="context-content context-empty"><div class="context-heading"><div><p class="overline">资源详情</p><h2>稍后重试</h2></div>${renderContextCloseButton()}</div><p>目标不受影响，可以继续处理。</p></section>`;
  }
  const resources = state.resources;
  if (!resources) return '<div class="loading-state">正在准备资源详情…</div>';
  const selection = state.inspector.selection;
  if (!selection) return renderUnavailableContext();
  if (selection.type === "resource-account") {
    const account = resources.codexAccounts?.find(({ identity }) => identity.id === selection.id);
    if (!account) return renderUnavailableContext();
    const { identity, quota, backupLabel } = account;
    return `
      <section class="context-content">
        <div class="context-heading">
          <div><p class="overline">Codex 账号</p><h2>${escapeHtml(identity.label)}</h2></div>
          ${renderContextCloseButton()}
        </div>
        <dl class="context-list">
          <div><dt>可用状态</dt><dd>${escapeHtml(resourceStatusLabel(quota.status))}</dd></div>
          <div><dt>当前用途</dt><dd>${escapeHtml(compactBackupLabel(backupLabel))}</dd></div>
          <div><dt>登录状态</dt><dd>${escapeHtml(identityLoginMessage(state.identityLoginStates[identity.id], identity))}</dd></div>
          <div><dt>更新于</dt><dd>${formatDate(quota.observedAt)}</dd></div>
        </dl>
        <div class="quota-windows context-quota-windows">
          ${renderQuotaWindow("5 小时", quota.shortWindow)}
          ${renderQuotaWindow("周额度", quota.longWindow)}
        </div>
        ${quota.message ? `<p class="context-summary">${escapeHtml(quota.message)}</p>` : ""}
      </section>`;
  }
  if (selection.type === "resource-work-order") {
    const resourceGoal = resources.workOrders.find((workOrder) => workOrder.id === selection.id);
    if (!resourceGoal) return renderUnavailableContext();
    const goal = state.workOrders.find((workOrder) => workOrder.id === resourceGoal.id);
    const identityId = goal?.executionIdentityId ?? state.executionIdentities.defaultIdentityId;
    const identity = state.executionIdentities.identities.find((candidate) => candidate.id === identityId);
    const usage = resourceGoal.usage.status === "available"
      ? formatUsage(resourceGoal.usage)
      : resourceGoal.usage.message || "不可用";
    return `
      <section class="context-content">
        <div class="context-heading">
          <div><p class="overline">目标资源</p><h2>${escapeHtml(resourceGoal.title)}</h2></div>
          ${renderContextCloseButton()}
        </div>
        <dl class="context-list">
          <div><dt>账号</dt><dd>${escapeHtml(identity?.label || "未指定")}</dd></div>
          <div><dt>优先级</dt><dd>${escapeHtml(resourcePriorityLabel(resourceGoal.priority))}</dd></div>
          <div><dt>执行节奏</dt><dd>${escapeHtml(resourcePaceLabel(resourceGoal.pace))}</dd></div>
          <div><dt>单轮上限</dt><dd>${escapeHtml(formatRunLimit(resourceGoal.maxRunMinutes))}</dd></div>
          <div><dt>可归因用量</dt><dd>${escapeHtml(usage)}</dd></div>
          ${resourceGoal.usage.observedAt ? `<div><dt>用量更新于</dt><dd>${formatDate(resourceGoal.usage.observedAt)}</dd></div>` : ""}
        </dl>
        <p class="context-summary">${escapeHtml(resourceGoal.recommendation)}</p>
      </section>`;
  }
  return renderUnavailableContext();
}

function renderOrderRow(workOrder) {
  const presentation = visibleStatus(workOrder, state.workOrders);
  const selected = state.selected?.id === workOrder.id;
  const unread = state.notifications.some(
    (notification) => notification.workOrderId === workOrder.id && !notification.readAt,
  );
  return `
    <button class="order-row ${selected ? "selected" : ""}" data-work-order-id="${escapeHtml(workOrder.id)}" type="button">
      <span class="status-dot ${presentation.status}"></span>
      <span class="order-row-copy">
        <strong>${escapeHtml(workOrder.title)}</strong>
        <small>${escapeHtml(formatVisibleStatus(presentation.status, presentation.reason))}</small>
      </span>
      ${unread ? '<span class="unread-indicator" aria-label="有未读通知"></span>' : ""}
      <time>${formatDate(workOrder.updatedAt)}</time>
    </button>`;
}

function renderWorkspace(workOrder, feedback) {
  const presentation = visibleStatus(workOrder, state.workOrders);
  const stages = state.draftStages ?? workOrder.plan?.stages ?? null;
  const canEditPlan = state.draftStages !== null;
  const highlights = completedGoalHighlights(workOrder);
  const currentState = workOrder.importContext?.status === "ready" && !workOrder.plan
    ? workOrder.importContext.currentState || workOrder.currentSummary
    : workOrder.currentSummary;
  const nextAction = workOrder.importContext?.status === "ready" && !workOrder.plan
    ? workOrder.importContext.nextAction || homeNextStep(workOrder, presentation)
    : homeNextStep(workOrder, presentation);
  const canEditImportedGoal = Boolean(
    workOrder.importContext &&
    !isImportOnlyGoal(workOrder) &&
    !workOrder.plan &&
    !workOrder.runStatus &&
    ["draft", "ready"].includes(workOrder.status),
  );
  return `
    <section class="workspace-content">
      <button class="mobile-back-button" id="back-to-all-goals" type="button">‹ 全部目标</button>
      <header class="workspace-heading goal-workbench-heading">
        <div class="goal-workbench-title">
          <div class="status-line">
            <span class="status-pill ${presentation.status}">${visibleStatusLabels[presentation.status]}</span>
            ${presentation.reason === visibleStatusLabels[presentation.status]
              ? ""
              : `<span>${escapeHtml(presentation.reason)}</span>`}
          </div>
          <h1>${escapeHtml(workOrder.title)}</h1>
          ${canEditImportedGoal
            ? `<label class="goal-statement-editor"><span>一句话目标</span><textarea id="workbench-goal-input" rows="2" maxlength="500">${escapeHtml(workOrder.goal)}</textarea></label>`
            : `<p class="goal-statement">${escapeHtml(workOrder.goal)}</p>`}
          <dl class="goal-snapshot-facts">
            <div><dt>当前</dt><dd>${escapeHtml(currentState)}</dd></div>
            <div><dt>下一步</dt><dd>${escapeHtml(nextAction)}</dd></div>
          </dl>
          ${highlights.length
            ? `<div class="goal-completed-highlights"><span>已完成</span><ul>${highlights.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>`
            : ""}
        </div>
        <button class="secondary-button goal-context-button" id="open-goal-context" type="button">目标信息</button>
      </header>
      <div class="primary-action-slot">${renderContextAction(workOrder)}</div>
      ${renderPrimaryWorkSurface(workOrder, stages, canEditPlan, feedback)}
      <p class="inline-feedback" id="execution-feedback" role="status"></p>
      <p class="inline-feedback" id="result-feedback" role="status"></p>
    </section>`;
}

function renderPrimaryWorkSurface(workOrder, stages, canEditPlan, feedback) {
  const presentation = visibleStatus(workOrder, state.workOrders);
  const activeView = state.primaryView ?? defaultGoalWorkbenchView(presentation.status);
  const tabs = [
    ["progress", "进展"],
    ["conversation", "对话"],
    ["result", "成果"],
  ];
  let content;
  if (activeView === "conversation") {
    content = renderConversationPanel(workOrder) || '<section class="workbench-empty"><p>还没有需要确认的对话。</p></section>';
  } else if (activeView === "result") {
    content = workOrder.result
      ? renderResultPanel(workOrder)
      : renderImportedResultPanel(workOrder) || '<section class="workbench-empty"><p>目标完成后，产物与验证结果会显示在这里。</p></section>';
  } else {
    content = isImportOnlyGoal(workOrder) || (workOrder.importContext && !stages && !canEditPlan)
      ? renderImportedHistorySurface(workOrder, feedback)
      : renderProgressSurface(workOrder, stages, canEditPlan, feedback);
  }
  return `
    <section class="primary-work-surface goal-workbench-surface">
      <div class="main-surface-tabs" role="tablist" aria-label="目标工作台">
        ${tabs.map(([id, label]) => `<button type="button" data-primary-view="${id}" role="tab" aria-selected="${activeView === id}" class="${activeView === id ? "active" : ""}">${label}</button>`).join("")}
      </div>
      ${content}
    </section>`;
}

function renderProgressSurface(workOrder, stages, canEditPlan, feedback) {
  return `
    <section class="map-panel workbench-tab-panel">
      <div class="primary-surface-heading">
        <div class="section-heading">
          <div>
            <p class="overline">进展</p>
            <h2>${stages ? (canEditPlan ? "编辑执行计划" : "执行节点") : "准备执行计划"}</h2>
          </div>
          <div class="map-heading-actions">
            ${workOrder.plan && !canEditPlan ? renderMapViewControls(workOrder) : ""}
            ${workOrder.plan ? `<span class="subtle-label">版本 ${workOrder.plan.version}</span>` : ""}
          </div>
        </div>
      </div>
        ${workOrder.revisionNote ? `<aside class="notice"><strong>补充要求</strong><p>${escapeHtml(workOrder.revisionNote)}</p></aside>` : ""}
        ${renderPlanArea(workOrder, stages, canEditPlan)}
        ${renderProgressSecondaryActions(workOrder)}
        <p class="inline-feedback" id="plan-feedback" role="status">${escapeHtml(feedback)}</p>
    </section>`;
}

function renderImportedHistorySurface(workOrder, feedback) {
  const context = workOrder.importContext ?? {
    status: "failed",
    summary: null,
    currentState: null,
    historicalStages: [],
    error: "来源会话尚未整理。",
  };
  const ready = context.status === "ready";
  const pending = context.status === "pending";
  const updateAvailable = state.sourceStatus?.hasUpdates;
  return `
    <section class="map-panel workbench-tab-panel import-history-surface">
      <div class="primary-surface-heading">
        <div class="section-heading">
          <div><p class="overline">进展</p><h2>${ready ? "历史进展" : "尚未整理"}</h2></div>
          <span class="subtle-label">${workOrder.sourceSessions.length} 个来源</span>
        </div>
      </div>
      ${updateAvailable ? '<aside class="notice import-update-notice"><strong>来源会话有新内容</strong><p>重新整理后会更新摘要和历史节点。</p></aside>' : ""}
      ${ready
        ? `${renderHistoricalProgress(context.historicalStages, workOrder)}
           ${context.historicalStages.length ? "" : '<p class="muted">没有可确认的历史节点。</p>'}`
        : pending
          ? '<div class="plan-empty"><p>历史正在后台整理，完成后会自动更新。</p></div>'
          : `<div class="plan-empty"><p>${escapeHtml(context.error || "历史整理失败，可以重试。")}</p></div>`}
      <div class="import-history-actions">
        ${ready ? '<button class="secondary-button" data-reorganize-sessions type="button">重新整理</button>' : ""}
        ${context.status === "failed" ? '<button class="text-button danger-text" data-delete-imported-goal type="button">删除目标</button>' : ""}
      </div>
      <p class="inline-feedback" id="plan-feedback" role="status">${escapeHtml(feedback)}</p>
    </section>`;
}

function importedStageStatusLabel(status) {
  return {
    completed: "已完成",
    in_progress: "进行到这里",
    unknown: "状态未确认",
  }[status] ?? "历史节点";
}

function renderRecoveryPanel(workOrder) {
  if (workOrder.status !== "interrupted") return "";
  const checkpoints = currentPlanCheckpoints(workOrder);
  const latestCheckpoint = checkpoints.at(-1);
  const latestStageCheckpoint = checkpoints.filter((checkpoint) => checkpoint.kind === "stage").at(-1);
  const completedStageIds = new Set(
    checkpoints
      .filter((checkpoint) => checkpoint.kind === "stage" && checkpoint.stageId)
      .map((checkpoint) => checkpoint.stageId),
  );
  const finalStage = workOrder.plan?.stages.at(-1);
  const currentStage = latestStageCheckpoint?.stageId === finalStage?.id
    ? finalStage
    : workOrder.plan?.stages.find((stage) => !completedStageIds.has(stage.id));
  return `
    <section class="recovery-panel">
      <div class="section-heading compact">
        <div><p class="overline">执行中断</p><h2>现场已保留</h2></div>
        <span class="status-pill response">需响应</span>
      </div>
      <dl class="recovery-facts">
        <div><dt>最近完成节点</dt><dd>${escapeHtml(latestStageCheckpoint?.stageOutcome || "还没有完成节点")}</dd></div>
        <div><dt>当前节点</dt><dd>${escapeHtml(currentStage?.outcome || "等待继续处理")}</dd></div>
        <div><dt>当前现场</dt><dd><code>${escapeHtml(shortPath(workOrder.worktreePath || workOrder.workspace?.path || "未找到"))}</code><pre>${escapeHtml(workOrder.recoverySite?.statusShort || "现场变化保留在当前工作空间")}</pre></dd></div>
        <div><dt>中断原因</dt><dd>${escapeHtml(workOrder.lastError || workOrder.currentSummary)}</dd></div>
      </dl>
      <p class="recovery-note">${latestCheckpoint
        ? latestCheckpoint.kind === "stage"
          ? "可以保留当前修改继续，也可以回到最近完成节点后重新执行当前节点。"
          : "可以保留当前修改继续，也可以回到本轮起始位置重新执行。"
        : "当前没有可用的完整恢复位置，只能继续当前现场。"}</p>
    </section>`;
}

function currentPlanCheckpoints(workOrder) {
  const planVersion = workOrder.plan?.version;
  return (workOrder.checkpoints ?? []).filter(
    (checkpoint) => checkpoint.planVersion === planVersion,
  );
}

function renderPlanArea(workOrder, stages, canEditPlan) {
  if (workOrder.pendingClarification && !stages) {
    return '<div class="plan-empty"><p>回答关键问题后继续生成计划。</p></div>';
  }
  if (!stages) {
    return `
      <div class="plan-empty">
        <p>计划生成后会在这里显示，你也可以直接手动填写。</p>
        <button class="secondary-button" id="manual-plan" type="button">手动填写计划</button>
      </div>`;
  }
  if (canEditPlan) return renderPlanForm(stages);
  return renderExecutionMap(workOrder, stages);
}

function renderConversationPanel(workOrder) {
  if (!workOrder.plan && !workOrder.pendingClarification && !workOrder.conversation?.length) {
    return "";
  }
  const pending = workOrder.pendingClarification;
  const stages = workOrder.plan?.stages ?? [];
  const stage = stages[Math.min(state.selectedStageIndex, Math.max(0, stages.length - 1))];
  const editable = !workOrder.runStatus && ["draft", "ready"].includes(workOrder.status);
  const messages = visibleGoalConversation(workOrder.conversation);
  return `
    <section class="conversation-panel" aria-labelledby="conversation-heading">
      <div class="section-heading compact conversation-heading">
        <div><p class="overline">对话</p><h2 id="conversation-heading">${pending ? "确认关键信息" : "补充目标"}</h2></div>
        <span class="subtle-label">${pending ? "待回答" : stage ? "当前节点" : "目标"}</span>
      </div>
      <div class="conversation-thread" aria-live="polite">
        ${messages.length
          ? messages.map((message) => `
              <article class="conversation-message ${message.role}">
                <span>${message.role === "user" ? "你" : "Teamline"}${message.stageId ? ` · ${escapeHtml(stageLabel(workOrder, message.stageId))}` : ""}</span>
                <p>${escapeHtml(message.content)}</p>
                ${message.kind === "decision" ? `<small>${message.requiresPlanConfirmation ? "计划已更新，需重新确认" : "已添加到节点"}</small>` : ""}
              </article>`).join("")
          : '<p class="conversation-empty">还没有补充内容。</p>'}
      </div>
      ${editable ? `
        <form id="conversation-form" class="conversation-form">
          <label><span>${pending ? "你的回答" : `补充${stage ? `“${escapeHtml(stage.outcome)}”` : "目标"}`}</span><textarea name="message" rows="3" required placeholder="${pending ? "直接回答上面的问题" : "写下需要补充或调整的内容"}"></textarea></label>
          <div class="conversation-actions">
            ${pending
              ? '<button class="primary-button" type="submit" data-conversation-mode="reply">提交回答</button>'
              : stage
                ? '<button class="primary-button" type="submit" data-conversation-mode="supplement">补充当前节点</button><button class="secondary-button" type="submit" data-conversation-mode="replan">更新目标或计划</button>'
                : '<button class="secondary-button" type="submit" data-conversation-mode="replan">更新目标</button>'}
          </div>
          <p class="inline-feedback" id="conversation-feedback" role="status"></p>
        </form>` : ""}
    </section>`;
}

function stageLabel(workOrder, stageId) {
  const index = workOrder.plan?.stages.findIndex((stage) => stage.id === stageId) ?? -1;
  return index >= 0 ? `节点 ${index + 1}` : "节点";
}

function renderMapViewControls(workOrder) {
  const canEdit = workOrder.status === "ready" && !workOrder.runStatus;
  const currentIndex = preferredStageIndex(workOrder);
  const canReturnToCurrent =
    !state.followCurrentStage && currentIndex !== state.selectedStageIndex;
  if (!canEdit && !canReturnToCurrent) return "";
  return `
    <div class="map-view-controls" aria-label="执行列表操作">
      ${canReturnToCurrent ? '<button type="button" id="follow-current-stage">回到当前节点</button>' : ""}
      ${canEdit ? '<button type="button" id="edit-plan">编辑计划</button>' : ""}
    </div>`;
}

function renderExecutionMap(workOrder, stages) {
  const stageById = new Map(stages.map((stage, index) => [stage.id, { stage, index }]));
  const singleStage = stages.length === 1;
  const historicalStages = workOrder.importContext?.historicalStages ?? [];
  const timeline = state.progressView === "timeline";
  return `
    <div class="progress-view-switch" role="tablist" aria-label="执行进展展示方式">
      <button type="button" data-progress-view="timeline" role="tab" aria-selected="${timeline}" class="${timeline ? "active" : ""}">时间线</button>
      <button type="button" data-progress-view="map" role="tab" aria-selected="${!timeline}" class="${timeline ? "" : "active"}">节点图</button>
    </div>
    ${historicalStages.length ? renderHistoricalProgress(historicalStages, workOrder) : ""}
    ${historicalStages.length ? '<div class="history-execution-boundary"><span>从这里开始由 Teamline 推进</span></div>' : ""}
    ${timeline
      ? renderExecutionTimeline(workOrder, stages)
      : `<div class="execution-map-graph structured-map" data-map-mode="graph">
          ${stages.map((stage, index) => renderMapNode(workOrder, stage, index, stageById, singleStage)).join("")}
        </div>`}
    ${workOrder.runStatus && stages.every((stage) => stage.status === "planning")
      ? '<p class="map-evidence-note">暂未收到节点进展，计划状态保持不变。</p>'
      : ""}`;
}

function renderMapNode(workOrder, stage, index, stageById, singleStage) {
  const dependencies = (stage.dependsOn ?? [])
    .map((id) => stageById.get(id))
    .filter(Boolean)
    .map(({ stage: dependency, index: dependencyIndex }) => `节点 ${dependencyIndex + 1} · ${dependency.outcome}`);
  const progress = stageProgress(workOrder, stage);
  return `
    <button class="map-node ${singleStage ? "single" : ""} ${state.selectedStageIndex === index ? "selected" : ""}" data-stage-index="${index}" type="button">
      <span class="map-node-topline">
        <span class="stage-index">${index + 1}</span>
        <span class="node-status ${escapeHtml(stage.status)}">${escapeHtml(formatVisibleStatus(stage.status, stage.statusReason))}</span>
      </span>
      <strong>${escapeHtml(stage.outcome)}</strong>
      <small>${escapeHtml(progress.summary)}</small>
      <span class="node-metadata">${escapeHtml(progress.timeLabel)}${progress.artifactCount ? ` · ${progress.artifactCount} 项成果` : ""}</span>
      ${dependencies.length ? `<span class="dependency-label">依赖：${escapeHtml(dependencies.join("；"))}</span>` : ""}
    </button>`;
}

function renderHistoricalMapNode(stage, index) {
  return `
    <article class="map-node historical-node" aria-label="历史推断节点">
      <span class="map-node-topline"><span class="stage-index">H${index + 1}</span><span class="history-badge">历史推断</span></span>
      <strong>${escapeHtml(stage.outcome)}</strong>
      <small>${escapeHtml(stage.summary)}</small>
    </article>`;
}

function renderHistoricalProgress(historicalStages, workOrder) {
  if (!historicalStages.length) return "";
  const timeline = state.progressView === "timeline";
  return `
    <details class="historical-progress">
      <summary>导入前历史 · ${historicalStages.length} 个节点</summary>
      ${timeline
        ? `<div class="execution-timeline historical-timeline">${renderHistoricalTimelineItems(historicalStages)}</div>`
        : `<div class="execution-map-graph structured-map historical-map">${historicalStages.map((stage, index) => renderHistoricalMapNode(stage, index)).join("")}</div>`}
      ${workOrder.importContext?.summary ? `<p class="historical-summary">${escapeHtml(workOrder.importContext.summary)}</p>` : ""}
    </details>`;
}

function renderHistoricalTimelineItems(historicalStages) {
  return historicalStages.map((stage, index) => `
    <article class="timeline-item historical">
      <span class="timeline-marker"></span>
      <div class="timeline-card">
        <div class="timeline-heading"><span class="history-badge">历史推断</span><span>历史节点 ${index + 1}</span></div>
        <strong>${escapeHtml(stage.outcome)}</strong>
        <p>${escapeHtml(stage.summary)}</p>
      </div>
    </article>`).join("");
}

function renderExecutionTimeline(workOrder, stages) {
  return `
    <div class="execution-timeline">
      ${stages.map((stage, index) => renderTimelineStage(workOrder, stage, index)).join("")}
      ${renderUnscopedReports(workOrder)}
    </div>`;
}

function renderTimelineStage(workOrder, stage, index) {
  const progress = stageProgress(workOrder, stage);
  const reports = state.events.filter(
    (event) => event.stageId === stage.id && event.category === "report",
  );
  return `
    <button class="timeline-item ${state.selectedStageIndex === index ? "selected" : ""}" data-stage-index="${index}" type="button">
      <span class="timeline-marker ${escapeHtml(stage.status)}"></span>
      <span class="timeline-card">
        <span class="timeline-heading"><span>节点 ${index + 1}</span><span class="node-status ${escapeHtml(stage.status)}">${escapeHtml(formatVisibleStatus(stage.status, stage.statusReason))}</span></span>
        <strong>${escapeHtml(stage.outcome)}</strong>
        <span class="timeline-summary">${escapeHtml(progress.summary)}</span>
        ${reports.map((event) => `<span class="timeline-report ${eventReportKind(event) === "suggest_stage" ? "suggestion" : ""}">${eventReportKind(event) === "suggest_stage" ? "建议新增节点 · " : ""}${escapeHtml(event.message)}</span>`).join("")}
        <span class="node-metadata">${escapeHtml(progress.timeLabel)}${progress.artifactCount ? ` · ${progress.artifactCount} 项成果` : ""}</span>
      </span>
    </button>`;
}

function stageProgress(workOrder, stage) {
  const events = state.events.filter((event) => event.stageId === stage.id);
  const visible = events.filter((event) => ["lifecycle", "message", "report"].includes(event.category));
  const latest = visible.at(-1);
  const startedAt = events.find((event) => event.category === "lifecycle")?.createdAt ?? null;
  const finishedAt = [...events].reverse().find(
    (event) => event.category === "lifecycle" && /(验证通过|确认完成|标记完成)/.test(event.message),
  )?.createdAt ?? stage.externalResult?.completedAt ?? null;
  const directArtifacts = (stage.artifacts ?? []).length;
  const completionSummary = completionSummaryForStage(workOrder, stage);
  return {
    summary: latest?.message || completionSummary || stage.statusReason || stage.scope,
    timeLabel: stageTimeLabel(startedAt, finishedAt),
    artifactCount: directArtifacts + localArtifactReferences(completionSummary).length,
    startedAt,
    updatedAt: latest?.createdAt ?? finishedAt ?? null,
  };
}

function stageTimeLabel(startedAt, finishedAt) {
  if (!startedAt && !finishedAt) return "尚未开始";
  if (!startedAt) return `完成于 ${formatDate(finishedAt)}`;
  if (!finishedAt) return `开始于 ${formatDate(startedAt)}`;
  return `${formatDate(startedAt)} — ${formatDate(finishedAt)}`;
}

function eventReportKind(event) {
  if (event.category !== "report" || !event.detail) return null;
  try {
    return JSON.parse(event.detail).reportKind ?? null;
  } catch {
    return null;
  }
}

function renderUnscopedReports(workOrder) {
  return state.events
    .filter((event) => event.category === "report" && !event.stageId)
    .map((event) => `
      <article class="timeline-item report">
        <span class="timeline-marker"></span>
        <div class="timeline-card"><span class="timeline-heading">${eventReportKind(event) === "suggest_stage" ? "建议新增节点" : "运行提示"}</span><strong>${escapeHtml(event.message)}</strong><small>${escapeHtml(formatDate(event.createdAt))}</small></div>
      </article>`)
    .join("");
}

function renderTechnicalActivity(workOrder) {
  const stage = workOrder.plan?.stages?.[state.selectedStageIndex];
  const events = state.events.filter(
    (event) =>
      (event.category === "tool" || event.category === "log") &&
      (stage ? event.stageId === stage.id : !event.stageId),
  );
  if (!events.length) return "";
  return `
    <details class="technical-activity">
      <summary>${stage ? `节点 ${state.selectedStageIndex + 1} · ` : ""}完整工具与日志 <span>${events.length}</span></summary>
      <div class="technical-event-list">
        ${events.map((event) => `
          <article><div><time>${escapeHtml(formatDate(event.createdAt))}</time><strong>${escapeHtml(event.message)}</strong></div>${event.detail ? `<pre>${escapeHtml(event.detail)}</pre>` : ""}</article>`).join("")}
      </div>
    </details>`;
}

function renderPlanForm(stages) {
  return `
    <form id="plan-form" class="plan-form">
      ${stages
        .map(
          (stage, index) => `
            <article class="plan-stage" data-plan-stage>
              <div class="plan-stage-heading">
                <strong>节点 ${index + 1}</strong>
                ${stages.length > 1 ? `<button type="button" data-remove-stage="${index}">移除</button>` : ""}
              </div>
              <input type="hidden" name="id" value="${escapeHtml(stage.id ?? "")}" />
              <label><span>目标结果</span><textarea name="outcome" rows="2" required>${escapeHtml(stage.outcome ?? "")}</textarea></label>
              <label><span>预计影响范围</span><textarea name="scope" rows="2" required>${escapeHtml(stage.scope ?? "")}</textarea></label>
              <label><span>验证方式</span><textarea name="verification" rows="2" required>${escapeHtml(stage.verification ?? "")}</textarea></label>
              <label><span>执行方式</span>
                <select name="executionMethod" data-execution-method>
                  <option value="codex" ${stage.executionMethod !== "external" ? "selected" : ""}>AI 执行</option>
                  <option value="external" ${stage.executionMethod === "external" ? "selected" : ""}>外部工作</option>
                </select>
              </label>
              ${stage.executionMethod === "external"
                ? ""
                : `<label><span>自动验证命令 <em>可选</em></span><input name="verificationCommand" value="${escapeHtml(stage.verificationCommand ?? "")}" placeholder="例如：bun test" /></label>`}
              <label><span>依赖节点 <em>可多选</em></span>
                <select name="dependsOn" multiple size="${Math.min(3, Math.max(2, stages.length - 1))}">
                  ${stages
                    .filter((candidate) => candidate.id !== stage.id)
                    .map((candidate) => {
                      const actualIndex = stages.indexOf(candidate);
                      return `<option value="${escapeHtml(candidate.id)}" ${(stage.dependsOn ?? []).includes(candidate.id) ? "selected" : ""}>节点 ${actualIndex + 1} · ${escapeHtml(candidate.outcome || "未命名")}</option>`;
                    })
                    .join("")}
                </select>
              </label>
              <div class="plan-stage-metadata">
                <span>工作空间：${escapeHtml(workspaceLabel(stage.workspace))}</span>
              </div>
            </article>`,
        )
        .join("")}
      <div class="plan-form-actions">
        <button class="secondary-button" id="add-stage" type="button">增加节点</button>
        <button class="primary-button" id="save-plan" type="submit">保存计划</button>
      </div>
    </form>`;
}

function renderRunPanel(workOrder) {
  if (!workOrder.runStatus) return "";
  return `
    <section class="run-panel">
      <div class="section-heading compact">
        <div><p class="overline">运行记录</p><h2>${escapeHtml(runStatusLabel(workOrder.runStatus))}</h2></div>
        <span class="subtle-label">第 ${workOrder.runNumber} 次运行</span>
      </div>
      <dl class="fact-grid">
        <div><dt>累计运行</dt><dd>${formatDuration(workOrder.runtimeMs)}</dd></div>
        <div><dt>本轮上限</dt><dd>${formatRunLimit(workOrder.maxRunMinutes)}</dd></div>
        <div><dt>当前执行会话</dt><dd>${escapeHtml(workOrder.currentSessionId ?? workOrder.sessionId ?? "等待 Codex 返回")}</dd></div>
        <div><dt>${workOrder.workspace?.kind === "directory" ? "工作区类型" : "分支"}</dt><dd>${escapeHtml(workOrder.workspace?.kind === "directory" ? "普通文件夹" : workOrder.executionBranch ?? "正在准备")}</dd></div>
      </dl>
      <div class="event-list">
        ${state.events.length
          ? state.events
              .slice()
              .reverse()
              .map(
                (event) => `<article><time>${formatDate(event.createdAt)}</time><p>${escapeHtml(event.message)}</p></article>`,
              )
              .join("")
          : "<p class=\"muted\">正在等待第一条进展。</p>"}
      </div>
    </section>`;
}

function renderResultPanel(workOrder) {
  if (!workOrder.result) return "";
  const historical = workOrder.result.planVersion !== workOrder.plan?.version;
  const resultData = collectResultViewData(workOrder, historical);
  const resultState = historical
    ? "历史成果"
    : workOrder.status === "delivered"
      ? "已确认完成"
      : workOrder.status === "review"
        ? "待确认"
        : "本轮结果";
  return `
    <section class="result-panel">
      <div class="section-heading compact">
        <div><p class="overline">成果</p><h2>实际成果</h2></div>
        <span class="result-state ${workOrder.status === "delivered" && !historical ? "completed" : ""}">${resultState}</span>
      </div>
      <p class="result-version">计划版本 ${workOrder.result.planVersion}${historical ? " · 这是上一轮结果" : ""}</p>
      <section class="result-section">
        <h3>完成摘要</h3>
        <div class="result-summary-list">
          ${resultData.summaries.length
            ? resultData.summaries.map((item) => `<article class="result-summary-card"><strong>${escapeHtml(item.stage)}</strong><p>${escapeHtml(item.summary)}</p></article>`).join("")
            : `<p class="result-empty">${escapeHtml(workOrder.currentSummary || "本轮已经结束。")}</p>`}
        </div>
      </section>
      <section class="result-section">
        <h3>产物</h3>
        ${workOrder.workspace?.kind === "directory" ? '<p class="result-artifact-note">本轮新建或修改的文件，最多显示 100 项。</p>' : ""}
        <div class="result-artifact-grid">
          ${resultData.artifacts.length
            ? resultData.artifacts.map((reference) => renderResultArtifactCard(reference)).join("")
            : '<p class="result-empty">没有识别到单独的产物引用，请在工作空间中查看本轮变化。</p>'}
        </div>
      </section>
      <section class="result-section">
        <h3>验证结果</h3>
        <div class="verification-list">
        ${workOrder.result.verifications
          .map(
            (verification) => `
              <article class="result-card verification-${verification.status}">
                <div><strong>${escapeHtml(verification.stageOutcome)}</strong><span>${verificationLabel(verification.status)}</span></div>
                <code>${escapeHtml(verification.command || "未配置自动验证命令")}</code>
                <pre>${escapeHtml(verification.output)}</pre>
              </article>`,
          )
          .join("") || '<p class="result-empty">没有自动验证结果，请人工确认本轮成果。</p>'}
        </div>
      </section>
      ${resultData.incomplete.length ? `
        <section class="result-section result-incomplete">
          <h3>仍需处理</h3>
          <ul>${resultData.incomplete.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
        </section>` : ""}
      ${workOrder.status === "review" ? `
        <details class="result-revision">
          <summary>还需要调整</summary>
          <form id="revision-form">
            <label><span>补充要求</span><textarea name="revisionNote" rows="3" required placeholder="说明还需要调整什么"></textarea></label>
            <button class="secondary-button" id="revise-work-order" type="submit">生成后续计划</button>
          </form>
        </details>` : ""}
      <details class="result-technical-details">
        <summary>工作区变化</summary>
        ${workOrder.workspace?.kind === "directory" ? "<p>普通文件夹不提供 Git 变化记录，请直接检查当前目录。</p>" : ""}
        <pre>${escapeHtml(workOrder.result.git.diffStat || "没有已记录的差异统计")}</pre>
        <pre>${escapeHtml(workOrder.result.git.statusShort || "工作区没有未提交变化")}</pre>
      </details>
    </section>`;
}

function renderImportedResultPanel(workOrder) {
  const context = workOrder.importContext;
  if (context?.status !== "ready") return "";
  const artifacts = context.artifacts ?? [];
  const highlights = completedGoalHighlights(workOrder);
  return `
    <section class="result-panel workbench-tab-panel imported-result-panel">
      <div class="section-heading compact">
        <div><p class="overline">来源成果</p><h2>已整理内容</h2></div>
        <span class="result-state">导入历史</span>
      </div>
      ${highlights.length
        ? `<section class="result-section"><h3>已完成</h3><ul class="result-highlight-list">${highlights.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>`
        : ""}
      <section class="result-section">
        <h3>产物</h3>
        <div class="result-artifact-grid">
          ${artifacts.length
            ? artifacts.map((reference) => renderResultArtifactCard(reference)).join("")
            : '<p class="result-empty">来源会话中没有识别到明确的成果引用。</p>'}
        </div>
      </section>
    </section>`;
}

function renderResultArtifactCard(reference) {
  return `
    <button class="reference-card result-artifact-card" type="button" data-result-artifact="${escapeHtml(reference.location)}">
      <span>${escapeHtml(referenceTypeLabel(reference.type))}</span>
      <strong>${escapeHtml(reference.label)}</strong>
      <code>${escapeHtml(reference.location)}</code>
      <small>查看详情</small>
    </button>`;
}

function collectResultViewData(workOrder, historical) {
  const stages = historical ? [] : workOrder.plan?.stages ?? [];
  const summaries = stages
    .map((stage) => ({ stage: stage.outcome, rawSummary: completionSummaryForStage(workOrder, stage) }))
    .filter((item) => item.rawSummary)
    .map((item) => ({ ...item, summary: cleanCompletionSummary(item.rawSummary) }));
  const artifacts = [];
  const seen = new Set();
  const addArtifact = (reference) => {
    const location = reference.location?.trim();
    if (!location || seen.has(location)) return;
    seen.add(location);
    artifacts.push(reference);
  };
  (workOrder.result.artifacts ?? []).forEach(addArtifact);
  stages.flatMap((stage) => stage.artifacts ?? []).forEach(addArtifact);
  summaries.flatMap((item) => localArtifactReferences(item.rawSummary)).forEach((reference) =>
    addArtifact({ id: `summary:${reference.location}`, type: "file", ...reference }),
  );
  gitArtifactReferences(workOrder).forEach(addArtifact);
  const incomplete = stages
    .filter((stage) => stage.status !== "completed")
    .map((stage) => `${stage.outcome}：${stage.statusReason}`);
  workOrder.result.verifications
    .filter((verification) => verification.status === "failed")
    .forEach((verification) => incomplete.push(`${verification.stageOutcome}：验证未通过`));
  return { summaries, artifacts, incomplete: [...new Set(incomplete)] };
}

function gitArtifactReferences(workOrder) {
  if (workOrder.workspace?.kind !== "git" || !workOrder.result?.git.statusShort) return [];
  const root = workOrder.worktreePath || workOrder.workspace.path;
  if (!root) return [];
  return gitArtifactPaths(workOrder.result.git.statusShort)
    .map((path, index) => ({
      id: `git-result:${index}:${path}`,
      type: "file",
      label: path.split("/").at(-1) || path,
      location: `${root.replace(/\/$/, "")}/${path}`,
    }));
}

function renderContext(workOrder) {
  const selection = state.inspector.selection;
  if (!selection || selection.type === "goal") return renderGoalContext(workOrder);
  if (selection.type === "artifact") return renderArtifactContext(workOrder, selection.id);

  const stages = state.draftStages ?? workOrder.plan?.stages ?? [];
  const selectedIndex = stages.findIndex((stage) => stage.id === selection.id);
  const stage = stages[selectedIndex];
  if (!stage) return renderUnavailableContext();
  state.selectedStageIndex = selectedIndex;
  return `
    <section class="context-content">
      <div class="context-heading">
        <div><p class="overline">节点 ${selectedIndex + 1}</p><h2>${escapeHtml(stage.outcome)}</h2></div>
        ${renderContextCloseButton()}
      </div>
      ${renderContextTabs()}
      ${renderContextTabContent(workOrder, stage)}
      <div class="context-section">${renderTechnicalActivity(workOrder) || '<p class="muted">这个节点还没有工具调用或技术日志。</p>'}</div>
    </section>`;
}

function renderGoalContext(workOrder) {
  return `
    <section class="context-content">
      <div class="context-heading">
        <div><p class="overline">目标</p><h2>补充信息</h2></div>
        ${renderContextCloseButton()}
      </div>
      ${renderGoalMaterials(workOrder)}
      ${workOrder.importContext ? renderImportedSessionContext(workOrder) : ""}
      ${renderGoalProjectContext(workOrder)}
      ${renderGoalResourceSettings(workOrder)}
    </section>`;
}

function renderGoalMaterials(workOrder) {
  const materials = workOrder.materials ?? [];
  return `
    <details class="context-disclosure" ${materials.length ? "open" : ""}>
      <summary>目标素材 · ${materials.length} 项</summary>
      <div class="reference-list goal-material-list">
        ${materials.length
          ? materials.map((material) => `
              <article class="reference-card">
                <span>${escapeHtml(projectMaterialKindLabel(material.kind))}</span>
                <strong>${escapeHtml(material.value)}</strong>
              </article>`).join("")
          : '<p class="muted">这个目标还没有单独添加素材。</p>'}
      </div>
    </details>`;
}

function renderArtifactContext(workOrder, artifactId) {
  const historical = workOrder.result?.planVersion !== workOrder.plan?.version;
  const artifacts = workOrder.result
    ? collectResultViewData(workOrder, historical).artifacts
    : workOrder.importContext?.artifacts ?? [];
  const reference = artifacts.find((artifact) => artifact.location === artifactId);
  if (!reference) return renderUnavailableContext();
  const canOpen = canOpenResultArtifact(workOrder, reference);
  return `
    <section class="context-content">
      <div class="context-heading">
        <div><p class="overline">成果</p><h2>${escapeHtml(reference.label)}</h2></div>
        ${renderContextCloseButton()}
      </div>
      <dl class="context-list artifact-context-list">
        <div><dt>类型</dt><dd>${escapeHtml(referenceTypeLabel(reference.type))}</dd></div>
        <div><dt>来源</dt><dd>${escapeHtml(artifactSourceLabel(workOrder, reference))}</dd></div>
        <div><dt>位置</dt><dd><code>${escapeHtml(reference.location)}</code></dd></div>
      </dl>
      ${canOpen
        ? `<div class="artifact-actions context-section"><button class="secondary-button" type="button" data-open-result-artifact="${escapeHtml(reference.location)}">打开文件</button><button type="button" data-reveal-result-artifact="${escapeHtml(reference.location)}">打开所在位置</button></div>`
        : '<p class="context-summary context-section">成果保留在原位置，当前无法直接从 Teamline 打开。</p>'}
    </section>`;
}

function canOpenResultArtifact(workOrder, reference) {
  return (workOrder.workspace?.kind === "directory" ||
      (workOrder.workspace?.kind === "git" && Boolean(workOrder.worktreePath))) &&
    reference.type === "file" &&
    (workOrder.result?.artifacts ?? []).some(
      (artifact) => artifact.type === "file" && artifact.location === reference.location,
    );
}

function artifactSourceLabel(workOrder, reference) {
  const stage = workOrder.plan?.stages?.find((candidate) =>
    candidate.artifacts?.some((artifact) => artifact.location === reference.location),
  );
  if (stage) return `执行节点 · ${stage.outcome}`;
  if (workOrder.importContext?.artifacts?.some((artifact) => artifact.location === reference.location)) {
    return "来源会话";
  }
  return "目标成果";
}

function renderUnavailableContext() {
  return `
    <section class="context-content context-empty">
      <div class="context-heading"><div><p class="overline">补充信息</p><h2>内容已更新</h2></div>${renderContextCloseButton()}</div>
      <p>这个对象已经不在当前目标中，请重新选择。</p>
    </section>`;
}

function renderContextCloseButton() {
  return '<button class="icon-button context-close-button" id="close-context-inspector" type="button" aria-label="关闭上下文检查栏">×</button>';
}

function renderGoalResourceSettings(workOrder) {
  if (isImportOnlyGoal(workOrder)) return "";
  const resourceEditable = workOrder.status !== "delivered";
  const runLimitEditable = workOrder.status === "ready" && workOrder.runStatus === null;
  const plan = workOrder.resourcePlan;
  const summary = `${resourcePriorityLabel(plan.priority)} · ${resourcePaceLabel(plan.pace)}`;
  const autoRunCopy = plan.runWhenQuotaAvailable
    ? plan.autoRunReason || "额度满足时自动开始下一轮"
    : "当前不会自动运行";
  return `
    <details class="context-disclosure goal-resource-settings">
      <summary>资源设置 · ${escapeHtml(summary)}</summary>
      <form id="goal-resource-form">
        <label><span>优先级</span><select name="priority" ${resourceEditable ? "" : "disabled"}>${resourceOptions([
          ["high", "优先推进"],
          ["normal", "正常推进"],
          ["background", "后台推进"],
        ], plan.priority)}</select></label>
        <label><span>推进方式</span><select name="pace" ${resourceEditable ? "" : "disabled"}>${resourceOptions([
          ["fast", "尽快完成"],
          ["balanced", "均匀推进"],
          ["saving", "节省额度"],
        ], plan.pace)}</select></label>
        <label><span>单轮最长运行</span><select name="maxRunMinutes" ${runLimitEditable ? "" : "disabled"}>
          ${[30, 60, 120, 240]
            .map((minutes) => `<option value="${minutes}" ${workOrder.maxRunMinutes === minutes ? "selected" : ""}>${formatRunLimit(minutes)}</option>`)
            .join("")}
        </select></label>
        <label class="auto-run-toggle compact">
          <input type="checkbox" name="runWhenQuotaAvailable" ${plan.runWhenQuotaAvailable ? "checked" : ""} ${resourceEditable ? "" : "disabled"} />
          <span><strong>额度充足时运行</strong><small>${escapeHtml(autoRunCopy)}</small></span>
        </label>
        <label class="auto-run-toggle compact">
          <input type="checkbox" name="paidApiFallbackEnabled" ${plan.paidApiFallbackEnabled ? "checked" : ""} ${resourceEditable ? "" : "disabled"} />
          <span><strong>订阅额度不足时使用付费 API</strong><small>需要全局月度预算和当前目标限额</small></span>
        </label>
        <label><span>当前目标付费限额（美元）</span><input name="paidApiLimitUsd" type="number" min="0.01" step="0.01" value="${plan.paidApiLimitUsd ?? ""}" placeholder="未设置" ${resourceEditable ? "" : "disabled"} /></label>
        ${runLimitEditable ? "" : '<p class="muted">单轮上限只能在待运行时修改。</p>'}
        ${resourceEditable
          ? '<button class="secondary-button full-button" type="submit">保存资源设置</button>'
          : '<p class="muted">已完成目标保留当时的资源设置。</p>'}
      </form>
    </details>`;
}

function resourcePriorityLabel(priority) {
  return { high: "优先推进", normal: "正常推进", background: "后台推进" }[priority] || "正常推进";
}

function resourcePaceLabel(pace) {
  return { fast: "尽快完成", balanced: "均匀推进", saving: "节省额度" }[pace] || "均匀推进";
}

function renderImportedSessionContext(workOrder) {
  const context = workOrder.importContext;
  const status = state.sourceStatus;
  const currentSessionId = workOrder.currentSessionId ?? workOrder.sessionId;
  return `
    <details class="context-disclosure source-session-context" open>
      <summary>来源会话 · ${workOrder.sourceSessions.length} 个</summary>
      ${status?.hasUpdates ? '<p class="source-update-message">来源会话有新内容，可以重新整理。</p>' : ""}
      ${context.error ? `<p class="form-error">${escapeHtml(context.error)}</p>` : ""}
      <div class="source-session-list">
        ${workOrder.sourceSessions.map((source, index) => renderSessionEntry(source, `来源 ${index + 1}`)).join("")}
        ${currentSessionId ? renderSessionEntry({
          kind: "codex_session",
          id: currentSessionId,
          openInCodex: workOrder.sourceSessions.some(
            (source) => source.id === currentSessionId && source.openInCodex === true,
          ),
        }, "当前执行会话") : ""}
      </div>
      ${context.status === "pending"
        ? '<p class="muted">历史正在后台整理。</p>'
        : `<button class="secondary-button full-button" data-reorganize-sessions type="button">${context.status === "ready" ? "重新整理来源" : "重试整理"}</button>`}
      ${context.status === "failed" ? '<button class="text-button danger-text" data-delete-imported-goal type="button">删除目标</button>' : ""}
      <p class="inline-feedback" id="session-entry-feedback" role="status"></p>
    </details>`;
}

function renderSessionEntry(source, label) {
  const codexSource = source.kind === "codex_session";
  const canOpenInCodex = codexSource && source.openInCodex === true;
  return `
    <article class="source-session-entry">
      <span>${escapeHtml(label)} · ${sourceKindLabel(source.kind)}</span>
      <code>${escapeHtml(source.id)}</code>
      <div>
        ${canOpenInCodex ? `<button class="secondary-button" type="button" data-open-codex-session="${escapeHtml(source.id)}">在 Codex 打开</button>` : `<span class="source-import-only">${codexSource ? "可在 Teamline 中查看和继续" : "仅导入与状态整理"}</span>`}
        <button class="text-button" type="button" data-copy-session-id="${escapeHtml(source.id)}">复制 ID</button>
        ${canOpenInCodex ? `<button class="text-button" type="button" data-copy-session-cli="${escapeHtml(source.id)}">复制 CLI 命令</button>` : ""}
      </div>
    </article>`;
}

function sourceKindLabel(kind) {
  return kind === "claude_code_session" ? "Claude Code" : "Codex";
}

function isImportOnlyGoal(workOrder) {
  return workOrder.sourceSessions?.[0]?.kind === "claude_code_session";
}

function shortSessionId(id) {
  return String(id).slice(0, 8);
}

function renderGoalProjectContext(workOrder) {
  const selection = state.goalProjectMaterials;
  const displayProjectId = selection?.projectId ?? workOrder.projectId;
  const currentProject = state.projects.find((project) => project.id === displayProjectId);
  const active = ["running", "stopping", "verifying"].includes(workOrder.runStatus);
  const savedProjectMaterialIds = workOrder.materials
    .map((material) => material.projectMaterialId)
    .filter(Boolean);
  const selectedIds = new Set(
    displayProjectId === workOrder.projectId
      ? savedProjectMaterialIds
      : [],
  );
  const recommendedIds = new Set(
    workOrder.projectMaterialSelectionConfirmed ? [] : selection?.recommendedIds ?? [],
  );
  const materials = selection?.projectId === displayProjectId ? selection.materials : [];
  return `
    <details class="context-disclosure goal-project-context">
      <summary>项目与素材${currentProject ? ` · ${escapeHtml(currentProject.name)}` : ""}</summary>
      <form id="goal-project-form">
        <label><span>所属项目</span><select name="projectId" ${active ? "disabled" : ""}>${projectOptions(displayProjectId)}</select></label>
        <fieldset ${active ? "disabled" : ""}>
          <legend>${isImportOnlyGoal(workOrder) ? "关联的项目素材" : "发送给 Codex 的项目素材"}</legend>
          ${materials.length
            ? materials.map((material) => `<label class="project-material-choice"><input type="checkbox" name="projectMaterialId" value="${escapeHtml(material.id)}" ${selectedIds.has(material.id) ? "checked" : ""} /><span><strong>${escapeHtml(material.label)}</strong><small>${escapeHtml(projectMaterialKindLabel(material.kind))}${recommendedIds.has(material.id) ? " · 建议" : ""}</small></span></label>`).join("")
            : `<p class="muted">${displayProjectId ? "这个项目还没有可选素材。" : "选择项目后可以使用其中的素材。"}</p>`}
        </fieldset>
        ${active ? '<p class="muted">目标运行时暂不能调整素材。</p>' : '<button class="secondary-button full-button" type="submit">保存项目与素材</button>'}
        <p class="inline-feedback" id="goal-project-feedback" role="status"></p>
      </form>
    </details>`;
}

function renderContextSupport(workOrder) {
  const conversation = renderConversationPanel(workOrder);
  const recovery = renderRecoveryPanel(workOrder);
  const run = renderRunPanel(workOrder);
  if (!conversation && !recovery && !run) return "";
  return `
    <div class="context-support">
      ${conversation ? `<details class="context-disclosure" ${workOrder.pendingClarification ? "open" : ""}><summary>目标对话</summary>${conversation}</details>` : ""}
      ${recovery ? `<details class="context-disclosure" open><summary>中断现场</summary>${recovery}</details>` : ""}
      ${run ? `<details class="context-disclosure"><summary>运行记录</summary>${run}</details>` : ""}
    </div>`;
}

function renderContextTabs() {
  const tabs = [
    ["artifacts", "成果与验证"],
    ["details", "详情"],
    ["materials", "素材"],
  ];
  return `
    <div class="context-tabs" role="tablist" aria-label="节点详情">
      ${tabs
        .map(
          ([id, label]) => `<button type="button" role="tab" data-context-tab="${id}" aria-selected="${state.contextTab === id}" class="${state.contextTab === id ? "active" : ""}">${label}</button>`,
        )
        .join("")}
    </div>`;
}

function renderContextTabContent(workOrder, stage) {
  if (state.contextTab === "materials") {
    const references = stage.materials ?? [];
    return `
      <div class="context-stage context-tab-panel" role="tabpanel">
        <h3>节点素材</h3>
        <div class="reference-list">
          ${references.length
            ? references.map(renderReference).join("")
            : '<p class="muted">这个节点还没有单独添加素材。</p>'}
          <article class="reference-card">
            <span>工作空间</span>
            <strong>${escapeHtml(workspaceLabel(stage.workspace))}</strong>
            <code>${escapeHtml(resolvedWorkspacePath(workOrder, stage))}</code>
          </article>
        </div>
      </div>`;
  }

  if (state.contextTab === "artifacts") {
    const references = stage.artifacts ?? [];
    const verification = workOrder.result?.verifications?.find(
      (candidate) => candidate.stageId === stage.id,
    );
    const completionSummary = completionSummaryForStage(workOrder, stage);
    const localArtifacts = localArtifactReferences(completionSummary);
    return `
      <div class="context-stage context-tab-panel" role="tabpanel">
        <h3>节点成果</h3>
        <div class="reference-list">
          ${completionSummary
            ? `<article class="reference-card completion-reference"><span>Codex 完成摘要</span><p>${escapeHtml(cleanCompletionSummary(completionSummary))}</p></article>`
            : ""}
          ${localArtifacts
            .map(
              (reference) => `<article class="reference-card"><span>本地成果</span><strong>${escapeHtml(reference.label)}</strong><code>${escapeHtml(reference.location)}</code></article>`,
            )
            .join("")}
          ${stage.externalResult?.conclusion
            ? `<article class="reference-card"><span>完成结论</span><strong>${escapeHtml(stage.externalResult.conclusion)}</strong><code>${formatDate(stage.externalResult.completedAt)}</code></article>`
            : ""}
          ${references.length ? references.map(renderReference).join("") : ""}
          ${verification
            ? `<article class="reference-card"><span>验证结果</span><strong>${escapeHtml(verificationLabel(verification.status))}</strong><code>${escapeHtml(verification.command || "人工检查")}</code></article>`
            : references.length || stage.externalResult?.conclusion ? "" : '<p class="muted">执行后，成果引用与验证结果会集中显示在这里。</p>'}
        </div>
      </div>`;
  }

  const progress = stageProgress(workOrder, stage);
  return `
    <div class="context-stage context-tab-panel" role="tabpanel">
      <h3>${escapeHtml(stage.outcome)}</h3>
      <p class="node-status-line"><span class="status-dot ${escapeHtml(stage.status)}"></span>${escapeHtml(formatVisibleStatus(stage.status, stage.statusReason))}</p>
      <dl class="context-list">
        <div><dt>影响范围</dt><dd>${escapeHtml(stage.scope)}</dd></div>
        <div><dt>执行方式</dt><dd>${escapeHtml(executionMethodLabel(stage.executionMethod))}</dd></div>
        <div><dt>${stage.executionMethod === "external" ? "成果位置" : "工作空间"}</dt><dd><code>${escapeHtml(stage.executionMethod === "external" ? "保留在原位置" : resolvedWorkspacePath(workOrder, stage))}</code></dd></div>
        <div><dt>验证方式</dt><dd>${escapeHtml(stage.verification)}</dd></div>
        ${stage.executionMethod === "external" ? "" : `<div><dt>验证命令</dt><dd><code>${escapeHtml(stage.verificationCommand || "未配置")}</code></dd></div>`}
        <div><dt>依赖</dt><dd>${stage.dependsOn?.length ? `${stage.dependsOn.length} 个前置节点` : "无，可独立开始"}</dd></div>
        <div><dt>补充上下文</dt><dd>${stage.contextNotes?.length ? stage.contextNotes.map(escapeHtml).join("；") : "暂无"}</dd></div>
        <div><dt>开始时间</dt><dd>${progress.startedAt ? escapeHtml(formatDate(progress.startedAt)) : "尚未开始"}</dd></div>
        <div><dt>最近更新</dt><dd>${progress.updatedAt ? escapeHtml(formatDate(progress.updatedAt)) : "暂无运行记录"}</dd></div>
        <div><dt>当前摘要</dt><dd>${escapeHtml(progress.summary)}</dd></div>
        <div><dt>成果</dt><dd>${progress.artifactCount ? `${progress.artifactCount} 项，可在“成果”中查看` : "暂无"}</dd></div>
        <div><dt>累计运行</dt><dd>${formatDuration(workOrder.runtimeMs)}</dd></div>
      </dl>
      <details class="node-source-details">
        <summary>来源会话</summary>
        <dl class="context-list">
          <div><dt>来源会话</dt><dd>${escapeHtml(
            (workOrder.sourceSessions ?? (workOrder.importSource ? [workOrder.importSource] : []))
              .map((source) => `${sourceKindLabel(source.kind)} · ${source.id}`)
              .join("、") || "无",
          )}</dd></div>
          <div><dt>当前执行会话</dt><dd>${escapeHtml(workOrder.currentSessionId ?? workOrder.sessionId ?? "未建立")}</dd></div>
        </dl>
      </details>
    </div>`;
}

function completionSummaryForStage(workOrder, stage) {
  if (stage.executionMethod !== "codex" || !workOrder.result) return null;
  const currentRunEvents = state.events.filter(
    (event) =>
      event.type === "progress" &&
      event.stageId === stage.id,
  );
  return currentRunEvents
    .slice()
    .reverse()
    .map((event) => event.message.trim())
    .find(
      (message) =>
        message &&
        !message.startsWith("Codex 进展：") &&
        message !== "Codex 已完成本轮处理" &&
        /(已完成|完成并验证|新增|创建|修改|结果)/.test(message),
    ) ?? null;
}

function localArtifactReferences(summary) {
  if (!summary) return [];
  const references = [];
  const pattern = /\[([^\]\n]+)\]\((\/[^)\n]+)\)/g;
  for (const match of summary.matchAll(pattern)) {
    if (references.some((reference) => reference.location === match[2])) continue;
    references.push({ label: match[1], location: match[2] });
    if (references.length === 5) break;
  }
  return references;
}

function cleanCompletionSummary(summary) {
  return summary.replace(/\[([^\]\n]+)\]\((\/[^)\n]+)\)/g, "$1").trim();
}

function renderReference(reference, workOrder) {
  const canOpen = workOrder ? canOpenResultArtifact(workOrder, reference) : false;
  return `<article class="reference-card"><span>${escapeHtml(referenceTypeLabel(reference.type))}</span><strong>${escapeHtml(reference.label)}</strong><code>${escapeHtml(reference.location)}</code>${canOpen ? `<div class="artifact-actions"><button class="secondary-button" type="button" data-open-result-artifact="${escapeHtml(reference.location)}">打开文件</button><button type="button" data-reveal-result-artifact="${escapeHtml(reference.location)}">打开所在位置</button></div>` : ""}</article>`;
}

function renderContextAction(workOrder) {
  if (isImportOnlyGoal(workOrder)) {
    return '<section class="context-action completed-action"><strong>仅导入与状态整理</strong><p>当前版本不会从 Claude Code 来源目标生成计划或开始执行。</p></section>';
  }
  if (state.draftStages !== null) {
    return '<section class="context-action"><p class="overline">正在编辑计划</p><strong>先保存计划再继续</strong><p>执行和成果登记会使用保存后的节点。</p></section>';
  }
  if (workOrder.pendingClarification) {
    return '<section class="context-action"><p class="overline">下一步</p><button class="primary-button" id="show-conversation" type="button">回答问题</button></section>';
  }
  if (workOrder.importContext?.status === "pending") {
    return '<section class="context-action completed-action"><p class="overline">正在整理</p><strong>历史整理完成后再生成计划</strong></section>';
  }
  if (workOrder.importContext?.status === "failed") {
    return '<section class="context-action"><p class="overline">下一步</p><button class="primary-button" data-reorganize-sessions type="button">重试整理</button></section>';
  }
  if (!workOrder.plan && !workOrder.runStatus) {
    return `<section class="context-action"><p class="overline">下一步</p><button class="primary-button" id="generate-plan" type="button">${workOrder.importContext ? "生成后续计划" : "生成执行计划"}</button></section>`;
  }
  if (
    workOrder.status === "ready" &&
    !workOrder.runStatus &&
    workOrder.plan?.confirmationRequired
  ) {
    return '<section class="context-action"><p class="overline">下一步</p><button class="primary-button" id="review-plan" type="button">检查并确认计划</button></section>';
  }
  const stage = workOrder.plan?.stages?.[preferredStageIndex(workOrder)];
  const needsStageConfirmation = workOrder.plan?.stages?.some(
    (candidate) =>
      candidate.executionMethod === "codex" &&
      candidate.status === "response" &&
      workOrder.result?.verifications?.some(
        (verification) =>
          verification.stageId === candidate.id && verification.status === "not_configured",
      ),
  );
  if (
    ["ready", "interrupted"].includes(workOrder.status) &&
    !workOrder.runStatus &&
    stage?.executionMethod === "external"
  ) {
    if (stage.status === "completed") {
      return '<section class="context-action completed-action"><strong>这个外部节点已完成。</strong><p>成果仍保留在原位置；选择后续节点继续。</p></section>';
    }
    if (!stageDependenciesCompleted(workOrder, stage)) {
      return '<section class="context-action"><p class="overline">下一步</p><strong>等待前置节点完成</strong><p>依赖完成后，这里会显示外部成果登记入口。</p></section>';
    }
    return `
      <section class="context-action">
        <p class="overline">下一步</p>
        <strong>在外部完成后登记结果</strong>
        <p>Teamline 只保存结论和原始位置，不复制或自动核验正文。</p>
        <form id="external-completion-form">
          <label><span>简短结论 <em>可选</em></span><textarea name="conclusion" rows="3" placeholder="说明完成了什么"></textarea></label>
          <label><span>成果引用 <em>可选</em></span>
            <select name="referenceType">
              <option value="">不添加引用</option>
              <option value="file">本地文件</option>
              <option value="link">外部链接</option>
            </select>
          </label>
          <label><span>原始位置</span><input name="referenceLocation" placeholder="本地文件路径或 https:// 链接" autocomplete="off" /></label>
          <button class="primary-button full-button" id="complete-external-stage" type="submit">标记节点完成</button>
        </form>
      </section>`;
  }
  if (
    needsStageConfirmation &&
    (workOrder.status === "ready" ||
      workOrder.status === "interrupted" ||
      workOrder.status === "review")
  ) {
    return `
      <section class="context-action">
        <p class="overline">下一步</p>
        <strong>确认当前 AI 节点结果</strong>
        <p>这个节点没有自动核验命令。确认后，Teamline 才会把该 AI 节点记为完成。</p>
        <button class="primary-button full-button" id="confirm-stage-results" type="button">确认节点结果并继续</button>
      </section>`;
  }
  if (
    workOrder.status === "ready" &&
    !workOrder.runStatus &&
    stage?.executionMethod === "codex" &&
    !stageDependenciesCompleted(workOrder, stage)
  ) {
    return '<section class="context-action"><p class="overline">下一步</p><strong>等待前置节点完成</strong><p>依赖完成后可以启动 Codex。</p></section>';
  }
  const waitingExternalStage = workOrder.plan?.stages?.find(
    (candidate) => candidate.executionMethod === "external" && candidate.status === "response",
  );
  if (
    ["ready", "interrupted"].includes(workOrder.status) &&
    !workOrder.runStatus &&
    waitingExternalStage
  ) {
    return `<section class="context-action"><p class="overline">下一步</p><strong>先完成外部节点</strong><p>请先处理“${escapeHtml(waitingExternalStage.outcome)}”，登记结果后再启动 Codex。</p></section>`;
  }
  if (workOrder.status === "ready" && !workOrder.runStatus) {
    const presentation = visibleStatus(workOrder, state.workOrders);
    const capacityBlocked =
      presentation.status === "queued" &&
      presentation.reason === "等待可用并发位置";
    const suggestedPath = workOrder.materials?.find(
      (material) => material.kind === "folder" || material.kind === "repository",
    )?.value ?? "";
    return `
      <section class="context-action">
        <p class="overline">下一步</p>
        ${workOrder.workspace
          ? `<p class="workspace-choice"><strong>${workOrder.workspace.kind === "git" ? "Git 仓库" : "普通文件夹"}</strong><code>${escapeHtml(shortPath(workOrder.workspace.path))}</code></p>
             <button class="primary-button full-button" id="start-work-order" type="button" ${capacityBlocked ? "disabled" : ""}>${capacityBlocked ? "等待可用并发位置" : "确认计划并启动"}</button>`
          : `<form id="workspace-form">
               <label><span>执行前选择本地文件夹</span><input name="workspacePath" value="${escapeHtml(suggestedPath)}" placeholder="/Users/you/Projects/workspace" autocomplete="off" required /></label>
               <p>Git 仓库会使用独立执行工作区；普通文件夹会直接使用，不提供 Git 隔离、版本记录或回滚。</p>
               <button class="primary-button full-button" id="select-workspace-and-start" type="submit" ${capacityBlocked ? "disabled" : ""}>${capacityBlocked ? "等待可用并发位置" : "选择文件夹并启动"}</button>
             </form>`}
      </section>`;
  }
  if (workOrder.runStatus === "running") {
    return '<section class="context-action"><p class="overline">正在推进</p><button class="primary-button" id="focus-current-stage" type="button">查看当前节点</button></section>';
  }
  if (workOrder.runStatus === "stopping" || workOrder.runStatus === "verifying") {
    return `<section class="context-action"><p>${escapeHtml(workOrder.currentSummary)}</p><button class="secondary-button full-button" type="button" disabled>处理中…</button></section>`;
  }
  if (workOrder.status === "interrupted") {
    return `
      <section class="context-action recovery-actions">
        <button class="primary-button full-button" id="continue-work-order" type="button">继续当前现场</button>
      </section>`;
  }
  if (workOrder.status === "review") {
    return `
      <section class="context-action">
        <button class="primary-button full-button" id="deliver-work-order" type="button">确认完成</button>
      </section>`;
  }
  if (workOrder.status === "delivered") {
    return '<section class="context-action completed-action"><button class="secondary-button" id="show-results" type="button">查看成果</button></section>';
  }
  return "";
}

function renderProgressSecondaryActions(workOrder) {
  if (workOrder.runStatus === "running") {
    return '<div class="progress-secondary-actions"><button class="text-button" id="interrupt-work-order" type="button">中断运行</button></div>';
  }
  if (workOrder.status !== "interrupted") return "";
  const latestCheckpoint = currentPlanCheckpoints(workOrder).at(-1);
  const canReexecute = workOrder.workspace?.kind === "git" && latestCheckpoint;
  return `<div class="progress-secondary-actions">${canReexecute
    ? `<button class="secondary-button" id="reexecute-work-order" type="button">${latestCheckpoint.kind === "stage" ? "从最近节点重新执行" : "从起始位置重新执行"}</button>`
    : '<p class="muted">普通文件夹暂不提供检查点回退。</p>'}</div>`;
}

function bindRenderedEvents() {
  document.querySelector("#back-to-all-goals")?.addEventListener("click", openAllGoals);
  document.querySelector("#open-goal-context")?.addEventListener("click", () => {
    openContextInspector({ type: "goal", id: state.selected.id });
    renderConsole();
  });
  document.querySelector("#close-context-inspector")?.addEventListener("click", dismissContextInspector);
  document.querySelectorAll("[data-primary-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.primaryView = button.dataset.primaryView;
      renderConsole();
    });
  });
  document.querySelector("#show-conversation")?.addEventListener("click", () => {
    state.primaryView = "conversation";
    renderConsole();
  });
  document.querySelector("#show-results")?.addEventListener("click", () => {
    state.primaryView = "result";
    renderConsole();
  });
  document.querySelector("#focus-current-stage")?.addEventListener("click", () => {
    state.primaryView = "progress";
    state.followCurrentStage = true;
    state.selectedStageIndex = preferredStageIndex(state.selected);
    const stage = state.selected.plan?.stages?.[state.selectedStageIndex];
    if (stage) openContextInspector({ type: "stage", id: stage.id });
    renderConsole();
  });
  document.querySelector("#review-plan")?.addEventListener("click", () => {
    state.primaryView = "progress";
    state.draftStages = state.selected.plan?.stages.map((stage) => ({ ...stage })) ?? [];
    renderConsole();
  });
  document.querySelectorAll("[data-result-artifact]").forEach((button) => {
    button.addEventListener("click", () => {
      openContextInspector({ type: "artifact", id: button.dataset.resultArtifact });
      renderConsole();
    });
  });
  document.querySelectorAll("[data-open-result-artifact], [data-reveal-result-artifact]").forEach((button) => {
    button.addEventListener("click", async () => {
      const reveal = button.hasAttribute("data-reveal-result-artifact");
      const path = reveal
        ? button.dataset.revealResultArtifact
        : button.dataset.openResultArtifact;
      const idleLabel = reveal ? "打开所在位置" : "打开文件";
      setBusy(button, "正在打开…");
      try {
        await requestJson(`/api/work-orders/${encodedSelectedId()}/artifacts/open`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, reveal }),
        });
        resetBusy(button, idleLabel);
        setFeedback("result-feedback", reveal ? "已在 Finder 中显示成果。" : "已打开成果文件。", false);
      } catch (error) {
        resetBusy(button, idleLabel);
        setFeedback("result-feedback", messageFrom(error, "无法打开这个成果。"), true);
      }
    });
  });
  document.querySelectorAll("[data-progress-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.progressView = button.dataset.progressView;
      renderConsole();
    });
  });
  document.querySelectorAll("[data-stage-index]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedStageIndex = Number(button.dataset.stageIndex);
      state.followCurrentStage = false;
      const stage = state.selected?.plan?.stages?.[state.selectedStageIndex];
      if (stage) openContextInspector({ type: "stage", id: stage.id });
      renderConsole();
    });
  });

  document.querySelector("#follow-current-stage")?.addEventListener("click", () => {
    state.followCurrentStage = true;
    state.selectedStageIndex = preferredStageIndex(state.selected);
    renderConsole();
  });

  document.querySelector("#edit-plan")?.addEventListener("click", () => {
    state.draftStages = state.selected.plan.stages.map((stage) => ({
      ...stage,
      dependsOn: [...(stage.dependsOn ?? [])],
      materials: [...(stage.materials ?? [])],
      artifacts: [...(stage.artifacts ?? [])],
    }));
    renderConsole();
  });

  document.querySelectorAll("[data-context-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.contextTab = button.dataset.contextTab;
      renderConsole();
    });
  });
  document.querySelector("#goal-project-form [name=projectId]")?.addEventListener("change", async (event) => {
    await refreshGoalProjectMaterials(state.selected, event.currentTarget.value);
    renderConsole();
  });
  document.querySelector("#goal-project-form")?.addEventListener("submit", saveGoalProjectContext);

  document.querySelectorAll("[data-reorganize-sessions]").forEach((button) => {
    button.addEventListener("click", async () => {
      setBusy(button, "正在整理…");
      setFeedback("plan-feedback", "Codex 正在重新读取来源并整理历史。", false);
      try {
        const result = await requestJson(
          `/api/work-orders/${encodedSelectedId()}/import-context/organize`,
          { method: "POST" },
        );
        await acceptWorkOrderResult(
          result.workOrder,
          result.outcome === "ready" ? "来源会话已整理。" : "整理没有完成，可以稍后重试。",
        );
      } catch (error) {
        resetBusy(button, state.selected.importContext?.status === "ready" ? "重新整理来源" : "重试整理");
        setFeedback("plan-feedback", messageFrom(error, "无法整理来源会话"), true);
      }
    });
  });

  document.querySelectorAll("[data-delete-imported-goal]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!window.confirm("删除这个整理失败的目标？来源会话不会被删除。")) return;
      setBusy(button, "正在删除…");
      try {
        await requestJson(`/api/work-orders/${encodedSelectedId()}`, { method: "DELETE" });
        state.selected = null;
        history.pushState({}, "", "/");
        await refreshConsole();
      } catch (error) {
        resetBusy(button, "删除目标");
        setFeedback("plan-feedback", messageFrom(error, "无法删除这个目标"), true);
      }
    });
  });

  document.querySelectorAll("[data-open-codex-session]").forEach((button) => {
    button.addEventListener("click", () => {
      const sessionId = button.dataset.openCodexSession;
      window.location.href = `codex://threads/${encodeURIComponent(sessionId)}`;
      setTimeout(() => {
        setFeedback("session-entry-feedback", "如果 Codex 没有打开，可以复制 CLI 命令恢复会话。", false);
      }, 700);
    });
  });
  document.querySelectorAll("[data-copy-session-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      await copySessionText(button.dataset.copySessionId, "会话 ID 已复制");
    });
  });
  document.querySelectorAll("[data-copy-session-cli]").forEach((button) => {
    button.addEventListener("click", async () => {
      const sessionId = button.dataset.copySessionCli;
      await copySessionText(`codex resume ${shellQuote(sessionId)}`, "CLI 命令已复制");
    });
  });

  document.querySelector("#generate-plan")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    setBusy(button, "正在生成…");
    setFeedback("plan-feedback", "生成计划通常需要 30–90 秒，Codex 正在整理目标和素材。", false);
    try {
      const goal = document.querySelector("#workbench-goal-input")?.value;
      const result = await requestJson(`/api/work-orders/${encodedSelectedId()}/plan/generate`, {
        method: "POST",
        ...(goal !== undefined
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ goal }) }
          : {}),
      });
      state.draftStages = null;
      await acceptWorkOrderResult(
        result.workOrder,
        result.outcome === "clarification" ? "还需要你确认一项关键信息。" : "计划已经生成，你可以继续编辑。",
      );
    } catch (error) {
      resetBusy(button, state.selected?.importContext ? "生成后续计划" : "生成执行计划");
      setFeedback("plan-feedback", messageFrom(error, "生成计划失败，你仍然可以手动填写。"), true);
    }
  });

  document.querySelector("#manual-plan")?.addEventListener("click", () => {
    state.draftStages = [emptyStage()];
    renderConsole();
  });

  document.querySelector("#conversation-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter;
    const mode = button?.dataset.conversationMode ?? "reply";
    const message = new FormData(event.currentTarget).get("message");
    const stage = state.selected?.plan?.stages?.[state.selectedStageIndex];
    setBusy(button, mode === "supplement" ? "正在保存…" : "正在整理…");
    setFeedback(
      "conversation-feedback",
      mode === "supplement" ? "正在写入当前节点。" : "正在整理目标、计划和资源决定。",
      false,
    );
    try {
      const result = await requestJson(`/api/work-orders/${encodedSelectedId()}/conversation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, mode, stageId: stage?.id }),
      });
      state.draftStages = null;
      await acceptWorkOrderResult(
        result.workOrder,
        result.outcome === "clarification"
          ? "还需要确认一项关键信息。"
          : mode === "supplement"
            ? "补充内容已归入当前节点。"
            : "计划已更新，请重新确认。",
      );
    } catch (error) {
      resetBusy(button, mode === "supplement" ? "补充当前节点" : mode === "replan" ? "更新目标或计划" : "提交回答");
      setFeedback("conversation-feedback", messageFrom(error, "无法保存这次更新，请重试。"), true);
    }
  });

  document.querySelector("#plan-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const stages = readPlanStages();
    const button = document.querySelector("#save-plan");
    setBusy(button, "正在保存…");
    try {
      const result = await requestJson(`/api/work-orders/${encodedSelectedId()}/plan`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stages }),
      });
      state.draftStages = null;
      await acceptWorkOrderResult(result.workOrder, "计划已保存，等待确认并启动。");
    } catch (error) {
      resetBusy(button, "保存计划");
      setFeedback("plan-feedback", messageFrom(error, "保存计划失败"), true);
    }
  });

  document.querySelector("#add-stage")?.addEventListener("click", () => {
    state.draftStages = [...readPlanStages(), emptyStage()];
    renderConsole();
  });
  document.querySelectorAll("[data-remove-stage]").forEach((button) => {
    button.addEventListener("click", () => {
      const stages = readPlanStages();
      stages.splice(Number(button.dataset.removeStage), 1);
      state.draftStages = stages.length ? stages : [emptyStage()];
      renderConsole();
    });
  });
  document.querySelectorAll("[data-execution-method]").forEach((select) => {
    select.addEventListener("change", () => {
      state.draftStages = readPlanStages();
      renderConsole();
    });
  });

  document.querySelector("#goal-resource-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = event.submitter;
    const data = new FormData(form);
    setBusy(button, "正在保存…");
    try {
      const result = await requestJson(`/api/work-orders/${encodedSelectedId()}/resource-settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          priority: data.get("priority"),
          pace: data.get("pace"),
          runWhenQuotaAvailable: data.get("runWhenQuotaAvailable") === "on",
          paidApiFallbackEnabled: data.get("paidApiFallbackEnabled") === "on",
          paidApiLimitUsd: data.get("paidApiLimitUsd") ? Number(data.get("paidApiLimitUsd")) : null,
          ...(data.has("maxRunMinutes")
            ? { maxRunMinutes: Number(data.get("maxRunMinutes")) }
            : {}),
        }),
      });
      resetBusy(button, "保存资源设置");
      await acceptWorkOrderResult(result.workOrder, "资源设置已保存。");
    } catch (error) {
      resetBusy(button, "保存资源设置");
      setFeedback("execution-feedback", messageFrom(error, "无法保存资源设置。"), true);
    }
  });

  document.querySelector("#external-completion-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const stage = state.selected?.plan?.stages?.[state.selectedStageIndex];
    if (!stage) return;
    const data = new FormData(event.currentTarget);
    const conclusion = String(data.get("conclusion") ?? "");
    const referenceType = String(data.get("referenceType") ?? "");
    const referenceLocation = String(data.get("referenceLocation") ?? "");
    const button = document.querySelector("#complete-external-stage");
    setBusy(button, "正在保存…");
    try {
      const result = await requestJson(
        `/api/work-orders/${encodedSelectedId()}/plan-stages/${encodeURIComponent(stage.id)}/complete-external`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conclusion,
            ...(referenceType
              ? {
                  reference: {
                    type: referenceType,
                    location: referenceLocation,
                  },
                }
              : {}),
          }),
        },
      );
      resetBusy(button, "标记节点完成");
      await acceptWorkOrderResult(result.workOrder, "外部节点已完成，后续节点可以继续。");
    } catch (error) {
      resetBusy(button, "标记节点完成");
      setFeedback("execution-feedback", messageFrom(error, "无法保存外部成果。"), true);
    }
  });

  bindAction(
    "#confirm-stage-results",
    "正在确认…",
    "确认节点结果并继续",
    "confirm-stage-results",
    "正在确认当前 AI 节点结果。",
  );

  bindAction("#start-work-order", "正在准备…", "确认计划并启动", "start", "Teamline 正在创建执行工作区并启动 Codex。");
  bindAction("#interrupt-work-order", "正在停止…", "中断运行", "interrupt", "正在请求 Codex 停止。");
  bindAction("#continue-work-order", "正在继续…", "继续当前现场", "continue", "正在从现有进度继续推进目标。");
  bindAction("#reexecute-work-order", "正在恢复…", "从最近节点重新执行", "reexecute", "正在恢复最近完整位置并启动新的运行。");
  bindAction("#deliver-work-order", "正在确认…", "确认完成", "deliver", "");

  document.querySelector("#workspace-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = document.querySelector("#select-workspace-and-start");
    const workspacePath = new FormData(event.currentTarget).get("workspacePath");
    setBusy(button, "正在检查文件夹…");
    setFeedback("execution-feedback", "正在确认本地文件夹。", false);
    try {
      await requestJson(`/api/work-orders/${encodedSelectedId()}/workspace`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: workspacePath }),
      });
      setBusy(button, "正在启动…");
      const result = await requestJson(`/api/work-orders/${encodedSelectedId()}/start`, {
        method: "POST",
      });
      await acceptWorkOrderResult(result.workOrder);
    } catch (error) {
      resetBusy(button, "选择文件夹并启动");
      setFeedback("execution-feedback", messageFrom(error, "无法使用这个文件夹，请重新选择。"), true);
    }
  });

  document.querySelector("#revision-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = document.querySelector("#revise-work-order");
    setBusy(button, "正在生成…");
    setFeedback("result-feedback", "正在根据调整内容生成后续计划，通常需要 30–90 秒。", false);
    try {
      const revisionNote = new FormData(event.currentTarget).get("revisionNote");
      const result = await requestJson(`/api/work-orders/${encodedSelectedId()}/revise`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revisionNote }),
      });
      state.primaryView = "progress";
      await acceptWorkOrderResult(
        result.workOrder,
        result.outcome === "clarification"
          ? "还需要确认一项关键信息。"
          : "后续计划已生成，请检查并确认。",
      );
    } catch (error) {
      resetBusy(button, "生成后续计划");
      setFeedback("result-feedback", messageFrom(error, "无法生成后续计划，请重试。"), true);
    }
  });
}

async function copySessionText(value, successMessage) {
  try {
    await navigator.clipboard.writeText(value);
    setFeedback("session-entry-feedback", successMessage, false);
  } catch {
    setFeedback("session-entry-feedback", "无法访问剪贴板，请手动复制。", true);
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function bindAction(selector, busyLabel, idleLabel, endpoint, pendingMessage) {
  document.querySelector(selector)?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    setBusy(button, busyLabel);
    if (pendingMessage) setFeedback("execution-feedback", pendingMessage, false);
    try {
      const result = await requestJson(`/api/work-orders/${encodedSelectedId()}/${endpoint}`, {
        method: "POST",
      });
      await acceptWorkOrderResult(result.workOrder);
    } catch (error) {
      resetBusy(button, idleLabel);
      setFeedback("execution-feedback", messageFrom(error, `无法${idleLabel}，请重试。`), true);
    }
  });
}

async function acceptWorkOrderResult(workOrder, feedback = "") {
  state.draftStages = null;
  state.selected = workOrder;
  state.inspector = setContextInspectorBusy(state.inspector, false);
  contextElement.setAttribute("aria-busy", "false");
  contextElement.toggleAttribute("inert", false);
  if (workOrder.runStatus === "running") state.followCurrentStage = true;
  await refreshConsole({ polling: true });
  if (feedback) setFeedback("plan-feedback", feedback, false);
}

async function createWorkOrder(event) {
  event.preventDefault();
  formError.textContent = "";
  setBusy(createButton, "正在创建…");
  try {
    const data = new FormData(createForm);
    const { workOrder } = await requestJson("/api/work-orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: data.get("name"),
        description: data.get("description"),
        acceptance: data.get("acceptance"),
        projectId: data.get("projectId") || null,
        projectMaterialIds: readCreateProjectMaterialIds(),
        materials: readMaterials(),
      }),
    });
    closeCreateDialog();
    history.pushState({}, "", `/goals/${encodeURIComponent(workOrder.id)}`);
    state.selected = workOrder;
    state.selectedStageIndex = 0;
    state.followCurrentStage = true;
  state.primaryView = null;
  state.progressView = "timeline";
    state.inspector = clearContextInspector();
    await refreshConsole();
  } catch (error) {
    formError.textContent = messageFrom(error, "创建目标失败");
    resetBusy(createButton, "创建目标");
  }
}

async function openSessionImport() {
  state.sessionSearch = "";
  state.sessionSelectedIds = new Set();
  state.sessionDiscovery = null;
  sessionImportError.textContent = "";
  document.querySelector("#session-search").value = "";
  document.querySelector("#session-import-name").value = "";
  document.querySelector("#session-import-source").value = state.sessionSource;
  populateProjectSelect(document.querySelector("#session-import-project"));
  document.querySelector("#session-candidate-list").innerHTML =
    '<div class="loading-state">正在读取本机会话…</div>';
  document.querySelector("#session-source-message").textContent = "";
  sessionImportDialog.showModal();
  await loadSessionDiscovery();
}

async function loadSessionDiscovery() {
  try {
    state.sessionDiscovery = await requestJson(
      `/api/sessions?source=${encodeURIComponent(state.sessionSource)}`,
    );
    renderSessionCandidates();
    document.querySelector("#session-search").focus();
  } catch (error) {
    sessionImportError.textContent = messageFrom(error, "无法读取本机会话");
  }
}

function closeSessionImport() {
  sessionImportDialog.close();
  sessionImportForm.reset();
  sessionImportError.textContent = "";
}

function renderSessionCandidates() {
  const discovery = state.sessionDiscovery;
  if (!discovery) return;
  document.querySelector("#session-source-message").textContent = discovery.message;
  const query = state.sessionSearch.trim().toLocaleLowerCase();
  const sessions = discovery.sessions.filter((session) =>
    !query || [session.title, session.projectLabel, session.workspacePath, session.id]
      .filter(Boolean)
      .some((value) => value.toLocaleLowerCase().includes(query)),
  );
  const list = document.querySelector("#session-candidate-list");
  if (!sessions.length) {
    list.innerHTML = `<div class="session-empty">${discovery.sessions.length ? "没有匹配的会话" : `没有找到可导入的${discovery.sourceLabel ?? "本机"}会话`}</div>`;
    return;
  }
  list.innerHTML = sessions.map((session) => {
    const unavailable = session.availability === "unavailable";
    const imported = Boolean(session.importedWorkOrderId);
    const disabled = unavailable || imported;
    const stateLabel = imported
      ? "已导入"
      : unavailable
        ? "来源不可用"
        : session.availability === "degraded"
          ? "部分信息不可用"
          : "可导入";
    return `
      <article class="session-candidate ${disabled ? "disabled" : ""}">
        <label class="session-select">
          <input type="checkbox" name="sessionId" value="${escapeHtml(session.id)}" ${state.sessionSelectedIds.has(session.id) ? "checked" : ""} ${disabled ? "disabled" : ""} />
          <span>
            <strong>${escapeHtml(session.title)}</strong>
            <small>${escapeHtml(session.projectLabel)}${state.sessionSource === "claude_code" ? ` · ${escapeHtml(shortSessionId(session.id))}` : ""} · ${formatDate(session.lastActiveAt)}</small>
          </span>
          <em>${stateLabel}</em>
        </label>
        ${session.suggestion ? `<p class="session-suggestion">可能与现有目标“${escapeHtml(session.suggestion.title)}”相关；本次仍会默认创建新目标。</p>` : ""}
        ${session.message ? `<p class="session-warning">${escapeHtml(session.message)}</p>` : ""}
      </article>`;
  }).join("");
  list.querySelectorAll('input[name="sessionId"]').forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.sessionSelectedIds.add(checkbox.value);
      else state.sessionSelectedIds.delete(checkbox.value);
      const nameInput = document.querySelector("#session-import-name");
      if (checkbox.checked && !nameInput.value.trim()) {
        const session = discovery.sessions.find((candidate) => candidate.id === checkbox.value);
        if (session) nameInput.value = session.title;
      }
    });
  });
}

async function importSelectedSessions(event) {
  event.preventDefault();
  sessionImportError.textContent = "";
  if (!state.sessionSelectedIds.size) {
    sessionImportError.textContent = "请选择至少一个会话";
    return;
  }
  const name = String(new FormData(sessionImportForm).get("name") ?? "").trim();
  if (!name) {
    sessionImportError.textContent = "请填写目标名称";
    return;
  }
  const sessionIds = [...state.sessionSelectedIds];
  const button = document.querySelector("#submit-session-import");
  setBusy(button, "正在导入…");
  try {
    const result = await requestJson("/api/sessions/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        source: state.sessionSource,
        projectId: new FormData(sessionImportForm).get("projectId") || null,
        sessionIds,
      }),
    });
    const workOrder = result.workOrder;
    closeSessionImport();
    if (workOrder) {
      history.pushState({}, "", `/goals/${encodeURIComponent(workOrder.id)}`);
      state.selected = workOrder;
      state.selectedStageIndex = 0;
      state.followCurrentStage = true;
      state.primaryView = null;
      state.inspector = clearContextInspector();
    }
    await refreshConsole();
  } catch (error) {
    resetBusy(button, "导入目标");
    sessionImportError.textContent = messageFrom(error, "无法导入会话");
  }
}

async function selectWorkOrder(id) {
  if (!id) return;
  state.draftStages = null;
  if (id !== state.selected?.id) {
    state.selectedStageIndex = 0;
    state.followCurrentStage = true;
    state.contextTab = "artifacts";
    state.primaryView = null;
    state.inspector = clearContextInspector();
    history.pushState({}, "", `/goals/${encodeURIComponent(id)}`);
  }
  try {
    await requestJson("/api/notifications/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workOrderId: id }),
    });
  } finally {
    await refreshConsole();
  }
}

function isResourceView() {
  return window.location.pathname === "/resources";
}

function isProjectsView() {
  return window.location.pathname === "/projects" || /^\/projects\/[^/]+$/.test(window.location.pathname);
}

function isAllGoalsView() {
  return window.location.pathname === "/";
}

function openAllGoals() {
  history.pushState({}, "", "/");
  resetGoalSelection();
  refreshConsole();
}

function closeCreateDialog() {
  createDialog.close();
  createForm.reset();
  document.querySelector("#material-list").innerHTML = "";
  state.createProjectMaterials = null;
  renderCreateProjectMaterials();
  formError.textContent = "";
  resetBusy(createButton, "创建目标");
}

function addMaterialRow(kind = "file", value = "") {
  const row = document.createElement("div");
  row.className = "material-row";
  row.innerHTML = `
    <select aria-label="素材类型">
      ${[
        ["repository", "Git 仓库"],
        ["folder", "文件夹"],
        ["file", "文件"],
        ["image", "图片"],
        ["link", "链接"],
      ].map(([optionValue, label]) => `<option value="${optionValue}" ${kind === optionValue ? "selected" : ""}>${label}</option>`).join("")}
    </select>
    <input value="${escapeHtml(value)}" aria-label="素材路径或链接" placeholder="本地路径或 https:// 链接" autocomplete="off" required />
    <button type="button" class="icon-button" aria-label="移除素材">×</button>`;
  row.querySelector("button").addEventListener("click", () => row.remove());
  document.querySelector("#material-list").append(row);
  row.querySelector("input").focus();
}

function readMaterials() {
  return [...document.querySelectorAll(".material-row")].map((row) => ({
    kind: row.querySelector("select").value,
    value: row.querySelector("input").value,
  }));
}

function renderMaterials(materials = []) {
  if (!materials.length) return "";
  return `
    <div class="context-section">
      <p class="overline">参考素材</p>
      <ul class="material-summary">
        ${materials.map((material) => `<li><span>${materialKindLabel(material.kind)}</span><code>${escapeHtml(shortPath(material.value))}</code></li>`).join("")}
      </ul>
    </div>`;
}

function materialKindLabel(kind) {
  return {
    text: "文本",
    repository: "仓库",
    folder: "文件夹",
    file: "文件",
    image: "图片",
    link: "链接",
  }[kind] ?? "素材";
}

function projectMaterialKindLabel(kind) {
  return {
    text: "文本",
    repository: "仓库",
    folder: "文件夹",
    file: "文件",
    image: "图片",
    link: "链接",
    goal: "目标",
  }[kind] ?? "素材";
}

function projectOptions(selectedId = "") {
  return [
    '<option value="">暂不归入项目</option>',
    ...state.projects.map(
      (project) => `<option value="${escapeHtml(project.id)}" ${project.id === selectedId ? "selected" : ""}>${escapeHtml(project.name)}</option>`,
    ),
  ].join("");
}

function populateProjectSelect(select, selectedId = "") {
  if (!select) return;
  select.innerHTML = projectOptions(selectedId);
}

async function refreshCreateProjectMaterials() {
  const projectId = document.querySelector("#create-project-select")?.value;
  if (!projectId) {
    state.createProjectMaterials = null;
    renderCreateProjectMaterials();
    return;
  }
  const name = createForm.querySelector('[name="name"]').value;
  const description = createForm.querySelector('[name="description"]').value;
  try {
    state.createProjectMaterials = {
      projectId,
      ...(await requestJson(
        `/api/projects/${encodeURIComponent(projectId)}/material-recommendations?name=${encodeURIComponent(name)}&description=${encodeURIComponent(description)}`,
      )),
    };
    renderCreateProjectMaterials();
  } catch (error) {
    state.createProjectMaterials = null;
    formError.textContent = messageFrom(error, "无法读取项目素材");
  }
}

function renderCreateProjectMaterials() {
  const container = document.querySelector("#create-project-materials");
  const list = document.querySelector("#create-project-material-list");
  if (!container || !list) return;
  const selection = state.createProjectMaterials;
  container.hidden = !selection;
  if (!selection) {
    list.innerHTML = "";
    return;
  }
  const recommended = new Set(selection.recommendedIds);
  list.innerHTML = selection.materials.length
    ? selection.materials.map((material) => `<label class="project-material-choice"><input type="checkbox" name="createProjectMaterialId" value="${escapeHtml(material.id)}" ${recommended.has(material.id) ? "checked" : ""} /><span><strong>${escapeHtml(material.label)}</strong><small>${escapeHtml(projectMaterialKindLabel(material.kind))}</small></span></label>`).join("")
    : '<p class="muted">这个项目还没有素材。</p>';
}

function readCreateProjectMaterialIds() {
  return [...document.querySelectorAll('[name="createProjectMaterialId"]:checked')].map(
    (input) => input.value,
  );
}

async function refreshGoalProjectMaterials(workOrder, projectId = workOrder?.projectId) {
  if (!workOrder || !projectId) {
    state.goalProjectMaterials = projectId === "" ? { projectId: "", materials: [], recommendedIds: [] } : null;
    return;
  }
  try {
    state.goalProjectMaterials = {
      projectId,
      ...(await requestJson(
        `/api/projects/${encodeURIComponent(projectId)}/material-recommendations?name=${encodeURIComponent(workOrder.name)}&description=${encodeURIComponent(workOrder.description)}`,
      )),
    };
  } catch {
    state.goalProjectMaterials = { projectId, materials: [], recommendedIds: [] };
  }
}

async function saveGoalProjectContext(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const button = event.submitter;
  setBusy(button, "正在保存…");
  try {
    const { workOrder } = await requestJson(
      `/api/work-orders/${encodedSelectedId()}/project-context`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: data.get("projectId") || null,
          projectMaterialIds: data.getAll("projectMaterialId"),
        }),
      },
    );
    await refreshGoalProjectMaterials(workOrder);
    resetBusy(button, "保存项目与素材");
    await acceptWorkOrderResult(workOrder);
  } catch (error) {
    resetBusy(button, "保存项目与素材");
    setFeedback("goal-project-feedback", messageFrom(error, "无法保存项目与素材"), true);
  }
}

function selectedProjectIdFromPath() {
  const match = window.location.pathname.match(/^\/projects\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function truncateText(value, maxLength) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function visibleStatus(workOrder, allWorkOrders) {
  const presented = allWorkOrders.find((candidate) => candidate.id === workOrder.id);
  if (presented?.userStatus && presented?.statusReason) {
    return { status: presented.userStatus, reason: presented.statusReason };
  }
  return { status: "planning", reason: "正在读取状态" };
}

function formatVisibleStatus(status, reason) {
  const label = visibleStatusLabels[status] ?? "规划中";
  return reason === label ? label : `${label} · ${reason}`;
}

function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  if (isResourceView()) {
    state.refreshTimer = setTimeout(() => refreshConsole({ polling: true }), 30_000);
    return;
  }
  if (
    state.workOrders.some((workOrder) =>
      ["running", "stopping", "verifying"].includes(workOrder.runStatus) ||
      workOrder.importContext?.status === "pending",
    )
  ) {
    state.refreshTimer = setTimeout(() => refreshConsole({ polling: true }), 2_000);
  }
}

function readPlanStages() {
  const sourceStages = state.draftStages ?? state.selected?.plan?.stages ?? [];
  return [...document.querySelectorAll("[data-plan-stage]")].map((stage) => {
    const id = stage.querySelector('[name="id"]').value || crypto.randomUUID();
    const source = sourceStages.find((candidate) => candidate.id === id) ?? {};
    return {
      ...source,
      id,
      outcome: stage.querySelector('[name="outcome"]').value,
      scope: stage.querySelector('[name="scope"]').value,
      verification: stage.querySelector('[name="verification"]').value,
      verificationCommand: stage.querySelector('[name="verificationCommand"]')?.value ?? "",
      dependsOn: [...stage.querySelector('[name="dependsOn"]').selectedOptions].map(
        (option) => option.value,
      ),
      executionMethod: stage.querySelector('[name="executionMethod"]').value,
      workspace:
        stage.querySelector('[name="executionMethod"]').value === "external"
          ? { kind: "external", path: null }
          : source.workspace?.kind === "external"
            ? { kind: state.selected.workspace?.kind ?? "git", path: state.selected.workspace?.path ?? null }
            : source.workspace ?? { kind: "git", path: state.selected.repositoryPath },
      materials: source.materials ?? [],
      artifacts: source.artifacts ?? [],
    };
  });
}

function selectedIdFromPath() {
  const match = window.location.pathname.match(/^\/(?:goals|work-orders)\/([^/]+)$/);
  if (match && window.location.pathname.startsWith("/work-orders/")) {
    history.replaceState(
      {},
      "",
      `/goals/${match[1]}${window.location.search}`,
    );
  }
  return match ? decodeURIComponent(match[1]) : null;
}

function selectedStageFromPath() {
  return new URL(window.location.href).searchParams.get("stage");
}

function preferredStageIndex(workOrder) {
  const stages = workOrder?.plan?.stages ?? [];
  if (!stages.length) return 0;
  const running = stages.findIndex((stage) => stage.status === "running");
  if (running >= 0) return running;
  if (["review", "delivered"].includes(workOrder.status)) return stages.length - 1;
  const response = stages.findIndex((stage) => stage.status === "response");
  if (response >= 0) return response;
  if (workOrder.runStatus === "running") {
    const stageById = new Map(stages.map((stage) => [stage.id, stage]));
    const nextQueued = stages.findIndex(
      (stage) =>
        stage.status === "queued" &&
        stage.dependsOn.every(
          (dependencyId) => stageById.get(dependencyId)?.status === "completed",
        ),
    );
    if (nextQueued >= 0) return nextQueued;
  }
  const planning = stages.findIndex((stage) => stage.status === "planning");
  return planning >= 0 ? planning : Math.max(0, stages.length - 1);
}

function encodedSelectedId() {
  return encodeURIComponent(state.selected.id);
}

function emptyStage() {
  return {
    id: crypto.randomUUID(),
    outcome: "",
    scope: "",
    verification: "",
    verificationCommand: "",
    dependsOn: [],
    executionMethod: "codex",
    workspace: { kind: "git", path: state.selected?.repositoryPath ?? null },
    materials: [],
    artifacts: [],
    status: "planning",
    statusReason: "等待确认并启动",
  };
}

function readTheme() {
  const saved = localStorage.getItem("teamline-theme");
  if (saved === "light" || saved === "dark") return saved;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector("#theme-toggle")?.setAttribute(
    "aria-label",
    theme === "dark" ? "切换到亮色主题" : "切换到深色主题",
  );
}

function setBusy(button, label) {
  if (!button) return;
  if (button.closest("#context-panel")) {
    button.dataset.contextInspectorBusy = "true";
    state.inspector = setContextInspectorBusy(state.inspector, true);
    contextElement.setAttribute("aria-busy", "true");
    contextElement.toggleAttribute("inert", true);
  }
  button.disabled = true;
  button.dataset.busy = "true";
  button.textContent = label;
}

function resetBusy(button, label) {
  if (!button) return;
  if (button.dataset.contextInspectorBusy === "true") {
    delete button.dataset.contextInspectorBusy;
    state.inspector = setContextInspectorBusy(state.inspector, false);
    contextElement.setAttribute("aria-busy", "false");
    contextElement.toggleAttribute("inert", false);
  }
  button.disabled = false;
  delete button.dataset.busy;
  button.textContent = label;
}

function setFeedback(id, message, isError) {
  const element = document.querySelector(`#${id}`);
  if (!element) return;
  element.textContent = message;
  element.classList.toggle("is-error", isError);
}

function runStatusLabel(status) {
  return {
    running: "Codex 运行中",
    stopping: "正在停止 Codex",
    verifying: "正在整理变化并执行验证",
    interrupted: "Codex 已中断",
    completed: "Codex 已结束",
    failed: "执行失败",
  }[status] ?? status;
}

function verificationLabel(status) {
  return { passed: "通过", failed: "失败", not_configured: "未配置" }[status] ?? status;
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  if (minutes > 0) return `${minutes} 分钟`;
  return `${totalSeconds} 秒`;
}

function formatRunLimit(minutes) {
  return minutes < 60 ? `${minutes} 分钟` : `${minutes / 60} 小时`;
}

function formatDate(value) {
  const date = new Date(value);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatRemaining(window) {
  return window ? `${Math.max(0, 100 - window.usedPercent)}% 可用` : "不可用";
}

function formatReset(value) {
  return `重置于 ${formatDate(value)}`;
}

function formatUsage(usage) {
  if (!usage || typeof usage.amount !== "number") return "不可用";
  if (usage.unit === "usd") {
    return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "USD" }).format(usage.amount);
  }
  return `${new Intl.NumberFormat("zh-CN").format(usage.amount)} tokens`;
}

function resourceStatusLabel(status) {
  return {
    available: "额度可读取",
    loading: "正在读取",
    unavailable: "暂时不可用",
    stale: "数据已过期",
    conflict: "数据有冲突",
    error: "读取失败",
    not_connected: "需要连接",
  }[status] || "不可用";
}

function scopeLabel(scope) {
  return { organization: "组织", project: "项目", api_key: "API Key" }[scope] || "账户";
}

function shortPath(path) {
  const parts = String(path).split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}

function executionMethodLabel(method) {
  return method === "external" ? "外部工作" : "AI 执行";
}

function stageDependenciesCompleted(workOrder, stage) {
  const completed = new Set(
    (workOrder.plan?.stages ?? [])
      .filter((candidate) => candidate.status === "completed")
      .map((candidate) => candidate.id),
  );
  return (stage.dependsOn ?? []).every((dependencyId) => completed.has(dependencyId));
}

function workspaceLabel(workspace) {
  if (workspace?.kind === "external") return "成果保留原位置";
  if (!workspace?.path) return "启动前选择";
  return {
    git: "Git 执行工作区",
    directory: "本地文件夹",
    external: "外部工作空间",
  }[workspace?.kind] ?? "Git 执行工作区";
}

function resolvedWorkspacePath(workOrder, stage) {
  if (stage.workspace?.kind === "external") return "成果保留原位置";
  if (stage.workspace?.kind === "git") {
    return (
      workOrder.worktreePath ||
      stage.workspace.path ||
      workOrder.repositoryPath ||
      "启动前选择"
    );
  }
  return stage.workspace?.path || "未配置路径";
}

function referenceTypeLabel(type) {
  return {
    repository: "仓库",
    folder: "文件夹",
    file: "文件",
    image: "图片",
    link: "链接",
  }[type] ?? "素材";
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "请求失败");
  return result;
}

function messageFrom(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
