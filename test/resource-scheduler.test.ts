import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../src/app";
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

    store.saveWorkspace(noWorkspace.id, { kind: "directory", path: "/tmp/teamline" });
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

  test("one check starts only the highest-priority work order and rechecks after that round", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const background = enable(store, ready(store, "后台委托").id, "background");
    const high = enable(store, ready(store, "优先委托").id, "high");
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
      "等待更高优先级委托",
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
      expect(scheduler.activeCount()).toBe(1);
      expect(scheduler.runNext().delayMs).toBe(0);
      await Bun.sleep(0);
      expect(store.get(workOrder.id)?.resourcePlan.autoRunReason).toBe(
        "等待确认计划",
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
      expect(scheduler.activeCount()).toBe(0);

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
      expect(scheduler.activeCount()).toBe(0);

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
});
