import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../src/app";
import type { CodexRunEvent, CodexRunner } from "../src/codex-runner";
import { WorkOrderStore } from "../src/work-order-store";

const repositoryPath = resolve(import.meta.dir, "..");

function readyWorkOrder(store: WorkOrderStore) {
  const created = store.create({ repositoryPath, goal: "完成一项测试委托" });
  return store.savePlan(created.id, [
    {
      outcome: "完成实现",
      scope: "相关代码",
      verification: "运行测试",
    },
  ]);
}

function fixedWorktreeManager(path = "/tmp/teamline/run-timeout") {
  return {
    async prepare() {
      return {
        path,
        branch: "teamline/run-timeout",
        baseCommit: "0123456789abcdef",
      };
    },
  };
}

function timeoutScheduler() {
  const tasks: Array<{
    delayMs: number;
    fire: () => void;
    cancelled: boolean;
  }> = [];
  return {
    tasks,
    schedule(callback: () => void, delayMs: number) {
      const task = {
        delayMs,
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
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(2);
  }
}

describe("run timeout", () => {
  test("saves the selected limit and restores it after reopening the database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-run-limit-"));
    const databasePath = join(directory, "teamline.sqlite");
    try {
      const database = new Database(databasePath);
      const store = new WorkOrderStore(database);
      const ready = readyWorkOrder(store);
      expect(ready.maxRunMinutes).toBe(60);

      const app = createApp({ store });
      const response = await app.fetch(
        new Request(
          `http://teamline.local/api/work-orders/${ready.id}/execution-settings`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ maxRunMinutes: 120 }),
          },
        ),
      );
      expect(response.status).toBe(200);
      expect((await response.json()).workOrder.maxRunMinutes).toBe(120);
      database.close();

      const reopened = new WorkOrderStore(new Database(databasePath));
      expect(reopened.get(ready.id)?.maxRunMinutes).toBe(120);
      reopened.database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("stops at the selected limit and keeps the timeout reason", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const ready = store.saveMaxRunMinutes(readyWorkOrder(store).id, 30);
    const scheduler = timeoutScheduler();
    let releaseExit!: () => void;
    const exitRequested = new Promise<void>((resolve) => {
      releaseExit = resolve;
    });
    let interrupts = 0;
    const runner: CodexRunner = {
      async start() {
        return {
          interrupt() {
            interrupts += 1;
            releaseExit();
          },
          events: (async function* (): AsyncGenerator<CodexRunEvent> {
            await exitRequested;
            yield { type: "exit", exitCode: 143, message: "Codex 已退出" };
          })(),
        };
      },
      async resume() {
        throw new Error("not used");
      },
    };
    const app = createApp({
      store,
      codexRunner: runner,
      worktreeManager: fixedWorktreeManager(),
      runTimeoutScheduler: scheduler.schedule,
    });

    await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${ready.id}/start`, {
        method: "POST",
      }),
    );
    expect(scheduler.tasks).toHaveLength(1);
    expect(scheduler.tasks[0].delayMs).toBe(30 * 60_000);
    scheduler.tasks[0].fire();

    await waitFor(() => store.get(ready.id)?.runStatus === "interrupted");
    expect(interrupts).toBe(1);
    expect(store.get(ready.id)).toMatchObject({
      status: "interrupted",
      currentSummary: "已达到本轮最长运行时间（30 分钟），Codex 已停止；可以继续委托",
    });
    expect(store.listRunEvents(ready.id).at(-1)?.message).toBe(
      "已达到本轮最长运行时间（30 分钟），Codex 已停止；可以继续委托",
    );
  });

  test("uses one timeout across resume and its fresh-run fallback", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-timeout-fallback-"));
    try {
      const store = new WorkOrderStore(new Database(":memory:"));
      const ready = store.saveMaxRunMinutes(readyWorkOrder(store).id, 30);
      store.saveWorktree(ready.id, {
        path: directory,
        branch: "teamline/continue-timeout",
        baseCommit: "0123456789abcdef",
      });
      store.markStarted(ready.id);
      store.recordSession(ready.id, "missing-session");
      store.recordInterrupted(ready.id);

      const scheduler = timeoutScheduler();
      let fallbackStarted = false;
      let releaseFallback!: () => void;
      const fallbackExit = new Promise<void>((resolve) => {
        releaseFallback = resolve;
      });
      let fallbackInterrupts = 0;
      const app = createApp({
        store,
        runTimeoutScheduler: scheduler.schedule,
        codexRunner: {
          async resume() {
            return {
              interrupt() {},
              events: (async function* () {
                yield {
                  type: "exit" as const,
                  exitCode: 1,
                  message: "Codex 会话不存在",
                  resumeUnavailable: true,
                };
              })(),
            };
          },
          async start() {
            fallbackStarted = true;
            return {
              interrupt() {
                fallbackInterrupts += 1;
                releaseFallback();
              },
              events: (async function* (): AsyncGenerator<CodexRunEvent> {
                await fallbackExit;
                yield { type: "exit", exitCode: 143, message: "Codex 已退出" };
              })(),
            };
          },
        },
      });

      const response = await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${ready.id}/continue`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(200);
      await waitFor(() => fallbackStarted);
      expect(scheduler.tasks).toHaveLength(1);

      scheduler.tasks[0].fire();
      await waitFor(() => store.get(ready.id)?.runStatus === "interrupted");
      expect(fallbackInterrupts).toBe(1);
      expect(store.get(ready.id)?.currentSummary).toContain("达到本轮最长运行时间");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("normal exit cancels its timeout", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const ready = readyWorkOrder(store);
    const scheduler = timeoutScheduler();
    let interrupts = 0;
    const app = createApp({
      store,
      worktreeManager: fixedWorktreeManager(),
      runTimeoutScheduler: scheduler.schedule,
      codexRunner: {
        async start() {
          return {
            interrupt() {
              interrupts += 1;
            },
            events: (async function* () {
              yield {
                type: "exit" as const,
                exitCode: 0,
                message: "Codex 已正常结束，等待结果处理",
              };
            })(),
          };
        },
        async resume() {
          throw new Error("not used");
        },
      },
    });

    await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${ready.id}/start`, {
        method: "POST",
      }),
    );
    await waitFor(() => store.get(ready.id)?.runStatus === "completed");
    expect(scheduler.tasks).toHaveLength(1);
    expect(scheduler.tasks[0].cancelled).toBe(true);
    scheduler.tasks[0].fire();
    expect(interrupts).toBe(0);
  });

  test("manual interrupt completion cancels its timeout", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const ready = readyWorkOrder(store);
    const scheduler = timeoutScheduler();
    let releaseExit!: () => void;
    const exitRequested = new Promise<void>((resolve) => {
      releaseExit = resolve;
    });
    const app = createApp({
      store,
      worktreeManager: fixedWorktreeManager(),
      runTimeoutScheduler: scheduler.schedule,
      codexRunner: {
        async start() {
          return {
            interrupt: releaseExit,
            events: (async function* (): AsyncGenerator<CodexRunEvent> {
              await exitRequested;
              yield { type: "exit", exitCode: 143, message: "Codex 已退出" };
            })(),
          };
        },
        async resume() {
          throw new Error("not used");
        },
      },
    });

    await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${ready.id}/start`, {
        method: "POST",
      }),
    );
    await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${ready.id}/interrupt`, {
        method: "POST",
      }),
    );
    await waitFor(() => store.get(ready.id)?.runStatus === "interrupted");
    expect(scheduler.tasks[0].cancelled).toBe(true);
  });

  test("start failure never leaves a timeout", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const ready = readyWorkOrder(store);
    const scheduler = timeoutScheduler();
    const app = createApp({
      store,
      worktreeManager: fixedWorktreeManager(),
      runTimeoutScheduler: scheduler.schedule,
      codexRunner: {
        async start() {
          throw new Error("Codex failed to start");
        },
        async resume() {
          throw new Error("not used");
        },
      },
    });

    const response = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${ready.id}/start`, {
        method: "POST",
      }),
    );
    expect(response.status).toBe(502);
    expect(scheduler.tasks).toHaveLength(0);
    expect(store.get(ready.id)).toMatchObject({ status: "ready", runStatus: null });
  });
});
