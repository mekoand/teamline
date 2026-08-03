import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { CodexExecutionRunner } from "../src/codex-runner";
import type { PlanGenerator } from "../src/plan-generator";
import { decideAutoRun } from "../src/resource-scheduler";
import { WorkOrderStore } from "../src/work-order-store";

function request(path: string, body?: unknown) {
  return new Request(`http://teamline.local${path}`, {
    method: "POST",
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
}

describe("work-order clarification and conversation", () => {
  test("generates a plan directly when the goal is already clear", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const created = store.create({ goal: "修复登录页的窄屏按钮溢出" });
    const app = createApp({
      store,
      planGenerator: {
        async generate() {
          return {
            outcome: "plan",
            message: "计划已生成。",
            questions: [],
            stages: [
              {
                id: "fix-layout",
                outcome: "登录按钮在窄屏完整显示",
                scope: "登录页布局与样式",
                verification: "检查 390px 和 320px 宽度",
              },
            ],
          };
        },
      },
    });

    const response = await app.fetch(request(`/api/work-orders/${created.id}/plan/generate`));
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.outcome).toBe("plan");
    expect(result.workOrder.pendingClarification).toBeNull();
    expect(result.workOrder.plan.confirmationRequired).toBe(true);
    expect(result.workOrder.plan.stages).toHaveLength(1);
    expect(result.workOrder.conversation).toHaveLength(0);
  });

  test("asks only for a key ambiguity and turns the answer into structured plan data", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const created = store.create({ goal: "调整导入流程" });
    let calls = 0;
    const planGenerator: PlanGenerator = {
      async generate(workOrder) {
        calls += 1;
        if (calls === 1) {
          return {
            outcome: "clarification",
            message: "需要确认导入来源。",
            questions: [
              {
                id: "source",
                prompt: "Ask Matt 需要支持文件导入，还是链接导入？",
                reason: "Ask Matt 判断来源会改变素材和节点范围",
                target: "materials",
              },
            ],
            stages: [],
          };
        }
        expect(workOrder.conversation.at(-1)).toMatchObject({
          role: "user",
          content: "先支持链接导入",
          decisionTarget: "materials",
        });
        return {
          outcome: "plan",
          message: "Ask Matt 已决定先支持链接导入。",
          questions: [],
          goal: "支持从链接导入资料",
          acceptance: "链接可被保存并进入当前委托",
          materials: [{ kind: "link", value: "https://example.test/source" }],
          resourcePlan: {
            priority: "high",
            pace: "balanced",
            runWhenQuotaAvailable: false,
          },
          stages: [
            {
              id: "link-import",
              outcome: "链接资料可导入",
              scope: "导入接口与委托素材",
              verification: "运行导入测试",
            },
          ],
        };
      },
    };
    const app = createApp({ store, planGenerator });

    const first = await app.fetch(request(`/api/work-orders/${created.id}/plan/generate`));
    const awaiting = await first.json();
    expect(awaiting.outcome).toBe("clarification");
    expect(awaiting.workOrder.pendingClarification.questions[0].target).toBe("materials");
    expect(JSON.stringify(awaiting.workOrder)).not.toContain("Ask Matt");
    expect(awaiting.workOrder.conversation[0]).toMatchObject({
      role: "teamline",
      kind: "question",
    });

    const answered = await app.fetch(
      request(`/api/work-orders/${created.id}/conversation`, {
        mode: "reply",
        message: "先支持链接导入",
      }),
    );
    const result = await answered.json();

    expect(answered.status).toBe(200);
    expect(result.outcome).toBe("plan");
    expect(result.workOrder).toMatchObject({
      goal: "调整导入流程",
      acceptance: null,
      resourcePlan: {
        priority: "normal",
        pace: "balanced",
        runWhenQuotaAvailable: false,
      },
      pendingClarification: null,
      status: "ready",
    });
    expect(result.workOrder.materials).toEqual([
      expect.objectContaining({ kind: "link", value: "https://example.test/source" }),
    ]);
    expect(result.workOrder.conversation.at(-1)).toMatchObject({
      role: "teamline",
      kind: "decision",
      requiresPlanConfirmation: true,
    });
    expect(JSON.stringify(result.workOrder)).not.toContain("Ask Matt");
  });

  test("keeps an ordinary supplement on the current node without changing plan version", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const created = store.create({
      goal: "完善设置页",
      workspace: { kind: "directory", path: "/tmp/teamline-settings" },
    });
    const ready = store.savePlan(created.id, [
      {
        id: "settings-ui",
        outcome: "设置页完成",
        scope: "设置页",
        verification: "人工检查",
      },
    ]);
    const app = createApp({ store });

    const response = await app.fetch(
      request(`/api/work-orders/${created.id}/conversation`, {
        mode: "supplement",
        stageId: ready.plan!.stages[0]!.id,
        message: "按钮文案保持简短，并检查 320px 宽度",
      }),
    );
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.workOrder.plan.version).toBe(ready.plan!.version);
    expect(result.workOrder.plan.stages[0].contextNotes).toEqual([
      "按钮文案保持简短，并检查 320px 宽度",
    ]);
    expect(result.workOrder.conversation.at(-1)).toMatchObject({
      kind: "decision",
      decisionTarget: "stage",
      requiresPlanConfirmation: false,
    });
  });

  test("includes current-node supplements in the Codex execution prompt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-conversation-prompt-"));
    const executable = join(directory, "fake-codex");
    const invocation = join(directory, "invocation.txt");
    try {
      writeFileSync(
        executable,
        ["#!/bin/sh", `printf '<%s>\\n' "$@" > "${invocation}"`, "exit 0", ""].join("\n"),
      );
      chmodSync(executable, 0o755);
      const store = new WorkOrderStore(new Database(":memory:"));
      const created = store.create({
        goal: "完善设置页",
        workspace: { kind: "directory", path: directory },
      });
      const ready = store.savePlan(created.id, [
        {
          id: "settings-ui",
          outcome: "设置页完成",
          scope: "设置页",
          verification: "人工检查",
        },
      ]);
      const supplemented = store.addStageSupplement(
        created.id,
        ready.plan!.stages[0]!.id,
        "按钮必须在 320px 宽度完整显示",
      );

      const run = await new CodexExecutionRunner(executable).start({
        workOrder: supplemented,
        workspacePath: directory,
      });
      for await (const _event of run.events) {
        // Drain output so the invocation is complete.
      }

      expect(readFileSync(invocation, "utf8")).toContain(
        "补充上下文：按钮必须在 320px 宽度完整显示",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("updates explicit soft resource preferences without changing the plan version", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const created = store.create({ goal: "调整资源节奏" });
    const ready = store.savePlan(created.id, [
      {
        id: "existing",
        outcome: "现有工作完成",
        scope: "当前范围",
        verification: "人工检查",
      },
    ]);
    let calls = 0;
    const app = createApp({
      store,
      planGenerator: {
        async generate() {
          calls += 1;
          if (calls === 1) {
            return {
              outcome: "clarification",
              message: "需要确认执行节奏。",
              questions: [
                {
                  id: "pace",
                  prompt: "这项委托需要优先推进，还是保持正常节奏？",
                  reason: "回答只调整软运行偏好",
                  target: "resources",
                },
              ],
              stages: [],
            };
          }
          return {
            outcome: "plan",
            message: "资源偏好已更新。",
            questions: [],
            resourcePlan: {
              priority: "high",
              pace: "fast",
              runWhenQuotaAvailable: true,
            },
            stages: [
              {
                id: "existing",
                outcome: "现有工作完成",
                scope: "当前范围",
                verification: "人工检查",
              },
            ],
          };
        },
      },
    });

    const clarification = await app.fetch(
      request(`/api/work-orders/${created.id}/conversation`, {
        mode: "replan",
        message: "调整资源安排",
      }),
    );
    expect((await clarification.json()).outcome).toBe("clarification");

    const response = await app.fetch(
      request(`/api/work-orders/${created.id}/conversation`, {
        mode: "reply",
        message: "优先推进并加快节奏",
      }),
    );
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.workOrder.plan.version).toBe(ready.plan!.version);
    expect(result.workOrder.resourcePlan).toMatchObject({
      priority: "high",
      pace: "fast",
      runWhenQuotaAvailable: false,
    });
    expect(result.workOrder.conversation.at(-1)).toMatchObject({
      decisionTarget: "resources",
      requiresPlanConfirmation: false,
    });
  });

  test("does not save a reply when generated structured data is invalid", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const created = store.create({ goal: "保持原计划" });
    const ready = store.savePlan(created.id, [
      { id: "only", outcome: "完成", scope: "当前范围", verification: "人工检查" },
    ]);
    const app = createApp({
      store,
      planGenerator: {
        async generate() {
          return { outcome: "plan", questions: [], stages: [] };
        },
      },
    });

    const response = await app.fetch(
      request(`/api/work-orders/${created.id}/conversation`, {
        mode: "replan",
        message: "更新目标",
      }),
    );

    expect(response.status).toBe(502);
    expect(store.get(created.id)?.conversation).toEqual([]);
    expect(store.get(created.id)?.plan?.version).toBe(ready.plan!.version);
  });

  test("serializes planning updates for one work order", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const created = store.create({ goal: "串行更新" });
    store.savePlan(created.id, [
      { id: "only", outcome: "完成", scope: "当前范围", verification: "人工检查" },
    ]);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = createApp({
      store,
      planGenerator: {
        async generate() {
          await waiting;
          return {
            outcome: "plan",
            questions: [],
            stages: [
              { id: "only", outcome: "完成", scope: "当前范围", verification: "人工检查" },
            ],
          };
        },
      },
    });

    const first = app.fetch(
      request(`/api/work-orders/${created.id}/conversation`, {
        mode: "replan",
        message: "第一次更新",
      }),
    );
    await Bun.sleep(0);
    const second = await app.fetch(
      request(`/api/work-orders/${created.id}/conversation`, {
        mode: "replan",
        message: "第二次更新",
      }),
    );
    release();
    const firstResponse = await first;

    expect(firstResponse.status).toBe(200);
    expect(second.status).toBe(409);
    expect(store.get(created.id)?.conversation.filter((message) => message.role === "user"))
      .toHaveLength(1);
  });

  test("a structural update creates a new plan version that must be confirmed again", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const created = store.create({
      goal: "完善设置页",
      workspace: { kind: "directory", path: "/tmp/teamline-settings-replan" },
    });
    const ready = store.savePlan(created.id, [
      {
        id: "settings-ui",
        outcome: "设置页完成",
        scope: "设置页",
        verification: "人工检查",
        materials: [
          {
            id: "settings-reference",
            type: "file",
            label: "设置页参考",
            location: "/tmp/settings-reference.md",
          },
        ],
        artifacts: [
          {
            id: "settings-artifact",
            type: "file",
            label: "设置页产物",
            location: "/tmp/settings-artifact.md",
          },
        ],
      },
    ]);
    store.addStageSupplement(
      created.id,
      ready.plan!.stages[0]!.id,
      "保留这项节点补充",
    );
    store.saveResourcePlan(created.id, {
      priority: "normal",
      pace: "balanced",
      runWhenQuotaAvailable: true,
    });
    const app = createApp({
      store,
      planGenerator: {
        async generate(workOrder) {
          expect(workOrder.conversation.at(-1)).toMatchObject({
            role: "user",
            requiresPlanConfirmation: true,
          });
          return {
            outcome: "plan",
            message: "已增加移动端节点并调整资源安排。",
            questions: [],
            resourcePlan: {
              priority: "high",
              pace: "fast",
              runWhenQuotaAvailable: true,
            },
            stages: [
              {
                id: "settings-ui",
                outcome: "设置页完成",
                scope: "设置页",
                verification: "人工检查",
              },
              {
                id: "mobile-check",
                outcome: "移动端布局通过检查",
                scope: "响应式样式",
                verification: "检查 390px 和 320px 宽度",
                dependsOn: ["settings-ui"],
              },
            ],
          };
        },
      },
    });

    const response = await app.fetch(
      request(`/api/work-orders/${created.id}/conversation`, {
        mode: "replan",
        message: "增加移动端检查节点，并优先推进",
      }),
    );
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.workOrder.plan.version).toBe(ready.plan!.version + 1);
    expect(result.workOrder.plan.confirmationRequired).toBe(true);
    expect(result.workOrder.plan.stages[1].dependsOn).toEqual(["settings-ui"]);
    expect(result.workOrder.plan.stages[0].contextNotes).toEqual(["保留这项节点补充"]);
    expect(result.workOrder.plan.stages[0].materials).toEqual([
      {
        id: "settings-reference",
        type: "file",
        label: "设置页参考",
        location: "/tmp/settings-reference.md",
      },
    ]);
    expect(result.workOrder.plan.stages[0].artifacts).toEqual([
      {
        id: "settings-artifact",
        type: "file",
        label: "设置页产物",
        location: "/tmp/settings-artifact.md",
      },
    ]);
    expect(result.workOrder.resourcePlan).toMatchObject({
      priority: "normal",
      pace: "balanced",
      runWhenQuotaAvailable: true,
    });
    expect(result.workOrder).toMatchObject({
      status: "ready",
      currentSummary: "计划等待确认",
    });
    expect(result.workOrder.conversation.at(-1).requiresPlanConfirmation).toBe(true);
    const observedAt = new Date();
    const autoRun = decideAutoRun(
      [result.workOrder],
      {
        source: "codex_app_server",
        status: "available",
        observedAt: observedAt.toISOString(),
        shortWindow: {
          usedPercent: 10,
          windowMinutes: 300,
          resetsAt: new Date(observedAt.getTime() + 60_000).toISOString(),
        },
        longWindow: {
          usedPercent: 10,
          windowMinutes: 10_080,
          resetsAt: new Date(observedAt.getTime() + 60_000).toISOString(),
        },
      },
      2,
      observedAt,
    );
    expect(autoRun.candidateId).toBeNull();
    expect(autoRun.reasons.get(created.id)).toBe("计划已更新，等待重新确认");
  });
});
