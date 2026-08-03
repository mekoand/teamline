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
  mapView: null,
  contextTab: "details",
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
    createDialog.querySelector('[name="goal"]').focus();
  });
  document.querySelector("#close-create").addEventListener("click", closeCreateDialog);
  document.querySelector("#cancel-create").addEventListener("click", closeCreateDialog);
  createForm.addEventListener("submit", createWorkOrder);
  document.querySelector("#add-material").addEventListener("click", () => addMaterialRow());
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
    if (state.mapView === null) {
      const preference = await requestJson("/api/preferences/execution-map-view");
      state.mapView = preference.view;
    }
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
        <span class="saved-state">已保存于本机</span>
      </header>

      <section class="map-panel">
        <div class="section-heading">
          <div>
            <p class="overline">执行地图</p>
            <h2>${stages ? (canEditPlan ? "检查并编辑计划" : "当前计划") : "先把工作想清楚"}</h2>
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

      ${renderRunPanel(workOrder)}
      ${renderResultPanel(workOrder)}
    </section>`;
}

function renderPlanArea(workOrder, stages, canEditPlan) {
  if (!stages) {
    return `
      <div class="plan-empty">
        <p>${workOrder.workspace
          ? "Codex 会以只读方式查看所选工作空间和素材，并把生成计划所需的上下文发送给当前配置的模型服务。规划不会修改文件。"
          : "Codex 会先根据目标和素材整理计划；现在不需要选择执行文件夹，规划不会修改本地文件。"}</p>
        <div class="button-row">
          <button class="primary-button" id="generate-plan" type="button">生成计划</button>
          <button class="secondary-button" id="manual-plan" type="button">手动填写</button>
        </div>
      </div>`;
  }
  if (canEditPlan) return renderPlanForm(stages);
  return renderExecutionMap(workOrder, stages);
}

function renderMapViewControls(workOrder) {
  const canEdit = workOrder.status === "ready" && !workOrder.runStatus;
  return `
    <div class="map-view-controls" aria-label="执行地图视图">
      <button type="button" data-map-view="map" class="${state.mapView === "map" ? "active" : ""}" aria-pressed="${state.mapView === "map"}">节点图</button>
      <button type="button" data-map-view="list" class="${state.mapView === "list" ? "active" : ""}" aria-pressed="${state.mapView === "list"}">纵向列表</button>
      ${canEdit ? '<button type="button" id="edit-plan">编辑计划</button>' : ""}
    </div>`;
}

function renderExecutionMap(workOrder, stages) {
  const stageById = new Map(stages.map((stage, index) => [stage.id, { stage, index }]));
  const singleStage = stages.length === 1;
  const className = state.mapView === "list" || singleStage
    ? "execution-map-list"
    : "execution-map-graph";
  return `
    <div class="${className}" data-map-mode="${escapeHtml(state.mapView ?? "map")}">
      ${stages.map((stage, index) => renderMapNode(stage, index, stageById, singleStage)).join("")}
    </div>
    ${workOrder.runStatus && stages.every((stage) => stage.status === "planning")
      ? '<p class="map-evidence-note">Codex 尚未提供可归因到节点的进展；这里保留已知的计划状态，不推测某个节点正在运行。</p>'
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
      ${dependencies.length && !singleStage ? `<span class="dependency-label">依赖 ${escapeHtml(dependencies.join("；"))}</span>` : ""}
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
                <strong>阶段 ${index + 1}</strong>
                ${stages.length > 1 ? `<button type="button" data-remove-stage="${index}">移除</button>` : ""}
              </div>
              <input type="hidden" name="id" value="${escapeHtml(stage.id ?? "")}" />
              <label><span>目标结果</span><textarea name="outcome" rows="2" required>${escapeHtml(stage.outcome ?? "")}</textarea></label>
              <label><span>预计影响范围</span><textarea name="scope" rows="2" required>${escapeHtml(stage.scope ?? "")}</textarea></label>
              <label><span>验证方式</span><textarea name="verification" rows="2" required>${escapeHtml(stage.verification ?? "")}</textarea></label>
              <label><span>自动验证命令 <em>可选</em></span><input name="verificationCommand" value="${escapeHtml(stage.verificationCommand ?? "")}" placeholder="例如：bun test" /></label>
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
                <span>执行方式：${escapeHtml(executionMethodLabel(stage.executionMethod))}</span>
                <span>工作空间：${escapeHtml(workspaceLabel(stage.workspace))}</span>
              </div>
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
        <div><p class="overline">成果与验收</p><h2>工作空间变化与检查结果</h2></div>
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
        <div><p class="overline">上下文</p><h2>${stage ? `阶段 ${selectedIndex + 1}` : "委托详情"}</h2></div>
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
    ["conversation", "对话"],
  ];
  return `
    <div class="context-tabs" role="tablist" aria-label="节点上下文">
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
    return `
      <div class="context-stage context-tab-panel" role="tabpanel">
        <h3>节点成果</h3>
        <div class="reference-list">
          ${references.length ? references.map(renderReference).join("") : ""}
          ${verification
            ? `<article class="reference-card"><span>验证结果</span><strong>${escapeHtml(verificationLabel(verification.status))}</strong><code>${escapeHtml(verification.command || "人工检查")}</code></article>`
            : references.length ? "" : '<p class="muted">执行后，成果引用与验证结果会集中显示在这里。</p>'}
        </div>
      </div>`;
  }

  if (state.contextTab === "conversation") {
    return `
      <div class="context-stage context-tab-panel" role="tabpanel">
        <h3>节点对话</h3>
        <p class="muted">对话是节点的辅助上下文，执行地图仍是主要工作界面。</p>
        ${workOrder.sessionId
          ? `<article class="reference-card"><span>Codex 会话</span><strong>${escapeHtml(workOrder.sessionId)}</strong><small>最近活动：${escapeHtml(state.events.at(-1)?.message ?? "暂无活动")}</small></article>`
          : '<p class="muted">启动 Codex 后，这里会显示关联会话和最近活动。</p>'}
      </div>`;
  }

  return `
    <div class="context-stage context-tab-panel" role="tabpanel">
      <h3>${escapeHtml(stage.outcome)}</h3>
      <p class="node-status-line"><span class="status-dot ${escapeHtml(stage.status)}"></span>${escapeHtml(visibleStatusLabels[stage.status] ?? "规划中")} · ${escapeHtml(stage.statusReason)}</p>
      <dl class="context-list">
        <div><dt>影响范围</dt><dd>${escapeHtml(stage.scope)}</dd></div>
        <div><dt>执行方式</dt><dd>${escapeHtml(executionMethodLabel(stage.executionMethod))}</dd></div>
        <div><dt>工作空间</dt><dd><code>${escapeHtml(resolvedWorkspacePath(workOrder, stage))}</code></dd></div>
        <div><dt>验证方式</dt><dd>${escapeHtml(stage.verification)}</dd></div>
        <div><dt>验证命令</dt><dd><code>${escapeHtml(stage.verificationCommand || "未配置")}</code></dd></div>
        <div><dt>依赖</dt><dd>${stage.dependsOn?.length ? `${stage.dependsOn.length} 个前置节点` : "无，可独立开始"}</dd></div>
        <div><dt>累计运行</dt><dd>${formatDuration(workOrder.runtimeMs)}</dd></div>
      </dl>
      <div class="context-section">
        <p class="overline">委托信息</p>
        <dl class="context-list">
          <div><dt>目标</dt><dd>${escapeHtml(workOrder.goal)}</dd></div>
          <div><dt>完成要求</dt><dd>${escapeHtml(workOrder.acceptance || "未单独填写")}</dd></div>
        </dl>
      </div>
    </div>`;
}

function renderReference(reference) {
  return `<article class="reference-card"><span>${escapeHtml(referenceTypeLabel(reference.type))}</span><strong>${escapeHtml(reference.label)}</strong><code>${escapeHtml(reference.location)}</code></article>`;
}

function renderContextAction(workOrder) {
  if (workOrder.status === "ready" && !workOrder.runStatus) {
    const queued = visibleStatus(workOrder, state.workOrders).status === "queued";
    const suggestedPath = workOrder.materials?.find(
      (material) => material.kind === "folder" || material.kind === "repository",
    )?.value ?? "";
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
        ${workOrder.workspace
          ? `<p class="workspace-choice"><strong>${workOrder.workspace.kind === "git" ? "Git 仓库" : "普通文件夹"}</strong><code>${escapeHtml(shortPath(workOrder.workspace.path))}</code></p>
             <button class="primary-button full-button" id="start-work-order" type="button" ${queued ? "disabled" : ""}>${queued ? "等待当前委托结束" : "确认计划并启动"}</button>`
          : `<form id="workspace-form">
               <label><span>执行前选择本地文件夹</span><input name="workspacePath" value="${escapeHtml(suggestedPath)}" placeholder="/Users/you/Projects/workspace" autocomplete="off" required /></label>
               <p>Git 仓库会使用独立委托工作区；普通文件夹会直接使用，不提供 Git 隔离、版本记录或回滚。</p>
               <button class="primary-button full-button" id="select-workspace-and-start" type="submit" ${queued ? "disabled" : ""}>${queued ? "等待当前委托结束" : "选择文件夹并启动"}</button>
             </form>`}
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

  document.querySelectorAll("[data-map-view]").forEach((button) => {
    button.addEventListener("click", async () => {
      const view = button.dataset.mapView;
      if (view === state.mapView) return;
      try {
        const saved = await requestJson("/api/preferences/execution-map-view", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ view }),
        });
        state.mapView = saved.view;
        renderConsole();
      } catch (error) {
        setFeedback("plan-feedback", messageFrom(error, "无法保存视图偏好"), true);
      }
    });
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
    setFeedback("plan-feedback", "Codex 正在根据工作空间和素材整理计划。", false);
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

  bindAction("#start-work-order", "正在准备…", "确认计划并启动", "start", "Teamline 正在创建委托工作区并启动 Codex。");
  bindAction("#interrupt-work-order", "正在停止…", "中断运行", "interrupt", "正在请求 Codex 停止。");
  bindAction("#continue-work-order", "正在继续…", "继续委托", "continue", "正在从现有进度继续委托。");
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
        goal: data.get("goal"),
        acceptance: data.get("acceptance"),
        materials: readMaterials(),
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
  state.contextTab = "details";
  history.pushState({}, "", `/work-orders/${encodeURIComponent(id)}`);
  refreshConsole();
}

function closeCreateDialog() {
  createDialog.close();
  createForm.reset();
  document.querySelector("#material-list").innerHTML = "";
  formError.textContent = "";
  resetBusy(createButton, "创建委托");
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
  if (["running", "stopping", "verifying"].includes(state.selected?.runStatus)) {
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
      verificationCommand: stage.querySelector('[name="verificationCommand"]').value,
      dependsOn: [...stage.querySelector('[name="dependsOn"]').selectedOptions].map(
        (option) => option.value,
      ),
      executionMethod: source.executionMethod ?? "codex",
      workspace: source.workspace ?? { kind: "git", path: state.selected.repositoryPath },
      materials: source.materials ?? [],
      artifacts: source.artifacts ?? [],
    };
  });
}

function selectedIdFromPath() {
  const match = window.location.pathname.match(/^\/work-orders\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
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

function shortPath(path) {
  const parts = String(path).split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}

function executionMethodLabel(method) {
  return method === "external" ? "外部工作" : "Codex · AI 执行";
}

function workspaceLabel(workspace) {
  return {
    git: "Git 委托工作区",
    directory: "本地文件夹",
    external: "外部工作空间",
  }[workspace?.kind] ?? "Git 委托工作区";
}

function resolvedWorkspacePath(workOrder, stage) {
  if (stage.workspace?.kind === "git") {
    return workOrder.worktreePath || stage.workspace.path || workOrder.repositoryPath;
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
