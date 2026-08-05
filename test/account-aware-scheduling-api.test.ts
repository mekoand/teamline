import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import type { CodexRunEvent, CodexRunner } from "../src/codex-runner";
import type { CodexResourceSignal, ResourceProvider } from "../src/resource-provider";
import { WorkOrderStore } from "../src/work-order-store";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "teamline-account-scheduling-"));
  temporaryDirectories.push(directory);
  return directory;
}

function addManagedIdentity(store: WorkOrderStore, id: string) {
  store.createManagedExecutionIdentity({
    id,
    label: "备用",
    managedHomePath: join(temporaryDirectory(), id),
  });
  return store.recordExecutionIdentityObservation(id, {
    loginState: "ready",
    capabilities: ["sessions"],
  });
}

function readyGoal(
  store: WorkOrderStore,
  label: string,
  executionIdentityId: string,
  stages = 1,
) {
  const workOrder = store.create({
    workspace: { kind: "directory", path: temporaryDirectory() },
    goal: label,
    executionIdentityId,
  });
  return store.savePlan(
    workOrder.id,
    Array.from({ length: stages }, (_, index) => ({
      outcome: `${label} ${index + 1}`,
      scope: "测试文件",
      verification: "运行测试",
      verificationCommand: "bun test",
      dependsOn: index === 0 ? [] : [`stage-${index}`],
      id: `stage-${index + 1}`,
    })),
  );
}

function quota(usedPercent: number): CodexResourceSignal {
  const now = Date.now();
  return {
    status: "available",
    source: "codex-app-server",
    observedAt: new Date(now).toISOString(),
    message: null,
    shortWindow: {
      usedPercent,
      windowMinutes: 300,
      resetsAt: new Date(now + 60 * 60_000).toISOString(),
    },
    longWindow: {
      usedPercent,
      windowMinutes: 10_080,
      resetsAt: new Date(now + 7 * 24 * 60 * 60_000).toISOString(),
    },
  };
}

function resourceProvider(readQuota: () => CodexResourceSignal): ResourceProvider {
  return {
    async read() {
      const observedAt = new Date().toISOString();
      return {
        observedAt,
        codex: readQuota(),
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

async function waitFor(condition: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(2);
  }
}

describe("Codex-account aware scheduling", () => {
  test("persists the selected running account independently from the default", () => {
    const databasePath = join(temporaryDirectory(), "teamline.db");
    let store = new WorkOrderStore(new Database(databasePath, { create: true }));
    const managedId = "71000000-0000-4000-8000-000000000000";
    addManagedIdentity(store, managedId);
    store.setCurrentExecutionIdentityId(managedId);
    expect(store.getDefaultExecutionIdentityId()).toBe("codex-system-default");
    store.database.close();

    store = new WorkOrderStore(new Database(databasePath));
    expect(store.getCurrentExecutionIdentityId()).toBe(managedId);
    expect(store.getDefaultExecutionIdentityId()).toBe("codex-system-default");
    store.database.close();
  });

  test("allows same-account concurrency and requires a confirmed idle switch", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    store.saveMaxConcurrency(3);
    const managedId = "71111111-1111-4111-8111-111111111111";
    addManagedIdentity(store, managedId);
    const first = readyGoal(store, "系统目标一", "codex-system-default");
    const second = readyGoal(store, "系统目标二", "codex-system-default");
    const alternate = readyGoal(store, "备用账号目标", managedId);
    const releases = new Map<string, () => void>();
    const starts: Array<{ id: string; identityId: string }> = [];
    const runner: CodexRunner = {
      async start({ workOrder, executionIdentity }) {
        starts.push({ id: workOrder.id, identityId: executionIdentity!.id });
        let release!: () => void;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        releases.set(workOrder.id, release);
        return {
          interrupt() {},
          events: (async function* (): AsyncGenerator<CodexRunEvent> {
            await released;
            yield { type: "exit", exitCode: 1, message: "测试结束", endState: "failed" };
          })(),
        };
      },
      async resume() {
        throw new Error("not used");
      },
    };
    const app = createApp({ store, codexRunner: runner });

    for (const workOrder of [first, second]) {
      const response = await app.fetch(new Request(
        `http://teamline.local/api/work-orders/${workOrder.id}/start`,
        { method: "POST" },
      ));
      expect(response.status).toBe(200);
    }
    expect(store.getCurrentExecutionIdentityId()).toBe("codex-system-default");

    const blocked = await app.fetch(new Request(
      `http://teamline.local/api/work-orders/${alternate.id}/start`,
      { method: "POST" },
    ));
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({
      code: "EXECUTION_IDENTITY_BUSY",
      error: expect.stringContaining("等待账号"),
    });
    const consoleView = await (
      await app.fetch(new Request("http://teamline.local/api/console"))
    ).json();
    expect(
      consoleView.workOrders.find(
        (candidate: { id: string }) => candidate.id === alternate.id,
      ),
    ).toMatchObject({ userStatus: "queued", statusReason: "等待账号" });

    const busySwitch = await app.fetch(new Request(
      `http://teamline.local/api/execution-identities/${managedId}/activate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      },
    ));
    expect(busySwitch.status).toBe(409);

    releases.get(first.id)!();
    releases.get(second.id)!();
    await waitFor(() => store.activeRunIds().length === 0);

    const confirmationRequired = await app.fetch(new Request(
      `http://teamline.local/api/work-orders/${alternate.id}/start`,
      { method: "POST" },
    ));
    expect(confirmationRequired.status).toBe(409);
    expect(await confirmationRequired.json()).toMatchObject({
      code: "EXECUTION_IDENTITY_SWITCH_REQUIRED",
    });

    const switched = await app.fetch(new Request(
      `http://teamline.local/api/execution-identities/${managedId}/activate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      },
    ));
    expect(switched.status).toBe(200);
    const switchedConsole = await (
      await app.fetch(new Request("http://teamline.local/api/console"))
    ).json();
    expect(
      switchedConsole.workOrders.find(
        (candidate: { id: string }) => candidate.id === alternate.id,
      ),
    ).toMatchObject({ userStatus: "queued", statusReason: "可以开始运行" });
    const started = await app.fetch(new Request(
      `http://teamline.local/api/work-orders/${alternate.id}/start`,
      { method: "POST" },
    ));
    expect(started.status).toBe(200);
    expect(starts).toContainEqual({ id: alternate.id, identityId: managedId });
  });

  test("blocks new starts while a legacy active run has no account binding", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const legacy = store.create({
      workspace: { kind: "directory", path: temporaryDirectory() },
      goal: "旧版运行",
    });
    store.savePlan(legacy.id, [{
      outcome: "继续旧版运行",
      scope: "测试文件",
      verification: "运行测试",
    }]);
    store.markStarted(legacy.id);
    const managedId = "71222222-2222-4222-8222-222222222222";
    addManagedIdentity(store, managedId);
    const next = readyGoal(store, "新的目标", managedId);
    let runnerCalls = 0;
    const app = createApp({
      store,
      codexRunner: {
        async start() {
          runnerCalls += 1;
          throw new Error("must not start");
        },
        async resume() {
          throw new Error("must not resume");
        },
      },
    });

    const response = await app.fetch(new Request(
      `http://teamline.local/api/work-orders/${next.id}/start`,
      { method: "POST" },
    ));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "EXECUTION_IDENTITY_BUSY",
      error: expect.stringContaining("旧版 Codex 运行"),
    });
    expect(runnerCalls).toBe(0);
  });

  test("checks reserve policy after a node finishes and before the next starts", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const workOrder = readyGoal(
      store,
      "分节点检查额度",
      "codex-system-default",
      2,
    );
    store.saveResourcePlan(workOrder.id, {
      priority: "normal",
      pace: "balanced",
      runWhenQuotaAvailable: true,
    });
    let usedPercent = 90;
    const starts: string[] = [];
    const app = createApp({
      store,
      resourceProvider: resourceProvider(() => quota(usedPercent)),
      codexRunner: {
        async start({ workOrder: current }) {
          starts.push(current.plan!.stages[0]!.id);
          return {
            interrupt() {},
            events: (async function* (): AsyncGenerator<CodexRunEvent> {
              yield { type: "exit", exitCode: 0, message: "节点完成", endState: "completed" };
            })(),
          };
        },
        async resume(input) {
          return this.start(input);
        },
      },
      resultProcessor: {
        async process(current) {
          const stage = current.plan!.stages[0]!;
          return {
            planVersion: current.plan!.version,
            git: { diffStat: "", statusShort: "" },
            verifications: [{
              stageId: stage.id,
              stageOutcome: stage.outcome,
              command: "bun test",
              status: "passed",
              exitCode: 0,
              output: "passed",
            }],
            completedAt: new Date().toISOString(),
          };
        },
      },
    });

    const first = await app.fetch(new Request(
      `http://teamline.local/api/work-orders/${workOrder.id}/start`,
      { method: "POST" },
    ));
    expect(first.status).toBe(200);
    await waitFor(() => store.get(workOrder.id)?.currentSummary.includes("额度不足") === true);
    expect(starts).toEqual(["stage-1"]);
    expect(store.get(workOrder.id)).toMatchObject({
      status: "ready",
      runStatus: null,
      resourcePlan: { autoRunReason: "额度不足，等待可用额度" },
    });

    usedPercent = 20;
    const resumed = await app.fetch(new Request(
      "http://teamline.local/api/resources/run-once",
      { method: "POST" },
    ));
    expect((await resumed.json()).startedWorkOrderId).toBe(workOrder.id);
    await waitFor(() => starts.length === 2);
    expect(starts).toEqual(["stage-1", "stage-2"]);
  });

  test("retries one structured transient failure and stops after the second", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const workOrder = readyGoal(store, "恢复短暂故障", "codex-system-default");
    let resumeCalls = 0;
    const app = createApp({
      store,
      codexRunner: {
        async start() {
          return {
            interrupt() {},
            events: (async function* (): AsyncGenerator<CodexRunEvent> {
              yield { type: "session", sessionId: "transient-session" };
              yield {
                type: "exit",
                exitCode: 1,
                message: "网络暂时不可用",
                endState: "transient_failure",
              };
            })(),
          };
        },
        async resume() {
          resumeCalls += 1;
          return {
            interrupt() {},
            events: (async function* (): AsyncGenerator<CodexRunEvent> {
              yield {
                type: "exit",
                exitCode: 1,
                message: "网络仍不可用",
                endState: "transient_failure",
              };
            })(),
          };
        },
      },
    });

    const response = await app.fetch(new Request(
      `http://teamline.local/api/work-orders/${workOrder.id}/start`,
      { method: "POST" },
    ));
    expect(response.status).toBe(200);
    await waitFor(() => store.get(workOrder.id)?.runStatus === "failed");
    expect(resumeCalls).toBe(1);
    expect(store.get(workOrder.id)).toMatchObject({
      status: "interrupted",
      currentSummary: "自动恢复一次后仍然失败，需要你响应",
    });
  });

  test("stops for a structured needs-response report instead of validating", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const workOrder = readyGoal(store, "补充产品决定", "codex-system-default");
    let processCalls = 0;
    const app = createApp({
      store,
      codexRunner: {
        async start() {
          return {
            interrupt() {},
            events: (async function* (): AsyncGenerator<CodexRunEvent> {
              yield {
                type: "progress",
                message: "请选择发布范围",
                category: "report",
                report: { kind: "needs_response" },
              };
              yield { type: "exit", exitCode: 0, message: "等待回复", endState: "completed" };
            })(),
          };
        },
        async resume() {
          throw new Error("not used");
        },
      },
      resultProcessor: {
        async process() {
          processCalls += 1;
          throw new Error("must not validate");
        },
      },
    });

    const response = await app.fetch(new Request(
      `http://teamline.local/api/work-orders/${workOrder.id}/start`,
      { method: "POST" },
    ));
    expect(response.status).toBe(200);
    await waitFor(() => store.get(workOrder.id)?.runStatus === "interrupted");
    expect(processCalls).toBe(0);
    expect(store.get(workOrder.id)).toMatchObject({
      status: "interrupted",
      currentSummary: "请选择发布范围",
    });
  });
});
