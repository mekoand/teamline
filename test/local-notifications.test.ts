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

  test("uses the four notification preferences, stable target codes, and resource dedupe", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const responseGoal = externalWorkOrder(store);
    const reviewGoal = store.create({ goal: "等待验收" });
    store.database
      .query("UPDATE work_orders SET status = 'review' WHERE id = ?")
      .run(reviewGoal.id);
    const failedGoal = store.create({ goal: "运行失败" });
    store.database
      .query("UPDATE work_orders SET status = 'interrupted', run_status = 'failed', run_number = 1 WHERE id = ?")
      .run(failedGoal.id);
    const app = createApp({ store });

    const defaults = await app.fetch(
      new Request("http://teamline.local/api/preferences/notifications"),
    );
    expect(await defaults.json()).toEqual({
      settings: {
        needsResponse: true,
        runFailed: true,
        goalPendingAcceptance: true,
        resourceUnavailable: true,
      },
    });

    store.syncWorkOrderNotifications();
    store.syncResourceNotifications([{
      workOrderId: failedGoal.id,
      executionIdentityId: "account-a",
      identityLabel: "工作账号",
      signal: {
        status: "unavailable",
        source: "codex-app-server",
        observedAt: new Date().toISOString(),
        message: "额度不可用",
        shortWindow: null,
        longWindow: null,
      },
    }]);
    store.syncResourceNotifications([{
      workOrderId: failedGoal.id,
      executionIdentityId: "account-a",
      identityLabel: "工作账号",
      signal: {
        status: "unavailable",
        source: "codex-app-server",
        observedAt: new Date().toISOString(),
        message: "额度不可用",
        shortWindow: null,
        longWindow: null,
      },
    }]);

    expect(store.listNotifications()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "response",
        workOrderId: responseGoal.id,
        targetCode: "goal.response",
      }),
      expect.objectContaining({
        kind: "review",
        workOrderId: reviewGoal.id,
        targetCode: "goal.stage",
      }),
      expect.objectContaining({
        kind: "run_failed",
        workOrderId: failedGoal.id,
        targetCode: "goal.failure",
      }),
      expect.objectContaining({
        kind: "resource_unavailable",
        workOrderId: failedGoal.id,
        targetCode: "resource.account",
        targetUrl: `/resources?account=account-a&goal=${failedGoal.id}&project=unclassified`,
      }),
    ]));
    expect(store.listNotifications().filter((notification) => notification.kind === "resource_unavailable")).toHaveLength(1);

    store.syncResourceNotifications([{
      workOrderId: failedGoal.id,
      executionIdentityId: "account-a",
      identityLabel: "工作账号",
      signal: {
        status: "available",
        source: "codex-app-server",
        observedAt: new Date().toISOString(),
        message: null,
        shortWindow: null,
        longWindow: null,
      },
    }]);
    store.syncResourceNotifications([{
      workOrderId: failedGoal.id,
      executionIdentityId: "account-a",
      identityLabel: "工作账号",
      signal: {
        status: "unavailable",
        source: "codex-app-server",
        observedAt: new Date().toISOString(),
        message: "额度不可用",
        shortWindow: null,
        longWindow: null,
      },
    }]);
    expect(store.listNotifications().filter((notification) => notification.kind === "resource_unavailable")).toHaveLength(2);

    const saved = await app.fetch(
      new Request("http://teamline.local/api/preferences/notifications", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          settings: {
            needsResponse: true,
            runFailed: false,
            goalPendingAcceptance: true,
            resourceUnavailable: true,
          },
        }),
      }),
    );
    expect(await saved.json()).toEqual({
      settings: {
        needsResponse: true,
        runFailed: false,
        goalPendingAcceptance: true,
        resourceUnavailable: true,
      },
    });
    const claim = await app.fetch(
      new Request("http://teamline.local/api/notifications/claim", { method: "POST" }),
    );
    expect((await claim.json()).notifications).toEqual(expect.not.arrayContaining([
      expect.objectContaining({ kind: "run_failed" }),
    ]));
  });

  test("claims resource notices after refreshing the resource snapshot", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const goal = externalWorkOrder(store);
    const app = createApp({ store });

    const claim = await app.fetch(
      new Request("http://teamline.local/api/notifications/claim", { method: "POST" }),
    );
    const notifications = (await claim.json()).notifications;
    expect(notifications).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "resource_unavailable",
        workOrderId: goal.id,
        targetCode: "resource.account",
      }),
    ]));
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

  test("keeps legacy auto-run history without exposing it as a system notice", async () => {
    const database = new Database(":memory:");
    const store = new WorkOrderStore(database);
    const workOrder = store.create({ goal: "自动运行委托" });
    const app = createApp({ store });

    const defaults = await app.fetch(
      new Request("http://teamline.local/api/notification-settings"),
    );
    expect(await defaults.json()).toEqual({
      settings: { autoRunStarted: false, autoRunStopped: false },
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
    expect(store.listNotifications().map((notification) => notification.kind)).toEqual([
      "auto_run_stopped",
    ]);
    const firstClaim = await app.fetch(
      new Request("http://teamline.local/api/notifications/claim", { method: "POST" }),
    );
    expect(await firstClaim.json()).toEqual({ notifications: [] });
  });

  test("keeps completed history in the console without claiming it as a native notice", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const workOrder = externalWorkOrder(store);
    store.completeExternalStage(workOrder.id, workOrder.plan!.stages[0]!.id, {
      conclusion: "设计稿已经完成",
    });
    store.confirmDelivered(workOrder.id);
    const app = createApp({ store });

    const history = await app.fetch(
      new Request("http://teamline.local/api/notifications"),
    );
    expect((await history.json()).notifications).toEqual([
      expect.objectContaining({ kind: "completed", workOrderId: workOrder.id }),
    ]);

    const claim = await app.fetch(
      new Request("http://teamline.local/api/notifications/claim", { method: "POST" }),
    );
    expect(await claim.json()).toEqual({ notifications: [] });
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
    const created = store.create({ repositoryPath: tmpdir(), goal: "自动执行" });
    const ready = store.savePlan(created.id, [
      { outcome: "完成自动执行", scope: "src", verification: "人工检查" },
    ]);
    store.saveResourcePlan(ready.id, {
      priority: "normal",
      pace: "balanced",
      runWhenQuotaAvailable: true,
    });
    store.saveNotificationSettings({ autoRunStarted: true, autoRunStopped: true });
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
    expect(page).toContain('id="notification-needs-response"');
    expect(page).toContain('id="notification-run-failed"');
    expect(page).toContain('id="notification-goal-pending-acceptance"');
    expect(page).toContain('id="notification-resource-unavailable"');
    expect(script).toContain("Notification.requestPermission()");
    expect(script).toContain('requestJson("/api/notifications/claim"');
    expect(script).toContain('requestJson("/api/preferences/notifications"');
    expect(script).toContain('searchParams.get("stage")');
    expect(script).toContain('searchParams.delete("stage")');
    expect(script).toContain('requestJson("/api/notifications/release"');
    expect(script).toContain("unread-indicator");
    expect(script).toContain("bindDismissibleDialog(notificationDialog");
    expect(script).toContain("bindDismissibleDialog(localStateDialog");
    expect(script).toContain("bindDismissibleDialog(createDialog");
    expect(script).toContain("bindDismissibleDialog(sessionImportDialog");
    expect(styles).toContain(".notification-dialog");
    expect(styles).toContain("@media (max-width: 680px)");
  });
});
