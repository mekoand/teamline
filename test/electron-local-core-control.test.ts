import { describe, expect, test } from "bun:test";
import { requestLocalCoreStop } from "../src/electron/local-core-control.mjs";

function responseFor(path: string, active: Array<{ id: string; runStatus: string }>) {
  if (path === "/api/console") return Response.json({ workOrders: active });
  if (path === "/api/local-core/shutdown") {
    return Response.json({ stopping: true }, { status: 202 });
  }
  return Response.json({ ok: true });
}

describe("safe Local Core shutdown control", () => {
  test("cancels before interrupting active work", async () => {
    const calls: Array<{ path: string; method: string }> = [];
    const result = await requestLocalCoreStop({
      url: "http://127.0.0.1:4310",
      confirmStop: async () => false,
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        calls.push({ path: url.pathname, method: init?.method ?? "GET" });
        return responseFor(url.pathname, [{ id: "goal-1", runStatus: "running" }]);
      },
    });
    expect(result).toEqual({ stopped: false, cancelled: true, interruptedIds: [] });
    expect(calls).toEqual([{ path: "/api/console", method: "GET" }]);
  });

  test("interrupts active work, waits for it to leave the running set, then shuts down", async () => {
    const calls: Array<{ path: string; method: string }> = [];
    let active = [{ id: "goal-1", runStatus: "running" }];
    const result = await requestLocalCoreStop({
      url: "http://127.0.0.1:4310",
      waitMs: 0,
      confirmStop: async (workOrders) => workOrders.length === 1,
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        calls.push({ path: url.pathname, method: init?.method ?? "GET" });
        if (url.pathname.endsWith("/interrupt")) active = [];
        return responseFor(url.pathname, active);
      },
    });
    expect(result).toEqual({ stopped: true, cancelled: false, interruptedIds: ["goal-1"] });
    expect(calls).toEqual([
      { path: "/api/console", method: "GET" },
      { path: "/api/work-orders/goal-1/interrupt", method: "POST" },
      { path: "/api/console", method: "GET" },
      { path: "/api/local-core/shutdown", method: "POST" },
    ]);
  });
});
