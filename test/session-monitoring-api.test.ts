import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { sessionMonitoringKey } from "../src/session-monitoring";
import type { SessionDiscoveryResult, SessionProvider } from "../src/session-discovery";
import { WorkOrderStore } from "../src/work-order-store";

function provider(read: () => SessionDiscoveryResult): SessionProvider {
  return { async discover() { return read(); } };
}

function session(id: string, title: string, workspacePath: string): SessionDiscoveryResult["sessions"][number] {
  return {
    id,
    title,
    workspacePath,
    projectLabel: workspacePath.split("/").at(-1) ?? workspacePath,
    lastActiveAt: "2026-08-09T01:00:00.000Z",
    sourcePath: `/tmp/sessions/${id}.jsonl`,
    availability: "available",
    message: null,
  };
}

describe("session monitoring catalog", () => {
  test("serves a separate monitoring mode with project-preserving navigation", async () => {
    const app = createApp({ store: new WorkOrderStore(new Database(":memory:")) });
    const [page, script, styles, monitoringPage] = await Promise.all([
      app.fetch(new Request("http://teamline.local/")).then((response) => response.text()),
      app.fetch(new Request("http://teamline.local/app.js")).then((response) => response.text()),
      app.fetch(new Request("http://teamline.local/styles.css")).then((response) => response.text()),
      app.fetch(new Request("http://teamline.local/session-monitoring")),
    ]);

    expect(monitoringPage.status).toBe(200);
    expect(page).toContain('id="open-execution-mode"');
    expect(page).toContain('id="open-monitoring-mode"');
    expect(script).toContain('"/api/session-monitoring/discover"');
    expect(script).toContain("currentProjectIdForModeSwitch");
    expect(script).toContain('"/session-monitoring"');
    expect(script).toContain("data-session-monitoring-toggle");
    expect(script).toContain("未归类");
    expect(styles).toContain(".sidebar-bottom");
    expect(styles).toContain(".session-monitoring-card");
  });

  test("scans Codex accounts and Claude Code without creating goals", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const systemIdentity = store.getSystemExecutionIdentityId()!;
    const alternateIdentity = store.createManagedExecutionIdentity({
      id: "codex-alt",
      label: "工作账号",
      managedHomePath: "/tmp/codex-alt",
    });
    const app = createApp({
      store,
      codexSessionProviderForIdentity(identity) {
        if (identity.id === alternateIdentity.id) {
          return provider(() => ({
            status: "available",
            message: "alternate Codex",
            sessions: [session("shared-id", "工作账号会话", "/tmp/alt-project")],
          }));
        }
        return provider(() => ({
          status: "available",
          message: "system Codex",
          sessions: [session("shared-id", "个人账号会话", "/tmp/personal-project")],
        }));
      },
      claudeCodeSessionProvider: provider(() => ({
        status: "available",
        message: "Claude Code",
        sessions: [session("shared-id", "Claude 会话", "/tmp/claude-project")],
      })),
    });

    const response = await app.fetch(new Request(
      "http://teamline.local/api/session-monitoring/discover",
      { method: "POST" },
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.sessions).toHaveLength(3);
    expect(body.sessions[0].sourcePath).toBeUndefined();
    expect(body.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceKind: "codex_session", executionIdentityId: systemIdentity }),
      expect.objectContaining({ sourceKind: "codex_session", executionIdentityId: alternateIdentity.id }),
      expect.objectContaining({ sourceKind: "claude_code_session", executionIdentityId: null }),
    ]));
    expect(body.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "shared-id",
        sourceKind: "codex_session",
        executionIdentityId: systemIdentity,
        monitoringEnabled: false,
        projectId: null,
        lastReadPosition: null,
        organizationStatus: "not_started",
        workGraphSnapshot: null,
      }),
      expect.objectContaining({
        id: "shared-id",
        sourceKind: "codex_session",
        executionIdentityId: alternateIdentity.id,
      }),
      expect.objectContaining({
        id: "shared-id",
        sourceKind: "claude_code_session",
        executionIdentityId: null,
      }),
    ]));
    expect(store.list()).toHaveLength(0);
  });

  test("persists project and monitoring choices, then leaves refreshed sessions disabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-session-monitoring-"));
    const databasePath = join(root, "teamline.db");
    let discovered = [session("session-a", "先发现的会话", "/tmp/project-a")];
    const providerForSystem = provider(() => ({
      status: "available" as const,
      message: "Codex",
      sessions: discovered,
    }));
    const createMonitoringApp = (store: WorkOrderStore) => createApp({
      store,
      codexSessionProvider: providerForSystem,
      claudeCodeSessionProvider: provider(() => ({
        status: "available",
        message: "Claude Code",
        sessions: [],
      })),
    });

    const firstStore = new WorkOrderStore(new Database(databasePath));
    const firstApp = createMonitoringApp(firstStore);
    try {
      const scanned = await firstApp.fetch(new Request(
        "http://teamline.local/api/session-monitoring/discover",
        { method: "POST" },
      )).then((response) => response.json());
      const project = await firstApp.fetch(new Request(
        "http://teamline.local/api/projects",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "会话项目" }),
        },
      )).then((response) => response.json());
      const saved = await firstApp.fetch(new Request(
        "http://teamline.local/api/session-monitoring/selections",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessions: [{
              key: scanned.sessions[0].key,
              projectId: project.project.id,
              monitoringEnabled: true,
            }],
          }),
        },
      )).then((response) => response.json());

      expect(saved.sessions[0]).toMatchObject({
        projectId: project.project.id,
        monitoringEnabled: true,
      });
      const updated = await firstApp.fetch(new Request(
        `http://teamline.local/api/session-monitoring/${encodeURIComponent(scanned.sessions[0].key)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            monitoringEnabled: false,
            lastReadPosition: 128,
            lastReadAt: "2026-08-09T02:00:00.000Z",
            organizationStatus: "pending",
            workGraphSnapshot: { version: 1, nodes: [] },
          }),
        },
      )).then((response) => response.json());
      expect(updated.session).toMatchObject({
        monitoringEnabled: false,
        lastReadPosition: 128,
        lastReadAt: "2026-08-09T02:00:00.000Z",
        organizationStatus: "pending",
        workGraphSnapshot: { version: 1, nodes: [] },
      });
      expect(updated.session.sourcePath).toBeUndefined();
      expect(firstStore.list()).toHaveLength(0);
      await firstApp.close();
      firstStore.database.close();

      const reopenedStore = new WorkOrderStore(new Database(databasePath));
      const reopenedApp = createMonitoringApp(reopenedStore);
      const persisted = await reopenedApp.fetch(new Request(
        "http://teamline.local/api/session-monitoring",
      )).then((response) => response.json());
      expect(persisted.lastScannedAt).toBe(scanned.lastScannedAt);
      expect(persisted.sessions).toEqual([
        expect.objectContaining({
          key: sessionMonitoringKey("codex_session", "codex-system-default", "session-a"),
          projectId: project.project.id,
          monitoringEnabled: false,
          lastDiscoveredAt: scanned.sessions[0].lastDiscoveredAt,
          lastReadPosition: 128,
          organizationStatus: "pending",
          workGraphSnapshot: { version: 1, nodes: [] },
        }),
      ]);

      discovered = [
        ...discovered,
        session("session-b", "刷新后出现的会话", "/tmp/project-b"),
      ];
      const refreshed = await reopenedApp.fetch(new Request(
        "http://teamline.local/api/session-monitoring/discover",
        { method: "POST" },
      )).then((response) => response.json());
      expect(refreshed.sessions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "session-a", monitoringEnabled: false, projectId: project.project.id }),
        expect.objectContaining({ id: "session-b", monitoringEnabled: false, projectId: null }),
      ]));
      await reopenedApp.close();
      reopenedStore.database.close();
    } finally {
      try { firstStore.database.close(); } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("excludes Teamline execution sessions without controlling external sessions", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const systemIdentity = store.getSystemExecutionIdentityId()!;
    const alternateIdentity = store.createManagedExecutionIdentity({
      id: "codex-alt",
      label: "备用账号",
      managedHomePath: "/tmp/codex-alt",
    });
    const goal = store.create({
      name: "Teamline 执行目标",
      description: "占用一个 Teamline 执行会话",
      executionIdentityId: systemIdentity,
    });
    store.database
      .query("UPDATE work_orders SET session_id = ?, session_identity_id = ? WHERE id = ?")
      .run("owned-session", systemIdentity, goal.id);
    let discoveryCalls = 0;
    const app = createApp({
      store,
      codexSessionProviderForIdentity(identity) {
        return {
          async discover() {
            discoveryCalls += 1;
            return {
              status: "available" as const,
              message: identity.id,
              sessions: [
                session("owned-session", `${identity.label} 的同 ID 会话`, "/tmp/owned"),
                session("external-session", `${identity.label} 的外部会话`, "/tmp/external"),
              ],
            };
          },
        };
      },
      claudeCodeSessionProvider: provider(() => ({
        status: "available",
        message: "Claude Code",
        sessions: [],
      })),
    });

    const discovered = await app.fetch(new Request(
      "http://teamline.local/api/session-monitoring/discover",
      { method: "POST" },
    )).then((response) => response.json());
    expect(discovered.sessions).toEqual(expect.not.arrayContaining([
      expect.objectContaining({
        sourceKind: "codex_session",
        executionIdentityId: systemIdentity,
        id: "owned-session",
      }),
    ]));
    expect(discovered.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceKind: "codex_session",
        executionIdentityId: alternateIdentity.id,
        id: "owned-session",
      }),
    ]));
    expect(store.list()).toHaveLength(1);

    const external = discovered.sessions.find((candidate: { id: string }) => candidate.id === "external-session");
    await app.fetch(new Request(
      `http://teamline.local/api/session-monitoring/${encodeURIComponent(external.key)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ monitoringEnabled: true }),
      },
    ));
    expect(discoveryCalls).toBe(2);
    await app.close();
  });

  test("keeps a cataloged session hidden after Teamline takes ownership", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const systemIdentity = store.getSystemExecutionIdentityId()!;
    const app = createApp({
      store,
      codexSessionProvider: provider(() => ({
        status: "available",
        message: "Codex",
        sessions: [session("claimed-session", "会被目标占用", "/tmp/claimed")],
      })),
      claudeCodeSessionProvider: provider(() => ({
        status: "available",
        message: "Claude Code",
        sessions: [],
      })),
    });

    const discovered = await app.fetch(new Request(
      "http://teamline.local/api/session-monitoring/discover",
      { method: "POST" },
    )).then((response) => response.json());
    expect(discovered.sessions).toHaveLength(1);

    const goal = store.create({
      name: "占用会话的目标",
      description: "测试 Teamline 占用后的目录过滤",
      executionIdentityId: systemIdentity,
    });
    store.database
      .query("UPDATE work_orders SET session_id = ?, session_identity_id = ? WHERE id = ?")
      .run("claimed-session", systemIdentity, goal.id);

    const persisted = await app.fetch(new Request(
      "http://teamline.local/api/session-monitoring",
    )).then((response) => response.json());
    expect(persisted.sessions).toHaveLength(0);
    expect(store.listSessionMonitoring()).toHaveLength(1);
    await app.close();
  });
});
