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

  test("offers external work selection and a result-reference next step", async () => {
    const app = createApp({ store: new WorkOrderStore(new Database(":memory:")) });
    const script = await (await app.fetch(new Request("http://teamline.local/app.js"))).text();

    expect(script).toContain('<select name="executionMethod" data-execution-method>');
    expect(script).toContain('<option value="external"');
    expect(script).toContain('id="external-completion-form"');
    expect(script).toContain("Teamline 只保存结论和原始位置，不复制或自动核验正文。");
    expect(script).toContain("/complete-external`");
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

  test("offers an explicit local Codex session import flow", async () => {
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
    expect(page).toContain("不会启动原会话");
    expect(script).toContain('requestJson("/api/codex-sessions")');
    expect(script).toContain('requestJson("/api/codex-sessions/import"');
    expect(script).toContain("data-session-goal");
  });

  test("keeps resource provenance secondary to quota and work-order allocation", async () => {
    const app = createApp({ store: new WorkOrderStore(new Database(":memory:")) });
    const script = await (await app.fetch(new Request("http://teamline.local/app.js"))).text();

    expect(script).toContain("额度状态");
    expect(script).toContain("委托资源");
    expect(script).toContain('<details class="resource-details">');
    expect(script).toContain("数据来源与口径");
    expect(script).not.toContain("可靠性优先");
    expect(script).not.toContain("不推测某个节点正在运行");
  });

  test("restores persisted work and exposes the five user-facing states", async () => {
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
            command: null,
            status: "not_configured",
            exitCode: null,
            output: "未配置自动验证命令",
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
        verifications: [],
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
        等待验收: "response",
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
