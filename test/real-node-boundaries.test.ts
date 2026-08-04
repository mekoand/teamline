import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../src/app";
import {
  CodexExecutionRunner,
  type CodexRunEvent,
  type CodexRunner,
} from "../src/codex-runner";
import type { WorkOrderResultProcessor } from "../src/result-processor";
import { WorkOrderStore } from "../src/work-order-store";

const workspacePath = resolve(import.meta.dir, "..");

async function waitFor(condition: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(2);
  }
}

describe("real AI node boundaries", () => {
  test("runs serial AI nodes once each and reaches review only after the last node", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const executions: Array<{ kind: "start" | "resume"; runNumber: number; stages: string[] }> = [];
    const events = (includeSession: boolean): AsyncIterable<CodexRunEvent> =>
      (async function* () {
        if (includeSession) yield { type: "session" as const, sessionId: "session-abc" };
        yield { type: "exit" as const, exitCode: 0, message: "Codex 已结束" };
      })();
    const codexRunner: CodexRunner = {
      async start({ workOrder }) {
        executions.push({
          kind: "start",
          runNumber: workOrder.runNumber,
          stages: workOrder.plan!.stages.map((stage) => stage.id),
        });
        return { interrupt() {}, events: events(true) };
      },
      async resume({ workOrder }) {
        executions.push({
          kind: "resume",
          runNumber: workOrder.runNumber,
          stages: workOrder.plan!.stages.map((stage) => stage.id),
        });
        return { interrupt() {}, events: events(false) };
      },
    };
    const resultProcessor: WorkOrderResultProcessor = {
      async process(workOrder) {
        const stage = workOrder.plan!.stages[0]!;
        return {
          planVersion: workOrder.plan!.version,
          git: { diffStat: "", statusShort: "" },
          verifications: [
            {
              stageId: stage.id,
              stageOutcome: stage.outcome,
              command: stage.verificationCommand ?? null,
              status: "passed",
              exitCode: 0,
              output: "pass",
            },
          ],
          completedAt: new Date().toISOString(),
        };
      },
    };
    const app = createApp({ store, codexRunner, resultProcessor });
    const created = store.create({
      workspace: { kind: "directory", path: workspacePath },
      goal: "依次完成 A、B、C",
    });
    store.savePlan(created.id, [
      {
        id: "A",
        outcome: "完成 A",
        scope: "A.md",
        verification: "check A",
        verificationCommand: "check-a",
      },
      {
        id: "B",
        outcome: "完成 B",
        scope: "B.md",
        verification: "check B",
        verificationCommand: "check-b",
        dependsOn: ["A"],
      },
      {
        id: "C",
        outcome: "完成 C",
        scope: "C.md",
        verification: "check C",
        verificationCommand: "check-c",
        dependsOn: ["B"],
      },
    ]);

    const response = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/start`, {
        method: "POST",
      }),
    );
    expect(response.status).toBe(200);
    await waitFor(() => store.get(created.id)?.status === "review");

    expect(executions).toEqual([
      { kind: "start", runNumber: 1, stages: ["A"] },
      { kind: "resume", runNumber: 2, stages: ["B"] },
      { kind: "resume", runNumber: 3, stages: ["C"] },
    ]);
    expect(store.get(created.id)).toMatchObject({
      status: "review",
      runStatus: "completed",
      runNumber: 3,
      plan: {
        stages: [
          { id: "A", status: "completed" },
          { id: "B", status: "completed" },
          { id: "C", status: "completed" },
        ],
      },
      result: {
        verifications: [{ stageId: "A" }, { stageId: "B" }, { stageId: "C" }],
      },
    });
  });

  test("each Codex prompt contains only the current node and asks Codex to exit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-node-prompt-"));
    const executable = join(directory, "fake-codex");
    const invocationLog = join(directory, "invocations.txt");
    try {
      writeFileSync(
        executable,
        [
          "#!/bin/sh",
          `printf '%s\\n' '<invocation>' >> "${invocationLog}"`,
          `printf '<%s>\\n' "$@" >> "${invocationLog}"`,
          'case " $* " in *" resume "*) ;; *) printf \'%s\\n\' \'{"thread_id":"session-prompt"}\' ;; esac',
          "exit 0",
          "",
        ].join("\n"),
      );
      chmodSync(executable, 0o755);
      const store = new WorkOrderStore(new Database(":memory:"));
      const app = createApp({
        store,
        codexRunner: new CodexExecutionRunner(executable),
        resultProcessor: {
          async process(workOrder) {
            const stage = workOrder.plan!.stages[0]!;
            return {
              planVersion: workOrder.plan!.version,
              git: { diffStat: "", statusShort: "" },
              verifications: [{
                stageId: stage.id,
                stageOutcome: stage.outcome,
                command: "check",
                status: "passed" as const,
                exitCode: 0,
                output: "pass",
              }],
              completedAt: new Date().toISOString(),
            };
          },
        },
      });
      const created = store.create({
        workspace: { kind: "directory", path: directory },
        goal: "按已确认执行图推进",
      });
      store.savePlan(created.id, [
        { id: "A", outcome: "ALPHA_ONLY", scope: "A", verification: "check", verificationCommand: "check" },
        { id: "B", outcome: "BETA_ONLY", scope: "B", verification: "check", verificationCommand: "check", dependsOn: ["A"] },
        { id: "C", outcome: "GAMMA_ONLY", scope: "C", verification: "check", verificationCommand: "check", dependsOn: ["B"] },
      ]);

      const response = await app.fetch(
        new Request(`http://teamline.local/api/work-orders/${created.id}/start`, { method: "POST" }),
      );
      expect(response.status).toBe(200);
      await waitFor(() => store.get(created.id)?.status === "review");

      const invocations = readFileSync(invocationLog, "utf8").split("<invocation>\n").slice(1);
      expect(invocations).toHaveLength(3);
      expect(invocations[0]).toContain("ALPHA_ONLY");
      expect(invocations[0]).not.toContain("BETA_ONLY");
      expect(invocations[0]).not.toContain("GAMMA_ONLY");
      expect(invocations[1]).toContain("BETA_ONLY");
      expect(invocations[1]).not.toContain("ALPHA_ONLY");
      expect(invocations[1]).not.toContain("GAMMA_ONLY");
      expect(invocations[2]).toContain("GAMMA_ONLY");
      expect(invocations[2]).not.toContain("ALPHA_ONLY");
      expect(invocations[2]).not.toContain("BETA_ONLY");
      for (const invocation of invocations) {
        expect(invocation).toContain("完成当前节点后退出");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("model stage markers are log hints and cannot advance node state", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const app = createApp({
      store,
      codexRunner: {
        async start() {
          return {
            interrupt() {},
            events: (async function* (): AsyncGenerator<CodexRunEvent> {
              yield {
                type: "progress",
                message: "TEAMLINE_STAGE_COMPLETE:A\nTEAMLINE_STAGE_START:B",
              };
              yield { type: "exit", exitCode: 1, message: "Codex 运行失败" };
            })(),
          };
        },
        async resume() {
          throw new Error("not used");
        },
      },
    });
    const created = store.create({
      workspace: { kind: "directory", path: workspacePath },
      goal: "模型标记不能推进节点",
    });
    store.savePlan(created.id, [
      { id: "A", outcome: "完成 A", scope: "A", verification: "check" },
      { id: "B", outcome: "完成 B", scope: "B", verification: "check", dependsOn: ["A"] },
    ]);

    const response = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/start`, { method: "POST" }),
    );
    expect(response.status).toBe(200);
    await waitFor(() => store.get(created.id)?.status === "interrupted");

    expect(store.get(created.id)?.plan?.stages).toMatchObject([
      { id: "A", status: "running" },
      { id: "B", status: "queued" },
    ]);
  });

  test("a failed node verification stops before the next AI node and keeps prior results", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const executions: string[] = [];
    const app = createApp({
      store,
      codexRunner: {
        async start({ workOrder }) {
          const stageId = workOrder.plan!.stages[0]!.id;
          executions.push(stageId);
          return {
            interrupt() {},
            events: (async function* (): AsyncGenerator<CodexRunEvent> {
              yield { type: "exit", exitCode: 0, message: "Codex 已结束" };
            })(),
          };
        },
        async resume({ workOrder }) {
          const stageId = workOrder.plan!.stages[0]!.id;
          executions.push(stageId);
          return {
            interrupt() {},
            events: (async function* (): AsyncGenerator<CodexRunEvent> {
              yield { type: "exit", exitCode: 0, message: "Codex 已结束" };
            })(),
          };
        },
      },
      resultProcessor: {
        async process(workOrder) {
          const stage = workOrder.plan!.stages[0]!;
          const passed = stage.id !== "B";
          return {
            planVersion: workOrder.plan!.version,
            git: { diffStat: "", statusShort: "" },
            verifications: [{
              stageId: stage.id,
              stageOutcome: stage.outcome,
              command: "check",
              status: passed ? "passed" as const : "failed" as const,
              exitCode: passed ? 0 : 1,
              output: passed ? "pass" : "fail",
            }],
            completedAt: new Date().toISOString(),
          };
        },
      },
    });
    const created = store.create({
      workspace: { kind: "directory", path: workspacePath },
      goal: "B 失败后停止",
    });
    store.savePlan(created.id, [
      { id: "A", outcome: "完成 A", scope: "A", verification: "check", verificationCommand: "check" },
      { id: "B", outcome: "完成 B", scope: "B", verification: "check", verificationCommand: "check", dependsOn: ["A"] },
      { id: "C", outcome: "完成 C", scope: "C", verification: "check", verificationCommand: "check", dependsOn: ["B"] },
    ]);

    const response = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/start`, { method: "POST" }),
    );
    expect(response.status).toBe(200);
    await waitFor(() => store.get(created.id)?.status === "interrupted");

    expect(executions).toEqual(["A", "B"]);
    expect(store.get(created.id)).toMatchObject({
      status: "interrupted",
      runNumber: 2,
      plan: { stages: [
        { id: "A", status: "completed" },
        { id: "B", status: "response" },
        { id: "C", status: "queued" },
      ] },
      result: { verifications: [{ stageId: "A" }, { stageId: "B", status: "failed" }] },
    });
  });

  test("an AI node without automatic verification waits for confirmation", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const executions: string[] = [];
    const app = createApp({
      store,
      codexRunner: {
        async start({ workOrder }) {
          executions.push(workOrder.plan!.stages[0]!.id);
          return {
            interrupt() {},
            events: (async function* (): AsyncGenerator<CodexRunEvent> {
              yield { type: "exit", exitCode: 0, message: "Codex 已结束" };
            })(),
          };
        },
        async resume() {
          throw new Error("must wait for confirmation");
        },
      },
      resultProcessor: {
        async process(workOrder) {
          const stage = workOrder.plan!.stages[0]!;
          return {
            planVersion: workOrder.plan!.version,
            git: { diffStat: "", statusShort: "" },
            verifications: [{
              stageId: stage.id,
              stageOutcome: stage.outcome,
              command: null,
              status: "not_configured" as const,
              exitCode: null,
              output: "未配置自动验证命令",
            }],
            completedAt: new Date().toISOString(),
          };
        },
      },
    });
    const created = store.create({
      workspace: { kind: "directory", path: workspacePath },
      goal: "人工确认 A 后再运行 B",
    });
    store.savePlan(created.id, [
      { id: "A", outcome: "完成 A", scope: "A", verification: "人工检查" },
      { id: "B", outcome: "完成 B", scope: "B", verification: "check", verificationCommand: "check", dependsOn: ["A"] },
    ]);

    const response = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/start`, { method: "POST" }),
    );
    expect(response.status).toBe(200);
    await waitFor(() => store.get(created.id)?.status === "interrupted");
    expect(executions).toEqual(["A"]);
    expect(store.get(created.id)).toMatchObject({
      status: "interrupted",
      plan: { stages: [
        { id: "A", status: "response" },
        { id: "B", status: "queued" },
      ] },
    });

    const confirmation = await app.fetch(
      new Request(
        `http://teamline.local/api/work-orders/${created.id}/confirm-stage-results`,
        { method: "POST" },
      ),
    );
    expect(confirmation.status).toBe(200);
    expect((await confirmation.json()).workOrder).toMatchObject({
      status: "ready",
      runStatus: null,
      plan: { stages: [
        { id: "A", status: "completed" },
        { id: "B", status: "planning" },
      ] },
    });
    expect(executions).toEqual(["A"]);
  });

  test("a Git node saves one baseline and a stage checkpoint after manual confirmation", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const captures: string[] = [];
    let preparations = 0;
    const executions: string[] = [];
    const app = createApp({
      store,
      worktreeManager: {
        async prepare() {
          preparations += 1;
          return { path: workspacePath, branch: "codex/manual-checkpoint", baseCommit: "base" };
        },
      },
      checkpointManager: {
        async capture(_path, reference) {
          captures.push(reference);
          return captures.length.toString().padStart(40, "0");
        },
        async describe() {
          return { diffStat: "", statusShort: "" };
        },
        async restore() {
          return { residueTreeHash: "f".repeat(40) };
        },
      },
      codexRunner: {
        async start({ workOrder }) {
          executions.push(`start:${workOrder.plan!.stages[0]!.id}`);
          return {
            interrupt() {},
            events: (async function* (): AsyncGenerator<CodexRunEvent> {
              yield { type: "session", sessionId: "manual-session" };
              yield { type: "exit", exitCode: 0, message: "Codex 已结束" };
            })(),
          };
        },
        async resume({ workOrder }) {
          executions.push(`resume:${workOrder.plan!.stages[0]!.id}`);
          return {
            interrupt() {},
            events: (async function* (): AsyncGenerator<CodexRunEvent> {
              yield { type: "exit", exitCode: 0, message: "Codex 已结束" };
            })(),
          };
        },
      },
      resultProcessor: {
        async process(workOrder) {
          const stage = workOrder.plan!.stages[0]!;
          return {
            planVersion: workOrder.plan!.version,
            git: { diffStat: "", statusShort: "" },
            verifications: [{
              stageId: stage.id,
              stageOutcome: stage.outcome,
              command: null,
              status: "not_configured" as const,
              exitCode: null,
              output: "未配置自动验证命令",
            }],
            completedAt: new Date().toISOString(),
          };
        },
      },
    });
    const created = store.create({
      workspace: { kind: "git", path: workspacePath },
      goal: "人工确认后保存 Git 检查点",
    });
    store.savePlan(created.id, [
      { id: "A", outcome: "完成 A", scope: "A", verification: "人工检查" },
      { id: "B", outcome: "完成 B", scope: "B", verification: "人工检查", dependsOn: ["A"] },
    ]);

    const start = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/start`, { method: "POST" }),
    );
    expect(start.status).toBe(200);
    await waitFor(() => store.get(created.id)?.status === "interrupted");
    expect(store.get(created.id)?.checkpoints).toMatchObject([{ kind: "baseline" }]);

    const confirmation = await app.fetch(
      new Request(
        `http://teamline.local/api/work-orders/${created.id}/confirm-stage-results`,
        { method: "POST" },
      ),
    );
    expect(confirmation.status).toBe(200);
    expect(store.get(created.id)?.checkpoints).toMatchObject([
      { kind: "baseline", stageId: null },
      { kind: "stage", stageId: "A", runNumber: 1 },
    ]);
    expect(captures).toHaveLength(2);

    const nextStart = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/start`, { method: "POST" }),
    );
    expect(nextStart.status).toBe(200);
    await waitFor(() => store.get(created.id)?.plan?.stages[1]?.status === "response");
    expect(preparations).toBe(1);
    expect(captures).toHaveLength(2);
    expect(executions).toEqual(["start:A", "resume:B"]);
  });

  test("serial Git nodes reuse one worktree and baseline while saving one checkpoint per node", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    let preparations = 0;
    const captures: string[] = [];
    const app = createApp({
      store,
      worktreeManager: {
        async prepare() {
          preparations += 1;
          return { path: workspacePath, branch: "codex/serial-checkpoints", baseCommit: "base" };
        },
      },
      checkpointManager: {
        async capture(_path, reference) {
          captures.push(reference);
          return captures.length.toString().padStart(40, "0");
        },
        async describe() {
          return { diffStat: "", statusShort: "" };
        },
        async restore() {
          return { residueTreeHash: "f".repeat(40) };
        },
      },
      codexRunner: {
        async start() {
          return {
            interrupt() {},
            events: (async function* (): AsyncGenerator<CodexRunEvent> {
              yield { type: "exit", exitCode: 0, message: "Codex 已结束" };
            })(),
          };
        },
        async resume() {
          throw new Error("no saved session");
        },
      },
      resultProcessor: {
        async process(workOrder) {
          const stage = workOrder.plan!.stages[0]!;
          return {
            planVersion: workOrder.plan!.version,
            git: { diffStat: "", statusShort: "" },
            verifications: [{
              stageId: stage.id,
              stageOutcome: stage.outcome,
              command: "check",
              status: "passed" as const,
              exitCode: 0,
              output: "pass",
            }],
            completedAt: new Date().toISOString(),
          };
        },
      },
    });
    const created = store.create({
      workspace: { kind: "git", path: workspacePath },
      goal: "每个 Git 节点保存检查点",
    });
    store.savePlan(created.id, [
      { id: "A", outcome: "完成 A", scope: "A", verification: "check", verificationCommand: "check" },
      { id: "B", outcome: "完成 B", scope: "B", verification: "check", verificationCommand: "check", dependsOn: ["A"] },
      { id: "C", outcome: "完成 C", scope: "C", verification: "check", verificationCommand: "check", dependsOn: ["B"] },
    ]);

    const response = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/start`, { method: "POST" }),
    );
    expect(response.status).toBe(200);
    await waitFor(() => store.get(created.id)?.status === "review");

    expect(preparations).toBe(1);
    expect(captures).toHaveLength(4);
    expect(store.get(created.id)?.checkpoints).toMatchObject([
      { kind: "baseline", runNumber: 1 },
      { kind: "stage", stageId: "A", runNumber: 1 },
      { kind: "stage", stageId: "B", runNumber: 2 },
      { kind: "stage", stageId: "C", runNumber: 3 },
    ]);
  });

  test("an external node stops automatic progress before the following AI node", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const executions: string[] = [];
    const app = createApp({
      store,
      codexRunner: {
        async start({ workOrder }) {
          executions.push(workOrder.plan!.stages[0]!.id);
          return {
            interrupt() {},
            events: (async function* (): AsyncGenerator<CodexRunEvent> {
              yield { type: "exit", exitCode: 0, message: "Codex 已结束" };
            })(),
          };
        },
        async resume() {
          throw new Error("external node must stop automatic progress");
        },
      },
      resultProcessor: {
        async process(workOrder) {
          const stage = workOrder.plan!.stages[0]!;
          return {
            planVersion: workOrder.plan!.version,
            git: { diffStat: "", statusShort: "" },
            verifications: [{
              stageId: stage.id,
              stageOutcome: stage.outcome,
              command: "check",
              status: "passed" as const,
              exitCode: 0,
              output: "pass",
            }],
            completedAt: new Date().toISOString(),
          };
        },
      },
    });
    const created = store.create({
      workspace: { kind: "directory", path: workspacePath },
      goal: "AI 后等待外部结果",
    });
    store.savePlan(created.id, [
      { id: "A", outcome: "完成 A", scope: "A", verification: "check", verificationCommand: "check" },
      { id: "X", outcome: "外部确认", scope: "external", verification: "用户确认", executionMethod: "external", dependsOn: ["A"] },
      { id: "B", outcome: "完成 B", scope: "B", verification: "check", verificationCommand: "check", dependsOn: ["X"] },
    ]);

    const response = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/start`, { method: "POST" }),
    );
    expect(response.status).toBe(200);
    await waitFor(() => store.get(created.id)?.status === "interrupted");
    expect(executions).toEqual(["A"]);
    expect(store.get(created.id)?.plan?.stages).toMatchObject([
      { id: "A", status: "completed" },
      { id: "X", status: "response" },
      { id: "B", status: "queued" },
    ]);

    const external = await app.fetch(
      new Request(
        `http://teamline.local/api/work-orders/${created.id}/plan-stages/X/complete-external`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ conclusion: "已确认" }),
        },
      ),
    );
    expect(external.status).toBe(200);
    expect((await external.json()).workOrder).toMatchObject({
      status: "ready",
      plan: { stages: [
        { id: "A", status: "completed" },
        { id: "X", status: "completed" },
        { id: "B", status: "planning" },
      ] },
    });
    expect(executions).toEqual(["A"]);
  });

  test("continue scopes a failed response node instead of sending the full plan", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const resumedStages: string[][] = [];
    const app = createApp({
      store,
      codexRunner: {
        async start() {
          throw new Error("not used");
        },
        async resume({ workOrder }) {
          resumedStages.push(workOrder.plan!.stages.map((stage) => stage.id));
          return {
            interrupt() {},
            events: (async function* (): AsyncGenerator<CodexRunEvent> {
              yield { type: "exit", exitCode: 1, message: "stop" };
            })(),
          };
        },
      },
    });
    const created = store.create({
      workspace: { kind: "directory", path: workspacePath },
      goal: "只继续失败的 B",
    });
    store.savePlan(created.id, [
      { id: "A", outcome: "完成 A", scope: "A", verification: "check", verificationCommand: "check" },
      { id: "B", outcome: "完成 B", scope: "B", verification: "check", verificationCommand: "check", dependsOn: ["A"] },
    ]);
    store.saveDirectWorkspace(created.id, workspacePath);
    store.markStarted(created.id);
    const firstVerifying = store.beginResultProcessing(created.id, "A done");
    store.completeReview(created.id, {
      planVersion: firstVerifying.plan!.version,
      git: { diffStat: "", statusShort: "" },
      verifications: [{
        stageId: "A",
        stageOutcome: "完成 A",
        command: "check",
        status: "passed",
        exitCode: 0,
        output: "pass",
      }],
      completedAt: new Date().toISOString(),
    });
    store.markNextStageStarted(created.id);
    store.recordSession(created.id, "saved-session");
    const secondVerifying = store.beginResultProcessing(created.id, "B done");
    store.recordVerificationFailure(created.id, {
      planVersion: secondVerifying.plan!.version,
      git: { diffStat: "", statusShort: "" },
      verifications: [{
        stageId: "B",
        stageOutcome: "完成 B",
        command: "check",
        status: "failed",
        exitCode: 1,
        output: "fail",
      }],
      completedAt: new Date().toISOString(),
    });

    const response = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/continue`, { method: "POST" }),
    );
    expect(response.status).toBe(200);
    expect(resumedStages).toEqual([["B"]]);
  });

  test("interrupts a next-node run that appears after an interrupt during startup", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    let releaseResume!: (run: Awaited<ReturnType<CodexRunner["resume"]>>) => void;
    const pendingResume = new Promise<Awaited<ReturnType<CodexRunner["resume"]>>>((resolve) => {
      releaseResume = resolve;
    });
    let resumeRequested = false;
    let nextRunInterrupts = 0;
    let nextRunEventsConsumed = 0;
    let finishNextRun!: (exitCode: number) => void;
    const nextRunExited = new Promise<number>((resolve) => {
      finishNextRun = resolve;
    });
    const app = createApp({
      store,
      codexRunner: {
        async start() {
          return {
            interrupt() {},
            events: (async function* (): AsyncGenerator<CodexRunEvent> {
              yield { type: "session", sessionId: "race-session" };
              yield { type: "exit", exitCode: 0, message: "A done" };
            })(),
          };
        },
        async resume() {
          resumeRequested = true;
          return pendingResume;
        },
      },
      resultProcessor: {
        async process(workOrder) {
          const stage = workOrder.plan!.stages[0]!;
          return {
            planVersion: workOrder.plan!.version,
            git: { diffStat: "", statusShort: "" },
            verifications: [{
              stageId: stage.id,
              stageOutcome: stage.outcome,
              command: "check",
              status: "passed" as const,
              exitCode: 0,
              output: "pass",
            }],
            completedAt: new Date().toISOString(),
          };
        },
      },
    });
    const created = store.create({
      workspace: { kind: "directory", path: workspacePath },
      goal: "切换节点时可中断",
    });
    store.savePlan(created.id, [
      { id: "A", outcome: "完成 A", scope: "A", verification: "check", verificationCommand: "check" },
      { id: "B", outcome: "完成 B", scope: "B", verification: "check", verificationCommand: "check", dependsOn: ["A"] },
    ]);

    const start = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/start`, { method: "POST" }),
    );
    expect(start.status).toBe(200);
    await waitFor(() => resumeRequested);

    const interrupted = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/interrupt`, { method: "POST" }),
    );
    expect(interrupted.status).toBe(200);
    expect(store.get(created.id)?.runStatus).toBe("stopping");

    releaseResume({
      interrupt() {
        nextRunInterrupts += 1;
      },
      events: {
        [Symbol.asyncIterator]() {
          nextRunEventsConsumed += 1;
          return (async function* (): AsyncGenerator<CodexRunEvent> {})();
        },
      },
      exited: nextRunExited,
    });
    await waitFor(() => nextRunInterrupts === 1);
    await Bun.sleep(5);
    expect(store.get(created.id)?.runStatus).toBe("stopping");
    expect(nextRunEventsConsumed).toBe(0);

    finishNextRun(143);
    await waitFor(() => store.get(created.id)?.status === "interrupted");
    expect(nextRunInterrupts).toBe(1);
    expect(nextRunEventsConsumed).toBe(0);
    expect(store.get(created.id)).toMatchObject({ status: "interrupted", runStatus: "interrupted" });
  });

  test("a retry after baseline capture reuses the prepared worktree and baseline", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    let preparations = 0;
    let captures = 0;
    let starts = 0;
    const app = createApp({
      store,
      worktreeManager: {
        async prepare() {
          preparations += 1;
          return { path: workspacePath, branch: "codex/baseline-retry", baseCommit: "base" };
        },
      },
      checkpointManager: {
        async capture() {
          captures += 1;
          return String(captures).padStart(40, "0");
        },
        async describe() {
          return { diffStat: "", statusShort: "" };
        },
        async restore() {
          return { residueTreeHash: "f".repeat(40) };
        },
      },
      codexRunner: {
        async start() {
          starts += 1;
          if (starts === 1) throw new Error("Codex start failed");
          return {
            interrupt() {},
            events: (async function* (): AsyncGenerator<CodexRunEvent> {})(),
          };
        },
        async resume() {
          throw new Error("not used");
        },
      },
    });
    const created = store.create({
      workspace: { kind: "git", path: workspacePath },
      goal: "启动失败后复用 baseline",
    });
    store.savePlan(created.id, [
      { id: "A", outcome: "完成 A", scope: "A", verification: "check", verificationCommand: "check" },
    ]);

    const failed = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/start`, { method: "POST" }),
    );
    expect(failed.status).toBe(502);
    expect(store.get(created.id)?.checkpoints).toMatchObject([{ kind: "baseline" }]);

    const retried = await app.fetch(
      new Request(`http://teamline.local/api/work-orders/${created.id}/start`, { method: "POST" }),
    );
    expect(retried.status).toBe(200);
    expect(preparations).toBe(1);
    expect(captures).toBe(1);
    expect(starts).toBe(2);
  });
});
