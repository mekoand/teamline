import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
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
      const staleArtifactPath = join(directory, "stale.md");
      writeFileSync(staleArtifactPath, "old\n");
      git(directory, "add", "stale.md");
      git(
        directory,
        "-c",
        "user.name=Teamline Tests",
        "-c",
        "user.email=teamline@example.test",
        "commit",
        "-m",
        "add stale fixture",
      );
      writeFileSync(join(directory, "README.md"), "# After\n");
      writeFileSync(join(directory, "untracked.txt"), "new\n");
      const store = new WorkOrderStore(new Database(":memory:"));
      const workOrder = resultWorkOrder(store, directory, [
        "pwd; printf first > command-order.txt; printf alpha",
        'test "$(cat command-order.txt)" = first; printf beta',
        undefined,
      ]);
      const previousResult = resultFixture(workOrder);
      previousResult.artifacts = [{
        id: "previous:stale.md",
        type: "file",
        label: "stale.md",
        location: staleArtifactPath,
      }];

      const result = await new LocalWorkOrderResultProcessor().process({
        ...workOrder,
        result: previousResult,
      });

      expect(result.git.diffStat).toContain("README.md");
      expect(result.git.statusShort).toContain("M README.md");
      expect(result.git.statusShort).toContain("?? untracked.txt");
      expect(result.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "file", location: realpathSync(join(directory, "README.md")) }),
        expect.objectContaining({ type: "file", location: realpathSync(join(directory, "untracked.txt")) }),
      ]));
      expect(result.artifacts?.some((artifact) => artifact.location === staleArtifactPath)).toBe(false);
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

  test("collects files changed during an ordinary-folder run without Git", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-directory-artifacts-"));
    try {
      const oldFile = join(directory, "old.txt");
      writeFileSync(oldFile, "before\n");
      const oldTime = new Date(Date.now() - 60_000);
      utimesSync(oldFile, oldTime, oldTime);

      const store = new WorkOrderStore(new Database(":memory:"));
      const created = store.create({
        workspace: { kind: "directory", path: directory },
        goal: "生成普通文件夹成果",
      });
      store.savePlan(created.id, [{
        outcome: "生成成果",
        scope: "RESULT.md 与 docs/summary.md",
        verification: "检查文件",
        verificationCommand: "true",
      }]);
      store.saveDirectWorkspace(created.id, directory);
      store.markStarted(created.id);

      mkdirSync(join(directory, "docs"));
      writeFileSync(join(directory, "RESULT.md"), "done\n");
      writeFileSync(join(directory, "docs", "summary.md"), "summary\n");
      writeFileSync(oldFile, "after\n");
      mkdirSync(join(directory, ".git"));
      writeFileSync(join(directory, ".git", "internal"), "ignored\n");

      const result = await new LocalWorkOrderResultProcessor().process(store.get(created.id)!);

      expect(result.artifacts?.map((artifact) => artifact.label).sort()).toEqual([
        "RESULT.md",
        "docs/summary.md",
        "old.txt",
      ]);
      expect(result.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "file",
          label: "RESULT.md",
          location: join(directory, "RESULT.md"),
        }),
      ]));
      expect(result.git).toEqual({
        diffStat: "普通文件夹不提供 Git 变化统计",
        statusShort: "结果保留在所选本地文件夹中",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("limits a very large result list to the 100 files disclosed by the UI", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-many-artifacts-"));
    try {
      const store = new WorkOrderStore(new Database(":memory:"));
      const created = store.create({
        workspace: { kind: "directory", path: directory },
        goal: "生成大量普通文件夹成果",
      });
      store.savePlan(created.id, [{
        outcome: "生成成果",
        scope: "outputs",
        verification: "检查文件",
        verificationCommand: "true",
      }]);
      store.saveDirectWorkspace(created.id, directory);
      store.markStarted(created.id);
      mkdirSync(join(directory, "outputs"));
      for (let index = 0; index < 101; index += 1) {
        writeFileSync(join(directory, "outputs", `${String(index).padStart(3, "0")}.md`), "done\n");
      }

      const result = await new LocalWorkOrderResultProcessor().process(store.get(created.id)!);

      expect(result.artifacts).toHaveLength(100);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("opens only collected ordinary-folder artifacts and can reveal their location", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-open-artifact-"));
    const outsideDirectory = mkdtempSync(join(tmpdir(), "teamline-outside-artifact-"));
    try {
      const artifactPath = join(directory, "RESULT.md");
      const outsidePath = join(outsideDirectory, "outside.md");
      const linkedPath = join(directory, "linked.md");
      writeFileSync(artifactPath, "done\n");
      writeFileSync(outsidePath, "outside\n");
      symlinkSync(outsidePath, linkedPath);
      const store = new WorkOrderStore(new Database(":memory:"));
      const created = store.create({
        workspace: { kind: "directory", path: directory },
        goal: "打开成果",
      });
      store.savePlan(created.id, [{
        outcome: "生成成果",
        scope: "RESULT.md",
        verification: "检查文件",
        verificationCommand: "true",
      }]);
      store.saveDirectWorkspace(created.id, directory);
      store.markStarted(created.id);
      const verifying = store.beginResultProcessing(created.id, "Codex 已正常结束");
      const stage = verifying.plan!.stages[0]!;
      store.completeReview(created.id, {
        planVersion: verifying.plan!.version,
        artifacts: [{
          id: "directory-result:RESULT.md",
          type: "file",
          label: "RESULT.md",
          location: artifactPath,
        }, {
          id: "directory-result:linked.md",
          type: "file",
          label: "linked.md",
          location: linkedPath,
        }],
        git: {
          diffStat: "普通文件夹不提供 Git 变化统计",
          statusShort: "结果保留在所选本地文件夹中",
        },
        verifications: [{
          stageId: stage.id,
          stageOutcome: stage.outcome,
          command: "true",
          status: "passed",
          exitCode: 0,
          output: "（无输出）",
        }],
        completedAt: new Date().toISOString(),
      });

      const opened: Array<{ path: string; reveal: boolean }> = [];
      const app = createApp({
        store,
        openLocalArtifact: async (path, reveal) => {
          opened.push({ path, reveal });
        },
      });
      for (const reveal of [false, true]) {
        const response = await app.fetch(new Request(
          `http://teamline.local/api/work-orders/${created.id}/artifacts/open`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: artifactPath, reveal }),
          },
        ));
        expect(response.status).toBe(200);
      }
      expect(opened).toEqual([
        { path: realpathSync(artifactPath), reveal: false },
        { path: realpathSync(artifactPath), reveal: true },
      ]);

      const rejected = await app.fetch(new Request(
        `http://teamline.local/api/work-orders/${created.id}/artifacts/open`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: join(directory, "not-a-result.md"), reveal: false }),
        },
      ));
      expect(rejected.status).toBe(400);
      const escapedSymlink = await app.fetch(new Request(
        `http://teamline.local/api/work-orders/${created.id}/artifacts/open`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: linkedPath, reveal: false }),
        },
      ));
      expect(escapedSymlink.status).toBe(400);
      expect(opened).toHaveLength(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(outsideDirectory, { recursive: true, force: true });
    }
  });

  test("opens only collected Git worktree artifacts and rejects paths outside the worktree", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "teamline-open-git-artifact-"));
    const outsideDirectory = mkdtempSync(join(tmpdir(), "teamline-outside-git-artifact-"));
    try {
      initializeRepository(worktree);
      const artifactPath = join(worktree, "RESULT.md");
      const uncollectedPath = join(worktree, "not-a-result.md");
      const outsidePath = join(outsideDirectory, "outside.md");
      const linkedPath = join(worktree, "linked.md");
      writeFileSync(artifactPath, "done\n");
      writeFileSync(uncollectedPath, "not collected\n");
      writeFileSync(outsidePath, "outside\n");
      symlinkSync(outsidePath, linkedPath);

      const store = new WorkOrderStore(new Database(":memory:"));
      const workOrder = resultWorkOrder(store, worktree, ["true"]);
      store.markStarted(workOrder.id);
      const verifying = store.beginResultProcessing(workOrder.id, "Codex 已正常结束");
      const stage = verifying.plan!.stages[0]!;
      store.completeReview(workOrder.id, {
        planVersion: verifying.plan!.version,
        artifacts: [{
          id: "git-result:RESULT.md",
          type: "file",
          label: "RESULT.md",
          location: artifactPath,
        }, {
          id: "git-result:linked.md",
          type: "file",
          label: "linked.md",
          location: linkedPath,
        }],
        git: { diffStat: "2 files changed", statusShort: "?? RESULT.md\n?? linked.md" },
        verifications: [{
          stageId: stage.id,
          stageOutcome: stage.outcome,
          command: "true",
          status: "passed",
          exitCode: 0,
          output: "（无输出）",
        }],
        completedAt: new Date().toISOString(),
      });

      const opened: Array<{ path: string; reveal: boolean }> = [];
      const app = createApp({
        store,
        openLocalArtifact: async (path, reveal) => {
          opened.push({ path, reveal });
        },
      });
      for (const reveal of [false, true]) {
        const response = await app.fetch(new Request(
          `http://teamline.local/api/work-orders/${workOrder.id}/artifacts/open`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: artifactPath, reveal }),
          },
        ));
        expect(response.status).toBe(200);
      }
      expect(opened).toEqual([
        { path: realpathSync(artifactPath), reveal: false },
        { path: realpathSync(artifactPath), reveal: true },
      ]);

      for (const path of [uncollectedPath, linkedPath, outsidePath]) {
        const response = await app.fetch(new Request(
          `http://teamline.local/api/work-orders/${workOrder.id}/artifacts/open`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path, reveal: false }),
          },
        ));
        expect(response.status).toBe(400);
      }
      expect(opened).toHaveLength(2);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
      rmSync(outsideDirectory, { recursive: true, force: true });
    }
  });

  test("keeps existing ordinary-folder artifacts and removes files deleted by a later node", () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-merge-artifacts-"));
    try {
      const store = new WorkOrderStore(new Database(":memory:"));
      const created = store.create({
        workspace: { kind: "directory", path: directory },
        goal: "分两步生成成果",
      });
      store.savePlan(created.id, [
        { outcome: "生成 A", scope: "A.md", verification: "检查 A", verificationCommand: "true" },
        { outcome: "生成 B", scope: "B.md", verification: "检查 B", verificationCommand: "true" },
      ]);
      store.saveDirectWorkspace(created.id, directory);

      const completeCurrentStage = (labels: string[]) => {
        const running = store.get(created.id)!;
        const stage = running.plan!.stages.find((candidate) => candidate.status === "running")!;
        const verifying = store.beginResultProcessing(created.id, "Codex 已正常结束");
        return store.completeReview(created.id, {
          planVersion: verifying.plan!.version,
          artifacts: labels.map((label) => ({
            id: `directory-result:${label}`,
            type: "file" as const,
            label,
            location: join(directory, label),
          })),
          git: {
            diffStat: "普通文件夹不提供 Git 变化统计",
            statusShort: "结果保留在所选本地文件夹中",
          },
          verifications: [{
            stageId: stage.id,
            stageOutcome: stage.outcome,
            command: "true",
            status: "passed",
            exitCode: 0,
            output: "（无输出）",
          }],
          completedAt: new Date().toISOString(),
        });
      };

      writeFileSync(join(directory, "A.md"), "A\n");
      writeFileSync(join(directory, "gone.txt"), "temporary\n");
      store.markStarted(created.id);
      expect(completeCurrentStage(["A.md", "gone.txt"]).status).toBe("ready");

      rmSync(join(directory, "gone.txt"));
      writeFileSync(join(directory, "B.md"), "B\n");
      store.markNextStageStarted(created.id);
      const completed = completeCurrentStage(["B.md"]);

      expect(completed.status).toBe("review");
      expect(completed.result?.artifacts?.map((artifact) => artifact.label)).toEqual([
        "A.md",
        "B.md",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps ordinary-folder artifacts from earlier plan versions after adjustment", () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-revision-artifacts-"));
    try {
      const store = new WorkOrderStore(new Database(":memory:"));
      const created = store.create({
        workspace: { kind: "directory", path: directory },
        goal: "生成并调整成果",
      });
      store.savePlan(created.id, [{
        outcome: "生成初始成果",
        scope: "brief.md",
        verification: "检查 brief.md",
        verificationCommand: "true",
      }]);
      store.saveDirectWorkspace(created.id, directory);

      const completeCurrentStage = (label: string) => {
        const running = store.get(created.id)!;
        const stage = running.plan!.stages.find((candidate) => candidate.status === "running")!;
        const verifying = store.beginResultProcessing(created.id, "Codex 已正常结束");
        return store.completeReview(created.id, {
          planVersion: verifying.plan!.version,
          artifacts: [{
            id: `directory-result:${label}`,
            type: "file" as const,
            label,
            location: join(directory, label),
          }],
          git: {
            diffStat: "普通文件夹不提供 Git 变化统计",
            statusShort: "结果保留在所选本地文件夹中",
          },
          verifications: [{
            stageId: stage.id,
            stageOutcome: stage.outcome,
            command: "true",
            status: "passed",
            exitCode: 0,
            output: "（无输出）",
          }],
          completedAt: new Date().toISOString(),
        });
      };

      writeFileSync(join(directory, "brief.md"), "brief\n");
      store.markStarted(created.id);
      expect(completeCurrentStage("brief.md").status).toBe("review");

      store.revise(created.id, "补充最终摘要");
      store.savePlan(created.id, [{
        outcome: "生成最终摘要",
        scope: "RESULT.md",
        verification: "检查 RESULT.md",
        verificationCommand: "true",
      }]);
      writeFileSync(join(directory, "RESULT.md"), "done\n");
      store.markStarted(created.id);
      const completed = completeCurrentStage("RESULT.md");

      expect(completed.status).toBe("review");
      expect(completed.result?.artifacts?.map((artifact) => artifact.label)).toEqual([
        "brief.md",
        "RESULT.md",
      ]);
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
    await waitFor(() => store.get(planned.id)?.status === "interrupted");
    expect(store.get(planned.id)).toMatchObject({
      status: "interrupted",
      runStatus: "completed",
      currentSummary: "请确认当前 AI 节点结果后继续",
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
    const workOrder = resultWorkOrder(store, "/tmp/delegated", ["bun test"]);
    store.markStarted(workOrder.id);
    const verifying = store.beginResultProcessing(workOrder.id, "Codex 已正常结束");
    store.completeReview(workOrder.id, resultFixture(verifying));
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
      currentSummary: "已由你确认完成",
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

  test("continue adjustment generates a confirmed new plan and keeps the previous result", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const workOrder = resultWorkOrder(store, "/tmp/delegated", ["bun test"]);
    store.markStarted(workOrder.id);
    const verifying = store.beginResultProcessing(workOrder.id, "Codex 已正常结束");
    const oldResult = resultFixture(verifying);
    store.completeReview(workOrder.id, oldResult);
    let planningStatus = "";
    let planningMessage = "";
    const app = createApp({
      store,
      planGenerator: {
        async generate(planningWorkOrder) {
          planningStatus = planningWorkOrder.status;
          planningMessage = planningWorkOrder.conversation.at(-1)?.content ?? "";
          return {
            outcome: "plan",
            message: "后续计划已生成，请确认后启动。",
            questions: [],
            stages: [
              {
                id: "mobile-empty-state",
                outcome: "移动端空状态清晰可用",
                scope: "移动端成果页",
                verification: "检查 390px 布局",
              },
            ],
          };
        },
      },
    });

    const response = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${workOrder.id}/revise`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revisionNote: "补充移动端空状态" }),
      }),
    );
    const payload = await response.json();
    const revised = payload.workOrder as WorkOrder;

    expect(response.status).toBe(200);
    expect(payload.outcome).toBe("plan");
    expect(planningStatus).toBe("review");
    expect(planningMessage).toBe("补充移动端空状态");
    expect(revised).toMatchObject({
      status: "ready",
      runStatus: null,
      revisionNote: "补充移动端空状态",
      result: oldResult,
      plan: { version: 2, confirmationRequired: true },
    });
    expect(revised.plan?.stages).toMatchObject([
      { id: "mobile-empty-state", outcome: "移动端空状态清晰可用" },
    ]);

    const startResponse = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${workOrder.id}/start`, {
        method: "POST",
      }),
    );
    expect(startResponse.status).toBe(409);
    expect(await startResponse.json()).toMatchObject({ code: "PLAN_CONFIRMATION_REQUIRED" });
  });

  test("continue adjustment planning failures leave review state unchanged", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const workOrder = resultWorkOrder(store, "/tmp/delegated", ["bun test"]);
    store.markStarted(workOrder.id);
    const verifying = store.beginResultProcessing(workOrder.id, "Codex 已正常结束");
    store.completeReview(workOrder.id, resultFixture(verifying));
    const before = structuredClone(store.get(workOrder.id));
    const app = createApp({
      store,
      planGenerator: {
        async generate() {
          throw new Error("planner unavailable");
        },
      },
    });

    const response = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${workOrder.id}/revise`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revisionNote: "继续完善窄屏" }),
      }),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "PLAN_GENERATION_FAILED" });
    expect(store.get(workOrder.id)).toEqual(before);
  });

  test("continue adjustment clarification still creates a new plan version after reply", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const workOrder = resultWorkOrder(store, "/tmp/delegated", ["bun test"]);
    store.markStarted(workOrder.id);
    const verifying = store.beginResultProcessing(workOrder.id, "Codex 已正常结束");
    const oldResult = resultFixture(verifying);
    store.completeReview(workOrder.id, oldResult);
    let calls = 0;
    const app = createApp({
      store,
      planGenerator: {
        async generate(planningWorkOrder) {
          calls += 1;
          if (calls === 1) {
            return {
              outcome: "clarification",
              message: "",
              questions: [{
                target: "plan" as const,
                prompt: "需要保留桌面布局吗？",
                reason: "这会影响后续计划范围",
              }],
              stages: [],
            };
          }
          return {
            outcome: "plan",
            message: "已按回复生成后续计划。",
            questions: [],
            stages: planningWorkOrder.plan!.stages.map((stage) => ({
              id: stage.id,
              outcome: stage.outcome,
              scope: stage.scope,
              verification: stage.verification,
              verificationCommand: stage.verificationCommand,
            })),
          };
        },
      },
    });

    const clarificationResponse = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${workOrder.id}/revise`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revisionNote: "继续完善响应式布局" }),
      }),
    );
    const clarification = await clarificationResponse.json();
    expect(clarificationResponse.status).toBe(200);
    expect(clarification).toMatchObject({
      outcome: "clarification",
      workOrder: {
        status: "draft",
        revisionNote: "继续完善响应式布局",
        result: oldResult,
        plan: { version: 1, confirmationRequired: true },
        pendingClarification: { requiresPlanConfirmation: true },
      },
    });

    const replyResponse = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${workOrder.id}/conversation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "reply", message: "需要保留" }),
      }),
    );
    const reply = await replyResponse.json();
    expect(replyResponse.status).toBe(200);
    expect(reply).toMatchObject({
      outcome: "plan",
      workOrder: {
        status: "ready",
        revisionNote: "继续完善响应式布局",
        result: oldResult,
        plan: { version: 2, confirmationRequired: true },
        pendingClarification: null,
      },
    });
  });

  test("continue adjustment rejects non-review goals before calling the planner", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const workOrder = resultWorkOrder(store, "/tmp/delegated", ["bun test"]);
    let calls = 0;
    const app = createApp({
      store,
      planGenerator: {
        async generate() {
          calls += 1;
          throw new Error("must not run");
        },
      },
    });

    const response = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${workOrder.id}/revise`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revisionNote: "不应调用规划器" }),
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "WORK_ORDER_NOT_IN_REVIEW" });
    expect(calls).toBe(0);
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
      const planned = resultWorkOrder(store, directory, ["bun test"]);
      store.markStarted(planned.id);
      const verifying = store.beginResultProcessing(planned.id, "Codex 已正常结束");
      store.completeReview(planned.id, resultFixture(verifying));
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
      const workOrder = resultWorkOrder(firstStore, "/tmp/delegated", ["bun test"]);
      firstStore.markStarted(workOrder.id);
      const firstVerifying = firstStore.beginResultProcessing(
        workOrder.id,
        "Codex 已正常结束",
      );
      const oldResult = resultFixture(firstVerifying);
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
    const workOrder = resultWorkOrder(store, "/tmp/delegated", ["bun test"]);
    store.markStarted(workOrder.id);
    const firstVerifying = store.beginResultProcessing(workOrder.id, "Codex 已正常结束");
    const oldResult = resultFixture(firstVerifying);
    store.completeReview(workOrder.id, oldResult);
    const revised = store.revise(workOrder.id, "继续完善");
    store.savePlan(revised.id, revised.plan!.stages);
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
      const workOrder = resultWorkOrder(firstStore, "/tmp/delegated", ["bun test"]);
      firstStore.markStarted(workOrder.id);
      const verifying = firstStore.beginResultProcessing(workOrder.id, "Codex 已正常结束");
      const result = resultFixture(verifying);
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
