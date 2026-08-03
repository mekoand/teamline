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
});
