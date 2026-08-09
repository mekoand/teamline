import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/app";
import { sessionMonitoringKey } from "../src/session-monitoring";
import type { SessionDiscoveryResult, SessionProvider } from "../src/session-discovery";
import { WorkOrderStore } from "../src/work-order-store";

function controlledScheduler() {
  const callbacks = new Set<() => void>();
  return {
    schedule(callback: () => void, _delayMs: number) {
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    async runNext() {
      const callback = callbacks.values().next().value as (() => void) | undefined;
      if (!callback) throw new Error("没有待运行的后台调度");
      callbacks.delete(callback);
      callback();
      await Bun.sleep(0);
    },
    get size() {
      return callbacks.size;
    },
  };
}

function discoveredSession(
  id: string,
  workspacePath: string,
  sourcePath: string,
  modifiedAt = "2026-08-09T01:00:00.000Z",
): SessionDiscoveryResult["sessions"][number] {
  return {
    id,
    title: `会话 ${id}`,
    workspacePath,
    projectLabel: workspacePath.split("/").at(-1) ?? workspacePath,
    lastActiveAt: modifiedAt,
    sourcePath,
    sourcePosition: 0,
    sourceModifiedAt: modifiedAt,
    availability: "available",
    message: null,
  };
}

function provider(discover: () => SessionDiscoveryResult): SessionProvider {
  return { async discover() { return discover(); } };
}

describe("Teamline 3.1 会话监控", () => {
  test("旧 catalog 数据迁移为显式覆盖并保持原有效值", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
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
        source_position INTEGER,
        source_modified_at TEXT,
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
      );
    `);
    const timestamp = "2026-08-09T01:00:00.000Z";
    database.query(`
      INSERT INTO session_monitoring_catalog (
        session_key, source_kind, execution_identity_id, session_id, title,
        project_label, last_active_at, availability, project_id, monitoring_enabled,
        last_discovered_at, created_at, updated_at
      ) VALUES (?, 'codex_session', 'codex-system-default', ?, ?, ?, ?, 'available', NULL, ?, ?, ?, ?)
    `).run(
      "codex_session:codex-system-default:legacy-enabled",
      "legacy-enabled",
      "旧启用会话",
      "旧项目",
      timestamp,
      1,
      timestamp,
      timestamp,
      timestamp,
    );
    const store = new WorkOrderStore(database);
    try {
      const key = "codex_session:codex-system-default:legacy-enabled";
      expect(store.getSessionMonitoring(key)).toMatchObject({
        monitoringEnabled: true,
        monitoringOverride: true,
      });
      expect(store.listSessionMonitoringWorks()).toEqual([
        expect.objectContaining({ sourceSessionKeys: [key] }),
      ]);
      const project = store.createProject("新默认关闭的项目");
      store.updateSessionMonitoring(key, { projectId: project.id });
      store.setProjectMonitoringDefault(project.id, false);
      expect(store.getSessionMonitoring(key)).toMatchObject({
        monitoringEnabled: true,
        monitoringOverride: true,
      });
    } finally {
      database.close();
    }
  });

  test("首次发现确认前只返回候选，不写项目、目录或调用整理模型", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-3-1-onboarding-"));
    const sourcePath = join(root, "session.jsonl");
    writeFileSync(sourcePath, "source\n", "utf8");
    const store = new WorkOrderStore(new Database(":memory:"));
    let organizations = 0;
    const app = createApp({
      store,
      codexSessionProvider: provider(() => ({
        status: "available",
        message: "Codex",
        sessions: [discoveredSession("first", root, sourcePath)],
      })),
      claudeCodeSessionProvider: provider(() => ({
        status: "available",
        message: "Claude Code",
        sessions: [],
      })),
      sessionOrganizer: {
        async organize() {
          organizations += 1;
          throw new Error("不应在确认前调用");
        },
      },
    });

    try {
      const preview = await app.fetch(new Request(
        "http://teamline.local/api/session-monitoring/discover",
        { method: "POST" },
      )).then((response) => response.json());
      expect(preview.onboarding).toBe(true);
      expect(preview.candidates).toHaveLength(1);
      expect(store.listProjects()).toHaveLength(0);
      expect(store.listSessionMonitoring()).toHaveLength(0);
      expect(organizations).toBe(0);

      const confirmed = await app.fetch(new Request(
        "http://teamline.local/api/session-monitoring/onboarding",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projects: [{ candidateKey: preview.candidates[0].key, monitoringEnabled: false }],
            selectedSessionKeys: [preview.sessions[0].key],
          }),
        },
      )).then((response) => response.json());
      expect(confirmed.outcome).toBe("confirmed");
      expect(store.listProjects()).toHaveLength(1);
      expect(store.getSessionMonitoring(preview.sessions[0].key)).toMatchObject({
        monitoringEnabled: false,
        monitoringOverride: null,
      });
      expect(organizations).toBe(0);
    } finally {
      await app.close();
      store.database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("项目默认与会话显式覆盖按固定优先级作用于未来发现", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-3-1-defaults-"));
    const sourceA = join(root, "a.jsonl");
    const sourceB = join(root, "b.jsonl");
    writeFileSync(sourceA, "a\n", "utf8");
    writeFileSync(sourceB, "b\n", "utf8");
    let sessions = [discoveredSession("a", root, sourceA)];
    const scheduler = controlledScheduler();
    const store = new WorkOrderStore(new Database(":memory:"));
    const app = createApp({
      store,
      sessionMonitoringScheduler: scheduler.schedule,
      codexSessionProvider: provider(() => ({ status: "available", message: "Codex", sessions })),
      claudeCodeSessionProvider: provider(() => ({ status: "available", message: "Claude", sessions: [] })),
    });

    try {
      const first = await app.fetch(new Request(
        "http://teamline.local/api/session-monitoring/discover",
        { method: "POST" },
      )).then((response) => response.json());
      const projectResponse = await app.fetch(new Request(
        "http://teamline.local/api/session-monitoring/onboarding",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projects: [{ candidateKey: first.candidates[0].key, monitoringEnabled: true }],
            selectedSessionKeys: [first.sessions[0].key],
          }),
        },
      )).then((response) => response.json());
      const project = projectResponse.projects[0];
      const firstKey = first.sessions[0].key as string;
      expect(store.getSessionMonitoring(firstKey)?.monitoringEnabled).toBe(true);
      await app.fetch(new Request(
        `http://teamline.local/api/session-monitoring/${encodeURIComponent(firstKey)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ monitoringEnabled: false }),
        },
      ));

      sessions = [
        discoveredSession("a", root, sourceA),
        discoveredSession("b", root, sourceB),
      ];
      const discovered = await app.fetch(new Request(
        "http://teamline.local/api/session-monitoring/discover",
        { method: "POST" },
      )).then((response) => response.json());
      const secondKey = sessionMonitoringKey(
        "codex_session",
        store.getSystemExecutionIdentityId(),
        "b",
      );
      expect(discovered.sessions).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: secondKey, projectId: project.id, monitoringEnabled: true, monitoringOverride: null }),
      ]));
      expect(store.getSessionMonitoring(firstKey)?.monitoringOverride).toBe(false);

      await app.fetch(new Request(
        `http://teamline.local/api/projects/${encodeURIComponent(project.id)}/session-monitoring-default`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        },
      ));
      expect(store.getSessionMonitoring(firstKey)?.monitoringEnabled).toBe(false);
      expect(store.getSessionMonitoring(secondKey)?.monitoringEnabled).toBe(false);
      await app.fetch(new Request(
        `http://teamline.local/api/projects/${encodeURIComponent(project.id)}/session-monitoring-default`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        },
      ));
      expect(store.getSessionMonitoring(firstKey)?.monitoringEnabled).toBe(false);
      expect(store.getSessionMonitoring(secondKey)?.monitoringEnabled).toBe(true);
      expect(store.getSessionMonitoring(firstKey)?.monitoringOverride).toBe(false);
      const rediscovered = await app.fetch(new Request(
        "http://teamline.local/api/session-monitoring/discover",
        { method: "POST" },
      )).then((response) => response.json());
      expect(rediscovered.sessions).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: firstKey, monitoringEnabled: false, monitoringOverride: false }),
        expect.objectContaining({ key: secondKey, monitoringEnabled: true, monitoringOverride: null }),
      ]));
    } finally {
      await app.close();
      store.database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("监控工作默认单来源，明确合并后只保存来源边界", () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const first = store.createProject("监控项目");
    const record = (id: string) => store.upsertDiscoveredSession({
      key: `codex_session:${id}`,
      sourceKind: "codex_session",
      executionIdentityId: null,
      executionIdentityLabel: null,
      id,
      title: id,
      workspacePath: "/tmp/monitoring-work",
      projectLabel: "monitoring-work",
      lastActiveAt: "2026-08-09T01:00:00.000Z",
      sourcePath: null,
      availability: "available",
      message: null,
      lastDiscoveredAt: "2026-08-09T01:00:00.000Z",
      projectId: first.id,
    });
    const firstRecord = record("a");
    const secondRecord = record("b");
    const initial = store.listSessionMonitoringWorks();
    expect(initial).toHaveLength(2);
    const merged = store.createSessionMonitoringWork({
      name: "明确合并的工作",
      projectId: first.id,
      sourceSessionKeys: [firstRecord.key, secondRecord.key],
    });
    expect(merged.sourceSessionKeys).toEqual([firstRecord.key, secondRecord.key]);
    expect(store.listSessionMonitoringWorks()).toEqual([
      expect.objectContaining({ id: merged.id, name: "明确合并的工作" }),
    ]);
    const trimmed = store.updateSessionMonitoringWork(merged.id, {
      sourceSessionKeys: [firstRecord.key],
    });
    expect(trimmed.sourceSessionKeys).toEqual([firstRecord.key]);
    expect(store.listSessionMonitoringWorks()).toHaveLength(2);
    expect(store.findSessionMonitoringWorkBySourceKey(firstRecord.key)).toEqual(
      expect.objectContaining({ id: merged.id, sourceSessionKeys: [firstRecord.key] }),
    );
    expect(store.findSessionMonitoringWorkBySourceKey(secondRecord.key)).toEqual(
      expect.objectContaining({ sourceSessionKeys: [secondRecord.key] }),
    );
    const beforeEmptyUpdate = store.listSessionMonitoringWorks();
    expect(() => store.updateSessionMonitoringWork(merged.id, { sourceSessionKeys: [] }))
      .toThrow("请选择至少一个来源会话");
    expect(store.listSessionMonitoringWorks()).toEqual(beforeEmptyUpdate);
    store.database.close();
  });

  test("A/B 项目来源不能跨项目创建、更新或从多来源工作单独移动", () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const projectA = store.createProject("项目 A");
    const projectB = store.createProject("项目 B");
    const record = (id: string, projectId: string, workspacePath: string) => store.upsertDiscoveredSession({
      key: `codex_session:cross-project-${id}`,
      sourceKind: "codex_session",
      executionIdentityId: null,
      executionIdentityLabel: null,
      id,
      title: id,
      workspacePath,
      projectLabel: id,
      lastActiveAt: "2026-08-09T01:00:00.000Z",
      sourcePath: null,
      availability: "available",
      message: null,
      lastDiscoveredAt: "2026-08-09T01:00:00.000Z",
      projectId,
    });
    const sourceA = record("a", projectA.id, "/tmp/monitoring-project-a");
    const sourceB = record("b", projectB.id, "/tmp/monitoring-project-b");
    const beforeCreate = store.listSessionMonitoringWorks();

    expect(() => store.createSessionMonitoringWork({
      name: "跨项目创建",
      projectId: projectA.id,
      sourceSessionKeys: [sourceA.key, sourceB.key],
    })).toThrow("同一个项目");
    expect(store.listSessionMonitoringWorks()).toEqual(beforeCreate);

    const single = store.createSessionMonitoringWork({
      name: "项目 A 单来源",
      projectId: projectA.id,
      sourceSessionKeys: [sourceA.key],
    });
    const beforeSingle = store.getSessionMonitoringWork(single.id);
    expect(() => store.updateSessionMonitoringWork(single.id, {
      projectId: projectB.id,
    })).toThrow("一致");
    expect(() => store.updateSessionMonitoringWork(single.id, {
      sourceSessionKeys: [sourceA.key, sourceB.key],
    })).toThrow("同一个项目");
    expect(store.getSessionMonitoringWork(single.id)).toEqual(beforeSingle);

    const sourceA2 = record("a2", projectA.id, "/tmp/monitoring-project-a-2");
    const multi = store.createSessionMonitoringWork({
      name: "项目 A 多来源",
      projectId: projectA.id,
      sourceSessionKeys: [sourceA.key, sourceA2.key],
    });
    const beforeMoveSource = store.getSessionMonitoring(sourceA.key);
    const beforeMoveWork = store.getSessionMonitoringWork(multi.id);
    expect(() => store.updateSessionMonitoring(sourceA.key, {
      projectId: projectB.id,
    })).toThrow("先解除多来源");
    expect(store.getSessionMonitoring(sourceA.key)).toEqual(beforeMoveSource);
    expect(store.getSessionMonitoringWork(multi.id)).toEqual(beforeMoveWork);
    store.database.close();
  });

  test("监控工作 PATCH 缩减来源后恢复单来源，并拒绝空来源", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const project = store.createProject("监控 API 项目");
    const record = (id: string) => store.upsertDiscoveredSession({
      key: `codex_session:api-${id}`,
      sourceKind: "codex_session",
      executionIdentityId: null,
      executionIdentityLabel: null,
      id,
      title: id,
      workspacePath: "/tmp/monitoring-api-work",
      projectLabel: "monitoring-api-work",
      lastActiveAt: "2026-08-09T01:00:00.000Z",
      sourcePath: null,
      availability: "available",
      message: null,
      lastDiscoveredAt: "2026-08-09T01:00:00.000Z",
      projectId: project.id,
    });
    const first = record("a");
    const second = record("b");
    const merged = store.createSessionMonitoringWork({
      name: "API 合并工作",
      projectId: project.id,
      sourceSessionKeys: [first.key, second.key],
    });
    const app = createApp({ store });
    try {
      const trimmed = await app.fetch(new Request(
        `http://teamline.local/api/session-monitoring/works/${encodeURIComponent(merged.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sourceSessionKeys: [first.key] }),
        },
      ));
      expect(trimmed.status).toBe(200);
      expect(store.listSessionMonitoringWorks()).toHaveLength(2);
      expect(store.findSessionMonitoringWorkBySourceKey(second.key)).toEqual(
        expect.objectContaining({ sourceSessionKeys: [second.key] }),
      );

      const beforeEmptyUpdate = store.listSessionMonitoringWorks();
      const empty = await app.fetch(new Request(
        `http://teamline.local/api/session-monitoring/works/${encodeURIComponent(merged.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sourceSessionKeys: [] }),
        },
      ));
      expect(empty.status).toBe(400);
      expect(store.listSessionMonitoringWorks()).toEqual(beforeEmptyUpdate);
    } finally {
      await app.close();
      store.database.close();
    }
  });

  test("automatic 冷却、manual/deep 绕过且 deep 选择高质量资源", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-3-1-scheduler-"));
    const sourcePath = join(root, "session.jsonl");
    writeFileSync(sourcePath, "one\n", "utf8");
    let content = "one\n";
    let modifiedAt = "2026-08-09T01:00:00.000Z";
    let now = Date.parse("2026-08-09T02:00:00.000Z");
    let organizations = 0;
    const preferences: string[] = [];
    const scheduler = controlledScheduler();
    const store = new WorkOrderStore(new Database(":memory:"));
    const source = () => discoveredSession("scheduled", root, sourcePath, modifiedAt);
    const app = createApp({
      store,
      sessionMonitoringNow: () => now,
      sessionMonitoringScheduler: scheduler.schedule,
      codexSessionProvider: {
        async discover() {
          return { status: "available" as const, message: "Codex", sessions: [source()] };
        },
        async read(_session, fromPosition) {
          const bytes = Buffer.from(content);
          return { content: bytes.subarray(fromPosition).toString("utf8"), nextPosition: bytes.length };
        },
      },
      claudeCodeSessionProvider: provider(() => ({ status: "available", message: "Claude", sessions: [] })),
      sessionOrganizationResourceSelector: {
        async select(request) {
          preferences.push(request.preference);
          return { tool: "codex", model: request.preference, accountId: null, accountLabel: null };
        },
      },
      sessionOrganizer: {
        async organize(input) {
          organizations += 1;
          return { description: "", summary: input.previousSnapshot ? "updated" : "initial", currentState: "state", historicalStages: [], artifacts: [] };
        },
      },
    });

    try {
      const preview = await app.fetch(new Request(
        "http://teamline.local/api/session-monitoring/discover",
        { method: "POST" },
      )).then((response) => response.json());
      const key = preview.sessions[0].key as string;
      await app.fetch(new Request(
        `http://teamline.local/api/session-monitoring/${encodeURIComponent(key)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ monitoringEnabled: true }),
        },
      ));
      await scheduler.runNext();
      while (organizations < 1) await Bun.sleep(1);

      appendFileSync(sourcePath, "two\n", "utf8");
      content += "two\n";
      modifiedAt = "2026-08-09T02:01:00.000Z";
      await scheduler.runNext();
      while (organizations < 2) await Bun.sleep(1);
      const work = store.findSessionMonitoringWorkBySourceKey(key)!;
      expect(work.lastAutomaticCompletedAt).toBe(new Date(now).toISOString());

      appendFileSync(sourcePath, "three\n", "utf8");
      content += "three\n";
      modifiedAt = "2026-08-09T02:02:00.000Z";
      await scheduler.runNext();
      await Bun.sleep(2);
      expect(organizations).toBe(2);
      expect(store.findSessionMonitoringWorkBySourceKey(key)?.pendingRefreshIntent?.mode).toBe("automatic");

      const manual = await app.fetch(new Request(
        "http://teamline.local/api/session-monitoring/refresh",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "manual", sessionKeys: [key] }),
        },
      ));
      expect(manual.status).toBe(200);
      while (organizations < 3) await Bun.sleep(1);
      expect(preferences).toEqual(["low_cost", "low_cost", "low_cost"]);

      appendFileSync(sourcePath, "four\n", "utf8");
      content += "four\n";
      modifiedAt = "2026-08-09T02:03:00.000Z";
      const deep = await app.fetch(new Request(
        "http://teamline.local/api/session-monitoring/refresh",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "deep", sessionKeys: [key] }),
        },
      ));
      expect(deep.status).toBe(200);
      while (organizations < 4) await Bun.sleep(1);
      expect(preferences.at(-1)).toBe("high_quality");
    } finally {
      await app.close();
      store.database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("重启后保留 automatic 待处理意图，并在冷却结束后恢复执行", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-3-1-restart-"));
    const sourcePath = join(root, "session.jsonl");
    const databasePath = join(root, "teamline.sqlite");
    writeFileSync(sourcePath, "one\n", "utf8");
    let content = "one\n";
    let modifiedAt = "2026-08-09T01:00:00.000Z";
    let now = Date.parse("2026-08-09T02:00:00.000Z");
    let organizations = 0;
    const source = () => discoveredSession("restart", root, sourcePath, modifiedAt);
    const makeProvider = () => ({
      async discover() {
        return { status: "available" as const, message: "Codex", sessions: [source()] };
      },
      async read(_session: SessionDiscoveryResult["sessions"][number], fromPosition: number) {
        const bytes = Buffer.from(content);
        return { content: bytes.subarray(fromPosition).toString("utf8"), nextPosition: bytes.length };
      },
    });
    const makeApp = (scheduler: ReturnType<typeof controlledScheduler>, store: WorkOrderStore) => createApp({
      store,
      sessionMonitoringNow: () => now,
      sessionMonitoringScheduler: scheduler.schedule,
      codexSessionProvider: makeProvider(),
      claudeCodeSessionProvider: provider(() => ({ status: "available", message: "Claude", sessions: [] })),
      sessionOrganizationResourceSelector: {
        async select() {
          return { tool: "codex", model: "fast-summary-model", accountId: null, accountLabel: null };
        },
      },
      sessionOrganizer: {
        async organize(input) {
          organizations += 1;
          return {
            description: "",
            summary: input.previousSnapshot ? "updated" : "initial",
            currentState: "state",
            historicalStages: [],
            artifacts: [],
          };
        },
      },
    });

    const scheduler1 = controlledScheduler();
    const store1 = new WorkOrderStore(new Database(databasePath));
    const app1 = makeApp(scheduler1, store1);
    try {
      const preview = await app1.fetch(new Request(
        "http://teamline.local/api/session-monitoring/discover",
        { method: "POST" },
      )).then((response) => response.json());
      const key = preview.sessions[0].key as string;
      await app1.fetch(new Request(
        "http://teamline.local/api/session-monitoring/onboarding",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projects: [{ candidateKey: preview.candidates[0].key, monitoringEnabled: true }],
            selectedSessionKeys: [key],
          }),
        },
      ));
      await scheduler1.runNext();
      while (organizations < 1) await Bun.sleep(1);

      appendFileSync(sourcePath, "two\n", "utf8");
      content += "two\n";
      modifiedAt = "2026-08-09T02:01:00.000Z";
      await scheduler1.runNext();
      while (organizations < 2) await Bun.sleep(1);
      const completedAt = store1.findSessionMonitoringWorkBySourceKey(key)?.lastAutomaticCompletedAt;
      expect(completedAt).toBe(new Date(now).toISOString());

      appendFileSync(sourcePath, "three\n", "utf8");
      content += "three\n";
      modifiedAt = "2026-08-09T02:02:00.000Z";
      await scheduler1.runNext();
      await Bun.sleep(2);
      expect(organizations).toBe(2);
      expect(store1.findSessionMonitoringWorkBySourceKey(key)?.pendingRefreshIntent?.mode).toBe("automatic");
      await app1.close();
      store1.database.close();

      const scheduler2 = controlledScheduler();
      const store2 = new WorkOrderStore(new Database(databasePath));
      const app2 = makeApp(scheduler2, store2);
      try {
        await scheduler2.runNext();
        await Bun.sleep(2);
        expect(organizations).toBe(2);
        now += 5 * 60_000;
        await scheduler2.runNext();
        while (organizations < 3) await Bun.sleep(1);
        expect(store2.findSessionMonitoringWorkBySourceKey(key)?.pendingRefreshIntent).toBeNull();
      } finally {
        await app2.close();
        store2.database.close();
      }
    } finally {
      await app1.close();
      if (store1.database) {
        try { store1.database.close(); } catch { /* already closed */ }
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("多来源聚合只刷新变化来源，并在失败时保留上次聚合结果", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-3-1-aggregate-"));
    const sourcePaths = {
      a: join(root, "a.jsonl"),
      b: join(root, "b.jsonl"),
    };
    writeFileSync(sourcePaths.a, "a-1\n", "utf8");
    writeFileSync(sourcePaths.b, "b-1\n", "utf8");
    const content = { a: "a-1\n", b: "b-1\n" };
    const modifiedAt = {
      a: "2026-08-09T01:00:00.000Z",
      b: "2026-08-09T01:00:00.000Z",
    };
    const organizations: string[] = [];
    const reads: string[] = [];
    let failNext = false;
    const makeSession = (id: "a" | "b") => discoveredSession(
      id,
      root,
      sourcePaths[id],
      modifiedAt[id],
    );
    const providerWithRead: SessionProvider = {
      async discover() {
        return {
          status: "available" as const,
          message: "Codex",
          sessions: [makeSession("a"), makeSession("b")],
        };
      },
      async read(session, fromPosition) {
        const id = session.id as "a" | "b";
        reads.push(`${id}:${fromPosition}`);
        const bytes = Buffer.from(content[id]);
        return {
          content: bytes.subarray(fromPosition).toString("utf8"),
          nextPosition: bytes.length,
        };
      },
    };
    const store = new WorkOrderStore(new Database(":memory:"));
    const app = createApp({
      store,
      codexSessionProvider: providerWithRead,
      claudeCodeSessionProvider: provider(() => ({ status: "available", message: "Claude", sessions: [] })),
      sessionOrganizationResourceSelector: {
        async select() {
          return { tool: "codex", model: "gpt-5.6-luna", accountId: null, accountLabel: null };
        },
      },
      sessionOrganizer: {
        async organize(input) {
          const id = input.sessions[0]?.id as "a" | "b";
          organizations.push(id);
          if (failNext) {
            failNext = false;
            throw new Error("来源整理失败");
          }
          return {
            summary: `${id}-${content[id].trim()}`,
            currentState: `${id} 当前状态`,
            nodes: [{ id: `${id}-current`, outcome: `${id} ${content[id].trim()}`, status: "current", estimatedProgress: id === "a" ? 40 : 60 }],
            enumerablePlan: { completed: id === "a" ? 1 : 2, total: 4 },
            inferredRelations: [],
            historicalStages: [],
            artifacts: [],
          };
        },
      },
    });
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 2_000;
      while (!predicate() && Date.now() < deadline) await Bun.sleep(2);
      expect(predicate()).toBe(true);
    };

    try {
      const preview = await app.fetch(new Request(
        "http://teamline.local/api/session-monitoring/discover",
        { method: "POST" },
      )).then((response) => response.json());
      const keys = preview.sessions.map((session: { key: string }) => session.key);
      await app.fetch(new Request(
        "http://teamline.local/api/session-monitoring/onboarding",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projects: [{ candidateKey: preview.candidates[0].key, monitoringEnabled: true }],
            selectedSessionKeys: keys,
          }),
        },
      ));
      await waitFor(() => organizations.length === 2);
      expect(reads.map((entry) => entry.split(":")[0]).sort()).toEqual(["a", "b"]);

      const firstWork = store.findSessionMonitoringWorkBySourceKey(keys[0])!;
      const mergedResponse = await app.fetch(new Request(
        "http://teamline.local/api/session-monitoring/works",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "多来源工作", sourceSessionKeys: keys }),
        },
      )).then((response) => response.json());
      const workId = mergedResponse.work.id as string;
      expect(workId).not.toBe(firstWork.id);
      expect(mergedResponse.work.aggregateStatus).toBe("ready");
      expect(mergedResponse.work.aggregateSnapshot.nodes.map((node: { sourceSessionKeys: string[] }) => node.sourceSessionKeys[0]).sort()).toEqual(keys.sort());

      content.a += "a-2\n";
      appendFileSync(sourcePaths.a, "a-2\n", "utf8");
      modifiedAt.a = "2026-08-09T02:00:00.000Z";
      await app.fetch(new Request(
        "http://teamline.local/api/session-monitoring/discover",
        { method: "POST" },
      ));
      await waitFor(() => organizations.length === 3);
      expect(reads.filter((entry) => entry.startsWith("b:"))).toHaveLength(1);
      const refreshed = store.getSessionMonitoringWork(workId)!;
      expect(refreshed.aggregateSnapshot).toMatchObject({
        nodes: expect.arrayContaining([
          expect.objectContaining({ outcome: "a a-1\na-2" }),
          expect.objectContaining({ outcome: "b b-1" }),
        ]),
      });

      content.a += "a-3\n";
      appendFileSync(sourcePaths.a, "a-3\n", "utf8");
      modifiedAt.a = "2026-08-09T02:01:00.000Z";
      await app.fetch(new Request(
        "http://teamline.local/api/session-monitoring/discover",
        { method: "POST" },
      ));
      await waitFor(() => store.findSessionMonitoringWorkBySourceKey(keys[0])?.pendingRefreshIntent?.mode === "automatic");
      failNext = true;
      await app.fetch(new Request(
        "http://teamline.local/api/session-monitoring/refresh",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "manual", workId }),
        },
      ));
      await waitFor(() => organizations.length === 4);
      const failedWork = store.getSessionMonitoringWork(workId)!;
      expect(failedWork.aggregateStatus).toBe("failed");
      expect(failedWork.aggregateSnapshot).toMatchObject({
        nodes: expect.arrayContaining([
          expect.objectContaining({ outcome: "a a-1\na-2" }),
          expect.objectContaining({ outcome: "b b-1" }),
        ]),
      });
    } finally {
      await app.close();
      store.database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
