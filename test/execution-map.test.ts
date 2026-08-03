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
      { id: planned.plan!.stages[0]!.id, status: "running" },
      { id: planned.plan!.stages[1]!.id, status: "running" },
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

  test("an external node requires a user result and never starts Codex", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    let starts = 0;
    const app = createApp({
      store,
      codexRunner: {
        async start() {
          starts += 1;
          throw new Error("external work must not start Codex");
        },
        async resume() {
          throw new Error("not used");
        },
      },
    });
    const created = store.create({ goal: "先在外部完成设计" });

    const planResponse = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/plan`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stages: [
            {
              id: "design",
              outcome: "在外部工具完成设计",
              scope: "设计稿",
              verification: "人工检查",
              executionMethod: "external",
            },
          ],
        }),
      }),
    );
    expect(planResponse.status).toBe(200);
    const planned = (await planResponse.json()).workOrder;
    expect(planned.plan.stages[0]).toMatchObject({
      executionMethod: "external",
      workspace: { kind: "external", path: null },
      status: "response",
      statusReason: "等待你在外部完成并标记",
    });

    const consoleResponse = await app.fetch(
      new Request("http://teamline.local/api/console"),
    );
    expect((await consoleResponse.json()).workOrders[0]).toMatchObject({
      userStatus: "response",
      statusReason: "待完成外部节点：在外部工具完成设计",
    });

    const startResponse = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/start`, {
        method: "POST",
      }),
    );
    expect(startResponse.status).toBe(409);
    expect(await startResponse.json()).toMatchObject({
      code: "EXTERNAL_STAGE_ACTION_REQUIRED",
    });
    expect(starts).toBe(0);
    expect(store.get(created.id)?.runStatus).toBeNull();
  });

  test("an external result keeps its original reference and releases a dependent AI node after reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-external-stage-"));
    const databasePath = join(directory, "teamline.db");
    const missingOriginalFile = join(directory, "not-created-by-teamline.fig");

    try {
      const firstDatabase = new Database(databasePath, { create: true });
      const firstStore = new WorkOrderStore(firstDatabase);
      const firstApp = createApp({ store: firstStore });
      const created = firstStore.create({ repositoryPath, goal: "设计完成后实现页面" });
      firstStore.savePlan(created.id, [
        {
          id: "design",
          outcome: "完成外部设计",
          scope: "设计工具",
          verification: "用户确认设计结论",
          executionMethod: "external",
        },
        {
          id: "implementation",
          outcome: "实现页面",
          scope: "public",
          verification: "浏览器检查",
          dependsOn: ["design"],
          executionMethod: "codex",
        },
      ]);

      const completeResponse = await firstApp.fetch(
        new Request(
          `http://teamline.local/api/work-orders/${created.id}/plan-stages/design/complete-external`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              reference: { type: "file", location: missingOriginalFile },
            }),
          },
        ),
      );
      expect(completeResponse.status).toBe(200);
      expect((await completeResponse.json()).workOrder.plan.stages).toMatchObject([
        {
          id: "design",
          status: "completed",
          externalResult: {
            conclusion: null,
          },
          artifacts: [{ type: "file", location: missingOriginalFile }],
        },
        {
          id: "implementation",
          status: "planning",
          statusReason: "前置节点已完成，可以启动 Codex",
        },
      ]);
      firstDatabase.close();

      const reopenedDatabase = new Database(databasePath);
      const reopened = new WorkOrderStore(reopenedDatabase).get(created.id);
      reopenedDatabase.close();
      expect(reopened?.status).toBe("ready");
      expect(reopened?.plan?.stages[0]?.artifacts[0]?.location).toBe(
        missingOriginalFile,
      );
      expect(reopened?.plan?.stages[1]).toMatchObject({
        status: "planning",
        statusReason: "前置节点已完成，可以启动 Codex",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a mixed AI-external-AI plan runs only the eligible AI segment and keeps prior evidence", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const runs: string[][] = [];
    const app = createApp({
      store,
      worktreeManager: {
        async prepare() {
          return {
            path: repositoryPath,
            branch: "codex/external-handoff",
            baseCommit: "0123456789abcdef",
          };
        },
      },
      codexRunner: {
        async start({ workOrder }) {
          runs.push(workOrder.plan!.stages.map((stage) => stage.id));
          return {
            interrupt() {},
            events: (async function* () {
              yield { type: "exit" as const, exitCode: 0, message: "Codex 已结束" };
            })(),
          };
        },
        async resume() {
          throw new Error("not used");
        },
      },
      resultProcessor: {
        async process(workOrder) {
          return {
            planVersion: workOrder.plan!.version,
            git: { diffStat: "1 file changed", statusShort: " M public/app.js" },
            verifications: workOrder.plan!.stages.map((stage) => ({
              stageId: stage.id,
              stageOutcome: stage.outcome,
              command: "bun test",
              status: "passed" as const,
              exitCode: 0,
              output: "pass",
            })),
            completedAt: new Date().toISOString(),
          };
        },
      },
    });
    const created = store.create({ repositoryPath, goal: "研究、确认、再实现" });
    store.savePlan(created.id, [
      {
        id: "research",
        outcome: "整理方案",
        scope: "docs",
        verification: "bun test",
        verificationCommand: "bun test",
        executionMethod: "codex",
      },
      {
        id: "decision",
        outcome: "确认设计方向",
        scope: "外部设计工具",
        verification: "用户确认",
        dependsOn: ["research"],
        executionMethod: "external",
      },
      {
        id: "implementation",
        outcome: "实现确认后的方案",
        scope: "public",
        verification: "bun test",
        verificationCommand: "bun test",
        dependsOn: ["decision"],
        executionMethod: "codex",
      },
    ]);

    const firstStart = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/start`, {
        method: "POST",
      }),
    );
    expect(firstStart.status).toBe(200);
    while (store.get(created.id)?.runStatus !== null) await Bun.sleep(1);
    expect(runs).toEqual([["research"]]);
    expect(store.get(created.id)?.plan?.stages).toMatchObject([
      { id: "research", status: "completed" },
      { id: "decision", status: "response" },
      { id: "implementation", status: "queued" },
    ]);

    const external = await app.fetch(
      new Request(
        `http://teamline.local/api/work-orders/${created.id}/plan-stages/decision/complete-external`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ conclusion: "采用紧凑布局" }),
        },
      ),
    );
    expect(external.status).toBe(200);
    expect((await external.json()).workOrder.plan.stages[2]).toMatchObject({
      status: "planning",
      statusReason: "前置节点已完成，可以启动 Codex",
    });

    const secondStart = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/start`, {
        method: "POST",
      }),
    );
    expect(secondStart.status).toBe(200);
    while (store.get(created.id)?.status !== "review") await Bun.sleep(1);
    expect(runs).toEqual([["research"], ["implementation"]]);
    expect(store.get(created.id)?.result?.verifications.map((item) => item.stageId)).toEqual([
      "research",
      "implementation",
    ]);
  });

  test("an AI node without automatic verification needs confirmation before external work is released", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const app = createApp({ store });
    const created = store.create({ repositoryPath, goal: "整理建议后人工决定" });
    store.savePlan(created.id, [
      {
        id: "proposal",
        outcome: "整理建议",
        scope: "docs",
        verification: "人工检查建议",
        executionMethod: "codex",
      },
      {
        id: "decision",
        outcome: "人工决定",
        scope: "外部沟通",
        verification: "用户确认",
        dependsOn: ["proposal"],
        executionMethod: "external",
      },
    ]);
    store.markStarted(created.id);
    store.beginResultProcessing(created.id, "Codex 已结束");
    store.completeReview(created.id, {
      planVersion: 1,
      git: { diffStat: "", statusShort: "" },
      verifications: [
        {
          stageId: "proposal",
          stageOutcome: "整理建议",
          command: null,
          status: "not_configured",
          exitCode: null,
          output: "未配置自动验证命令",
        },
      ],
      completedAt: new Date().toISOString(),
    });

    expect(store.get(created.id)).toMatchObject({
      status: "review",
      runStatus: "completed",
      plan: {
        stages: [
          { id: "proposal", status: "response" },
          { id: "decision", status: "queued" },
        ],
      },
    });
    const lockedExternal = await app.fetch(
      new Request(
        `http://teamline.local/api/work-orders/${created.id}/plan-stages/decision/complete-external`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ conclusion: "不能提前登记" }),
        },
      ),
    );
    expect(lockedExternal.status).toBe(409);

    const confirmation = await app.fetch(
      new Request(
        `http://teamline.local/api/work-orders/${created.id}/confirm-stage-results`,
        { method: "POST" },
      ),
    );
    expect(confirmation.status).toBe(200);
    expect((await confirmation.json()).workOrder).toMatchObject({
      status: "ready",
      runStatus: null,
      plan: {
        stages: [
          { id: "proposal", status: "completed", statusReason: "已由你确认完成" },
          { id: "decision", status: "response" },
        ],
      },
    });
  });

  test("parallel manual AI review is preserved while an external node is ready or completed", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const app = createApp({ store });
    const prepareMixedResult = (goal: string) => {
      const created = store.create({ repositoryPath, goal });
      store.savePlan(created.id, [
        {
          id: "verified",
          outcome: "自动核验的 AI 工作",
          scope: "src",
          verification: "bun test",
          verificationCommand: "bun test",
          executionMethod: "codex",
        },
        {
          id: "manual",
          outcome: "人工检查的 AI 工作",
          scope: "public",
          verification: "浏览器检查",
          executionMethod: "codex",
        },
        {
          id: "external",
          outcome: "外部确认",
          scope: "外部沟通",
          verification: "用户确认",
          dependsOn: ["verified"],
          executionMethod: "external",
        },
      ]);
      store.markStarted(created.id);
      store.beginResultProcessing(created.id, "Codex 已结束");
      store.completeReview(created.id, {
        planVersion: 1,
        git: { diffStat: "", statusShort: "" },
        verifications: [
          {
            stageId: "verified",
            stageOutcome: "自动核验的 AI 工作",
            command: "bun test",
            status: "passed",
            exitCode: 0,
            output: "pass",
          },
          {
            stageId: "manual",
            stageOutcome: "人工检查的 AI 工作",
            command: null,
            status: "not_configured",
            exitCode: null,
            output: "未配置自动验证命令",
          },
        ],
        completedAt: new Date().toISOString(),
      });
      return created.id;
    };

    const confirmFirstId = prepareMixedResult("先确认并行 AI 结果");
    expect(store.get(confirmFirstId)?.plan?.stages).toMatchObject([
      { id: "verified", status: "completed" },
      { id: "manual", status: "response" },
      { id: "external", status: "response" },
    ]);
    const confirmation = await app.fetch(
      new Request(
        `http://teamline.local/api/work-orders/${confirmFirstId}/confirm-stage-results`,
        { method: "POST" },
      ),
    );
    expect(confirmation.status).toBe(200);
    expect((await confirmation.json()).workOrder.plan.stages[1]).toMatchObject({
      id: "manual",
      status: "completed",
    });

    const externalFirstId = prepareMixedResult("先完成并行外部节点");
    const external = await app.fetch(
      new Request(
        `http://teamline.local/api/work-orders/${externalFirstId}/plan-stages/external/complete-external`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ conclusion: "外部确认完成" }),
        },
      ),
    );
    expect(external.status).toBe(200);
    expect((await external.json()).workOrder).toMatchObject({
      status: "review",
      plan: {
        stages: [
          { id: "verified", status: "completed" },
          { id: "manual", status: "response" },
          { id: "external", status: "completed" },
        ],
      },
    });
    const confirmationAfterExternal = await app.fetch(
      new Request(
        `http://teamline.local/api/work-orders/${externalFirstId}/confirm-stage-results`,
        { method: "POST" },
      ),
    );
    expect(confirmationAfterExternal.status).toBe(200);
    expect((await confirmationAfterExternal.json()).workOrder).toMatchObject({
      status: "review",
      runStatus: "completed",
      plan: {
        stages: [
          { id: "verified", status: "completed" },
          { id: "manual", status: "completed" },
          { id: "external", status: "completed" },
        ],
      },
    });
  });

  test("continue without a saved session sends only the AI segment before an external node", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const runs: string[][] = [];
    const app = createApp({
      store,
      codexRunner: {
        async start({ workOrder }) {
          runs.push(workOrder.plan!.stages.map((stage) => stage.id));
          return {
            interrupt() {},
            events: (async function* () {
              yield { type: "exit" as const, exitCode: 0, message: "Codex 已结束" };
            })(),
          };
        },
        async resume() {
          throw new Error("resume must not be called without a session");
        },
      },
      resultProcessor: {
        async process(workOrder) {
          const stage = workOrder.plan!.stages[0]!;
          return {
            planVersion: workOrder.plan!.version,
            git: { diffStat: "", statusShort: "" },
            verifications: [
              {
                stageId: stage.id,
                stageOutcome: stage.outcome,
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
    const created = store.create({ repositoryPath, goal: "继续当前 AI 现场" });
    store.savePlan(created.id, [
      {
        id: "before",
        outcome: "外部决定前的实现",
        scope: "src",
        verification: "人工检查",
        executionMethod: "codex",
      },
      {
        id: "decision",
        outcome: "外部决定",
        scope: "外部沟通",
        verification: "用户确认",
        dependsOn: ["before"],
        executionMethod: "external",
      },
      {
        id: "after",
        outcome: "决定后的实现",
        scope: "public",
        verification: "人工检查",
        dependsOn: ["decision"],
        executionMethod: "codex",
      },
    ]);
    store.saveWorktree(created.id, {
      path: repositoryPath,
      branch: "codex/external-continue-test",
      baseCommit: "0123456789abcdef",
    });
    store.markStarted(created.id);
    store.recordInterrupted(created.id);

    const response = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/continue`, {
        method: "POST",
      }),
    );
    expect(response.status).toBe(200);
    expect(runs).toEqual([["before"]]);
  });

  test("an external-only plan reaches review from a short conclusion or external link", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const app = createApp({ store });
    const conclusionOnly = store.create({ goal: "记录外部结论" });
    store.savePlan(conclusionOnly.id, [
      {
        id: "decision",
        outcome: "确认人工决定",
        scope: "外部沟通",
        verification: "用户确认",
        executionMethod: "external",
      },
    ]);
    const conclusionResponse = await app.fetch(
      new Request(
        `http://teamline.local/api/work-orders/${conclusionOnly.id}/plan-stages/decision/complete-external`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ conclusion: "决定保留现有信息架构" }),
        },
      ),
    );
    expect(conclusionResponse.status).toBe(200);
    expect((await conclusionResponse.json()).workOrder).toMatchObject({
      status: "review",
      plan: {
        stages: [
          {
            status: "completed",
            externalResult: { conclusion: "决定保留现有信息架构" },
            artifacts: [],
          },
        ],
      },
    });

    const created = store.create({ goal: "完成外部文档" });
    store.savePlan(created.id, [
      {
        id: "document",
        outcome: "完成协作文档",
        scope: "外部文档",
        verification: "用户确认",
        executionMethod: "external",
      },
    ]);

    const response = await app.fetch(
      new Request(
        `http://teamline.local/api/work-orders/${created.id}/plan-stages/document/complete-external`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            reference: {
              type: "link",
              label: "协作文档",
              location: "https://example.test/document/42",
            },
          }),
        },
      ),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).workOrder).toMatchObject({
      status: "review",
      currentSummary: "全部节点已完成，等待验收",
      plan: {
        stages: [
          {
            status: "completed",
            artifacts: [
              {
                type: "link",
                label: "协作文档",
                location: "https://example.test/document/42",
              },
            ],
          },
        ],
      },
    });
  });
});
