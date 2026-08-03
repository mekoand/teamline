import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { CodexExecutionRunner } from "../src/codex-runner";
import { LocalWorkOrderResultProcessor } from "../src/result-processor";
import { WorkOrderStore } from "../src/work-order-store";
import type { WorkOrder, WorkOrderResult } from "../src/work-order";

function git(repository: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", repository, ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function initializeRepository(repository: string) {
  git(repository, "init", "-b", "main");
  writeFileSync(join(repository, "README.md"), "# Before\n");
  git(repository, "add", "README.md");
  git(
    repository,
    "-c",
    "user.name=Teamline Tests",
    "-c",
    "user.email=teamline@example.test",
    "commit",
    "-m",
    "initial",
  );
}

function resultWorkOrder(
  store: WorkOrderStore,
  repository: string,
  commands: Array<string | undefined>,
): WorkOrder {
  const created = store.create({ repositoryPath: repository, goal: "整理执行结果" });
  const planned = store.savePlan(
    created.id,
    commands.map((verificationCommand, index) => ({
      outcome: `阶段 ${index + 1}`,
      scope: "README.md",
      verification: `人工检查 ${index + 1}`,
      verificationCommand,
    })),
  );
  let baseCommit = "0123456789abcdef";
  try {
    baseCommit = git(repository, "rev-parse", "HEAD");
  } catch {
    // Store-only API tests do not need a real worktree.
  }
  store.saveWorktree(planned.id, {
    path: repository,
    branch: "main",
    baseCommit,
  });
  return store.get(planned.id)!;
}

function resultFixture(
  workOrder: WorkOrder,
  status: "passed" | "failed" | "not_configured" = "passed",
): WorkOrderResult {
  const stage = workOrder.plan!.stages[0]!;
  return {
    planVersion: workOrder.plan!.version,
    git: { diffStat: "1 file changed, 1 insertion(+)", statusShort: " M README.md" },
    verifications: [
      {
        stageId: stage.id,
        stageOutcome: stage.outcome,
        command: status === "not_configured" ? null : "bun test",
        status,
        exitCode: status === "not_configured" ? null : status === "passed" ? 0 : 1,
        output: status === "not_configured" ? "未配置自动验证命令" : "test output",
      },
    ],
    completedAt: new Date().toISOString(),
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(2);
  }
}

describe("result review persistence", () => {
  test("stores an optional confirmed verification command and migrates delivered status", () => {
    const database = new Database(":memory:");
    const store = new WorkOrderStore(database);
    const created = store.create({ repositoryPath: "/tmp/example", goal: "完成结果验收" });
    const planned = store.savePlan(created.id, [
      {
        outcome: "结果可验收",
        scope: "src",
        verification: "运行自动测试并人工查看页面",
        verificationCommand: "bun test",
      },
    ]);

    expect(planned.plan?.stages[0]).toMatchObject({
      verification: "运行自动测试并人工查看页面",
      verificationCommand: "bun test",
    });

    database.query("UPDATE work_orders SET status = 'completed' WHERE id = ?").run(created.id);
    const reopened = new WorkOrderStore(database);
    expect(reopened.get(created.id)).toMatchObject({
      status: "delivered",
      plan: { stages: [{ status: "completed", statusReason: "已由你确认完成" }] },
    });
  });

  test("collects tracked and untracked changes and runs configured commands in stage order", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-result-processor-"));
    try {
      initializeRepository(directory);
      writeFileSync(join(directory, "README.md"), "# After\n");
      writeFileSync(join(directory, "untracked.txt"), "new\n");
      const store = new WorkOrderStore(new Database(":memory:"));
      const workOrder = resultWorkOrder(store, directory, [
        "pwd; printf first > command-order.txt; printf alpha",
        'test "$(cat command-order.txt)" = first; printf beta',
        undefined,
      ]);

      const result = await new LocalWorkOrderResultProcessor().process(workOrder);

      expect(result.git.diffStat).toContain("README.md");
      expect(result.git.statusShort).toContain("M README.md");
      expect(result.git.statusShort).toContain("?? untracked.txt");
      expect(result.verifications.map((verification) => verification.status)).toEqual([
        "passed",
        "passed",
        "not_configured",
      ]);
      expect(result.verifications[0]?.output).toContain(directory);
      expect(result.verifications[1]?.output).toBe("beta");
      expect(result.verifications[2]).toMatchObject({
        command: null,
        exitCode: null,
        output: "未配置自动验证命令",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("records a failed command and continues remaining stages", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-result-failure-"));
    try {
      initializeRepository(directory);
      const store = new WorkOrderStore(new Database(":memory:"));
      const workOrder = resultWorkOrder(store, directory, [
        "printf before",
        "printf failed >&2; exit 7",
        "printf after",
      ]);

      const result = await new LocalWorkOrderResultProcessor().process(workOrder);

      expect(result.verifications).toMatchObject([
        { status: "passed", exitCode: 0, output: "before" },
        { status: "failed", exitCode: 7, output: "failed" },
        { status: "passed", exitCode: 0, output: "after" },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("moves through verifying before review and keeps verification active", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const planned = store.savePlan(
      store.create({ repositoryPath: "/tmp/source", goal: "完成结果验收" }).id,
      [
        {
          outcome: "结果可验收",
          scope: "README.md",
          verification: "检查结果",
        },
      ],
    );
    let finishProcessing!: (result: WorkOrderResult) => void;
    const processing = new Promise<WorkOrderResult>((resolve) => {
      finishProcessing = resolve;
    });
    const app = createApp({
      store,
      worktreeManager: {
        async prepare() {
          return {
            path: "/tmp/delegated",
            branch: "teamline/result-review",
            baseCommit: "0123456789abcdef",
          };
        },
      },
      codexRunner: {
        async start() {
          return {
            pid: 4242,
            interrupt() {},
            events: (async function* () {
              yield { type: "exit" as const, exitCode: 0, message: "Codex 已正常结束" };
            })(),
          };
        },
        async resume() {
          throw new Error("not used");
        },
      },
      resultProcessor: {
        async process(workOrder) {
          expect(workOrder.runStatus).toBe("verifying");
          return processing;
        },
      },
    });

    const response = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${planned.id}/start`, {
        method: "POST",
      }),
    );
    expect(response.status).toBe(200);
    await waitFor(() => store.get(planned.id)?.runStatus === "verifying");
    expect(store.get(planned.id)).toMatchObject({
      status: "running",
      runStatus: "verifying",
      runPid: null,
    });
    expect(store.hasActiveRun()).toBe(true);

    finishProcessing(resultFixture(store.get(planned.id)!, "not_configured"));
    await waitFor(() => store.get(planned.id)?.status === "review");
    expect(store.get(planned.id)).toMatchObject({
      status: "review",
      runStatus: "completed",
      currentSummary: "等待人工验收",
      result: {
        verifications: [{ status: "not_configured", output: "未配置自动验证命令" }],
      },
    });
  });

  test("moves a work order to interrupted when a verification command fails", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const planned = store.savePlan(
      store.create({ repositoryPath: "/tmp/source", goal: "完成结果验收" }).id,
      [
        {
          outcome: "结果可验收",
          scope: "README.md",
          verification: "检查结果",
          verificationCommand: "bun test",
        },
      ],
    );
    const app = createApp({
      store,
      worktreeManager: {
        async prepare() {
          return {
            path: "/tmp/delegated",
            branch: "teamline/result-failure",
            baseCommit: "0123456789abcdef",
          };
        },
      },
      codexRunner: {
        async start() {
          return {
            interrupt() {},
            events: (async function* () {
              yield { type: "exit" as const, exitCode: 0, message: "Codex 已正常结束" };
            })(),
          };
        },
        async resume() {
          throw new Error("not used");
        },
      },
      resultProcessor: {
        async process(workOrder) {
          return resultFixture(workOrder, "failed");
        },
      },
    });

    await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${planned.id}/start`, {
        method: "POST",
      }),
    );
    await waitFor(() => store.get(planned.id)?.status === "interrupted");
    expect(store.get(planned.id)).toMatchObject({
      status: "interrupted",
      runStatus: "failed",
      currentSummary: "自动验证未通过",
      lastError: "自动验证未通过，请查看验证结果后继续处理",
      result: { verifications: [{ status: "failed", exitCode: 1 }] },
    });
  });

  test("only review work orders can be delivered", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const workOrder = resultWorkOrder(store, "/tmp/delegated", [undefined]);
    store.markStarted(workOrder.id);
    const verifying = store.beginResultProcessing(workOrder.id, "Codex 已正常结束");
    store.completeReview(workOrder.id, resultFixture(verifying, "not_configured"));
    const app = createApp({ store });

    const deliveredResponse = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${workOrder.id}/deliver`, {
        method: "POST",
      }),
    );
    expect(deliveredResponse.status).toBe(200);
    expect((await deliveredResponse.json()).workOrder).toMatchObject({
      status: "delivered",
      runStatus: "completed",
      currentSummary: "已由用户确认交付",
      plan: {
        stages: [
          {
            status: "completed",
            statusReason: "已由你确认完成",
          },
        ],
      },
    });

    const duplicate = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${workOrder.id}/deliver`, {
        method: "POST",
      }),
    );
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ code: "WORK_ORDER_NOT_IN_REVIEW" });
  });

  test("supplemental requirements copy the stages into a new ready plan version", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const workOrder = resultWorkOrder(store, "/tmp/delegated", ["bun test"]);
    store.markStarted(workOrder.id);
    const verifying = store.beginResultProcessing(workOrder.id, "Codex 已正常结束");
    const oldResult = resultFixture(verifying);
    store.completeReview(workOrder.id, oldResult);
    const app = createApp({ store });

    const response = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${workOrder.id}/revise`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revisionNote: "补充移动端空状态" }),
      }),
    );
    const revised = (await response.json()).workOrder as WorkOrder;

    expect(response.status).toBe(200);
    expect(revised).toMatchObject({
      status: "ready",
      runStatus: null,
      revisionNote: "补充移动端空状态",
      result: oldResult,
      plan: { version: 2 },
    });
    expect(revised.plan?.stages).toEqual(workOrder.plan?.stages);
  });

  test("includes the saved supplemental requirement in the next Codex prompt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-revision-prompt-"));
    const executable = join(directory, "fake-codex");
    const invocation = join(directory, "invocation.txt");
    try {
      writeFileSync(
        executable,
        [
          "#!/bin/sh",
          `printf '<%s>\\n' "$@" > "${invocation}"`,
          "exit 0",
          "",
        ].join("\n"),
      );
      chmodSync(executable, 0o755);
      const store = new WorkOrderStore(new Database(":memory:"));
      const planned = resultWorkOrder(store, directory, [undefined]);
      store.markStarted(planned.id);
      const verifying = store.beginResultProcessing(planned.id, "Codex 已正常结束");
      store.completeReview(planned.id, resultFixture(verifying, "not_configured"));
      const revised = store.revise(planned.id, "补充移动端空状态");

      const run = await new CodexExecutionRunner(executable).start({
        workOrder: revised,
        workspacePath: directory,
      });
      for await (const _event of run.events) {
        // Drain the process events so the invocation file is complete.
      }

      expect(readFileSync(invocation, "utf8")).toContain("补充要求：\n补充移动端空状态");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("service restart interrupts verification and preserves the last complete result", () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-verifying-restart-"));
    const databasePath = join(directory, "teamline.db");
    try {
      const firstDatabase = new Database(databasePath, { create: true });
      const firstStore = new WorkOrderStore(firstDatabase);
      const workOrder = resultWorkOrder(firstStore, "/tmp/delegated", [undefined]);
      firstStore.markStarted(workOrder.id);
      const firstVerifying = firstStore.beginResultProcessing(
        workOrder.id,
        "Codex 已正常结束",
      );
      const oldResult = resultFixture(firstVerifying, "not_configured");
      firstStore.completeReview(workOrder.id, oldResult);
      firstStore.revise(workOrder.id, "继续完善");
      firstStore.markStarted(workOrder.id);
      firstStore.beginResultProcessing(workOrder.id, "Codex 已正常结束");
      firstDatabase.close();

      const reopenedDatabase = new Database(databasePath);
      const reopenedStore = new WorkOrderStore(reopenedDatabase);
      expect(reopenedStore.interruptActiveRunsAfterRestart(() => false)).toBe(1);
      expect(reopenedStore.get(workOrder.id)).toMatchObject({
        status: "interrupted",
        runStatus: "interrupted",
        result: oldResult,
      });
      reopenedDatabase.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("result processing exceptions interrupt the work order without replacing an old result", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const workOrder = resultWorkOrder(store, "/tmp/delegated", [undefined]);
    store.markStarted(workOrder.id);
    const firstVerifying = store.beginResultProcessing(workOrder.id, "Codex 已正常结束");
    const oldResult = resultFixture(firstVerifying, "not_configured");
    store.completeReview(workOrder.id, oldResult);
    store.revise(workOrder.id, "继续完善");
    const app = createApp({
      store,
      worktreeManager: {
        async prepare() {
          return {
            path: "/tmp/delegated",
            branch: "main",
            baseCommit: "0123456789abcdef",
          };
        },
      },
      codexRunner: {
        async start() {
          return {
            interrupt() {},
            events: (async function* () {
              yield { type: "exit" as const, exitCode: 0, message: "Codex 已正常结束" };
            })(),
          };
        },
        async resume() {
          throw new Error("not used");
        },
      },
      resultProcessor: {
        async process() {
          throw new Error("git failed");
        },
      },
    });

    await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${workOrder.id}/start`, {
        method: "POST",
      }),
    );
    await waitFor(() => store.get(workOrder.id)?.status === "interrupted");
    expect(store.get(workOrder.id)).toMatchObject({
      status: "interrupted",
      runStatus: "failed",
      currentSummary: "结果整理失败",
      result: oldResult,
    });
  });

  test("persists a delivered status and result after reopening the database", () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-delivered-reopen-"));
    const databasePath = join(directory, "teamline.db");
    try {
      const firstDatabase = new Database(databasePath, { create: true });
      const firstStore = new WorkOrderStore(firstDatabase);
      const workOrder = resultWorkOrder(firstStore, "/tmp/delegated", [undefined]);
      firstStore.markStarted(workOrder.id);
      const verifying = firstStore.beginResultProcessing(workOrder.id, "Codex 已正常结束");
      const result = resultFixture(verifying, "not_configured");
      firstStore.completeReview(workOrder.id, result);
      firstStore.confirmDelivered(workOrder.id);
      firstDatabase.close();

      const reopenedDatabase = new Database(databasePath);
      const reopened = new WorkOrderStore(reopenedDatabase).get(workOrder.id);
      expect(reopened).toMatchObject({ status: "delivered", result });
      reopenedDatabase.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects plan changes after execution starts so unconfirmed commands cannot run", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const workOrder = resultWorkOrder(store, "/tmp/delegated", ["printf confirmed"]);
    store.markStarted(workOrder.id);
    let generations = 0;
    const app = createApp({
      store,
      planGenerator: {
        async generate() {
          generations += 1;
          return {
            stages: [
              {
                outcome: "注入阶段",
                scope: "README.md",
                verification: "运行注入命令",
                verificationCommand: "printf injected",
              },
            ],
          };
        },
      },
    });

    const update = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${workOrder.id}/plan`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stages: [
            {
              outcome: "注入阶段",
              scope: "README.md",
              verification: "运行注入命令",
              verificationCommand: "printf injected",
            },
          ],
        }),
      }),
    );
    const generate = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${workOrder.id}/plan/generate`, {
        method: "POST",
      }),
    );

    expect(update.status).toBe(409);
    expect(await update.json()).toMatchObject({ code: "WORK_ORDER_PLAN_LOCKED" });
    expect(generate.status).toBe(409);
    expect(await generate.json()).toMatchObject({ code: "WORK_ORDER_PLAN_LOCKED" });
    expect(generations).toBe(0);
    expect(store.get(workOrder.id)?.plan?.stages[0]?.verificationCommand).toBe(
      "printf confirmed",
    );
  });

  test("rejects a generated command if execution starts while planning is in flight", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const workOrder = resultWorkOrder(store, "/tmp/delegated", ["printf confirmed"]);
    let releaseGeneration!: () => void;
    let generationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      generationStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseGeneration = resolve;
    });
    const app = createApp({
      store,
      planGenerator: {
        async generate() {
          generationStarted();
          await blocked;
          return {
            stages: [
              {
                outcome: "注入阶段",
                scope: "README.md",
                verification: "运行注入命令",
                verificationCommand: "printf injected",
              },
            ],
          };
        },
      },
    });

    const pendingResponse = app.fetch(
      new Request(`http://teamline.local/api/work-orders/${workOrder.id}/plan/generate`, {
        method: "POST",
      }),
    );
    await started;
    store.markStarted(workOrder.id);
    releaseGeneration();
    const response = await pendingResponse;

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "WORK_ORDER_PLAN_LOCKED" });
    expect(store.get(workOrder.id)?.plan?.stages[0]?.verificationCommand).toBe(
      "printf confirmed",
    );
  });
});
