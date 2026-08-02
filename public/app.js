const statusLabels = {
  draft: "草稿",
  ready: "待确认",
  running: "进行中",
  interrupted: "已中断",
  review: "待验收",
  completed: "已完成",
};

const detailMatch = window.location.pathname.match(/^\/work-orders\/([^/]+)$/);
let detailRefreshTimer;

if (detailMatch) {
  loadWorkOrderDetail(decodeURIComponent(detailMatch[1]));
} else {
  setupHome();
}

function setupHome() {
  const list = document.querySelector("#work-order-list");
  const count = document.querySelector("#work-order-count");
  const dialog = document.querySelector("#create-dialog");
  const form = document.querySelector("#create-form");
  const errorMessage = document.querySelector("#form-error");
  const submitButton = document.querySelector("#submit-create");

  document.querySelector("#open-create").addEventListener("click", () => dialog.showModal());
  document.querySelector("#close-create").addEventListener("click", closeDialog);
  document.querySelector("#cancel-create").addEventListener("click", closeDialog);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorMessage.textContent = "";
    submitButton.disabled = true;
    submitButton.textContent = "正在创建…";

    try {
      const data = new FormData(form);
      await requestJson("/api/work-orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repositoryPath: data.get("repositoryPath"),
          goal: data.get("goal"),
          acceptance: data.get("acceptance"),
        }),
      });
      closeDialog();
      await loadWorkOrders();
    } catch (error) {
      errorMessage.textContent = messageFrom(error, "创建委托失败");
      submitButton.disabled = false;
      submitButton.textContent = "创建委托";
    }
  });

  async function loadWorkOrders() {
    list.innerHTML = '<div class="loading">正在读取本地委托…</div>';
    try {
      const { workOrders } = await requestJson("/api/work-orders");
      count.textContent = `${workOrders.length} 项`;
      list.innerHTML = "";

      if (workOrders.length === 0) {
        list.append(document.querySelector("#empty-template").content.cloneNode(true));
        return;
      }

      for (const workOrder of workOrders) {
        const card = document.createElement("a");
        card.className = "work-order-card";
        card.href = `/work-orders/${encodeURIComponent(workOrder.id)}`;
        card.innerHTML = `
          <div class="card-topline">
            <span class="status ${statusClass(workOrder)}">${displayStatusLabel(workOrder)}</span>
            <time>${formatDate(workOrder.updatedAt)}</time>
          </div>
          <h3>${escapeHtml(workOrder.title)}</h3>
          <p class="repository">${escapeHtml(shortPath(workOrder.repositoryPath))}</p>
          <div class="card-footer">
            <span>${escapeHtml(workOrder.currentSummary)}</span>
            <b aria-hidden="true">→</b>
          </div>
        `;
        list.append(card);
      }
    } catch {
      list.innerHTML = '<div class="empty-state"><h3>无法连接本地服务</h3><p>请确认 Teamline 正在运行。</p></div>';
    }
  }

  function closeDialog() {
    dialog.close();
    form.reset();
    errorMessage.textContent = "";
    submitButton.disabled = false;
    submitButton.textContent = "创建委托";
  }

  loadWorkOrders();
}

async function loadWorkOrderDetail(id, polling = false) {
  const main = document.querySelector("main");
  if (!polling) {
    main.innerHTML = '<div class="detail-loading">正在读取委托…</div>';
  }

  try {
    const { workOrder } = await requestJson(`/api/work-orders/${encodeURIComponent(id)}`);
    renderWorkOrderDetail(workOrder);
  } catch (error) {
    if (polling) {
      detailRefreshTimer = setTimeout(() => loadWorkOrderDetail(id, true), 4_000);
      return;
    }
    main.innerHTML = `
      <section class="detail-error">
        <p class="eyebrow">工作委托</p>
        <h1>无法打开这项委托</h1>
        <p>${escapeHtml(messageFrom(error, "请返回首页后重试"))}</p>
        <a class="secondary-link" href="/">返回首页</a>
      </section>
    `;
  }
}

function renderWorkOrderDetail(workOrder, draftStages = null, feedback = "") {
  clearTimeout(detailRefreshTimer);
  const main = document.querySelector("main");
  const stages = draftStages ?? workOrder.plan?.stages ?? null;

  main.innerHTML = `
    <section class="detail-page">
      <a class="back-link" href="/">← 返回工作台</a>

      <header class="detail-header">
        <div>
          <div class="detail-meta">
            <span class="status ${statusClass(workOrder)}">${displayStatusLabel(workOrder)}</span>
            <span>${escapeHtml(shortPath(workOrder.repositoryPath))}</span>
          </div>
          <h1>${escapeHtml(workOrder.title)}</h1>
          <p class="detail-goal">${escapeHtml(workOrder.goal)}</p>
        </div>
        ${
          workOrder.acceptance
            ? `<aside class="acceptance-card"><span>完成要求</span><p>${escapeHtml(workOrder.acceptance)}</p></aside>`
            : ""
        }
      </header>

      <section class="plan-panel">
        <div class="plan-heading">
          <div>
            <p class="eyebrow">委托计划</p>
            <h2>${
              stages
                ? workOrder.status === "ready" || draftStages
                  ? "检查并编辑计划"
                  : "已确认计划"
                : "先把工作想清楚"
            }</h2>
          </div>
          ${workOrder.plan ? `<span class="plan-version">版本 ${workOrder.plan.version}</span>` : ""}
        </div>

        ${
          stages
            ? workOrder.status === "ready" || draftStages
              ? renderPlanForm(stages)
              : renderPlanSummary(stages)
            : `
              <div class="plan-empty">
                <p>Codex 会以只读方式查看这个仓库，并把生成计划所需的代码上下文发送给你当前配置的模型服务。它不会在这一步修改代码。</p>
                <div class="plan-actions">
                  <button class="primary-button" id="generate-plan" type="button">生成计划</button>
                  <button class="secondary-button" id="manual-plan" type="button">手动填写</button>
                </div>
              </div>
            `
        }
        <p class="plan-feedback" id="plan-feedback" role="status">${escapeHtml(feedback)}</p>
      </section>

      ${renderExecutionPanel(workOrder)}
    </section>
  `;

  document.querySelector("#generate-plan")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "正在生成…";
    setPlanFeedback("Codex 正在读取仓库并整理计划，这可能需要一点时间。", false);

    try {
      const result = await requestJson(
        `/api/work-orders/${encodeURIComponent(workOrder.id)}/plan/generate`,
        { method: "POST" },
      );
      renderWorkOrderDetail(result.workOrder, null, "计划已经生成，你可以继续编辑。 ");
    } catch (error) {
      button.disabled = false;
      button.textContent = "重新生成";
      setPlanFeedback(messageFrom(error, "生成计划失败，你仍然可以手动填写。"), true);
    }
  });

  document.querySelector("#manual-plan")?.addEventListener("click", () => {
    renderWorkOrderDetail(workOrder, [emptyStage()]);
  });

  const planForm = document.querySelector("#plan-form");
  planForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = document.querySelector("#save-plan");
    submitButton.disabled = true;
    submitButton.textContent = "正在保存…";
    setPlanFeedback("", false);

    try {
      const result = await requestJson(
        `/api/work-orders/${encodeURIComponent(workOrder.id)}/plan`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ stages: readPlanStages() }),
        },
      );
      renderWorkOrderDetail(result.workOrder, null, "计划已保存，等待确认并启动。 ");
    } catch (error) {
      submitButton.disabled = false;
      submitButton.textContent = "保存计划";
      setPlanFeedback(messageFrom(error, "保存计划失败"), true);
    }
  });

  document.querySelector("#add-stage")?.addEventListener("click", () => {
    renderWorkOrderDetail(workOrder, [...readPlanStages(), emptyStage()]);
  });

  document.querySelectorAll("[data-remove-stage]").forEach((button) => {
    button.addEventListener("click", () => {
      const stagesAfterRemoval = readPlanStages();
      stagesAfterRemoval.splice(Number(button.dataset.removeStage), 1);
      renderWorkOrderDetail(workOrder, stagesAfterRemoval.length ? stagesAfterRemoval : [emptyStage()]);
    });
  });

  document.querySelector("#start-work-order")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "正在准备独立工作区…";
    setExecutionFeedback("Teamline 正在创建委托 worktree 并启动 Codex。", false);

    try {
      const result = await requestJson(
        `/api/work-orders/${encodeURIComponent(workOrder.id)}/start`,
        { method: "POST" },
      );
      renderWorkOrderDetail(result.workOrder);
    } catch (error) {
      button.disabled = false;
      button.textContent = "确认并启动";
      setExecutionFeedback(messageFrom(error, "Codex 启动失败，请处理后重试。"), true);
    }
  });

  if (workOrder.runStatus) {
    loadRunEvents(workOrder.id);
  }
  if (workOrder.runStatus === "running") {
    detailRefreshTimer = setTimeout(
      () => loadWorkOrderDetail(workOrder.id, true),
      2_000,
    );
  }
}

function renderPlanForm(stages) {
  return `
    <form id="plan-form">
      <div class="plan-stage-list">
        ${stages
          .map(
            (stage, index) => `
              <article class="plan-stage" data-plan-stage>
                <div class="stage-heading">
                  <span>阶段 ${index + 1}</span>
                  ${stages.length > 1 ? `<button type="button" data-remove-stage="${index}">移除</button>` : ""}
                </div>
                <input type="hidden" name="id" value="${escapeHtml(stage.id ?? "")}" />
                <label>
                  <span>目标结果</span>
                  <textarea name="outcome" rows="2" required>${escapeHtml(stage.outcome ?? "")}</textarea>
                </label>
                <label>
                  <span>预计影响范围</span>
                  <textarea name="scope" rows="2" required>${escapeHtml(stage.scope ?? "")}</textarea>
                </label>
                <label>
                  <span>验证方式</span>
                  <textarea name="verification" rows="2" required>${escapeHtml(stage.verification ?? "")}</textarea>
                </label>
              </article>
            `,
          )
          .join("")}
      </div>
      <div class="plan-form-actions">
        <button class="secondary-button" id="add-stage" type="button">增加阶段</button>
        <button class="primary-button" id="save-plan" type="submit">保存计划</button>
      </div>
    </form>
  `;
}

function renderPlanSummary(stages) {
  return `
    <div class="plan-stage-list">
      ${stages
        .map(
          (stage, index) => `
            <article class="plan-stage plan-stage-readonly">
              <div class="stage-heading"><span>阶段 ${index + 1}</span></div>
              <dl>
                <div><dt>目标结果</dt><dd>${escapeHtml(stage.outcome)}</dd></div>
                <div><dt>预计影响范围</dt><dd>${escapeHtml(stage.scope)}</dd></div>
                <div><dt>验证方式</dt><dd>${escapeHtml(stage.verification)}</dd></div>
              </dl>
            </article>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderExecutionPanel(workOrder) {
  if (workOrder.status === "ready" && !workOrder.runStatus) {
    return `
      <section class="execution-panel start-panel">
        <div>
          <p class="eyebrow">执行确认</p>
          <h2>确认计划并启动 Codex</h2>
          <p>Teamline 会从仓库当前提交创建独立 worktree。Codex 只在该委托工作区内执行。</p>
          <dl class="execution-facts">
            <div><dt>工具</dt><dd>Codex</dd></div>
            <div><dt>工作区</dt><dd>首次启动时创建</dd></div>
          </dl>
        </div>
        <div class="start-actions">
          <button class="primary-button" id="start-work-order" type="button">确认并启动</button>
          <p id="execution-feedback" class="execution-feedback" role="status">${escapeHtml(workOrder.lastError ?? "")}</p>
        </div>
      </section>
    `;
  }

  if (!workOrder.runStatus) {
    return "";
  }

  const runLabel = {
    running: "Codex 运行中",
    completed: "Codex 已结束",
    failed: "Codex 运行失败",
  }[workOrder.runStatus];
  return `
    <section class="execution-panel run-panel">
      <div class="run-heading">
        <div>
          <p class="eyebrow">运行详情</p>
          <h2>${runLabel}</h2>
        </div>
        <span class="run-indicator run-${escapeHtml(workOrder.runStatus)}">${displayRunStatus(workOrder.runStatus)}</span>
      </div>
      <p class="run-summary">${escapeHtml(workOrder.currentSummary)}</p>
      ${workOrder.lastError ? `<p class="run-error">${escapeHtml(workOrder.lastError)}</p>` : ""}
      <dl class="run-facts">
        <div><dt>累计运行时间</dt><dd>${formatDuration(workOrder.runtimeMs)}</dd></div>
        <div><dt>会话标识</dt><dd>${escapeHtml(workOrder.sessionId ?? "等待 Codex 返回")}</dd></div>
        <div><dt>委托分支</dt><dd>${escapeHtml(workOrder.executionBranch ?? "正在准备")}</dd></div>
        <div><dt>委托工作区</dt><dd>${escapeHtml(shortPath(workOrder.worktreePath ?? "正在准备"))}</dd></div>
      </dl>
      <div class="event-section">
        <div class="event-heading"><h3>最近进展</h3><span>自动保存于本机</span></div>
        <div id="run-event-list" class="run-event-list"><p>正在读取最近事件…</p></div>
      </div>
    </section>
  `;
}

async function loadRunEvents(id) {
  const list = document.querySelector("#run-event-list");
  if (!list) return;

  try {
    const { events } = await requestJson(
      `/api/work-orders/${encodeURIComponent(id)}/events`,
    );
    list.innerHTML = events.length
      ? events
          .slice()
          .reverse()
          .map(
            (event) => `
              <article class="run-event">
                <time>${formatDate(event.createdAt)}</time>
                <p>${escapeHtml(event.message)}</p>
              </article>
            `,
          )
          .join("")
      : "<p>Codex 已启动，正在等待第一条进展。</p>";
  } catch (error) {
    list.innerHTML = `<p class="run-error">${escapeHtml(messageFrom(error, "无法读取运行事件"))}</p>`;
  }
}

function readPlanStages() {
  return [...document.querySelectorAll("[data-plan-stage]")].map((stage) => ({
    id: stage.querySelector('[name="id"]').value || undefined,
    outcome: stage.querySelector('[name="outcome"]').value,
    scope: stage.querySelector('[name="scope"]').value,
    verification: stage.querySelector('[name="verification"]').value,
  }));
}

function emptyStage() {
  return { outcome: "", scope: "", verification: "" };
}

function setPlanFeedback(message, isError) {
  const feedback = document.querySelector("#plan-feedback");
  feedback.textContent = message;
  feedback.classList.toggle("is-error", isError);
}

function setExecutionFeedback(message, isError) {
  const feedback = document.querySelector("#execution-feedback");
  feedback.textContent = message;
  feedback.classList.toggle("is-error", isError);
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error ?? "请求失败");
  }
  return result;
}

function messageFrom(error, fallback) {
  return error instanceof Error ? error.message : fallback;
}

function shortPath(path) {
  const pieces = path.split("/").filter(Boolean);
  return pieces.length > 2 ? `…/${pieces.slice(-2).join("/")}` : path;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours} 小时 ${minutes} 分`
    : minutes > 0
      ? `${minutes} 分 ${seconds} 秒`
      : `${seconds} 秒`;
}

function displayStatusLabel(workOrder) {
  if (workOrder.runStatus === "completed") return "Codex 已结束";
  if (workOrder.runStatus === "failed") return "运行失败";
  return statusLabels[workOrder.status] ?? workOrder.status;
}

function statusClass(workOrder) {
  if (workOrder.runStatus === "completed") return "status-run-completed";
  if (workOrder.runStatus === "failed") return "status-interrupted";
  return `status-${escapeHtml(workOrder.status)}`;
}

function displayRunStatus(runStatus) {
  return {
    running: "执行中",
    completed: "已结束",
    failed: "需要处理",
  }[runStatus];
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
