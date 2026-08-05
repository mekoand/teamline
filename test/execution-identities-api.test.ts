import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import type { ExecutionIdentityEnvironment } from "../src/execution-identity-environment";
import {
  ExecutionIdentityLoginInProgressError,
  LocalCodexIdentityEnvironment,
  type ExecutionIdentityLoginOperation,
} from "../src/execution-identity-environment";
import { WorkOrderStore } from "../src/work-order-store";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "teamline-identities-"));
  temporaryDirectories.push(directory);
  return join(directory, "teamline.db");
}

function fakeEnvironment() {
  const homes = new Set<string>();
  const removed: string[] = [];
  const inspectedHomes: string[] = [];
  const loginOperations = new Map<string, ExecutionIdentityLoginOperation>();
  const environment: ExecutionIdentityEnvironment = {
    async create(identityId) {
      homes.add(identityId);
      return { managedHomePath: `/managed-codex/${identityId}` };
    },
    async remove(identityId) {
      homes.delete(identityId);
      removed.push(identityId);
    },
    async inspect(identity) {
      inspectedHomes.push(identity.managedHomePath ?? "system");
      return {
        accountFingerprint: "private-account-fingerprint",
        loginState: "ready",
        capabilities: ["sessions", "app-server"],
        observedAt: "2026-08-05T04:00:00.000Z",
      };
    },
    async startLogin(identity) {
      if (loginOperations.get(identity.id)?.status === "in_progress") {
        throw new ExecutionIdentityLoginInProgressError("Codex 登录正在进行中");
      }
      const operation = {
        status: "in_progress" as const,
        startedAt: "2026-08-05T04:01:00.000Z",
      };
      loginOperations.set(identity.id, operation);
      return operation;
    },
    getLoginStatus(identityId) {
      return loginOperations.get(identityId) ?? { status: "idle" };
    },
  };
  return {
    environment,
    homes,
    removed,
    inspectedHomes,
    loginOperations,
  };
}

describe("execution identity API", () => {
  test("creates and removes only the selected managed Codex home", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-managed-homes-"));
    temporaryDirectories.push(root);
    const executable = join(root, "fake-codex");
    const observedHome = join(root, "observed-home.txt");
    writeFileSync(
      executable,
      `#!/bin/sh
printf '%s' "$CODEX_HOME" > '${observedHome}'
while IFS= read -r line; do
  case "$line" in
    *account/read*) printf '%s\n' '{"id":2,"result":{"account":{"type":"chatgpt","planType":"pro"}}}'; break ;;
  esac
done
`,
    );
    chmodSync(executable, 0o755);
    const environment = new LocalCodexIdentityEnvironment(root, {
      executable,
      systemHome: join(root, "system"),
      timeoutMs: 5_000,
    });
    const firstId = "11111111-1111-4111-8111-111111111111";
    const secondId = "22222222-2222-4222-8222-222222222222";
    const first = await environment.create(firstId);
    const second = await environment.create(secondId);
    mkdirSync(join(first.managedHomePath, "nested"));
    writeFileSync(join(first.managedHomePath, "nested", "auth.json"), "test only");
    const observed = await environment.inspect({
      id: firstId,
      tool: "codex",
      label: "个人",
      status: "enabled",
      homeKind: "managed",
      managedHomePath: first.managedHomePath,
      accountFingerprint: null,
      loginState: "signed_out",
      capabilities: [],
      lastObservedAt: null,
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
      removedAt: null,
    });

    expect(readFileSync(observedHome, "utf8")).toBe(first.managedHomePath);
    expect(observed).toEqual(
      expect.objectContaining({
        loginState: "ready",
        capabilities: ["app-server", "sessions"],
      }),
    );
    expect(observed.accountFingerprint).toHaveLength(12);

    await environment.remove(firstId);

    expect(existsSync(first.managedHomePath)).toBe(false);
    expect(existsSync(second.managedHomePath)).toBe(true);
    await expect(environment.remove("../outside")).rejects.toThrow(
      "Codex 账号标识无效",
    );
  });

  test("runs and reaps only the managed Codex login processes it starts", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-managed-login-"));
    temporaryDirectories.push(root);
    const executable = join(root, "fake-codex");
    const observedHome = join(root, "login-home.txt");
    const release = join(root, "release-login");
    const fail = join(root, "fail-login");
    writeFileSync(
      executable,
      `#!/bin/sh
if [ "$1" = "login" ]; then
  printf '%s' "$CODEX_HOME" > '${observedHome}'
  while [ ! -f '${release}' ]; do sleep 0.02; done
  if [ -f '${fail}' ]; then exit 7; fi
  exit 0
fi
exit 2
`,
    );
    chmodSync(executable, 0o755);
    const environment = new LocalCodexIdentityEnvironment(root, {
      executable,
      systemHome: join(root, "system"),
    });
    const id = "33333333-3333-4333-8333-333333333333";
    const created = await environment.create(id);
    const identity = {
      id,
      tool: "codex" as const,
      label: "个人",
      status: "enabled" as const,
      homeKind: "managed" as const,
      managedHomePath: created.managedHomePath,
      accountFingerprint: null,
      loginState: "signed_out" as const,
      capabilities: [],
      lastObservedAt: null,
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
      removedAt: null,
    };

    expect(await environment.startLogin(identity)).toEqual(
      expect.objectContaining({ status: "in_progress" }),
    );
    await waitFor(() => existsSync(observedHome));
    expect(readFileSync(observedHome, "utf8")).toBe(created.managedHomePath);
    await expect(environment.startLogin(identity)).rejects.toBeInstanceOf(
      ExecutionIdentityLoginInProgressError,
    );

    writeFileSync(release, "done");
    await waitFor(() => environment.getLoginStatus(id).status === "completed");
    expect(environment.getLoginStatus(id)).toEqual(
      expect.objectContaining({ status: "completed" }),
    );

    rmSync(release);
    writeFileSync(fail, "fail");
    await environment.startLogin(identity);
    writeFileSync(release, "done");
    await waitFor(() => environment.getLoginStatus(id).status === "failed");
    expect(environment.getLoginStatus(id)).toEqual(
      expect.objectContaining({
        status: "failed",
        error: "Codex 登录未成功完成，请重试",
      }),
    );

    rmSync(release);
    rmSync(fail);
    await environment.startLogin(identity);
    await waitFor(() => environment.getLoginStatus(id).status === "in_progress");
    await environment.remove(id);
    expect(existsSync(created.managedHomePath)).toBe(false);
    expect(environment.getLoginStatus(id)).toEqual({ status: "idle" });

    rmSync(release, { force: true });
    const timeoutEnvironment = new LocalCodexIdentityEnvironment(
      join(root, "timeout-identities"),
      {
        executable,
        systemHome: join(root, "system"),
        loginTimeoutMs: 40,
      },
    );
    const timeoutId = "55555555-5555-4555-8555-555555555555";
    const timeoutHome = await timeoutEnvironment.create(timeoutId);
    await timeoutEnvironment.startLogin({
      ...identity,
      id: timeoutId,
      managedHomePath: timeoutHome.managedHomePath,
    });
    await waitFor(
      () => timeoutEnvironment.getLoginStatus(timeoutId).status === "failed",
    );
    expect(timeoutEnvironment.getLoginStatus(timeoutId)).toEqual(
      expect.objectContaining({
        status: "failed",
        error: "Codex 登录已超时，请重试",
      }),
    );
    await timeoutEnvironment.close();
  });

  test("migrates an existing single-account database without losing goals", () => {
    const databasePath = temporaryDatabase();
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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO work_orders (
        id, title, repository_path, goal, acceptance, status,
        current_summary, plan_json, created_at, updated_at
      ) VALUES (
        'legacy-goal', '已有目标', '/tmp/teamline', '保留已有目标', NULL,
        'draft', '等待生成执行计划', NULL,
        '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
      );
    `);
    legacy.close();

    const store = new WorkOrderStore(new Database(databasePath));
    expect(store.get("legacy-goal")?.title).toBe("已有目标");
    expect(store.listExecutionIdentities()).toEqual([
      expect.objectContaining({
        id: "codex-system-default",
        label: "Codex",
        status: "enabled",
        homeKind: "system",
        loginState: "unknown",
      }),
    ]);
    expect(store.getDefaultExecutionIdentityId()).toBe("codex-system-default");
    expect(() => store.removeExecutionIdentity("codex-system-default")).toThrow(
      "系统 Codex 账号只能停用",
    );
    store.database.close();
  });

  test("persists independent identities and supports lifecycle operations without exposing secrets", async () => {
    const databasePath = temporaryDatabase();
    const store = new WorkOrderStore(new Database(databasePath, { create: true }));
    const fake = fakeEnvironment();
    const app = createApp({ store, executionIdentityEnvironment: fake.environment });

    const firstResponse = await app.fetch(
      new Request("http://teamline.local/api/execution-identities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "个人" }),
      }),
    );
    const first = await firstResponse.json();
    expect(firstResponse.status).toBe(201);
    expect(first.identity).toEqual(
      expect.objectContaining({
        label: "个人",
        status: "enabled",
        homeKind: "managed",
        loginState: "signed_out",
        executable: false,
      }),
    );
    expect(first.identity.managedHomePath).toBeUndefined();
    expect(first.identity.accountFingerprint).toBeUndefined();

    const secondResponse = await app.fetch(
      new Request("http://teamline.local/api/execution-identities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "工作" }),
      }),
    );
    const second = await secondResponse.json();
    expect(secondResponse.status).toBe(201);
    expect(fake.homes).toEqual(new Set([first.identity.id, second.identity.id]));

    const refreshedResponse = await app.fetch(
      new Request(
        `http://teamline.local/api/execution-identities/${first.identity.id}/refresh`,
        { method: "POST" },
      ),
    );
    expect(refreshedResponse.status).toBe(200);
    expect(fake.inspectedHomes).toEqual([
      `/managed-codex/${first.identity.id}`,
    ]);
    await app.fetch(
      new Request(
        `http://teamline.local/api/execution-identities/${first.identity.id}/disable`,
        { method: "POST" },
      ),
    );
    const enabledResponse = await app.fetch(
      new Request(
        `http://teamline.local/api/execution-identities/${first.identity.id}/enable`,
        { method: "POST" },
      ),
    );
    expect((await enabledResponse.json()).identity).toEqual(
      expect.objectContaining({ status: "enabled", loginState: "ready", executable: true }),
    );

    const renamedResponse = await app.fetch(
      new Request(
        `http://teamline.local/api/execution-identities/${second.identity.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ label: "备用" }),
        },
      ),
    );
    expect((await renamedResponse.json()).identity.label).toBe("备用");

    const exported = await (
      await app.fetch(new Request("http://teamline.local/api/local-state/export"))
    ).text();
    expect(exported).not.toContain("private-account-fingerprint");
    expect(exported).not.toContain("/managed-codex/");

    store.database.close();
    const reopenedStore = new WorkOrderStore(new Database(databasePath));
    const reopened = createApp({
      store: reopenedStore,
      executionIdentityEnvironment: fake.environment,
    });
    const list = await (
      await reopened.fetch(new Request("http://teamline.local/api/execution-identities"))
    ).json();
    expect(list.identities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: first.identity.id,
          label: "个人",
          loginState: "ready",
          capabilities: ["app-server", "sessions"],
        }),
        expect.objectContaining({
          id: second.identity.id,
          label: "备用",
          loginState: "signed_out",
        }),
      ]),
    );
    expect(JSON.stringify(list)).not.toContain("private-account-fingerprint");
    expect(JSON.stringify(list)).not.toContain("/managed-codex/");

    const unconfirmed = await reopened.fetch(
      new Request(
        `http://teamline.local/api/execution-identities/${first.identity.id}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      ),
    );
    expect(unconfirmed.status).toBe(400);
    expect(fake.removed).toEqual([]);

    const removedResponse = await reopened.fetch(
      new Request(
        `http://teamline.local/api/execution-identities/${first.identity.id}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirm: true }),
        },
      ),
    );
    const removed = await removedResponse.json();
    expect(removedResponse.status).toBe(200);
    expect(removed.identity).toEqual(
      expect.objectContaining({
        id: first.identity.id,
        label: "个人",
        status: "removed",
        loginState: "signed_out",
        executable: false,
      }),
    );
    expect(fake.removed).toEqual([first.identity.id]);
    expect(reopenedStore.getExecutionIdentity(first.identity.id)).toEqual(
      expect.objectContaining({
        managedHomePath: null,
        accountFingerprint: null,
        capabilities: [],
      }),
    );
    reopenedStore.database.close();
  });

  test("starts, polls, deduplicates, and refreshes a managed login without exposing secrets", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const fake = fakeEnvironment();
    const app = createApp({ store, executionIdentityEnvironment: fake.environment });
    const createdResponse = await app.fetch(
      new Request("http://teamline.local/api/execution-identities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "个人" }),
      }),
    );
    const created = await createdResponse.json();
    const loginUrl = `http://teamline.local/api/execution-identities/${created.identity.id}/login`;

    expect(await (await app.fetch(new Request(loginUrl))).json()).toEqual({
      login: { status: "idle" },
    });
    const startedResponse = await app.fetch(
      new Request(loginUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      }),
    );
    const startedText = await startedResponse.text();
    expect(startedResponse.status).toBe(202);
    expect(JSON.parse(startedText)).toEqual(
      expect.objectContaining({
        login: {
          status: "in_progress",
          startedAt: "2026-08-05T04:01:00.000Z",
        },
        identity: expect.objectContaining({ id: created.identity.id }),
      }),
    );
    expect(startedText).not.toContain("/managed-codex/");
    expect(startedText).not.toContain("token");
    expect(startedText).not.toContain("cookie");
    expect(startedText).not.toContain("auth.json");

    const duplicateResponse = await app.fetch(
      new Request(loginUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      }),
    );
    expect(duplicateResponse.status).toBe(409);
    expect(await duplicateResponse.json()).toEqual(
      expect.objectContaining({ code: "EXECUTION_IDENTITY_LOGIN_IN_PROGRESS" }),
    );

    fake.loginOperations.set(created.identity.id, {
      status: "completed",
      startedAt: "2026-08-05T04:01:00.000Z",
      finishedAt: "2026-08-05T04:02:00.000Z",
    });
    expect(await (await app.fetch(new Request(loginUrl))).json()).toEqual({
      login: {
        status: "completed",
        startedAt: "2026-08-05T04:01:00.000Z",
        finishedAt: "2026-08-05T04:02:00.000Z",
      },
    });

    const refreshedResponse = await app.fetch(
      new Request(
        `http://teamline.local/api/execution-identities/${created.identity.id}/refresh`,
        { method: "POST" },
      ),
    );
    expect((await refreshedResponse.json()).identity).toEqual(
      expect.objectContaining({ loginState: "ready", executable: true }),
    );

    fake.loginOperations.set(created.identity.id, {
      status: "failed",
      startedAt: "2026-08-05T04:03:00.000Z",
      finishedAt: "2026-08-05T04:03:01.000Z",
      error: "Codex 登录未成功完成，请重试",
    });
    expect(await (await app.fetch(new Request(loginUrl))).json()).toEqual({
      login: expect.objectContaining({
        status: "failed",
        error: "Codex 登录未成功完成，请重试",
      }),
    });
  });

  test("rejects login when the identity or environment cannot support it", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const id = "44444444-4444-4444-8444-444444444444";
    store.createManagedExecutionIdentity({
      id,
      label: "个人",
      managedHomePath: `/managed-codex/${id}`,
    });
    const unavailable = createApp({ store });
    const loginUrl = `http://teamline.local/api/execution-identities/${id}/login`;

    const unavailableResponse = await unavailable.fetch(
      new Request(loginUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      }),
    );
    expect(unavailableResponse.status).toBe(503);
    expect(await unavailableResponse.json()).toEqual(
      expect.objectContaining({ code: "IDENTITY_ENVIRONMENT_UNAVAILABLE" }),
    );

    const fake = fakeEnvironment();
    const app = createApp({ store, executionIdentityEnvironment: fake.environment });
    store.setExecutionIdentityEnabled(id, false);
    const disabledResponse = await app.fetch(
      new Request(loginUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      }),
    );
    expect(disabledResponse.status).toBe(409);
    expect(await disabledResponse.json()).toEqual(
      expect.objectContaining({ code: "EXECUTION_IDENTITY_DISABLED" }),
    );

    const systemResponse = await app.fetch(
      new Request(
        "http://teamline.local/api/execution-identities/codex-system-default/login",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirm: true }),
        },
      ),
    );
    expect(systemResponse.status).toBe(409);
    expect(await systemResponse.json()).toEqual(
      expect.objectContaining({ code: "EXECUTION_IDENTITY_LOGIN_UNSUPPORTED" }),
    );

    store.setExecutionIdentityEnabled(id, true);
    store.recordExecutionIdentityObservation(id, {
      loginState: "ready",
      capabilities: ["sessions"],
    });
    const authenticatedResponse = await app.fetch(
      confirmedLoginRequest(loginUrl),
    );
    expect(authenticatedResponse.status).toBe(409);
    expect(await authenticatedResponse.json()).toEqual(
      expect.objectContaining({
        code: "EXECUTION_IDENTITY_ALREADY_AUTHENTICATED",
      }),
    );

    const active = store.create({
      workspace: { kind: "directory", path: "/tmp/teamline-active-login-test" },
      goal: "正在运行",
      executionIdentityId: id,
    });
    store.savePlan(active.id, [
      { outcome: "完成", scope: "测试", verification: "检查" },
    ]);
    store.markStarted(active.id);
    store.recordExecutionIdentityObservation(id, {
      loginState: "signed_out",
      capabilities: [],
    });
    const busyResponse = await app.fetch(confirmedLoginRequest(loginUrl));
    expect(busyResponse.status).toBe(409);
    expect(await busyResponse.json()).toEqual(
      expect.objectContaining({ code: "EXECUTION_IDENTITY_BUSY" }),
    );

    const confirmationId = "66666666-6666-4666-8666-666666666666";
    store.createManagedExecutionIdentity({
      id: confirmationId,
      label: "待确认",
      managedHomePath: `/managed-codex/${confirmationId}`,
    });
    const confirmationUrl =
      `http://teamline.local/api/execution-identities/${confirmationId}/login`;
    const simplePostResponse = await app.fetch(
      new Request(confirmationUrl, { method: "POST" }),
    );
    expect(simplePostResponse.status).toBe(400);
    expect(await simplePostResponse.json()).toEqual(
      expect.objectContaining({
        code: "EXECUTION_IDENTITY_LOGIN_CONFIRMATION_REQUIRED",
      }),
    );
    const unconfirmedResponse = await app.fetch(
      new Request(confirmationUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: false }),
      }),
    );
    expect(unconfirmedResponse.status).toBe(400);
    const malformedResponse = await app.fetch(
      new Request(confirmationUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    );
    expect(malformedResponse.status).toBe(400);
    expect(await malformedResponse.json()).toEqual(
      expect.objectContaining({
        code: "EXECUTION_IDENTITY_LOGIN_CONFIRMATION_REQUIRED",
      }),
    );

    const legacyStore = new WorkOrderStore(new Database(":memory:"));
    const legacyIdentityId = "77777777-7777-4777-8777-777777777777";
    legacyStore.createManagedExecutionIdentity({
      id: legacyIdentityId,
      label: "旧运行边界",
      managedHomePath: `/managed-codex/${legacyIdentityId}`,
    });
    const legacyRun = legacyStore.create({
      workspace: { kind: "directory", path: "/tmp/teamline-legacy-login-test" },
      goal: "旧版未绑定运行",
    });
    legacyStore.savePlan(legacyRun.id, [
      { outcome: "完成", scope: "测试", verification: "检查" },
    ]);
    legacyStore.markStarted(legacyRun.id);
    expect(legacyStore.get(legacyRun.id)?.executionIdentityId).toBeNull();
    const legacyApp = createApp({
      store: legacyStore,
      executionIdentityEnvironment: fakeEnvironment().environment,
    });
    const legacyBusyResponse = await legacyApp.fetch(
      confirmedLoginRequest(
        `http://teamline.local/api/execution-identities/${legacyIdentityId}/login`,
      ),
    );
    expect(legacyBusyResponse.status).toBe(409);
    expect(await legacyBusyResponse.json()).toEqual(
      expect.objectContaining({ code: "EXECUTION_IDENTITY_BUSY" }),
    );
  });

  test("cleans up a prepared managed home when account creation is invalid", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const fake = fakeEnvironment();
    const app = createApp({ store, executionIdentityEnvironment: fake.environment });
    const response = await app.fetch(
      new Request("http://teamline.local/api/execution-identities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "" }),
      }),
    );
    expect(response.status).toBe(400);
    expect(fake.homes.size).toBe(0);
    expect(fake.removed).toHaveLength(1);
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(10);
  }
}

function confirmedLoginRequest(url: string): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: true }),
  });
}
