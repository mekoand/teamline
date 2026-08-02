const statusLabels = {
  draft: "草稿",
  ready: "待确认",
  running: "进行中",
  interrupted: "已中断",
  review: "待验收",
  delivered: "已交付",
};

const homeGroupDefinitions = [
  {
    id: "attention",
    title: "需要处理",
    statuses: ["draft", "ready", "interrupted"],
  },
  { id: "active", title: "进行中", statuses: ["running"] },
  { id: "review", title: "待验收", statuses: ["review"] },
  { id: "delivered", title: "最近交付", statuses: ["delivered"] },
];

const workOrderAnchorPrefix = "work-order-";

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

      for (const group of groupWorkOrders(workOrders)) {
        if (group.workOrders.length === 0) continue;

        const section = document.createElement("section");
        section.className = "work-order-group";
        section.setAttribute("aria-labelledby", `work-order-group-${group.id}`);
        section.innerHTML = `
          <div class="work-order-group-heading">
            <h3 id="work-order-group-${group.id}">${group.title}</h3>
            <span>${group.workOrders.length} 项</span>
          </div>
          <div class="work-order-grid"></div>
        `;

        const groupList = section.querySelector(".work-order-grid");
        for (const workOrder of group.workOrders) {
          groupList.append(createWorkOrderCard(workOrder));
        }
        list.append(section);
      }

      restoreHomeAnchor();
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
      <a class="back-link" href="/#${workOrderAnchor(workOrder.id)}">← 返回工作台</a>

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
          workOrder.revisionNote
            ? `<aside class="revision-note"><strong>补充要求</strong><p>${escapeHtml(workOrder.revisionNote)}</p></aside>`
            : ""
        }

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
      ${renderResultPanel(workOrder)}
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

  document.querySelector("#interrupt-work-order")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "正在停止…";
    setExecutionFeedback("正在请求 Codex 停止；进程退出后委托才会标为已中断。", false);
    try {
      const result = await requestJson(
        `/api/work-orders/${encodeURIComponent(workOrder.id)}/interrupt`,
        { method: "POST" },
      );
      renderWorkOrderDetail(result.workOrder);
    } catch (error) {
      button.disabled = false;
      button.textContent = "中断运行";
      setExecutionFeedback(messageFrom(error, "无法中断 Codex，请重试。"), true);
    }
  });

  document.querySelector("#continue-work-order")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "正在继续…";
    setExecutionFeedback("正在从已保存的会话或当前现场继续委托。", false);
    try {
      const result = await requestJson(
        `/api/work-orders/${encodeURIComponent(workOrder.id)}/continue`,
        { method: "POST" },
      );
      renderWorkOrderDetail(result.workOrder);
    } catch (error) {
      button.disabled = false;
      button.textContent = "继续委托";
      setExecutionFeedback(messageFrom(error, "无法继续委托，请处理后重试。"), true);
    }
  });

  document.querySelector("#deliver-work-order")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "正在确认…";
    setResultFeedback("", false);
    try {
      const result = await requestJson(
        `/api/work-orders/${encodeURIComponent(workOrder.id)}/deliver`,
        { method: "POST" },
      );
      renderWorkOrderDetail(result.workOrder);
    } catch (error) {
      button.disabled = false;
      button.textContent = "确认已交付";
      setResultFeedback(messageFrom(error, "无法确认交付，请重试。"), true);
    }
  });

  document.querySelector("#revision-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = document.querySelector("#revise-work-order");
    const revisionNote = new FormData(event.currentTarget).get("revisionNote");
    button.disabled = true;
    button.textContent = "正在保存…";
    setResultFeedback("", false);
    try {
      const result = await requestJson(
        `/api/work-orders/${encodeURIComponent(workOrder.id)}/revise`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ revisionNote }),
        },
      );
      renderWorkOrderDetail(result.workOrder, null, "补充要求已保存，请检查并再次确认计划。");
    } catch (error) {
      button.disabled = false;
      button.textContent = "补充要求并继续";
      setResultFeedback(messageFrom(error, "无法保存补充要求，请重试。"), true);
    }
  });

  if (workOrder.runStatus) {
    loadRunEvents(workOrder.id);
  }
  if (["running", "stopping", "verifying"].includes(workOrder.runStatus)) {
    detailRefreshTimer = setTimeout(
      () => loadWorkOrderDetail(workOrder.id, true),
      2_000,
    );
  }
}

function groupWorkOrders(workOrders) {
  return homeGroupDefinitions.map((group) => ({
    ...group,
    workOrders: workOrders
      .filter((workOrder) => group.statuses.includes(workOrder.status))
      .sort((left, right) => new Date(right.updatedAt) - new Date(left.updatedAt)),
  }));
}

function createWorkOrderCard(workOrder) {
  const card = document.createElement("a");
  card.className = "work-order-card";
  card.id = workOrderAnchor(workOrder.id);
  card.href = `/work-orders/${encodeURIComponent(workOrder.id)}`;
  card.innerHTML = `
    <div class="card-topline">
      <span class="status ${statusClass(workOrder)}">${displayStatusLabel(workOrder)}</span>
      <time>${formatDate(workOrder.updatedAt)}</time>
    </div>
    <h3>${escapeHtml(workOrder.title)}</h3>
    <p class="repository"><span>仓库</span>${escapeHtml(shortPath(workOrder.repositoryPath))}</p>
    <div class="card-progress">
      <span>最近进展</span>
      <p>${escapeHtml(workOrder.currentSummary)}</p>
    </div>
    <dl class="card-facts">
      <div>
        <dt>累计运行时间</dt>
        <dd>${formatDuration(workOrder.runtimeMs)}</dd>
      </div>
      <div class="card-next-action">
        <dt>下一步</dt>
        <dd>${escapeHtml(nextActionFor(workOrder))}</dd>
      </div>
    </dl>
    <div class="card-footer">
      <span>打开委托</span>
      <b aria-hidden="true">→</b>
    </div>
  `;
  card.addEventListener("click", (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    window.history.replaceState(null, "", `/#${card.id}`);
  });
  return card;
}

function nextActionFor(workOrder) {
  const runAction = {
    running: "查看运行进展",
    stopping: "等待 Codex 停止",
    verifying: "等待验证完成",
    interrupted: "继续委托",
    failed: "处理错误并继续委托",
  }[workOrder.runStatus];
  if (runAction) return runAction;

  if (workOrder.runStatus === "completed" && workOrder.status === "running") {
    return "等待结果整理完成";
  }

  return {
    draft: "生成或填写计划",
    ready: "确认计划并启动",
    running: "查看运行进展",
    interrupted: "继续委托",
    review: "查看结果并确认已交付",
    delivered: "查看已交付结果",
  }[workOrder.status] ?? "打开委托查看详情";
}

function workOrderAnchor(id) {
  return `${workOrderAnchorPrefix}${id}`;
}

function restoreHomeAnchor() {
  const anchor = window.location.hash.slice(1);
  if (!anchor.startsWith(workOrderAnchorPrefix)) return;

  const card = document.getElementById(anchor);
  if (!card) return;

  window.requestAnimationFrame(() => {
    card.scrollIntoView({ block: "center" });
  });
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
                <label>
                  <span>自动验证命令（可选）</span>
                  <input name="verificationCommand" value="${escapeHtml(stage.verificationCommand ?? "")}" placeholder="例如：bun test" />
                  <small>确认并启动后，Codex 正常退出时才会在委托工作区运行此命令。验证方式中的自然语言不会执行。</small>
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
                <div><dt>自动验证命令</dt><dd><code>${escapeHtml(stage.verificationCommand || "未配置自动验证命令")}</code></dd></div>
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
    stopping: "正在停止 Codex",
    verifying: "正在整理变化并执行验证",
    interrupted: "Codex 已中断",
    completed: "Codex 已结束",
    failed: "委托已中断",
  }[workOrder.runStatus];
  const runAction =
    workOrder.runStatus === "running"
      ? '<button class="secondary-button" id="interrupt-work-order" type="button">中断运行</button>'
      : workOrder.runStatus === "stopping"
        ? '<button class="secondary-button" type="button" disabled>正在停止…</button>'
        : workOrder.status === "interrupted"
          ? '<button class="primary-button" id="continue-work-order" type="button">继续委托</button>'
          : "";
  return `
    <section class="execution-panel run-panel">
      <div class="run-heading">
        <div>
          <p class="eyebrow">运行详情</p>
          <h2>${runLabel}</h2>
        </div>
        <div class="run-actions">
          <span class="run-indicator run-${escapeHtml(workOrder.runStatus)}">${displayRunStatus(workOrder.runStatus)}</span>
          ${runAction}
        </div>
      </div>
      <p class="run-summary">${escapeHtml(workOrder.currentSummary)}</p>
      ${workOrder.lastError ? `<p class="run-error">${escapeHtml(workOrder.lastError)}</p>` : ""}
      <p id="execution-feedback" class="execution-feedback" role="status"></p>
      <dl class="run-facts">
        <div><dt>累计运行时间</dt><dd>${formatDuration(workOrder.runtimeMs)}</dd></div>
        <div><dt>当前运行记录</dt><dd>第 ${workOrder.runNumber} 次运行</dd></div>
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

function renderResultPanel(workOrder) {
  if (!workOrder.result || ["ready", "running"].includes(workOrder.status)) return "";
  const isReviewResult = ["review", "delivered"].includes(workOrder.status);
  const isHistoricalResult = workOrder.result.planVersion !== workOrder.plan?.version;
  const verificationItems = workOrder.result.verifications
    .map((verification) => {
      const label = {
        passed: "通过",
        failed: "失败",
        not_configured: "未配置",
      }[verification.status];
      return `
        <article class="verification-result verification-${escapeHtml(verification.status)}">
          <div class="verification-heading">
            <b>${escapeHtml(verification.stageOutcome)}</b>
            <span>${label}</span>
          </div>
          <p><code>${escapeHtml(verification.command || "未配置自动验证命令")}</code></p>
          ${verification.exitCode === null ? "" : `<p>退出码：${verification.exitCode}</p>`}
          <pre>${escapeHtml(verification.output)}</pre>
        </article>
      `;
    })
    .join("");
  const reviewActions =
    workOrder.status === "review"
      ? `
        <div class="review-actions">
          <button class="primary-button" id="deliver-work-order" type="button">确认已交付</button>
          <form id="revision-form">
            <label>
              <span>还有补充要求？</span>
              <textarea name="revisionNote" rows="3" required placeholder="说明需要继续处理的内容"></textarea>
            </label>
            <button class="secondary-button" id="revise-work-order" type="submit">补充要求并继续</button>
          </form>
        </div>
      `
      : workOrder.status === "delivered"
        ? '<p class="delivered-note">这项委托已经由你确认交付。</p>'
        : "";
  return `
    <section class="result-panel">
      <div class="result-heading">
        <div><p class="eyebrow">${isReviewResult ? "验收结果" : "最近一次执行结果"}</p><h2>代码变化与检查结果</h2></div>
        <span>计划版本 ${workOrder.result.planVersion}</span>
      </div>
      ${isHistoricalResult ? `<p class="historical-result-note">这是计划版本 ${workOrder.result.planVersion} 的历史结果，当前计划为版本 ${workOrder.plan?.version ?? "未知"}。</p>` : ""}
      <div class="git-summary">
        <h3>Git 变化摘要</h3>
        <p>相对起始提交 <code>${escapeHtml(workOrder.baseCommit ?? "未知")}</code></p>
        <pre>${escapeHtml(workOrder.result.git.diffStat)}</pre>
        <pre>${escapeHtml(workOrder.result.git.statusShort)}</pre>
      </div>
      <div class="verification-results">
        <h3>验证结果</h3>
        ${verificationItems}
      </div>
      ${reviewActions}
      <p id="result-feedback" class="execution-feedback" role="status"></p>
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
                <div class="run-event-meta">
                  <b>第 ${event.runNumber} 次运行</b>
                  <time>${formatDate(event.createdAt)}</time>
                </div>
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
    verificationCommand: stage.querySelector('[name="verificationCommand"]').value,
  }));
}

function emptyStage() {
  return { outcome: "", scope: "", verification: "", verificationCommand: "" };
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

function setResultFeedback(message, isError) {
  const feedback = document.querySelector("#result-feedback");
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
  if (workOrder.runStatus === "stopping") return "正在停止";
  if (workOrder.runStatus === "verifying") return "正在验证";
  if (["interrupted", "failed"].includes(workOrder.runStatus)) return "已中断";
  if (workOrder.runStatus === "completed" && workOrder.status === "running") return "Codex 已结束";
  return statusLabels[workOrder.status] ?? workOrder.status;
}

function statusClass(workOrder) {
  if (workOrder.runStatus === "stopping") return "status-running";
  if (workOrder.runStatus === "verifying") return "status-running";
  if (workOrder.runStatus === "interrupted") return "status-interrupted";
  if (workOrder.runStatus === "completed" && workOrder.status === "running") return "status-run-completed";
  if (workOrder.runStatus === "failed") return "status-interrupted";
  return `status-${escapeHtml(workOrder.status)}`;
}

function displayRunStatus(runStatus) {
  return {
    running: "执行中",
    stopping: "正在停止",
    verifying: "正在验证",
    interrupted: "已中断",
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
