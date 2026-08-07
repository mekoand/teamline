import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp } from "../src/app";
import type {
  CodexSessionDiscoveryResult,
  CodexSessionProvider,
} from "../src/codex-session-discovery";
import { WorkOrderStore } from "../src/work-order-store";
import { presentConsoleWorkOrders } from "../src/console-presentation";

function provider(read: () => CodexSessionDiscoveryResult): CodexSessionProvider {
  return { async discover() { return read(); } };
}

async function waitForImport(
  store: WorkOrderStore,
  id: string,
  expected: "ready" | "failed" = "ready",
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const workOrder = store.get(id);
    if (workOrder?.importContext?.status === expected) return workOrder;
    await Bun.sleep(1);
  }
  throw new Error(`会话整理没有进入 ${expected}`);
}

const baseDiscovery: CodexSessionDiscoveryResult = {
  status: "available",
  message: "只读取本机会话",
  sessions: [
    {
      id: "session-a",
      title: "设置页面重构",
      workspacePath: "/tmp/project-a",
      projectLabel: "project-a",
      lastActiveAt: "2026-08-03T02:00:00.000Z",
      sourcePath: "/tmp/codex/session-a.jsonl",
      availability: "available",
      message: null,
    },
    {
      id: "session-b",
      title: "整理产品文档",
      workspacePath: "/tmp/project-b",
      projectLabel: "project-b",
      lastActiveAt: "2026-08-03T01:00:00.000Z",
      sourcePath: "/tmp/codex/session-b.jsonl",
      availability: "available",
      message: null,
    },
  ],
};

const organized = {
  description: "完成设置页重构并整理发布说明",
  summary: "两个来源会话已经完成设计与主要实现，当前等待补齐验证。",
  currentState: "实现基本完成，验证尚未完成",
  completedHighlights: ["设置页结构已确认", "主要页面已实现"],
  nextAction: "补齐验证并确认发布结果",
  historicalStages: [
    {
      id: "design",
      outcome: "确认设置页结构",
      summary: "结构与交互已经确认",
      status: "completed" as const,
      sourceSessionIds: ["session-a"],
    },
    {
      id: "implementation",
      outcome: "完成页面实现",
      summary: "主要页面已经实现",
      status: "in_progress" as const,
      sourceSessionIds: ["session-a", "session-b"],
    },
  ],
  artifacts: [
    {
      id: "settings-file",
      type: "file" as const,
      label: "设置页入口",
      location: "/tmp/project-a/src/settings.ts",
    },
  ],
};

const singleSourceOrganization = {
  ...organized,
  historicalStages: organized.historicalStages.map((stage) => ({
    ...stage,
    sourceSessionIds: ["session-a"],
  })),
};

describe("V2 single-goal Codex session import", () => {
  test("creates the goal before background organization finishes", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    let scheduled: (() => void) | undefined;
    let finishOrganization!: (value: typeof singleSourceOrganization) => void;
    let organizerStarted = false;
    const organization = new Promise<typeof singleSourceOrganization>((resolve) => {
      finishOrganization = resolve;
    });
    const app = createApp({
      store,
      codexSessionProvider: provider(() => baseDiscovery),
      sessionOrganizationScheduler(callback) { scheduled = callback; },
      sessionOrganizer: {
        async organize() {
          organizerStarted = true;
          return organization;
        },
      },
    });

    const response = await app.fetch(new Request("http://teamline.local/api/codex-sessions/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "后台整理目标", sessionIds: ["session-a"] }),
    }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.outcome).toBe("pending");
    expect(organizerStarted).toBe(false);
    expect(store.get(body.workOrder.id)?.currentSummary).toBe("正在整理历史");
    expect(presentConsoleWorkOrders(store.list())[0]).toMatchObject({
      userStatus: "planning",
      statusReason: "正在整理历史",
    });

    scheduled?.();
    await Bun.sleep(0);
    expect(organizerStarted).toBe(true);
    expect(store.get(body.workOrder.id)?.importContext?.status).toBe("pending");
    finishOrganization(singleSourceOrganization);
    const ready = await waitForImport(store, body.workOrder.id);
    expect(ready.importContext).toMatchObject({ status: "ready" });
  });

  test("turns unfinished organization into a retryable interruption after restart", () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const pending = store.create({
      name: "中断的整理",
      description: "中断的整理",
      sourceSessions: [{
        kind: "codex_session",
        id: "session-a",
        lastActiveAt: "2026-08-03T02:00:00.000Z",
        version: 1,
      }],
      importContext: {
        status: "pending",
        summary: null,
        currentState: null,
        completedHighlights: [],
        nextAction: null,
        historicalStages: [],
        artifacts: [],
        organizedAt: null,
        error: null,
      },
    });

    createApp({ store });

    expect(store.get(pending.id)?.importContext).toMatchObject({
      status: "failed",
      error: "历史整理中断",
    });
    expect(presentConsoleWorkOrders(store.list())[0]?.statusReason).toBe("历史整理中断");
  });

  test("close interrupts background discovery that never finishes", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    let discoveryCalls = 0;
    let scheduled: (() => void) | undefined;
    let rejectDiscovery!: (error: Error) => void;
    const stuckDiscovery = new Promise<never>((_, reject) => {
      rejectDiscovery = reject;
    });
    const app = createApp({
      store,
      codexSessionProvider: {
        async discover() {
          discoveryCalls += 1;
          if (discoveryCalls === 1) return baseDiscovery;
          return stuckDiscovery;
        },
      },
      sessionOrganizationScheduler(callback) { scheduled = callback; },
      sessionOrganizer: { async organize() { return singleSourceOrganization; } },
    });
    const imported = await app.fetch(new Request(
      "http://teamline.local/api/codex-sessions/import",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "发现阶段中断", sessionIds: ["session-a"] }),
      },
    ));
    const id = (await imported.json()).workOrder.id;
    scheduled?.();
    await Bun.sleep(0);
    expect(discoveryCalls).toBe(2);

    const closeResult = await Promise.race([
      app.close().then(() => "closed"),
      Bun.sleep(100).then(() => "timed-out"),
    ]);

    expect(closeResult).toBe("closed");
    expect(store.get(id)?.importContext).toMatchObject({
      status: "failed",
      error: "历史整理中断",
    });
    rejectDiscovery(new Error("延迟失败"));
    await Bun.sleep(0);
  });

  test("bounds the new summary fields and accepts legacy contexts without them", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const app = createApp({
      store,
      codexSessionProvider: provider(() => baseDiscovery),
      sessionOrganizer: {
        async organize() {
          return {
            ...singleSourceOrganization,
            description: `得到明确结果。${"不应进入目标".repeat(30)}`,
            summary: "摘要".repeat(180),
            currentState: "当前状态".repeat(40),
            completedHighlights: Array.from({ length: 5 }, (_, index) =>
              `已完成 ${index + 1} ${"内容".repeat(60)}`
            ),
            nextAction: "下一步".repeat(80),
            historicalStages: Array.from({ length: 12 }, (_, index) => ({
              id: `history-${index + 1}`,
              outcome: `历史节点 ${index + 1} ${"名称".repeat(60)}`,
              summary: "节点摘要".repeat(60),
              status: "completed" as const,
              sourceSessionIds: ["session-a"],
            })),
          };
        },
      },
    });
    const response = await app.fetch(new Request("http://teamline.local/api/codex-sessions/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "收紧整理字段", sessionIds: ["session-a"] }),
    }));
    const ready = await waitForImport(store, (await response.json()).workOrder.id);

    expect(ready.description).toBe("得到明确结果。");
    expect(ready.importContext?.summary.length).toBeLessThanOrEqual(240);
    expect(ready.importContext?.currentState?.length).toBeLessThanOrEqual(100);
    expect(ready.importContext?.completedHighlights).toHaveLength(3);
    expect(ready.importContext?.completedHighlights.every((item) => item.length <= 80)).toBe(true);
    expect(ready.importContext?.nextAction?.length).toBeLessThanOrEqual(100);
    expect(ready.importContext?.historicalStages).toHaveLength(8);

    const legacy = store.create({
      name: "旧导入目标",
      description: "旧导入目标",
      sourceSessions: [{
        kind: "codex_session",
        id: "legacy-session",
        lastActiveAt: "2026-08-01T00:00:00.000Z",
        version: 1,
      }],
      importContext: {
        status: "ready",
        summary: "旧摘要",
        currentState: "旧状态",
        historicalStages: [],
        artifacts: [],
        organizedAt: "2026-08-01T01:00:00.000Z",
        error: null,
      } as never,
    });
    expect(store.get(legacy.id)?.importContext).toMatchObject({
      completedHighlights: [],
      nextAction: null,
    });
  });

  test("upgrades a legacy import context when the source is reorganized", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const legacySource = {
      ...baseDiscovery.sessions[0]!,
      id: "legacy-session",
      title: "旧来源会话",
    };
    const legacy = store.create({
      name: "旧导入目标",
      description: "旧导入目标",
      sourceSessions: [{
        kind: "codex_session",
        id: legacySource.id,
        lastActiveAt: legacySource.lastActiveAt,
        version: 1,
      }],
      importContext: {
        status: "ready",
        summary: "旧摘要",
        currentState: "旧状态",
        historicalStages: [],
        artifacts: [],
        organizedAt: "2026-08-01T01:00:00.000Z",
        error: null,
      } as never,
    });
    const app = createApp({
      store,
      codexSessionProvider: provider(() => ({
        ...baseDiscovery,
        sessions: [legacySource],
      })),
      sessionOrganizer: {
        async organize() {
          return {
            ...singleSourceOrganization,
            completedHighlights: ["完成旧会话整理"],
            nextAction: "生成后续计划",
            historicalStages: singleSourceOrganization.historicalStages.map((stage) => ({
              ...stage,
              sourceSessionIds: [legacySource.id],
            })),
          };
        },
      },
    });

    const response = await app.fetch(new Request(
      `http://teamline.local/api/work-orders/${legacy.id}/import-context/organize`,
      { method: "POST" },
    ));

    expect(response.status).toBe(200);
    expect((await response.json()).workOrder.importContext).toMatchObject({
      status: "ready",
      completedHighlights: ["完成旧会话整理"],
      nextAction: "生成后续计划",
    });
  });

  test("combines multiple source sessions into one unstarted goal without a future plan", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const project = store.createProject("Personal Beta");
    const organizerInputs: unknown[] = [];
    const app = createApp({
      store,
      codexSessionProvider: provider(() => baseDiscovery),
      sessionOrganizer: {
        async organize(input: unknown) {
          organizerInputs.push(input);
          return organized;
        },
      },
    });

    const response = await app.fetch(new Request("http://teamline.local/api/codex-sessions/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "发布 Personal Beta",
        projectId: project.id,
        sessionIds: ["session-a", "session-b"],
      }),
    }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.outcome).toBe("pending");
    expect(store.list()).toHaveLength(1);
    expect(body.workOrder.importContext).toMatchObject({ status: "pending" });
    const ready = await waitForImport(store, body.workOrder.id);
    expect(ready).toMatchObject({
      name: "发布 Personal Beta",
      description: organized.description,
      projectId: project.id,
      workspace: null,
      materials: [],
      plan: null,
      sessionId: null,
      currentSessionId: null,
      status: "draft",
      importContext: {
        status: "ready",
        summary: organized.summary,
        currentState: organized.currentState,
        historicalStages: organized.historicalStages,
        artifacts: organized.artifacts,
        error: null,
      },
    });
    expect(ready.sourceSessions).toEqual([
      expect.objectContaining({ id: "session-a", lastReadAt: expect.any(String) }),
      expect.objectContaining({ id: "session-b", lastReadAt: expect.any(String) }),
    ]);
    expect(JSON.stringify(ready)).not.toContain("session-a.jsonl");
    expect(organizerInputs).toEqual([
      expect.objectContaining({
        name: "发布 Personal Beta",
        sessions: [
          expect.objectContaining({ id: "session-a", sourcePath: "/tmp/codex/session-a.jsonl" }),
          expect.objectContaining({ id: "session-b", sourcePath: "/tmp/codex/session-b.jsonl" }),
        ],
      }),
    ]);
  });

  test("only carries a workspace when every source has the same available path", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const discovery = {
      ...baseDiscovery,
      sessions: baseDiscovery.sessions.map((session) => ({
        ...session,
        workspacePath: "/tmp/shared-project",
        projectLabel: "shared-project",
      })),
    };
    const app = createApp({
      store,
      codexSessionProvider: provider(() => discovery),
      sessionOrganizer: { async organize() { return organized; } },
    });

    const response = await app.fetch(new Request("http://teamline.local/api/codex-sessions/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "整合设置工作", sessionIds: ["session-a", "session-b"] }),
    }));

    expect(response.status).toBe(201);
    const workOrder = (await response.json()).workOrder;
    expect(workOrder.workspace).toEqual({
      kind: "directory",
      path: "/tmp/shared-project",
    });
    await waitForImport(store, workOrder.id);
  });

  test("continues a ready imported goal through the existing plan flow with an optional note", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    let planningInput: ReturnType<WorkOrderStore["get"]> = null;
    const app = createApp({
      store,
      codexSessionProvider: provider(() => baseDiscovery),
      sessionOrganizer: { async organize() { return singleSourceOrganization; } },
      planGenerator: {
        async generate(workOrder) {
          planningInput = workOrder;
          return {
            outcome: "plan",
            message: "后续计划已生成。",
            questions: [],
            stages: [{
              id: "finish-verification",
              outcome: "完成剩余验证",
              scope: "现有成果",
              verification: "检查验证结果",
            }],
          };
        },
      },
    });
    const importedResponse = await app.fetch(new Request(
      "http://teamline.local/api/codex-sessions/import",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "完成设置页", sessionIds: ["session-a"] }),
      },
    ));
    const importedGoal = (await importedResponse.json()).workOrder;
    const imported = await waitForImport(store, importedGoal.id);

    const response = await app.fetch(new Request(
      `http://teamline.local/api/work-orders/${imported.id}/plan/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ continuationNote: "先补齐移动端验证" }),
      },
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(planningInput?.conversation.at(-1)).toMatchObject({
      role: "user",
      content: "先补齐移动端验证",
      decisionTarget: "plan",
    });
    expect(body.workOrder).toMatchObject({
      status: "ready",
      runStatus: null,
      currentSessionId: null,
      sourceSessions: imported.sourceSessions,
      importContext: imported.importContext,
      plan: {
        confirmationRequired: true,
        stages: [expect.objectContaining({ outcome: "完成剩余验证" })],
      },
    });
    expect(body.workOrder.conversation).toContainEqual(expect.objectContaining({
      role: "user",
      content: "先补齐移动端验证",
    }));
  });

  test("keeps a retryable planning goal when initial organization fails", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    let attempts = 0;
    const app = createApp({
      store,
      codexSessionProvider: provider(() => baseDiscovery),
      sessionOrganizer: {
        async organize() {
          attempts += 1;
          if (attempts === 1) throw new Error("Codex 暂时不可用");
          return singleSourceOrganization;
        },
      },
    });

    const imported = await app.fetch(new Request("http://teamline.local/api/codex-sessions/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "整理历史工作", sessionIds: ["session-a"] }),
    }));
    const pending = await imported.json();
    const failedWorkOrder = await waitForImport(store, pending.workOrder.id, "failed");

    expect(imported.status).toBe(201);
    expect(pending.outcome).toBe("pending");
    expect(failedWorkOrder).toMatchObject({
      status: "draft",
      plan: null,
      importContext: {
        status: "failed",
        summary: null,
        error: "Codex 暂时不可用",
      },
    });

    const retried = await app.fetch(new Request(
      `http://teamline.local/api/work-orders/${failedWorkOrder.id}/import-context/organize`,
      { method: "POST" },
    ));
    expect(retried.status).toBe(200);
    expect((await retried.json()).workOrder.importContext).toMatchObject({
      status: "ready",
      summary: organized.summary,
      error: null,
    });
  });

  test("deletes a failed import without deleting the source session", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const app = createApp({
      store,
      codexSessionProvider: provider(() => baseDiscovery),
      sessionOrganizer: { async organize() { throw new Error("整理失败"); } },
    });
    const imported = await app.fetch(new Request("http://teamline.local/api/codex-sessions/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "可以删除", sessionIds: ["session-a"] }),
    }));
    const id = (await imported.json()).workOrder.id;
    await waitForImport(store, id, "failed");

    const deleted = await app.fetch(new Request(`http://teamline.local/api/work-orders/${id}`, {
      method: "DELETE",
    }));

    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true });
    expect(store.get(id)).toBeNull();
    expect(baseDiscovery.sessions.find((session) => session.id === "session-a")?.id).toBe(
      "session-a",
    );
  });

  test("preserves the last successful summary when reorganization fails", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    let shouldFail = false;
    const app = createApp({
      store,
      codexSessionProvider: provider(() => baseDiscovery),
      sessionOrganizer: {
        async organize() {
          if (shouldFail) throw new Error("重新整理失败");
          return singleSourceOrganization;
        },
      },
    });
    const imported = await app.fetch(new Request("http://teamline.local/api/codex-sessions/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "整理历史工作", sessionIds: ["session-a"] }),
    }));
    const id = (await imported.json()).workOrder.id;
    await waitForImport(store, id);
    shouldFail = true;

    const response = await app.fetch(new Request(
      `http://teamline.local/api/work-orders/${id}/import-context/organize`,
      { method: "POST" },
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.outcome).toBe("failed");
    expect(body.workOrder.importContext).toMatchObject({
      status: "ready",
      summary: organized.summary,
      error: "重新整理失败",
    });
  });

  test("reports newer source content without reading or reorganizing it", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    let currentDiscovery = baseDiscovery;
    let organizations = 0;
    const app = createApp({
      store,
      codexSessionProvider: provider(() => currentDiscovery),
      sessionOrganizer: {
        async organize() {
          organizations += 1;
          return singleSourceOrganization;
        },
      },
    });
    const imported = await app.fetch(new Request("http://teamline.local/api/codex-sessions/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "整理历史工作", sessionIds: ["session-a"] }),
    }));
    const id = (await imported.json()).workOrder.id;
    await waitForImport(store, id);
    currentDiscovery = {
      ...baseDiscovery,
      sessions: baseDiscovery.sessions.map((session) => session.id === "session-a"
        ? { ...session, lastActiveAt: "2026-08-04T08:00:00.000Z" }
        : session),
    };

    const response = await app.fetch(new Request(
      `http://teamline.local/api/work-orders/${id}`,
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.sourceStatus).toMatchObject({
      hasUpdates: true,
      sessions: [expect.objectContaining({ id: "session-a", updateAvailable: true })],
    });
    expect(organizations).toBe(1);
  });

  test("validates the whole import before creating the goal", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const unavailable = {
      ...baseDiscovery,
      sessions: [
        ...baseDiscovery.sessions,
        {
          id: "session-gone",
          title: "已移除会话",
          workspacePath: null,
          projectLabel: "来源文件不可用",
          lastActiveAt: "2026-08-01T00:00:00.000Z",
          sourcePath: null,
          availability: "unavailable" as const,
          message: "来源文件不可用",
        },
      ],
    };
    const app = createApp({
      store,
      codexSessionProvider: provider(() => unavailable),
      sessionOrganizer: { async organize() { return organized; } },
    });

    const response = await app.fetch(new Request("http://teamline.local/api/codex-sessions/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "不应创建",
        sessionIds: ["session-a", "session-gone"],
      }),
    }));

    expect(response.status).toBe(400);
    expect(store.list()).toEqual([]);
  });
});
