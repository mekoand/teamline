import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import type { CodexRunEvent, CodexRunner } from "../src/codex-runner";
import type {
  CodexIdentityResourceProvider,
  CodexResourceSignal,
  ResourceProvider,
} from "../src/resource-provider";
import type { WorkOrderResultProcessor } from "../src/result-processor";
import { WorkOrderStore } from "../src/work-order-store";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `teamline-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

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

function resources(): ResourceProvider {
  return {
    async read() {
      const observedAt = new Date().toISOString();
      return {
        observedAt,
        codex: availableQuota(),
        openaiApi: {
          status: "not_connected",
          source: null,
          observedAt,
          message: "未连接",
          scope: null,
          usage: null,
        },
        workOrderUsage: [],
      };
    },
  };
}

function identityResources(): CodexIdentityResourceProvider {
  return { async read() { return availableQuota(); } };
}

function manualScheduler() {
  const timers: Array<{ callback: () => void; delayMs: number; active: boolean }> = [];
  return {
    schedule(callback: () => void, delayMs: number) {
      const timer = { callback, delayMs, active: true };
      timers.push(timer);
      return () => { timer.active = false; };
    },
    runNext() {
      const timer = timers.find((candidate) => candidate.active);
      if (!timer) throw new Error("no scheduled background check");
      timer.active = false;
      timer.callback();
      return timer;
    },
    activeCount() {
      return timers.filter((timer) => timer.active).length;
    },
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(2);
  }
}

describe("V2.1 multi-account project regression", () => {
  test("runs each project's dependent nodes on its assigned account and stops for review", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const managedIdentityId = "53333333-3333-4333-8333-333333333333";
    store.createManagedExecutionIdentity({
      id: managedIdentityId,
      label: "备用账号",
      managedHomePath: temporaryDirectory("managed-home"),
    });
    store.recordExecutionIdentityObservation(managedIdentityId, {
      loginState: "ready",
      capabilities: ["sessions"],
    });
    store.setCurrentExecutionIdentityId("codex-system-default");

    const firstProject = store.createProject("客户端");
    const secondProject = store.createProject("服务端");
    const createGoal = (
      projectId: string,
      identityId: string,
      label: string,
    ) => {
      const created = store.create({
        name: label,
        description: `完成${label}`,
        projectId,
        workspace: { kind: "directory", path: temporaryDirectory(label) },
        executionIdentityId: identityId,
      });
      const planned = store.savePlan(created.id, [
        {
          id: `${label}-prepare`,
          outcome: `${label}准备完成`,
          scope: "测试工作区",
          verification: "自动检查准备结果",
          verificationCommand: "true",
          dependsOn: [],
        },
        {
          id: `${label}-finish`,
          outcome: `${label}最终完成`,
          scope: "测试工作区",
          verification: "自动检查最终结果",
          verificationCommand: "true",
          dependsOn: [`${label}-prepare`],
        },
      ]);
      store.saveResourcePlan(planned.id, {
        priority: "normal",
        pace: "balanced",
        runWhenQuotaAvailable: true,
      });
      return planned;
    };
    const systemGoal = createGoal(
      firstProject.id,
      "codex-system-default",
      "客户端目标",
    );
    const managedGoal = createGoal(
      secondProject.id,
      managedIdentityId,
      "服务端目标",
    );

    const starts: Array<{ goalId: string; stageId: string; identityId: string }> = [];
    const runner: CodexRunner = {
      async start({ workOrder, executionIdentity }) {
        starts.push({
          goalId: workOrder.id,
          stageId: workOrder.plan!.stages[0]!.id,
          identityId: executionIdentity!.id,
        });
        return {
          interrupt() {},
          events: (async function* (): AsyncGenerator<CodexRunEvent> {
            yield {
              type: "exit",
              exitCode: 0,
              message: "当前节点已完成",
              endState: "completed",
            };
          })(),
        };
      },
      async resume(input) {
        return this.start(input);
      },
    };
    const resultProcessor: WorkOrderResultProcessor = {
      async process(workOrder) {
        const stage = workOrder.plan!.stages[0]!;
        return {
          planVersion: workOrder.plan!.version,
          git: { diffStat: "", statusShort: "" },
          verifications: [{
            stageId: stage.id,
            stageOutcome: stage.outcome,
            command: stage.verificationCommand ?? null,
            status: "passed",
            exitCode: 0,
            output: "passed",
          }],
          completedAt: new Date().toISOString(),
        };
      },
    };
    const scheduler = manualScheduler();
    const app = createApp({
      store,
      codexRunner: runner,
      resultProcessor,
      resourceProvider: resources(),
      identityResourceProvider: identityResources(),
      autoRunRetryScheduler: scheduler.schedule,
      autoRunRetryMs: 100,
    });

    expect(scheduler.runNext().delayMs).toBe(0);
    await waitFor(
      () =>
        store.get(systemGoal.id)?.status === "review" &&
        store.get(managedGoal.id)?.resourcePlan.autoRunReason === "等待账号",
    );
    expect(starts).toEqual([
      {
        goalId: systemGoal.id,
        stageId: "客户端目标-prepare",
        identityId: "codex-system-default",
      },
      {
        goalId: systemGoal.id,
        stageId: "客户端目标-finish",
        identityId: "codex-system-default",
      },
    ]);
    expect(store.get(managedGoal.id)).toMatchObject({
      projectId: secondProject.id,
      status: "ready",
      resourcePlan: { autoRunReason: "等待账号" },
    });

    const switched = await app.fetch(new Request(
      `http://teamline.local/api/execution-identities/${managedIdentityId}/activate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      },
    ));
    expect(switched.status).toBe(200);
    expect(scheduler.runNext().delayMs).toBe(0);
    await waitFor(() => store.get(managedGoal.id)?.status === "review");

    expect(starts.slice(2)).toEqual([
      {
        goalId: managedGoal.id,
        stageId: "服务端目标-prepare",
        identityId: managedIdentityId,
      },
      {
        goalId: managedGoal.id,
        stageId: "服务端目标-finish",
        identityId: managedIdentityId,
      },
    ]);
    expect(store.listProjects().map((project) => project.id)).toEqual([
      firstProject.id,
      secondProject.id,
    ]);
    expect(store.list().map((goal) => goal.status)).toEqual(["review", "review"]);

    const notifications = await (
      await app.fetch(new Request("http://teamline.local/api/notifications"))
    ).json() as { notifications: Array<{ kind: string }> };
    expect(notifications.notifications.map((notification) => notification.kind)).toEqual([
      "review",
      "review",
    ]);

    for (const goal of [systemGoal, managedGoal]) {
      const response = await app.fetch(new Request(
        `http://teamline.local/api/work-orders/${goal.id}/deliver`,
        { method: "POST" },
      ));
      expect(response.status).toBe(200);
    }
    expect(scheduler.activeCount()).toBe(0);
    await app.close();
  });
});
