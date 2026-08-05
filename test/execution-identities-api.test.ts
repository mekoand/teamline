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
import { LocalCodexIdentityEnvironment } from "../src/execution-identity-environment";
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
  };
  return { environment, homes, removed, inspectedHomes };
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
      timeoutMs: 1_000,
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
