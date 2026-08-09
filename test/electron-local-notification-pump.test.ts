import { describe, expect, test } from "bun:test";
import {
  claimLocalNotifications,
  nativeNotificationOptions,
  normalizeLocalNotification,
  releaseLocalNotification,
} from "../src/electron/local-notification-pump.mjs";

describe("Electron local notification pump", () => {
  test("claims only routable notifications and preserves stable routing fields", async () => {
    const requests: Request[] = [];
    const notifications = await claimLocalNotifications(
      new URL("http://127.0.0.1:4310/"),
      async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({
          notifications: [
            {
              id: 7,
              title: "目标运行失败",
              body: "目标 · 运行失败",
              targetCode: "goal.failure",
              targetUrl: "/goals/goal-7",
            },
            { id: "invalid", targetCode: "", targetUrl: "goal-8" },
          ],
        });
      },
    );

    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url).toBe("http://127.0.0.1:4310/api/notifications/claim");
    expect(notifications).toEqual([
      expect.objectContaining({
        id: 7,
        targetCode: "goal.failure",
        targetUrl: "/goals/goal-7",
      }),
    ]);
    expect(nativeNotificationOptions(notifications[0])).toEqual({
      title: "目标运行失败",
      body: "目标 · 运行失败",
    });
  });

  test("releases a claimed notice when native display fails", async () => {
    let request: Request | null = null;
    await releaseLocalNotification(
      new URL("http://127.0.0.1:4310/"),
      9,
      async (input, init) => {
        request = new Request(input, init);
        return new Response(null, { status: 200 });
      },
    );

    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("http://127.0.0.1:4310/api/notifications/release");
    expect(await request?.json()).toEqual({ id: 9 });
    expect(normalizeLocalNotification({ id: 0, targetCode: "goal.failure", targetUrl: "/goals/0" })).toBeNull();
  });
});
