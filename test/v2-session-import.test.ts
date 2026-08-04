import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp } from "../src/app";
import type {
  CodexSessionDiscoveryResult,
  CodexSessionProvider,
} from "../src/codex-session-discovery";
import { WorkOrderStore } from "../src/work-order-store";

function provider(read: () => CodexSessionDiscoveryResult): CodexSessionProvider {
  return { async discover() { return read(); } };
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
    expect(body.outcome).toBe("ready");
    expect(store.list()).toHaveLength(1);
    expect(body.workOrder).toMatchObject({
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
    expect(body.workOrder.sourceSessions).toEqual([
      expect.objectContaining({ id: "session-a", lastReadAt: expect.any(String) }),
      expect.objectContaining({ id: "session-b", lastReadAt: expect.any(String) }),
    ]);
    expect(JSON.stringify(body.workOrder)).not.toContain("session-a.jsonl");
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
    expect((await response.json()).workOrder.workspace).toEqual({
      kind: "directory",
      path: "/tmp/shared-project",
    });
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
    const failed = await imported.json();

    expect(imported.status).toBe(201);
    expect(failed.outcome).toBe("failed");
    expect(failed.workOrder).toMatchObject({
      status: "draft",
      plan: null,
      importContext: {
        status: "failed",
        summary: null,
        error: "Codex 暂时不可用",
      },
    });

    const retried = await app.fetch(new Request(
      `http://teamline.local/api/work-orders/${failed.workOrder.id}/import-context/organize`,
      { method: "POST" },
    ));
    expect(retried.status).toBe(200);
    expect((await retried.json()).workOrder.importContext).toMatchObject({
      status: "ready",
      summary: organized.summary,
      error: null,
    });
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
          return organized;
        },
      },
    });
    const imported = await app.fetch(new Request("http://teamline.local/api/codex-sessions/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "整理历史工作", sessionIds: ["session-a"] }),
    }));
    const id = (await imported.json()).workOrder.id;
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
