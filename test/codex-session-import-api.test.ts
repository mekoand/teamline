import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import type {
  CodexSessionDiscoveryResult,
  CodexSessionProvider,
} from "../src/codex-session-discovery";
import { WorkOrderStore } from "../src/work-order-store";

function provider(result: CodexSessionDiscoveryResult): CodexSessionProvider {
  return { async discover() { return result; } };
}

const discovery: CodexSessionDiscoveryResult = {
  status: "partial",
  message: "部分会话信息不可用",
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
      workspacePath: null,
      projectLabel: "文件夹不可用",
      lastActiveAt: "2026-08-03T01:00:00.000Z",
      sourcePath: "/tmp/codex/session-b.jsonl",
      availability: "degraded",
      message: "文件夹不可用",
    },
    {
      id: "session-gone",
      title: "已经移除的会话",
      workspacePath: null,
      projectLabel: "来源文件不可用",
      lastActiveAt: "2026-08-02T01:00:00.000Z",
      sourcePath: null,
      availability: "unavailable",
      message: "来源文件不可用",
    },
  ],
};

const sessionOrganizer = {
  async organize() {
    return {
      description: "完成设置页面重构",
      summary: "设置页面已经完成主要重构",
      currentState: "等待确认后续验证",
      historicalStages: [{
        id: "refactor",
        outcome: "重构设置页面",
        summary: "主要结构已经调整",
        status: "completed" as const,
        sourceSessionIds: ["session-a"],
      }],
      artifacts: [],
    };
  },
};

describe("Codex session import API", () => {
  test("lists searchable metadata without exposing the source file path", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    store.create({ goal: "现有设置工作", materials: [{ kind: "folder", value: "/tmp/project-a" }] });
    const app = createApp({ store, codexSessionProvider: provider(discovery) });

    const response = await app.fetch(new Request("http://teamline.local/api/codex-sessions?q=project-a"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({
      id: "session-a",
      title: "设置页面重构",
      projectLabel: "project-a",
      importedWorkOrderId: null,
      suggestion: { title: "现有设置工作" },
    });
    expect(JSON.stringify(body)).not.toContain("/tmp/codex/session-a.jsonl");
  });

  test("imports only selected sessions as one unstarted goal without a future execution plan", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    let starts = 0;
    const app = createApp({
      store,
      codexSessionProvider: provider(discovery),
      sessionOrganizer,
      codexRunner: {
        async start() { starts += 1; throw new Error("must not start"); },
        async resume() { throw new Error("must not resume"); },
      },
    });

    const response = await app.fetch(
      new Request("http://teamline.local/api/codex-sessions/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "完成设置页面重构",
          sessionIds: ["session-a"],
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.outcome).toBe("ready");
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]).toMatchObject({
      name: "完成设置页面重构",
      importSource: {
        kind: "codex_session",
        id: "session-a",
        lastActiveAt: "2026-08-03T02:00:00.000Z",
        version: 1,
      },
      workspace: { kind: "directory", path: "/tmp/project-a" },
      status: "draft",
      runStatus: null,
      sessionId: null,
      plan: null,
      importContext: {
        status: "ready",
        summary: "设置页面已经完成主要重构",
      },
    });
    expect(store.list()[0]?.materials).toEqual([]);
    expect(store.list().some((workOrder) => workOrder.title.includes("产品文档"))).toBe(false);
    expect(starts).toBe(0);
  });

  test("does not duplicate a session that was already imported", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const app = createApp({ store, codexSessionProvider: provider(discovery), sessionOrganizer });
    const request = () =>
      app.fetch(new Request("http://teamline.local/api/codex-sessions/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "完成设置页面重构", sessionIds: ["session-a"] }),
      }));

    expect((await request()).status).toBe(201);
    const second = await request();
    const body = await second.json();

    expect(second.status).toBe(400);
    expect(body.error).toContain("已经属于目标");
    expect(store.list()).toHaveLength(1);
  });

  test("recognizes a session imported as the second source of a goal", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const goal = store.create({
      name: "合并历史上下文",
      description: "从多个会话整理目标",
      sourceSessions: [
        {
          kind: "codex_session",
          id: "session-a",
          lastActiveAt: "2026-08-03T02:00:00.000Z",
          version: 1,
        },
        {
          kind: "codex_session",
          id: "session-b",
          lastActiveAt: "2026-08-03T01:00:00.000Z",
          version: 1,
        },
      ],
    });
    const app = createApp({ store, codexSessionProvider: provider(discovery), sessionOrganizer });

    const response = await app.fetch(
      new Request("http://teamline.local/api/codex-sessions?q=session-b"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.sessions).toEqual([
      expect.objectContaining({ id: "session-b", importedWorkOrderId: goal.id }),
    ]);
  });

  test("does not mistake a manually added file material for an imported session", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const manual = store.create({
      goal: "手工整理会话记录",
      materials: [{ kind: "file", value: "/tmp/codex/session-a.jsonl" }],
    });
    const app = createApp({ store, codexSessionProvider: provider(discovery) });

    const listResponse = await app.fetch(
      new Request("http://teamline.local/api/codex-sessions?q=session-a"),
    );
    expect((await listResponse.json()).sessions[0].importedWorkOrderId).toBeNull();

    const response = await app.fetch(
      new Request("http://teamline.local/api/codex-sessions/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "完成设置页面重构", sessionIds: ["session-a"] }),
      }),
    );

    expect(response.status).toBe(201);
    expect(store.list()).toHaveLength(2);
    expect(store.get(manual.id)?.importSource).toBeNull();
    expect(store.list().find((workOrder) => workOrder.id !== manual.id)?.importSource?.id).toBe(
      "session-a",
    );
  });

  test("keeps the stable import source after reopening SQLite", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-import-source-"));
    const databasePath = join(directory, "teamline.db");
    try {
      const firstDatabase = new Database(databasePath, { create: true });
      const firstStore = new WorkOrderStore(firstDatabase);
      const app = createApp({
        store: firstStore,
        codexSessionProvider: provider(discovery),
        sessionOrganizer,
      });
      const response = await app.fetch(
        new Request("http://teamline.local/api/codex-sessions/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "完成设置页面重构", sessionIds: ["session-a"] }),
        }),
      );
      expect(response.status).toBe(201);
      const workOrderId = (await response.json()).workOrder.id;
      firstDatabase.close();

      const reopenedDatabase = new Database(databasePath);
      const reopened = new WorkOrderStore(reopenedDatabase).get(workOrderId);
      expect(reopened?.importSource).toEqual({
        kind: "codex_session",
        id: "session-a",
        lastActiveAt: "2026-08-03T02:00:00.000Z",
        lastReadAt: expect.any(String),
        version: 1,
      });
      reopenedDatabase.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects unavailable sessions before writing anything", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const app = createApp({ store, codexSessionProvider: provider(discovery), sessionOrganizer });

    const response = await app.fetch(
      new Request("http://teamline.local/api/codex-sessions/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "继续工作", sessionIds: ["session-gone"] }),
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("INVALID_CODEX_SESSION_IMPORT");
    expect(body.error).toContain("来源文件不可用");
    expect(store.list()).toEqual([]);
  });
});
