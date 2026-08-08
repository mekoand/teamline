import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp } from "../src/app";
import { WorkOrderStore } from "../src/work-order-store";

describe("goal workbench API", () => {
  test("confirms an edited imported goal before generating its plan", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const imported = store.create({
      name: "继续历史工作",
      description: "整理前的目标",
      sourceSessions: [{
        kind: "codex_session",
        id: "source-session",
        lastActiveAt: "2026-08-04T01:00:00.000Z",
        version: 1,
      }],
      importContext: {
        status: "ready",
        summary: "历史工作已经整理",
        currentState: "等待确认后续目标",
        completedHighlights: ["完成历史梳理"],
        nextAction: "确认目标并生成计划",
        historicalStages: [],
        artifacts: [],
        organizedAt: "2026-08-04T02:00:00.000Z",
        error: null,
      },
    });
    let receivedGoal = "";
    const app = createApp({
      store,
      planGenerator: {
        async generate(workOrder) {
          receivedGoal = workOrder.goal;
          return {
            outcome: "plan" as const,
            stages: [{
              id: "next",
              outcome: "完成后续工作",
              scope: "当前工作区",
              verification: "人工检查",
              verificationCommand: null,
              dependsOn: [],
              executionMethod: "codex" as const,
            }],
          };
        },
      },
    });

    const response = await app.fetch(new Request(
      `http://teamline.local/api/work-orders/${imported.id}/plan/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal: "完成 macOS 远程访问配置" }),
      },
    ));

    expect(response.status).toBe(200);
    expect(receivedGoal).toBe("完成 macOS 远程访问配置");
    expect(store.get(imported.id)?.goal).toBe("完成 macOS 远程访问配置");
  });

  test("blocks plan generation until an imported session is organized", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const imported = store.create({
      goal: "整理导入会话",
      sourceSessions: [{
        kind: "codex_session",
        id: "pending-session",
        lastActiveAt: "2026-08-04T01:00:00.000Z",
        version: 1,
      }],
      importContext: {
        status: "pending",
        summary: null,
        currentState: null,
        completedHighlights: [],
        nextAction: null,
        historicalStages: [],
        artifacts: [],
        organizedAt: null,
        error: null,
      },
    });
    let calls = 0;
    const app = createApp({
      store,
      planGenerator: {
        async generate() {
          calls += 1;
          return { outcome: "plan" as const, stages: [] };
        },
      },
    });

    const blocked = await app.fetch(new Request(
      `http://teamline.local/api/work-orders/${imported.id}/plan/generate`,
      { method: "POST" },
    ));

    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ code: "WORK_ORDER_IMPORT_NOT_READY" });
    store.markSessionOrganizationFailed(imported.id, "历史整理失败");
    const failed = await app.fetch(new Request(
      `http://teamline.local/api/work-orders/${imported.id}/plan/generate`,
      { method: "POST" },
    ));
    expect(failed.status).toBe(409);
    expect(await failed.json()).toMatchObject({ code: "WORK_ORDER_IMPORT_NOT_READY" });
    expect(calls).toBe(0);
  });

  test("keeps plan generation available for an ordinary new goal", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const ordinary = store.create({ goal: "整理普通目标" });
    const app = createApp({
      store,
      planGenerator: {
        async generate() {
          return {
            outcome: "plan" as const,
            stages: [{
              id: "ordinary",
              outcome: "完成普通目标",
              scope: "当前工作区",
              verification: "人工检查",
              verificationCommand: null,
              dependsOn: [],
              executionMethod: "codex" as const,
            }],
          };
        },
      },
    });

    const response = await app.fetch(new Request(
      `http://teamline.local/api/work-orders/${ordinary.id}/plan/generate`,
      { method: "POST" },
    ));

    expect(response.status).toBe(200);
  });
});
