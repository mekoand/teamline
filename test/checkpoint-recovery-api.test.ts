import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { GitCheckpointManager } from "../src/checkpoint-manager";
import type { CodexRunEvent, CodexRunner } from "../src/codex-runner";
import { WorkOrderStore } from "../src/work-order-store";

function git(repository: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", repository, ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function initializeRepository(repository: string): string {
  git(repository, "init", "-b", "main");
  writeFileSync(join(repository, "README.md"), "baseline\n");
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
  return git(repository, "rev-parse", "HEAD");
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(2);
  }
}

describe("stage checkpoints and recovery", () => {
  test("captures and restores a real Git workspace without moving the checkpoint", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-checkpoint-manager-"));
    try {
      initializeRepository(directory);
      const manager = new GitCheckpointManager();
      const baseline = await manager.capture(
        directory,
        "refs/teamline/checkpoints/order/baseline",
      );
      writeFileSync(join(directory, "README.md"), "stage complete\n");
      writeFileSync(join(directory, "result.txt"), "kept\n");
      const stage = await manager.capture(
        directory,
        "refs/teamline/checkpoints/order/stage",
      );

      writeFileSync(join(directory, "README.md"), "interrupted现场\n");
      writeFileSync(join(directory, "stray.txt"), "remove on restore\n");
      const restored = await manager.restore(
        directory,
        stage,
        "refs/teamline/residue/order/run-2",
      );

      expect(baseline).not.toBe(stage);
      expect(restored.residueTreeHash).not.toBe(stage);
      expect(readFileSync(join(directory, "README.md"), "utf8")).toBe("stage complete\n");
      expect(readFileSync(join(directory, "result.txt"), "utf8")).toBe("kept\n");
      expect(existsSync(join(directory, "stray.txt"))).toBe(false);
      expect(git(directory, "rev-parse", "refs/teamline/checkpoints/order/stage")).toBe(stage);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("saves a final stage checkpoint when the verified boundary is complete", async () => {
    const repository = mkdtempSync(join(tmpdir(), "teamline-final-checkpoint-"));
    const baseCommit = initializeRepository(repository);
    const store = new WorkOrderStore(new Database(":memory:"));
    const manager = new GitCheckpointManager();
    try {
      const app = createApp({
        store,
        checkpointManager: manager,
        codexRunner: {
          async start() {
            writeFileSync(join(repository, "README.md"), "verified result\n");
            return {
              interrupt() {},
              events: (async function* (): AsyncGenerator<CodexRunEvent> {
                yield { type: "exit", exitCode: 0, message: "Codex 已结束" };
              })(),
            };
          },
          async resume() {
            throw new Error("not used");
          },
        },
        worktreeManager: {
          async prepare() {
            return { path: repository, branch: "teamline/final", baseCommit };
          },
        },
        resultProcessor: {
          async process(workOrder) {
            const stage = workOrder.plan!.stages[0]!;
            return {
              planVersion: workOrder.plan!.version,
              git: { diffStat: "1 file changed", statusShort: "M README.md" },
              verifications: [
                {
                  stageId: stage.id,
                  stageOutcome: stage.outcome,
                  command: "check",
                  status: "passed" as const,
                  exitCode: 0,
                  output: "passed",
                },
              ],
              completedAt: new Date().toISOString(),
            };
          },
        },
      });
      const created = store.create({ repositoryPath: repository, goal: "完成单阶段工作" });
      store.savePlan(created.id, [
        { outcome: "完成并验证结果", scope: "README", verification: "check" },
      ]);

      const response = await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${created.id}/start`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(200);
      await waitFor(() => store.get(created.id)?.status === "review");
      expect(store.get(created.id)).toMatchObject({
        checkpoints: [
          { kind: "baseline", runNumber: 1 },
          { kind: "stage", stageOutcome: "完成并验证结果", runNumber: 1 },
        ],
        plan: {
          stages: [{ status: "completed", statusReason: "验证通过，检查点已保存" }],
        },
      });
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  test("does not turn a failed multi-stage run into a false stage checkpoint", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-checkpoint-api-"));
    const repository = join(directory, "repository");
    const databasePath = join(directory, "teamline.db");
    await Bun.write(join(repository, ".keep"), "");
    const baseCommit = initializeRepository(repository);
    const manager = new GitCheckpointManager();

    try {
      const firstDatabase = new Database(databasePath, { create: true });
      const firstStore = new WorkOrderStore(firstDatabase);
      let createdId = "";
      let starts = 0;
      const firstRunner: CodexRunner = {
        async start() {
          starts += 1;
          expect(firstStore.get(createdId)?.checkpoints[0]).toMatchObject({
            kind: "baseline",
            runNumber: 1,
          });
          writeFileSync(
            join(repository, "README.md"),
            starts === 1 ? "first stage complete\n" : "first stage complete\nsecond stage residue\n",
          );
          return {
            interrupt() {},
            events: (async function* (): AsyncGenerator<CodexRunEvent> {
              yield { type: "exit", exitCode: 0, message: "Codex 已结束" };
            })(),
          };
        },
        async resume() {
          throw new Error("not used");
        },
      };
      const firstApp = createApp({
        store: firstStore,
        checkpointManager: manager,
        codexRunner: firstRunner,
        worktreeManager: {
          async prepare() {
            return {
              path: repository,
              branch: "teamline/work-order-checkpoint",
              baseCommit,
            };
          },
        },
        resultProcessor: {
          async process(workOrder) {
            const stage = workOrder.plan!.stages[0]!;
            const passed = stage.outcome === "完成第一阶段";
            return {
              planVersion: workOrder.plan!.version,
              git: { diffStat: "1 file changed", statusShort: " M README.md" },
              verifications: [{
                stageId: stage.id,
                stageOutcome: stage.outcome,
                command: passed ? "check first" : "check second",
                status: passed ? "passed" as const : "failed" as const,
                exitCode: passed ? 0 : 1,
                output: passed ? "passed" : "failed",
              }],
              completedAt: new Date().toISOString(),
            };
          },
        },
      });
      const created = firstStore.create({ repositoryPath: repository, goal: "完成两阶段修改" });
      createdId = created.id;
      firstStore.savePlan(created.id, [
        { outcome: "完成第一阶段", scope: "README", verification: "check first" },
        { outcome: "完成第二阶段", scope: "README", verification: "check second" },
      ]);

      const started = await firstApp.fetch(
        new Request(`http://teamline.local/api/work-orders/${created.id}/start`, {
          method: "POST",
        }),
      );
      expect(started.status).toBe(200);
      await waitFor(() => firstStore.get(created.id)?.status === "interrupted");
      const interrupted = firstStore.get(created.id)!;
      expect(interrupted.checkpoints).toMatchObject([
        { kind: "baseline", runNumber: 1 },
        { kind: "stage", stageOutcome: "完成第一阶段", runNumber: 1 },
      ]);
      expect(interrupted.plan!.stages).toMatchObject([
        { status: "completed", statusReason: "验证通过，检查点已保存" },
        { status: "response", statusReason: "自动验证未通过" },
      ]);
      const checkpointHash = interrupted.checkpoints.at(-1)!.treeHash;
      writeFileSync(join(repository, "README.md"), "interrupted changes\n");
      firstDatabase.close();

      const reopenedDatabase = new Database(databasePath);
      const reopenedStore = new WorkOrderStore(reopenedDatabase);
      let releaseRun!: () => void;
      const running = new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      const secondApp = createApp({
        store: reopenedStore,
        checkpointManager: manager,
        codexRunner: {
          async start(input) {
            expect(readFileSync(join(repository, "README.md"), "utf8")).toBe("first stage complete\n");
            expect(input.continuation?.reexecuteStage).toMatchObject({
              outcome: "完成第二阶段",
            });
            return {
              interrupt() {
                releaseRun();
              },
              events: (async function* (): AsyncGenerator<CodexRunEvent> {
                await running;
                yield { type: "exit", exitCode: 143, message: "test stopped" };
              })(),
            };
          },
          async resume() {
            throw new Error("not used");
          },
        },
      });

      expect(reopenedStore.get(created.id)?.checkpoints.at(-1)?.treeHash).toBe(checkpointHash);
      const detail = await secondApp.fetch(
        new Request(`http://teamline.local/api/work-orders/${created.id}`),
      );
      expect((await detail.json()).workOrder.recoverySite.statusShort).toContain(
        "README.md",
      );
      const response = await secondApp.fetch(
        new Request(`http://teamline.local/api/work-orders/${created.id}/reexecute`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(200);
      expect((await response.json()).workOrder).toMatchObject({
        status: "running",
        runStatus: "running",
        runNumber: 3,
        sessionId: null,
      });
      expect(reopenedStore.get(created.id)?.checkpoints.at(-1)?.treeHash).toBe(checkpointHash);
      expect(reopenedStore.listRunEvents(created.id).at(-1)).toMatchObject({
        runNumber: 3,
        message: "已恢复到“完成第一阶段”检查点，开始重新执行“完成第二阶段”",
      });
      releaseRun();
      await waitFor(() => reopenedStore.get(created.id)?.runStatus === "failed");
      reopenedDatabase.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
