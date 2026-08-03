import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../src/app";
import { WorkOrderStore } from "../src/work-order-store";

const repositoryPath = resolve(import.meta.dir, "..");

describe("execution map", () => {
  test("a structured execution map survives reopening the local database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-map-test-"));
    const databasePath = join(directory, "teamline.db");

    try {
      const firstDatabase = new Database(databasePath, { create: true });
      const firstStore = new WorkOrderStore(firstDatabase);
      const firstApp = createApp({ store: firstStore });
      const created = firstStore.create({
        repositoryPath,
        goal: "把执行地图接入正式计划",
      });
      const inspectId = crypto.randomUUID();
      const implementId = crypto.randomUUID();

      const saveResponse = await firstApp.fetch(
        new Request(`http://teamline.local/api/work-orders/${created.id}/plan`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            stages: [
              {
                id: inspectId,
                outcome: "确认现有计划边界",
                scope: "CONTEXT.md 与相关 ADR",
                verification: "人工检查范围",
                dependsOn: [],
                executionMethod: "codex",
                workspace: { kind: "git", path: repositoryPath },
                materials: [
                  {
                    id: "context",
                    type: "file",
                    label: "CONTEXT.md",
                    location: "CONTEXT.md",
                  },
                ],
                artifacts: [],
              },
              {
                id: implementId,
                outcome: "交付正式执行地图",
                scope: "本地 HTTP 应用",
                verification: "bun test",
                verificationCommand: "bun test",
                dependsOn: [inspectId],
                executionMethod: "codex",
                workspace: { kind: "git", path: repositoryPath },
                materials: [],
                artifacts: [],
              },
            ],
          }),
        }),
      );
      expect(saveResponse.status).toBe(200);
      firstDatabase.close();

      const reopenedDatabase = new Database(databasePath);
      const reopenedApp = createApp({ store: new WorkOrderStore(reopenedDatabase) });
      const response = await reopenedApp.fetch(
        new Request(`http://teamline.local/api/work-orders/${created.id}`),
      );
      const { workOrder } = await response.json();
      reopenedDatabase.close();

      expect(response.status).toBe(200);
      expect(workOrder.plan.stages).toEqual([
        {
          id: inspectId,
          outcome: "确认现有计划边界",
          scope: "CONTEXT.md 与相关 ADR",
          verification: "人工检查范围",
          dependsOn: [],
          executionMethod: "codex",
          workspace: { kind: "git", path: repositoryPath },
          materials: [
            {
              id: "context",
              type: "file",
              label: "CONTEXT.md",
              location: "CONTEXT.md",
            },
          ],
          artifacts: [],
          status: "planning",
          statusReason: "等待确认并启动",
        },
        {
          id: implementId,
          outcome: "交付正式执行地图",
          scope: "本地 HTTP 应用",
          verification: "bun test",
          verificationCommand: "bun test",
          dependsOn: [inspectId],
          executionMethod: "codex",
          workspace: { kind: "git", path: repositoryPath },
          materials: [],
          artifacts: [],
          status: "planning",
          statusReason: "等待确认并启动",
        },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects execution maps with circular node dependencies", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const app = createApp({ store });
    const created = store.create({ repositoryPath, goal: "检查依赖" });

    const response = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/plan`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stages: [
            {
              id: "first",
              outcome: "第一项",
              scope: "src",
              verification: "检查",
              dependsOn: ["second"],
            },
            {
              id: "second",
              outcome: "第二项",
              scope: "test",
              verification: "检查",
              dependsOn: ["first"],
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "INVALID_PLAN",
      error: "计划内容不完整，请检查每个阶段",
    });
    expect(store.get(created.id)?.plan).toBeNull();
  });

  test("map or list preference remains after refreshing and reopening SQLite", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-map-preference-"));
    const databasePath = join(directory, "teamline.db");

    try {
      const firstDatabase = new Database(databasePath, { create: true });
      const firstApp = createApp({ store: new WorkOrderStore(firstDatabase) });
      const saveResponse = await firstApp.fetch(
        new Request("http://teamline.local/api/preferences/execution-map-view", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ view: "list" }),
        }),
      );
      expect(saveResponse.status).toBe(200);
      expect(await saveResponse.json()).toEqual({ view: "list" });
      firstDatabase.close();

      const reopenedDatabase = new Database(databasePath);
      const reopenedApp = createApp({ store: new WorkOrderStore(reopenedDatabase) });
      const response = await reopenedApp.fetch(
        new Request("http://teamline.local/api/preferences/execution-map-view"),
      );
      reopenedDatabase.close();

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ view: "list" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("node status changes only when verification evidence names that node", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    let finish!: () => void;
    const app = createApp({
      store,
      codexRunner: {
        async start() {
          return {
            interrupt() {},
            events: (async function* () {
              await new Promise<void>((resolve) => {
                finish = resolve;
              });
              yield {
                type: "exit" as const,
                exitCode: 0,
                message: "Codex 已结束",
              };
            })(),
          };
        },
        async resume() {
          throw new Error("not used");
        },
      },
      worktreeManager: {
        async prepare() {
          return {
            path: repositoryPath,
            branch: "codex/evidence-test",
            baseCommit: "0123456789abcdef",
          };
        },
      },
      resultProcessor: {
        async process(workOrder) {
          return {
            planVersion: workOrder.plan!.version,
            git: { diffStat: "1 file changed", statusShort: " M src/app.ts" },
            verifications: [
              {
                stageId: workOrder.plan!.stages[0]!.id,
                stageOutcome: workOrder.plan!.stages[0]!.outcome,
                command: "bun test",
                status: "passed" as const,
                exitCode: 0,
                output: "54 pass",
              },
              {
                stageId: workOrder.plan!.stages[1]!.id,
                stageOutcome: workOrder.plan!.stages[1]!.outcome,
                command: null,
                status: "not_configured" as const,
                exitCode: null,
                output: "未配置自动验证命令",
              },
            ],
            completedAt: new Date().toISOString(),
          };
        },
      },
    });
    const created = store.create({ repositoryPath, goal: "按证据更新节点" });
    const planned = store.savePlan(created.id, [
      { outcome: "自动验证节点", scope: "src", verification: "bun test" },
      { outcome: "人工检查节点", scope: "public", verification: "浏览器检查" },
    ]);

    const startResponse = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/start`, {
        method: "POST",
      }),
    );
    expect(startResponse.status).toBe(200);
    const whileRunning = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}`),
    );
    expect((await whileRunning.json()).workOrder.plan.stages).toMatchObject([
      { id: planned.plan!.stages[0]!.id, status: "planning" },
      { id: planned.plan!.stages[1]!.id, status: "planning" },
    ]);

    finish();
    const deadline = Date.now() + 2_000;
    while (store.get(created.id)?.status !== "review") {
      if (Date.now() >= deadline) throw new Error("result processing timed out");
      await Bun.sleep(2);
    }
    const reviewed = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}`),
    );
    expect((await reviewed.clone().json()).workOrder.plan.stages).toMatchObject([
      {
        id: planned.plan!.stages[0]!.id,
        status: "response",
        statusReason: "自动验证通过，等待阶段检查点",
      },
      {
        id: planned.plan!.stages[1]!.id,
        status: "response",
        statusReason: "等待人工验收",
      },
    ]);

    const reviseResponse = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/revise`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revisionNote: "补充节点展示检查" }),
      }),
    );
    expect(reviseResponse.status).toBe(200);
    expect((await reviseResponse.json()).workOrder.plan.stages).toMatchObject([
      { status: "planning", statusReason: "等待确认并启动" },
      { status: "planning", statusReason: "等待确认并启动" },
    ]);
  });

  test("does not confirm execution methods or workspaces the current runner cannot honor", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const app = createApp({ store });
    const created = store.create({ repositoryPath, goal: "拒绝未支持的执行条件" });

    const response = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/plan`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stages: [
            {
              outcome: "在外部工具完成设计",
              scope: "设计稿",
              verification: "人工检查",
              executionMethod: "external",
              workspace: { kind: "external", path: null },
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "INVALID_PLAN",
      error: "计划内容不完整，请检查每个阶段",
    });
    expect(store.get(created.id)?.plan).toBeNull();
  });
});
