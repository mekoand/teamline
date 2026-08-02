const visibleStatusLabels = {
  planning: "规划中",
  running: "运行中",
  queued: "排队中",
  response: "需响应",
  completed: "已完成",
};

const state = {
  workOrders: [],
  selected: null,
  selectedStageIndex: 0,
  draftStages: null,
  events: [],
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

applyTheme(state.theme);
bindShellEvents();
refreshConsole();

function bindShellEvents() {
  document.querySelector("#theme-toggle").addEventListener("click", () => {
    state.theme = state.theme === "dark" ? "light" : "dark";
    localStorage.setItem("teamline-theme", state.theme);
    applyTheme(state.theme);
  });

  document.querySelector("#open-create").addEventListener("click", () => {
    createDialog.showModal();
    createDialog.querySelector('[name="repositoryPath"]').focus();
  });
  document.querySelector("#close-create").addEventListener("click", closeCreateDialog);
  document.querySelector("#cancel-create").addEventListener("click", closeCreateDialog);
  createForm.addEventListener("submit", createWorkOrder);
  window.addEventListener("popstate", () => {
    state.draftStages = null;
    refreshConsole();
  });
}

async function refreshConsole({ polling = false } = {}) {
  clearTimeout(state.refreshTimer);
  if (!polling && state.workOrders.length === 0) {
    workspaceElement.innerHTML = '<div class="loading-state">正在读取本地委托…</div>';
    contextElement.innerHTML = '<div class="loading-state">正在准备上下文…</div>';
  }

  try {
    const { workOrders } = await requestJson("/api/console");
    state.workOrders = workOrders;
    const requestedId = selectedIdFromPath();
    const selectedId = requestedId ?? state.selected?.id ?? workOrders[0]?.id ?? null;

    if (selectedId) {
      const { workOrder } = await requestJson(
        `/api/work-orders/${encodeURIComponent(selectedId)}`,
      );
      state.selected = workOrder;
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

function renderConsole(feedback = "") {
  renderWorkOrderList();
  if (!state.selected) {
    workspaceElement.innerHTML = `
      <section class="empty-console">
        <span class="empty-symbol">↗</span>
        <h2>从一项真实工作开始</h2>
        <p>创建委托后，计划、运行进展和验收结果会留在这个本地工作台。</p>
        <button class="primary-button" id="empty-create" type="button">创建第一个委托</button>
      </section>`;
    contextElement.innerHTML = `
      <section class="context-empty">
        <p class="overline">上下文</p>
        <h2>尚未选择委托</h2>
        <p>这里会显示当前阶段的范围、验证方式和执行操作。</p>
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
    listElement.innerHTML = '<p class="sidebar-empty">还没有委托</p>';
    return;
  }

  const groups = [
    ["response", "需响应"],
    ["running", "运行中"],
    ["planning", "规划中"],
    ["queued", "排队中"],
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

function renderOrderRow(workOrder) {
  const presentation = visibleStatus(workOrder, state.workOrders);
  const selected = state.selected?.id === workOrder.id;
  return `
    <button class="order-row ${selected ? "selected" : ""}" data-work-order-id="${escapeHtml(workOrder.id)}" type="button">
      <span class="status-dot ${presentation.status}"></span>
      <span class="order-row-copy">
        <strong>${escapeHtml(workOrder.title)}</strong>
        <small>${visibleStatusLabels[presentation.status]} · ${escapeHtml(presentation.reason)}</small>
      </span>
      <time>${formatDate(workOrder.updatedAt)}</time>
    </button>`;
}

function renderWorkspace(workOrder, feedback) {
  const presentation = visibleStatus(workOrder, state.workOrders);
  const stages = state.draftStages ?? workOrder.plan?.stages ?? null;
  const canEditPlan = workOrder.status === "ready" || state.draftStages !== null;
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
        <span class="saved-state">已保存于本机</span>
      </header>

      <section class="map-panel">
        <div class="section-heading">
          <div>
            <p class="overline">执行地图</p>
            <h2>${stages ? (canEditPlan ? "检查并编辑计划" : "当前计划") : "先把工作想清楚"}</h2>
          </div>
          ${workOrder.plan ? `<span class="subtle-label">版本 ${workOrder.plan.version}</span>` : ""}
        </div>
        ${workOrder.revisionNote ? `<aside class="notice"><strong>补充要求</strong><p>${escapeHtml(workOrder.revisionNote)}</p></aside>` : ""}
        ${renderPlanArea(workOrder, stages, canEditPlan)}
        <p class="inline-feedback" id="plan-feedback" role="status">${escapeHtml(feedback)}</p>
      </section>

      ${renderRunPanel(workOrder)}
      ${renderResultPanel(workOrder)}
    </section>`;
}

function renderPlanArea(workOrder, stages, canEditPlan) {
  if (!stages) {
    return `
      <div class="plan-empty">
        <p>Codex 会以只读方式查看仓库，并把生成计划所需的代码上下文发送给当前配置的模型服务。规划不会修改代码。</p>
        <div class="button-row">
          <button class="primary-button" id="generate-plan" type="button">生成计划</button>
          <button class="secondary-button" id="manual-plan" type="button">手动填写</button>
        </div>
      </div>`;
  }
  if (canEditPlan) return renderPlanForm(stages);

  return `
    <div class="stage-flow">
      ${stages
        .map((stage, index) => {
          return `
            <button class="stage-row ${state.selectedStageIndex === index ? "selected" : ""}" data-stage-index="${index}" type="button">
              <span class="stage-index">${index + 1}</span>
              <span class="stage-copy">
                <strong>${escapeHtml(stage.outcome)}</strong>
                <small>${escapeHtml(stage.scope)}</small>
              </span>
              <span class="subtle-label">计划阶段</span>
            </button>`;
        })
        .join("")}
    </div>`;
}

function renderPlanForm(stages) {
  return `
    <form id="plan-form" class="plan-form">
      ${stages
        .map(
          (stage, index) => `
            <article class="plan-stage" data-plan-stage>
              <div class="plan-stage-heading">
                <strong>阶段 ${index + 1}</strong>
                ${stages.length > 1 ? `<button type="button" data-remove-stage="${index}">移除</button>` : ""}
              </div>
              <input type="hidden" name="id" value="${escapeHtml(stage.id ?? "")}" />
              <label><span>目标结果</span><textarea name="outcome" rows="2" required>${escapeHtml(stage.outcome ?? "")}</textarea></label>
              <label><span>预计影响范围</span><textarea name="scope" rows="2" required>${escapeHtml(stage.scope ?? "")}</textarea></label>
              <label><span>验证方式</span><textarea name="verification" rows="2" required>${escapeHtml(stage.verification ?? "")}</textarea></label>
              <label><span>自动验证命令 <em>可选</em></span><input name="verificationCommand" value="${escapeHtml(stage.verificationCommand ?? "")}" placeholder="例如：bun test" /></label>
            </article>`,
        )
        .join("")}
      <div class="plan-form-actions">
        <button class="secondary-button" id="add-stage" type="button">增加阶段</button>
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
        <div><dt>会话</dt><dd>${escapeHtml(workOrder.sessionId ?? "等待 Codex 返回")}</dd></div>
        <div><dt>分支</dt><dd>${escapeHtml(workOrder.executionBranch ?? "正在准备")}</dd></div>
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
        <div><p class="overline">成果与验收</p><h2>代码变化与检查结果</h2></div>
        <span class="subtle-label">计划版本 ${workOrder.result.planVersion}</span>
      </div>
      ${historical ? `<p class="notice">这是上一版计划的历史结果。</p>` : ""}
      <article class="result-card">
        <h3>Git 变化摘要</h3>
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
        <div><p class="overline">上下文</p><h2>${stage ? `阶段 ${selectedIndex + 1}` : "委托详情"}</h2></div>
        <span class="status-dot ${presentation.status}" title="${visibleStatusLabels[presentation.status]}"></span>
      </div>

      ${stage
        ? `<div class="context-stage">
            <h3>${escapeHtml(stage.outcome)}</h3>
            <dl class="context-list">
              <div><dt>影响范围</dt><dd>${escapeHtml(stage.scope)}</dd></div>
              <div><dt>验证方式</dt><dd>${escapeHtml(stage.verification)}</dd></div>
              <div><dt>验证命令</dt><dd><code>${escapeHtml(stage.verificationCommand || "未配置")}</code></dd></div>
            </dl>
          </div>`
        : `<p class="context-summary">${escapeHtml(workOrder.goal)}</p>`}

      <div class="context-section">
        <p class="overline">委托信息</p>
        <dl class="context-list">
          <div><dt>仓库</dt><dd><code>${escapeHtml(shortPath(workOrder.repositoryPath))}</code></dd></div>
          <div><dt>目标</dt><dd>${escapeHtml(workOrder.goal)}</dd></div>
          <div><dt>完成要求</dt><dd>${escapeHtml(workOrder.acceptance || "未单独填写")}</dd></div>
        </dl>
      </div>

      ${renderContextAction(workOrder)}
      <p class="inline-feedback" id="execution-feedback" role="status"></p>
      <p class="inline-feedback" id="result-feedback" role="status"></p>
    </section>`;
}

function renderContextAction(workOrder) {
  if (workOrder.status === "ready" && !workOrder.runStatus) {
    const queued = visibleStatus(workOrder, state.workOrders).status === "queued";
    return `
      <section class="context-action">
        <p class="overline">执行确认</p>
        <label><span>本轮最长运行时间</span>
          <select id="max-run-minutes">
            ${[30, 60, 120, 240]
              .map((minutes) => `<option value="${minutes}" ${workOrder.maxRunMinutes === minutes ? "selected" : ""}>${formatRunLimit(minutes)}</option>`)
              .join("")}
          </select>
        </label>
        <button class="primary-button full-button" id="start-work-order" type="button" ${queued ? "disabled" : ""}>
          ${queued ? "等待当前委托结束" : "确认计划并启动"}
        </button>
      </section>`;
  }
  if (workOrder.runStatus === "running") {
    return `<section class="context-action"><p>Codex 正在委托工作区内执行。</p><button class="secondary-button full-button" id="interrupt-work-order" type="button">中断运行</button></section>`;
  }
  if (workOrder.runStatus === "stopping" || workOrder.runStatus === "verifying") {
    return `<section class="context-action"><p>${escapeHtml(workOrder.currentSummary)}</p><button class="secondary-button full-button" type="button" disabled>处理中…</button></section>`;
  }
  if (workOrder.status === "interrupted") {
    return `<section class="context-action"><p>${escapeHtml(workOrder.lastError || workOrder.currentSummary)}</p><button class="primary-button full-button" id="continue-work-order" type="button">继续委托</button></section>`;
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
    return '<section class="context-action completed-action"><strong>这项委托已经确认完成。</strong><p>计划、运行记录和验收结果仍保存在本机。</p></section>';
  }
  return "";
}

function bindRenderedEvents() {
  document.querySelectorAll("[data-stage-index]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedStageIndex = Number(button.dataset.stageIndex);
      renderConsole();
    });
  });

  document.querySelector("#generate-plan")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    setBusy(button, "正在生成…");
    setFeedback("plan-feedback", "Codex 正在只读查看仓库并整理计划。", false);
    try {
      const result = await requestJson(`/api/work-orders/${encodedSelectedId()}/plan/generate`, {
        method: "POST",
      });
      state.draftStages = null;
      await acceptWorkOrderResult(result.workOrder, "计划已经生成，你可以继续编辑。");
    } catch (error) {
      resetBusy(button, "生成计划");
      setFeedback("plan-feedback", messageFrom(error, "生成计划失败，你仍然可以手动填写。"), true);
    }
  });

  document.querySelector("#manual-plan")?.addEventListener("click", () => {
    state.draftStages = [emptyStage()];
    renderConsole();
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

  document.querySelector("#max-run-minutes")?.addEventListener("change", async (event) => {
    const select = event.currentTarget;
    const draftStages = readPlanStages();
    select.disabled = true;
    try {
      const result = await requestJson(`/api/work-orders/${encodedSelectedId()}/execution-settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxRunMinutes: Number(select.value) }),
      });
      state.draftStages = draftStages;
      await acceptWorkOrderResult(result.workOrder);
    } catch (error) {
      select.disabled = false;
      setFeedback("execution-feedback", messageFrom(error, "无法保存最长运行时间。"), true);
    }
  });

  bindAction("#start-work-order", "正在准备…", "确认计划并启动", "start", "Teamline 正在创建委托工作区并启动 Codex。");
  bindAction("#interrupt-work-order", "正在停止…", "中断运行", "interrupt", "正在请求 Codex 停止。");
  bindAction("#continue-work-order", "正在继续…", "继续委托", "continue", "正在从现有进度继续委托。");
  bindAction("#deliver-work-order", "正在确认…", "确认完成", "deliver", "");

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
  state.selected = workOrder;
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
        repositoryPath: data.get("repositoryPath"),
        goal: data.get("goal"),
        acceptance: data.get("acceptance"),
      }),
    });
    closeCreateDialog();
    history.pushState({}, "", `/work-orders/${encodeURIComponent(workOrder.id)}`);
    state.selected = workOrder;
    state.selectedStageIndex = 0;
    await refreshConsole();
  } catch (error) {
    formError.textContent = messageFrom(error, "创建委托失败");
    resetBusy(createButton, "创建委托");
  }
}

function selectWorkOrder(id) {
  if (!id || id === state.selected?.id) return;
  state.draftStages = null;
  state.selectedStageIndex = 0;
  history.pushState({}, "", `/work-orders/${encodeURIComponent(id)}`);
  refreshConsole();
}

function closeCreateDialog() {
  createDialog.close();
  createForm.reset();
  formError.textContent = "";
  resetBusy(createButton, "创建委托");
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
  if (["running", "stopping", "verifying"].includes(state.selected?.runStatus)) {
    state.refreshTimer = setTimeout(() => refreshConsole({ polling: true }), 2_000);
  }
}

function readPlanStages() {
  return [...document.querySelectorAll("[data-plan-stage]")].map((stage) => ({
    id: stage.querySelector('[name="id"]').value || undefined,
    outcome: stage.querySelector('[name="outcome"]').value,
    scope: stage.querySelector('[name="scope"]').value,
    verification: stage.querySelector('[name="verification"]').value,
    verificationCommand: stage.querySelector('[name="verificationCommand"]').value,
  }));
}

function selectedIdFromPath() {
  const match = window.location.pathname.match(/^\/work-orders\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function encodedSelectedId() {
  return encodeURIComponent(state.selected.id);
}

function emptyStage() {
  return { outcome: "", scope: "", verification: "", verificationCommand: "" };
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

function shortPath(path) {
  const parts = String(path).split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
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
