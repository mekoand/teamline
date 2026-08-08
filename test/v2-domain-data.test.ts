import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { runCli } from "../src/cli";
import { WorkOrderStore } from "../src/work-order-store";

describe("V2 domain data", () => {
  test("creates and lists projects through the local API after reopening SQLite", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-v2-projects-"));
    const databasePath = join(directory, "teamline.db");

    try {
      const firstDatabase = new Database(databasePath, { create: true });
      const firstApp = createApp({ store: new WorkOrderStore(firstDatabase) });
      const createResponse = await firstApp.fetch(
        new Request("http://teamline.local/api/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Teamline V2" }),
        }),
      );
      const { project } = await createResponse.json();
      firstDatabase.close();

      const reopenedDatabase = new Database(databasePath);
      const reopenedApp = createApp({ store: new WorkOrderStore(reopenedDatabase) });
      const listResponse = await reopenedApp.fetch(
        new Request("http://teamline.local/api/projects"),
      );
      const body = await listResponse.json();
      reopenedDatabase.close();

      expect(createResponse.status).toBe(201);
      expect(project).toEqual({
        id: expect.any(String),
        name: "Teamline V2",
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      expect(listResponse.status).toBe(200);
      expect(body.projects).toEqual([project]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("persists a named goal description and project through the compatible API", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-v2-goal-"));
    const databasePath = join(directory, "teamline.db");

    try {
      const firstDatabase = new Database(databasePath, { create: true });
      const firstStore = new WorkOrderStore(firstDatabase);
      const project = firstStore.createProject("Teamline V2");
      const firstApp = createApp({ store: firstStore });
      const createResponse = await firstApp.fetch(
        new Request("http://teamline.local/api/work-orders", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "统一目标语言",
            description: "把 V2 用户语言统一为目标",
            projectId: project.id,
          }),
        }),
      );
      const created = (await createResponse.json()).workOrder;
      firstDatabase.close();

      const reopenedDatabase = new Database(databasePath);
      const reopenedApp = createApp({ store: new WorkOrderStore(reopenedDatabase) });
      const detailResponse = await reopenedApp.fetch(
        new Request(`http://teamline.local/api/work-orders/${created.id}`),
      );
      const reopened = (await detailResponse.json()).workOrder;
      reopenedDatabase.close();

      expect(createResponse.status).toBe(201);
      expect(detailResponse.status).toBe(200);
      expect(reopened).toMatchObject({
        name: "统一目标语言",
        description: "把 V2 用户语言统一为目标",
        projectId: project.id,
        title: "统一目标语言",
        goal: "把 V2 用户语言统一为目标",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps source sessions separate from the current execution session", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-v2-sessions-"));
    const databasePath = join(directory, "teamline.db");
    const sourceSessions = [
      {
        kind: "codex_session",
        id: "source-session-a",
        lastActiveAt: "2026-08-03T02:00:00.000Z",
        version: 1,
      },
      {
        kind: "codex_session",
        id: "source-session-b",
        lastActiveAt: "2026-08-03T03:00:00.000Z",
        version: 1,
      },
    ];

    try {
      const firstDatabase = new Database(databasePath, { create: true });
      const firstStore = new WorkOrderStore(firstDatabase);
      const firstApp = createApp({ store: firstStore });
      const createResponse = await firstApp.fetch(
        new Request("http://teamline.local/api/work-orders", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "继续历史目标",
            description: "整理两个来源会话后继续推进",
            sourceSessions,
          }),
        }),
      );
      const created = (await createResponse.json()).workOrder;
      firstStore.savePlan(created.id, [
        { outcome: "继续推进", scope: "目标范围", verification: "检查结果" },
      ]);
      firstStore.markStarted(created.id);
      firstStore.recordSession(created.id, "current-execution-session");
      firstDatabase.close();

      const reopenedDatabase = new Database(databasePath);
      const reopenedApp = createApp({ store: new WorkOrderStore(reopenedDatabase) });
      const detailResponse = await reopenedApp.fetch(
        new Request(`http://teamline.local/api/work-orders/${created.id}`),
      );
      const reopened = (await detailResponse.json()).workOrder;
      reopenedDatabase.close();

      expect(createResponse.status).toBe(201);
      expect(created).toMatchObject({ sourceSessions, currentSessionId: null });
      expect(reopened).toMatchObject({
        sourceSessions,
        currentSessionId: "current-execution-session",
        importSource: sourceSessions[0],
        sessionId: "current-execution-session",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects malformed source sessions before writing a goal", async () => {
    const invalidSources = [
      [{ kind: "other", id: "session-a", lastActiveAt: "2026-08-03T02:00:00.000Z", version: 1 }],
      [{ kind: "codex_session", id: "session-a", lastActiveAt: "2026-08-03T02:00:00.000Z", version: 2 }],
      [{ kind: "codex_session", id: "   ", lastActiveAt: "2026-08-03T02:00:00.000Z", version: 1 }],
      [{ kind: "codex_session", id: "session-a", lastActiveAt: "not-a-date", version: 1 }],
    ];

    for (const sourceSessions of invalidSources) {
      const store = new WorkOrderStore(new Database(":memory:"));
      const response = await createApp({ store }).fetch(
        new Request("http://teamline.local/api/work-orders", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "不应写入",
            description: "来源会话不合法",
            sourceSessions,
          }),
        }),
      );

      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain("来源会话");
      expect(store.list()).toEqual([]);
    }
  });

  test("rejects duplicate source session ids within one goal", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const response = await createApp({ store }).fetch(
      new Request("http://teamline.local/api/work-orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "重复来源",
          description: "同一来源不能重复出现",
          sourceSessions: [
            {
              kind: "codex_session",
              id: "shared-source",
              lastActiveAt: "2026-08-03T02:00:00.000Z",
              version: 1,
            },
            {
              kind: "codex_session",
              id: "shared-source",
              lastActiveAt: "2026-08-03T03:00:00.000Z",
              version: 1,
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("来源会话");
    expect(store.list()).toEqual([]);
  });

  test("does not let two goals claim the same source session", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const app = createApp({ store });
    const sourceSessions = [{
      kind: "codex_session",
      id: "shared-source",
      lastActiveAt: "2026-08-03T02:00:00.000Z",
      version: 1,
    }];
    const create = (name: string) => app.fetch(
      new Request("http://teamline.local/api/work-orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, description: `${name}说明`, sourceSessions }),
      }),
    );

    expect((await create("第一个目标")).status).toBe(201);
    const duplicate = await create("第二个目标");
    expect(duplicate.status).toBe(400);
    expect((await duplicate.json()).error).toContain("来源会话");
    expect(store.list()).toHaveLength(1);
  });

  test("upgrades a legacy SQLite work order without losing compatible fields", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-v2-legacy-"));
    const databasePath = join(directory, "teamline.db");
    const importSource = {
      kind: "codex_session",
      id: "legacy-source-session",
      lastActiveAt: "2026-08-01T00:00:00.000Z",
      version: 1,
    };
    let database: Database | undefined;

    try {
      database = new Database(databasePath, { create: true });
      database.exec(`
        CREATE TABLE work_orders (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          repository_path TEXT NOT NULL,
          goal TEXT NOT NULL,
          acceptance TEXT,
          status TEXT NOT NULL,
          current_summary TEXT NOT NULL,
          plan_json TEXT,
          import_source_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      database
        .query(`
          INSERT INTO work_orders (
            id, title, repository_path, goal, acceptance, status,
            current_summary, plan_json, import_source_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
        `)
        .run(
          "legacy-goal",
          "旧目标名称",
          "/tmp/legacy",
          "旧目标说明",
          "旧验收要求",
          "draft",
          "等待生成计划",
          JSON.stringify(importSource),
          "2026-08-01T00:00:00.000Z",
          "2026-08-01T00:00:00.000Z",
        );
      database.close();

      database = new Database(databasePath);
      const firstStore = new WorkOrderStore(database);
      const firstApp = createApp({ store: firstStore });
      const firstResponse = await firstApp.fetch(
        new Request("http://teamline.local/api/work-orders/legacy-goal"),
      );
      const first = (await firstResponse.json()).workOrder;
      database.close();

      database = new Database(databasePath);
      const reopenedStore = new WorkOrderStore(database);
      const second = reopenedStore.get("legacy-goal");

      expect(firstResponse.status).toBe(200);
      expect(first).toMatchObject({
        id: "legacy-goal",
        name: "旧目标名称",
        description: "旧目标说明",
        projectId: null,
        sourceSessions: [importSource],
        currentSessionId: null,
        importSource,
        title: "旧目标名称",
        goal: "旧目标说明",
        acceptance: "旧验收要求",
        repositoryPath: "/tmp/legacy",
      });
      expect(second).toMatchObject(first);
      expect(reopenedStore.listProjects()).toEqual([]);
    } finally {
      database?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("assigns a duplicated legacy import source to one stable owner across export and restore", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-v2-legacy-duplicate-"));
    const databasePath = join(directory, "teamline.db");
    const importSource = {
      kind: "codex_session",
      id: "shared-legacy-session",
      lastActiveAt: "2026-08-01T00:00:00.000Z",
      version: 1,
    };
    let database: Database | undefined;

    try {
      database = new Database(databasePath, { create: true });
      database.exec(`
        CREATE TABLE work_orders (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          repository_path TEXT NOT NULL,
          goal TEXT NOT NULL,
          acceptance TEXT,
          status TEXT NOT NULL,
          current_summary TEXT NOT NULL,
          plan_json TEXT,
          import_source_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      const insert = database.query(`
        INSERT INTO work_orders (
          id, title, repository_path, goal, acceptance, status,
          current_summary, plan_json, import_source_json, created_at, updated_at
        ) VALUES (?, ?, '', ?, NULL, 'draft', '等待生成计划', NULL, ?, ?, ?)
      `);
      insert.run(
        "legacy-owner",
        "较早目标",
        "较早说明",
        JSON.stringify(importSource),
        "2026-08-01T00:00:00.000Z",
        "2026-08-01T00:00:00.000Z",
      );
      insert.run(
        "legacy-duplicate",
        "较晚目标",
        "较晚说明",
        JSON.stringify(importSource),
        "2026-08-02T00:00:00.000Z",
        "2026-08-02T00:00:00.000Z",
      );
      database.close();

      database = new Database(databasePath);
      const upgradedStore = new WorkOrderStore(database);
      expect(upgradedStore.get("legacy-owner")).toMatchObject({
        sourceSessions: [importSource],
        importSource,
      });
      expect(upgradedStore.get("legacy-duplicate")).toMatchObject({
        sourceSessions: [],
        importSource: null,
      });
      expect(
        upgradedStore.database
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM work_orders WHERE import_source_json IS NOT NULL",
          )
          .get()?.count,
      ).toBe(2);

      const exported = await (
        await createApp({ store: upgradedStore }).fetch(
          new Request("http://teamline.local/api/local-state/export"),
        )
      ).json();
      expect(exported.version).toBe(4);
      database.close();

      const restoredStore = new WorkOrderStore(new Database(":memory:"));
      const restoredApp = createApp({ store: restoredStore });
      const previewResponse = await restoredApp.fetch(
        new Request("http://teamline.local/api/local-state/restore/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ bundle: exported }),
        }),
      );
      const preview = await previewResponse.json();
      const confirmResponse = await restoredApp.fetch(
        new Request("http://teamline.local/api/local-state/restore/confirm", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ previewId: preview.previewId }),
        }),
      );

      expect(previewResponse.status).toBe(200);
      expect(confirmResponse.status).toBe(201);
      expect(restoredStore.get("legacy-owner")?.sourceSessions).toEqual([{
        ...importSource,
        executionIdentityId: expect.any(String),
      }]);
      expect(restoredStore.get("legacy-duplicate")).toMatchObject({
        sourceSessions: [],
        importSource: null,
      });
    } finally {
      database?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps legacy work-order creation and address beside the goal address", async () => {
    const app = createApp({ store: new WorkOrderStore(new Database(":memory:")) });
    const createResponse = await app.fetch(
      new Request("http://teamline.local/api/work-orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal: "继续支持旧客户端", acceptance: "旧字段保持可读" }),
      }),
    );
    const created = (await createResponse.json()).workOrder;
    const goalPage = await app.fetch(
      new Request(`http://teamline.local/goals/${created.id}`),
    );
    const legacyPage = await app.fetch(
      new Request(`http://teamline.local/work-orders/${created.id}`),
    );

    expect(createResponse.status).toBe(201);
    expect(created).toMatchObject({
      name: "继续支持旧客户端",
      description: "继续支持旧客户端",
      title: "继续支持旧客户端",
      goal: "继续支持旧客户端",
      acceptance: "旧字段保持可读",
    });
    expect(goalPage.status).toBe(200);
    expect(legacyPage.status).toBe(200);
  });

  test("presents review separately from goals that need a response", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const responseGoal = store.savePlan(
      store.create({ goal: "等待用户处理" }).id,
      [{ outcome: "执行", scope: "src", verification: "检查" }],
    );
    store.markStarted(responseGoal.id);
    store.recordInterrupted(responseGoal.id);

    const reviewGoal = store.savePlan(
      store.create({ goal: "等待用户验收" }).id,
      [{ outcome: "交付", scope: "src", verification: "检查" }],
    );
    store.markStarted(reviewGoal.id);
    const verifying = store.beginResultProcessing(reviewGoal.id, "Codex 已结束");
    store.completeReview(reviewGoal.id, {
      planVersion: verifying.plan!.version,
      git: { diffStat: "", statusShort: "" },
      verifications: [{
        stageId: verifying.plan!.stages[0]!.id,
        stageOutcome: verifying.plan!.stages[0]!.outcome,
        command: "check",
        status: "passed",
        exitCode: 0,
        output: "pass",
      }],
      completedAt: "2026-08-04T00:00:00.000Z",
    });

    const response = await createApp({ store }).fetch(
      new Request("http://teamline.local/api/console"),
    );
    const workOrders = (await response.json()).workOrders;

    expect(
      workOrders.find((workOrder: { id: string }) => workOrder.id === responseGoal.id),
    ).toMatchObject({ userStatus: "response", statusReason: "执行中断" });
    expect(
      workOrders.find((workOrder: { id: string }) => workOrder.id === reviewGoal.id),
    ).toMatchObject({ userStatus: "review", statusReason: "待验收" });
  });

  test("CLI labels review separately and opens the goal address", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const reviewGoal = store.savePlan(
      store.create({ goal: "验收 CLI 输出" }).id,
      [{ outcome: "交付", scope: "src", verification: "检查" }],
    );
    store.markStarted(reviewGoal.id);
    const verifying = store.beginResultProcessing(reviewGoal.id, "Codex 已结束");
    store.completeReview(reviewGoal.id, {
      planVersion: verifying.plan!.version,
      git: { diffStat: "", statusShort: "" },
      verifications: [{
        stageId: verifying.plan!.stages[0]!.id,
        stageOutcome: verifying.plan!.stages[0]!.outcome,
        command: "check",
        status: "passed",
        exitCode: 0,
        output: "pass",
      }],
      completedAt: "2026-08-04T00:00:00.000Z",
    });
    const responseGoal = store.savePlan(
      store.create({ goal: "处理 CLI 响应" }).id,
      [{ outcome: "执行", scope: "src", verification: "检查" }],
    );
    store.markStarted(responseGoal.id);
    store.recordInterrupted(responseGoal.id);
    const app = createApp({ store });
    const stdout: string[] = [];
    const opened: string[] = [];
    const dependencies = {
      cwd: () => "/tmp",
      env: { TEAMLINE_URL: "http://127.0.0.1:4310/" },
      fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
        app.fetch(new Request(input, init))) as typeof globalThis.fetch,
      stdout: (message: string) => stdout.push(message),
      stderr: () => {},
      openUrl: (url: string) => opened.push(url),
      resolveWorkspace: async (cwd: string) => cwd,
    };

    dependencies.env.TEAMLINE_LANG = "zh-CN";

    expect(await runCli(["list"], dependencies)).toBe(0);
    expect(stdout.join("\n")).toContain("待验收  验收 CLI 输出");
    expect(stdout.join("\n")).toContain("需响应  处理 CLI 响应");
    expect(await runCli(["open", reviewGoal.id], dependencies)).toBe(0);
    expect(opened).toEqual([
      `http://127.0.0.1:4310/goals/${reviewGoal.id}`,
    ]);
  });

  test("resource presentation keeps review separate from response", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const reviewGoal = store.savePlan(
      store.create({ goal: "验收资源结果" }).id,
      [{ outcome: "交付", scope: "src", verification: "检查" }],
    );
    store.markStarted(reviewGoal.id);
    const verifying = store.beginResultProcessing(reviewGoal.id, "Codex 已结束");
    store.completeReview(reviewGoal.id, {
      planVersion: verifying.plan!.version,
      git: { diffStat: "", statusShort: "" },
      verifications: [{
        stageId: verifying.plan!.stages[0]!.id,
        stageOutcome: verifying.plan!.stages[0]!.outcome,
        command: "check",
        status: "passed",
        exitCode: 0,
        output: "pass",
      }],
      completedAt: "2026-08-04T00:00:00.000Z",
    });
    const responseGoal = store.savePlan(
      store.create({ goal: "处理资源响应" }).id,
      [{ outcome: "执行", scope: "src", verification: "检查" }],
    );
    store.markStarted(responseGoal.id);
    store.recordInterrupted(responseGoal.id);
    const observedAt = "2026-08-04T00:00:00.000Z";
    const app = createApp({
      store,
      resourceProvider: {
        async read() {
          return {
            observedAt,
            codex: {
              status: "not_connected" as const,
              source: "codex-app-server" as const,
              observedAt,
              message: "未连接",
              shortWindow: null,
              longWindow: null,
            },
            openaiApi: {
              status: "not_connected" as const,
              source: "openai-usage-api" as const,
              observedAt,
              message: "未连接",
              scope: null,
              usage: null,
            },
            workOrderUsage: [],
          };
        },
      },
    });

    const response = await app.fetch(
      new Request("http://teamline.local/api/resources"),
    );
    const workOrders = (await response.json()).workOrders;

    expect(
      workOrders.find((workOrder: { id: string }) => workOrder.id === reviewGoal.id),
    ).toMatchObject({ status: "review", recommendation: "先验收这个目标" });
    expect(
      workOrders.find((workOrder: { id: string }) => workOrder.id === responseGoal.id),
    ).toMatchObject({ status: "response", recommendation: "先处理这个目标需要的响应" });
  });

  test("serves a distinct review group and goal-first navigation in the local console", async () => {
    const app = createApp({ store: new WorkOrderStore(new Database(":memory:")) });
    const page = await (
      await app.fetch(new Request("http://teamline.local/"))
    ).text();
    const script = await (
      await app.fetch(new Request("http://teamline.local/app.js"))
    ).text();

    expect(page).toContain('data-i18n="shell.goals">Goals</h1>');
    expect(page).toContain('id="language-select"');
    expect(page).toContain('name="name"');
    expect(page).toContain('name="description"');
    expect(script).toContain("visibleStatusLabels");
    expect(script).toContain('["review", visibleStatusLabels.review]');
    expect(script).toContain("<dt>来源会话</dt>");
    expect(script).toContain("<dt>当前执行会话</dt>");
    expect(script).toContain("(?:goals|work-orders)");
    expect(script).toContain('`/goals/${encodeURIComponent(id)}`');
  });
});
