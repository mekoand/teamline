import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../src/app";
import {
  CodexExecutionRunner,
  type CodexRunEvent,
  type CodexRunner,
} from "../src/codex-runner";
import { WorkOrderStore } from "../src/work-order-store";

const repositoryPath = resolve(import.meta.dir, "..");

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

async function requestWorkOrder(app: ReturnType<typeof createApp>, id: string) {
  const response = await app.fetch(
    new Request(`http://teamline.local/api/work-orders/${id}`),
  );
  return (await response.json()).workOrder;
}

function git(repository: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", repository, ...args]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
}

function initializeGitWorkspace(workspacePath: string) {
  git(workspacePath, "init", "-b", "main");
  writeFileSync(join(workspacePath, "README.md"), "# Before\n");
  git(workspacePath, "add", "README.md");
  git(
    workspacePath,
    "-c",
    "user.name=Teamline Tests",
    "-c",
    "user.email=teamline@example.test",
    "commit",
    "-m",
    "initial",
  );
}

function interruptedFixture(
  store: WorkOrderStore,
  workspacePath: string,
  sessionId: string | null,
) {
  const ready = readyWorkOrder(store);
  store.saveWorktree(ready.id, {
    path: workspacePath,
    branch: "teamline/work-order-continue",
    baseCommit: "0123456789abcdef",
  });
  store.markStarted(ready.id);
  if (sessionId) {
    store.recordSession(ready.id, sessionId);
  }
  store.recordProgress(ready.id, "第一轮完成了主题变量整理");
  store.recordInterrupted(ready.id);
  return store.get(ready.id)!;
}

describe("interrupt and continue API", () => {
  test("interrupt stays stopping until the launched Codex process exits", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-interrupt-api-"));
    const workspacePath = join(directory, "worktree");
    await Bun.write(join(workspacePath, ".keep"), "");
    const changedFile = join(workspacePath, "changed.ts");
    writeFileSync(changedFile, "export const changed = true;\n");

    try {
      const store = new WorkOrderStore(new Database(":memory:"));
      store.saveMaxConcurrency(1);
      let releaseExit!: () => void;
      const exitRequested = new Promise<void>((resolve) => {
        releaseExit = resolve;
      });
      let interruptCount = 0;
      const runner: CodexRunner = {
        async start() {
          return {
            interrupt() {
              interruptCount += 1;
            },
            events: (async function* (): AsyncGenerator<CodexRunEvent> {
              yield { type: "progress", message: "正在修改设置页面" };
              await exitRequested;
              yield {
                type: "exit",
                exitCode: 143,
                message: "Codex 已退出",
              };
            })(),
          };
        },
      };
      const app = createApp({
        store,
        codexRunner: runner,
        worktreeManager: {
          async prepare() {
            return {
              path: workspacePath,
              branch: "teamline/work-order-interrupt",
              baseCommit: "0123456789abcdef",
            };
          },
        },
      });
      const created = readyWorkOrder(store);

      const start = await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${created.id}/start`, {
          method: "POST",
        }),
      );
      expect(start.status).toBe(200);
      await waitFor(() => store.listRunEvents(created.id).length === 1);

      const interrupt = await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${created.id}/interrupt`, {
          method: "POST",
        }),
      );
      expect(interrupt.status).toBe(200);
      expect((await interrupt.json()).workOrder).toMatchObject({
        status: "running",
        runStatus: "stopping",
        currentSummary: "正在停止 Codex",
      });
      expect(interruptCount).toBe(1);
      expect(await requestWorkOrder(app, created.id)).toMatchObject({
        status: "running",
        runStatus: "stopping",
      });
      const blocked = readyWorkOrder(store);
      const blockedStart = await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${blocked.id}/start`, {
          method: "POST",
        }),
      );
      expect(blockedStart.status).toBe(409);
      expect(await blockedStart.json()).toMatchObject({
        code: "CONCURRENCY_LIMIT_REACHED",
      });

      releaseExit();
      await waitFor(() => store.get(created.id)?.runStatus === "interrupted");
      expect(await requestWorkOrder(app, created.id)).toMatchObject({
        status: "interrupted",
        runStatus: "interrupted",
        currentSummary: "Codex 已中断",
        runNumber: 1,
      });
      expect(existsSync(changedFile)).toBe(true);
      expect(store.listRunEvents(created.id)).toMatchObject([
        { type: "progress", message: "正在修改设置页面", runNumber: 1 },
        { type: "exit", message: "Codex 已中断", runNumber: 1 },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("continue resumes the saved session as run two and accumulates runtime", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-continue-api-"));
    const workspacePath = join(directory, "worktree");
    await Bun.write(join(workspacePath, ".keep"), "");

    try {
      const store = new WorkOrderStore(new Database(":memory:"));
      let finishFirstRun!: () => void;
      const firstRunExit = new Promise<void>((resolve) => {
        finishFirstRun = resolve;
      });
      const resumeRequests: unknown[] = [];
      const runner = {
        async start() {
          return {
            interrupt() {
              finishFirstRun();
            },
            events: (async function* (): AsyncGenerator<CodexRunEvent> {
              yield { type: "session", sessionId: "session-saved" };
              yield { type: "progress", message: "第一轮已经修改设置页面" };
              await firstRunExit;
              yield { type: "exit", exitCode: 143, message: "Codex 已退出" };
            })(),
          };
        },
        async resume(request: unknown) {
          resumeRequests.push(request);
          return {
            interrupt() {},
            events: (async function* (): AsyncGenerator<CodexRunEvent> {
              yield { type: "progress", message: "第二轮继续运行" };
              yield {
                type: "exit",
                exitCode: 0,
                message: "Codex 已正常结束，等待结果处理",
              };
            })(),
          };
        },
      };
      const app = createApp({
        store,
        codexRunner: runner,
        worktreeManager: {
          async prepare() {
            return {
              path: workspacePath,
              branch: "teamline/work-order-continue",
              baseCommit: "0123456789abcdef",
            };
          },
        },
      });
      const created = readyWorkOrder(store);

      await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${created.id}/start`, {
          method: "POST",
        }),
      );
      await waitFor(() => store.get(created.id)?.sessionId === "session-saved");
      await Bun.sleep(5);
      await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${created.id}/interrupt`, {
          method: "POST",
        }),
      );
      await waitFor(() => store.get(created.id)?.runStatus === "interrupted");
      const firstRuntime = store.get(created.id)!.runtimeMs;

      const continued = await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${created.id}/continue`, {
          method: "POST",
        }),
      );
      expect(continued.status).toBe(200);
      expect((await continued.json()).workOrder).toMatchObject({
        status: "running",
        runStatus: "running",
        runNumber: 2,
        sessionId: "session-saved",
      });
      await waitFor(() => store.get(created.id)?.runStatus === "completed");

      expect(resumeRequests).toEqual([
        {
          workOrder: expect.objectContaining({ id: created.id, runNumber: 2 }),
          workspacePath,
          sessionId: "session-saved",
        },
      ]);
      expect(store.get(created.id)!.runtimeMs).toBeGreaterThanOrEqual(firstRuntime);
      const eventsResponse = await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${created.id}/events`),
      );
      expect((await eventsResponse.json()).events).toMatchObject([
        { message: "Codex 会话已连接", runNumber: 1 },
        { message: "第一轮已经修改设置页面", runNumber: 1 },
        { message: "Codex 已中断", runNumber: 1 },
        { message: "第二轮继续运行", runNumber: 2 },
        { message: "Codex 已正常结束，等待结果处理", runNumber: 2 },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("an unavailable saved session falls back once with the current worktree context", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-resume-fallback-"));
    const workspacePath = join(directory, "worktree");
    const executablePath = join(directory, "fake-codex");
    const invocationLog = join(directory, "invocations.log");
    await Bun.write(join(workspacePath, ".keep"), "");
    initializeGitWorkspace(workspacePath);
    writeFileSync(join(workspacePath, "README.md"), "# After\n");
    writeFileSync(
      executablePath,
      [
        "#!/bin/sh",
        `printf '<%s>\\n' "$@" >> "${invocationLog}"`,
        'case " $* " in *" resume "*)',
        `  printf '%s\\n' '{"type":"error","error":{"message":"secret-token=must-not-persist; Session session-missing not found"}}'`,
        "  exit 1",
        "esac",
        `printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"降级执行已经启动"}}'`,
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(executablePath, 0o755);

    try {
      const store = new WorkOrderStore(new Database(":memory:"));
      const interrupted = interruptedFixture(
        store,
        workspacePath,
        "session-missing",
      );
      const app = createApp({
        store,
        codexRunner: new CodexExecutionRunner(executablePath),
      });

      const response = await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${interrupted.id}/continue`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(200);
      await waitFor(() => store.get(interrupted.id)?.runStatus === "completed");

      const invocation = readFileSync(invocationLog, "utf8");
      expect(invocation).toContain(
        "<exec>\n<--skip-git-repo-check>\n<resume>\n<session-missing>\n<请继续推进已确认的工作目标：为设置页面增加深色模式\n继续按节点执行；开始和完成节点时分别单独输出 TEAMLINE_STAGE_START:<节点 ID> 和 TEAMLINE_STAGE_COMPLETE:<节点 ID>。>\n<--json>",
      );
      expect(invocation.match(/<exec>/g)).toHaveLength(2);
      expect(invocation).toContain("工作目标：\n为设置页面增加深色模式");
      expect(invocation).toContain("已确认计划：");
      expect(invocation).toContain("第一轮完成了主题变量整理");
      expect(invocation).toContain(" M README.md");
      expect(invocation).not.toContain("secret-token");
      expect(store.get(interrupted.id)).toMatchObject({
        runNumber: 2,
        runStatus: "completed",
      });
      expect(store.listRunEvents(interrupted.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            runNumber: 2,
            message: "保存的 Codex 会话不可用，已使用当前现场启动新的执行",
          }),
          expect.objectContaining({
            runNumber: 2,
            message: "降级执行已经启动",
          }),
        ]),
      );
      expect(JSON.stringify(store.listRunEvents(interrupted.id))).not.toContain(
        "secret-token",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("authentication, permission, configuration, and unrelated resume failures do not fall back", async () => {
    const failures = [
      "Session session-saved unavailable: authentication required",
      "Session session-saved unavailable: permission denied",
      "Session session-saved unavailable: invalid config.toml",
      "Session session-saved unavailable: network timeout",
    ];

    for (const [index, failure] of failures.entries()) {
      const directory = mkdtempSync(join(tmpdir(), `teamline-resume-direct-failure-${index}-`));
      const workspacePath = join(directory, "worktree");
      const executablePath = join(directory, "fake-codex");
      const invocationLog = join(directory, "invocations.log");
      await Bun.write(join(workspacePath, ".keep"), "");
      writeFileSync(
        executablePath,
        [
          "#!/bin/sh",
          `printf '<%s>\\n' "$@" >> "${invocationLog}"`,
          'case " $* " in *" resume "*)',
          `  printf '%s\\n' '${failure}' >&2`,
          "  exit 1",
          "esac",
          `printf '%s\\n' '{"type":"turn.completed"}'`,
          "exit 0",
          "",
        ].join("\n"),
      );
      chmodSync(executablePath, 0o755);

      try {
        const store = new WorkOrderStore(new Database(":memory:"));
        const interrupted = interruptedFixture(
          store,
          workspacePath,
          "session-saved",
        );
        const app = createApp({
          store,
          codexRunner: new CodexExecutionRunner(executablePath),
        });

        const response = await app.fetch(
          new Request(
            `http://teamline.local/api/work-orders/${interrupted.id}/continue`,
            { method: "POST" },
          ),
        );
        expect(response.status).toBe(200);
        await waitFor(() => store.get(interrupted.id)?.runStatus !== "running");

        expect(store.get(interrupted.id)?.runStatus).toBe("failed");
        expect(readFileSync(invocationLog, "utf8").match(/<exec>/g)).toHaveLength(1);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  test("continue starts a fresh run directly when no Codex session was saved", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-no-session-"));
    const workspacePath = join(directory, "worktree");
    await Bun.write(join(workspacePath, ".keep"), "");

    try {
      const store = new WorkOrderStore(new Database(":memory:"));
      const interrupted = interruptedFixture(store, workspacePath, null);
      const freshStarts: unknown[] = [];
      const app = createApp({
        store,
        codexRunner: {
          async start(request) {
            freshStarts.push(request);
            return {
              interrupt() {},
              events: (async function* (): AsyncGenerator<CodexRunEvent> {
                yield { type: "progress", message: "已从保存现场开始新执行" };
                yield {
                  type: "exit",
                  exitCode: 0,
                  message: "Codex 已正常结束，等待结果处理",
                };
              })(),
            };
          },
          async resume() {
            throw new Error("resume must not be called without a session");
          },
        },
      });

      const response = await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${interrupted.id}/continue`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(200);
      await waitFor(() => store.get(interrupted.id)?.runStatus === "completed");
      expect(freshStarts).toEqual([
        expect.objectContaining({
          workspacePath,
          workOrder: expect.objectContaining({ runNumber: 2 }),
          continuation: expect.objectContaining({
            recentProgress: ["第一轮完成了主题变量整理"],
          }),
        }),
      ]);
      expect(store.listRunEvents(interrupted.id).at(-2)).toMatchObject({
        runNumber: 2,
        message: "已从保存现场开始新执行",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("continue reports a missing worktree without rebuilding or starting Codex", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const missingPath = join(tmpdir(), crypto.randomUUID(), "missing-worktree");
    const interrupted = interruptedFixture(store, missingPath, "session-saved");
    let starts = 0;
    const app = createApp({
      store,
      codexRunner: {
        async start() {
          starts += 1;
          throw new Error("must not start");
        },
        async resume() {
          starts += 1;
          throw new Error("must not resume");
        },
      },
    });

    const response = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${interrupted.id}/continue`, {
        method: "POST",
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "WORKTREE_MISSING",
      error: "执行工作区不存在，无法继续；Teamline 不会自动重建或覆盖现场",
    });
    expect(starts).toBe(0);
    expect(store.get(interrupted.id)).toMatchObject({
      status: "interrupted",
      runStatus: "interrupted",
      runNumber: 1,
      worktreePath: missingPath,
    });
  });

  test("interrupt during fallback startup stops the new process before marking interrupted", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-fallback-interrupt-"));
    const workspacePath = join(directory, "worktree");
    await Bun.write(join(workspacePath, ".keep"), "");

    try {
      const store = new WorkOrderStore(new Database(":memory:"));
      const interrupted = interruptedFixture(
        store,
        workspacePath,
        "session-missing",
      );
      let oldInterrupts = 0;
      let newInterrupts = 0;
      let fallbackStartObserved!: () => void;
      const fallbackStarting = new Promise<void>((resolve) => {
        fallbackStartObserved = resolve;
      });
      let returnFallbackHandle!: () => void;
      const fallbackHandleReady = new Promise<void>((resolve) => {
        returnFallbackHandle = resolve;
      });
      let releaseFallbackExit!: () => void;
      const fallbackExit = new Promise<void>((resolve) => {
        releaseFallbackExit = resolve;
      });
      let startCalls = 0;
      const app = createApp({
        store,
        codexRunner: {
          async resume() {
            return {
              interrupt() {
                oldInterrupts += 1;
              },
              events: (async function* (): AsyncGenerator<CodexRunEvent> {
                yield {
                  type: "exit",
                  exitCode: 1,
                  message: "保存的会话不存在",
                  resumeUnavailable: true,
                };
              })(),
            };
          },
          async start() {
            startCalls += 1;
            fallbackStartObserved();
            await fallbackHandleReady;
            return {
              interrupt() {
                newInterrupts += 1;
                releaseFallbackExit();
              },
              events: (async function* (): AsyncGenerator<CodexRunEvent> {
                await fallbackExit;
                yield { type: "exit", exitCode: 143, message: "Codex 已退出" };
              })(),
            };
          },
        },
      });

      const continued = await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${interrupted.id}/continue`, {
          method: "POST",
        }),
      );
      expect(continued.status).toBe(200);
      await fallbackStarting;

      const interrupt = await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${interrupted.id}/interrupt`, {
          method: "POST",
        }),
      );
      expect(interrupt.status).toBe(200);
      expect((await interrupt.json()).workOrder.runStatus).toBe("stopping");
      expect(oldInterrupts).toBe(1);
      expect(newInterrupts).toBe(0);

      returnFallbackHandle();
      await waitFor(() => newInterrupts === 1);
      await waitFor(() => store.get(interrupted.id)?.runStatus === "interrupted");
      expect(startCalls).toBe(1);
      expect(newInterrupts).toBe(1);
      expect(store.get(interrupted.id)).toMatchObject({
        status: "interrupted",
        runStatus: "interrupted",
        runNumber: 2,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reopening an Issue 3 database numbers the existing run as one and continue as two", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-run-number-migration-"));
    const workspacePath = join(directory, "worktree");
    const databasePath = join(directory, "teamline.db");
    await Bun.write(join(workspacePath, ".keep"), "");

    try {
      const originalDatabase = new Database(databasePath, { create: true });
      const originalStore = new WorkOrderStore(originalDatabase);
      const interrupted = interruptedFixture(
        originalStore,
        workspacePath,
        "session-saved",
      );
      originalDatabase.close();

      const legacyDatabase = new Database(databasePath);
      legacyDatabase.exec("ALTER TABLE work_orders DROP COLUMN run_number");
      legacyDatabase.exec("ALTER TABLE run_events DROP COLUMN run_number");
      legacyDatabase.close();

      const reopenedDatabase = new Database(databasePath);
      const reopenedStore = new WorkOrderStore(reopenedDatabase);
      const app = createApp({
        store: reopenedStore,
        codexRunner: {
          async start() {
            throw new Error("fresh start must not be used");
          },
          async resume() {
            return {
              interrupt() {},
              events: (async function* (): AsyncGenerator<CodexRunEvent> {
                yield {
                  type: "exit",
                  exitCode: 0,
                  message: "Codex 已正常结束，等待结果处理",
                };
              })(),
            };
          },
        },
      });

      expect(await requestWorkOrder(app, interrupted.id)).toMatchObject({
        runStatus: "interrupted",
        runNumber: 1,
      });
      const migratedEvents = await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${interrupted.id}/events`),
      );
      expect((await migratedEvents.json()).events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ runNumber: 1 }),
        ]),
      );

      const continued = await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${interrupted.id}/continue`, {
          method: "POST",
        }),
      );
      expect(continued.status).toBe(200);
      expect((await continued.json()).workOrder.runNumber).toBe(2);
      await waitFor(() => reopenedStore.get(interrupted.id)?.runStatus === "completed");
      reopenedDatabase.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("restart marks a recorded dead Codex pid interrupted", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const running = readyWorkOrder(store);
    store.markStarted(running.id);
    store.recordRunPid(running.id, 41_001);

    expect(store.interruptActiveRunsAfterRestart(() => false)).toBe(1);
    expect(store.get(running.id)).toMatchObject({
      status: "interrupted",
      runStatus: "interrupted",
      runPid: null,
    });
  });

  test("restart keeps a live Codex pid active but does not control or kill it", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const running = readyWorkOrder(store);
    store.markStarted(running.id);
    store.recordRunPid(running.id, 41_002);
    store.markStopping(running.id);
    const checkedPids: number[] = [];

    expect(
      store.interruptActiveRunsAfterRestart((pid) => {
        checkedPids.push(pid);
        return true;
      }),
    ).toBe(0);
    const app = createApp({
      store,
      codexRunner: {
        async start() {
          throw new Error("must not start");
        },
        async resume() {
          throw new Error("must not resume");
        },
      },
      worktreeManager: {
        async prepare() {
          throw new Error("must not prepare");
        },
      },
    });

    const interrupt = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${running.id}/interrupt`, {
        method: "POST",
      }),
    );
    expect(interrupt.status).toBe(409);
    expect(await interrupt.json()).toEqual({
      code: "RUN_CONTROL_LOST",
      error:
        "服务重启后无法控制这次仍在运行的 Codex，请在终端停止或待其结束后重启 Teamline",
    });
    expect(checkedPids).toEqual([41_002]);
    expect(store.get(running.id)).toMatchObject({
      status: "running",
      runStatus: "running",
      runPid: 41_002,
      currentSummary: "服务重启后仍检测到 Codex 运行，但已无法控制",
    });
  });

  test("a stopping stream error still waits for observed process exit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-stream-exit-"));
    const workspacePath = join(directory, "worktree");
    await Bun.write(join(workspacePath, ".keep"), "");

    try {
      const store = new WorkOrderStore(new Database(":memory:"));
      let failStream!: () => void;
      const streamFailure = new Promise<void>((resolve) => {
        failStream = resolve;
      });
      let releaseProcessExit!: () => void;
      const processExit = new Promise<number>((resolve) => {
        releaseProcessExit = () => resolve(143);
      });
      const app = createApp({
        store,
        codexRunner: {
          async start() {
            return {
              exited: processExit,
              interrupt() {
                failStream();
              },
              events: (async function* (): AsyncGenerator<CodexRunEvent> {
                yield { type: "progress", message: "运行中" };
                await streamFailure;
                throw new Error("stdout closed before process exit");
              })(),
            };
          },
          async resume() {
            throw new Error("must not resume");
          },
        },
        worktreeManager: {
          async prepare() {
            return {
              path: workspacePath,
              branch: "teamline/work-order-stream-exit",
              baseCommit: "0123456789abcdef",
            };
          },
        },
      });
      const created = readyWorkOrder(store);
      await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${created.id}/start`, {
          method: "POST",
        }),
      );
      await waitFor(() => store.listRunEvents(created.id).length === 1);
      await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${created.id}/interrupt`, {
          method: "POST",
        }),
      );
      await Bun.sleep(10);
      expect(store.get(created.id)?.runStatus).toBe("stopping");

      releaseProcessExit();
      await waitFor(() => store.get(created.id)?.runStatus === "interrupted");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
