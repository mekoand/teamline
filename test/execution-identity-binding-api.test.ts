import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { CodexExecutionRunner, type CodexRunEvent, type CodexRunner } from "../src/codex-runner";
import type { ExecutionIdentity } from "../src/execution-identity";
import { WorkOrderStore } from "../src/work-order-store";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "teamline-identity-binding-"));
  temporaryDirectories.push(directory);
  return directory;
}

function addManagedIdentity(store: WorkOrderStore, id: string, label = "备用") {
  store.createManagedExecutionIdentity({
    id,
    label,
    managedHomePath: join(temporaryDirectory(), id),
  });
  return store.recordExecutionIdentityObservation(id, {
    loginState: "ready",
    capabilities: ["sessions"],
  });
}

function readyDirectoryGoal(store: WorkOrderStore, workspacePath: string) {
  const created = store.create({
    workspace: { kind: "directory", path: workspacePath },
    goal: "完成账号绑定测试",
  });
  return store.savePlan(created.id, [
    {
      outcome: "完成当前节点",
      scope: "测试文件",
      verification: "人工检查",
    },
  ]);
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(2);
  }
}

function sessionRunner(captured: Array<{ kind: "start" | "resume"; identityId: string }>): CodexRunner {
  return {
    async start(input) {
      captured.push({ kind: "start", identityId: input.executionIdentity!.id });
      return {
        interrupt() {},
        events: (async function* (): AsyncGenerator<CodexRunEvent> {
          yield { type: "session", sessionId: `session-${input.executionIdentity!.id}` };
          yield { type: "exit", exitCode: 1, message: "测试结束" };
        })(),
      };
    },
    async resume(input) {
      captured.push({ kind: "resume", identityId: input.executionIdentity!.id });
      return {
        interrupt() {},
        events: (async function* (): AsyncGenerator<CodexRunEvent> {
          yield { type: "exit", exitCode: 1, message: "测试结束" };
        })(),
      };
    },
  };
}

describe("goal and session execution identity binding", () => {
  test("backfills an existing Codex session with the system identity", () => {
    const databasePath = join(temporaryDirectory(), "legacy.sqlite");
    const legacy = new Database(databasePath, { create: true });
    legacy.exec(`
      CREATE TABLE work_orders (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        repository_path TEXT NOT NULL,
        goal TEXT NOT NULL,
        acceptance TEXT,
        status TEXT NOT NULL,
        current_summary TEXT NOT NULL,
        plan_json TEXT,
        session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO work_orders (
        id, title, repository_path, goal, status, current_summary,
        session_id, created_at, updated_at
      ) VALUES (
        'legacy-session-goal', '旧目标', '/tmp', '继续旧目标', 'interrupted',
        '执行已中断', 'legacy-session',
        '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
      );
    `);
    legacy.close();

    const store = new WorkOrderStore(new Database(databasePath));

    expect(store.get("legacy-session-goal")).toMatchObject({
      executionIdentityId: "codex-system-default",
      sessionIdentityId: "codex-system-default",
      sessionId: "legacy-session",
    });
    store.database.close();
  });

  test("backfills a legacy imported Codex goal before its first run", () => {
    const databasePath = join(temporaryDirectory(), "legacy-import.sqlite");
    const source = {
      kind: "codex_session",
      id: "legacy-imported-session",
      lastActiveAt: "2026-08-01T00:00:00.000Z",
      version: 1,
    };
    const legacy = new Database(databasePath, { create: true });
    legacy.exec(`
      CREATE TABLE work_orders (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        repository_path TEXT NOT NULL,
        goal TEXT NOT NULL,
        acceptance TEXT,
        status TEXT NOT NULL,
        current_summary TEXT NOT NULL,
        plan_json TEXT,
        source_sessions_json TEXT,
        import_source_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    legacy
      .query(`
        INSERT INTO work_orders (
          id, title, repository_path, goal, status, current_summary,
          source_sessions_json, import_source_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        "legacy-import-goal",
        "旧导入目标",
        "/tmp",
        "继续旧导入目标",
        "draft",
        "等待整理",
        JSON.stringify([source]),
        JSON.stringify(source),
        "2026-08-01T00:00:00.000Z",
        "2026-08-01T00:00:00.000Z",
      );
    legacy.close();

    const store = new WorkOrderStore(new Database(databasePath));

    expect(store.get("legacy-import-goal")).toMatchObject({
      executionIdentityId: "codex-system-default",
      sourceSessions: [
        {
          ...source,
          executionIdentityId: "codex-system-default",
          openInCodex: true,
        },
      ],
    });
    store.database.close();
  });

  test("binds the first run to the selected default without rewriting it later", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const workspacePath = temporaryDirectory();
    const managedId = "11111111-1111-4111-8111-111111111111";
    addManagedIdentity(store, managedId);
    const captured: Array<{ kind: "start" | "resume"; identityId: string }> = [];
    const app = createApp({ store, codexRunner: sessionRunner(captured) });

    const defaultResponse = await app.fetch(new Request(
      `http://teamline.local/api/execution-identities/${managedId}/default`,
      { method: "POST" },
    ));
    expect(defaultResponse.status).toBe(200);
    const goal = readyDirectoryGoal(store, workspacePath);
    const started = await app.fetch(new Request(
      `http://teamline.local/api/work-orders/${goal.id}/start`,
      { method: "POST" },
    ));
    expect(started.status).toBe(200);
    await waitFor(() => store.get(goal.id)?.sessionId !== null);

    await app.fetch(new Request(
      "http://teamline.local/api/execution-identities/codex-system-default/default",
      { method: "POST" },
    ));

    expect(captured[0]).toEqual({ kind: "start", identityId: managedId });
    expect(store.get(goal.id)).toMatchObject({
      executionIdentityId: managedId,
      sessionIdentityId: managedId,
      sessionId: `session-${managedId}`,
    });
    expect(store.getDefaultExecutionIdentityId()).toBe("codex-system-default");
  });

  test("rejects a cross-identity resume before invoking Codex", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const workspacePath = temporaryDirectory();
    const managedId = "22222222-2222-4222-8222-222222222222";
    addManagedIdentity(store, managedId);
    const goal = readyDirectoryGoal(store, workspacePath);
    store.bindExecutionIdentity(goal.id, "codex-system-default");
    store.saveDirectWorkspace(goal.id, workspacePath);
    store.markStarted(goal.id);
    store.recordSession(goal.id, "system-session", "codex-system-default");
    store.recordInterrupted(goal.id);
    store.database
      .query("UPDATE work_orders SET session_identity_id = ? WHERE id = ?")
      .run(managedId, goal.id);
    let resumeCalls = 0;
    const app = createApp({
      store,
      codexRunner: {
        async start() {
          throw new Error("not used");
        },
        async resume() {
          resumeCalls += 1;
          throw new Error("must not run");
        },
      },
    });

    const response = await app.fetch(new Request(
      `http://teamline.local/api/work-orders/${goal.id}/continue`,
      { method: "POST" },
    ));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "EXECUTION_IDENTITY_MISMATCH" });
    expect(resumeCalls).toBe(0);
  });

  test("confirmed account switching starts a new session with handoff context", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const workspacePath = temporaryDirectory();
    const managedId = "33333333-3333-4333-8333-333333333333";
    addManagedIdentity(store, managedId);
    const goal = readyDirectoryGoal(store, workspacePath);
    store.bindExecutionIdentity(goal.id, "codex-system-default");
    store.saveDirectWorkspace(goal.id, workspacePath);
    store.markStarted(goal.id);
    store.recordSession(goal.id, "old-system-session", "codex-system-default");
    store.recordInterrupted(goal.id, "节点执行到一半");
    const captured: Array<{ kind: "start" | "resume"; identityId: string }> = [];
    const app = createApp({ store, codexRunner: sessionRunner(captured) });

    const switchedResponse = await app.fetch(new Request(
      `http://teamline.local/api/work-orders/${goal.id}/execution-identity`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ executionIdentityId: managedId, confirm: true }),
      },
    ));
    expect(switchedResponse.status).toBe(200);
    expect((await switchedResponse.json()).workOrder).toMatchObject({
      executionIdentityId: managedId,
      sessionId: null,
      sessionIdentityId: null,
      sessionHandoff: {
        fromExecutionIdentityId: "codex-system-default",
        previousSessionId: "old-system-session",
        currentStageOutcome: "完成当前节点",
      },
    });

    const continued = await app.fetch(new Request(
      `http://teamline.local/api/work-orders/${goal.id}/continue`,
      { method: "POST" },
    ));
    expect(continued.status).toBe(200);
    await waitFor(() => store.get(goal.id)?.sessionId === `session-${managedId}`);
    expect(captured[0]).toEqual({ kind: "start", identityId: managedId });
    expect(captured.some((request) => request.kind === "resume")).toBe(false);
    expect(store.get(goal.id)).toMatchObject({
      sessionId: `session-${managedId}`,
      sessionIdentityId: managedId,
      sessionHandoff: null,
    });
  });

  test("runs managed identities with their own CODEX_HOME", async () => {
    const directory = temporaryDirectory();
    const executable = join(directory, "fake-codex");
    const observedHome = join(directory, "observed-home.txt");
    writeFileSync(
      executable,
      `#!/bin/sh\nprintf '%s' "$CODEX_HOME" > '${observedHome}'\nprintf '%s\\n' '{"type":"thread.started","thread_id":"managed-session"}'\n`,
    );
    chmodSync(executable, 0o755);
    const managedHomePath = join(directory, "managed-home");
    const identity: ExecutionIdentity = {
      id: "44444444-4444-4444-8444-444444444444",
      tool: "codex",
      label: "备用",
      status: "enabled",
      homeKind: "managed",
      managedHomePath,
      accountFingerprint: null,
      loginState: "ready",
      capabilities: ["sessions"],
      lastObservedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      removedAt: null,
    };
    const store = new WorkOrderStore(new Database(":memory:"));
    const workOrder = readyDirectoryGoal(store, directory);
    const run = await new CodexExecutionRunner(executable).start({
      workOrder,
      workspacePath: directory,
      executionIdentity: identity,
    });
    for await (const _event of run.events) {
      // Consume the process output so the fake command exits.
    }

    expect(await Bun.file(observedHome).text()).toBe(managedHomePath);
  });

  test("passes the API key only to explicitly paid Codex executions", async () => {
    const directory = temporaryDirectory();
    const executable = join(directory, "fake-codex");
    const observedKey = join(directory, "observed-key.txt");
    writeFileSync(
      executable,
      `#!/bin/sh\nprintf '%s|%s|%s' "$CODEX_API_KEY" "$OPENAI_API_KEY" "$OPENAI_ADMIN_KEY" > '${observedKey}'\nprintf '%s\\n' '{"type":"turn.completed"}'\n`,
    );
    chmodSync(executable, 0o755);
    const store = new WorkOrderStore(new Database(":memory:"));
    const workOrder = readyDirectoryGoal(store, directory);
    const runner = new CodexExecutionRunner(executable, "paid-test-key");

    const previousApiKey = process.env.OPENAI_API_KEY;
    const previousAdminKey = process.env.OPENAI_ADMIN_KEY;
    process.env.OPENAI_API_KEY = "must-not-leak";
    process.env.OPENAI_ADMIN_KEY = "admin-must-not-leak";
    try {
      const subscription = await runner.start({
        workOrder,
        workspacePath: directory,
        billingMode: "subscription",
      });
      for await (const _event of subscription.events) {
        // Consume the process output so the fake command exits.
      }
      expect(await Bun.file(observedKey).text()).toBe("||");

      const paid = await runner.start({
        workOrder,
        workspacePath: directory,
        billingMode: "paid_api",
      });
      for await (const _event of paid.events) {
        // Consume the process output so the fake command exits.
      }
      expect(await Bun.file(observedKey).text()).toBe("paid-test-key||");
    } finally {
      if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousApiKey;
      if (previousAdminKey === undefined) delete process.env.OPENAI_ADMIN_KEY;
      else process.env.OPENAI_ADMIN_KEY = previousAdminKey;
    }
  });
});
