import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp } from "../src/app";
import { presentConsoleWorkOrders } from "../src/console-presentation";
import { decideAutoRun } from "../src/resource-scheduler";
import { WorkOrderStore } from "../src/work-order-store";

const unavailableQuota = {
  status: "unavailable" as const,
  source: "codex-app-server" as const,
  observedAt: new Date().toISOString(),
  message: "legacy provider text",
  shortWindow: null,
  longWindow: null,
};

describe("semantic messages", () => {
  test("presents stable status codes and parameters beside compatibility text", () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const goal = store.savePlan(store.create({ goal: "Prepare an external result" }).id, [{
      id: "external",
      outcome: "Approve the final design",
      scope: "Design tool",
      verification: "User confirmation",
      executionMethod: "external",
    }]);
    expect(presentConsoleWorkOrders(store.list())[0]).toMatchObject({
      statusReason: "待完成外部节点：Approve the final design",
      statusMessage: {
        code: "status.awaiting_external_stage",
        params: { outcome: "Approve the final design" },
      },
    });
  });

  test("scheduler exposes codes without using localized text as its decision seam", () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const goal = store.savePlan(store.create({
      goal: "Wait for quota",
      workspace: { kind: "directory", path: process.cwd() },
    }).id, [{ outcome: "Run", scope: "src", verification: "check" }]);
    store.saveResourcePlan(goal.id, {
      priority: "normal",
      pace: "balanced",
      runWhenQuotaAvailable: true,
      paidApiFallbackEnabled: false,
      paidApiLimitUsd: null,
    });

    const decision = decideAutoRun(store.list(), unavailableQuota, 2);
    expect(decision.reasons.get(goal.id)).toBe("额度数据不可用，保持排队");
    expect(decision.reasonMessages.get(goal.id)).toEqual({
      code: "scheduler.quota_unavailable",
      params: {},
    });
  });

  test("adds codes to legacy API errors and persisted notifications", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const app = createApp({ store });
    const invalid = await app.fetch(new Request("http://teamline.local/api/work-orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }));
    expect(await invalid.json()).toMatchObject({
      code: "error.invalid_request",
      message: { code: "error.invalid_request", params: {} },
    });

    const delivered = store.savePlan(store.create({ goal: "Deliver it" }).id, [
      { outcome: "Done", scope: "src", verification: "check" },
    ]);
    store.markStarted(delivered.id);
    const processing = store.beginResultProcessing(delivered.id, "done");
    store.completeReview(delivered.id, {
      planVersion: processing.plan!.version,
      git: { diffStat: "", statusShort: "" },
      verifications: [{
        stageId: processing.plan!.stages[0]!.id,
        stageOutcome: processing.plan!.stages[0]!.outcome,
        command: "check",
        status: "passed",
        exitCode: 0,
        output: "pass",
      }],
      completedAt: new Date().toISOString(),
    });
    store.confirmDelivered(delivered.id);
    store.syncWorkOrderNotifications();
    expect(store.listNotifications()[0]).toMatchObject({
      title: "目标已完成",
      titleMessage: { code: "notification.title.completed", params: {} },
      bodyMessage: { code: "notification.body.completed" },
    });
  });
});
