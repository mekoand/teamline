import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { LocalClaudeCodeSessionProvider } from "../src/claude-code-session-discovery";
import { LocalCodexSessionProvider } from "../src/codex-session-discovery";
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

function controlledScheduler() {
  const callbacks = new Set<() => void>();
  return {
    schedule(callback: () => void, _delayMs: number) {
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    async runNext() {
      const callback = callbacks.values().next().value as (() => void) | undefined;
      if (!callback) throw new Error("没有待运行的后台扫描");
      callbacks.delete(callback);
      callback();
      await Bun.sleep(0);
    },
    get size() {
      return callbacks.size;
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  message = "后台会话监控没有完成",
) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error(message);
}

function sourceReadProvider(
  readDiscovery: () => SessionDiscoveryResult,
  readSource: (path: string, fromPosition: number) => { content: string; nextPosition: number },
  onRead: () => void,
): SessionProvider {
  return {
    async discover() {
      return readDiscovery();
    },
    async read(source, fromPosition) {
      onRead();
      if (!source.sourcePath) throw new Error("来源文件不可用");
      return readSource(source.sourcePath, fromPosition);
    },
  };
}

function monitorOrganization(version: number, summary: string) {
  return {
    description: "持续推进一个受监控会话",
    summary,
    currentState: `版本 ${version}`,
    historicalStages: [],
    artifacts: [],
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
    expect(script).toContain("data-session-monitoring-retry");
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

  test("updates monitored sessions only after source metadata changes and reads only the appended bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-session-monitoring-incremental-"));
    const sourcePath = join(root, "session.jsonl");
    const workspacePath = join(root, "workspace");
    writeFileSync(sourcePath, "first record\n", "utf8");
    let sourceContent = readFileSync(sourcePath, "utf8");
    let lastActiveAt = "2026-08-09T01:00:00.000Z";
    let sourceModifiedAt = "2026-08-09T01:00:00.000Z";
    let reads = 0;
    const organizationInputs: Array<{
      previousSnapshot?: unknown | null;
      content: string;
    }> = [];
    const selections: Array<{ accountId: string | null; model: string }> = [];
    const scheduler = controlledScheduler();
    const store = new WorkOrderStore(new Database(":memory:"));
    const systemIdentity = store.getSystemExecutionIdentityId()!;
    const discoveredSession = () => ({
      ...session("incremental", "增量会话", workspacePath),
      lastActiveAt,
      sourcePath,
      sourcePosition: Buffer.byteLength(sourceContent),
      sourceModifiedAt,
    });
    const sourceProvider = sourceReadProvider(
      () => ({
        status: "available" as const,
        message: "Codex",
        sessions: [discoveredSession()],
      }),
      (path, fromPosition) => {
        const bytes = readFileSync(path);
        return {
          content: bytes.subarray(fromPosition).toString("utf8"),
          nextPosition: bytes.length,
        };
      },
      () => { reads += 1; },
    );
    const app = createApp({
      store,
      codexSessionProvider: sourceProvider,
      claudeCodeSessionProvider: provider(() => ({
        status: "available",
        message: "Claude Code",
        sessions: [],
      })),
      sessionMonitoringScheduler: scheduler.schedule,
      sessionOrganizationResourceSelector: {
        async select(request) {
          selections.push({ accountId: request.accountId, model: "fast-summary-model" });
          return {
            tool: "codex",
            model: "fast-summary-model",
            accountId: request.accountId,
            accountLabel: "个人账号",
          };
        },
      },
      sessionOrganizer: {
        async organize(input) {
          const content = readFileSync(input.sessions[0]!.sourcePath, "utf8");
          organizationInputs.push({ previousSnapshot: input.previousSnapshot, content });
          return monitorOrganization(organizationInputs.length, content);
        },
      },
    });

    try {
      const discovered = await app.fetch(new Request(
        "http://teamline.local/api/session-monitoring/discover",
        { method: "POST" },
      )).then((response) => response.json());
      const key = discovered.sessions[0].key as string;
      await app.fetch(new Request(
        `http://teamline.local/api/session-monitoring/${encodeURIComponent(key)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ monitoringEnabled: true }),
        },
      ));

      await scheduler.runNext();
      await waitFor(() => store.getSessionMonitoring(key)?.organizationStatus === "ready");
      expect(reads).toBe(1);
      expect(organizationInputs).toEqual([{
        previousSnapshot: null,
        content: "first record\n",
      }]);
      expect(selections).toEqual([{ accountId: systemIdentity, model: "fast-summary-model" }]);

      await scheduler.runNext();
      await Bun.sleep(5);
      expect(reads).toBe(1);
      expect(organizationInputs).toHaveLength(1);
      expect(selections).toHaveLength(1);

      const appended = "second record\n";
      appendFileSync(sourcePath, appended, "utf8");
      sourceContent += appended;
      lastActiveAt = "2026-08-09T01:05:00.000Z";
      sourceModifiedAt = "2026-08-09T01:05:00.000Z";
      await scheduler.runNext();
      await waitFor(() => organizationInputs.length === 2);

      const monitored = store.getSessionMonitoring(key)!;
      expect(reads).toBe(2);
      expect(organizationInputs[1]).toEqual({
        previousSnapshot: monitorOrganization(1, "first record\n"),
        content: appended,
      });
      expect(monitored).toMatchObject({
        lastReadPosition: Buffer.byteLength(sourceContent),
        organizationStatus: "ready",
        workGraphSnapshot: monitorOrganization(2, appended),
      });
      expect(monitored.lastReadAt).toEqual(expect.any(String));

      const resources = await app.fetch(new Request("http://teamline.local/api/resources"))
        .then((response) => response.json());
      expect(resources.sessionMonitoringUsage).toEqual(expect.arrayContaining([
        expect.objectContaining({
          sessionKey: key,
          tool: "codex",
          model: "fast-summary-model",
          accountId: systemIdentity,
          status: "succeeded",
        }),
      ]));
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("requeues a source change observed while its previous organization is still running", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-session-monitoring-overlap-"));
    const sourcePath = join(root, "session.jsonl");
    writeFileSync(sourcePath, "first record\n", "utf8");
    let sourceContent = readFileSync(sourcePath, "utf8");
    let sourceModifiedAt = "2026-08-09T01:00:00.000Z";
    let reads = 0;
    let organizations = 0;
    let organizationStarted!: () => void;
    let releaseOrganization!: () => void;
    const organizationStartedPromise = new Promise<void>((resolve) => {
      organizationStarted = resolve;
    });
    const organizationReleasePromise = new Promise<void>((resolve) => {
      releaseOrganization = resolve;
    });
    const organizationInputs: string[] = [];
    const scheduler = controlledScheduler();
    const store = new WorkOrderStore(new Database(":memory:"));
    const discoveredSession = () => ({
      ...session("overlap", "重叠整理会话", root),
      sourcePath,
      sourcePosition: Buffer.byteLength(sourceContent),
      sourceModifiedAt,
    });
    const app = createApp({
      store,
      codexSessionProvider: sourceReadProvider(
        () => ({ status: "available", message: "Codex", sessions: [discoveredSession()] }),
        (path, fromPosition) => {
          const bytes = readFileSync(path);
          return {
            content: bytes.subarray(fromPosition).toString("utf8"),
            nextPosition: bytes.length,
          };
        },
        () => { reads += 1; },
      ),
      claudeCodeSessionProvider: provider(() => ({
        status: "available",
        message: "Claude Code",
        sessions: [],
      })),
      sessionMonitoringScheduler: scheduler.schedule,
      sessionOrganizationResourceSelector: {
        async select() {
          return { tool: "codex", model: "fast-summary-model", accountId: null, accountLabel: null };
        },
      },
      sessionOrganizer: {
        async organize(input) {
          organizations += 1;
          organizationInputs.push(readFileSync(input.sessions[0]!.sourcePath, "utf8"));
          if (organizations === 1) {
            organizationStarted();
            await organizationReleasePromise;
          }
          return monitorOrganization(organizations, organizationInputs.at(-1)!);
        },
      },
    });

    try {
      const first = await app.fetch(new Request(
        "http://teamline.local/api/session-monitoring/discover",
        { method: "POST" },
      )).then((response) => response.json());
      const key = first.sessions[0].key as string;
      await app.fetch(new Request(
        `http://teamline.local/api/session-monitoring/${encodeURIComponent(key)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ monitoringEnabled: true }),
        },
      ));
      await scheduler.runNext();
      await organizationStartedPromise;

      const appended = "second record\n";
      appendFileSync(sourcePath, appended, "utf8");
      sourceContent += appended;
      sourceModifiedAt = "2026-08-09T01:05:00.000Z";
      const rediscovery = await app.fetch(new Request(
        "http://teamline.local/api/session-monitoring/discover",
        { method: "POST" },
      ));
      expect(rediscovery.status).toBe(200);

      releaseOrganization();
      await waitFor(() => organizations === 2);
      expect(reads).toBe(2);
      expect(organizationInputs).toEqual(["first record\n", appended]);
      expect(store.getSessionMonitoring(key)).toMatchObject({
        lastReadPosition: Buffer.byteLength(sourceContent),
        organizationStatus: "ready",
        workGraphSnapshot: monitorOrganization(2, appended),
      });
    } finally {
      releaseOrganization();
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("monitors temporary Codex and Claude sources through their concrete providers", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-session-monitoring-real-sources-"));
    const codexHome = join(root, "codex-home");
    const codexSessions = join(codexHome, "sessions", "2026", "08", "09");
    const claudeRoot = join(root, "claude-projects");
    const claudeProject = join(claudeRoot, "-tmp-real-project");
    const workspace = join(root, "real-project");
    const codexId = "019fc374-5a5b-78b0-81da-c5bf1452cebf";
    const codexSource = join(
      codexSessions,
      `rollout-2026-08-09T01-10-10-${codexId}.jsonl`,
    );
    const claudeSource = join(claudeProject, "claude-session.jsonl");
    mkdirSync(codexSessions, { recursive: true });
    mkdirSync(claudeProject, { recursive: true });
    mkdirSync(workspace);
    const codexInitial = [
      JSON.stringify({ type: "session_meta", payload: { id: codexId, cwd: workspace } }),
      JSON.stringify({ type: "response_item", payload: { role: "user" } }),
      "",
    ].join("\n");
    const claudeInitial = [
      JSON.stringify({ type: "user", sessionId: "claude-session", cwd: workspace }),
      JSON.stringify({ type: "assistant", sessionId: "claude-session" }),
      "",
    ].join("\n");
    writeFileSync(
      join(codexHome, "session_index.jsonl"),
      `${JSON.stringify({ id: codexId, thread_name: "真实 Codex 会话", updated_at: new Date().toISOString() })}\n`,
    );
    writeFileSync(codexSource, codexInitial);
    writeFileSync(claudeSource, claudeInitial);
    const codex = new LocalCodexSessionProvider(codexHome);
    const claude = new LocalClaudeCodeSessionProvider(claudeRoot);
    let codexReads = 0;
    let claudeReads = 0;
    const scheduler = controlledScheduler();
    const store = new WorkOrderStore(new Database(":memory:"));
    const app = createApp({
      store,
      codexSessionProvider: {
        discover(signal) { return codex.discover(signal); },
        read(session, fromPosition, signal) {
          codexReads += 1;
          return codex.read!(session, fromPosition, signal);
        },
      },
      claudeCodeSessionProvider: {
        discover(signal) { return claude.discover(signal); },
        read(session, fromPosition, signal) {
          claudeReads += 1;
          return claude.read!(session, fromPosition, signal);
        },
      },
      sessionMonitoringScheduler: scheduler.schedule,
      sessionOrganizationResourceSelector: {
        async select(request) {
          return {
            tool: "codex",
            model: "fast-summary-model",
            accountId: request.accountId,
            accountLabel: request.accountId ? "Codex 账号" : null,
          };
        },
      },
      sessionOrganizer: {
        async organize(input) {
          return monitorOrganization(
            input.previousSnapshot ? 2 : 1,
            readFileSync(input.sessions[0]!.sourcePath, "utf8"),
          );
        },
      },
    });

    try {
      const discovered = await app.fetch(new Request(
        "http://teamline.local/api/session-monitoring/discover",
        { method: "POST" },
      )).then((response) => response.json());
      const keys = discovered.sessions.map((candidate: { key: string }) => candidate.key);
      expect(keys).toHaveLength(2);
      await app.fetch(new Request(
        "http://teamline.local/api/session-monitoring/selections",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessions: keys.map((key: string) => ({ key, monitoringEnabled: true })) }),
        },
      ));
      await scheduler.runNext();
      await waitFor(() => store.listSessionMonitoring().every((session) => session.organizationStatus === "ready"));
      expect(codexReads).toBe(1);
      expect(claudeReads).toBe(1);

      const codexAppend = `${JSON.stringify({ type: "response_item", payload: { role: "assistant" } })}\n`;
      const claudeAppend = `${JSON.stringify({ type: "assistant", sessionId: "claude-session" })}\n`;
      appendFileSync(codexSource, codexAppend, "utf8");
      appendFileSync(claudeSource, claudeAppend, "utf8");
      await scheduler.runNext();
      await waitFor(() =>
        codexReads === 2 &&
        claudeReads === 2 &&
        store.listSessionMonitoring().every((session) => session.organizationStatus === "ready"),
      );
      expect(store.listSessionMonitoring()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: codexId,
            sourceKind: "codex_session",
            organizationStatus: "ready",
          }),
          expect.objectContaining({
            id: "claude-session",
            sourceKind: "claude_code_session",
            organizationStatus: "ready",
          }),
        ]),
      );
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not organize an unmonitored session discovered during a background scan", async () => {
    const scheduler = controlledScheduler();
    const store = new WorkOrderStore(new Database(":memory:"));
    let discovered = [session("monitored", "已监控", "/tmp/monitored")];
    let reads = 0;
    let organizations = 0;
    const app = createApp({
      store,
      codexSessionProvider: sourceReadProvider(
        () => ({ status: "available", message: "Codex", sessions: discovered }),
        () => ({ content: "new content", nextPosition: 11 }),
        () => { reads += 1; },
      ),
      sessionMonitoringScheduler: scheduler.schedule,
      sessionOrganizationResourceSelector: {
        async select() {
          return { tool: "codex", model: "fast-summary-model", accountId: null, accountLabel: null };
        },
      },
      sessionOrganizer: {
        async organize() {
          organizations += 1;
          return monitorOrganization(organizations, "summary");
        },
      },
    });

    try {
      const first = await app.fetch(new Request(
        "http://teamline.local/api/session-monitoring/discover",
        { method: "POST" },
      )).then((response) => response.json());
      const key = first.sessions[0].key as string;
      await app.fetch(new Request(
        `http://teamline.local/api/session-monitoring/${encodeURIComponent(key)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ monitoringEnabled: true }),
        },
      ));
      await scheduler.runNext();
      await waitFor(() => organizations === 1);

      discovered = [
        ...discovered,
        session("unmonitored", "新发现", "/tmp/new-session"),
      ];
      await scheduler.runNext();
      await waitFor(() => store.getSessionMonitoring(
        sessionMonitoringKey("codex_session", store.getSystemExecutionIdentityId(), "unmonitored"),
      ) !== null);
      expect(organizations).toBe(1);
      expect(reads).toBe(1);
      expect(store.getSessionMonitoring(
        sessionMonitoringKey("codex_session", store.getSystemExecutionIdentityId(), "unmonitored"),
      )).toMatchObject({ monitoringEnabled: false, organizationStatus: "not_started" });
    } finally {
      await app.close();
    }
  });

  test("does not mark a cataloged session missing from a partial source result as unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-session-monitoring-partial-"));
    const sourcePath = join(root, "retained.jsonl");
    writeFileSync(sourcePath, "still here\n", "utf8");
    const store = new WorkOrderStore(new Database(":memory:"));
    let complete = true;
    const app = createApp({
      store,
      codexSessionProvider: provider(() => ({
        status: complete ? "available" : "partial",
        message: complete ? "Codex" : "Codex 只返回了部分会话",
        sessions: complete
          ? [{ ...session("retained", "仍在来源中的会话", root), sourcePath }]
          : [],
      })),
      claudeCodeSessionProvider: provider(() => ({
        status: "available",
        message: "Claude Code",
        sessions: [],
      })),
    });

    try {
      await app.fetch(new Request(
        "http://teamline.local/api/session-monitoring/discover",
        { method: "POST" },
      ));
      complete = false;
      await app.fetch(new Request(
        "http://teamline.local/api/session-monitoring/discover",
        { method: "POST" },
      ));
      expect(store.getSessionMonitoring(
        sessionMonitoringKey("codex_session", store.getSystemExecutionIdentityId(), "retained"),
      )).toMatchObject({ availability: "available", organizationStatus: "not_started" });
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("continues an enabled session from its saved source when discovery omits it", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-session-monitoring-saved-source-"));
    const sourcePath = join(root, "saved.jsonl");
    writeFileSync(sourcePath, "before\n", "utf8");
    let listed = true;
    let organizations = 0;
    const scheduler = controlledScheduler();
    const store = new WorkOrderStore(new Database(":memory:"));
    const app = createApp({
      store,
      codexSessionProvider: sourceReadProvider(
        () => ({
          status: "available",
          message: "Codex",
          sessions: listed
            ? [{ ...session("saved-source", "已保存来源", root), sourcePath }]
            : [],
        }),
        (path, fromPosition) => {
          const content = readFileSync(path);
          return {
            content: content.subarray(fromPosition).toString("utf8"),
            nextPosition: content.length,
          };
        },
        () => undefined,
      ),
      sessionMonitoringScheduler: scheduler.schedule,
      sessionOrganizationResourceSelector: {
        async select() {
          return { tool: "codex", model: "fast-summary-model", accountId: null, accountLabel: null };
        },
      },
      sessionOrganizer: {
        async organize() {
          organizations += 1;
          return monitorOrganization(organizations, "updated");
        },
      },
    });

    try {
      const first = await app.fetch(new Request(
        "http://teamline.local/api/session-monitoring/discover",
        { method: "POST" },
      )).then((response) => response.json());
      const key = first.sessions[0].key as string;
      await app.fetch(new Request(
        `http://teamline.local/api/session-monitoring/${encodeURIComponent(key)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ monitoringEnabled: true }),
        },
      ));
      await scheduler.runNext();
      await waitFor(() => organizations === 1);

      listed = false;
      appendFileSync(sourcePath, "after\n", "utf8");
      await scheduler.runNext();
      await waitFor(() => organizations === 2);
      expect(store.getSessionMonitoring(key)).toMatchObject({
        organizationStatus: "ready",
        lastReadPosition: Buffer.byteLength("before\nafter\n"),
      });
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not retry an unchanged source after its initial organization fails", async () => {
    const scheduler = controlledScheduler();
    const store = new WorkOrderStore(new Database(":memory:"));
    let reads = 0;
    let organizations = 0;
    let fail = true;
    const app = createApp({
      store,
      codexSessionProvider: sourceReadProvider(
        () => ({ status: "available", message: "Codex", sessions: [session("initial-failure", "初次失败", "/tmp/initial-failure")] }),
        () => ({ content: "initial\n", nextPosition: 8 }),
        () => { reads += 1; },
      ),
      sessionMonitoringScheduler: scheduler.schedule,
      sessionOrganizationResourceSelector: {
        async select() {
          return { tool: "codex", model: "fast-summary-model", accountId: null, accountLabel: null };
        },
      },
      sessionOrganizer: {
        async organize() {
          organizations += 1;
          if (fail) throw new Error("首次整理失败");
          return monitorOrganization(organizations, "重试成功");
        },
      },
    });

    try {
      const discovered = await app.fetch(new Request(
        "http://teamline.local/api/session-monitoring/discover",
        { method: "POST" },
      )).then((response) => response.json());
      const key = discovered.sessions[0].key as string;
      await app.fetch(new Request(
        `http://teamline.local/api/session-monitoring/${encodeURIComponent(key)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ monitoringEnabled: true }),
        },
      ));
      await scheduler.runNext();
      await waitFor(() => store.getSessionMonitoring(key)?.organizationStatus === "failed");
      await scheduler.runNext();
      await Bun.sleep(5);
      expect(reads).toBe(1);
      expect(organizations).toBe(1);

      fail = false;
      await app.fetch(new Request(
        `http://teamline.local/api/session-monitoring/${encodeURIComponent(key)}/retry`,
        { method: "POST" },
      ));
      await waitFor(() => store.getSessionMonitoring(key)?.organizationStatus === "ready");
      expect(reads).toBe(2);
      expect(organizations).toBe(2);
    } finally {
      await app.close();
    }
  });

  test("does not commit a slow organization after monitoring is disabled", async () => {
    const scheduler = controlledScheduler();
    const store = new WorkOrderStore(new Database(":memory:"));
    let resolveOrganization!: () => void;
    let organizationStarted = false;
    const organizationFinished = new Promise<void>((resolve) => {
      resolveOrganization = resolve;
    });
    const app = createApp({
      store,
      codexSessionProvider: sourceReadProvider(
        () => ({ status: "available", message: "Codex", sessions: [session("slow", "慢会话", "/tmp/slow")] }),
        () => ({ content: "new content\n", nextPosition: 12 }),
        () => undefined,
      ),
      sessionMonitoringScheduler: scheduler.schedule,
      sessionOrganizationResourceSelector: {
        async select() {
          return { tool: "codex", model: "fast-summary-model", accountId: null, accountLabel: null };
        },
      },
      sessionOrganizer: {
        async organize() {
          organizationStarted = true;
          await organizationFinished;
          return monitorOrganization(1, "should not be committed");
        },
      },
    });

    try {
      const discovered = await app.fetch(new Request(
        "http://teamline.local/api/session-monitoring/discover",
        { method: "POST" },
      )).then((response) => response.json());
      const key = discovered.sessions[0].key as string;
      await app.fetch(new Request(
        `http://teamline.local/api/session-monitoring/${encodeURIComponent(key)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ monitoringEnabled: true }),
        },
      ));
      await scheduler.runNext();
      await waitFor(() =>
        organizationStarted && store.getSessionMonitoring(key)?.organizationStatus === "pending",
      );
      await app.fetch(new Request(
        `http://teamline.local/api/session-monitoring/${encodeURIComponent(key)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ monitoringEnabled: false }),
        },
      ));
      await waitFor(() => store.getSessionMonitoring(key)?.organizationStatus === "failed");
      resolveOrganization();
      expect(store.getSessionMonitoring(key)).toMatchObject({
        monitoringEnabled: false,
        workGraphSnapshot: null,
      });
      expect(store.listSessionMonitoringResourceUsage()).toEqual([
        expect.objectContaining({ status: "failed" }),
      ]);
    } finally {
      resolveOrganization();
      await app.close();
    }
  });

  test("preserves the last successful snapshot when one source update is damaged and retries it manually", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-session-monitoring-retry-"));
    const sourcePath = join(root, "session.jsonl");
    writeFileSync(sourcePath, "stable\n", "utf8");
    let sourceContent = readFileSync(sourcePath, "utf8");
    let lastActiveAt = "2026-08-09T01:00:00.000Z";
    let failNext = false;
    let reads = 0;
    let organizations = 0;
    const scheduler = controlledScheduler();
    const store = new WorkOrderStore(new Database(":memory:"));
    const source = () => ({
      ...session("retryable", "可重试会话", root),
      sourcePath,
      lastActiveAt,
      sourcePosition: Buffer.byteLength(sourceContent),
      sourceModifiedAt: lastActiveAt,
    });
    const app = createApp({
      store,
      codexSessionProvider: sourceReadProvider(
        () => ({ status: "available", message: "Codex", sessions: [source()] }),
        (path, fromPosition) => {
          const bytes = readFileSync(path);
          return {
            content: bytes.subarray(fromPosition).toString("utf8"),
            nextPosition: bytes.length,
          };
        },
        () => { reads += 1; },
      ),
      sessionMonitoringScheduler: scheduler.schedule,
      sessionOrganizationResourceSelector: {
        async select() {
          return { tool: "codex", model: "fast-summary-model", accountId: null, accountLabel: null };
        },
      },
      sessionOrganizer: {
        async organize(input) {
          organizations += 1;
          const content = readFileSync(input.sessions[0]!.sourcePath, "utf8");
          if (failNext) throw new Error("损坏记录无法整理");
          return monitorOrganization(organizations, content);
        },
      },
    });

    try {
      const first = await app.fetch(new Request(
        "http://teamline.local/api/session-monitoring/discover",
        { method: "POST" },
      )).then((response) => response.json());
      const key = first.sessions[0].key as string;
      await app.fetch(new Request(
        `http://teamline.local/api/session-monitoring/${encodeURIComponent(key)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ monitoringEnabled: true }),
        },
      ));
      await scheduler.runNext();
      await waitFor(() => organizations === 1);
      const previous = store.getSessionMonitoring(key)!;
      const previousPosition = previous.lastReadPosition;
      const previousSnapshot = previous.workGraphSnapshot;

      const damaged = "{damaged-record\n";
      appendFileSync(sourcePath, damaged, "utf8");
      sourceContent += damaged;
      lastActiveAt = "2026-08-09T01:05:00.000Z";
      failNext = true;
      await scheduler.runNext();
      await waitFor(() => store.getSessionMonitoring(key)?.organizationStatus === "failed");
      expect(store.getSessionMonitoring(key)).toMatchObject({
        lastReadPosition: previousPosition,
        workGraphSnapshot: previousSnapshot,
        organizationStatus: "failed",
      });
      expect(store.getSessionMonitoring(key)?.message).toContain("损坏记录");
      const attemptsAfterFailure = organizations;
      const readsAfterFailure = reads;
      await scheduler.runNext();
      await Bun.sleep(5);
      expect(organizations).toBe(attemptsAfterFailure);
      expect(reads).toBe(readsAfterFailure);
      expect(store.getSessionMonitoring(key)?.message).toContain("损坏记录");

      failNext = false;
      const retry = await app.fetch(new Request(
        `http://teamline.local/api/session-monitoring/${encodeURIComponent(key)}/retry`,
        { method: "POST" },
      ));
      expect(retry.status).toBe(202);
      await waitFor(() => store.getSessionMonitoring(key)?.organizationStatus === "ready");
      expect(organizations).toBe(3);
      expect(store.getSessionMonitoring(key)?.lastReadPosition).toBe(
        Buffer.byteLength(sourceContent),
      );
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps a successful snapshot when the source disappears and restores it through retry", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-session-monitoring-disappeared-"));
    const sourcePath = join(root, "session.jsonl");
    writeFileSync(sourcePath, "before disappearance\n", "utf8");
    let sourceAvailable = true;
    let organizations = 0;
    const scheduler = controlledScheduler();
    const store = new WorkOrderStore(new Database(":memory:"));
    const app = createApp({
      store,
      codexSessionProvider: sourceReadProvider(
        () => ({
          status: sourceAvailable ? "available" : "unavailable",
          message: "Codex",
          sessions: sourceAvailable
            ? [{
                ...session("disappearing", "会消失的会话", root),
                sourcePath,
                sourcePosition: readFileSync(sourcePath).length,
                sourceModifiedAt: "2026-08-09T01:00:00.000Z",
              }]
            : [],
        }),
        (path, fromPosition) => {
          const bytes = readFileSync(path);
          return {
            content: bytes.subarray(fromPosition).toString("utf8"),
            nextPosition: bytes.length,
          };
        },
        () => undefined,
      ),
      sessionMonitoringScheduler: scheduler.schedule,
      sessionOrganizationResourceSelector: {
        async select() {
          return { tool: "codex", model: "fast-summary-model", accountId: null, accountLabel: null };
        },
      },
      sessionOrganizer: {
        async organize() {
          organizations += 1;
          return monitorOrganization(organizations, "snapshot");
        },
      },
    });

    try {
      const first = await app.fetch(new Request(
        "http://teamline.local/api/session-monitoring/discover",
        { method: "POST" },
      )).then((response) => response.json());
      const key = first.sessions[0].key as string;
      await app.fetch(new Request(
        `http://teamline.local/api/session-monitoring/${encodeURIComponent(key)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ monitoringEnabled: true }),
        },
      ));
      await scheduler.runNext();
      await waitFor(() => organizations === 1);
      const snapshot = store.getSessionMonitoring(key)!.workGraphSnapshot;

      sourceAvailable = false;
      rmSync(sourcePath);
      await scheduler.runNext();
      await waitFor(() => store.getSessionMonitoring(key)?.organizationStatus === "failed");
      expect(store.getSessionMonitoring(key)).toMatchObject({
        availability: "unavailable",
        organizationStatus: "failed",
        workGraphSnapshot: snapshot,
      });

      sourceAvailable = true;
      writeFileSync(sourcePath, "before disappearance\n", "utf8");
      const retry = await app.fetch(new Request(
        `http://teamline.local/api/session-monitoring/${encodeURIComponent(key)}/retry`,
        { method: "POST" },
      ));
      expect(retry.status).toBe(202);
      await waitFor(() => store.getSessionMonitoring(key)?.organizationStatus === "ready");
      expect(organizations).toBe(2);
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps account-specific monitored sessions isolated while one background organization is slow", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-session-monitoring-accounts-"));
    const personalPath = join(root, "personal.jsonl");
    const workPath = join(root, "work.jsonl");
    writeFileSync(personalPath, "personal content\n", "utf8");
    writeFileSync(workPath, "work content\n", "utf8");
    const scheduler = controlledScheduler();
    const store = new WorkOrderStore(new Database(":memory:"));
    const personalIdentity = store.getSystemExecutionIdentityId()!;
    const workIdentity = store.createManagedExecutionIdentity({
      id: "codex-work",
      label: "工作账号",
      managedHomePath: join(root, "work-home"),
    });
    const pending = [] as Array<{ resolve: () => void }>;
    let organizations = 0;
    const forIdentity = (identityId: string, path: string) => sourceReadProvider(
      () => ({
        status: "available",
        message: identityId,
        sessions: [{
          ...session("same-id", `${identityId} 会话`, root),
          sourcePath: path,
          sourcePosition: readFileSync(path).length,
          sourceModifiedAt: "2026-08-09T01:00:00.000Z",
        }],
      }),
      (sourcePath, fromPosition) => {
        const bytes = readFileSync(sourcePath);
        return {
          content: bytes.subarray(fromPosition).toString("utf8"),
          nextPosition: bytes.length,
        };
      },
      () => undefined,
    );
    const app = createApp({
      store,
      codexSessionProviderForIdentity(identity) {
        return identity.id === workIdentity.id
          ? forIdentity(workIdentity.id, workPath)
          : forIdentity(personalIdentity, personalPath);
      },
      claudeCodeSessionProvider: provider(() => ({
        status: "available",
        message: "Claude Code",
        sessions: [],
      })),
      sessionMonitoringScheduler: scheduler.schedule,
      sessionOrganizationResourceSelector: {
        async select(request) {
          return {
            tool: "codex",
            model: request.accountId === workIdentity.id ? "work-fast-model" : "personal-fast-model",
            accountId: request.accountId,
            accountLabel: request.accountId === workIdentity.id ? "工作账号" : "个人账号",
          };
        },
      },
      sessionOrganizer: {
        async organize(input) {
          organizations += 1;
          if (input.sessions[0]!.id === "same-id" && input.resource?.accountId === personalIdentity) {
            await new Promise<void>((resolve) => pending.push({ resolve }));
          }
          return monitorOrganization(organizations, readFileSync(input.sessions[0]!.sourcePath, "utf8"));
        },
      },
    });

    try {
      const discovered = await app.fetch(new Request(
        "http://teamline.local/api/session-monitoring/discover",
        { method: "POST" },
      )).then((response) => response.json());
      const keys = discovered.sessions.map((candidate: { key: string }) => candidate.key);
      await app.fetch(new Request(
        "http://teamline.local/api/session-monitoring/selections",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessions: keys.map((key: string) => ({ key, monitoringEnabled: true })),
          }),
        },
      ));
      await scheduler.runNext();
      await waitFor(() => organizations === 2);
      const health = await Promise.race([
        app.fetch(new Request("http://teamline.local/api/health")),
        Bun.sleep(50).then(() => null),
      ]);
      expect(health).not.toBeNull();
      expect(store.getSessionMonitoring(sessionMonitoringKey("codex_session", workIdentity.id, "same-id")))
        .toMatchObject({ organizationStatus: "ready", workGraphSnapshot: expect.anything() });
      expect(store.getSessionMonitoring(sessionMonitoringKey("codex_session", personalIdentity, "same-id"))?.organizationStatus)
        .toBe("pending");
      pending.forEach(({ resolve }) => resolve());
      await waitFor(() => store.listSessionMonitoring().every((candidate) => candidate.organizationStatus === "ready"));
      const resources = await app.fetch(new Request("http://teamline.local/api/resources"))
        .then((response) => response.json());
      expect(resources.sessionMonitoringUsage).toEqual(expect.arrayContaining([
        expect.objectContaining({ accountId: personalIdentity, model: "personal-fast-model" }),
        expect.objectContaining({ accountId: workIdentity.id, model: "work-fast-model" }),
      ]));
    } finally {
      pending.forEach(({ resolve }) => resolve());
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
