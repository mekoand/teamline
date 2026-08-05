import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp } from "../src/app";
import { WorkOrderStore } from "../src/work-order-store";
import { LocalWorkOrderResultProcessor } from "../src/result-processor";
import { join, resolve } from "node:path";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";

async function* noEvents() {}

async function waitFor(condition: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(2);
  }
}

describe("material work orders API", () => {
  test("creates a work order from its goal without requiring a workspace", async () => {
    const app = createApp({ store: new WorkOrderStore(new Database(":memory:")) });

    const response = await app.fetch(
      new Request("http://teamline.local/api/work-orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal: "整理一份竞品研究摘要" }),
      }),
    );
    const { workOrder } = await response.json();

    expect(response.status).toBe(201);
    expect(workOrder).toMatchObject({
      goal: "整理一份竞品研究摘要",
      workspace: null,
      materials: [],
      status: "draft",
    });
  });

  test("asks for a local folder only when a workspace-free work order is started", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const app = createApp({
      store,
      codexRunner: {
        async start() {
          throw new Error("Codex must not start without a workspace");
        },
        async resume() {
          throw new Error("not used");
        },
      },
    });
    const created = store.create({ goal: "整理一份竞品研究摘要" });
    store.savePlan(created.id, [
      {
        outcome: "形成竞品摘要",
        scope: "研究材料与摘要文档",
        verification: "人工检查摘要结构",
      },
    ]);

    const response = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/start`, {
        method: "POST",
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "WORKSPACE_REQUIRED",
      error: "请选择一个本地文件夹作为执行工作空间",
    });
  });

  test("generates and confirms a plan before any execution workspace is selected", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const plannedMaterials: unknown[] = [];
    const app = createApp({
      store,
      planGenerator: {
        async generate(workOrder) {
          plannedMaterials.push(workOrder.materials);
          return {
            stages: [
              {
                outcome: "形成竞品摘要",
                scope: "研究材料与摘要文档",
                verification: "人工检查摘要结构",
              },
            ],
          };
        },
      },
    });
    const created = store.create({
      goal: "整理竞品摘要",
      materials: [{ kind: "link", value: "https://example.test/reference" }],
    });

    const response = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/plan/generate`, {
        method: "POST",
      }),
    );
    const { workOrder } = await response.json();

    expect(response.status).toBe(200);
    expect(workOrder).toMatchObject({
      status: "ready",
      workspace: null,
      plan: {
        version: 1,
        stages: [
          {
            outcome: "形成竞品摘要",
            workspace: { kind: "git", path: null },
          },
        ],
      },
    });
    expect(plannedMaterials).toEqual([
      [{ id: expect.any(String), kind: "link", value: "https://example.test/reference" }],
    ]);
  });

  test("keeps repository, folder, file, image, and link materials with the work order", async () => {
    const repositoryPath = resolve(import.meta.dir, "..");
    const store = new WorkOrderStore(new Database(":memory:"));
    const app = createApp({ store });
    const materials = [
      { kind: "repository", value: repositoryPath },
      { kind: "folder", value: "/tmp/research-notes" },
      { kind: "file", value: "/tmp/brief.pdf" },
      { kind: "image", value: "/tmp/reference.png" },
      { kind: "link", value: "https://example.test/brief" },
    ];

    const response = await app.fetch(
      new Request("http://teamline.local/api/work-orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal: "根据素材整理方案", materials }),
      }),
    );
    const { workOrder } = await response.json();
    const detail = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${workOrder.id}`),
    );
    const persisted = (await detail.json()).workOrder;

    expect(response.status).toBe(201);
    expect(persisted.workspace).toBeNull();
    expect(persisted.repositoryPath).toBe("");
    expect(persisted.materials).toEqual(
      materials.map((material) => ({ ...material, id: expect.any(String) })),
    );
  });

  test("reopens all five material kinds and an explicitly selected workspace from SQLite", () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-material-reopen-"));
    const databasePath = join(directory, "teamline.db");
    const workspacePath = realpathSync(directory);
    const materials = [
      { kind: "repository" as const, value: "/tmp/reference-repository" },
      { kind: "folder" as const, value: "/tmp/reference-folder" },
      { kind: "file" as const, value: "/tmp/reference-file.md" },
      { kind: "image" as const, value: "/tmp/reference-image.png" },
      { kind: "link" as const, value: "https://example.test/reference" },
    ];

    try {
      const firstDatabase = new Database(databasePath, { create: true });
      const firstStore = new WorkOrderStore(firstDatabase);
      const created = firstStore.create({ goal: "持久化素材", materials });
      firstStore.saveWorkspace(created.id, {
        kind: "directory",
        path: workspacePath,
      });
      firstDatabase.close();

      const reopenedDatabase = new Database(databasePath);
      const reopened = new WorkOrderStore(reopenedDatabase).get(created.id);

      expect(reopened).toMatchObject({
        workspace: { kind: "directory", path: workspacePath },
        repositoryPath: workspacePath,
      });
      expect(reopened?.materials).toEqual(
        materials.map((material) => ({ ...material, id: expect.any(String) })),
      );
      reopenedDatabase.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("backfills legacy repository workspaces idempotently on every reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-workspace-backfill-"));
    const databasePath = join(directory, "teamline.db");
    try {
      const database = new Database(databasePath, { create: true });
      const store = new WorkOrderStore(database);
      const created = store.create({ goal: "待回填的旧目标" });
      database
        .query("UPDATE work_orders SET repository_path = ?, workspace_kind = NULL WHERE id = ?")
        .run("/tmp/legacy-repository", created.id);
      database.close();

      const firstReopen = new Database(databasePath);
      expect(new WorkOrderStore(firstReopen).get(created.id)?.workspace).toEqual({
        kind: "git",
        path: "/tmp/legacy-repository",
      });
      firstReopen
        .query("UPDATE work_orders SET workspace_kind = NULL WHERE id = ?")
        .run(created.id);
      firstReopen.close();

      const secondReopen = new Database(databasePath);
      expect(new WorkOrderStore(secondReopen).get(created.id)?.workspace).toEqual({
        kind: "git",
        path: "/tmp/legacy-repository",
      });
      secondReopen.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("synchronizes a delayed directory choice into plan nodes and SQLite", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-plan-workspace-sync-"));
    const databasePath = join(directory, "teamline.db");
    const workspacePath = join(directory, "workspace");
    mkdirSync(workspacePath);
    try {
      const firstDatabase = new Database(databasePath, { create: true });
      const firstStore = new WorkOrderStore(firstDatabase);
      const app = createApp({ store: firstStore });
      const created = firstStore.create({ goal: "整理本地材料" });
      firstStore.savePlan(created.id, [
        {
          outcome: "材料已经整理",
          scope: "本地文件夹",
          verification: "人工检查目录",
        },
      ]);
      expect(firstStore.get(created.id)?.plan?.stages[0]?.workspace).toEqual({
        kind: "git",
        path: null,
      });

      const response = await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${created.id}/workspace`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: workspacePath }),
        }),
      );
      const selected = (await response.json()).workOrder;
      const canonicalPath = realpathSync(workspacePath);
      expect(response.status).toBe(200);
      expect(selected.plan.stages[0].workspace).toEqual({
        kind: "directory",
        path: canonicalPath,
      });
      firstDatabase.close();

      const reopenedDatabase = new Database(databasePath);
      expect(
        new WorkOrderStore(reopenedDatabase).get(created.id)?.plan?.stages[0]
          ?.workspace,
      ).toEqual({ kind: "directory", path: canonicalPath });
      reopenedDatabase.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("runs in an explicitly selected ordinary folder without creating a Git worktree", async () => {
    const workspacePath = mkdtempSync(`${tmpdir()}/teamline-directory-workspace-`);
    try {
      const store = new WorkOrderStore(new Database(":memory:"));
      const starts: string[] = [];
      const app = createApp({
        store,
        codexRunner: {
          async start({ workspacePath }) {
            starts.push(workspacePath);
            return { events: noEvents() };
          },
          async resume() {
            throw new Error("not used");
          },
        },
        worktreeManager: {
          async prepare() {
            throw new Error("ordinary folders must not create worktrees");
          },
        },
      });
      const created = store.create({
        goal: "整理本地文档",
        materials: [{ kind: "folder", value: workspacePath }],
      });
      store.savePlan(created.id, [
        {
          outcome: "文档结构已经整理",
          scope: "本地文档",
          verification: "人工检查目录结构",
        },
      ]);

      const selectResponse = await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${created.id}/workspace`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: workspacePath }),
        }),
      );
      const startResponse = await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${created.id}/start`, {
          method: "POST",
        }),
      );
      const { workOrder } = await startResponse.json();

      expect(selectResponse.status).toBe(200);
      expect(startResponse.status).toBe(200);
      const canonicalPath = realpathSync(workspacePath);
      expect(workOrder.workspace).toEqual({ kind: "directory", path: canonicalPath });
      expect(workOrder.worktreePath).toBe(canonicalPath);
      expect(starts).toEqual([canonicalPath]);
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  test("runs two distinct ordinary folders in parallel", async () => {
    const firstPath = mkdtempSync(`${tmpdir()}/teamline-directory-parallel-a-`);
    const secondPath = mkdtempSync(`${tmpdir()}/teamline-directory-parallel-b-`);
    try {
      const store = new WorkOrderStore(new Database(":memory:"));
      const starts: string[] = [];
      const app = createApp({
        store,
        codexRunner: {
          async start({ workspacePath }) {
            starts.push(workspacePath);
            return { events: noEvents() };
          },
          async resume() {
            throw new Error("not used");
          },
        },
        worktreeManager: {
          async prepare() {
            throw new Error("ordinary folders must not create worktrees");
          },
        },
      });
      const orders = [firstPath, secondPath].map((path, index) => {
        const created = store.create({
          goal: `整理本地文档 ${index + 1}`,
          workspace: { kind: "directory", path: realpathSync(path) },
        });
        store.savePlan(created.id, [
          {
            outcome: "文档已经整理",
            scope: path,
            verification: "人工检查目录",
          },
        ]);
        return created;
      });

      const responses = await Promise.all(
        orders.map((order) =>
          app.fetch(
            new Request(`http://teamline.local/api/work-orders/${order.id}/start`, {
              method: "POST",
            }),
          ),
        ),
      );

      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect(starts.sort()).toEqual(
        [realpathSync(firstPath), realpathSync(secondPath)].sort(),
      );
      expect(store.activeRunIds()).toHaveLength(2);
    } finally {
      rmSync(firstPath, { recursive: true, force: true });
      rmSync(secondPath, { recursive: true, force: true });
    }
  });

  test("collects verification results after a run in an ordinary folder", async () => {
    const workspacePath = mkdtempSync(`${tmpdir()}/teamline-directory-result-`);
    try {
      const store = new WorkOrderStore(new Database(":memory:"));
      const app = createApp({
        store,
        codexRunner: {
          async start() {
            return {
              events: (async function* () {
                yield {
                  type: "exit" as const,
                  exitCode: 0,
                  message: "Codex 已正常结束，等待结果处理",
                };
              })(),
            };
          },
          async resume() {
            throw new Error("not used");
          },
        },
        resultProcessor: new LocalWorkOrderResultProcessor(),
      });
      const created = store.create({
        goal: "整理本地文档",
        workspace: { kind: "directory", path: realpathSync(workspacePath) },
      });
      store.savePlan(created.id, [
        {
          outcome: "文档结构已经整理",
          scope: "本地文档",
          verification: "确认工作空间可读取",
          verificationCommand: "test -d .",
        },
      ]);

      const response = await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${created.id}/start`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(200);
      await waitFor(() => store.get(created.id)?.status !== "running");

      expect(store.get(created.id)).toMatchObject({
        status: "review",
        result: {
          git: {
            diffStat: "普通文件夹不提供 Git 变化统计",
            statusShort: "结果保留在所选本地文件夹中",
          },
          verifications: [{ status: "passed", exitCode: 0 }],
        },
      });
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  test("returns an actionable error when the selected folder is missing", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const app = createApp({ store });
    const created = store.create({ goal: "整理本地文档" });

    const response = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/workspace`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/tmp/teamline-folder-that-does-not-exist" }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "WORKSPACE_NOT_FOUND",
      error: "这个文件夹不存在，请重新选择一个本地文件夹",
    });
  });

  test("distinguishes a file path from a folder without read-write-enter permission", async () => {
    const fixture = mkdtempSync(`${tmpdir()}/teamline-invalid-workspaces-`);
    const filePath = join(fixture, "brief.txt");
    const lockedPath = join(fixture, "locked");
    writeFileSync(filePath, "brief");
    mkdirSync(lockedPath);
    chmodSync(lockedPath, 0o600);
    try {
      const store = new WorkOrderStore(new Database(":memory:"));
      const app = createApp({ store });
      const fileOrder = store.create({ goal: "整理文档" });
      const lockedOrder = store.create({ goal: "整理另一份文档" });

      const fileResponse = await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${fileOrder.id}/workspace`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: filePath }),
        }),
      );
      const lockedResponse = await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${lockedOrder.id}/workspace`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: lockedPath }),
        }),
      );

      expect(await fileResponse.json()).toEqual({
        code: "WORKSPACE_NOT_DIRECTORY",
        error: "所选路径不是文件夹，请重新选择",
      });
      expect(await lockedResponse.json()).toEqual({
        code: "WORKSPACE_PERMISSION_DENIED",
        error: "Teamline 无法读写或进入这个文件夹，请调整权限或选择其他文件夹",
      });
    } finally {
      chmodSync(lockedPath, 0o700);
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("does not assign an ordinary folder held by another active execution", async () => {
    const fixture = mkdtempSync(`${tmpdir()}/teamline-busy-workspace-`);
    const workspacePath = join(fixture, "workspace");
    const workspaceAlias = join(fixture, "workspace-alias");
    mkdirSync(workspacePath);
    symlinkSync(workspacePath, workspaceAlias);
    try {
      const store = new WorkOrderStore(new Database(":memory:"));
      const app = createApp({ store });
      const active = store.create({
        goal: "正在整理文档",
        workspace: { kind: "directory", path: realpathSync(workspacePath) },
      });
      store.savePlan(active.id, [
        { outcome: "整理完成", scope: "文档", verification: "人工检查" },
      ]);
      store.markStarted(active.id);
      const waiting = store.create({ goal: "另一项文档工作" });

      const response = await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${waiting.id}/workspace`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: workspaceAlias }),
        }),
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        code: "WORKSPACE_IN_USE",
        error: "这个文件夹正在被另一个目标使用，请等待其结束或选择其他文件夹",
      });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("rechecks canonical directory ownership before both start and continue", async () => {
    const fixture = mkdtempSync(`${tmpdir()}/teamline-workspace-race-`);
    const workspacePath = join(fixture, "workspace");
    const workspaceAlias = join(fixture, "workspace-alias");
    mkdirSync(workspacePath);
    symlinkSync(workspacePath, workspaceAlias);
    try {
      const store = new WorkOrderStore(new Database(":memory:"));
      const app = createApp({
        store,
        codexRunner: {
          async start() {
            throw new Error("occupied workspace must not start");
          },
          async resume() {
            throw new Error("occupied workspace must not resume");
          },
        },
      });
      const waiting = store.create({
        goal: "等待执行",
        workspace: { kind: "directory", path: workspaceAlias },
      });
      store.savePlan(waiting.id, [
        { outcome: "完成", scope: "文档", verification: "人工检查" },
      ]);
      const active = store.create({
        goal: "正在执行",
        workspace: { kind: "directory", path: workspacePath },
      });
      store.savePlan(active.id, [
        { outcome: "完成", scope: "文档", verification: "人工检查" },
      ]);
      store.bindExecutionIdentity(active.id);
      store.saveDirectWorkspace(active.id, realpathSync(workspacePath));
      store.markStarted(active.id);

      const startResponse = await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${waiting.id}/start`, {
          method: "POST",
        }),
      );
      expect(startResponse.status).toBe(409);
      expect(await startResponse.json()).toMatchObject({ code: "WORKSPACE_IN_USE" });

      store.saveDirectWorkspace(waiting.id, workspaceAlias);
      store.bindExecutionIdentity(waiting.id);
      store.markStarted(waiting.id);
      store.recordInterrupted(waiting.id);
      const continueResponse = await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${waiting.id}/continue`, {
          method: "POST",
        }),
      );
      expect(continueResponse.status).toBe(409);
      expect(await continueResponse.json()).toMatchObject({
        code: "WORKSPACE_IN_USE",
      });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("revalidates an ordinary directory before continue and returns an actionable error", async () => {
    const workspacePath = mkdtempSync(`${tmpdir()}/teamline-continue-workspace-`);
    const store = new WorkOrderStore(new Database(":memory:"));
    const app = createApp({
      store,
      codexRunner: {
        async start() {
          throw new Error("must not start with an invalid continuation workspace");
        },
        async resume() {
          throw new Error("must not resume with an invalid continuation workspace");
        },
      },
    });
    const created = store.create({
      goal: "继续整理本地文档",
      workspace: { kind: "directory", path: realpathSync(workspacePath) },
    });
    store.savePlan(created.id, [
      { outcome: "整理完成", scope: "文档", verification: "人工检查" },
    ]);
    store.saveDirectWorkspace(created.id, realpathSync(workspacePath));
    store.markStarted(created.id);
    store.recordInterrupted(created.id);
    rmSync(workspacePath, { recursive: true, force: true });

    const response = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/continue`, {
        method: "POST",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "WORKSPACE_NOT_FOUND",
      error: "这个文件夹不存在，请重新选择一个本地文件夹",
    });
  });
});
