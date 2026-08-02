import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../src/app";
import { CodexExecutionRunner, type CodexRunner } from "../src/codex-runner";
import { WorkOrderStore } from "../src/work-order-store";
import { GitWorktreeManager } from "../src/worktree-manager";

const repositoryPath = resolve(import.meta.dir, "..");

async function* emptyEvents() {}

async function* runEvents(...events: import("../src/codex-runner").CodexRunEvent[]) {
  for (const event of events) {
    yield event;
  }
}

async function* controlledExitEvents(register: (finish: () => void) => void) {
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => {
    finish = resolve;
  });
  register(finish);
  await ready;
  yield {
    type: "exit" as const,
    exitCode: 0,
    message: "Codex 已正常结束，等待结果处理",
  };
}

function fixedWorktreeManager() {
  return {
    async prepare() {
      return {
        path: "/tmp/teamline/work-order-1",
        branch: "teamline/work-order-1",
        baseCommit: "0123456789abcdef",
      };
    },
  };
}

function readyWorkOrder(store: WorkOrderStore) {
  const created = store.create({
    repositoryPath,
    goal: "为设置页面增加深色模式",
  });
  return store.savePlan(created.id, [
    {
      outcome: "设置页面跟随系统深色模式",
      scope: "设置页面及主题样式",
      verification: "运行相关测试",
    },
  ]);
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for condition");
    }
    await Bun.sleep(2);
  }
}

function initializeGitRepository(repository: string) {
  const initialized = Bun.spawnSync(["git", "init", "-b", "main", repository]);
  if (initialized.exitCode !== 0) {
    throw new Error(initialized.stderr.toString());
  }
  writeFileSync(join(repository, "README.md"), "# Example\n");
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

function git(repository: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", repository, ...args]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return result.stdout.toString().trim();
}

describe("work order API", () => {
  test("a confirmed plan starts Codex in its delegated worktree", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const starts: Parameters<CodexRunner["start"]>[0][] = [];
    const app = createApp({
      store,
      codexRunner: {
        async start(request) {
          starts.push(request);
          return { events: emptyEvents() };
        },
      },
      worktreeManager: {
        async prepare() {
          return {
            path: "/tmp/teamline/work-order-1",
            branch: "teamline/work-order-1",
            baseCommit: "0123456789abcdef",
          };
        },
      },
    });
    const created = store.create({
      repositoryPath,
      goal: "为设置页面增加深色模式",
    });
    store.savePlan(created.id, [
      {
        outcome: "设置页面跟随系统深色模式",
        scope: "设置页面及主题样式",
        verification: "运行相关测试",
      },
    ]);

    const response = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/start`, {
        method: "POST",
      }),
    );
    const { workOrder } = await response.json();

    expect(response.status).toBe(200);
    expect(workOrder).toMatchObject({
      id: created.id,
      status: "running",
      currentSummary: "Codex 已启动",
      worktreePath: "/tmp/teamline/work-order-1",
      executionBranch: "teamline/work-order-1",
      baseCommit: "0123456789abcdef",
      runStartedAt: expect.any(String),
      runtimeMs: expect.any(Number),
    });
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      workspacePath: "/tmp/teamline/work-order-1",
      workOrder: { id: created.id },
    });
  });

  test("first start creates a real delegated Git worktree and branch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-worktree-test-"));
    const sourceRepository = join(directory, "source");
    const worktreeRoot = join(directory, "delegated");

    try {
      initializeGitRepository(sourceRepository);
      const store = new WorkOrderStore(new Database(":memory:"));
      let codexWorkspace = "";
      const worktreeManager = new GitWorktreeManager(worktreeRoot);
      const app = createApp({
        store,
        codexRunner: {
          async start({ workspacePath }) {
            codexWorkspace = workspacePath;
            return {
              events: runEvents({
                type: "exit",
                exitCode: 0,
                message: "Codex 已正常结束，等待结果处理",
              }),
            };
          },
        },
        worktreeManager,
      });
      const created = store.create({
        repositoryPath: sourceRepository,
        goal: "更新 README",
      });
      store.savePlan(created.id, [
        {
          outcome: "README 已更新",
          scope: "README.md",
          verification: "检查 README 内容",
        },
      ]);
      const sourceCommit = git(sourceRepository, "rev-parse", "HEAD");
      const halfCreated = await worktreeManager.prepare(created);

      const response = await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${created.id}/start`, {
          method: "POST",
        }),
      );
      const { workOrder } = await response.json();

      expect(response.status).toBe(200);
      expect(workOrder.worktreePath).toBe(join(worktreeRoot, created.id));
      expect(workOrder.worktreePath).not.toBe(sourceRepository);
      expect(workOrder.executionBranch).toBe(`teamline/work-order-${created.id}`);
      expect(workOrder.baseCommit).toBe(sourceCommit);
      expect(workOrder.worktreePath).toBe(halfCreated.path);
      expect(codexWorkspace).toBe(workOrder.worktreePath);
      expect(existsSync(join(workOrder.worktreePath, ".git"))).toBe(true);
      expect(git(workOrder.worktreePath, "branch", "--show-current")).toBe(
        workOrder.executionBranch,
      );

      await waitFor(() => store.get(created.id)?.runStatus === "completed");
      const branchOnlyCreated = store.create({
        repositoryPath: sourceRepository,
        goal: "补充 README 示例",
      });
      const branchOnly = store.savePlan(branchOnlyCreated.id, [
        {
          outcome: "README 包含示例",
          scope: "README.md",
          verification: "检查 README 内容",
        },
      ]);
      const branchOnlyName = `teamline/work-order-${branchOnly.id}`;
      git(sourceRepository, "branch", branchOnlyName, sourceCommit);
      const branchOnlyResponse = await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${branchOnly.id}/start`, {
          method: "POST",
        }),
      );
      const { workOrder: mountedBranch } = await branchOnlyResponse.json();
      expect(branchOnlyResponse.status).toBe(200);
      expect(mountedBranch.executionBranch).toBe(branchOnlyName);
      expect(existsSync(join(mountedBranch.worktreePath, ".git"))).toBe(true);

      const missingCreated = store.create({
        repositoryPath: sourceRepository,
        goal: "验证 worktree 重建",
      });
      const missingWorktree = await worktreeManager.prepare(missingCreated);
      renameSync(missingWorktree.path, `${missingWorktree.path}-residue`);
      const remountedWorktree = await worktreeManager.prepare(missingCreated);
      expect(remountedWorktree).toEqual(missingWorktree);
      expect(existsSync(join(remountedWorktree.path, ".git"))).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("the local Codex runner returns after spawn and streams JSONL in the background", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-codex-runner-test-"));
    const workspacePath = join(directory, "workspace");
    const executablePath = join(directory, "fake-codex");

    try {
      mkdirSync(workspacePath);
      writeFileSync(
        executablePath,
        [
          "#!/bin/sh",
          `printf '%s\\n' '{"type":"thread.started","thread_id":"thread-local"}'`,
          `printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"正在修改文件"}}'`,
          "sleep 0.05",
          `printf '%s\\n' 'secret-token=should-not-leak auth failed' >&2`,
          "exit 1",
          "",
        ].join("\n"),
      );
      chmodSync(executablePath, 0o755);
      const store = new WorkOrderStore(new Database(":memory:"));
      const app = createApp({
        store,
        codexRunner: new CodexExecutionRunner(executablePath),
        worktreeManager: {
          async prepare() {
            return {
              path: workspacePath,
              branch: "teamline/work-order-local",
              baseCommit: "0123456789abcdef",
            };
          },
        },
      });
      const created = readyWorkOrder(store);

      const response = await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${created.id}/start`, {
          method: "POST",
        }),
      );
      const { workOrder: started } = await response.json();

      expect(response.status).toBe(200);
      expect(started.runStatus).toBe("running");
      await waitFor(() => store.get(created.id)?.runStatus === "failed");
      expect(store.get(created.id)).toMatchObject({
        status: "interrupted",
        runStatus: "failed",
        sessionId: "thread-local",
        currentSummary: "Codex 运行失败，请确认已经登录后重试",
      });
      expect(store.listRunEvents(created.id)).toMatchObject([
        { type: "session", message: "Codex 会话已连接" },
        { type: "progress", message: "正在修改文件" },
        { type: "exit", message: "Codex 运行失败，请确认已经登录后重试" },
      ]);
      expect(JSON.stringify(store.listRunEvents(created.id))).not.toContain(
        "secret-token",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Codex session and progress events remain available after reopening the database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-run-test-"));
    const databasePath = join(directory, "teamline.db");

    try {
      const firstDatabase = new Database(databasePath, { create: true });
      const store = new WorkOrderStore(firstDatabase);
      const app = createApp({
        store,
        codexRunner: {
          async start() {
            return {
              events: runEvents(
                { type: "session", sessionId: "thread-123" },
                { type: "progress", message: "正在更新设置页面" },
                { type: "exit", exitCode: 0, message: "Codex 已正常结束，等待结果处理" },
              ),
            };
          },
        },
        worktreeManager: fixedWorktreeManager(),
      });
      const created = readyWorkOrder(store);

      const startResponse = await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${created.id}/start`, {
          method: "POST",
        }),
      );
      expect(startResponse.status).toBe(200);

      await waitFor(() => store.get(created.id)?.runStatus === "completed");
      const eventsResponse = await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${created.id}/events`),
      );
      expect(eventsResponse.status).toBe(200);
      expect(await eventsResponse.json()).toMatchObject({
        events: [
          { type: "session", message: "Codex 会话已连接" },
          { type: "progress", message: "正在更新设置页面" },
          { type: "exit", message: "Codex 已正常结束，等待结果处理" },
        ],
      });
      firstDatabase.close();

      const reopenedDatabase = new Database(databasePath);
      const reopenedApp = createApp({ store: new WorkOrderStore(reopenedDatabase) });
      const reopenedResponse = await reopenedApp.fetch(
        new Request(`http://teamline.local/api/work-orders/${created.id}`),
      );
      const { workOrder } = await reopenedResponse.json();
      reopenedDatabase.close();

      expect(workOrder).toMatchObject({
        status: "running",
        runStatus: "completed",
        currentSummary: "Codex 已正常结束，等待结果处理",
        sessionId: "thread-123",
        runStartedAt: expect.any(String),
        runEndedAt: expect.any(String),
        runtimeMs: expect.any(Number),
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a running work order blocks duplicate and concurrent starts but a finished run does not", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    let finishFirstRun: (() => void) | undefined;
    let startCount = 0;
    const app = createApp({
      store,
      codexRunner: {
        async start() {
          startCount += 1;
          if (startCount === 1) {
            return {
              events: controlledExitEvents((finish) => {
                finishFirstRun = finish;
              }),
            };
          }
          return { events: emptyEvents() };
        },
      },
      worktreeManager: fixedWorktreeManager(),
    });
    const first = readyWorkOrder(store);
    const second = readyWorkOrder(store);

    const firstStart = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${first.id}/start`, {
        method: "POST",
      }),
    );
    expect(firstStart.status).toBe(200);

    const duplicate = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${first.id}/start`, {
        method: "POST",
      }),
    );
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({
      code: "WORK_ORDER_ALREADY_RUNNING",
      error: "这项委托已经在运行",
    });

    const concurrent = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${second.id}/start`, {
        method: "POST",
      }),
    );
    expect(concurrent.status).toBe(409);
    expect(await concurrent.json()).toEqual({
      code: "ACTIVE_WORK_ORDER_EXISTS",
      error: "已有另一项委托正在运行，请等待它结束后再启动",
    });

    finishFirstRun?.();
    await waitFor(() => store.get(first.id)?.runStatus === "completed");
    const afterExit = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${second.id}/start`, {
        method: "POST",
      }),
    );
    expect(afterExit.status).toBe(200);
  });

  test("a Codex start failure keeps the plan ready and reuses the prepared worktree", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    let startAttempts = 0;
    let prepareAttempts = 0;
    let reusedPreparedWorktree = false;
    const app = createApp({
      store,
      codexRunner: {
        async start() {
          startAttempts += 1;
          if (startAttempts === 1) {
            throw new Error("找不到 Codex，请先安装并登录 Codex");
          }
          return { events: emptyEvents() };
        },
      },
      worktreeManager: {
        async prepare(workOrder) {
          prepareAttempts += 1;
          if (prepareAttempts === 2) {
            reusedPreparedWorktree =
              workOrder.worktreePath === "/tmp/teamline/work-order-1" &&
              workOrder.executionBranch === "teamline/work-order-1" &&
              workOrder.baseCommit === "0123456789abcdef";
          }
          return fixedWorktreeManager().prepare();
        },
      },
    });
    const created = readyWorkOrder(store);

    const failed = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/start`, {
        method: "POST",
      }),
    );
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({
      code: "CODEX_START_FAILED",
      error: "找不到 Codex，请先安装并登录 Codex",
    });
    expect(store.get(created.id)).toMatchObject({
      status: "ready",
      runStatus: null,
      currentSummary: "Codex 启动失败，请处理后重试",
      lastError: "找不到 Codex，请先安装并登录 Codex",
      worktreePath: "/tmp/teamline/work-order-1",
    });

    const retried = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/start`, {
        method: "POST",
      }),
    );
    expect(retried.status).toBe(200);
    expect(prepareAttempts).toBe(2);
    expect(reusedPreparedWorktree).toBe(true);
  });

  test("an event stream failure records a fixed error without leaking diagnostics", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const app = createApp({
      store,
      codexRunner: {
        async start() {
          return {
            events: (async function* () {
              yield { type: "progress" as const, message: "正在处理委托" };
              throw new Error("secret-token=must-not-reach-storage");
            })(),
          };
        },
      },
      worktreeManager: fixedWorktreeManager(),
    });
    const created = readyWorkOrder(store);

    await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/start`, {
        method: "POST",
      }),
    );
    await waitFor(() => store.get(created.id)?.runStatus === "failed");

    expect(store.get(created.id)).toMatchObject({
      status: "interrupted",
      runStatus: "failed",
      currentSummary: "Codex 运行异常结束，请检查本机 Codex 后重试",
      lastError: "Codex 运行异常结束，请检查本机 Codex 后重试",
    });
    expect(JSON.stringify(store.get(created.id))).not.toContain("secret-token");
    expect(JSON.stringify(store.listRunEvents(created.id))).not.toContain("secret-token");
  });

  test("a service restart releases an active run that can no longer be tracked", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-restart-test-"));
    const databasePath = join(directory, "teamline.db");

    try {
      const firstDatabase = new Database(databasePath, { create: true });
      const firstStore = new WorkOrderStore(firstDatabase);
      const orphaned = readyWorkOrder(firstStore);
      firstStore.markStarted(orphaned.id);
      const next = readyWorkOrder(firstStore);
      firstDatabase.close();

      const reopenedDatabase = new Database(databasePath);
      const reopenedStore = new WorkOrderStore(reopenedDatabase);
      expect(reopenedStore.interruptActiveRunsAfterRestart()).toBe(1);
      const app = createApp({
        store: reopenedStore,
        codexRunner: { async start() { return { events: emptyEvents() }; } },
        worktreeManager: fixedWorktreeManager(),
      });
      const detail = await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${orphaned.id}`),
      );
      expect((await detail.json()).workOrder).toMatchObject({
        status: "interrupted",
        runStatus: "failed",
        currentSummary: "本地服务重启，无法继续跟踪这次运行",
      });
      const nextStart = await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${next.id}/start`, {
          method: "POST",
        }),
      );
      expect(nextStart.status).toBe(200);
      reopenedDatabase.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("Codex is not spawned when the running state cannot be saved", async () => {
    class FailingStartStore extends WorkOrderStore {
      override markStarted(): never {
        throw new Error("database is read-only");
      }
    }

    const store = new FailingStartStore(new Database(":memory:"));
    let startCount = 0;
    const app = createApp({
      store,
      codexRunner: {
        async start() {
          startCount += 1;
          return { events: emptyEvents() };
        },
      },
      worktreeManager: fixedWorktreeManager(),
    });
    const created = readyWorkOrder(store);

    const response = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/start`, {
        method: "POST",
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      code: "EXECUTION_STATE_FAILED",
      error: "无法保存运行状态，Codex 尚未启动，请重试",
    });
    expect(startCount).toBe(0);
  });

  test("a created work order can be opened by id", async () => {
    const app = createApp({
      store: new WorkOrderStore(new Database(":memory:")),
    });

    const createResponse = await app.fetch(
      new Request("http://teamline.local/api/work-orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repositoryPath,
          goal: "为设置页面增加深色模式",
          acceptance: "现有测试保持通过",
        }),
      }),
    );
    const { workOrder: created } = await createResponse.json();

    const response = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}`),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ workOrder: created });
  });

  test("a generated plan can be opened and edited", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const app = createApp({
      store,
      planGenerator: {
        async generate() {
          return {
            stages: [
              {
                outcome: "设置页面跟随系统深色模式",
                scope: "设置页面及主题样式",
                verification: "运行相关测试并在浏览器中检查主题切换",
              },
            ],
          };
        },
      },
    });
    const created = store.create({
      repositoryPath,
      goal: "为设置页面增加深色模式",
      acceptance: "现有测试保持通过",
    });

    const response = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/plan/generate`, {
        method: "POST",
      }),
    );
    const { workOrder } = await response.json();

    expect(response.status).toBe(200);
    expect(workOrder).toMatchObject({
      id: created.id,
      status: "ready",
      currentSummary: "计划等待确认",
      plan: {
        version: 1,
        stages: [
          {
            id: expect.any(String),
            outcome: "设置页面跟随系统深色模式",
            scope: "设置页面及主题样式",
            verification: "运行相关测试并在浏览器中检查主题切换",
          },
        ],
        updatedAt: expect.any(String),
      },
    });

    const reopened = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}`),
    );
    expect((await reopened.json()).workOrder).toEqual(workOrder);

    const editResponse = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/plan`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stages: [
            {
              ...workOrder.plan.stages[0],
              outcome: "设置页面支持深色模式并保留现有布局",
            },
          ],
        }),
      }),
    );
    const edited = (await editResponse.json()).workOrder;

    expect(edited.plan.version).toBe(2);
    expect(edited.plan.stages[0].outcome).toBe("设置页面支持深色模式并保留现有布局");
  });

  test("a manual plan can be saved when generation fails", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const app = createApp({
      store,
      planGenerator: {
        async generate() {
          throw new Error("Codex 暂时不可用");
        },
      },
    });
    const created = store.create({
      repositoryPath,
      goal: "为设置页面增加深色模式",
    });

    const generationResponse = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/plan/generate`, {
        method: "POST",
      }),
    );
    expect(generationResponse.status).toBe(502);
    expect(await generationResponse.json()).toEqual({
      code: "PLAN_GENERATION_FAILED",
      error: "Codex 无法生成计划，请确认已经安装并登录后重试",
    });

    const saveResponse = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/plan`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stages: [
            {
              outcome: "设置页面跟随系统深色模式",
              scope: "设置页面及主题样式",
              verification: "运行相关测试",
            },
          ],
        }),
      }),
    );
    const { workOrder } = await saveResponse.json();

    expect(saveResponse.status).toBe(200);
    expect(workOrder.status).toBe("ready");
    expect(workOrder.plan.stages[0]).toMatchObject({
      outcome: "设置页面跟随系统深色模式",
      scope: "设置页面及主题样式",
      verification: "运行相关测试",
    });
  });

  test("a work order detail page can be opened directly", async () => {
    const app = createApp({
      store: new WorkOrderStore(new Database(":memory:")),
    });

    const response = await app.fetch(
      new Request("http://teamline.local/work-orders/example-id"),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<title>Teamline</title>");
  });

  test("plan generation returns a clear timeout instead of waiting forever", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const app = createApp({
      store,
      planGenerationTimeoutMs: 5,
      planGenerator: {
        async generate() {
          return new Promise(() => {});
        },
      },
    });
    const created = store.create({
      repositoryPath,
      goal: "为设置页面增加深色模式",
    });

    const result = await Promise.race([
      app.fetch(
        new Request(`http://teamline.local/api/work-orders/${created.id}/plan/generate`, {
          method: "POST",
        }),
      ),
      Bun.sleep(40).then(() => "still waiting" as const),
    ]);

    expect(result).not.toBe("still waiting");
    if (!(result instanceof Response)) {
      throw new Error("plan generation did not return a response");
    }
    expect(result.status).toBe(504);
    expect(await result.json()).toEqual({
      code: "PLAN_GENERATION_TIMEOUT",
      error: "生成计划超时，请重试",
    });
  });

  test("a saved plan remains available after reopening the database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-plan-test-"));
    const databasePath = join(directory, "teamline.db");

    try {
      const firstDatabase = new Database(databasePath, { create: true });
      const firstStore = new WorkOrderStore(firstDatabase);
      const firstApp = createApp({
        store: firstStore,
        planGenerator: {
          async generate() {
            return {
              stages: [
                {
                  outcome: "设置页面跟随系统深色模式",
                  scope: "设置页面及主题样式",
                  verification: "运行相关测试",
                },
              ],
            };
          },
        },
      });
      const created = firstStore.create({
        repositoryPath,
        goal: "为设置页面增加深色模式",
      });
      await firstApp.fetch(
        new Request(`http://teamline.local/api/work-orders/${created.id}/plan/generate`, {
          method: "POST",
        }),
      );
      firstDatabase.close();

      const reopenedDatabase = new Database(databasePath);
      const reopenedApp = createApp({ store: new WorkOrderStore(reopenedDatabase) });
      const response = await reopenedApp.fetch(
        new Request(`http://teamline.local/api/work-orders/${created.id}`),
      );
      const { workOrder } = await response.json();
      reopenedDatabase.close();

      expect(workOrder.status).toBe("ready");
      expect(workOrder.plan.stages[0].outcome).toBe("设置页面跟随系统深色模式");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("an invalid manual plan returns a stable error", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const app = createApp({ store });
    const created = store.create({
      repositoryPath,
      goal: "为设置页面增加深色模式",
    });

    const response = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/plan`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stages: [{ outcome: 42, scope: "设置页面", verification: "运行测试" }],
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "INVALID_PLAN",
      error: "计划内容不完整，请检查每个阶段",
    });
  });
});
