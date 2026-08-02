import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../src/app";
import { WorkOrderStore } from "../src/work-order-store";

const repositoryPath = resolve(import.meta.dir, "..");

describe("work order API", () => {
  test("a created work order can be opened by id", async () => {
    const app = createApp({
      store: new WorkOrderStore(new Database(":memory:")),
    });

    const createResponse = await app.fetch(
      new Request("http://teamline.local/api/work-orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repositoryPath,
          goal: "为设置页面增加深色模式",
          acceptance: "现有测试保持通过",
        }),
      }),
    );
    const { workOrder: created } = await createResponse.json();

    const response = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}`),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ workOrder: created });
  });

  test("a generated plan can be opened and edited", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const app = createApp({
      store,
      planGenerator: {
        async generate() {
          return {
            stages: [
              {
                outcome: "设置页面跟随系统深色模式",
                scope: "设置页面及主题样式",
                verification: "运行相关测试并在浏览器中检查主题切换",
              },
            ],
          };
        },
      },
    });
    const created = store.create({
      repositoryPath,
      goal: "为设置页面增加深色模式",
      acceptance: "现有测试保持通过",
    });

    const response = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/plan/generate`, {
        method: "POST",
      }),
    );
    const { workOrder } = await response.json();

    expect(response.status).toBe(200);
    expect(workOrder).toMatchObject({
      id: created.id,
      status: "ready",
      currentSummary: "计划等待确认",
      plan: {
        version: 1,
        stages: [
          {
            id: expect.any(String),
            outcome: "设置页面跟随系统深色模式",
            scope: "设置页面及主题样式",
            verification: "运行相关测试并在浏览器中检查主题切换",
          },
        ],
        updatedAt: expect.any(String),
      },
    });

    const reopened = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}`),
    );
    expect((await reopened.json()).workOrder).toEqual(workOrder);

    const editResponse = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/plan`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stages: [
            {
              ...workOrder.plan.stages[0],
              outcome: "设置页面支持深色模式并保留现有布局",
            },
          ],
        }),
      }),
    );
    const edited = (await editResponse.json()).workOrder;

    expect(edited.plan.version).toBe(2);
    expect(edited.plan.stages[0].outcome).toBe("设置页面支持深色模式并保留现有布局");
  });

  test("a manual plan can be saved when generation fails", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const app = createApp({
      store,
      planGenerator: {
        async generate() {
          throw new Error("Codex 暂时不可用");
        },
      },
    });
    const created = store.create({
      repositoryPath,
      goal: "为设置页面增加深色模式",
    });

    const generationResponse = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/plan/generate`, {
        method: "POST",
      }),
    );
    expect(generationResponse.status).toBe(502);
    expect(await generationResponse.json()).toEqual({
      code: "PLAN_GENERATION_FAILED",
      error: "Codex 无法生成计划，请确认已经安装并登录后重试",
    });

    const saveResponse = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/plan`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stages: [
            {
              outcome: "设置页面跟随系统深色模式",
              scope: "设置页面及主题样式",
              verification: "运行相关测试",
            },
          ],
        }),
      }),
    );
    const { workOrder } = await saveResponse.json();

    expect(saveResponse.status).toBe(200);
    expect(workOrder.status).toBe("ready");
    expect(workOrder.plan.stages[0]).toMatchObject({
      outcome: "设置页面跟随系统深色模式",
      scope: "设置页面及主题样式",
      verification: "运行相关测试",
    });
  });

  test("a work order detail page can be opened directly", async () => {
    const app = createApp({
      store: new WorkOrderStore(new Database(":memory:")),
    });

    const response = await app.fetch(
      new Request("http://teamline.local/work-orders/example-id"),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<title>Teamline</title>");
  });

  test("plan generation returns a clear timeout instead of waiting forever", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const app = createApp({
      store,
      planGenerationTimeoutMs: 5,
      planGenerator: {
        async generate() {
          return new Promise(() => {});
        },
      },
    });
    const created = store.create({
      repositoryPath,
      goal: "为设置页面增加深色模式",
    });

    const result = await Promise.race([
      app.fetch(
        new Request(`http://teamline.local/api/work-orders/${created.id}/plan/generate`, {
          method: "POST",
        }),
      ),
      Bun.sleep(40).then(() => "still waiting" as const),
    ]);

    expect(result).not.toBe("still waiting");
    if (!(result instanceof Response)) {
      throw new Error("plan generation did not return a response");
    }
    expect(result.status).toBe(504);
    expect(await result.json()).toEqual({
      code: "PLAN_GENERATION_TIMEOUT",
      error: "生成计划超时，请重试",
    });
  });

  test("a saved plan remains available after reopening the database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-plan-test-"));
    const databasePath = join(directory, "teamline.db");

    try {
      const firstDatabase = new Database(databasePath, { create: true });
      const firstStore = new WorkOrderStore(firstDatabase);
      const firstApp = createApp({
        store: firstStore,
        planGenerator: {
          async generate() {
            return {
              stages: [
                {
                  outcome: "设置页面跟随系统深色模式",
                  scope: "设置页面及主题样式",
                  verification: "运行相关测试",
                },
              ],
            };
          },
        },
      });
      const created = firstStore.create({
        repositoryPath,
        goal: "为设置页面增加深色模式",
      });
      await firstApp.fetch(
        new Request(`http://teamline.local/api/work-orders/${created.id}/plan/generate`, {
          method: "POST",
        }),
      );
      firstDatabase.close();

      const reopenedDatabase = new Database(databasePath);
      const reopenedApp = createApp({ store: new WorkOrderStore(reopenedDatabase) });
      const response = await reopenedApp.fetch(
        new Request(`http://teamline.local/api/work-orders/${created.id}`),
      );
      const { workOrder } = await response.json();
      reopenedDatabase.close();

      expect(workOrder.status).toBe("ready");
      expect(workOrder.plan.stages[0].outcome).toBe("设置页面跟随系统深色模式");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("an invalid manual plan returns a stable error", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const app = createApp({ store });
    const created = store.create({
      repositoryPath,
      goal: "为设置页面增加深色模式",
    });

    const response = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/plan`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stages: [{ outcome: 42, scope: "设置页面", verification: "运行测试" }],
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "INVALID_PLAN",
      error: "计划内容不完整，请检查每个阶段",
    });
  });
});
