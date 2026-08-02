const statusLabels = {
  draft: "草稿",
  ready: "待确认",
  running: "进行中",
  interrupted: "已中断",
  review: "待验收",
  completed: "已完成",
};

const detailMatch = window.location.pathname.match(/^\/work-orders\/([^/]+)$/);

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
            <span class="status status-${escapeHtml(workOrder.status)}">${statusLabels[workOrder.status]}</span>
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

async function loadWorkOrderDetail(id) {
  const main = document.querySelector("main");
  main.innerHTML = '<div class="detail-loading">正在读取委托…</div>';

  try {
    const { workOrder } = await requestJson(`/api/work-orders/${encodeURIComponent(id)}`);
    renderWorkOrderDetail(workOrder);
  } catch (error) {
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
  const main = document.querySelector("main");
  const stages = draftStages ?? workOrder.plan?.stages ?? null;

  main.innerHTML = `
    <section class="detail-page">
      <a class="back-link" href="/">← 返回工作台</a>

      <header class="detail-header">
        <div>
          <div class="detail-meta">
            <span class="status status-${escapeHtml(workOrder.status)}">${statusLabels[workOrder.status]}</span>
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
            <h2>${stages ? "检查并编辑计划" : "先把工作想清楚"}</h2>
          </div>
          ${workOrder.plan ? `<span class="plan-version">版本 ${workOrder.plan.version}</span>` : ""}
        </div>

        ${
          stages
            ? renderPlanForm(stages)
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
