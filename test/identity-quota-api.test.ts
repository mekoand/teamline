import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import type { ExecutionIdentity } from "../src/execution-identity";
import {
  CodexExecutionIdentityResourceProvider,
  type CodexResourceSignal,
} from "../src/resource-provider";
import { WorkOrderStore } from "../src/work-order-store";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "teamline-identity-quota-"));
  temporaryDirectories.push(directory);
  return directory;
}

function managedIdentity(store: WorkOrderStore, id: string, label: string) {
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

function quotaSignal(input: {
  shortUsed?: number | null;
  longUsed?: number | null;
  status?: CodexResourceSignal["status"];
  observedAt?: string;
} = {}): CodexResourceSignal {
  const now = Date.now();
  return {
    status: input.status ?? "available",
    source: "codex-app-server",
    observedAt: input.observedAt ?? new Date(now).toISOString(),
    message: input.status === "conflict" ? "额度窗口冲突" : null,
    shortWindow: input.shortUsed === null
      ? null
      : {
          usedPercent: input.shortUsed ?? 20,
          windowMinutes: 300,
          resetsAt: new Date(now + 3 * 60 * 60_000).toISOString(),
        },
    longWindow: input.longUsed === null
      ? null
      : {
          usedPercent: input.longUsed ?? 35,
          windowMinutes: 10_080,
          resetsAt: new Date(now + 6 * 24 * 60 * 60_000).toISOString(),
        },
  };
}

describe("Codex identity quota monitoring", () => {
  test("recommends only a complete healthy backup and persists each account independently", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const backupId = "61111111-1111-4111-8111-111111111111";
    const disabledId = "61222222-2222-4222-8222-222222222222";
    managedIdentity(store, backupId, "备用");
    managedIdentity(store, disabledId, "停用");
    store.setExecutionIdentityEnabled(disabledId, false);
    const calls: string[] = [];
    const app = createApp({
      store,
      identityResourceProvider: {
        async read(identity) {
          calls.push(identity.id);
          return identity.id === backupId
            ? quotaSignal({ shortUsed: 25, longUsed: 40 })
            : quotaSignal({ shortUsed: 10, longUsed: 15 });
        },
      },
    });

    const response = await app.fetch(new Request("http://teamline.local/api/resources"));
    const resources = await response.json();
    const backup = resources.codexAccounts.find(
      (account: { identity: { id: string } }) => account.identity.id === backupId,
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([backupId]);
    expect(backup).toMatchObject({
      backupStatus: "available",
      backupLabel: "备用账号可用",
      quota: {
        status: "available",
        shortWindow: { usedPercent: 25 },
        longWindow: { usedPercent: 40 },
      },
    });
    expect(store.getExecutionIdentityQuotaSnapshot(backupId)).toMatchObject({
      executionIdentityId: backupId,
      signal: {
        shortWindow: { usedPercent: 25 },
        longWindow: { usedPercent: 40 },
      },
    });
    expect(store.getDefaultExecutionIdentityId()).toBe("codex-system-default");
  });

  test("keeps missing, stale, conflicting, and zero windows distinct", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const weeklyOnlyId = "62222222-2222-4222-8222-222222222222";
    const staleId = "63333333-3333-4333-8333-333333333333";
    const conflictId = "64444444-4444-4444-8444-444444444444";
    const zeroId = "65555555-5555-4555-8555-555555555555";
    for (const [id, label] of [
      [weeklyOnlyId, "只有周额度"],
      [staleId, "陈旧"],
      [conflictId, "冲突"],
      [zeroId, "已用完"],
    ] as const) {
      managedIdentity(store, id, label);
    }
    const signals = new Map<string, CodexResourceSignal>([
      [weeklyOnlyId, quotaSignal({ shortUsed: null, longUsed: 20 })],
      [staleId, quotaSignal({ observedAt: new Date(Date.now() - 10 * 60_000).toISOString() })],
      [conflictId, quotaSignal({ status: "conflict", shortUsed: null, longUsed: null })],
      [zeroId, quotaSignal({ shortUsed: 100, longUsed: 20 })],
    ]);
    const app = createApp({
      store,
      identityResourceProvider: {
        async read(identity) {
          return signals.get(identity.id) ?? quotaSignal();
        },
      },
    });

    const accounts = (await (
      await app.fetch(new Request("http://teamline.local/api/resources"))
    ).json()).codexAccounts;
    const byId = new Map(accounts.map(
      (account: { identity: { id: string } }) => [account.identity.id, account],
    ));

    expect(byId.get(weeklyOnlyId)).toMatchObject({
      backupStatus: "unknown",
      backupLabel: "备用账号额度未知",
      quota: { status: "available", shortWindow: null, longWindow: { usedPercent: 20 } },
    });
    expect(byId.get(staleId)).toMatchObject({
      backupStatus: "unknown",
      quota: { status: "stale", shortWindow: null, longWindow: null },
    });
    expect(byId.get(conflictId)).toMatchObject({
      backupStatus: "unknown",
      quota: { status: "conflict", shortWindow: null, longWindow: null },
    });
    expect(byId.get(zeroId)).toMatchObject({
      backupStatus: "insufficient",
      backupLabel: "备用账号额度不足",
      quota: { status: "available", shortWindow: { usedPercent: 100 } },
    });
  });

  test("does not overwrite the last snapshot after an observation failure", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const backupId = "66666666-6666-4666-8666-666666666666";
    managedIdentity(store, backupId, "备用");
    const healthy = quotaSignal({ shortUsed: 30, longUsed: 45 });
    let fail = false;
    const app = createApp({
      store,
      identityResourceProvider: {
        async read(identity) {
          if (identity.id === backupId && fail) throw new Error("temporary failure");
          return identity.id === backupId ? healthy : quotaSignal();
        },
      },
    });

    await app.fetch(new Request("http://teamline.local/api/resources"));
    const saved = store.getExecutionIdentityQuotaSnapshot(backupId);
    fail = true;
    const resources = await (
      await app.fetch(new Request("http://teamline.local/api/resources"))
    ).json();
    const backup = resources.codexAccounts.find(
      (account: { identity: { id: string } }) => account.identity.id === backupId,
    );

    expect(backup).toMatchObject({
      backupStatus: "unknown",
      quota: {
        status: "stale",
        message: "本次额度读取失败，上次数据已保留，等待重新读取",
        shortWindow: null,
        longWindow: null,
      },
    });
    expect(store.getExecutionIdentityQuotaSnapshot(backupId)).toEqual(saved);
  });

  test("falls back to the persisted snapshot when the provider returns an error", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const backupId = "66888888-8888-4888-8888-888888888888";
    managedIdentity(store, backupId, "备用");
    const healthy = quotaSignal({ shortUsed: 30, longUsed: 45 });
    let failed = false;
    const app = createApp({
      store,
      identityResourceProvider: {
        async read(identity) {
          if (identity.id === backupId && failed) {
            return {
              status: "error",
              source: "codex-app-server",
              observedAt: new Date().toISOString(),
              message: "Codex 额度读取失败",
              shortWindow: null,
              longWindow: null,
            };
          }
          return identity.id === backupId ? healthy : quotaSignal();
        },
      },
    });

    await app.fetch(new Request("http://teamline.local/api/resources"));
    const saved = store.getExecutionIdentityQuotaSnapshot(backupId);
    failed = true;
    const resources = await (
      await app.fetch(new Request("http://teamline.local/api/resources"))
    ).json();
    const backup = resources.codexAccounts.find(
      (account: { identity: { id: string } }) => account.identity.id === backupId,
    );

    expect(backup).toMatchObject({
      backupStatus: "unknown",
      quota: {
        status: "stale",
        shortWindow: null,
        longWindow: null,
      },
    });
    expect(store.getExecutionIdentityQuotaSnapshot(backupId)).toEqual(saved);
  });

  test("uses the enabled default identity for the legacy Codex summary", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const backupId = "66999999-9999-4999-8999-999999999999";
    managedIdentity(store, backupId, "主用账号");
    store.setDefaultExecutionIdentityId(backupId);
    store.setExecutionIdentityEnabled("codex-system-default", false);
    let systemReads = 0;
    let openAIOnlyReads = 0;
    const app = createApp({
      store,
      resourceProvider: {
        async read() {
          systemReads += 1;
          throw new Error("disabled system identity must not be read");
        },
        async readWithoutCodex() {
          openAIOnlyReads += 1;
          const observedAt = new Date().toISOString();
          return {
            observedAt,
            codex: {
              status: "unavailable",
              source: "codex-app-server",
              observedAt,
              message: "系统 Codex 账号未启用",
              shortWindow: null,
              longWindow: null,
            },
            openaiApi: {
              status: "not_connected",
              source: "openai-usage-api",
              observedAt,
              message: "未连接",
              scope: null,
              usage: null,
            },
            workOrderUsage: [],
          };
        },
      },
      identityResourceProvider: {
        async read(identity) {
          expect(identity.id).toBe(backupId);
          return quotaSignal({ shortUsed: 18, longUsed: 29 });
        },
      },
    });

    const resources = await (
      await app.fetch(new Request("http://teamline.local/api/resources"))
    ).json();

    expect(resources.codex).toMatchObject({
      status: "available",
      shortWindow: { usedPercent: 18 },
      longWindow: { usedPercent: 29 },
    });
    expect(resources.codexAccounts).toHaveLength(1);
    expect(systemReads).toBe(0);
    expect(openAIOnlyReads).toBe(1);
    expect(resources.codexAccounts[0]).toMatchObject({
      identity: { id: backupId, isDefault: true },
      backupStatus: "current",
    });
  });

  test("shows the running account separately from the default account", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const defaultId = "67000000-0000-4000-8000-000000000000";
    managedIdentity(store, defaultId, "默认账号");
    store.setDefaultExecutionIdentityId(defaultId);
    store.setCurrentExecutionIdentityId("codex-system-default");
    const app = createApp({
      store,
      resourceProvider: {
        async read() {
          const observedAt = new Date().toISOString();
          return {
            observedAt,
            codex: quotaSignal({ shortUsed: 12, longUsed: 24 }),
            openaiApi: {
              status: "not_connected" as const,
              source: null,
              observedAt,
              message: "未连接",
              scope: null,
              usage: null,
            },
            workOrderUsage: [],
          };
        },
      },
      identityResourceProvider: {
        async read(identity) {
          return quotaSignal({ shortUsed: 42, longUsed: 54 });
        },
      },
    });

    const resources = await (
      await app.fetch(new Request("http://teamline.local/api/resources"))
    ).json();
    const accounts = new Map(resources.codexAccounts.map(
      (account: { identity: { id: string } }) => [account.identity.id, account],
    ));

    expect(resources.codex).toMatchObject({
      shortWindow: { usedPercent: 12 },
      longWindow: { usedPercent: 24 },
    });
    expect(accounts.get("codex-system-default")).toMatchObject({
      identity: { isDefault: false },
      backupStatus: "current",
      backupLabel: "当前账号",
    });
    expect(accounts.get(defaultId)).toMatchObject({
      identity: { isDefault: true },
      backupStatus: "available",
      backupLabel: "备用账号可用",
    });
  });

  test("reads each identity through its own CODEX_HOME", async () => {
    const directory = temporaryDirectory();
    const executable = join(directory, "fake-codex");
    const observedHomes = join(directory, "homes.txt");
    const reset = Math.floor(Date.now() / 1_000) + 60 * 60;
    writeFileSync(
      executable,
      `#!/bin/sh\nprintf '%s\\n' "$CODEX_HOME" >> '${observedHomes}'\nread initialize\nread initialized\nread rate_limits\nprintf '%s\\n' '{"id":6,"result":{"rateLimits":{"primary":{"usedPercent":10,"windowDurationMins":300,"resetsAt":${reset}}}}}'\n`,
    );
    chmodSync(executable, 0o755);
    const provider = new CodexExecutionIdentityResourceProvider(
      executable,
      join(directory, "system-home"),
    );
    const managedHome = join(directory, "managed-home");
    const managed: ExecutionIdentity = {
      id: "67777777-7777-4777-8777-777777777777",
      tool: "codex",
      label: "备用",
      status: "enabled",
      homeKind: "managed",
      managedHomePath: managedHome,
      accountFingerprint: null,
      loginState: "ready",
      capabilities: [],
      lastObservedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      removedAt: null,
    };

    await provider.read(managed);

    expect((await Bun.file(observedHomes).text()).trim()).toBe(managedHome);
  });
});
