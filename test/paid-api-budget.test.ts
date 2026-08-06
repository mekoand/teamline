import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { createApp } from "../src/app";
import type { CodexRunEvent, CodexRunner } from "../src/codex-runner";
import { decidePaidApiRun } from "../src/paid-api-budget";
import type { ResourceProviderSnapshot } from "../src/resource-provider";
import { WorkOrderStore } from "../src/work-order-store";

const workspacePath = resolve(import.meta.dir, "..");

function exhaustedQuota(observedAt: string) {
  return {
    status: "available" as const,
    source: "codex-app-server" as const,
    observedAt,
    message: null,
    shortWindow: {
      usedPercent: 90,
      windowMinutes: 300,
      resetsAt: new Date(Date.parse(observedAt) + 3_600_000).toISOString(),
    },
    longWindow: {
      usedPercent: 40,
      windowMinutes: 10_080,
      resetsAt: new Date(Date.parse(observedAt) + 7 * 86_400_000).toISOString(),
    },
  };
}

function snapshot(
  workOrderId: string,
  amount: number | null,
  observedAt = new Date().toISOString(),
  accountAmount = 1,
): ResourceProviderSnapshot {
  return {
    observedAt,
    codex: exhaustedQuota(observedAt),
    openaiApi: {
      status: "available",
      source: "openai-usage-api",
      observedAt,
      message: null,
      scope: "project",
      usage: {
        amount: accountAmount,
        unit: "usd",
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: observedAt,
      },
    },
    workOrderUsage:
      amount === null
        ? []
        : [{
            workOrderId,
            amount,
            unit: "usd",
            observedAt,
            source: "openai-usage-api",
          }],
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(5);
  }
}

describe("paid API budget fallback", () => {
  test("keeps paid fallback off until the goal has an explicit positive limit", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const workOrder = store.create({ goal: "验证付费授权" });
    const app = createApp({ store });

    const response = await app.fetch(new Request(
      `http://teamline.local/api/work-orders/${workOrder.id}/resource-plan`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          priority: "normal",
          pace: "balanced",
          runWhenQuotaAvailable: true,
          paidApiFallbackEnabled: true,
          paidApiLimitUsd: null,
        }),
      },
    ));

    expect(response.status).toBe(400);
    expect(store.get(workOrder.id)?.resourcePlan).toMatchObject({
      paidApiFallbackEnabled: false,
      paidApiLimitUsd: null,
    });
  });

  test("never accepts estimated goal usage for a spending decision", () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const created = store.create({ goal: "拒绝估算用量" });
    store.saveResourcePlan(created.id, {
      priority: "normal",
      pace: "balanced",
      runWhenQuotaAvailable: true,
      paidApiFallbackEnabled: true,
      paidApiLimitUsd: 2,
    });
    const current = store.get(created.id)!;
    const resources = snapshot(created.id, 0.5);
    resources.workOrderUsage[0] = {
      ...resources.workOrderUsage[0]!,
      source: "estimated",
    } as never;

    expect(
      decidePaidApiRun(
        current,
        resources,
        { monthlyBudgetUsd: 10 },
        true,
      ),
    ).toEqual({ allowed: false, reason: "这个目标的 API 实际用量不可用" });
  });

  test("stops paid execution when observed monthly account spend reaches the global budget", () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const created = store.create({ goal: "遵守全局 API 预算" });
    store.saveResourcePlan(created.id, {
      priority: "normal",
      pace: "balanced",
      runWhenQuotaAvailable: true,
      paidApiFallbackEnabled: true,
      paidApiLimitUsd: 20,
    });
    const resources = snapshot(created.id, 1);
    resources.openaiApi.usage!.amount = 10;

    expect(
      decidePaidApiRun(
        store.get(created.id)!,
        resources,
        { monthlyBudgetUsd: 10 },
        true,
      ),
    ).toEqual({ allowed: false, reason: "API 月度预算已用完" });
  });

  test("runs paid nodes one at a time and stops the next node after delayed usage reaches the goal limit", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const created = store.create({ goal: "按实际用量推进三个节点" });
    const planned = store.savePlan(created.id, [
      { id: "stage-1", outcome: "完成 A", scope: "A", verification: "检查 A", verificationCommand: "true" },
      { id: "stage-2", outcome: "完成 B", scope: "B", verification: "检查 B", verificationCommand: "true", dependsOn: ["stage-1"] },
      { id: "stage-3", outcome: "完成 C", scope: "C", verification: "检查 C", verificationCommand: "true", dependsOn: ["stage-2"] },
    ]);
    store.saveWorkspace(planned.id, { kind: "directory", path: workspacePath });
    store.savePaidApiBudgetSettings(10);
    store.saveResourcePlan(planned.id, {
      priority: "normal",
      pace: "balanced",
      runWhenQuotaAvailable: true,
      paidApiFallbackEnabled: true,
      paidApiLimitUsd: 2,
    });

    let resources = snapshot(planned.id, null);
    const releases: Array<() => void> = [];
    const starts: Array<{ stageId: string; billingMode: string | undefined }> = [];
    const runner: CodexRunner = {
      paidApiAvailable: () => true,
      async start({ workOrder, billingMode }) {
        starts.push({ stageId: workOrder.plan!.stages[0]!.id, billingMode });
        let release!: () => void;
        const released = new Promise<void>((resolveRelease) => {
          release = resolveRelease;
        });
        releases.push(release);
        return {
          interrupt() {},
          events: (async function* (): AsyncGenerator<CodexRunEvent> {
            await released;
            yield {
              type: "exit",
              exitCode: 0,
              message: "节点完成",
              endState: "completed",
            };
          })(),
        };
      },
      async resume(input) {
        return this.start(input);
      },
    };
    const app = createApp({
      store,
      codexRunner: runner,
      resourceProvider: { async read() { return resources; } },
      resultProcessor: {
        async process(workOrder) {
          const stage = workOrder.plan!.stages[0]!;
          return {
            planVersion: workOrder.plan!.version,
            git: { diffStat: "", statusShort: "" },
            verifications: [{
              stageId: stage.id,
              stageOutcome: stage.outcome,
              command: "true",
              status: "passed",
              exitCode: 0,
              output: "passed",
            }],
            completedAt: new Date().toISOString(),
          };
        },
      },
      autoRunRetryScheduler: () => () => {},
    });

    const first = await app.fetch(new Request(
      "http://teamline.local/api/resources/run-once",
      { method: "POST" },
    ));
    expect((await first.json()).startedWorkOrderId).toBe(planned.id);
    expect(starts).toEqual([{ stageId: "stage-1", billingMode: "paid_api" }]);

    releases[0]!();
    await waitFor(() => store.get(planned.id)?.currentSummary.includes("用量更新") === true);
    expect(starts).toHaveLength(1);

    const firstPaidAt = store.get(planned.id)!.resourcePlan.lastPaidApiRunAt!;
    resources = snapshot(
      planned.id,
      0.5,
      new Date(Date.parse(firstPaidAt) + 1).toISOString(),
    );
    const second = await app.fetch(new Request(
      "http://teamline.local/api/resources/run-once",
      { method: "POST" },
    ));
    expect((await second.json()).startedWorkOrderId).toBe(planned.id);
    expect(starts[1]).toEqual({ stageId: "stage-2", billingMode: "paid_api" });

    releases[1]!();
    await waitFor(() => store.get(planned.id)?.currentSummary.includes("用量更新") === true);
    const secondPaidAt = store.get(planned.id)!.resourcePlan.lastPaidApiRunAt!;
    resources = snapshot(
      planned.id,
      2,
      new Date(Date.parse(secondPaidAt) + 1).toISOString(),
    );
    await app.fetch(new Request(
      "http://teamline.local/api/resources/run-once",
      { method: "POST" },
    ));

    expect(starts).toHaveLength(2);
    expect(store.get(planned.id)).toMatchObject({
      status: "ready",
      resourcePlan: { autoRunReason: "这个目标的付费限额已用完" },
    });
  });

  test("attributes an observed dedicated-project cost increase before starting the next paid node", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const created = store.create({ goal: "按项目实际费用推进" });
    const planned = store.savePlan(created.id, [
      { id: "stage-1", outcome: "完成 A", scope: "A", verification: "检查 A", verificationCommand: "true" },
      { id: "stage-2", outcome: "完成 B", scope: "B", verification: "检查 B", verificationCommand: "true", dependsOn: ["stage-1"] },
    ]);
    store.saveWorkspace(planned.id, { kind: "directory", path: workspacePath });
    store.savePaidApiBudgetSettings(10);
    store.saveResourcePlan(planned.id, {
      priority: "normal",
      pace: "balanced",
      runWhenQuotaAvailable: true,
      paidApiFallbackEnabled: true,
      paidApiLimitUsd: 2,
    });

    let resources = snapshot(planned.id, null);
    const releases: Array<() => void> = [];
    const starts: string[] = [];
    const runner: CodexRunner = {
      paidApiAvailable: () => true,
      async start({ workOrder }) {
        starts.push(workOrder.plan!.stages[0]!.id);
        let release!: () => void;
        const released = new Promise<void>((resolveRelease) => {
          release = resolveRelease;
        });
        releases.push(release);
        return {
          interrupt() {},
          events: (async function* (): AsyncGenerator<CodexRunEvent> {
            await released;
            yield { type: "exit", exitCode: 0, message: "节点完成", endState: "completed" };
          })(),
        };
      },
      async resume(input) {
        return this.start(input);
      },
    };
    const app = createApp({
      store,
      codexRunner: runner,
      resourceProvider: { async read() { return resources; } },
      resultProcessor: {
        async process(workOrder) {
          const stage = workOrder.plan!.stages[0]!;
          return {
            planVersion: workOrder.plan!.version,
            git: { diffStat: "", statusShort: "" },
            verifications: [{
              stageId: stage.id,
              stageOutcome: stage.outcome,
              command: "true",
              status: "passed",
              exitCode: 0,
              output: "passed",
            }],
            completedAt: new Date().toISOString(),
          };
        },
      },
      autoRunRetryScheduler: () => () => {},
    });

    await app.fetch(new Request("http://teamline.local/api/resources/run-once", { method: "POST" }));
    releases[0]!();
    await waitFor(() => store.get(planned.id)?.currentSummary.includes("用量更新") === true);
    expect(starts).toEqual(["stage-1"]);

    const firstPaidAt = store.get(planned.id)!.resourcePlan.lastPaidApiRunAt!;
    resources = snapshot(
      planned.id,
      null,
      new Date(Date.parse(firstPaidAt) + 1).toISOString(),
      1.75,
    );
    await app.fetch(new Request("http://teamline.local/api/resources/run-once", { method: "POST" }));

    expect(starts).toEqual(["stage-1", "stage-2"]);
    expect(store.getPaidApiAttributionState()).toMatchObject({
      observedByWorkOrder: {
        [planned.id]: { amountUsd: 0.75 },
      },
    });
  });

  test("requires explicit confirmation to clear a zero-cost or cross-month pending observation", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const workOrder = store.create({ goal: "解除无法自动归属的费用等待" });
    expect(
      store.claimPaidApiAttribution(
        workOrder.id,
        1,
        "2026-07-01T00:00:00.000Z",
        "2026-07-31T23:59:59.000Z",
      ),
    ).toBe(true);
    const app = createApp({ store });

    const rejected = await app.fetch(new Request(
      "http://teamline.local/api/resources/paid-api-attribution/clear",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workOrderId: workOrder.id }),
      },
    ));
    expect(rejected.status).toBe(400);
    expect(store.getPaidApiAttributionState().pending?.workOrderId).toBe(workOrder.id);

    const cleared = await app.fetch(new Request(
      "http://teamline.local/api/resources/paid-api-attribution/clear",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workOrderId: workOrder.id,
          confirmNoPendingCharge: true,
        }),
      },
    ));
    expect(cleared.status).toBe(200);
    expect(store.getPaidApiAttributionState().pending).toBeNull();
  });
});
