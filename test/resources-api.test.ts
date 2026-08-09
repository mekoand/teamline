import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import {
  CodexAppServerResourceProvider,
  OpenAIOrganizationUsageProvider,
  type ResourceProvider,
} from "../src/resource-provider";
import { createServerResourceProvider } from "../src/server-resources";
import { WorkOrderStore } from "../src/work-order-store";

describe("resource API", () => {
  test("returns reliable Codex windows, account API usage, and attributed work-order usage", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const workOrder = store.create({
      repositoryPath: "/tmp/teamline",
      goal: "整理资源页面",
    });
    const observedAt = "2026-08-03T04:00:00.000Z";
    const provider: ResourceProvider = {
      async read() {
        return {
          observedAt,
          codex: {
            status: "available",
            source: "codex-app-server",
            observedAt,
            message: null,
            shortWindow: {
              usedPercent: 24,
              windowMinutes: 300,
              resetsAt: "2026-08-03T07:00:00.000Z",
            },
            longWindow: {
              usedPercent: 41,
              windowMinutes: 10_080,
              resetsAt: "2026-08-09T04:00:00.000Z",
            },
          },
          openaiApi: {
            status: "available",
            source: "openai-usage-api",
            observedAt,
            message: null,
            scope: "organization",
            usage: {
              amount: 12.5,
              unit: "usd",
              periodStart: "2026-08-01T00:00:00.000Z",
              periodEnd: "2026-08-03T04:00:00.000Z",
            },
          },
          workOrderUsage: [
            {
              workOrderId: workOrder.id,
              amount: 3.25,
              unit: "usd",
              observedAt,
              source: "openai-usage-api",
            },
          ],
        };
      },
    };
    const app = createApp({ store, resourceProvider: provider });

    const response = await app.fetch(
      new Request("http://teamline.local/api/resources"),
    );
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result).toEqual({
      observedAt,
      sessionMonitoringUsage: [],
      runningCount: 0,
      codex: {
        status: "available",
        source: "codex-app-server",
        observedAt,
        message: null,
        shortWindow: {
          usedPercent: 24,
          windowMinutes: 300,
          resetsAt: "2026-08-03T07:00:00.000Z",
        },
        longWindow: {
          usedPercent: 41,
          windowMinutes: 10_080,
          resetsAt: "2026-08-09T04:00:00.000Z",
        },
      },
      openaiApi: {
        status: "available",
        source: "openai-usage-api",
        observedAt,
        message: null,
        scope: "organization",
        usage: {
          amount: 12.5,
          unit: "usd",
          periodStart: "2026-08-01T00:00:00.000Z",
          periodEnd: "2026-08-03T04:00:00.000Z",
        },
      },
      paidApi: {
        available: false,
        budget: { monthlyBudgetUsd: null },
        note:
          "用量由提供方延迟回传，Teamline 会在观察到限额后停止后续付费节点，但当前节点仍可能产生少量超支。",
      },
      workOrders: [
        {
          id: workOrder.id,
          title: "整理资源页面",
          status: "planning",
          priority: "normal",
          pace: "balanced",
          maxRunMinutes: 60,
          runWhenQuotaAvailable: false,
          autoRunReason: null,
          paidApiFallbackEnabled: false,
          paidApiLimitUsd: null,
          usage: {
            status: "available",
            amount: 3.25,
            unit: "usd",
            observedAt,
            source: "openai-usage-api",
          },
          recommendation: "先确认计划，再安排运行",
          recommendationMessage: {
            code: "resource.recommendation.confirm_plan",
            params: {},
          },
        },
      ],
    });
  });

  test("uses the saved concurrency limit when presenting resource-page status", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    store.saveMaxConcurrency(1);
    const running = store.create({
      repositoryPath: "/tmp/teamline-running",
      goal: "正在运行的目标",
    });
    store.savePlan(running.id, [
      { outcome: "完成运行", scope: "src", verification: "人工检查" },
    ]);
    store.markStarted(running.id);
    const ready = store.create({
      repositoryPath: "/tmp/teamline-ready",
      goal: "等待运行的目标",
    });
    store.savePlan(ready.id, [
      { outcome: "完成等待项", scope: "src", verification: "人工检查" },
    ]);
    const observedAt = "2026-08-03T04:00:00.000Z";
    const app = createApp({
      store,
      resourceProvider: {
        async read() {
          return {
            observedAt,
            codex: {
              status: "available" as const,
              source: "codex-app-server" as const,
              observedAt,
              message: null,
              shortWindow: null,
              longWindow: null,
            },
            openaiApi: {
              status: "not_connected" as const,
              source: "openai-usage-api" as const,
              observedAt,
              message: "未连接",
              scope: null,
              usage: null,
            },
            workOrderUsage: [],
          };
        },
      },
    });

    const result = await (
      await app.fetch(new Request("http://teamline.local/api/resources"))
    ).json();
    const presentedReady = result.workOrders.find(
      (workOrder: { id: string }) => workOrder.id === ready.id,
    );

    expect(presentedReady).toMatchObject({
      status: "queued",
      recommendation: "等待当前运行结束",
    });
  });

  test("reads Codex subscription windows through the local app-server protocol", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-resource-test-"));
    const executable = join(directory, "fake-codex");
    const shortReset = Math.floor(Date.now() / 1_000) + 60 * 60;
    const longReset = shortReset + 7 * 24 * 60 * 60;
    writeFileSync(
      executable,
      [
        "#!/bin/sh",
        "read initialize",
        "read initialized",
        "read rate_limits",
        `printf '%s\\n' '{"id":6,"result":{"rateLimits":{"limitId":"codex","primary":{"usedPercent":32,"windowDurationMins":300,"resetsAt":${shortReset}},"secondary":{"usedPercent":67,"windowDurationMins":10080,"resetsAt":${longReset}},"rateLimitReachedType":null}}}'`,
      ].join("\n"),
    );
    chmodSync(executable, 0o755);

    try {
      const app = createApp({
        store: new WorkOrderStore(new Database(":memory:")),
        resourceProvider: new CodexAppServerResourceProvider(executable),
      });
      const response = await app.fetch(
        new Request("http://teamline.local/api/resources"),
      );
      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result.codex).toEqual({
        status: "available",
        source: "codex-app-server",
        observedAt: expect.any(String),
        message: null,
        shortWindow: {
          usedPercent: 32,
          windowMinutes: 300,
          resetsAt: new Date(shortReset * 1_000).toISOString(),
        },
        longWindow: {
          usedPercent: 67,
          windowMinutes: 10_080,
          resetsAt: new Date(longReset * 1_000).toISOString(),
        },
      });
      expect(result.openaiApi).toMatchObject({
        status: "not_connected",
        scope: null,
        usage: null,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reports conflicting aggregate and named Codex quota windows", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-resource-test-"));
    const executable = join(directory, "fake-codex");
    const resetAt = Math.floor(Date.now() / 1_000) + 60 * 60;
    writeFileSync(
      executable,
      [
        "#!/bin/sh",
        "read initialize",
        "read initialized",
        "read rate_limits",
        `printf '%s\\n' '{"id":6,"result":{"rateLimits":{"primary":{"usedPercent":20,"windowDurationMins":300,"resetsAt":${resetAt}}},"rateLimitsByLimitId":{"codex":{"primary":{"usedPercent":45,"windowDurationMins":300,"resetsAt":${resetAt}}}}}}'`,
      ].join("\n"),
    );
    chmodSync(executable, 0o755);

    try {
      const app = createApp({
        store: new WorkOrderStore(new Database(":memory:")),
        resourceProvider: new CodexAppServerResourceProvider(executable),
      });
      const result = await (
        await app.fetch(new Request("http://teamline.local/api/resources"))
      ).json();

      expect(result.codex).toMatchObject({
        status: "conflict",
        message: "Codex 返回了不一致的额度窗口，等待重新读取",
        shortWindow: null,
        longWindow: null,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reports read failures and missing attribution without inventing exact values", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    store.create({ repositoryPath: "/tmp/teamline", goal: "等待可靠用量" });
    const app = createApp({
      store,
      resourceProvider: {
        async read() {
          throw new Error("credentials expired");
        },
      },
    });

    const response = await app.fetch(
      new Request("http://teamline.local/api/resources"),
    );
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.codex).toEqual({
      status: "error",
      source: "codex-app-server",
      observedAt: expect.any(String),
      message: "Codex 额度读取失败，请稍后重试",
      shortWindow: null,
      longWindow: null,
    });
    expect(result.openaiApi).toMatchObject({
      status: "not_connected",
      usage: null,
      scope: null,
    });
    expect(result.workOrders[0].usage).toEqual({
      status: "unavailable",
      message: "当前没有可归因到这个目标的用量",
      messageDescriptor: { code: "resource.usage.unattributed", params: {} },
    });
  });

  test("keeps optional OpenAI costs at account scope when they cannot be attributed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-resource-test-"));
    const executable = join(directory, "fake-codex");
    writeFileSync(
      executable,
      [
        "#!/bin/sh",
        "read initialize",
        "read initialized",
        "read rate_limits",
        `printf '%s\\n' '{"id":6,"result":{"rateLimits":{"primary":{"usedPercent":10,"windowDurationMins":300,"resetsAt":1785733200},"secondary":{"usedPercent":20,"windowDurationMins":10080,"resetsAt":1786251600}}}}'`,
      ].join("\n"),
    );
    chmodSync(executable, 0o755);
    const requests: Request[] = [];
    let apiNow = new Date("2026-08-03T04:00:00.000Z");
    const apiUsage = new OpenAIOrganizationUsageProvider(
      "sk-admin-test",
      undefined,
      async (request) => {
        requests.push(request);
        return Response.json({
          data: [
            {
              start_time: 1785542400,
              end_time: 1785628800,
              results: [
                { amount: { value: 1.25, currency: "usd" } },
                { amount: { value: 2.5, currency: "usd" } },
              ],
            },
          ],
          has_more: false,
          next_page: null,
        });
      },
      () => new Date(apiNow),
    );

    try {
      const store = new WorkOrderStore(new Database(":memory:"));
      store.create({ repositoryPath: "/tmp/teamline", goal: "检查账户用量" });
      const app = createApp({
        store,
        resourceProvider: new CodexAppServerResourceProvider(
          executable,
          5_000,
          apiUsage,
          60_000,
          5 * 60_000,
          3_000,
          () => new Date(apiNow),
        ),
      });

      const result = await (
        await app.fetch(new Request("http://teamline.local/api/resources"))
      ).json();

      expect(result.openaiApi).toEqual({
        status: "available",
        source: "openai-usage-api",
        observedAt: "2026-08-03T04:00:00.000Z",
        message: null,
        scope: "organization",
        usage: {
          amount: 3.75,
          unit: "usd",
          periodStart: "2026-08-01T00:00:00.000Z",
          periodEnd: "2026-08-03T04:00:00.000Z",
        },
      });
      expect(result.workOrders[0].usage.status).toBe("unavailable");
      expect(requests).toHaveLength(1);
      expect(requests[0]!.headers.get("authorization")).toBe(
        "Bearer sk-admin-test",
      );
      expect(requests[0]!.url).toContain(
        "/v1/organization/costs?start_time=1785542400",
      );

      apiNow = new Date("2026-08-03T04:00:30.000Z");
      const cachedResult = await (
        await app.fetch(new Request("http://teamline.local/api/resources"))
      ).json();
      expect(cachedResult.openaiApi.observedAt).toBe(
        "2026-08-03T04:00:00.000Z",
      );
      expect(requests).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reads actual costs for the configured Teamline project", async () => {
    const requests: Request[] = [];
    const now = new Date("2026-08-03T04:00:00.000Z");
    const provider = new OpenAIOrganizationUsageProvider(
      "sk-admin-test",
      "proj_teamline",
      async (request) => {
        requests.push(request);
        return Response.json({
          data: [{ results: [{ amount: { value: 2.25, currency: "usd" } }] }],
          has_more: false,
        });
      },
      () => now,
    );

    const result = await provider.read(now.toISOString());

    expect(result).toMatchObject({
      status: "available",
      scope: "project",
      usage: {
        amount: 2.25,
        periodEnd: now.toISOString(),
      },
    });
    expect(new URL(requests[0]!.url).searchParams.get("project_ids")).toBe(
      "proj_teamline",
    );
  });

  test("keeps stale signals labelled and counts current runs without using them for scheduling", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const workOrder = store.create({
      repositoryPath: "/tmp/teamline",
      goal: "运行中的目标",
    });
    store.savePlan(workOrder.id, [
      { outcome: "完成", scope: "src", verification: "人工检查" },
    ]);
    store.markStarted(workOrder.id);
    const app = createApp({
      store,
      resourceProvider: {
        async read() {
          return {
            observedAt: "2026-08-02T04:00:00.000Z",
            codex: {
              status: "stale" as const,
              source: "codex-app-server" as const,
              observedAt: "2026-08-02T04:00:00.000Z",
              message: "额度数据已过期，请重新读取",
              shortWindow: null,
              longWindow: null,
            },
            openaiApi: {
              status: "stale" as const,
              source: "openai-usage-api" as const,
              observedAt: "2026-08-02T04:00:00.000Z",
              message: "API 账户用量已过期",
              scope: "organization" as const,
              usage: null,
            },
            workOrderUsage: [],
          };
        },
      },
    });

    const result = await (
      await app.fetch(new Request("http://teamline.local/api/resources"))
    ).json();

    expect(result.runningCount).toBe(1);
    expect(result.codex).toMatchObject({
      status: "stale",
      message: "额度数据已过期，请重新读取",
      shortWindow: null,
      longWindow: null,
    });
    expect(result.openaiApi).toMatchObject({
      status: "stale",
      usage: null,
    });
    expect(result.workOrders[0]).toMatchObject({
      status: "running",
      recommendation: "保持观察，运行结束后再评估",
      usage: { status: "unavailable" },
    });
  });

  test("returns Codex quota when optional OpenAI usage never responds", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-resource-test-"));
    const executable = join(directory, "fake-codex");
    writeFileSync(
      executable,
      [
        "#!/bin/sh",
        "read initialize",
        "read initialized",
        "read rate_limits",
        `printf '%s\\n' '{"id":6,"result":{"rateLimits":{"primary":{"usedPercent":10,"windowDurationMins":300,"resetsAt":1785733200}}}}'`,
      ].join("\n"),
    );
    chmodSync(executable, 0o755);
    try {
      const app = createApp({
        store: new WorkOrderStore(new Database(":memory:")),
        resourceProvider: new CodexAppServerResourceProvider(
          executable,
          5_000,
          { read: () => new Promise(() => {}) },
          60_000,
          5 * 60_000,
          20,
          () => new Date("2026-08-03T04:00:00.000Z"),
        ),
      });

      const result = await Promise.race([
        app
          .fetch(new Request("http://teamline.local/api/resources"))
          .then((response) => response.json()),
        Bun.sleep(1_500).then(() => {
          throw new Error("resource endpoint did not enforce its OpenAI timeout");
        }),
      ]);

      expect(result.codex).toMatchObject({
        status: "available",
        shortWindow: { usedPercent: 10 },
      });
      expect(result.openaiApi).toMatchObject({
        status: "error",
        usage: null,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("returns Codex before the production OpenAI timeout when optional usage never responds", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-resource-test-"));
    const executable = join(directory, "fake-codex");
    writeFileSync(
      executable,
      [
        "#!/bin/sh",
        "read initialize",
        "read initialized",
        "read rate_limits",
        `printf '%s\\n' '{"id":6,"result":{"rateLimits":{"primary":{"usedPercent":10,"windowDurationMins":300,"resetsAt":1785733200}}}}'`,
      ].join("\n"),
    );
    chmodSync(executable, 0o755);
    try {
      const app = createApp({
        store: new WorkOrderStore(new Database(":memory:")),
        resourceProvider: new CodexAppServerResourceProvider(
          executable,
          5_000,
          { read: () => new Promise(() => {}) },
          60_000,
          5 * 60_000,
          3_000,
          () => new Date("2026-08-03T04:00:00.000Z"),
        ),
      });
      const startedAt = performance.now();
      const result = await Promise.race([
        app
          .fetch(new Request("http://teamline.local/api/resources"))
          .then((response) => response.json()),
        Bun.sleep(1_500).then(() => {
          throw new Error("Codex response waited for the OpenAI timeout");
        }),
      ]);

      expect(performance.now() - startedAt).toBeLessThan(1_500);
      expect(result.codex).toMatchObject({
        status: "available",
        shortWindow: { usedPercent: 10 },
      });
      expect(result.openaiApi).toMatchObject({
        status: "loading",
        usage: null,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("does not report malformed OpenAI cost buckets as a precise zero", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-resource-test-"));
    const executable = join(directory, "fake-codex");
    writeFileSync(
      executable,
      [
        "#!/bin/sh",
        "read initialize",
        "read initialized",
        "read rate_limits",
        `printf '%s\\n' '{"id":6,"result":{"rateLimits":{"primary":{"usedPercent":10,"windowDurationMins":300,"resetsAt":1785733200}}}}'`,
      ].join("\n"),
    );
    chmodSync(executable, 0o755);
    const apiUsage = new OpenAIOrganizationUsageProvider(
      "sk-admin-test",
      undefined,
      async () => Response.json({ data: [{ start_time: 1785542400 }], has_more: false }),
      () => new Date("2026-08-03T04:00:00.000Z"),
    );
    try {
      const app = createApp({
        store: new WorkOrderStore(new Database(":memory:")),
        resourceProvider: new CodexAppServerResourceProvider(
          executable,
          5_000,
          apiUsage,
        ),
      });

      const result = await (
        await app.fetch(new Request("http://teamline.local/api/resources"))
      ).json();

      expect(result.openaiApi).toMatchObject({
        status: "error",
        usage: null,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps the original Codex sample time in cache and hides stale exact values", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-resource-test-"));
    const executable = join(directory, "fake-codex");
    writeFileSync(
      executable,
      [
        "#!/bin/sh",
        "read initialize",
        "read initialized",
        "read rate_limits",
        `printf '%s\\n' '{"id":6,"result":{"rateLimits":{"primary":{"usedPercent":10,"windowDurationMins":300,"resetsAt":1785733200}}}}'`,
      ].join("\n"),
    );
    chmodSync(executable, 0o755);
    let now = new Date("2026-08-03T04:00:00.000Z");
    try {
      const app = createApp({
        store: new WorkOrderStore(new Database(":memory:")),
        resourceProvider: new CodexAppServerResourceProvider(
          executable,
          5_000,
          undefined,
          60_000,
          5_000,
          3_000,
          () => new Date(now),
        ),
      });

      const first = await (
        await app.fetch(new Request("http://teamline.local/api/resources"))
      ).json();
      now = new Date("2026-08-03T04:00:01.000Z");
      const cached = await (
        await app.fetch(new Request("http://teamline.local/api/resources"))
      ).json();
      now = new Date("2026-08-03T04:00:06.000Z");
      const stale = await (
        await app.fetch(new Request("http://teamline.local/api/resources"))
      ).json();

      expect(first.codex.observedAt).toBe("2026-08-03T04:00:00.000Z");
      expect(cached).toMatchObject({
        observedAt: "2026-08-03T04:00:01.000Z",
        codex: {
          status: "available",
          observedAt: "2026-08-03T04:00:00.000Z",
        },
      });
      expect(stale.codex).toMatchObject({
        status: "stale",
        observedAt: "2026-08-03T04:00:00.000Z",
        shortWindow: null,
        longWindow: null,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("hides exact Codex values after the reported reset time has passed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-resource-test-"));
    const executable = join(directory, "fake-codex");
    writeFileSync(
      executable,
      [
        "#!/bin/sh",
        "read initialize",
        "read initialized",
        "read rate_limits",
        `printf '%s\\n' '{"id":6,"result":{"rateLimits":{"primary":{"usedPercent":10,"windowDurationMins":300,"resetsAt":1785729540}}}}'`,
      ].join("\n"),
    );
    chmodSync(executable, 0o755);
    try {
      const app = createApp({
        store: new WorkOrderStore(new Database(":memory:")),
        resourceProvider: new CodexAppServerResourceProvider(
          executable,
          5_000,
          undefined,
          60_000,
          5 * 60_000,
          3_000,
          () => new Date("2026-08-03T04:00:00.000Z"),
        ),
      });
      const result = await (
        await app.fetch(new Request("http://teamline.local/api/resources"))
      ).json();

      expect(result.codex).toMatchObject({
        status: "stale",
        message: "额度窗口已经重置，需要重新读取后才能显示精确值",
        shortWindow: null,
        longWindow: null,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("does not claim a ready work order can run when Codex quota is unknown", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const workOrder = store.create({
      repositoryPath: "/tmp/teamline",
      goal: "等待额度判断",
    });
    store.savePlan(workOrder.id, [
      { outcome: "完成", scope: "src", verification: "人工检查" },
    ]);
    const observedAt = "2026-08-03T04:00:00.000Z";
    const app = createApp({
      store,
      resourceProvider: {
        async read() {
          return {
            observedAt,
            codex: {
              status: "unavailable" as const,
              source: "codex-app-server" as const,
              observedAt,
              message: "没有可靠额度",
              shortWindow: null,
              longWindow: null,
            },
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
    });

    const result = await (
      await app.fetch(new Request("http://teamline.local/api/resources"))
    ).json();
    expect(result.workOrders[0].recommendation).toBe(
      "额度信号不可用，无法判断是否适合运行",
    );
  });

  test("hides stale attributed work-order usage instead of displaying an exact amount", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const workOrder = store.create({
      repositoryPath: "/tmp/teamline",
      goal: "检查过期目标用量",
    });
    const observedAt = "2026-08-03T04:10:01.000Z";
    const app = createApp({
      store,
      resourceProvider: {
        async read() {
          return {
            observedAt,
            codex: {
              status: "available" as const,
              source: "codex-app-server" as const,
              observedAt,
              message: null,
              shortWindow: {
                usedPercent: 10,
                windowMinutes: 300,
                resetsAt: "2026-08-03T07:00:00.000Z",
              },
              longWindow: null,
            },
            openaiApi: {
              status: "available" as const,
              source: "openai-usage-api" as const,
              observedAt,
              message: null,
              scope: "organization" as const,
              usage: {
                amount: 8,
                unit: "usd" as const,
                periodStart: "2026-08-01T00:00:00.000Z",
                periodEnd: observedAt,
              },
            },
            workOrderUsage: [
              {
                workOrderId: workOrder.id,
                amount: 3.25,
                unit: "usd" as const,
                observedAt: "2026-08-03T04:00:00.000Z",
                source: "openai-usage-api" as const,
              },
            ],
          };
        },
      },
    });

    const result = await (
      await app.fetch(new Request("http://teamline.local/api/resources"))
    ).json();
    expect(result.workOrders[0].usage).toEqual({
      status: "stale",
      observedAt: "2026-08-03T04:00:00.000Z",
      message: "目标用量已过期，需要重新读取后才能显示精确值",
      messageDescriptor: { code: "resource.usage.stale", params: {} },
    });
    expect(result.workOrders[0].usage).not.toHaveProperty("amount");
  });

  test("rejects invalid or future attributed usage without leaking exact fields", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const workOrder = store.create({
      repositoryPath: "/tmp/teamline",
      goal: "检查无效目标用量",
    });
    const snapshotObservedAt = "2026-08-03T04:10:00.000Z";
    let usage: {
      workOrderId: string;
      amount: number;
      unit: string;
      observedAt: string;
      source: string;
    };
    const provider: ResourceProvider = {
      async read() {
        return {
          observedAt: snapshotObservedAt,
          codex: {
            status: "available",
            source: "codex-app-server",
            observedAt: snapshotObservedAt,
            message: null,
            shortWindow: {
              usedPercent: 10,
              windowMinutes: 300,
              resetsAt: "2026-08-03T07:00:00.000Z",
            },
            longWindow: null,
          },
          openaiApi: {
            status: "available",
            source: "openai-usage-api",
            observedAt: snapshotObservedAt,
            message: null,
            scope: "organization",
            usage: {
              amount: 8,
              unit: "usd",
              periodStart: "2026-08-01T00:00:00.000Z",
              periodEnd: snapshotObservedAt,
            },
          },
          workOrderUsage: [usage as never],
        };
      },
    };
    const app = createApp({ store, resourceProvider: provider });
    const baseUsage = {
      workOrderId: workOrder.id,
      amount: 3.25,
      unit: "usd",
      observedAt: snapshotObservedAt,
      source: "openai-usage-api",
    };
    const cases = [
      {
        name: "infinite amount",
        status: "unavailable",
        usage: { ...baseUsage, amount: Infinity },
      },
      {
        name: "negative amount",
        status: "unavailable",
        usage: { ...baseUsage, amount: -1 },
      },
      {
        name: "invalid unit",
        status: "unavailable",
        usage: { ...baseUsage, unit: "credits" },
      },
      {
        name: "invalid source",
        status: "unavailable",
        usage: { ...baseUsage, source: "estimated" },
      },
      {
        name: "unparseable observedAt",
        status: "unavailable",
        usage: { ...baseUsage, observedAt: "not-a-date" },
      },
      {
        name: "future observedAt",
        status: "stale",
        usage: { ...baseUsage, observedAt: "2026-08-03T04:12:00.000Z" },
      },
    ];

    for (const testCase of cases) {
      usage = testCase.usage;
      const result = await (
        await app.fetch(new Request("http://teamline.local/api/resources"))
      ).json();
      const presented = result.workOrders[0].usage;
      expect(presented.status, testCase.name).toBe(testCase.status);
      expect(presented, testCase.name).not.toHaveProperty("amount");
      expect(presented, testCase.name).not.toHaveProperty("unit");
      expect(presented, testCase.name).not.toHaveProperty("source");
      if (testCase.name === "unparseable observedAt") {
        expect(presented, testCase.name).not.toHaveProperty("observedAt");
      } else {
        expect(presented.observedAt, testCase.name).toBe(
          testCase.usage.observedAt,
        );
      }
    }
  });

  test("uses TEAMLINE_CODEX_PATH in the server resource-provider wiring", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-resource-test-"));
    const executable = join(directory, "fake-codex");
    const resetAt = Math.floor(Date.now() / 1_000) + 60 * 60;
    writeFileSync(
      executable,
      [
        "#!/bin/sh",
        "read initialize",
        "read initialized",
        "read rate_limits",
        `printf '%s\\n' '{"id":6,"result":{"rateLimits":{"primary":{"usedPercent":22,"windowDurationMins":300,"resetsAt":${resetAt}}}}}'`,
      ].join("\n"),
    );
    chmodSync(executable, 0o755);
    try {
      const app = createApp({
        store: new WorkOrderStore(new Database(":memory:")),
        resourceProvider: createServerResourceProvider({
          TEAMLINE_CODEX_PATH: executable,
        }),
      });
      const result = await (
        await app.fetch(new Request("http://teamline.local/api/resources"))
      ).json();
      expect(result.codex).toMatchObject({
        status: "available",
        shortWindow: { usedPercent: 22 },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
