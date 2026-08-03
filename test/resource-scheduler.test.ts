import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
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
});
