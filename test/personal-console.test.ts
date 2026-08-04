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
    expect(page).toContain('id="max-concurrency"');
    expect(page).toContain('type="number" min="1" step="1"');
    expect(script).toContain('localStorage.getItem("teamline-theme")');
    expect(script).toContain('localStorage.setItem("teamline-theme"');
    expect(script).toContain('"/api/execution-settings"');
    expect(script).toContain("state.workOrders.some((workOrder)");
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
    expect(script).toContain('["response", "需响应"]');
    expect(script).toContain('["review", "待验收"]');
    expect(script).toContain('["running", "运行中"]');
    expect(script).toContain('["planning", "规划中"]');
    expect(script).toContain('["queued", "待运行"]');
    expect(script).toContain('["completed", "已完成"]');
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

  test("uses stepped 390px navigation with explicit return paths and balanced Chinese wrapping", async () => {
    const app = createApp({ store: new WorkOrderStore(new Database(":memory:")) });
    const [script, styles] = await Promise.all([
      app.fetch(new Request("http://teamline.local/app.js")).then((response) => response.text()),
      app.fetch(new Request("http://teamline.local/styles.css")).then((response) => response.text()),
    ]);

    expect(script).toContain('class="mobile-back-button"');
    expect(script).toContain('id="back-to-all-goals"');
    expect(script).toContain('id="back-to-goal"');
    expect(script).toContain('id="open-goal-context"');
    expect(script).toContain("mobileContextActionLabel");
    expect(script).toContain('state.mobileContextOpen = true');
    expect(script).toContain("mobileContextOpen");
    expect(styles).toContain("@media (max-width: 680px)");
    expect(styles).toContain(".console-shell.mobile-context-open");
    expect(styles).toContain("text-wrap: balance");
    expect(styles).toContain("word-break: auto-phrase");
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
    expect(script).toContain("生成计划通常需要 30–90 秒");
  });

  test("keeps the topbar controls aligned and Chinese headings phrase-aware", async () => {
    const app = createApp({ store: new WorkOrderStore(new Database(":memory:")) });
    const styles = await (await app.fetch(new Request("http://teamline.local/styles.css"))).text();

    expect(styles).toContain(".concurrency-control > span");
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
    expect(script).toContain("workOrder.usage.message");
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
    expect(script).not.toContain("生成后续计划");
    expect(script).not.toContain("data-session-goal");
  });

  test("keeps resource provenance secondary to quota and work-order allocation", async () => {
    const app = createApp({ store: new WorkOrderStore(new Database(":memory:")) });
    const script = await (await app.fetch(new Request("http://teamline.local/app.js"))).text();

    expect(script).toContain("额度状态");
    expect(script).toContain("目标资源");
    expect(script).toContain('<details class="resource-details">');
    expect(script).toContain("数据来源与口径");
    expect(script).not.toContain("可靠性优先");
    expect(script).not.toContain("不推测某个节点正在运行");
  });

  test("restores persisted work and exposes the six user-facing states", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-console-"));
    const databasePath = join(directory, "teamline.db");
    try {
      const firstDatabase = new Database(databasePath, { create: true });
      const firstStore = new WorkOrderStore(firstDatabase);
      firstStore.create({ repositoryPath: "/tmp/planning", goal: "规划新委托" });

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
