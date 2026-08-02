const statusLabels = {
  draft: "草稿",
  ready: "待确认",
  running: "进行中",
  interrupted: "已中断",
  review: "待验收",
  completed: "已完成",
};

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
    const response = await fetch("/api/work-orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repositoryPath: data.get("repositoryPath"),
        goal: data.get("goal"),
        acceptance: data.get("acceptance"),
      }),
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error ?? "创建委托失败");
    }

    closeDialog();
    await loadWorkOrders();
  } catch (error) {
    errorMessage.textContent = error instanceof Error ? error.message : "创建委托失败";
    submitButton.disabled = false;
    submitButton.textContent = "创建委托";
  }
});

async function loadWorkOrders() {
  list.innerHTML = '<div class="loading">正在读取本地委托…</div>';
  try {
    const response = await fetch("/api/work-orders");
    const { workOrders } = await response.json();
    renderWorkOrders(workOrders);
  } catch {
    list.innerHTML = '<div class="empty-state"><h3>无法连接本地服务</h3><p>请确认 Teamline 正在运行。</p></div>';
  }
}

function renderWorkOrders(workOrders) {
  count.textContent = `${workOrders.length} 项`;
  list.innerHTML = "";

  if (workOrders.length === 0) {
    list.append(document.querySelector("#empty-template").content.cloneNode(true));
    return;
  }

  for (const workOrder of workOrders) {
    const card = document.createElement("article");
    card.className = "work-order-card";
    card.innerHTML = `
      <div class="card-topline">
        <span class="status status-${escapeHtml(workOrder.status)}">${statusLabels[workOrder.status]}</span>
        <time>${formatDate(workOrder.updatedAt)}</time>
      </div>
      <h3>${escapeHtml(workOrder.title)}</h3>
      <p class="repository">${escapeHtml(shortPath(workOrder.repositoryPath))}</p>
      <div class="card-footer">
        <span>${escapeHtml(workOrder.currentSummary)}</span>
      </div>
    `;
    list.append(card);
  }
}

function closeDialog() {
  dialog.close();
  form.reset();
  errorMessage.textContent = "";
  submitButton.disabled = false;
  submitButton.textContent = "创建委托";
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

loadWorkOrders();
