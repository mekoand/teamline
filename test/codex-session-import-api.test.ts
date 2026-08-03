import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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

  test("imports only selected sessions as unstarted work orders with a draft execution map", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    let starts = 0;
    const app = createApp({
      store,
      codexSessionProvider: provider(discovery),
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
          sessions: [{ id: "session-a", goal: "完成设置页面重构" }],
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.imported).toHaveLength(1);
    expect(body.existing).toEqual([]);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]).toMatchObject({
      goal: "完成设置页面重构",
      workspace: null,
      status: "ready",
      runStatus: null,
      sessionId: null,
      plan: {
        version: 1,
        stages: [{ outcome: "完成设置页面重构", status: "planning" }],
      },
    });
    expect(store.list()[0]?.materials).toEqual([
      { id: expect.any(String), kind: "folder", value: "/tmp/project-a" },
      { id: expect.any(String), kind: "file", value: "/tmp/codex/session-a.jsonl" },
    ]);
    expect(store.list().some((workOrder) => workOrder.title.includes("产品文档"))).toBe(false);
    expect(starts).toBe(0);
  });

  test("does not duplicate a session that was already imported", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const app = createApp({ store, codexSessionProvider: provider(discovery) });
    const request = () =>
      app.fetch(new Request("http://teamline.local/api/codex-sessions/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessions: [{ id: "session-a", goal: "完成设置页面重构" }] }),
      }));

    expect((await request()).status).toBe(201);
    const second = await request();
    const body = await second.json();

    expect(second.status).toBe(201);
    expect(body.imported).toEqual([]);
    expect(body.existing).toHaveLength(1);
    expect(store.list()).toHaveLength(1);
  });

  test("rejects unavailable sessions before writing anything", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const app = createApp({ store, codexSessionProvider: provider(discovery) });

    const response = await app.fetch(
      new Request("http://teamline.local/api/codex-sessions/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessions: [{ id: "session-gone", goal: "继续工作" }] }),
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("来源文件不可用");
    expect(store.list()).toEqual([]);
  });
});
