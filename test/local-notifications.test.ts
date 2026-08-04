import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { WorkOrderStore } from "../src/work-order-store";

function externalWorkOrder(store: WorkOrderStore) {
  const created = store.create({ goal: "完成外部设计" });
  return store.savePlan(created.id, [
    {
      outcome: "完成设计稿",
      scope: "设计文件",
      verification: "确认设计稿链接",
      executionMethod: "external",
    },
  ]);
}

describe("local work-order notifications", () => {
  test("labels a goal awaiting acceptance as review instead of response", async () => {
    const database = new Database(":memory:");
    const store = new WorkOrderStore(database);
    const goal = store.create({ goal: "验收已经完成的结果" });
    store.database
      .query("UPDATE work_orders SET status = 'review' WHERE id = ?")
      .run(goal.id);
    const response = await createApp({ store }).fetch(
      new Request("http://teamline.local/api/notifications"),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).notifications).toEqual([
      expect.objectContaining({
        kind: "review",
        workOrderId: goal.id,
        title: "目标等待验收",
      }),
    ]);

    database.exec("UPDATE local_notifications SET notification_kind = 'response'");
    const reopenedStore = new WorkOrderStore(database);
    expect(reopenedStore.listNotifications()).toEqual([
      expect.objectContaining({ kind: "review", workOrderId: goal.id }),
    ]);
  });

  test("keeps response and completed notices unread without duplicating after restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-notifications-"));
    const databasePath = join(directory, "teamline.db");
    let database: Database | undefined;
    try {
      database = new Database(databasePath, { create: true });
      let store = new WorkOrderStore(database);
      const workOrder = externalWorkOrder(store);
      const stageId = workOrder.plan!.stages[0]!.id;

      store.syncWorkOrderNotifications();
      expect(store.listNotifications()).toEqual([
        expect.objectContaining({
          kind: "response",
          workOrderId: workOrder.id,
          stageId,
          readAt: null,
          targetUrl: `/goals/${workOrder.id}?stage=${stageId}`,
        }),
      ]);

      database.close();
      database = new Database(databasePath);
      store = new WorkOrderStore(database);
      store.syncWorkOrderNotifications();
      expect(store.listNotifications()).toHaveLength(1);

      store.completeExternalStage(workOrder.id, stageId, {
        conclusion: "设计稿已经完成",
      });
      store.confirmDelivered(workOrder.id);
      store.syncWorkOrderNotifications();

      const notifications = store.listNotifications();
      expect(notifications).toHaveLength(2);
      expect(notifications[0]).toMatchObject({
        kind: "completed",
        workOrderId: workOrder.id,
        stageId,
      });
      expect(notifications.filter((notification) => notification.readAt === null)).toHaveLength(2);
    } finally {
      database?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("claims each native notice once and persists independent auto-run settings", async () => {
    const database = new Database(":memory:");
    const store = new WorkOrderStore(database);
    const workOrder = store.create({ goal: "自动运行委托" });
    const app = createApp({ store });

    const defaults = await app.fetch(
      new Request("http://teamline.local/api/notification-settings"),
    );
    expect(await defaults.json()).toEqual({
      settings: { autoRunStarted: true, autoRunStopped: true },
    });

    const saved = await app.fetch(
      new Request("http://teamline.local/api/notification-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ autoRunStarted: false, autoRunStopped: true }),
      }),
    );
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
      settings: { autoRunStarted: false, autoRunStopped: true },
    });

    store.recordAutoRunStarted(workOrder.id, 1);
    store.recordAutoRunStopped(workOrder.id, 1);
    const firstClaim = await app.fetch(
      new Request("http://teamline.local/api/notifications/claim", { method: "POST" }),
    );
    const secondClaim = await app.fetch(
      new Request("http://teamline.local/api/notifications/claim", { method: "POST" }),
    );
    const first = await firstClaim.json();
    const second = await secondClaim.json();

    expect(first.notifications.map((notification: { kind: string }) => notification.kind)).toEqual([
      "auto_run_stopped",
    ]);
    expect(second.notifications).toEqual([]);

    const release = await app.fetch(
      new Request("http://teamline.local/api/notifications/release", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: first.notifications[0].id }),
      }),
    );
    const retried = await app.fetch(
      new Request("http://teamline.local/api/notifications/claim", { method: "POST" }),
    );
    expect(release.status).toBe(200);
    expect((await retried.json()).notifications).toEqual([
      expect.objectContaining({ id: first.notifications[0].id, kind: "auto_run_stopped" }),
    ]);
  });

  test("notification API retains unread notices and marks only the opened work order read", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const first = externalWorkOrder(store);
    const second = externalWorkOrder(store);
    const app = createApp({ store });

    const response = await app.fetch(
      new Request("http://teamline.local/api/notifications"),
    );
    const body = await response.json();
    expect(body.unreadCount).toBe(2);
    expect(body.notifications).toHaveLength(2);

    const markRead = await app.fetch(
      new Request("http://teamline.local/api/notifications/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workOrderId: first.id }),
      }),
    );
    expect(markRead.status).toBe(200);
    expect(store.listNotifications().filter((notification) => notification.readAt === null)).toEqual([
      expect.objectContaining({ workOrderId: second.id }),
    ]);
  });

  test("an authorized auto-run records one start and one stop notice for its run", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const created = store.create({ repositoryPath: "/tmp/teamline-source", goal: "自动执行" });
    const ready = store.savePlan(created.id, [
      { outcome: "完成自动执行", scope: "src", verification: "人工检查" },
    ]);
    store.saveResourcePlan(ready.id, {
      priority: "normal",
      pace: "balanced",
      runWhenQuotaAvailable: true,
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const now = Date.now();
    const app = createApp({
      store,
      codexRunner: {
        async start() {
          return {
            events: (async function* () {
              await released;
              yield { type: "exit" as const, exitCode: 0, message: "自动运行结束" };
            })(),
          };
        },
      },
      worktreeManager: {
        async prepare() {
          return {
            path: "/tmp/teamline-auto-run",
            branch: "teamline/auto-run",
            baseCommit: "0123456789abcdef",
          };
        },
      },
      resourceProvider: {
        async read() {
          return {
            observedAt: new Date(now).toISOString(),
            codex: {
              status: "available" as const,
              source: "codex-app-server" as const,
              observedAt: new Date(now).toISOString(),
              message: null,
              shortWindow: {
                usedPercent: 20,
                windowMinutes: 300,
                resetsAt: new Date(now + 3_600_000).toISOString(),
              },
              longWindow: {
                usedPercent: 30,
                windowMinutes: 10_080,
                resetsAt: new Date(now + 86_400_000).toISOString(),
              },
            },
            openaiApi: {
              status: "not_connected" as const,
              source: null,
              observedAt: new Date(now).toISOString(),
              message: "未连接",
              scope: null,
              usage: null,
            },
            workOrderUsage: [],
          };
        },
      },
      autoRunRetryScheduler() {
        return () => {};
      },
    });

    const response = await app.fetch(
      new Request("http://teamline.local/api/resources/run-once", { method: "POST" }),
    );
    expect(await response.json()).toEqual({ startedWorkOrderId: ready.id, reason: null });
    expect(store.listNotifications().map((notification) => notification.kind)).toEqual([
      "auto_run_started",
    ]);

    release();
    const deadline = Date.now() + 1_000;
    while (
      !store.listNotifications().some((notification) => notification.kind === "auto_run_stopped") &&
      Date.now() < deadline
    ) {
      await Bun.sleep(2);
    }
    expect(store.listNotifications().map((notification) => notification.kind)).toEqual([
      "auto_run_stopped",
      "auto_run_started",
    ]);
  });

  test("the local console exposes permission, unread, settings, and exact node routing", async () => {
    const app = createApp({ store: new WorkOrderStore(new Database(":memory:")) });
    const [page, script, styles] = await Promise.all([
      app.fetch(new Request("http://teamline.local/")).then((response) => response.text()),
      app.fetch(new Request("http://teamline.local/app.js")).then((response) => response.text()),
      app.fetch(new Request("http://teamline.local/styles.css")).then((response) => response.text()),
    ]);

    expect(page).toContain('id="open-notifications"');
    expect(page).toContain('id="notification-dialog"');
    expect(page).toContain('id="auto-run-started-notifications"');
    expect(page).toContain('id="auto-run-stopped-notifications"');
    expect(script).toContain("Notification.requestPermission()");
    expect(script).toContain('requestJson("/api/notifications/claim"');
    expect(script).toContain('searchParams.get("stage")');
    expect(script).toContain('searchParams.delete("stage")');
    expect(script).toContain('requestJson("/api/notifications/release"');
    expect(script).toContain("unread-indicator");
    expect(styles).toContain(".notification-dialog");
    expect(styles).toContain("@media (max-width: 680px)");
  });
});
