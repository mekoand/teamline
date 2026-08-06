import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../src/app";
import { presentConsoleWorkOrders } from "../src/console-presentation";
import type { CodexRunEvent, CodexRunner } from "../src/codex-runner";
import type { CodexResourceSignal, ResourceProvider } from "../src/resource-provider";
import { decideAutoRun } from "../src/resource-scheduler";
import { WorkOrderStore } from "../src/work-order-store";

const repositoryPath = resolve(import.meta.dir, "..");

function availableQuota(): CodexResourceSignal {
  const now = Date.now();
  return {
    status: "available",
    source: "codex-app-server",
    observedAt: new Date(now).toISOString(),
    message: null,
    shortWindow: {
      usedPercent: 20,
      windowMinutes: 300,
      resetsAt: new Date(now + 60 * 60_000).toISOString(),
    },
    longWindow: {
      usedPercent: 30,
      windowMinutes: 10_080,
      resetsAt: new Date(now + 7 * 24 * 60 * 60_000).toISOString(),
    },
  };
}

function enable(
  store: WorkOrderStore,
  id: string,
  priority: "high" | "normal" | "background" = "normal",
) {
  return store.saveResourcePlan(id, {
    priority,
    pace: "balanced",
    runWhenQuotaAvailable: true,
  });
}

function ready(store: WorkOrderStore, goal: string) {
  const created = store.create({ repositoryPath, goal });
  return store.savePlan(created.id, [
    { outcome: `完成${goal}`, scope: "src", verification: "运行测试" },
  ]);
}

function oneShotScheduler() {
  const timers: Array<{ callback: () => void; delayMs: number; active: boolean }> = [];
  return {
    timers,
    schedule(callback: () => void, delayMs: number) {
      const timer = { callback, delayMs, active: true };
      timers.push(timer);
      return () => {
        timer.active = false;
      };
    },
    runNext() {
      const timer = timers.find((candidate) => candidate.active);
      if (!timer) throw new Error("no scheduled auto-run check");
      timer.active = false;
      timer.callback();
      return timer;
    },
    activeCount() {
      return timers.filter((timer) => timer.active).length;
    },
  };
}

function availableResourceProvider(): ResourceProvider {
  return {
    async read() {
      return {
        observedAt: new Date().toISOString(),
        codex: availableQuota(),
        openaiApi: {
          status: "not_connected" as const,
          source: null,
          observedAt: new Date().toISOString(),
          message: "未连接",
          scope: null,
          usage: null,
        },
        workOrderUsage: [],
      };
    },
  };
}

describe("work-order resource scheduling", () => {
  test("persists three-level resource settings and keeps auto-run off by default", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const workOrder = store.create({ goal: "整理资源安排" });
    expect(workOrder.resourcePlan).toEqual({
      priority: "normal",
      pace: "balanced",
      runWhenQuotaAvailable: false,
      autoRunReason: null,
      paidApiFallbackEnabled: false,
      paidApiLimitUsd: null,
      lastPaidApiRunAt: null,
      lastBillingMode: null,
    });

    const app = createApp({ store });
    const response = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${workOrder.id}/resource-plan`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          priority: "background",
          pace: "saving",
          runWhenQuotaAvailable: true,
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(store.get(workOrder.id)?.resourcePlan).toMatchObject({
      priority: "background",
      pace: "saving",
      runWhenQuotaAvailable: true,
    });
  });

  test("saves target resource settings together without a partial update", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const workOrder = ready(store, "保存目标资源设置");
    const app = createApp({ store });

    const saved = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${workOrder.id}/resource-settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          priority: "high",
          pace: "saving",
          runWhenQuotaAvailable: true,
          maxRunMinutes: 120,
        }),
      }),
    );
    expect(saved.status).toBe(200);
    expect(store.get(workOrder.id)).toMatchObject({
      maxRunMinutes: 120,
      resourcePlan: {
        priority: "high",
        pace: "saving",
        runWhenQuotaAvailable: true,
      },
    });

    const rejected = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${workOrder.id}/resource-settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          priority: "background",
          pace: "fast",
          runWhenQuotaAvailable: false,
          maxRunMinutes: 15,
        }),
      }),
    );
    expect(rejected.status).toBe(400);
    expect(store.get(workOrder.id)).toMatchObject({
      maxRunMinutes: 120,
      resourcePlan: {
        priority: "high",
        pace: "saving",
        runWhenQuotaAvailable: true,
      },
    });
  });

  test("rechecks auto-run authorization after slow workspace preparation", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const workOrder = enable(store, ready(store, "准备期间关闭自动运行").id);
    let releasePreparation!: () => void;
    let preparationStarted!: () => void;
    const startedPreparing = new Promise<void>((resolve) => {
      preparationStarted = resolve;
    });
    const preparationReleased = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const starts: string[] = [];
    const app = createApp({
      store,
      resourceProvider: availableResourceProvider(),
      codexRunner: {
        async start({ workOrder: started }) {
          starts.push(started.id);
          return {
            interrupt() {},
            events: (async function* (): AsyncGenerator<CodexRunEvent> {
              await new Promise(() => {});
            })(),
          };
        },
        async resume() {
          throw new Error("not used");
        },
      },
      worktreeManager: {
        async prepare(started) {
          preparationStarted();
          await preparationReleased;
          return {
            path: `/tmp/teamline-${started.id}`,
            branch: `teamline/${started.id}`,
            baseCommit: "0123456789abcdef",
          };
        },
      },
    });

    const automaticStart = app.fetch(
      new Request("http://teamline.local/api/resources/run-once", { method: "POST" }),
    );
    await startedPreparing;
    const disabled = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${workOrder.id}/resource-settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          priority: "normal",
          pace: "balanced",
          runWhenQuotaAvailable: false,
          maxRunMinutes: 60,
        }),
      }),
    );
    expect(disabled.status).toBe(200);
    releasePreparation();
    const result = await automaticStart.then((response) => response.json());

    expect(result.startedWorkOrderId).toBeNull();
    expect(starts).toEqual([]);
    expect(store.get(workOrder.id)).toMatchObject({
      status: "ready",
      runStatus: null,
      resourcePlan: { runWhenQuotaAvailable: false, autoRunReason: null },
    });
  });

  test("does not clear a new plan confirmation while auto-run is preparing", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const workOrder = enable(store, ready(store, "准备期间更新计划").id);
    let releasePreparation!: () => void;
    let preparationStarted!: () => void;
    const startedPreparing = new Promise<void>((resolve) => {
      preparationStarted = resolve;
    });
    const preparationReleased = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const starts: string[] = [];
    const app = createApp({
      store,
      resourceProvider: availableResourceProvider(),
      codexRunner: {
        async start({ workOrder: started }) {
          starts.push(started.id);
          return {
            interrupt() {},
            events: (async function* (): AsyncGenerator<CodexRunEvent> {
              await new Promise(() => {});
            })(),
          };
        },
        async resume() {
          throw new Error("not used");
        },
      },
      worktreeManager: {
        async prepare(started) {
          preparationStarted();
          await preparationReleased;
          return {
            path: `/tmp/teamline-${started.id}`,
            branch: `teamline/${started.id}`,
            baseCommit: "0123456789abcdef",
          };
        },
      },
    });

    const automaticStart = app.fetch(
      new Request("http://teamline.local/api/resources/run-once", { method: "POST" }),
    );
    await startedPreparing;
    store.savePlan(
      workOrder.id,
      [{ outcome: "执行更新后的计划", scope: "src", verification: "运行测试" }],
      { confirmationRequired: true },
    );
    releasePreparation();
    const result = await automaticStart.then((response) => response.json());

    expect(result.startedWorkOrderId).toBeNull();
    expect(starts).toEqual([]);
    expect(store.get(workOrder.id)).toMatchObject({
      status: "ready",
      runStatus: null,
      plan: { version: 2, confirmationRequired: true },
      resourcePlan: { autoRunReason: "计划有变更，等待确认" },
    });
  });

  test("keeps enabled work queued with a clear reason when a required condition is missing", () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const draft = enable(store, store.create({ goal: "等待计划" }).id);
    let decision = decideAutoRun(store.list(), availableQuota(), 2);
    expect(decision.reasons.get(draft.id)).toBe("等待确认计划");

    const noWorkspace = store.savePlan(draft.id, [
      { outcome: "完成", scope: "src", verification: "检查" },
    ]);
    decision = decideAutoRun(store.list(), availableQuota(), 2);
    expect(decision.reasons.get(noWorkspace.id)).toBe("等待选择工作空间");

    const external = store.create({ goal: "等待外部设计" });
    store.savePlan(external.id, [
      {
        outcome: "完成设计",
        scope: "外部工具",
        verification: "用户确认",
        executionMethod: "external",
      },
    ]);
    enable(store, external.id);
    decision = decideAutoRun(store.list(), availableQuota(), 2);
    expect(decision.candidateId).toBeNull();
    expect(decision.reasons.get(external.id)).toBe("等待完成外部节点");

    store.saveWorkspace(noWorkspace.id, { kind: "directory", path: tmpdir() });
    decision = decideAutoRun(
      store.list(),
      { ...availableQuota(), status: "stale", shortWindow: null, longWindow: null },
      2,
    );
    expect(decision.reasons.get(noWorkspace.id)).toBe(
      "额度数据已过期，等待重新读取",
    );
    decision = decideAutoRun(
      store.list(),
      { ...availableQuota(), status: "conflict" },
      2,
    );
    expect(decision.reasons.get(noWorkspace.id)).toBe(
      "额度数据冲突，等待重新读取",
    );

    const active = ready(store, "占用并发");
    store.markStarted(active.id);
    decision = decideAutoRun(store.list(), availableQuota(), 1);
    expect(decision.reasons.get(noWorkspace.id)).toBe("等待可用并发位置");
  });

  test("stops automatic running at every response and acceptance boundary", () => {
    const store = new WorkOrderStore(new Database(":memory:"));

    const changedPlan = store.create({ goal: "确认新计划" });
    store.savePlan(
      changedPlan.id,
      [{ outcome: "执行新计划", scope: "src", verification: "检查" }],
      { confirmationRequired: true },
    );
    enable(store, changedPlan.id);

    const external = store.create({ goal: "等待外部节点" });
    store.savePlan(external.id, [{
      outcome: "完成外部设计",
      scope: "设计工具",
      verification: "用户确认",
      executionMethod: "external",
    }]);
    enable(store, external.id);

    const failed = enable(store, ready(store, "处理验证失败").id);
    store.markStarted(failed.id);
    const failedVerifying = store.beginResultProcessing(failed.id, "Codex 已结束");
    store.recordVerificationFailure(failed.id, {
      planVersion: failedVerifying.plan!.version,
      git: { diffStat: "", statusShort: "" },
      verifications: [{
        stageId: failedVerifying.plan!.stages[0]!.id,
        stageOutcome: failedVerifying.plan!.stages[0]!.outcome,
        command: "bun test",
        status: "failed",
        exitCode: 1,
        output: "failed",
      }],
      completedAt: new Date().toISOString(),
    });

    const review = enable(store, ready(store, "等待整体验收").id);
    store.markStarted(review.id);
    const reviewVerifying = store.beginResultProcessing(review.id, "Codex 已结束");
    store.completeReview(review.id, {
      planVersion: reviewVerifying.plan!.version,
      git: { diffStat: "", statusShort: "" },
      verifications: [{
        stageId: reviewVerifying.plan!.stages[0]!.id,
        stageOutcome: reviewVerifying.plan!.stages[0]!.outcome,
        command: "bun test",
        status: "passed",
        exitCode: 0,
        output: "passed",
      }],
      completedAt: new Date().toISOString(),
    });

    const limited = enable(store, ready(store, "达到单轮上限").id);
    store.markStarted(limited.id);
    store.recordInterrupted(
      limited.id,
      "已达到本轮最长运行时间（60 分钟），Codex 已停止；可以继续推进目标",
    );

    const decision = decideAutoRun(store.list(), availableQuota(), 2);
    expect(decision.candidateId).toBeNull();
    expect(decision.reasons.get(changedPlan.id)).toBe("计划有变更，等待确认");
    expect(decision.reasons.get(external.id)).toBe("等待完成外部节点");
    expect(decision.reasons.get(failed.id)).toBe("验证失败，等待处理后继续");
    expect(decision.reasons.get(review.id)).toBe("等待验收");
    expect(decision.reasons.get(limited.id)).toBe("已达到本轮上限，等待继续");

    const presented = new Map(
      presentConsoleWorkOrders(store.list()).map((workOrder) => [
        workOrder.id,
        workOrder.statusReason,
      ]),
    );
    expect(presented.get(external.id)).toBe("待完成外部节点：完成外部设计");
    expect(presented.get(failed.id)).toBe("自动验证未通过");
    expect(presented.get(limited.id)).toBe("已达到本轮上限");
  });

  test("one check starts only the highest-priority work order and rechecks after that round", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const background = enable(store, ready(store, "后台目标").id, "background");
    const high = enable(store, ready(store, "优先目标").id, "high");
    const releases: Array<() => void> = [];
    const starts: string[] = [];
    const runner: CodexRunner = {
      async start({ workOrder }) {
        starts.push(workOrder.id);
        let release!: () => void;
        const done = new Promise<void>((resolveRelease) => {
          release = resolveRelease;
        });
        releases.push(release);
        return {
          interrupt() {},
          events: (async function* (): AsyncGenerator<CodexRunEvent> {
            await done;
            yield { type: "exit", exitCode: 0, message: "本轮完成" };
          })(),
        };
      },
      async resume() {
        throw new Error("not used");
      },
    };
    const snapshot = {
      observedAt: new Date().toISOString(),
      codex: availableQuota(),
      openaiApi: {
        status: "not_connected" as const,
        source: null,
        observedAt: new Date().toISOString(),
        message: "未连接",
        scope: null,
        usage: null,
      },
      workOrderUsage: [],
    };
    const provider: ResourceProvider = { async read() { return snapshot; } };
    const app = createApp({
      store,
      resourceProvider: provider,
      codexRunner: runner,
      worktreeManager: {
        async prepare(workOrder) {
          return {
            path: `/tmp/teamline-${workOrder.id}`,
            branch: `teamline/${workOrder.id}`,
            baseCommit: "0123456789abcdef",
          };
        },
      },
    });

    const first = await app.fetch(
      new Request("http://teamline.local/api/resources/run-once", { method: "POST" }),
    );
    expect(await first.json()).toEqual({
      startedWorkOrderId: high.id,
      reason: null,
    });
    expect(starts).toEqual([high.id]);
    expect(store.get(background.id)?.resourcePlan.autoRunReason).toBe(
      "等待更高优先级目标",
    );

    releases[0]!();
    const deadline = Date.now() + 1_000;
    while (starts.length < 2 && Date.now() < deadline) await Bun.sleep(5);
    expect(starts).toEqual([high.id, background.id]);
    releases[1]!();
  });

  test("retries a quota-blocked authorization and starts without a browser", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const workOrder = enable(store, ready(store, "等待额度恢复").id);
    let codex = { ...availableQuota(), shortWindow: { ...availableQuota().shortWindow!, usedPercent: 90 } };
    const scheduler = oneShotScheduler();
    const starts: string[] = [];
    const app = createApp({
      store,
      resourceProvider: {
        async read() {
          return {
            observedAt: new Date().toISOString(),
            codex,
            openaiApi: {
              status: "not_connected" as const,
              source: null,
              observedAt: new Date().toISOString(),
              message: "未连接",
              scope: null,
              usage: null,
            },
            workOrderUsage: [],
          };
        },
      },
      codexRunner: {
        async start({ workOrder: started }) {
          starts.push(started.id);
          return {
            interrupt() {},
            events: (async function* (): AsyncGenerator<CodexRunEvent> {
              await new Promise(() => {});
            })(),
          };
        },
        async resume() {
          throw new Error("not used");
        },
      },
      worktreeManager: {
        async prepare(started) {
          return {
            path: `/tmp/teamline-${started.id}`,
            branch: `teamline/${started.id}`,
            baseCommit: "0123456789abcdef",
          };
        },
      },
      autoRunRetryScheduler: scheduler.schedule,
      autoRunRetryMs: 25,
    });
    void app;

    expect(scheduler.runNext().delayMs).toBe(0);
    await Bun.sleep(0);
    expect(starts).toEqual([]);
    expect(store.get(workOrder.id)?.resourcePlan.autoRunReason).toBe(
      "额度不足，等待可用额度",
    );
    const retry = scheduler.timers.find((timer) => timer.active);
    expect(retry?.delayMs).toBe(25);

    codex = availableQuota();
    scheduler.runNext();
    await Bun.sleep(0);
    expect(starts).toEqual([workOrder.id]);
  });

  test("service startup rechecks an enabled work order restored from SQLite", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-auto-run-restart-"));
    const databasePath = join(directory, "teamline.db");
    try {
      let database = new Database(databasePath, { create: true });
      let store = new WorkOrderStore(database);
      const workOrder = enable(store, ready(store, "服务重启后继续判断").id);
      database.close();

      database = new Database(databasePath);
      store = new WorkOrderStore(database);
      const scheduler = oneShotScheduler();
      const starts: string[] = [];
      createApp({
        store,
        resourceProvider: {
          async read() {
            return {
              observedAt: new Date().toISOString(),
              codex: availableQuota(),
              openaiApi: {
                status: "not_connected" as const,
                source: null,
                observedAt: new Date().toISOString(),
                message: "未连接",
                scope: null,
                usage: null,
              },
              workOrderUsage: [],
            };
          },
        },
        codexRunner: {
          async start({ workOrder: started }) {
            starts.push(started.id);
            return {
              interrupt() {},
              events: (async function* (): AsyncGenerator<CodexRunEvent> {
                await new Promise(() => {});
              })(),
            };
          },
          async resume() {
            throw new Error("not used");
          },
        },
        worktreeManager: {
          async prepare(started) {
            return {
              path: `/tmp/teamline-${started.id}`,
              branch: `teamline/${started.id}`,
              baseCommit: "0123456789abcdef",
            };
          },
        },
        autoRunRetryScheduler: scheduler.schedule,
      });

      expect(scheduler.runNext().delayMs).toBe(0);
      await Bun.sleep(0);
      expect(starts).toEqual([workOrder.id]);
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("refreshes accounts, quota, and workspace after a wake gap and closes its timer", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-background-wake-"));
    const workspace = join(directory, "workspace");
    try {
      const store = new WorkOrderStore(new Database(":memory:"));
      const managedIdentityId = "73333333-3333-4333-8333-333333333333";
      store.createManagedExecutionIdentity({
        id: managedIdentityId,
        label: "后台备用账号",
        managedHomePath: join(directory, "codex-home"),
      });
      store.recordExecutionIdentityObservation(managedIdentityId, {
        loginState: "ready",
        capabilities: ["app-server"],
      });
      const created = store.create({ goal: "唤醒后继续判断" });
      const planned = store.savePlan(created.id, [
        { outcome: "完成后台执行", scope: "当前文件夹", verification: "检查" },
      ]);
      store.saveWorkspace(planned.id, { kind: "directory", path: workspace });
      enable(store, planned.id);
      const scheduler = oneShotScheduler();
      let now = 0;
      let resourceReads = 0;
      let identityReads = 0;
      let managedQuotaReads = 0;
      const starts: string[] = [];
      const app = createApp({
        store,
        resourceProvider: {
          async read() {
            resourceReads += 1;
            return (await availableResourceProvider().read());
          },
        },
        identityResourceProvider: {
          async read() {
            managedQuotaReads += 1;
            return availableQuota();
          },
        },
        codexRunner: {
          async start({ workOrder }) {
            starts.push(workOrder.id);
            return {
              interrupt() {},
              events: (async function* (): AsyncGenerator<CodexRunEvent> {
                await new Promise(() => {});
              })(),
            };
          },
          async resume() {
            throw new Error("not used");
          },
        },
        executionIdentityEnvironment: {
          async create() { return { managedHomePath: "/tmp/not-used" }; },
          async remove() {},
          async inspect() {
            identityReads += 1;
            return { loginState: "ready" as const, capabilities: ["app-server"] };
          },
          async startLogin() { return { status: "idle" as const }; },
          getLoginStatus() { return { status: "idle" as const }; },
        },
        autoRunRetryScheduler: scheduler.schedule,
        autoRunRetryMs: 100,
        backgroundNow: () => now,
        wakeDetectionThresholdMs: 50,
      });

      expect(scheduler.runNext().delayMs).toBe(0);
      await Bun.sleep(0);
      expect(resourceReads).toBe(1);
      expect(managedQuotaReads).toBe(1);
      expect(starts).toEqual([]);
      expect(store.get(planned.id)?.resourcePlan.autoRunReason).toBe(
        "工作空间不可用，等待重新检查",
      );
      expect(scheduler.timers.find((timer) => timer.active)?.delayMs).toBe(100);

      mkdirSync(workspace);
      now = 1_000;
      scheduler.runNext();
      const deadline = Date.now() + 1_000;
      while (starts.length === 0 && Date.now() < deadline) await Bun.sleep(2);
      expect(identityReads).toBe(2);
      expect(resourceReads).toBe(3);
      expect(managedQuotaReads).toBe(3);
      expect(starts).toEqual([planned.id]);

      expect(scheduler.activeCount()).toBe(1);
      await app.close();
      expect(scheduler.activeCount()).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("plan and workspace APIs immediately recheck a previously authorized work order", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "teamline-auto-run-static-"));
    try {
      const store = new WorkOrderStore(new Database(":memory:"));
      const workOrder = store.create({ goal: "补齐静态执行条件" });
      const scheduler = oneShotScheduler();
      const starts: string[] = [];
      const app = createApp({
        store,
        resourceProvider: availableResourceProvider(),
        codexRunner: {
          async start({ workOrder: started }) {
            starts.push(started.id);
            return {
              interrupt() {},
              events: (async function* (): AsyncGenerator<CodexRunEvent> {
                await new Promise(() => {});
              })(),
            };
          },
          async resume() {
            throw new Error("not used");
          },
        },
        autoRunRetryScheduler: scheduler.schedule,
      });

      await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${workOrder.id}/resource-plan`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            priority: "normal",
            pace: "balanced",
            runWhenQuotaAvailable: true,
          }),
        }),
      );
      expect(scheduler.activeCount()).toBe(0);

      await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${workOrder.id}/plan`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            stages: [{ outcome: "完成", scope: "当前文件夹", verification: "检查" }],
          }),
        }),
      );
      expect(scheduler.activeCount()).toBe(1);
      expect(scheduler.runNext().delayMs).toBe(0);
      await Bun.sleep(0);
      expect(store.get(workOrder.id)?.resourcePlan.autoRunReason).toBe(
        "等待选择工作空间",
      );
      expect(scheduler.activeCount()).toBe(1);

      await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${workOrder.id}/workspace`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: workspace }),
        }),
      );
      expect(scheduler.activeCount()).toBe(1);
      expect(scheduler.runNext().delayMs).toBe(0);
      const deadline = Date.now() + 1_000;
      while (starts.length === 0 && Date.now() < deadline) await Bun.sleep(5);
      expect(starts).toEqual([workOrder.id]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("raising max concurrency immediately rechecks queued authorized work", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "teamline-auto-run-capacity-"));
    try {
      const store = new WorkOrderStore(new Database(":memory:"));
      store.saveMaxConcurrency(1);
      const active = ready(store, "占用唯一并发");
      store.bindExecutionIdentity(active.id);
      store.markStarted(active.id);
      const waiting = store.create({
        workspace: { kind: "directory", path: workspace },
        goal: "等待并发提高",
      });
      store.savePlan(waiting.id, [
        { outcome: "完成", scope: "当前文件夹", verification: "检查" },
      ]);
      enable(store, waiting.id);
      const scheduler = oneShotScheduler();
      const starts: string[] = [];
      const app = createApp({
        store,
        resourceProvider: availableResourceProvider(),
        codexRunner: {
          async start({ workOrder: started }) {
            starts.push(started.id);
            return {
              interrupt() {},
              events: (async function* (): AsyncGenerator<CodexRunEvent> {
                await new Promise(() => {});
              })(),
            };
          },
          async resume() {
            throw new Error("not used");
          },
        },
        autoRunRetryScheduler: scheduler.schedule,
      });

      expect(scheduler.runNext().delayMs).toBe(0);
      await Bun.sleep(0);
      expect(store.get(waiting.id)?.resourcePlan.autoRunReason).toBe(
        "等待可用并发位置",
      );
      expect(scheduler.activeCount()).toBe(1);

      await app.fetch(
        new Request("http://teamline.local/api/execution-settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ maxConcurrency: 2 }),
        }),
      );
      expect(scheduler.activeCount()).toBe(1);
      expect(scheduler.runNext().delayMs).toBe(0);
      const deadline = Date.now() + 1_000;
      while (starts.length === 0 && Date.now() < deadline) await Bun.sleep(5);
      expect(starts).toEqual([waiting.id]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("stops background polling when the last authorized goal is delivered", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const workOrder = enable(store, ready(store, "完成后停止轮询").id);
    const scheduler = oneShotScheduler();
    const app = createApp({
      store,
      resourceProvider: availableResourceProvider(),
      autoRunRetryScheduler: scheduler.schedule,
    });
    expect(scheduler.activeCount()).toBe(1);

    store.database
      .query("UPDATE work_orders SET status = 'review' WHERE id = ?")
      .run(workOrder.id);
    const response = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${workOrder.id}/deliver`, {
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    expect(store.get(workOrder.id)?.status).toBe("delivered");
    expect(scheduler.activeCount()).toBe(0);
  });

  test("uses the current account and that account's own quota when choosing work", () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const managedId = "72222222-2222-4222-8222-222222222222";
    store.createManagedExecutionIdentity({
      id: managedId,
      label: "备用",
      managedHomePath: "/tmp/teamline-managed-scheduler",
    });
    store.recordExecutionIdentityObservation(managedId, {
      loginState: "ready",
      capabilities: ["sessions"],
    });
    const system = enable(store, ready(store, "系统账号工作").id);
    const alternate = enable(store, ready(store, "备用账号工作").id);
    store.bindExecutionIdentity(system.id, "codex-system-default");
    store.bindExecutionIdentity(alternate.id, managedId);
    store.setCurrentExecutionIdentityId("codex-system-default");
    const identities = new Set(["codex-system-default", managedId]);
    const quotas = new Map([
      ["codex-system-default", availableQuota()],
      [managedId, availableQuota()],
    ]);

    let decision = decideAutoRun(store.list(), availableQuota(), 2, new Date(), {
      currentExecutionIdentityId: store.getCurrentExecutionIdentityId(),
      defaultExecutionIdentityId: store.getDefaultExecutionIdentityId(),
      executableExecutionIdentityIds: identities,
      quotaByExecutionIdentityId: quotas,
    });
    expect(decision.candidateId).toBe(system.id);
    expect(decision.reasons.get(alternate.id)).toBe("等待账号");

    store.setCurrentExecutionIdentityId(managedId);
    quotas.set(managedId, {
      ...availableQuota(),
      shortWindow: { ...availableQuota().shortWindow!, usedPercent: 90 },
    });
    decision = decideAutoRun(store.list(), availableQuota(), 2, new Date(), {
      currentExecutionIdentityId: managedId,
      defaultExecutionIdentityId: store.getDefaultExecutionIdentityId(),
      executableExecutionIdentityIds: identities,
      quotaByExecutionIdentityId: quotas,
    });
    expect(decision.candidateId).toBeNull();
    expect(decision.reasons.get(system.id)).toBe("等待账号");
    expect(decision.reasons.get(alternate.id)).toBe("额度不足，等待可用额度");

    store.saveResourcePlan(alternate.id, {
      priority: "normal",
      pace: "fast",
      runWhenQuotaAvailable: true,
    });
    quotas.set(managedId, {
      ...availableQuota(),
      status: "stale",
      shortWindow: null,
      longWindow: null,
    });
    decision = decideAutoRun(store.list(), availableQuota(), 2, new Date(), {
      currentExecutionIdentityId: managedId,
      defaultExecutionIdentityId: store.getDefaultExecutionIdentityId(),
      executableExecutionIdentityIds: identities,
      quotaByExecutionIdentityId: quotas,
    });
    expect(decision.candidateId).toBe(alternate.id);
  });
});
