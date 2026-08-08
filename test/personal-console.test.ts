import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { WorkOrderStore } from "../src/work-order-store";

describe("personal console", () => {
  test("serves the formal three-column workspace with a persistent theme control", async () => {
    const app = createApp({ store: new WorkOrderStore(new Database(":memory:")) });

    const [pageResponse, scriptResponse] = await Promise.all([
      app.fetch(new Request("http://teamline.local/")),
      app.fetch(new Request("http://teamline.local/app.js")),
    ]);
    const page = await pageResponse.text();
    const script = await scriptResponse.text();

    expect(pageResponse.status).toBe(200);
    expect(page).toContain('class="console-shell"');
    expect(page).toContain('id="work-order-list"');
    expect(page).toContain('id="work-order-workspace"');
    expect(page).toContain('id="context-panel"');
    expect(page).toContain('id="theme-toggle"');
    expect(page).not.toContain('id="max-concurrency"');
    expect(script).toContain('localStorage.getItem("teamline-theme")');
    expect(script).toContain('localStorage.setItem("teamline-theme"');
    expect(script).toContain('"/api/execution-settings"');
    expect(script).toContain("state.workOrders.some((workOrder)");
    expect(script).toContain('workOrder.importContext?.status === "pending"');
    expect(script).toContain("最近完成节点");
    expect(script).toContain("继续当前现场");
    expect(script).toContain("从最近节点重新执行");
    expect(script).toContain("回到当前节点");
    expect(script).toContain('data-progress-view="timeline"');
    expect(script).toContain('>节点图</button>');
    expect(script).toContain("历史推断");
    expect(script).toContain("工具与日志");
    expect(script).toContain("event.stageId === stage.id");
    expect(script).not.toContain(
      'event.runNumber === workOrder.runNumber &&\n      event.stageId === stage.id',
    );
  });

  test("makes all goals the home view and keeps detail context separate from the primary work surface", async () => {
    const app = createApp({ store: new WorkOrderStore(new Database(":memory:")) });
    const [page, script, styles, projectsPageResponse] = await Promise.all([
      app.fetch(new Request("http://teamline.local/")).then((response) => response.text()),
      app.fetch(new Request("http://teamline.local/app.js")).then((response) => response.text()),
      app.fetch(new Request("http://teamline.local/styles.css")).then((response) => response.text()),
      app.fetch(new Request("http://teamline.local/projects")),
    ]);

    expect(page).toContain('id="open-all-goals"');
    expect(page).toContain('id="open-projects"');
    expect(projectsPageResponse.status).toBe(200);
    expect(script).toContain("renderAllGoalsWorkspace");
    expect(script).toContain('["response", visibleStatusLabels.response]');
    expect(script).toContain('["review", visibleStatusLabels.review]');
    expect(script).toContain('["running", visibleStatusLabels.running]');
    expect(script).toContain('["planning", visibleStatusLabels.planning]');
    expect(script).toContain('["queued", visibleStatusLabels.queued]');
    expect(script).toContain('["completed", visibleStatusLabels.completed]');
    expect(script).toContain('data-home-status="${status}"');
    expect(script).toContain('id="open-create-home"');
    expect(script).toContain('id="open-session-import-home"');
    expect(script).toContain("renderPrimaryWorkSurface");
    expect(script).toContain("formatVisibleStatus");
    expect(script).not.toContain('<span class="dependency-label">依赖：无</span>');
    expect(script).not.toContain("\${renderRecoveryPanel(workOrder)}");
    expect(script).not.toContain("\${renderRunPanel(workOrder)}");
    expect(styles).toContain(".home-status-section");
  });

  test("groups the home view by project with a seven-day default and operational goal summaries", async () => {
    const app = createApp({ store: new WorkOrderStore(new Database(":memory:")) });
    const [script, styles] = await Promise.all([
      app.fetch(new Request("http://teamline.local/app.js")).then((response) => response.text()),
      app.fetch(new Request("http://teamline.local/styles.css")).then((response) => response.text()),
    ]);

    expect(script).toContain('homeHistoryFilter: "7"');
    expect(script).toContain('["current", "当前"]');
    expect(script).toContain('["7", "7 天"]');
    expect(script).toContain('["30", "30 天"]');
    expect(script).toContain('["all", "全部"]');
    expect(script).toContain("const active = visibleStatus(workOrder, state.workOrders).status !== \"completed\"");
    expect(script).toContain("homeProjectGroups");
    expect(script).toContain('data-label="当前节点"');
    expect(script).toContain('data-label="状态"');
    expect(script).toContain('data-label="下一步"');
    expect(script).toContain("new Set(identities.map((identity) => identity.id)).size <= 1");
    expect(styles).toContain(".home-project-groups");
    expect(styles).toContain(".goal-account-tag");
  });

  test("keeps removed account labels on historical goals", async () => {
    const app = createApp({ store: new WorkOrderStore(new Database(":memory:")) });
    const script = await (await app.fetch(new Request("http://teamline.local/app.js"))).text();

    expect(script).toContain("new Set(identities.map((identity) => identity.id)).size <= 1");
    expect(script).toContain('identity.status === "removed" ? " · 已移除"');
    expect(script).not.toContain('state.executionIdentities.identities.filter(\n    (identity) => identity.status !== "removed"');
  });

  test("uses a dismissible narrow-screen inspector with balanced Chinese wrapping", async () => {
    const app = createApp({ store: new WorkOrderStore(new Database(":memory:")) });
    const [page, script, styles, inspectorResponse] = await Promise.all([
      app.fetch(new Request("http://teamline.local/")).then((response) => response.text()),
      app.fetch(new Request("http://teamline.local/app.js")).then((response) => response.text()),
      app.fetch(new Request("http://teamline.local/styles.css")).then((response) => response.text()),
      app.fetch(new Request("http://teamline.local/context-inspector.js")),
    ]);

    expect(script).toContain('class="mobile-back-button"');
    expect(script).toContain('id="back-to-all-goals"');
    expect(script).toContain('id="open-goal-context"');
    expect(page).toContain('id="context-backdrop"');
    expect(page).toContain('aria-label="上下文检查栏"');
    expect(script).toContain("selectContextInspector");
    expect(script).toContain("closeContextInspector");
    expect(script).toContain('event.key !== "Escape"');
    expect(script).toContain("state.inspector.busy");
    expect(script).toContain('contextElement.toggleAttribute("inert", state.inspector.busy)');
    expect(script).toContain("setContextInspectorBusy(state.inspector, false)");
    expect(inspectorResponse.status).toBe(200);
    expect(styles).toContain("@media (max-width: 1120px) and (min-width: 980px)");
    expect(styles).toContain("@media (max-width: 979px)");
    expect(styles).not.toContain("@media (max-width: 880px) {\n  .console-shell.context-open");
    expect(styles).toContain("@media (max-width: 680px)");
    expect(styles).toContain(".console-shell.context-open .context-backdrop");
    expect(styles).toContain("width: min(360px, calc(100vw - 28px))");
    expect(styles).toContain("text-wrap: balance");
    expect(styles).toContain("word-break: auto-phrase");
  });

  test("keeps primary actions in the work surface and limits the inspector to selected context", async () => {
    const app = createApp({ store: new WorkOrderStore(new Database(":memory:")) });
    const [script, styles] = await Promise.all([
      app.fetch(new Request("http://teamline.local/app.js")).then((response) => response.text()),
      app.fetch(new Request("http://teamline.local/styles.css")).then((response) => response.text()),
    ]);

    const contextStart = script.indexOf("function renderContext(workOrder)");
    const contextEnd = script.indexOf("function renderGoalResourceSettings", contextStart);
    const contextRenderer = script.slice(contextStart, contextEnd);
    const mapStart = script.indexOf("function renderExecutionMap(workOrder, stages)");
    const mapEnd = script.indexOf("function renderMapNode", mapStart);
    const mapRenderer = script.slice(mapStart, mapEnd);
    expect(script).toContain('<div class="primary-action-slot">${renderContextAction(workOrder)}</div>');
    expect(script).not.toContain('<div class="workspace-support">${renderContextSupport(workOrder)}</div>');
    expect(contextRenderer).not.toContain("renderContextAction(workOrder)");
    expect(contextRenderer).not.toContain("renderContextSupport(workOrder)");
    expect(contextRenderer).toContain('selection.type === "artifact"');
    expect(contextRenderer).toContain("renderGoalContext(workOrder)");
    expect(contextRenderer).toContain("renderContextTabContent(workOrder, stage)");
    expect(contextRenderer).toContain("renderTechnicalActivity(workOrder)");
    expect(mapRenderer).not.toContain("renderTechnicalActivity(workOrder)");
    expect(script).toContain('data-result-artifact="${escapeHtml(reference.location)}"');
    expect(script).toContain('workOrder.workspace?.kind === "git" && Boolean(workOrder.worktreePath)');
    expect(script).toContain('openContextInspector({ type: "stage", id: stage.id })');
    expect(styles).toContain(".console-shell.context-open");
    expect(styles).toContain(".primary-action-slot .context-action");
  });

  test("uses the shared inspector for selected project and resource details", async () => {
    const app = createApp({ store: new WorkOrderStore(new Database(":memory:")) });
    const [script, styles] = await Promise.all([
      app.fetch(new Request("http://teamline.local/app.js")).then((response) => response.text()),
      app.fetch(new Request("http://teamline.local/styles.css")).then((response) => response.text()),
    ]);

    expect(script).toContain('state.inspector.open ? renderProjectContext() : ""');
    expect(script).toContain('state.inspector.open ? renderResourceContext() : ""');
    expect(script).toContain('type: "project-material"');
    expect(script).toContain('type: "project-result"');
    expect(script).toContain('type: "resource-account"');
    expect(script).toContain('type: "resource-work-order"');
    expect(script).toContain('data-project-material-id=');
    expect(script).toContain('data-project-result-id=');
    expect(script).toContain('data-resource-account-id=');
    expect(script).toContain('data-resource-work-order-id=');
    expect(script).toContain("可归因用量");
    expect(script).not.toContain("<h2>当前安排</h2>");
    expect(script).not.toContain("<summary>数据来源与口径</summary>");
    expect(styles).toContain(".inspector-selection-button");
    expect(styles).toContain(".context-quota-windows");
  });

  test("clears a goal inspector before opening resources from the quota summary", async () => {
    const app = createApp({ store: new WorkOrderStore(new Database(":memory:")) });
    const script = await (await app.fetch(new Request("http://teamline.local/app.js"))).text();
    const summaryStart = script.indexOf("function renderResourceSummary()");
    const summaryEnd = script.indexOf("function renderTopbarAccountQuota", summaryStart);
    const summaryRenderer = script.slice(summaryStart, summaryEnd);

    expect(summaryRenderer.match(/resetGoalSelection\(\)/g)).toHaveLength(2);
    expect(summaryRenderer).toContain('history.pushState({}, "", "/resources")');
  });

  test("keeps creation goal-first and defers the local workspace choice until start", async () => {
    const app = createApp({ store: new WorkOrderStore(new Database(":memory:")) });
    const [pageResponse, scriptResponse] = await Promise.all([
      app.fetch(new Request("http://teamline.local/")),
      app.fetch(new Request("http://teamline.local/app.js")),
    ]);
    const page = await pageResponse.text();
    const script = await scriptResponse.text();

    expect(page.indexOf('name="goal"')).toBeLessThan(page.indexOf('id="material-list"'));
    expect(page).not.toContain('name="repositoryPath"');
    expect(page).toContain('id="add-material"');
    expect(script).toContain('id="workspace-form"');
    expect(script).toContain('/workspace`');
  });

  test("keeps completed output and slow planning guidance visible", async () => {
    const app = createApp({ store: new WorkOrderStore(new Database(":memory:")) });
    const script = await (await app.fetch(new Request("http://teamline.local/app.js"))).text();

    expect(script).toContain("Codex 完成摘要");
    expect(script).toContain("completionSummaryForStage");
    expect(script).toContain("localArtifactReferences");
    expect(script).toContain("workOrder.result.artifacts");
    expect(script).toContain("打开文件");
    expect(script).toContain("打开所在位置");
    expect(script).toContain("本轮新建或修改的文件，最多显示 100 项");
    expect(script).toContain("/artifacts/open`");
    expect(script).toContain("生成计划通常需要 30–90 秒");
  });

  test("keeps the topbar controls aligned and Chinese headings phrase-aware", async () => {
    const app = createApp({ store: new WorkOrderStore(new Database(":memory:")) });
    const styles = await (await app.fetch(new Request("http://teamline.local/styles.css"))).text();

    expect(styles).toContain(".resource-concurrency-control > span");
    expect(styles).toContain("word-break: auto-phrase");
  });

  test("offers external work selection and a result-reference next step", async () => {
    const app = createApp({ store: new WorkOrderStore(new Database(":memory:")) });
    const script = await (await app.fetch(new Request("http://teamline.local/app.js"))).text();

    expect(script).toContain('<select name="executionMethod" data-execution-method>');
    expect(script).toContain('<option value="external"');
    expect(script).toContain('id="external-completion-form"');
    expect(script).toContain("Teamline 只保存结论和原始位置，不复制或自动核验正文。");
    expect(script).toContain("/complete-external`");
    expect(script).toContain('["ready", "interrupted"].includes(workOrder.status)');
    expect(script).toContain(
      'workOrder.status === "interrupted" ||\n      workOrder.status === "review"',
    );
    expect(script).not.toContain(
      'workOrder.plan?.stages?.some((candidate) => candidate.executionMethod === "external");',
    );
  });

  test("serves the resource summary and resource-page navigation", async () => {
    const app = createApp({ store: new WorkOrderStore(new Database(":memory:")) });

    const [pageResponse, scriptResponse] = await Promise.all([
      app.fetch(new Request("http://teamline.local/resources")),
      app.fetch(new Request("http://teamline.local/app.js")),
    ]);
    const page = await pageResponse.text();
    const script = await scriptResponse.text();

    expect(pageResponse.status).toBe(200);
    expect(page).toContain('id="resource-summary"');
    expect(page).toContain('id="open-resources"');
    expect(script).toContain('requestJson("/api/resources")');
    expect(script).toContain('loading: "正在读取"');
    expect(script).toContain('state.resources?.openaiApi.status === "loading"');
    expect(script).toContain("refreshResources");
    expect(script).not.toContain(
      'const [{ workOrders }, resources] = await Promise.all',
    );
    expect(script).toContain("resource-workspace");
    expect(script).toContain("renderCodexAccountQuota");
    expect(script).toContain('backupStatus === "available"');
    expect(script).toContain('backupStatus === "unknown"');
    expect(script).toContain('available: "额度可读取"');
    expect(script).toContain("workOrder.usage.message");
    expect(script).toContain('id="max-concurrency"');
    expect(script).toContain('id="goal-resource-form"');
    expect(script).toContain("资源设置 ·");
    expect(script).toContain('presentation.message.code === "status.awaiting_capacity"');
    expect(script).not.toContain(
      'const queued = visibleStatus(workOrder, state.workOrders).status === "queued"',
    );
    expect(script).toContain("Codex 额度</span>");
    expect(script).not.toContain("${runningCount} 项运行中</span>\n      </button>");
  });

  test("shows compact account quota controls and wires managed-account login polling", async () => {
    const app = createApp({ store: new WorkOrderStore(new Database(":memory:")) });
    const [script, styles] = await Promise.all([
      app.fetch(new Request("http://teamline.local/app.js")).then((response) => response.text()),
      app.fetch(new Request("http://teamline.local/styles.css")).then((response) => response.text()),
    ]);

    expect(script).toContain('class="topbar-quota-control"');
    expect(script).toContain('removeAttribute("open")');
    expect(script).toContain('renderQuotaWindow("5 小时"');
    expect(script).toContain('renderQuotaWindow("周额度"');
    expect(script).toContain("Array.isArray(resources.codexAccounts)");
    expect(script).toContain("还没有可用账号，可以先添加一个。");
    expect(script).toContain('"备用账号可用": "备用可用"');
    expect(script).toContain('"备用账号额度未知": "备用未知"');
    expect(script).toContain("data-login-identity");
    expect(script).toContain('id="add-identity-form"');
    expect(script).toContain('requestJson("/api/execution-identities"');
    expect(script).toContain("添加并登录");
    expect(script).toContain("JSON.stringify({ confirm: true })");
    expect(script).toContain("/login`");
    expect(script).toContain('current.login.status === "in_progress"');
    expect(script).toContain('result.login.status === "completed"');
    expect(script).toContain("identityLoginChecks: new Set()");
    expect(script).toContain("resumeIdentityLoginChecks()");
    expect(script).toContain("recoverIdentityLoginState");
    expect(script).toContain('identity.status === "enabled"');
    expect(script).toContain('if (identity.loginState === "ready")');
    expect(script).toContain("refreshIdentityAfterLogin");
    expect(script).toContain("/refresh`");
    expect(styles).toContain(".topbar-quota-popover");
    expect(styles).toContain(".identity-actions");
  });

  test("keeps the execution graph primary while prioritizing artifacts and verification", async () => {
    const app = createApp({ store: new WorkOrderStore(new Database(":memory:")) });
    const script = await (await app.fetch(new Request("http://teamline.local/app.js"))).text();

    expect(script).toContain('progressView: "map"');
    expect(script).toContain('contextTab: "artifacts"');
    expect(script).toContain("defaultGoalWorkbenchView(presentation.status)");
    expect(script).toContain('workOrder.importContext?.status === "ready" && !workOrder.plan');
    expect(script).toContain("workOrder.plan?.stages?.[preferredStageIndex(workOrder)]");
    expect(script).toContain('workOrder.importContext?.status === "pending"');
    expect(script).toContain('workOrder.importContext?.status === "failed"');
    expect(script).toContain('["progress", "进展"]');
    expect(script).toContain('["conversation", "对话"]');
    expect(script).toContain('["result", "成果"]');
    expect(script).toContain("从这里开始由 Teamline 推进");
    expect(script).toContain("完整工具与日志");
  });

  test("offers one local session import flow for Codex and Claude Code", async () => {
    const app = createApp({ store: new WorkOrderStore(new Database(":memory:")) });
    const [pageResponse, scriptResponse] = await Promise.all([
      app.fetch(new Request("http://teamline.local/")),
      app.fetch(new Request("http://teamline.local/app.js")),
    ]);
    const page = await pageResponse.text();
    const script = await scriptResponse.text();

    expect(page).toContain('id="open-session-import"');
    expect(page).toContain('id="session-import-dialog"');
    const sidebar = page.match(/<aside class="order-sidebar"[\s\S]*?<\/aside>/)?.[0] ?? "";
    const createDialog = page.match(/<dialog id="create-dialog"[\s\S]*?<\/dialog>/)?.[0] ?? "";
    expect(sidebar).not.toContain('id="open-session-import"');
    expect(createDialog).toContain('id="open-session-import"');
    expect(page).toContain("不会继续运行原会话");
    expect(page).toContain('id="session-import-source"');
    expect(page).toContain('<option value="claude_code">Claude Code</option>');
    expect(page).toContain("只导入并整理状态");
    expect(script).toContain('`/api/sessions?source=${encodeURIComponent(state.sessionSource)}`');
    expect(script).toContain('requestJson("/api/sessions/import"');
    expect(script).toContain("sessionSelectedIds");
    expect(script).toContain("sessionIds");
    expect(script).toContain("codex://threads/");
    expect(script).toContain("复制 CLI 命令");
    expect(script).toContain("仅导入与状态整理");
    expect(script).toContain("shortSessionId(session.id)");
    expect(script).toContain("isImportOnlyGoal(workOrder)");
    expect(script).toContain("当前版本不会从 Claude Code 来源目标生成计划或开始执行");
    expect(script).toContain('workOrder.importOnly ? \'<p class="source-import-only">');
    expect(script).not.toContain("data-session-goal");
  });

  test("confirms an editable imported goal while generating the follow-up plan", async () => {
    const app = createApp({ store: new WorkOrderStore(new Database(":memory:")) });
    const [page, script] = await Promise.all([
      app.fetch(new Request("http://teamline.local/")).then((response) => response.text()),
      app.fetch(new Request("http://teamline.local/app.js")).then((response) => response.text()),
    ]);

    expect(page).not.toContain('id="continue-goal-dialog"');
    expect(script).toContain('id="workbench-goal-input"');
    expect(script).toContain("生成后续计划");
    expect(script).toContain('JSON.stringify({ goal })');
    expect(script).not.toContain("data-continue-imported-goal");
  });

  test("keeps resource provenance secondary and out of the default workspace", async () => {
    const app = createApp({ store: new WorkOrderStore(new Database(":memory:")) });
    const script = await (await app.fetch(new Request("http://teamline.local/app.js"))).text();

    expect(script).toContain("额度状态");
    expect(script).toContain("目标资源");
    expect(script).not.toContain('<details class="resource-details">');
    expect(script).not.toContain("数据来源与口径");
    expect(script).toContain("用量更新于");
    expect(script).not.toContain("可靠性优先");
    expect(script).not.toContain("不推测某个节点正在运行");
  });

  test("presents a confirmed idle goal as waiting to run", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const workOrder = store.create({ goal: "准备开始" });
    store.savePlan(workOrder.id, [
      { outcome: "完成目标", scope: "当前文件夹", verification: "检查结果" },
    ]);
    const app = createApp({ store });

    const response = await app.fetch(new Request("http://teamline.local/api/console"));
    const result = await response.json();

    expect(result.workOrders[0]).toMatchObject({
      userStatus: "queued",
      statusReason: "等待选择工作空间",
    });
  });

  test("restores persisted work and exposes the six user-facing states", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-console-"));
    const databasePath = join(directory, "teamline.db");
    try {
      const firstDatabase = new Database(databasePath, { create: true });
      const firstStore = new WorkOrderStore(firstDatabase);
      firstStore.create({ repositoryPath: "/tmp/planning", goal: "规划新委托" });

      firstStore.savePlan(
        firstStore.create({ repositoryPath: "/tmp/ready", goal: "可以开始的目标" }).id,
        [{ outcome: "开始执行", scope: "src", verification: "人工检查" }],
      );

      const running = firstStore.savePlan(
        firstStore.create({ repositoryPath: "/tmp/running", goal: "执行中的委托" }).id,
        [{ outcome: "完成执行", scope: "src", verification: "人工检查" }],
      );
      firstStore.markStarted(running.id);

      const stopping = firstStore.savePlan(
        firstStore.create({ repositoryPath: "/tmp/stopping", goal: "正在停止" }).id,
        [{ outcome: "停止执行", scope: "src", verification: "人工检查" }],
      );
      firstStore.markStarted(stopping.id);
      firstStore.markStopping(stopping.id);

      const verifyingWorkOrder = firstStore.savePlan(
        firstStore.create({ repositoryPath: "/tmp/verifying", goal: "正在验证" }).id,
        [{ outcome: "整理结果", scope: "src", verification: "人工检查" }],
      );
      firstStore.markStarted(verifyingWorkOrder.id);
      firstStore.beginResultProcessing(verifyingWorkOrder.id, "Codex 已结束");

      const interrupted = firstStore.savePlan(
        firstStore.create({ repositoryPath: "/tmp/interrupted", goal: "执行已中断" }).id,
        [{ outcome: "恢复执行", scope: "src", verification: "人工检查" }],
      );
      firstStore.markStarted(interrupted.id);
      firstStore.recordInterrupted(interrupted.id);

      firstStore.savePlan(
        firstStore.create({ repositoryPath: "/tmp/queued", goal: "排队的委托" }).id,
        [{ outcome: "等待执行", scope: "src", verification: "人工检查" }],
      );

      const review = firstStore.savePlan(
        firstStore.create({ repositoryPath: "/tmp/review", goal: "等待验收" }).id,
        [{ outcome: "交付结果", scope: "src", verification: "人工检查" }],
      );
      firstStore.markStarted(review.id);
      const verifying = firstStore.beginResultProcessing(review.id, "Codex 已结束");
      firstStore.completeReview(review.id, {
        planVersion: verifying.plan!.version,
        git: { diffStat: "1 file changed", statusShort: " M src/app.ts" },
        verifications: [
          {
            stageId: verifying.plan!.stages[0]!.id,
            stageOutcome: "交付结果",
            command: "check",
            status: "passed",
            exitCode: 0,
            output: "pass",
          },
        ],
        completedAt: new Date().toISOString(),
      });

      const delivered = firstStore.savePlan(
        firstStore.create({ repositoryPath: "/tmp/delivered", goal: "已经完成" }).id,
        [{ outcome: "交付结果", scope: "src", verification: "人工检查" }],
      );
      firstStore.markStarted(delivered.id);
      const deliveredVerifying = firstStore.beginResultProcessing(delivered.id, "Codex 已结束");
      firstStore.completeReview(delivered.id, {
        planVersion: deliveredVerifying.plan!.version,
        git: { diffStat: "", statusShort: "" },
        verifications: [{
          stageId: deliveredVerifying.plan!.stages[0]!.id,
          stageOutcome: deliveredVerifying.plan!.stages[0]!.outcome,
          command: "check",
          status: "passed",
          exitCode: 0,
          output: "pass",
        }],
        completedAt: new Date().toISOString(),
      });
      firstStore.confirmDelivered(delivered.id);
      firstDatabase.close();

      const reopenedDatabase = new Database(databasePath);
      const app = createApp({ store: new WorkOrderStore(reopenedDatabase) });
      const response = await app.fetch(new Request("http://teamline.local/api/console"));
      const { workOrders } = await response.json();
      reopenedDatabase.close();

      expect(response.status).toBe(200);
      expect(
        Object.fromEntries(workOrders.map((workOrder) => [workOrder.title, workOrder.userStatus])),
      ).toEqual({
        规划新委托: "planning",
        可以开始的目标: "queued",
        执行中的委托: "running",
        正在停止: "running",
        正在验证: "running",
        执行已中断: "response",
        排队的委托: "queued",
        等待验收: "review",
        已经完成: "completed",
      });
      expect(workOrders.find((workOrder) => workOrder.title === "等待验收").statusReason).toBe(
        "待验收",
      );
      expect(workOrders.find((workOrder) => workOrder.title === "正在停止").statusReason).toBe(
        "正在停止",
      );
      expect(workOrders.find((workOrder) => workOrder.title === "正在验证").statusReason).toBe(
        "正在整理结果",
      );
      expect(workOrders.find((workOrder) => workOrder.title === "执行已中断").statusReason).toBe(
        "执行中断",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
