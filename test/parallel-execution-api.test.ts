import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../src/app";
import type { CodexRunEvent, CodexRunner } from "../src/codex-runner";
import { WorkOrderStore } from "../src/work-order-store";
import { GitWorktreeManager } from "../src/worktree-manager";

const repositoryPath = resolve(import.meta.dir, "..");

function readyWorkOrder(store: WorkOrderStore, goal: string) {
  const created = store.create({ repositoryPath, goal });
  return store.savePlan(created.id, [
    {
      outcome: `完成${goal}`,
      scope: "相关代码",
      verification: "运行测试",
    },
  ]);
}

function controlledRun() {
  let release!: () => void;
  const released = new Promise<void>((resolveRelease) => {
    release = resolveRelease;
  });
  return {
    release,
    run: {
      interrupt() {},
      events: (async function* (): AsyncGenerator<CodexRunEvent> {
        await released;
        yield {
          type: "exit",
          exitCode: 0,
          message: "Codex 已正常结束，等待结果处理",
        };
      })(),
    },
  };
}

function start(app: ReturnType<typeof createApp>, id: string) {
  return app.fetch(
    new Request(`http://teamline.local/api/work-orders/${id}/start`, {
      method: "POST",
    }),
  );
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(2);
  }
}

function git(repository: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", repository, ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function initializeGitRepository(repository: string) {
  const initialized = Bun.spawnSync(["git", "init", "-b", "main", repository]);
  if (initialized.exitCode !== 0) throw new Error(initialized.stderr.toString());
  writeFileSync(join(repository, "README.md"), "# Parallel worktrees\n");
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

describe("parallel work order execution", () => {
  test("the conservative default runs two work orders and rejects a third", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const controlledRuns = [controlledRun(), controlledRun(), controlledRun()];
    let starts = 0;
    const runner: CodexRunner = {
      async start() {
        return controlledRuns[starts++]!.run;
      },
      async resume() {
        throw new Error("not used");
      },
    };
    const app = createApp({
      store,
      codexRunner: runner,
      worktreeManager: {
        async prepare(workOrder) {
          return {
            path: `/tmp/teamline/${workOrder.id}`,
            branch: `teamline/${workOrder.id}`,
            baseCommit: "0123456789abcdef",
          };
        },
      },
    });
    const first = readyWorkOrder(store, "第一个目标");
    const second = readyWorkOrder(store, "第二个目标");
    const third = readyWorkOrder(store, "第三个目标");

    const firstResponse = await start(app, first.id);
    const secondResponse = await start(app, second.id);
    const thirdResponse = await start(app, third.id);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(store.get(first.id)?.runStatus).toBe("running");
    expect(store.get(second.id)?.runStatus).toBe("running");
    expect(thirdResponse.status).toBe(409);
    expect(await thirdResponse.json()).toEqual({
      code: "CONCURRENCY_LIMIT_REACHED",
      error: "已达到本机最大并发数（2），请等待一个目标结束或调整设置",
    });
    expect(starts).toBe(2);

    controlledRuns[0]!.release();
    controlledRuns[1]!.release();
  });

  test("maximum concurrency is persisted and controls when ready work is queued", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-concurrency-settings-"));
    const databasePath = join(directory, "teamline.db");
    let database: Database | undefined;
    try {
      database = new Database(databasePath, { create: true });
      let store = new WorkOrderStore(database);
      let app = createApp({ store });

      const defaultResponse = await app.fetch(
        new Request("http://teamline.local/api/execution-settings"),
      );
      expect(await defaultResponse.json()).toEqual({
        executionSettings: { maxConcurrency: 2 },
      });

      for (const maxConcurrency of [5, 7, 12]) {
        const saveResponse = await app.fetch(
          new Request("http://teamline.local/api/execution-settings", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ maxConcurrency }),
          }),
        );
        expect(saveResponse.status).toBe(200);
        database.close();

        database = new Database(databasePath);
        store = new WorkOrderStore(database);
        app = createApp({ store });
        expect(store.getExecutionSettings()).toEqual({ maxConcurrency });
      }

      store.saveMaxConcurrency(3);
      const first = readyWorkOrder(store, "运行一");
      const second = readyWorkOrder(store, "运行二");
      const ready = readyWorkOrder(store, "等待运行");
      store.markStarted(first.id);
      store.markStarted(second.id);

      const available = await createApp({ store }).fetch(
        new Request("http://teamline.local/api/console"),
      );
      const availableWorkOrders = (await available.json()).workOrders;
      expect(
        availableWorkOrders.find((workOrder: { id: string }) => workOrder.id === ready.id),
      ).toMatchObject({ userStatus: "queued", statusReason: "可以开始运行" });

      const third = readyWorkOrder(store, "运行三");
      store.markStarted(third.id);
      const full = await createApp({ store }).fetch(
        new Request("http://teamline.local/api/console"),
      );
      const fullWorkOrders = (await full.json()).workOrders;
      expect(
        fullWorkOrders.find((workOrder: { id: string }) => workOrder.id === ready.id),
      ).toMatchObject({ userStatus: "queued", statusReason: "等待可用并发位置" });
      database.close();
      database = undefined;
    } finally {
      database?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("the same physical workspace cannot be shared by active work orders", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-workspace-owner-"));
    try {
      const store = new WorkOrderStore(new Database(":memory:"));
      const firstRun = controlledRun();
      const app = createApp({
        store,
        codexRunner: {
          async start() {
            return firstRun.run;
          },
          async resume() {
            throw new Error("not used");
          },
        },
        worktreeManager: {
          async prepare() {
            return {
              path: directory,
              branch: "teamline/shared",
              baseCommit: "0123456789abcdef",
            };
          },
        },
      });
      const first = readyWorkOrder(store, "独占工作区一");
      const second = readyWorkOrder(store, "独占工作区二");

      expect((await start(app, first.id)).status).toBe(200);
      const conflict = await start(app, second.id);

      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toEqual({
        code: "WORKSPACE_IN_USE",
        error: "这个工作区已由另一个活动目标使用，请选择其他工作区",
      });
      expect(store.get(first.id)?.runStatus).toBe("running");
      expect(store.get(second.id)?.runStatus).toBeNull();
      firstRun.release();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("simultaneous starts cannot reserve the same physical workspace", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-workspace-race-"));
    try {
      const store = new WorkOrderStore(new Database(":memory:"));
      const activeRun = controlledRun();
      let prepareCount = 0;
      let releasePreparation!: () => void;
      const bothPreparing = new Promise<void>((resolvePreparation) => {
        releasePreparation = resolvePreparation;
      });
      let startCount = 0;
      const app = createApp({
        store,
        codexRunner: {
          async start() {
            startCount += 1;
            return activeRun.run;
          },
          async resume() {
            throw new Error("not used");
          },
        },
        worktreeManager: {
          async prepare() {
            prepareCount += 1;
            if (prepareCount === 2) releasePreparation();
            await bothPreparing;
            return {
              path: directory,
              branch: "teamline/shared-race",
              baseCommit: "0123456789abcdef",
            };
          },
        },
      });
      const first = readyWorkOrder(store, "竞态工作区一");
      const second = readyWorkOrder(store, "竞态工作区二");

      const responses = await Promise.all([start(app, first.id), start(app, second.id)]);

      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      expect(startCount).toBe(1);
      expect(store.activeRunIds()).toHaveLength(1);
      const conflict = responses.find((response) => response.status === 409)!;
      expect(await conflict.json()).toMatchObject({ code: "WORKSPACE_IN_USE" });
      activeRun.release();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("two Git work orders prepared together receive distinct worktrees and branches", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-parallel-worktrees-"));
    const repository = join(directory, "source");
    try {
      initializeGitRepository(repository);
      const store = new WorkOrderStore(new Database(":memory:"));
      const first = store.create({ repositoryPath: repository, goal: "Git 目标一" });
      const second = store.create({ repositoryPath: repository, goal: "Git 目标二" });
      const manager = new GitWorktreeManager(join(directory, "delegated"));

      const [firstWorktree, secondWorktree] = await Promise.all([
        manager.prepare(first),
        manager.prepare(second),
      ]);

      expect(firstWorktree.path).not.toBe(secondWorktree.path);
      expect(firstWorktree.branch).not.toBe(secondWorktree.branch);
      expect(git(firstWorktree.path, "branch", "--show-current")).toBe(
        firstWorktree.branch,
      );
      expect(git(secondWorktree.path, "branch", "--show-current")).toBe(
        secondWorktree.branch,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("interrupting and continuing one run leaves the other run untouched", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-independent-runs-"));
    try {
      const store = new WorkOrderStore(new Database(":memory:"));
      const exits = new Map<string, () => void>();
      const interrupts = new Map<string, number>();
      const continuedRun = controlledRun();
      const runner: CodexRunner = {
        async start({ workOrder }) {
          let release!: () => void;
          const exit = new Promise<void>((resolveExit) => {
            release = resolveExit;
          });
          exits.set(workOrder.id, release);
          return {
            interrupt() {
              interrupts.set(workOrder.id, (interrupts.get(workOrder.id) ?? 0) + 1);
              release();
            },
            events: (async function* (): AsyncGenerator<CodexRunEvent> {
              yield { type: "session", sessionId: `session-${workOrder.id}` };
              await exit;
              yield { type: "exit", exitCode: 143, message: "Codex 已退出" };
            })(),
          };
        },
        async resume() {
          return continuedRun.run;
        },
      };
      const app = createApp({
        store,
        codexRunner: runner,
        worktreeManager: {
          async prepare(workOrder) {
            const path = join(directory, workOrder.id);
            mkdirSync(path);
            return {
              path,
              branch: `teamline/${workOrder.id}`,
              baseCommit: "0123456789abcdef",
            };
          },
        },
      });
      const first = readyWorkOrder(store, "暂停再继续");
      const second = readyWorkOrder(store, "保持运行");
      await start(app, first.id);
      await start(app, second.id);
      await waitFor(() => Boolean(store.get(first.id)?.sessionId));

      const interrupt = await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${first.id}/interrupt`, {
          method: "POST",
        }),
      );
      expect(interrupt.status).toBe(200);
      await waitFor(() => store.get(first.id)?.status === "interrupted");
      expect(interrupts.get(first.id)).toBe(1);
      expect(interrupts.get(second.id) ?? 0).toBe(0);
      expect(store.get(second.id)).toMatchObject({
        status: "running",
        runStatus: "running",
        runNumber: 1,
      });

      const continued = await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${first.id}/continue`, {
          method: "POST",
        }),
      );
      expect(continued.status).toBe(200);
      expect(store.get(first.id)).toMatchObject({ runStatus: "running", runNumber: 2 });
      expect(store.get(second.id)).toMatchObject({ runStatus: "running", runNumber: 1 });

      exits.get(second.id)?.();
      continuedRun.release();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("result processing for one run does not release or interrupt another run", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const firstRun = controlledRun();
    const secondRun = controlledRun();
    let starts = 0;
    let finishProcessing!: () => void;
    const processing = new Promise<void>((resolveProcessing) => {
      finishProcessing = resolveProcessing;
    });
    const app = createApp({
      store,
      codexRunner: {
        async start() {
          return [firstRun.run, secondRun.run][starts++]!;
        },
        async resume() {
          throw new Error("not used");
        },
      },
      worktreeManager: {
        async prepare(workOrder) {
          return {
            path: `/tmp/teamline/result-${workOrder.id}`,
            branch: `teamline/${workOrder.id}`,
            baseCommit: "0123456789abcdef",
          };
        },
      },
      resultProcessor: {
        async process(workOrder) {
          await processing;
          return {
            planVersion: workOrder.plan!.version,
            git: { diffStat: "", statusShort: "" },
            verifications: [{
              stageId: workOrder.plan!.stages[0]!.id,
              stageOutcome: workOrder.plan!.stages[0]!.outcome,
              command: "check",
              status: "passed",
              exitCode: 0,
              output: "pass",
            }],
            completedAt: new Date().toISOString(),
          };
        },
      },
    });
    const first = readyWorkOrder(store, "先整理结果");
    const second = readyWorkOrder(store, "继续执行");
    await start(app, first.id);
    await start(app, second.id);

    firstRun.release();
    await waitFor(() => store.get(first.id)?.runStatus === "verifying");
    expect(store.get(second.id)?.runStatus).toBe("running");

    finishProcessing();
    await waitFor(() => store.get(first.id)?.status === "review");
    expect(store.get(second.id)?.runStatus).toBe("running");
    secondRun.release();
  });

  test("simultaneous start requests reserve capacity before worktree preparation", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const runs = [controlledRun(), controlledRun(), controlledRun()];
    let starts = 0;
    const app = createApp({
      store,
      codexRunner: {
        async start() {
          return runs[starts++]!.run;
        },
        async resume() {
          throw new Error("not used");
        },
      },
      worktreeManager: {
        async prepare(workOrder) {
          await Bun.sleep(5);
          return {
            path: `/tmp/teamline/race-${workOrder.id}`,
            branch: `teamline/${workOrder.id}`,
            baseCommit: "0123456789abcdef",
          };
        },
      },
    });
    const workOrders = [
      readyWorkOrder(store, "并发请求一"),
      readyWorkOrder(store, "并发请求二"),
      readyWorkOrder(store, "并发请求三"),
    ];

    const responses = await Promise.all(
      workOrders.map((workOrder) => start(app, workOrder.id)),
    );

    expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 409]);
    expect(starts).toBe(2);
    expect(store.activeRunIds()).toHaveLength(2);
    runs[0]!.release();
    runs[1]!.release();
  });

  test("each parallel run has an independent run-time limit", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const tasks: Array<{ fire: () => void; cancelled: boolean }> = [];
    const interrupts = new Map<string, number>();
    const exits = new Map<string, () => void>();
    const app = createApp({
      store,
      runTimeoutScheduler(callback) {
        const task = {
          cancelled: false,
          fire() {
            if (!task.cancelled) callback();
          },
        };
        tasks.push(task);
        return () => {
          task.cancelled = true;
        };
      },
      codexRunner: {
        async start({ workOrder }) {
          let release!: () => void;
          const exit = new Promise<void>((resolveExit) => {
            release = resolveExit;
          });
          exits.set(workOrder.id, release);
          return {
            interrupt() {
              interrupts.set(workOrder.id, (interrupts.get(workOrder.id) ?? 0) + 1);
              release();
            },
            events: (async function* (): AsyncGenerator<CodexRunEvent> {
              await exit;
              yield { type: "exit", exitCode: 143, message: "Codex 已退出" };
            })(),
          };
        },
        async resume() {
          throw new Error("not used");
        },
      },
      worktreeManager: {
        async prepare(workOrder) {
          return {
            path: `/tmp/teamline/timeout-${workOrder.id}`,
            branch: `teamline/${workOrder.id}`,
            baseCommit: "0123456789abcdef",
          };
        },
      },
    });
    const first = readyWorkOrder(store, "计时一");
    const second = readyWorkOrder(store, "计时二");
    await start(app, first.id);
    await start(app, second.id);
    expect(tasks).toHaveLength(2);

    tasks[0]!.fire();
    await waitFor(() => store.get(first.id)?.status === "interrupted");

    expect(interrupts.get(first.id)).toBe(1);
    expect(interrupts.get(second.id) ?? 0).toBe(0);
    expect(tasks[1]!.cancelled).toBe(false);
    expect(store.get(second.id)?.runStatus).toBe("running");
    exits.get(second.id)?.();
    await waitFor(() => store.get(second.id)?.runStatus === "failed");
  });

  test("restart releases only dead runs while live runs keep their capacity", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-parallel-restart-"));
    const databasePath = join(directory, "teamline.db");
    try {
      const firstStore = new WorkOrderStore(new Database(databasePath, { create: true }));
      const live = readyWorkOrder(firstStore, "仍在运行");
      const dead = readyWorkOrder(firstStore, "已经退出");
      const next = readyWorkOrder(firstStore, "重启后启动");
      firstStore.bindExecutionIdentity(live.id);
      firstStore.markStarted(live.id);
      firstStore.recordRunPid(live.id, 101);
      firstStore.bindExecutionIdentity(dead.id);
      firstStore.markStarted(dead.id);
      firstStore.recordRunPid(dead.id, 202);
      firstStore.database.close();

      const reopenedStore = new WorkOrderStore(new Database(databasePath));
      expect(reopenedStore.interruptActiveRunsAfterRestart((pid) => pid === 101)).toBe(1);
      expect(reopenedStore.get(live.id)).toMatchObject({
        status: "running",
        runStatus: "running",
        runPid: 101,
      });
      expect(reopenedStore.get(dead.id)).toMatchObject({
        status: "interrupted",
        runStatus: "interrupted",
      });

      const nextRun = controlledRun();
      const app = createApp({
        store: reopenedStore,
        codexRunner: {
          async start() {
            return nextRun.run;
          },
          async resume() {
            throw new Error("not used");
          },
        },
        worktreeManager: {
          async prepare(workOrder) {
            return {
              path: join(directory, workOrder.id),
              branch: `teamline/${workOrder.id}`,
              baseCommit: "0123456789abcdef",
            };
          },
        },
      });
      expect((await start(app, next.id)).status).toBe(200);
      expect(reopenedStore.activeRunIds().sort()).toEqual([live.id, next.id].sort());
      nextRun.release();
      await waitFor(() => reopenedStore.get(next.id)?.runStatus === "completed");
      reopenedStore.database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
