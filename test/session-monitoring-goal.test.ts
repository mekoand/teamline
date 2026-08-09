import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import type { CodexRunEvent, CodexRunner } from "../src/codex-runner";
import { LocalStateTransfer } from "../src/local-state-transfer";
import type { WorkOrderResultProcessor } from "../src/result-processor";
import { sessionMonitoringKey } from "../src/session-monitoring";
import { WorkOrderStore } from "../src/work-order-store";

async function responseJson(response: Response) {
  return await response.json() as Record<string, any>;
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("等待执行流程超时");
    await Bun.sleep(2);
  }
}

function addMonitoredSession(
  store: WorkOrderStore,
  input: {
    sourceKind?: "codex_session" | "claude_code_session";
    executionIdentityId?: string | null;
    executionIdentityLabel?: string;
    id: string;
    title: string;
    projectId: string;
    workspacePath: string;
    snapshot: unknown;
  },
) {
  const sourceKind = input.sourceKind ?? "codex_session";
  const executionIdentityId = input.executionIdentityId === undefined
    ? store.getSystemExecutionIdentityId()
    : input.executionIdentityId;
  const key = sessionMonitoringKey(sourceKind, executionIdentityId, input.id);
  store.upsertDiscoveredSession({
    key,
    sourceKind,
    executionIdentityId,
    executionIdentityLabel: input.executionIdentityLabel ?? "测试 Codex",
    id: input.id,
    title: input.title,
    workspacePath: input.workspacePath,
    projectLabel: "监控项目",
    lastActiveAt: "2026-08-09T01:00:00.000Z",
    sourcePath: null,
    availability: "available",
    message: null,
    lastDiscoveredAt: "2026-08-09T01:01:00.000Z",
  });
  store.updateSessionMonitoring(key, {
    projectId: input.projectId,
    monitoringEnabled: true,
    lastReadPosition: 128,
    lastReadAt: "2026-08-09T01:02:00.000Z",
    organizationStatus: "ready",
    workGraphSnapshot: input.snapshot,
  });
  return key;
}

function runEvents(withSession: boolean, sessionId: string): AsyncIterable<CodexRunEvent> {
  return (async function* () {
    if (withSession) yield { type: "session" as const, sessionId };
    yield { type: "exit" as const, exitCode: 0, message: "Codex 已结束" };
  })();
}

function resultProcessor(verifiedStageIds: string[]): WorkOrderResultProcessor {
  return {
    async process(workOrder) {
      const stage = workOrder.plan!.stages.find((candidate) => candidate.status !== "completed")!;
      verifiedStageIds.push(stage.id);
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
}

describe("从会话监控创建目标", () => {
  test("保存创建时来源上下文，使用新执行会话并保持节点串行验证", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "teamline-monitoring-goal-"));
    const store = new WorkOrderStore(new Database(":memory:"));
    const project = store.createProject("监控项目");
    const snapshot = {
      summary: "接口准备已完成",
      currentState: "等待端到端验证",
      nextAction: "运行端到端验证",
      nodes: [
        { id: "prepare", outcome: "完成接口准备", status: "completed", summary: "接口已经就绪" },
        { id: "verify", outcome: "端到端验证", status: "current", summary: "等待验证" },
      ],
    };
    const sourceKey = addMonitoredSession(store, {
      id: "external-source-session",
      title: "外部会话 · 接口准备",
      projectId: project.id,
      workspacePath: workspace,
      snapshot,
    });
    const executedStageIds: string[] = [];
    const executionKinds: string[] = [];
    const executionSessionIds: string[] = [];
    const verifiedStageIds: string[] = [];
    const runner: CodexRunner = {
      async start({ workOrder }) {
        executionKinds.push("start");
        executionSessionIds.push(workOrder.currentSessionId ?? "");
        executedStageIds.push(workOrder.plan!.stages.find((stage) => stage.status !== "completed")!.id);
        return { interrupt() {}, events: runEvents(true, "new-teamline-execution-session") };
      },
      async resume({ workOrder }) {
        executionKinds.push("resume");
        executionSessionIds.push(workOrder.currentSessionId ?? "");
        executedStageIds.push(workOrder.plan!.stages.find((stage) => stage.status !== "completed")!.id);
        return { interrupt() {}, events: runEvents(false, "new-teamline-execution-session") };
      },
    };
    const app = createApp({
      store,
      codexRunner: runner,
      resultProcessor: resultProcessor(verifiedStageIds),
      planGenerator: {
        async generate(workOrder) {
          expect(workOrder.sourceContext).toMatchObject({
            kind: "session_monitoring",
            projectId: project.id,
            sessions: [{ key: sourceKey, workGraphSnapshot: snapshot }],
          });
          return {
            outcome: "plan" as const,
            message: "从来源进展生成执行计划",
            questions: [],
            stages: [
              {
                id: "continue-verification",
                outcome: "完成端到端验证",
                scope: "监控项目验证流程",
                verification: "运行端到端检查",
                verificationCommand: "true",
                dependsOn: [],
                executionMethod: "codex" as const,
              },
              {
                id: "accept-result",
                outcome: "确认验证结果",
                scope: "监控项目验收",
                verification: "检查验证结果",
                verificationCommand: "true",
                dependsOn: ["continue-verification"],
                executionMethod: "codex" as const,
              },
            ],
          };
        },
      },
    });

    try {
      const createdResponse = await app.fetch(new Request(
        "http://teamline.local/api/session-monitoring/create-goal",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "继续监控项目验证",
            description: "从当前工作图进展继续验证",
            acceptance: "两个验证节点均通过",
            projectId: project.id,
            sessionKeys: [sourceKey],
          }),
        },
      ));
      const created = await responseJson(createdResponse);
      expect(createdResponse.status).toBe(201);
      expect(created).toMatchObject({
        outcome: "created",
        workOrder: {
          projectId: project.id,
          sourceSessions: [],
          sourceContext: {
            kind: "session_monitoring",
            version: 1,
            projectId: project.id,
            sessions: [{
              key: sourceKey,
              monitoringEnabled: true,
              organizationStatus: "ready",
              lastReadPosition: 128,
              workGraphSnapshot: snapshot,
            }],
          },
          importContext: { status: "ready" },
          currentSessionId: null,
        },
      });
      const goalId = created.workOrder.id;
      const createdContext = structuredClone(store.get(goalId)!.sourceContext);
      expect(store.getSessionMonitoring(sourceKey)?.monitoringEnabled).toBe(true);

      store.updateSessionMonitoring(sourceKey, {
        lastReadPosition: 256,
        lastReadAt: "2026-08-09T02:00:00.000Z",
        workGraphSnapshot: { summary: "后来发生的变化", currentState: "来源继续推进" },
      });
      expect(store.getSessionMonitoring(sourceKey)?.monitoringEnabled).toBe(true);
      expect(store.get(goalId)?.sourceContext).toEqual(createdContext);

      const restoredStore = new WorkOrderStore(new Database(":memory:"));
      const restore = new LocalStateTransfer(restoredStore);
      const preview = restore.preview(new LocalStateTransfer(store).export());
      expect(restore.confirm({ previewId: preview.previewId })).toEqual({
        imported: 1,
        copied: 0,
        skipped: 0,
      });
      const restoredContext = restoredStore.get(goalId)!.sourceContext!;
      const restoredExpected = structuredClone(createdContext)!;
      restoredExpected.sessions[0]!.source.executionIdentityId =
        restoredStore.get(goalId)!.executionIdentityId;
      expect(restoredContext).toEqual(restoredExpected);
      restoredStore.database.close();

      const planResponse = await app.fetch(new Request(
        `http://teamline.local/api/work-orders/${goalId}/plan/generate`,
        { method: "POST" },
      ));
      const planned = await responseJson(planResponse);
      expect(planResponse.status).toBe(200);
      expect(planned.workOrder.plan.stages).toEqual([
        expect.objectContaining({ id: "continue-verification", dependsOn: [] }),
        expect.objectContaining({ id: "accept-result", dependsOn: ["continue-verification"] }),
      ]);

      const confirmedPlanResponse = await app.fetch(new Request(
        `http://teamline.local/api/work-orders/${goalId}/plan`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ stages: planned.workOrder.plan.stages }),
        },
      ));
      expect(confirmedPlanResponse.status).toBe(200);
      const startResponse = await app.fetch(new Request(
        `http://teamline.local/api/work-orders/${goalId}/start`,
        { method: "POST" },
      ));
      expect(startResponse.status, JSON.stringify(await startResponse.clone().json())).toBe(200);
      await waitFor(() => store.get(goalId)?.status === "review");

      const detail = store.get(goalId)!;
      expect(executionKinds).toEqual(["start", "resume"]);
      expect(executedStageIds).toEqual(["continue-verification", "accept-result"]);
      expect(verifiedStageIds).toEqual(executedStageIds);
      expect(executionSessionIds).toEqual(["", "new-teamline-execution-session"]);
      expect(detail.currentSessionId).toBe("new-teamline-execution-session");
      expect(detail.sourceSessions).toEqual([]);
      expect(detail.sourceContext?.sessions[0]?.source.id).toBe("external-source-session");
      expect(detail.currentSessionId).not.toBe(detail.sourceContext?.sessions[0]?.source.id);
      expect(detail.plan?.stages.every((stage) => stage.status === "completed")).toBe(true);
      expect(detail.result?.verifications).toHaveLength(2);
      expect(detail.result?.verifications.map((verification) => verification.stageId)).toEqual(executedStageIds);
      expect(store.getSessionMonitoring(sourceKey)?.monitoringEnabled).toBe(true);
    } finally {
      await app.close();
      store.database.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("从正式监控工作或节点创建目标时冻结聚合快照并保持监控独立", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "teamline-monitoring-work-goal-"));
    const store = new WorkOrderStore(new Database(":memory:"));
    const project = store.createProject("监控工作项目");
    const firstKey = addMonitoredSession(store, {
      id: "formal-source-a",
      title: "来源 A",
      projectId: project.id,
      workspacePath: workspace,
      snapshot: { currentState: "A 已完成", nodes: [{ id: "a", outcome: "A 节点", status: "historical" }] },
    });
    const secondKey = addMonitoredSession(store, {
      id: "formal-source-b",
      title: "来源 B",
      projectId: project.id,
      workspacePath: workspace,
      snapshot: { currentState: "B 正在推进", nodes: [{ id: "b", outcome: "B 节点", status: "current" }] },
    });
    const work = store.createSessionMonitoringWork({
      name: "正式多来源监控工作",
      projectId: project.id,
      sourceSessionKeys: [firstKey, secondKey],
    });
    const aggregateSnapshot = {
      version: 1,
      summary: "A 与 B 的聚合进展",
      currentState: "等待发布验证",
      nextAction: "运行发布验证",
      currentProgressPercent: 60,
      enumerablePlan: { completed: 3, total: 5 },
      currentNodeId: "formal-current",
      sourceSessionKeys: [firstKey, secondKey],
      sourceUpdatedAt: { [firstKey]: "2026-08-09T02:00:00.000Z", [secondKey]: "2026-08-09T02:01:00.000Z" },
      nodes: [{
        id: "formal-current",
        outcome: "发布验证",
        summary: "等待两个来源共同确认",
        status: "current",
        estimatedProgress: 60,
        sourceSessionIds: ["formal-source-a", "formal-source-b"],
        sourceSessionKeys: [firstKey, secondKey],
        toolCalls: ["run-check"],
        logs: ["verification.log"],
        artifacts: [{
          id: "release-report",
          type: "file",
          label: "发布报告",
          location: "reports/release.md",
          sourceSessionIds: ["formal-source-b"],
          sourceSessionKeys: [secondKey],
        }],
      }],
      inferredRelations: [],
      artifacts: [{
        id: "release-report",
        type: "file",
        label: "发布报告",
        location: "reports/release.md",
        sourceSessionIds: ["formal-source-b"],
        sourceSessionKeys: [secondKey],
      }],
      toolCalls: ["run-check"],
      logs: ["verification.log"],
    };
    store.updateSessionMonitoringWorkAggregate(work.id, {
      snapshot: aggregateSnapshot,
      status: "ready",
      message: null,
      updatedAt: "2026-08-09T02:02:00.000Z",
    });
    store.updateSessionMonitoringWorkSnapshotRef(work.id, "session-monitoring-work:formal:1");
    const app = createApp({ store });

    try {
      const create = (url: string, body: Record<string, unknown>) => app.fetch(new Request(
        url,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      ));
      const firstResponse = await create(
        `http://teamline.local/api/session-monitoring/works/${work.id}/create-goal`,
        {
          name: "继续正式监控工作",
          projectId: project.id,
          focusNodeId: "formal-current",
        },
      );
      const first = await responseJson(firstResponse);
      expect(firstResponse.status).toBe(201);
      expect(first.workOrder).toMatchObject({
        projectId: project.id,
        sourceSessions: [],
        sourceContext: {
          kind: "session_monitoring",
          projectId: project.id,
          monitoringWork: {
            id: work.id,
            name: work.name,
            projectId: project.id,
            sourceSessionKeys: [firstKey, secondKey],
            aggregateSnapshotRef: "session-monitoring-work:formal:1",
            aggregateSnapshot,
            aggregateStatus: "ready",
            aggregateMessage: null,
            aggregateUpdatedAt: "2026-08-09T02:02:00.000Z",
            focusNodeId: "formal-current",
          },
          sessions: [
            { key: firstKey, monitoringEnabled: true, organizationStatus: "ready" },
            { key: secondKey, monitoringEnabled: true, organizationStatus: "ready" },
          ],
        },
        importContext: {
          status: "ready",
          monitoringContext: {
            workId: work.id,
            workName: work.name,
            sourceSessionKeys: [firstKey, secondKey],
            aggregateSnapshotRef: "session-monitoring-work:formal:1",
            aggregateStatus: "ready",
            aggregateUpdatedAt: "2026-08-09T02:02:00.000Z",
            summary: "A 与 B 的聚合进展",
            currentState: "等待发布验证",
            nextAction: "运行发布验证",
            focusNodeId: "formal-current",
            focusNode: {
              id: "formal-current",
              outcome: "发布验证",
              summary: "等待两个来源共同确认",
              status: "current",
              sourceSessionIds: ["formal-source-a", "formal-source-b"],
              sourceSessionKeys: [firstKey, secondKey],
            },
            artifacts: [{
              id: "release-report",
              type: "file",
              label: "发布报告",
              location: "reports/release.md",
              sourceSessionIds: ["formal-source-b"],
              sourceSessionKeys: [secondKey],
            }],
            toolCalls: ["run-check"],
            logs: ["verification.log"],
          },
        },
      });
      const firstGoalId = first.workOrder.id;
      const frozenContext = structuredClone(store.get(firstGoalId)!.sourceContext);

      const secondResponse = await create("http://teamline.local/api/session-monitoring/create-goal", {
        name: "再次从同一监控工作创建目标",
        projectId: project.id,
        monitoringWorkId: work.id,
      });
      const second = await responseJson(secondResponse);
      expect(secondResponse.status).toBe(201);
      expect(second.workOrder.id).not.toBe(firstGoalId);
      expect(second.workOrder.sourceSessions).toEqual([]);
      expect(second.workOrder.sourceContext.monitoringWork.sourceSessionKeys).toEqual([firstKey, secondKey]);
      expect(store.list().filter((goal) => goal.sourceContext?.monitoringWork?.id === work.id)).toHaveLength(2);

      store.updateSessionMonitoringWorkAggregate(work.id, {
        snapshot: { ...aggregateSnapshot, currentState: "后来已完成验证" },
        status: "ready",
        updatedAt: "2026-08-09T03:00:00.000Z",
      });
      store.updateSessionMonitoring(firstKey, {
        monitoringEnabled: true,
        lastReadPosition: 999,
        workGraphSnapshot: { currentState: "来源继续变化" },
      });
      expect(store.get(firstGoalId)?.sourceContext).toEqual(frozenContext);
      expect(store.getSessionMonitoring(firstKey)?.monitoringEnabled).toBe(true);
      expect(store.getSessionMonitoring(secondKey)?.monitoringEnabled).toBe(true);

      const restoredStore = new WorkOrderStore(new Database(":memory:"));
      const restore = new LocalStateTransfer(restoredStore);
      const preview = restore.preview(new LocalStateTransfer(store).export());
      expect(restore.confirm({ previewId: preview.previewId })).toEqual({
        imported: 2,
        copied: 0,
        skipped: 0,
      });
      const restoredExpected = structuredClone(frozenContext)!;
      for (const session of restoredExpected.sessions) {
        session.source.executionIdentityId = restoredStore.get(firstGoalId)!.executionIdentityId;
      }
      expect(restoredStore.get(firstGoalId)?.sourceContext).toEqual(restoredExpected);

      const failedBefore = store.list().length;
      const failed = await create("http://teamline.local/api/session-monitoring/create-goal", {
        name: "失败后不应留下目标",
        projectId: project.id,
        monitoringWorkId: "missing-monitoring-work",
      });
      expect(failed.status).toBe(400);
      expect(store.list()).toHaveLength(failedBefore);
      expect(store.listSessionMonitoring().filter((session) => session.monitoringEnabled)).toHaveLength(2);
      restoredStore.database.close();
    } finally {
      await app.close();
      store.database.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("允许同项目多工具多账号来源，并允许同一监控会话重复创建目标", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "teamline-monitoring-goal-mixed-"));
    const store = new WorkOrderStore(new Database(":memory:"));
    const project = store.createProject("混合来源项目");
    const alternateIdentity = store.createManagedExecutionIdentity({
      id: "codex-monitoring-secondary",
      label: "第二 Codex 账号",
      managedHomePath: join(workspace, "codex-secondary"),
    });
    const codexKey = addMonitoredSession(store, {
      id: "mixed-codex-source",
      title: "个人 Codex 进展",
      projectId: project.id,
      workspacePath: workspace,
      snapshot: { currentState: "个人账号已完成" },
    });
    const alternateCodexKey = addMonitoredSession(store, {
      id: "mixed-codex-source",
      title: "工作 Codex 进展",
      projectId: project.id,
      workspacePath: workspace,
      sourceKind: "codex_session",
      executionIdentityId: alternateIdentity.id,
      executionIdentityLabel: alternateIdentity.label,
      snapshot: { currentState: "工作账号已完成" },
    });
    const claudeKey = addMonitoredSession(store, {
      id: "mixed-claude-source",
      title: "Claude Code 进展",
      projectId: project.id,
      workspacePath: workspace,
      sourceKind: "claude_code_session",
      executionIdentityId: null,
      executionIdentityLabel: "Claude Code",
      snapshot: { currentState: "Claude Code 已完成" },
    });
    const app = createApp({ store });

    try {
      const create = async (name: string, sessionKeys: string[]) => {
        const response = await app.fetch(new Request(
          "http://teamline.local/api/session-monitoring/create-goal",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name, projectId: project.id, sessionKeys }),
          },
        ));
        expect(response.status).toBe(201);
        return (await responseJson(response)).workOrder;
      };
      const mixed = await create("混合来源目标", [codexKey, alternateCodexKey, claudeKey]);
      expect(mixed.sourceSessions).toEqual([]);
      expect(mixed.executionIdentityId).toBeNull();
      expect(mixed.sourceContext.sessions.map((session: any) => ({
        kind: session.source.kind,
        id: session.source.id,
        executionIdentityId: session.source.executionIdentityId ?? null,
      }))).toEqual([
        { kind: "codex_session", id: "mixed-codex-source", executionIdentityId: store.getSystemExecutionIdentityId() },
        { kind: "codex_session", id: "mixed-codex-source", executionIdentityId: alternateIdentity.id },
        { kind: "claude_code_session", id: "mixed-claude-source", executionIdentityId: null },
      ]);

      const repeated = await create("同一会话的后续目标", [codexKey]);
      expect(repeated.sourceSessions).toEqual([]);
      expect(repeated.sourceContext.sessions[0].key).toBe(codexKey);
      expect(store.list().filter((goal) => goal.sourceContext?.sessions.some((session) => session.key === codexKey))).toHaveLength(2);
      expect(store.listSessionMonitoring().filter((session) => session.monitoringEnabled)).toHaveLength(3);

      const restoredStore = new WorkOrderStore(new Database(":memory:"));
      const transfer = new LocalStateTransfer(restoredStore);
      const preview = transfer.preview(transferFrom(store));
      expect(transfer.confirm({ previewId: preview.previewId })).toEqual({
        imported: 2,
        copied: 0,
        skipped: 0,
      });
      expect(restoredStore.list().every((goal) => goal.sourceSessions.length === 0)).toBe(true);
      expect(restoredStore.list().map((goal) => goal.sourceContext?.sessions.length).sort((a, b) => a - b)).toEqual([1, 3]);
      restoredStore.database.close();
    } finally {
      await app.close();
      store.database.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("不同监控来源创建的目标仍由同一并发执行器并行运行", async () => {
    const firstWorkspace = mkdtempSync(join(tmpdir(), "teamline-monitoring-goal-a-"));
    const secondWorkspace = mkdtempSync(join(tmpdir(), "teamline-monitoring-goal-b-"));
    const store = new WorkOrderStore(new Database(":memory:"));
    const project = store.createProject("并行监控项目");
    const firstKey = addMonitoredSession(store, {
      id: "parallel-source-a",
      title: "并行来源 A",
      projectId: project.id,
      workspacePath: firstWorkspace,
      snapshot: { currentState: "来源 A 就绪" },
    });
    const secondKey = addMonitoredSession(store, {
      id: "parallel-source-b",
      title: "并行来源 B",
      projectId: project.id,
      workspacePath: secondWorkspace,
      snapshot: { currentState: "来源 B 就绪" },
    });
    const controlledRuns = [
      (() => {
        let release!: () => void;
        const released = new Promise<void>((resolve) => { release = resolve; });
        return { release, events: (async function* () { await released; yield { type: "exit" as const, exitCode: 0, message: "完成" }; })() };
      })(),
      (() => {
        let release!: () => void;
        const released = new Promise<void>((resolve) => { release = resolve; });
        return { release, events: (async function* () { await released; yield { type: "exit" as const, exitCode: 0, message: "完成" }; })() };
      })(),
    ];
    const startedGoalIds: string[] = [];
    const verifiedStageIds: string[] = [];
    let runIndex = 0;
    const app = createApp({
      store,
      codexRunner: {
        async start({ workOrder }) {
          startedGoalIds.push(workOrder.id);
          return { interrupt() {}, events: controlledRuns[runIndex++]!.events };
        },
        async resume() {
          throw new Error("并行测试不应恢复已有会话");
        },
      },
      resultProcessor: resultProcessor(verifiedStageIds),
    });

    try {
      const create = async (sessionKey: string, name: string) => {
        const response = await app.fetch(new Request(
          "http://teamline.local/api/session-monitoring/create-goal",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name, projectId: project.id, sessionKeys: [sessionKey] }),
          },
        ));
        expect(response.status).toBe(201);
        return (await responseJson(response)).workOrder.id as string;
      };
      const firstGoalId = await create(firstKey, "并行目标 A");
      const secondGoalId = await create(secondKey, "并行目标 B");
      for (const [id, outcome] of [[firstGoalId, "完成目标 A"], [secondGoalId, "完成目标 B"]] as const) {
        store.savePlan(id, [{ outcome, scope: "监控来源后的执行", verification: "检查结果" }]);
      }

      const responses = await Promise.all([
        app.fetch(new Request(`http://teamline.local/api/work-orders/${firstGoalId}/start`, { method: "POST" })),
        app.fetch(new Request(`http://teamline.local/api/work-orders/${secondGoalId}/start`, { method: "POST" })),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 200]);
      expect(startedGoalIds).toHaveLength(2);
      expect(new Set(startedGoalIds)).toEqual(new Set([firstGoalId, secondGoalId]));
      expect(store.get(firstGoalId)?.runStatus).toBe("running");
      expect(store.get(secondGoalId)?.runStatus).toBe("running");

      controlledRuns.forEach((run) => run.release());
      await waitFor(() => store.get(firstGoalId)?.status === "review" && store.get(secondGoalId)?.status === "review");
      expect(verifiedStageIds).toHaveLength(2);
      expect(store.get(firstGoalId)?.result?.verifications).toHaveLength(1);
      expect(store.get(secondGoalId)?.result?.verifications).toHaveLength(1);
    } finally {
      controlledRuns.forEach((run) => run.release());
      await app.close();
      store.database.close();
      rmSync(firstWorkspace, { recursive: true, force: true });
      rmSync(secondWorkspace, { recursive: true, force: true });
    }
  });
});

function transferFrom(store: WorkOrderStore) {
  return new LocalStateTransfer(store).export();
}
