const visibleStatusLabels = {
  planning: "规划中",
  running: "运行中",
  queued: "待运行",
  response: "需响应",
  review: "待验收",
  completed: "已完成",
};

const state = {
  workOrders: [],
  selected: null,
  selectedStageIndex: 0,
  followCurrentStage: true,
  draftStages: null,
  contextTab: "details",
  events: [],
  executionSettings: { maxConcurrency: 2 },
  resources: null,
  resourceError: "",
  resourceRefreshInFlight: false,
  autoRunCheckRequested: true,
  resourceProgressTimer: null,
  sessionDiscovery: null,
  sessionSearch: "",
  notifications: [],
  unreadNotificationCount: 0,
  notificationSettings: { autoRunStarted: true, autoRunStopped: true },
  nativeNotificationCheckInFlight: false,
  restorePreview: null,
  refreshTimer: null,
  theme: readTheme(),
};

const listElement = document.querySelector("#work-order-list");
const countElement = document.querySelector("#work-order-count");
const workspaceElement = document.querySelector("#work-order-workspace");
const contextElement = document.querySelector("#context-panel");
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
bindShellEvents();
refreshConsole();

function bindShellEvents() {
  document.querySelector("#theme-toggle").addEventListener("click", () => {
    state.theme = state.theme === "dark" ? "light" : "dark";
    localStorage.setItem("teamline-theme", state.theme);
    applyTheme(state.theme);
  });

  document.querySelector("#max-concurrency").addEventListener("change", saveMaxConcurrency);

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

  document.querySelector("#open-create").addEventListener("click", () => {
    createDialog.showModal();
    createDialog.querySelector('[name="name"]').focus();
  });
  document.querySelector("#open-resources").addEventListener("click", () => {
    history.pushState({}, "", "/resources");
    state.draftStages = null;
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
  sessionImportForm.addEventListener("submit", importSelectedSessions);
  document.querySelector("#close-create").addEventListener("click", closeCreateDialog);
  document.querySelector("#cancel-create").addEventListener("click", closeCreateDialog);
  createForm.addEventListener("submit", createWorkOrder);
  document.querySelector("#add-material").addEventListener("click", () => addMaterialRow());
  window.addEventListener("popstate", () => {
    state.draftStages = null;
    refreshConsole();
  });
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
  document.querySelector("#restore-preview").innerHTML = `
    <div class="restore-summary">
      <strong>将恢复 ${preview.summary.total} 个目标</strong>
      <span>${preview.summary.conflicts} 项冲突 · ${preview.summary.needsAttention} 项恢复后需处理</span>
    </div>
    ${preview.settingsConflict
      ? `<label class="restore-conflict-choice settings-choice"><span>本机设置不同</span><select id="restore-settings-resolution"><option value="">请选择</option><option value="keep_existing">保留现有设置</option><option value="use_imported">使用导入设置</option></select></label>`
      : ""}
    <div class="restore-order-list">${rows || '<p class="muted">文件中没有目标。</p>'}</div>
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
    const [consoleState, notificationState] = await Promise.all([
      requestJson("/api/console"),
      requestJson("/api/notifications"),
    ]);
    const { workOrders, executionSettings } = consoleState;
    state.workOrders = workOrders;
    state.executionSettings = executionSettings;
    state.notifications = notificationState.notifications;
    state.unreadNotificationCount = notificationState.unreadCount;
    state.notificationSettings = notificationState.settings;
    renderNotificationShell();
    void showPendingNativeNotifications();
    document.querySelector("#max-concurrency").value = String(
      executionSettings.maxConcurrency,
    );
    void refreshResources({ checkAutoRun });
    state.autoRunCheckRequested = false;
    if (isResourceView()) {
      state.selected = null;
      state.events = [];
      renderConsole();
      scheduleRefresh();
      return;
    }
    const requestedId = selectedIdFromPath();
    const selectedId = requestedId ?? state.selected?.id ?? workOrders[0]?.id ?? null;

    if (selectedId) {
      const { workOrder } = await requestJson(
        `/api/work-orders/${encodeURIComponent(selectedId)}`,
      );
      state.selected = workOrder;
      const requestedStageId = selectedStageFromPath();
      if (requestedStageId) {
        const requestedStageIndex = workOrder.plan?.stages.findIndex(
          (stage) => stage.id === requestedStageId,
        );
        if (requestedStageIndex >= 0) {
          state.selectedStageIndex = requestedStageIndex;
          state.followCurrentStage = false;
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
      state.events = workOrder.runStatus
        ? (await requestJson(`/api/work-orders/${encodeURIComponent(selectedId)}/events`)).events
        : [];
    } else {
      state.selected = null;
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
  document.querySelector("#open-resources")?.classList.toggle("selected", isResourceView());
  if (isResourceView()) {
    workspaceElement.innerHTML = renderResourceWorkspace();
    contextElement.innerHTML = renderResourceContext();
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
    contextElement.innerHTML = `
      <section class="context-empty">
        <p class="overline">详情</p>
        <h2>等待选择</h2>
        <p>新建目标后，这里显示当前节点和下一步操作。</p>
      </section>`;
    document.querySelector("#empty-create")?.addEventListener("click", () => createDialog.showModal());
    return;
  }

  workspaceElement.innerHTML = renderWorkspace(state.selected, feedback);
  contextElement.innerHTML = renderContext(state.selected);
  bindRenderedEvents();
}

function renderWorkOrderList() {
  countElement.textContent = String(state.workOrders.length);
  if (state.workOrders.length === 0) {
    listElement.innerHTML = '<p class="sidebar-empty">暂无目标</p>';
    return;
  }

  const groups = [
    ["response", "需响应"],
    ["review", "待验收"],
    ["running", "运行中"],
    ["planning", "规划中"],
    ["queued", "待运行"],
    ["completed", "已完成"],
  ];
  listElement.innerHTML = groups
    .map(([status, label]) => {
      const orders = state.workOrders.filter(
        (workOrder) => visibleStatus(workOrder, state.workOrders).status === status,
      );
      if (orders.length === 0) return "";
      return `
        <section class="order-group" aria-labelledby="group-${status}">
          <div class="order-group-heading">
            <h2 id="group-${status}">${label}</h2>
            <span>${orders.length}</span>
          </div>
          ${orders.map(renderOrderRow).join("")}
        </section>`;
    })
    .join("");

  document.querySelectorAll("[data-work-order-id]").forEach((button) => {
    button.addEventListener("click", () => selectWorkOrder(button.dataset.workOrderId));
  });
}

function renderResourceSummary() {
  if (!state.resources) {
    resourceSummaryElement.innerHTML = state.resourceError
      ? `<button type="button" data-open-resource-summary><strong>Codex 额度读取失败</strong><span>工作台仍可使用</span></button>`
      : "<span>Codex 额度正在读取…</span>";
    resourceSummaryElement.querySelector("button")?.addEventListener("click", () => {
      history.pushState({}, "", "/resources");
      renderConsole();
    });
    return;
  }
  const { codex, runningCount } = state.resources;
  if (codex.status !== "available") {
    resourceSummaryElement.innerHTML = `
      <button type="button" data-open-resource-summary>
        <strong>Codex ${resourceStatusLabel(codex.status)}</strong><span>${runningCount} 项运行中</span>
      </button>`;
  } else {
    const nextReset = [codex.shortWindow, codex.longWindow]
      .filter(Boolean)
      .sort((left, right) => Date.parse(left.resetsAt) - Date.parse(right.resetsAt))[0];
    resourceSummaryElement.innerHTML = `
      <button type="button" data-open-resource-summary>
        <span>短周期 <strong>${formatRemaining(codex.shortWindow)}</strong></span>
        <span>长期 <strong>${formatRemaining(codex.longWindow)}</strong></span>
        <span>${nextReset ? `最近${formatReset(nextReset.resetsAt)}` : "重置时间不可用"}</span>
        <span>${runningCount} 项运行中</span>
      </button>`;
  }
  resourceSummaryElement.querySelector("button")?.addEventListener("click", () => {
    history.pushState({}, "", "/resources");
    renderConsole();
  });
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
        ${renderApiResourceCard(resources.openaiApi)}
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
        ? `<div class="quota-windows">${renderQuotaWindow("短周期", codex.shortWindow)}${renderQuotaWindow("长期", codex.longWindow)}</div>`
        : `<p class="resource-message">${escapeHtml(codex.message || "暂时没有可用额度数据")}</p>`}
    </article>`;
}

function renderQuotaWindow(label, window) {
  if (!window) {
    return `<div><span>${label}</span><strong>不可用</strong><small>暂无数据</small></div>`;
  }
  return `<div><span>${label}</span><strong>${formatRemaining(window)}</strong><small>${formatReset(window.resetsAt)}</small></div>`;
}

function renderApiResourceCard(api) {
  const available = api.status === "available" && api.usage;
  return `
    <article class="resource-card ${available ? "available" : "unavailable"}">
      <div class="resource-card-heading"><div><p class="overline">OpenAI API</p><h2>${available ? "账户用量" : resourceStatusLabel(api.status)}</h2></div><span class="subtle-label">可选连接</span></div>
      ${available
        ? `<strong class="account-usage">${formatUsage(api.usage)}</strong><p class="resource-message">${scopeLabel(api.scope)}账户用量</p>`
        : `<p class="resource-message">${escapeHtml(api.message || "连接后可查看 API 用量和费用")}</p>`}
    </article>`;
}

function renderResourceOrder(workOrder) {
  const usage = workOrder.usage.status === "available"
    ? formatUsage(workOrder.usage)
    : escapeHtml(workOrder.usage.message || "不可用");
  return `
    <article class="resource-order-row">
      <div class="resource-order-title"><span class="status-dot ${workOrder.status}"></span><div><strong>${escapeHtml(workOrder.title)}</strong><small>${visibleStatusLabels[workOrder.status] || workOrder.status}</small></div></div>
      <dl>
        <div><dt>优先级</dt><dd><select data-resource-priority data-work-order-id="${escapeHtml(workOrder.id)}">${resourceOptions([
          ["high", "优先推进"],
          ["normal", "正常推进"],
          ["background", "后台推进"],
        ], workOrder.priority)}</select></dd></div>
        <div><dt>执行节奏</dt><dd><select data-resource-pace data-work-order-id="${escapeHtml(workOrder.id)}">${resourceOptions([
          ["fast", "尽快完成"],
          ["balanced", "均匀推进"],
          ["saving", "节省额度"],
        ], workOrder.pace)}</select></dd></div>
        <div><dt>当前用量</dt><dd>${usage}</dd></div>
        <div><dt>运行建议</dt><dd>${escapeHtml(workOrder.recommendation)}</dd></div>
      </dl>
      <label class="auto-run-toggle">
        <input type="checkbox" data-resource-auto-run data-work-order-id="${escapeHtml(workOrder.id)}" ${workOrder.runWhenQuotaAvailable ? "checked" : ""} />
        <span><strong>额度充足时运行</strong><small>${escapeHtml(workOrder.autoRunReason || "每次只开始一轮，并受本轮时长限制")}</small></span>
      </label>
    </article>`;
}

function resourceOptions(options, selected) {
  return options
    .map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`)
    .join("");
}

function bindResourceEvents() {
  document.querySelectorAll("[data-resource-priority], [data-resource-pace], [data-resource-auto-run]")
    .forEach((control) => control.addEventListener("change", () => saveResourcePlan(control.dataset.workOrderId)));
}

async function saveResourcePlan(id) {
  const priority = document.querySelector(`[data-resource-priority][data-work-order-id="${CSS.escape(id)}"]`);
  const pace = document.querySelector(`[data-resource-pace][data-work-order-id="${CSS.escape(id)}"]`);
  const autoRun = document.querySelector(`[data-resource-auto-run][data-work-order-id="${CSS.escape(id)}"]`);
  if (!priority || !pace || !autoRun) return;
  for (const control of [priority, pace, autoRun]) control.disabled = true;
  try {
    await requestJson(`/api/work-orders/${encodeURIComponent(id)}/resource-plan`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        priority: priority.value,
        pace: pace.value,
        runWhenQuotaAvailable: autoRun.checked,
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

function renderResourceContext() {
  if (state.resourceError) {
    return `<section class="context-empty"><p class="overline">资源详情</p><h2>稍后重试</h2><p>目标不受影响，可以继续处理。</p></section>`;
  }
  const resources = state.resources;
  if (!resources) return '<div class="loading-state">正在准备资源详情…</div>';
  const api = resources.openaiApi;
  const workOrders = resources?.workOrders ?? [];
  const autoRunCount = workOrders.filter((workOrder) => workOrder.runWhenQuotaAvailable).length;
  const highPriorityCount = workOrders.filter((workOrder) => workOrder.priority === "high").length;
  return `
    <section class="context-content">
      <div class="context-heading"><div><p class="overline">资源详情</p><h2>当前安排</h2></div></div>
      <dl class="context-list resource-summary-list">
        <div><dt>运行中</dt><dd>${resources?.runningCount ?? 0} 项</dd></div>
        <div><dt>优先推进</dt><dd>${highPriorityCount} 项</dd></div>
        <div><dt>自动运行</dt><dd>${autoRunCount} 项</dd></div>
      </dl>
      <p class="context-summary resource-next-step">在“目标资源”中调整优先级、执行节奏和自动运行。</p>
      <details class="resource-details">
        <summary>数据来源与口径</summary>
        <p>Codex 额度来自本地接口，采集于 ${formatDate(resources.codex.observedAt)}；读取失败时显示“不可用”。</p>
        <p>${escapeHtml(api?.message || "OpenAI API 用量为可选连接。")}</p>
        <p>账户聚合用量不会自动归入具体目标。</p>
      </details>
    </section>`;
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
        <small>${visibleStatusLabels[presentation.status]} · ${escapeHtml(presentation.reason)}</small>
      </span>
      ${unread ? '<span class="unread-indicator" aria-label="有未读通知"></span>' : ""}
      <time>${formatDate(workOrder.updatedAt)}</time>
    </button>`;
}

function renderWorkspace(workOrder, feedback) {
  const presentation = visibleStatus(workOrder, state.workOrders);
  const stages = state.draftStages ?? workOrder.plan?.stages ?? null;
  const canEditPlan = state.draftStages !== null;
  return `
    <section class="workspace-content">
      <header class="workspace-heading">
        <div>
          <div class="status-line">
            <span class="status-pill ${presentation.status}">${visibleStatusLabels[presentation.status]}</span>
            <span>${escapeHtml(presentation.reason)}</span>
          </div>
          <h1>${escapeHtml(workOrder.title)}</h1>
          <p>${escapeHtml(workOrder.currentSummary)}</p>
        </div>
        <span class="saved-state">本机已保存</span>
      </header>

      ${workOrder.pendingClarification ? renderConversationPanel(workOrder) : ""}

      <section class="map-panel">
        <div class="section-heading">
          <div>
            <p class="overline">执行列表</p>
            <h2>${stages ? (canEditPlan ? "检查并编辑计划" : "当前计划") : "准备执行计划"}</h2>
          </div>
          <div class="map-heading-actions">
            ${workOrder.plan && !canEditPlan ? renderMapViewControls(workOrder) : ""}
            ${workOrder.plan ? `<span class="subtle-label">版本 ${workOrder.plan.version}</span>` : ""}
          </div>
        </div>
        ${workOrder.revisionNote ? `<aside class="notice"><strong>补充要求</strong><p>${escapeHtml(workOrder.revisionNote)}</p></aside>` : ""}
        ${renderPlanArea(workOrder, stages, canEditPlan)}
        <p class="inline-feedback" id="plan-feedback" role="status">${escapeHtml(feedback)}</p>
      </section>

      ${workOrder.pendingClarification ? "" : renderConversationPanel(workOrder)}

      ${renderRecoveryPanel(workOrder)}
      ${renderRunPanel(workOrder)}
      ${renderResultPanel(workOrder)}
    </section>`;
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
        <p>${workOrder.workspace
          ? "所选工作空间和素材会发送给当前模型服务；生成计划不会修改文件。"
          : "所选素材会发送给当前模型服务；执行文件夹可在启动前选择。"}</p>
        <div class="button-row">
          <button class="primary-button" id="generate-plan" type="button">生成计划</button>
          <button class="secondary-button" id="manual-plan" type="button">手动填写</button>
        </div>
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
  const messages = workOrder.conversation ?? [];
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
  const className = "execution-map-list";
  return `
    <div class="${className}" data-map-mode="list">
      ${stages.map((stage, index) => renderMapNode(stage, index, stageById, singleStage)).join("")}
    </div>
    ${workOrder.runStatus && stages.every((stage) => stage.status === "planning")
      ? '<p class="map-evidence-note">暂未收到节点进展，计划状态保持不变。</p>'
      : ""}`;
}

function renderMapNode(stage, index, stageById, singleStage) {
  const dependencies = (stage.dependsOn ?? [])
    .map((id) => stageById.get(id))
    .filter(Boolean)
    .map(({ stage: dependency, index: dependencyIndex }) => `节点 ${dependencyIndex + 1} · ${dependency.outcome}`);
  return `
    <button class="map-node ${singleStage ? "single" : ""} ${state.selectedStageIndex === index ? "selected" : ""}" data-stage-index="${index}" type="button">
      <span class="map-node-topline">
        <span class="stage-index">${index + 1}</span>
        <span class="node-status ${escapeHtml(stage.status)}">${escapeHtml(visibleStatusLabels[stage.status] ?? "规划中")} · ${escapeHtml(stage.statusReason)}</span>
      </span>
      <strong>${escapeHtml(stage.outcome)}</strong>
      <small>${escapeHtml(stage.scope)}</small>
      ${dependencies.length ? `<span class="dependency-label">依赖：${escapeHtml(dependencies.join("；"))}</span>` : '<span class="dependency-label">依赖：无</span>'}
    </button>`;
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
  if (!workOrder.result || ["ready", "running"].includes(workOrder.status)) return "";
  const historical = workOrder.result.planVersion !== workOrder.plan?.version;
  return `
    <section class="result-panel">
      <div class="section-heading compact">
        <div><p class="overline">验收</p><h2>成果与检查</h2></div>
        <span class="subtle-label">计划版本 ${workOrder.result.planVersion}</span>
      </div>
      ${historical ? `<p class="notice">这是上一版计划的历史结果。</p>` : ""}
      <article class="result-card">
        <h3>${workOrder.workspace?.kind === "directory" ? "普通文件夹结果" : "Git 变化摘要"}</h3>
        ${workOrder.workspace?.kind === "directory" ? "<p>普通文件夹不提供 Git 隔离、版本记录或回滚；请自行确认和保存目录内容。</p>" : ""}
        <pre>${escapeHtml(workOrder.result.git.diffStat || "没有已记录的差异统计")}</pre>
        <pre>${escapeHtml(workOrder.result.git.statusShort || "工作区没有未提交变化")}</pre>
      </article>
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
          .join("")}
      </div>
    </section>`;
}

function renderContext(workOrder) {
  const presentation = visibleStatus(workOrder, state.workOrders);
  const stages = state.draftStages ?? workOrder.plan?.stages ?? [];
  const selectedIndex = Math.min(state.selectedStageIndex, Math.max(0, stages.length - 1));
  const stage = stages[selectedIndex];
  return `
    <section class="context-content">
      <div class="context-heading">
        <div><p class="overline">${stage ? "当前节点" : "详情"}</p><h2>${stage ? `节点 ${selectedIndex + 1}` : "目标信息"}</h2></div>
        <span class="status-dot ${stage?.status ?? presentation.status}" title="${escapeHtml(stage?.statusReason ?? presentation.reason)}"></span>
      </div>

      ${stage ? renderContextTabs() : ""}
      ${stage ? renderContextTabContent(workOrder, stage) : `<p class="context-summary">${escapeHtml(workOrder.goal)}</p>`}

      ${renderMaterials(workOrder.materials)}

      ${renderContextAction(workOrder)}
      <p class="inline-feedback" id="execution-feedback" role="status"></p>
      <p class="inline-feedback" id="result-feedback" role="status"></p>
    </section>`;
}

function renderContextTabs() {
  const tabs = [
    ["details", "详情"],
    ["materials", "素材"],
    ["artifacts", "成果"],
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

  return `
    <div class="context-stage context-tab-panel" role="tabpanel">
      <h3>${escapeHtml(stage.outcome)}</h3>
      <p class="node-status-line"><span class="status-dot ${escapeHtml(stage.status)}"></span>${escapeHtml(visibleStatusLabels[stage.status] ?? "规划中")} · ${escapeHtml(stage.statusReason)}</p>
      <dl class="context-list">
        <div><dt>影响范围</dt><dd>${escapeHtml(stage.scope)}</dd></div>
        <div><dt>执行方式</dt><dd>${escapeHtml(executionMethodLabel(stage.executionMethod))}</dd></div>
        <div><dt>${stage.executionMethod === "external" ? "成果位置" : "工作空间"}</dt><dd><code>${escapeHtml(stage.executionMethod === "external" ? "保留在原位置" : resolvedWorkspacePath(workOrder, stage))}</code></dd></div>
        <div><dt>验证方式</dt><dd>${escapeHtml(stage.verification)}</dd></div>
        ${stage.executionMethod === "external" ? "" : `<div><dt>验证命令</dt><dd><code>${escapeHtml(stage.verificationCommand || "未配置")}</code></dd></div>`}
        <div><dt>依赖</dt><dd>${stage.dependsOn?.length ? `${stage.dependsOn.length} 个前置节点` : "无，可独立开始"}</dd></div>
        <div><dt>补充上下文</dt><dd>${stage.contextNotes?.length ? stage.contextNotes.map(escapeHtml).join("；") : "暂无"}</dd></div>
        <div><dt>累计运行</dt><dd>${formatDuration(workOrder.runtimeMs)}</dd></div>
      </dl>
      <div class="context-section">
        <p class="overline">目标信息</p>
        <dl class="context-list">
          <div><dt>目标说明</dt><dd>${escapeHtml(workOrder.description ?? workOrder.goal)}</dd></div>
          <div><dt>完成要求</dt><dd>${escapeHtml(workOrder.acceptance || "未单独填写")}</dd></div>
          <div><dt>来源会话</dt><dd>${escapeHtml(
            (workOrder.sourceSessions ?? (workOrder.importSource ? [workOrder.importSource] : []))
              .map((source) => source.id)
              .join("、") || "无",
          )}</dd></div>
          <div><dt>当前执行会话</dt><dd>${escapeHtml(workOrder.currentSessionId ?? workOrder.sessionId ?? "未建立")}</dd></div>
        </dl>
      </div>
    </div>`;
}

function completionSummaryForStage(workOrder, stage) {
  if (stage.executionMethod !== "codex" || !workOrder.result) return null;
  const currentRunEvents = state.events.filter(
    (event) => event.type === "progress" && event.runNumber === workOrder.runNumber,
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

function renderReference(reference) {
  return `<article class="reference-card"><span>${escapeHtml(referenceTypeLabel(reference.type))}</span><strong>${escapeHtml(reference.label)}</strong><code>${escapeHtml(reference.location)}</code></article>`;
}

function renderContextAction(workOrder) {
  if (state.draftStages !== null) {
    return '<section class="context-action"><p class="overline">正在编辑计划</p><strong>先保存计划再继续</strong><p>执行和成果登记会使用保存后的节点。</p></section>';
  }
  if (
    workOrder.status === "ready" &&
    !workOrder.runStatus &&
    workOrder.plan?.confirmationRequired
  ) {
    return '<section class="context-action"><p class="overline">下一步</p><strong>检查并确认计划</strong><p>请在执行列表中选择“编辑计划”，确认节点、工作空间和资源后保存。</p></section>';
  }
  const stage = workOrder.plan?.stages?.[state.selectedStageIndex];
  const needsStageConfirmation = workOrder.plan?.stages?.some(
    (candidate) =>
      candidate.executionMethod === "codex" &&
      candidate.status === "response" &&
      workOrder.result?.verifications?.some(
        (verification) =>
          verification.stageId === candidate.id && verification.status === "not_configured",
      ),
  ) && workOrder.plan?.stages?.some((candidate) => candidate.executionMethod === "external");
  if (workOrder.status === "ready" && !workOrder.runStatus && stage?.executionMethod === "external") {
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
    (workOrder.status === "ready" || workOrder.status === "review")
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
  if (workOrder.status === "ready" && !workOrder.runStatus && waitingExternalStage) {
    return `<section class="context-action"><p class="overline">下一步</p><strong>先完成外部节点</strong><p>请先处理“${escapeHtml(waitingExternalStage.outcome)}”，登记结果后再启动 Codex。</p></section>`;
  }
  if (workOrder.status === "ready" && !workOrder.runStatus) {
    const queued = visibleStatus(workOrder, state.workOrders).status === "queued";
    const suggestedPath = workOrder.materials?.find(
      (material) => material.kind === "folder" || material.kind === "repository",
    )?.value ?? "";
    return `
      <section class="context-action">
        <p class="overline">下一步</p>
        <label><span>本轮最长运行时间</span>
          <select id="max-run-minutes">
            ${[30, 60, 120, 240]
              .map((minutes) => `<option value="${minutes}" ${workOrder.maxRunMinutes === minutes ? "selected" : ""}>${formatRunLimit(minutes)}</option>`)
              .join("")}
          </select>
        </label>
        ${workOrder.workspace
          ? `<p class="workspace-choice"><strong>${workOrder.workspace.kind === "git" ? "Git 仓库" : "普通文件夹"}</strong><code>${escapeHtml(shortPath(workOrder.workspace.path))}</code></p>
             <button class="primary-button full-button" id="start-work-order" type="button" ${queued ? "disabled" : ""}>${queued ? "等待当前目标结束" : "确认计划并启动"}</button>`
          : `<form id="workspace-form">
               <label><span>执行前选择本地文件夹</span><input name="workspacePath" value="${escapeHtml(suggestedPath)}" placeholder="/Users/you/Projects/workspace" autocomplete="off" required /></label>
               <p>Git 仓库会使用独立执行工作区；普通文件夹会直接使用，不提供 Git 隔离、版本记录或回滚。</p>
               <button class="primary-button full-button" id="select-workspace-and-start" type="submit" ${queued ? "disabled" : ""}>${queued ? "等待当前目标结束" : "选择文件夹并启动"}</button>
             </form>`}
      </section>`;
  }
  if (workOrder.runStatus === "running") {
    return `<section class="context-action"><p>Codex 正在所选工作区中运行。</p><button class="secondary-button full-button" id="interrupt-work-order" type="button">中断运行</button></section>`;
  }
  if (workOrder.runStatus === "stopping" || workOrder.runStatus === "verifying") {
    return `<section class="context-action"><p>${escapeHtml(workOrder.currentSummary)}</p><button class="secondary-button full-button" type="button" disabled>处理中…</button></section>`;
  }
  if (workOrder.status === "interrupted") {
    const latestCheckpoint = currentPlanCheckpoints(workOrder).at(-1);
    const canReexecute = workOrder.workspace?.kind === "git" && latestCheckpoint;
    return `
      <section class="context-action recovery-actions">
        <p>选择如何处理当前中断。</p>
        <button class="primary-button full-button" id="continue-work-order" type="button">继续当前现场</button>
        ${canReexecute
          ? `<button class="secondary-button full-button" id="reexecute-work-order" type="button">${latestCheckpoint.kind === "stage" ? "从最近节点重新执行" : "从起始位置重新执行"}</button>`
          : '<p class="muted">普通文件夹暂不提供检查点回退。</p>'}
      </section>`;
  }
  if (workOrder.status === "review") {
    return `
      <section class="context-action">
        <p>结果已整理完成，需要你确认是否符合目标。</p>
        <button class="primary-button full-button" id="deliver-work-order" type="button">确认完成</button>
        <form id="revision-form">
          <label><span>还有补充要求？</span><textarea name="revisionNote" rows="3" required placeholder="说明需要继续处理的内容"></textarea></label>
          <button class="secondary-button full-button" id="revise-work-order" type="submit">补充要求并继续</button>
        </form>
      </section>`;
  }
  if (workOrder.status === "delivered") {
    return '<section class="context-action completed-action"><strong>这个目标已经确认完成。</strong><p>计划、运行记录和验收结果仍保存在本机。</p></section>';
  }
  return "";
}

function bindRenderedEvents() {
  document.querySelectorAll("[data-stage-index]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedStageIndex = Number(button.dataset.stageIndex);
      state.followCurrentStage = false;
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

  document.querySelector("#generate-plan")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    setBusy(button, "正在生成…");
    setFeedback("plan-feedback", "生成计划通常需要 30–90 秒，Codex 正在整理目标和素材。", false);
    try {
      const result = await requestJson(`/api/work-orders/${encodedSelectedId()}/plan/generate`, {
        method: "POST",
      });
      state.draftStages = null;
      await acceptWorkOrderResult(
        result.workOrder,
        result.outcome === "clarification" ? "还需要你确认一项关键信息。" : "计划已经生成，你可以继续编辑。",
      );
    } catch (error) {
      resetBusy(button, "生成计划");
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

  document.querySelector("#max-run-minutes")?.addEventListener("change", async (event) => {
    const select = event.currentTarget;
    select.disabled = true;
    try {
      const result = await requestJson(`/api/work-orders/${encodedSelectedId()}/execution-settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxRunMinutes: Number(select.value) }),
      });
      await acceptWorkOrderResult(result.workOrder);
    } catch (error) {
      select.disabled = false;
      setFeedback("execution-feedback", messageFrom(error, "无法保存最长运行时间。"), true);
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
    setBusy(button, "正在保存…");
    try {
      const revisionNote = new FormData(event.currentTarget).get("revisionNote");
      const result = await requestJson(`/api/work-orders/${encodedSelectedId()}/revise`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revisionNote }),
      });
      await acceptWorkOrderResult(result.workOrder, "补充要求已保存，请检查并再次确认计划。");
    } catch (error) {
      resetBusy(button, "补充要求并继续");
      setFeedback("result-feedback", messageFrom(error, "无法保存补充要求，请重试。"), true);
    }
  });
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
        materials: readMaterials(),
      }),
    });
    closeCreateDialog();
    history.pushState({}, "", `/goals/${encodeURIComponent(workOrder.id)}`);
    state.selected = workOrder;
    state.selectedStageIndex = 0;
    state.followCurrentStage = true;
    await refreshConsole();
  } catch (error) {
    formError.textContent = messageFrom(error, "创建目标失败");
    resetBusy(createButton, "创建目标");
  }
}

async function openSessionImport() {
  state.sessionSearch = "";
  state.sessionDiscovery = null;
  sessionImportError.textContent = "";
  document.querySelector("#session-search").value = "";
  document.querySelector("#session-candidate-list").innerHTML =
    '<div class="loading-state">正在读取本机会话…</div>';
  document.querySelector("#session-source-message").textContent = "";
  sessionImportDialog.showModal();
  try {
    state.sessionDiscovery = await requestJson("/api/codex-sessions");
    renderSessionCandidates();
    document.querySelector("#session-search").focus();
  } catch (error) {
    sessionImportError.textContent = messageFrom(error, "无法读取本机 Codex 会话");
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
    list.innerHTML = `<div class="session-empty">${discovery.sessions.length ? "没有匹配的会话" : "没有找到可导入的 Codex 会话"}</div>`;
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
          <input type="checkbox" name="sessionId" value="${escapeHtml(session.id)}" ${disabled ? "disabled" : ""} />
          <span>
            <strong>${escapeHtml(session.title)}</strong>
            <small>${escapeHtml(session.projectLabel)} · ${formatDate(session.lastActiveAt)}</small>
          </span>
          <em>${stateLabel}</em>
        </label>
        ${!disabled ? `<label class="session-goal"><span>目标</span><input data-session-goal="${escapeHtml(session.id)}" value="${escapeHtml(session.title)}" autocomplete="off" /></label>` : ""}
        ${session.suggestion ? `<p class="session-suggestion">可能与现有目标“${escapeHtml(session.suggestion.title)}”相关；本次仍会默认创建新目标。</p>` : ""}
        ${session.message ? `<p class="session-warning">${escapeHtml(session.message)}</p>` : ""}
      </article>`;
  }).join("");
}

async function importSelectedSessions(event) {
  event.preventDefault();
  sessionImportError.textContent = "";
  const selected = [...sessionImportForm.querySelectorAll('input[name="sessionId"]:checked')];
  if (!selected.length) {
    sessionImportError.textContent = "请选择至少一个 Codex 会话";
    return;
  }
  const sessions = selected.map((checkbox) => ({
    id: checkbox.value,
    goal: sessionImportForm.querySelector(`[data-session-goal="${CSS.escape(checkbox.value)}"]`)?.value,
  }));
  const button = document.querySelector("#submit-session-import");
  setBusy(button, "正在导入…");
  try {
    const result = await requestJson("/api/codex-sessions/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessions }),
    });
    const workOrder = result.imported[0] ?? result.existing[0];
    closeSessionImport();
    if (workOrder) {
      history.pushState({}, "", `/goals/${encodeURIComponent(workOrder.id)}`);
      state.selected = workOrder;
      state.selectedStageIndex = 0;
      state.followCurrentStage = true;
    }
    await refreshConsole();
  } catch (error) {
    resetBusy(button, "导入所选会话");
    sessionImportError.textContent = messageFrom(error, "无法导入 Codex 会话");
  }
}

async function selectWorkOrder(id) {
  if (!id) return;
  state.draftStages = null;
  if (id !== state.selected?.id) {
    state.selectedStageIndex = 0;
    state.followCurrentStage = true;
    state.contextTab = "details";
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

function closeCreateDialog() {
  createDialog.close();
  createForm.reset();
  document.querySelector("#material-list").innerHTML = "";
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
    repository: "仓库",
    folder: "文件夹",
    file: "文件",
    image: "图片",
    link: "链接",
  }[kind] ?? "素材";
}

function visibleStatus(workOrder, allWorkOrders) {
  const presented = allWorkOrders.find((candidate) => candidate.id === workOrder.id);
  if (presented?.userStatus && presented?.statusReason) {
    return { status: presented.userStatus, reason: presented.statusReason };
  }
  return { status: "planning", reason: "正在读取状态" };
}

function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  if (isResourceView()) {
    state.refreshTimer = setTimeout(() => refreshConsole({ polling: true }), 30_000);
    return;
  }
  if (
    state.workOrders.some((workOrder) =>
      ["running", "stopping", "verifying"].includes(workOrder.runStatus),
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
  button.disabled = true;
  button.textContent = label;
}

function resetBusy(button, label) {
  if (!button) return;
  button.disabled = false;
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
