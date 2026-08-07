import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import type { CodexRunEvent, CodexRunner } from "../src/codex-runner";
import type { WorkOrderResultProcessor } from "../src/result-processor";
import type { WorkOrder } from "../src/work-order";
import { WorkOrderStore } from "../src/work-order-store";

async function responseJson(response: Response) {
  return await response.json() as Record<string, any>;
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(2);
  }
}

function successfulExecution(executedStages: string[]) {
  const events = (withSession: boolean): AsyncIterable<CodexRunEvent> =>
    (async function* () {
      if (withSession) yield { type: "session" as const, sessionId: "continued-session" };
      yield { type: "exit" as const, exitCode: 0, message: "Codex 已结束" };
    })();
  const record = (workOrder: WorkOrder) => {
    executedStages.push(workOrder.plan!.stages[0]!.id);
  };
  const codexRunner: CodexRunner = {
    async start({ workOrder }) {
      record(workOrder);
      return { interrupt() {}, events: events(true) };
    },
    async resume({ workOrder }) {
      record(workOrder);
      return { interrupt() {}, events: events(false) };
    },
  };
  const resultProcessor: WorkOrderResultProcessor = {
    async process(workOrder) {
      const stage = workOrder.plan!.stages[0]!;
      return {
        planVersion: workOrder.plan!.version,
        git: { diffStat: "", statusShort: "" },
        verifications: [{
          stageId: stage.id,
          stageOutcome: stage.outcome,
          command: stage.verificationCommand ?? null,
          status: "passed" as const,
          exitCode: 0,
          output: "验证通过",
        }],
        completedAt: new Date().toISOString(),
      };
    },
  };
  return { codexRunner, resultProcessor };
}

describe("V2 main-flow regression", () => {
  test("new goal stays consistent from clarification and project material through result acceptance", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "teamline-v2-main-flow-"));
    const store = new WorkOrderStore(new Database(":memory:"));
    const executedStages: string[] = [];
    let planningCalls = 0;
    const app = createApp({
      store,
      ...successfulExecution(executedStages),
      planGenerator: {
        async generate(workOrder) {
          planningCalls += 1;
          if (planningCalls === 1) {
            return {
              outcome: "clarification" as const,
              message: "需要确认发布范围。",
              questions: [{
                target: "plan" as const,
                prompt: "是否包含移动端检查？",
                reason: "这会改变验收范围",
              }],
              stages: [],
            };
          }
          expect(workOrder.conversation.at(-1)?.content).toBe("包含 390px 检查");
          expect(workOrder.materials).toEqual([
            expect.objectContaining({ value: "中文标题需要自然换行" }),
          ]);
          return {
            outcome: "plan" as const,
            message: "计划已生成。",
            questions: [],
            stages: [
              {
                id: "desktop",
                outcome: "桌面端主流程可用",
                scope: "目标主界面",
                verification: "检查桌面端",
                verificationCommand: "true",
                dependsOn: [],
                executionMethod: "codex" as const,
              },
              {
                id: "mobile",
                outcome: "390px 主流程可用",
                scope: "目标移动端界面",
                verification: "检查 390px",
                verificationCommand: "true",
                dependsOn: ["desktop"],
                executionMethod: "codex" as const,
              },
            ],
          };
        },
      },
    });

    try {
      const project = await responseJson(await app.fetch(new Request(
        "http://teamline.local/api/projects",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Personal Beta" }),
        },
      )));
      const material = await responseJson(await app.fetch(new Request(
        `http://teamline.local/api/projects/${project.project.id}/materials`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "text",
            label: "中文排版要求",
            value: "中文标题需要自然换行",
          }),
        },
      )));
      const createdResponse = await app.fetch(new Request(
        "http://teamline.local/api/work-orders",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "完成 Personal Beta 发布检查",
            description: "检查桌面端与移动端主流程",
            projectId: project.project.id,
            projectMaterialIds: [material.material.id],
          }),
        },
      ));
      const created = await responseJson(createdResponse);
      expect(createdResponse.status).toBe(201);

      const clarification = await responseJson(await app.fetch(new Request(
        `http://teamline.local/api/work-orders/${created.workOrder.id}/plan/generate`,
        { method: "POST" },
      )));
      expect(clarification).toMatchObject({
        outcome: "clarification",
        workOrder: {
          status: "draft",
          pendingClarification: { questions: [{ prompt: "是否包含移动端检查？" }] },
        },
      });

      const planned = await responseJson(await app.fetch(new Request(
        `http://teamline.local/api/work-orders/${created.workOrder.id}/conversation`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "reply", message: "包含 390px 检查" }),
        },
      )));
      expect(planned).toMatchObject({
        outcome: "plan",
        workOrder: {
          status: "ready",
          projectId: project.project.id,
          pendingClarification: null,
          plan: {
            confirmationRequired: true,
            stages: [{ id: "desktop" }, { id: "mobile" }],
          },
        },
      });

      const confirmedPlanResponse = await app.fetch(new Request(
        `http://teamline.local/api/work-orders/${created.workOrder.id}/plan`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ stages: planned.workOrder.plan.stages }),
        },
      ));
      expect(confirmedPlanResponse.status).toBe(200);

      const workspaceResponse = await app.fetch(new Request(
        `http://teamline.local/api/work-orders/${created.workOrder.id}/workspace`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: workspace }),
        },
      ));
      expect(workspaceResponse.status).toBe(200);
      const startResponse = await app.fetch(new Request(
        `http://teamline.local/api/work-orders/${created.workOrder.id}/start`,
        { method: "POST" },
      ));
      expect(startResponse.status, JSON.stringify(await startResponse.clone().json())).toBe(200);
      await waitFor(() => store.get(created.workOrder.id)?.status === "review");

      const detail = await responseJson(await app.fetch(new Request(
        `http://teamline.local/api/work-orders/${created.workOrder.id}`,
      )));
      const consoleState = await responseJson(await app.fetch(new Request(
        "http://teamline.local/api/console",
      )));
      const projectState = await responseJson(await app.fetch(new Request(
        `http://teamline.local/api/projects/${project.project.id}`,
      )));
      expect(executedStages).toEqual(["desktop", "mobile"]);
      expect(detail.workOrder).toMatchObject({
        status: "review",
        runNumber: 2,
        plan: { stages: [{ status: "completed" }, { status: "completed" }] },
        result: { verifications: [{ stageId: "desktop" }, { stageId: "mobile" }] },
      });
      expect(consoleState.workOrders).toEqual([
        expect.objectContaining({
          id: created.workOrder.id,
          userStatus: "review",
          statusReason: "待验收",
        }),
      ]);
      expect(projectState).toMatchObject({
        summary: { totalGoals: 1, completedGoals: 0 },
        goals: [expect.objectContaining({ id: created.workOrder.id, status: "review" })],
        results: [expect.objectContaining({ workOrderId: created.workOrder.id, status: "review" })],
      });

      const deliveredResponse = await app.fetch(new Request(
        `http://teamline.local/api/work-orders/${created.workOrder.id}/deliver`,
        { method: "POST" },
      ));
      expect(deliveredResponse.status).toBe(200);
      const deliveredConsole = await responseJson(await app.fetch(new Request(
        "http://teamline.local/api/console",
      )));
      const deliveredDetail = await responseJson(await app.fetch(new Request(
        `http://teamline.local/api/work-orders/${created.workOrder.id}`,
      )));
      const deliveredProject = await responseJson(await app.fetch(new Request(
        `http://teamline.local/api/projects/${project.project.id}`,
      )));
      expect(deliveredConsole.workOrders[0]).toMatchObject({
        status: "delivered",
        userStatus: "completed",
        statusReason: "已确认交付",
        result: { verifications: [{ stageId: "desktop" }, { stageId: "mobile" }] },
        plan: { stages: [
          { status: "completed", statusReason: "已由你确认完成" },
          { status: "completed", statusReason: "已由你确认完成" },
        ] },
      });
      expect(deliveredDetail.workOrder).toMatchObject({
        status: "delivered",
        result: { verifications: [{ stageId: "desktop" }, { stageId: "mobile" }] },
        plan: { stages: [{ status: "completed" }, { status: "completed" }] },
      });
      expect(deliveredProject).toMatchObject({
        summary: { totalGoals: 1, completedGoals: 1 },
        goals: [expect.objectContaining({ id: created.workOrder.id, status: "delivered" })],
        results: [expect.objectContaining({ workOrderId: created.workOrder.id, status: "delivered" })],
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("an imported Codex session can be organized into a project goal and continued", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "teamline-v2-import-flow-"));
    const store = new WorkOrderStore(new Database(":memory:"));
    const executedStages: string[] = [];
    let sourceLastActiveAt = "2026-08-04T08:00:00.000Z";
    let organizationCalls = 0;
    const app = createApp({
      store,
      ...successfulExecution(executedStages),
      codexSessionProvider: {
        async discover() {
          return {
            status: "available" as const,
            message: "本机会话可读取",
            sessions: [{
              id: "source-session",
              title: "整理 Personal Beta",
              workspacePath: workspace,
              projectLabel: "Personal Beta",
              lastActiveAt: sourceLastActiveAt,
              sourcePath: join(workspace, "source-session.jsonl"),
              availability: "available" as const,
              message: null,
            }],
          };
        },
      },
      sessionOrganizer: {
        async organize() {
          organizationCalls += 1;
          return {
            description: "继续完成 Personal Beta 发布",
            summary: "历史会话已完成界面设计。",
            currentState: "等待补充发布检查。",
            historicalStages: [{
              id: "history-design",
              outcome: "界面设计完成",
              summary: "主要界面已经确定",
              status: "completed" as const,
              sourceSessionIds: ["source-session"],
            }],
            artifacts: [],
          };
        },
      },
      planGenerator: {
        async generate(workOrder) {
          expect(workOrder.importContext).toMatchObject({
            status: "ready",
            summary: "历史会话已完成界面设计。",
          });
          expect(workOrder.materials).toEqual([
            expect.objectContaining({ value: "发布前检查关键状态" }),
          ]);
          return {
            outcome: "plan" as const,
            message: "后续计划已生成。",
            questions: [],
            stages: [{
              id: "release-check",
              outcome: "完成发布检查",
              scope: "Personal Beta 主流程",
              verification: "检查关键状态",
              verificationCommand: "true",
              dependsOn: [],
              executionMethod: "codex" as const,
            }],
          };
        },
      },
    });

    try {
      const project = await responseJson(await app.fetch(new Request(
        "http://teamline.local/api/projects",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Personal Beta" }),
        },
      )));
      const material = await responseJson(await app.fetch(new Request(
        `http://teamline.local/api/projects/${project.project.id}/materials`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "text",
            label: "发布检查",
            value: "发布前检查关键状态",
          }),
        },
      )));
      const importedResponse = await app.fetch(new Request(
        "http://teamline.local/api/sessions/import",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            source: "codex",
            name: "继续 Personal Beta 发布",
            projectId: project.project.id,
            sessionIds: ["source-session"],
          }),
        },
      ));
      const imported = await responseJson(importedResponse);
      expect(importedResponse.status).toBe(201);
      expect(imported).toMatchObject({
        outcome: "pending",
        workOrder: {
          status: "draft",
          projectId: project.project.id,
          importContext: { status: "pending" },
        },
      });
      await waitFor(() => store.get(imported.workOrder.id)?.importContext?.status === "ready");
      expect(store.get(imported.workOrder.id)?.importContext).toMatchObject({
        status: "ready",
        historicalStages: [{ id: "history-design", status: "completed" }],
      });
      expect(organizationCalls).toBe(1);

      sourceLastActiveAt = "2026-08-04T09:00:00.000Z";
      const updatedSource = await responseJson(await app.fetch(new Request(
        `http://teamline.local/api/work-orders/${imported.workOrder.id}`,
      )));
      expect(updatedSource.sourceStatus).toMatchObject({
        hasUpdates: true,
        sessions: [{ id: "source-session", updateAvailable: true }],
      });
      const reorganizedResponse = await app.fetch(new Request(
        `http://teamline.local/api/work-orders/${imported.workOrder.id}/import-context/organize`,
        { method: "POST" },
      ));
      const reorganized = await responseJson(reorganizedResponse);
      expect(reorganizedResponse.status).toBe(200);
      expect(reorganized).toMatchObject({
        outcome: "ready",
        workOrder: {
          sourceSessions: [{
            id: "source-session",
            lastActiveAt: sourceLastActiveAt,
            lastReadAt: expect.any(String),
          }],
          importContext: { status: "ready" },
        },
      });
      expect(organizationCalls).toBe(2);

      const contextResponse = await app.fetch(new Request(
        `http://teamline.local/api/work-orders/${imported.workOrder.id}/project-context`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId: project.project.id,
            projectMaterialIds: [material.material.id],
          }),
        },
      ));
      expect(contextResponse.status).toBe(200);
      const planResponse = await app.fetch(new Request(
        `http://teamline.local/api/work-orders/${imported.workOrder.id}/plan/generate`,
        { method: "POST" },
      ));
      expect(planResponse.status).toBe(200);
      const planned = await responseJson(planResponse);
      expect(planned).toMatchObject({
        outcome: "plan",
        workOrder: {
          status: "ready",
          projectId: project.project.id,
          sourceSessions: [{ id: "source-session" }],
          currentSessionId: null,
          plan: {
            confirmationRequired: true,
            stages: [{ id: "release-check", status: "planning" }],
          },
        },
      });

      const confirmedPlanResponse = await app.fetch(new Request(
        `http://teamline.local/api/work-orders/${imported.workOrder.id}/plan`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ stages: planned.workOrder.plan.stages }),
        },
      ));
      expect(confirmedPlanResponse.status).toBe(200);

      const startResponse = await app.fetch(new Request(
        `http://teamline.local/api/work-orders/${imported.workOrder.id}/start`,
        { method: "POST" },
      ));
      expect(startResponse.status, JSON.stringify(await startResponse.clone().json())).toBe(200);
      await waitFor(() => store.get(imported.workOrder.id)?.status === "review");

      const detail = await responseJson(await app.fetch(new Request(
        `http://teamline.local/api/work-orders/${imported.workOrder.id}`,
      )));
      const projectDetail = await responseJson(await app.fetch(new Request(
        `http://teamline.local/api/projects/${project.project.id}`,
      )));
      expect(executedStages).toEqual(["release-check"]);
      expect(detail.workOrder).toMatchObject({
        status: "review",
        projectId: project.project.id,
        currentSessionId: "continued-session",
        sourceSessions: [{ id: "source-session" }],
        importContext: {
          historicalStages: [{ id: "history-design", status: "completed" }],
        },
        plan: { stages: [{ id: "release-check", status: "completed" }] },
        result: { verifications: [{ stageId: "release-check", status: "passed" }] },
      });
      expect(projectDetail).toMatchObject({
        summary: { totalGoals: 1, completedGoals: 0 },
        materials: [expect.objectContaining({ id: material.material.id })],
        goals: [expect.objectContaining({ id: imported.workOrder.id, status: "review" })],
      });

      const deliveredResponse = await app.fetch(new Request(
        `http://teamline.local/api/work-orders/${imported.workOrder.id}/deliver`,
        { method: "POST" },
      ));
      expect(deliveredResponse.status).toBe(200);
      const [deliveredDetail, deliveredConsole, deliveredProject] = await Promise.all([
        app.fetch(new Request(`http://teamline.local/api/work-orders/${imported.workOrder.id}`))
          .then(responseJson),
        app.fetch(new Request("http://teamline.local/api/console")).then(responseJson),
        app.fetch(new Request(`http://teamline.local/api/projects/${project.project.id}`))
          .then(responseJson),
      ]);
      expect(deliveredDetail.workOrder).toMatchObject({
        status: "delivered",
        importContext: {
          historicalStages: [{ id: "history-design", status: "completed" }],
        },
        plan: { stages: [{ id: "release-check", status: "completed" }] },
        result: { verifications: [{ stageId: "release-check", status: "passed" }] },
      });
      expect(deliveredConsole.workOrders[0]).toMatchObject({
        id: imported.workOrder.id,
        status: "delivered",
        userStatus: "completed",
      });
      expect(deliveredProject).toMatchObject({
        summary: { totalGoals: 1, completedGoals: 1 },
        goals: [expect.objectContaining({ id: imported.workOrder.id, status: "delivered" })],
        results: [expect.objectContaining({ workOrderId: imported.workOrder.id, status: "delivered" })],
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
