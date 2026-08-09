import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { WorkOrderStore } from "../src/work-order-store";

describe("work orders", () => {
  test("creates and lists a local work order", () => {
    const store = new WorkOrderStore(new Database(":memory:"));

    const created = store.create({
      repositoryPath: "/tmp/example-repository",
      goal: "为设置页面增加深色模式",
      acceptance: "现有测试保持通过",
    });

    expect(created.status).toBe("draft");
    expect(created.title).toBe("为设置页面增加深色模式");
    expect(store.list()).toEqual([created]);
  });

  test("requires a goal but allows the workspace to be selected later", () => {
    const store = new WorkOrderStore(new Database(":memory:"));

    expect(store.create({ goal: "实现功能" }).workspace).toBeNull();
    expect(() => store.create({ repositoryPath: "/tmp/repo", goal: "" })).toThrow(
      "请描述想完成的工作",
    );
  });

  test("adds the import source column to an existing database", () => {
    const database = new Database(":memory:");
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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    new WorkOrderStore(database);
    const columns = database
      .query<{ name: string }, []>("PRAGMA table_info(work_orders)")
      .all()
      .map((column) => column.name);
    expect(columns).toContain("import_source_json");
  });

  test("migrates the session monitoring cursor columns from the #74 schema", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE session_monitoring_catalog (
        session_key TEXT PRIMARY KEY,
        source_kind TEXT NOT NULL,
        execution_identity_id TEXT,
        execution_identity_label TEXT,
        session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        workspace_path TEXT,
        project_label TEXT NOT NULL,
        last_active_at TEXT NOT NULL,
        source_path TEXT,
        availability TEXT NOT NULL,
        message TEXT,
        project_id TEXT,
        monitoring_enabled INTEGER NOT NULL DEFAULT 0,
        last_discovered_at TEXT NOT NULL,
        last_read_position INTEGER,
        last_read_at TEXT,
        organization_status TEXT NOT NULL DEFAULT 'not_started',
        work_graph_snapshot_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    const store = new WorkOrderStore(database);
    const columns = database
      .query<{ name: string }, []>("PRAGMA table_info(session_monitoring_catalog)")
      .all()
      .map((column) => column.name);
    expect(columns).toContain("source_position");
    expect(columns).toContain("source_modified_at");
    expect(store.upsertDiscoveredSession({
      key: "codex_session:codex-system-default:migrated",
      sourceKind: "codex_session",
      executionIdentityId: "codex-system-default",
      executionIdentityLabel: "Codex",
      id: "migrated",
      title: "已迁移会话",
      workspacePath: null,
      projectLabel: "未知项目",
      lastActiveAt: "2026-08-09T01:00:00.000Z",
      sourcePath: "/tmp/migrated.jsonl",
      sourcePosition: 128,
      sourceModifiedAt: "2026-08-09T01:00:00.000Z",
      availability: "available",
      message: null,
      lastDiscoveredAt: "2026-08-09T01:00:00.000Z",
    })).toMatchObject({ sourcePosition: 128, sourceModifiedAt: "2026-08-09T01:00:00.000Z" });
  });
});
