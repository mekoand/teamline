import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PlanGenerator } from "./plan-generator";
import type { CheckpointManager } from "./checkpoint-manager";
import { presentConsoleWorkOrders } from "./console-presentation";
import type { WorkOrderResultProcessor } from "./result-processor";
import type {
  ContinuationContext,
  CodexRunEvent,
  CodexRunner,
  StartedCodexRun,
} from "./codex-runner";
import {
  workOrderMaterialKinds,
  type PlanStageInput,
  type PlanStage,
  type WorkOrderMaterialKind,
  type WorkOrderCheckpoint,
  type WorkOrder,
} from "./work-order";
import { PlanLockedError, type WorkOrderStore } from "./work-order-store";
import type { DelegatedWorktree, WorktreeManager } from "./worktree-manager";
import {
  unavailableResourceSnapshot,
  type ResourceProvider,
} from "./resource-provider";
import { presentResources } from "./resource-presentation";
import { decideAutoRun } from "./resource-scheduler";

type AppDependencies = {
  store: WorkOrderStore;
  planGenerator?: PlanGenerator;
  planGenerationTimeoutMs?: number;
  projectRoot?: string;
  codexRunner?: CodexRunner;
  worktreeManager?: WorktreeManager;
  resultProcessor?: WorkOrderResultProcessor;
  runTimeoutScheduler?: (
    callback: () => void,
    delayMs: number,
  ) => () => void;
  resourceProvider?: ResourceProvider;
  checkpointManager?: CheckpointManager;
  autoRunRetryScheduler?: (
    callback: () => void,
    delayMs: number,
  ) => () => void;
  autoRunRetryMs?: number;
};

class PlanGenerationTimeoutError extends Error {}

const staticFiles: Record<string, { path: string; type: string }> = {
  "/": { path: "public/index.html", type: "text/html; charset=utf-8" },
  "/app.js": { path: "public/app.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { path: "public/styles.css", type: "text/css; charset=utf-8" },
  "/teamline-logo.png": { path: "public/teamline-logo.png", type: "image/png" },
};

export function createApp({
  store,
  planGenerator,
  planGenerationTimeoutMs = 5 * 60 * 1000,
  projectRoot = resolve(import.meta.dir, ".."),
  codexRunner,
  worktreeManager,
  resultProcessor,
  runTimeoutScheduler = scheduleTimeout,
  resourceProvider,
  checkpointManager,
  autoRunRetryScheduler = scheduleTimeout,
  autoRunRetryMs = 60_000,
}: AppDependencies) {
  const startingWorkOrderIds = new Set<string>();
  const startingWorkspacePaths = new Map<string, string>();
  const activeRuns = new Map<string, StartedCodexRun>();
  const runTimeouts = new Map<string, () => void>();
  const stopReasons = new Map<string, string>();
  let autoRunCheckInFlight:
    | Promise<{ startedWorkOrderId: string | null; reason: string | null }>
    | null = null;
  let cancelAutoRunTimer: (() => void) | null = null;
  let handleRequest!: (request: Request) => Promise<Response>;
  let scheduleAutoRunCheck!: (delayMs?: number) => void;

  const clearRunTimeout = (id: string) => {
    runTimeouts.get(id)?.();
    runTimeouts.delete(id);
  };
  const startRunTimeout = (id: string) => {
    clearRunTimeout(id);
    const maxRunMinutes = store.get(id)?.maxRunMinutes ?? 60;
    const cancel = runTimeoutScheduler(() => {
      runTimeouts.delete(id);
      const activeRun = activeRuns.get(id);
      if (store.get(id)?.runStatus !== "running" || !activeRun) return;

      const reason = `已达到本轮最长运行时间（${maxRunMinutes} 分钟），Codex 已停止；可以继续委托`;
      stopReasons.set(id, reason);
      store.markStopping(
        id,
        `已达到本轮最长运行时间（${maxRunMinutes} 分钟），正在停止 Codex`,
      );
      try {
        activeRun.interrupt();
      } catch {
        // The event stream still decides when the run has actually stopped.
      }
    }, maxRunMinutes * 60_000);
    runTimeouts.set(id, cancel);
  };
  const finishReason = (id: string) => {
    const reason = stopReasons.get(id);
    stopReasons.delete(id);
    return reason;
  };
  const executionCapacityReached = () => {
    const activeOrStarting = new Set([
      ...store.activeRunIds(),
      ...startingWorkOrderIds,
    ]);
    return activeOrStarting.size >= store.getExecutionSettings().maxConcurrency;
  };
  const workspaceOwner = (id: string, workspacePath: string) => {
    const targetPath = canonicalWorkspacePath(workspacePath);
    const activeOwner = store
      .list()
      .find(
        (candidate) =>
          candidate.id !== id &&
          ["running", "stopping", "verifying"].includes(
            candidate.runStatus ?? "",
          ) &&
          candidate.worktreePath &&
          canonicalWorkspacePath(candidate.worktreePath) === targetPath,
      );
    if (activeOwner) return activeOwner.id;
    for (const [candidateId, candidatePath] of startingWorkspacePaths) {
      if (
        candidateId !== id &&
        canonicalWorkspacePath(candidatePath) === targetPath
      ) {
        return candidateId;
      }
    }
    return null;
  };

  const readResourceSnapshot = async () => {
    try {
      return resourceProvider
        ? await resourceProvider.read()
        : unavailableResourceSnapshot();
    } catch {
      return unavailableResourceSnapshot(
        "Codex 额度读取失败，请稍后重试",
        new Date().toISOString(),
        "error",
      );
    }
  };
  const runAutoRunOnce = () => {
    if (autoRunCheckInFlight) return autoRunCheckInFlight;
    cancelAutoRunTimer?.();
    cancelAutoRunTimer = null;
    autoRunCheckInFlight = (async () => {
      const snapshot = await readResourceSnapshot();
      const decision = decideAutoRun(
        store.list(),
        snapshot.codex,
        store.getExecutionSettings().maxConcurrency,
      );
      for (const [id, reason] of decision.reasons) {
        store.saveAutoRunReason(id, reason);
      }
      if (!decision.candidateId) {
        if (
          [...decision.reasons.values()].some((reason) => reason?.startsWith("额度"))
        ) {
          scheduleAutoRunCheck(autoRunRetryMs);
        }
        return { startedWorkOrderId: null, reason: null };
      }

      store.saveAutoRunReason(decision.candidateId, null);
      const response = await handleRequest(
        new Request(
          `http://teamline.local/api/work-orders/${encodeURIComponent(decision.candidateId)}/start`,
          { method: "POST" },
        ),
      );
      if (!response.ok) {
        const result = (await response.json()) as { error?: string };
        const reason = result.error || "自动启动失败，等待重试";
        store.saveAutoRunReason(decision.candidateId, reason);
        return { startedWorkOrderId: null, reason };
      }
      return { startedWorkOrderId: decision.candidateId, reason: null };
    })().finally(() => {
      autoRunCheckInFlight = null;
    });
    return autoRunCheckInFlight;
  };
  scheduleAutoRunCheck = (delayMs = 0) => {
    if (
      !store
        .list()
        .some((workOrder) => workOrder.resourcePlan.runWhenQuotaAvailable)
    ) {
      cancelAutoRunTimer?.();
      cancelAutoRunTimer = null;
      return;
    }
    if (cancelAutoRunTimer) {
      if (delayMs > 0) return;
      cancelAutoRunTimer();
      cancelAutoRunTimer = null;
    }
    let active = true;
    const cancel = autoRunRetryScheduler(() => {
      if (!active) return;
      active = false;
      cancelAutoRunTimer = null;
      void runAutoRunOnce();
    }, delayMs);
    cancelAutoRunTimer = () => {
      if (!active) return;
      active = false;
      cancel();
    };
  };

  handleRequest = async (request: Request): Promise<Response> => {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/api/health") {
        return Response.json({ ok: true });
      }

      if (request.method === "GET" && url.pathname === "/api/work-orders") {
        return Response.json({ workOrders: store.list() });
      }

      if (request.method === "GET" && url.pathname === "/api/console") {
        const executionSettings = store.getExecutionSettings();
        return Response.json({
          workOrders: presentConsoleWorkOrders(
            store.list(),
            executionSettings.maxConcurrency,
          ),
          executionSettings,
        });
      }

      if (request.method === "GET" && url.pathname === "/api/execution-settings") {
        return Response.json({ executionSettings: store.getExecutionSettings() });
      }

      if (request.method === "PUT" && url.pathname === "/api/execution-settings") {
        try {
          const body = (await request.json()) as { maxConcurrency?: number };
          return Response.json({
            executionSettings: store.saveMaxConcurrency(body.maxConcurrency ?? NaN),
          });
        } catch (error) {
          return Response.json(
            {
              code: "INVALID_EXECUTION_SETTINGS",
              error: error instanceof Error ? error.message : "无法保存执行设置",
            },
            { status: 400 },
          );
        }
      }

      if (
        request.method === "GET" &&
        url.pathname === "/api/preferences/execution-map-view"
      ) {
        return Response.json({ view: store.getExecutionMapView() });
      }

      if (
        request.method === "PUT" &&
        url.pathname === "/api/preferences/execution-map-view"
      ) {
        const body = (await request.json()) as { view?: string };
        if (body.view !== "map" && body.view !== "list") {
          return Response.json(
            { code: "INVALID_EXECUTION_MAP_VIEW", error: "请选择节点图或纵向列表" },
            { status: 400 },
          );
        }
        return Response.json({ view: store.saveExecutionMapView(body.view) });
      }

      if (request.method === "GET" && url.pathname === "/api/resources") {
        const snapshot = await readResourceSnapshot();
        return Response.json(
          presentResources(
            snapshot,
            store.list(),
            store.getExecutionSettings().maxConcurrency,
          ),
        );
      }

      if (request.method === "POST" && url.pathname === "/api/resources/run-once") {
        return Response.json(await runAutoRunOnce());
      }

      const startMatch = url.pathname.match(/^\/api\/work-orders\/([^/]+)\/start$/);
      if (request.method === "POST" && startMatch) {
        const id = decodeURIComponent(startMatch[1]);
        const workOrder = store.get(id);
        if (!workOrder) {
          return Response.json(
            { code: "WORK_ORDER_NOT_FOUND", error: "找不到这项委托" },
            { status: 404 },
          );
        }
        if (workOrder.runStatus === "running" || startingWorkOrderIds.has(id)) {
          return Response.json(
            { code: "WORK_ORDER_ALREADY_RUNNING", error: "这项委托已经在运行" },
            { status: 409 },
          );
        }
        if (workOrder.status !== "ready" || !workOrder.plan) {
          return Response.json(
            { code: "WORK_ORDER_NOT_READY", error: "请先保存并确认委托计划" },
            { status: 409 },
          );
        }
        if (!workOrder.workspace) {
          return Response.json(
            {
              code: "WORKSPACE_REQUIRED",
              error: "请选择一个本地文件夹作为执行工作空间",
            },
            { status: 409 },
          );
        }
        if (!codexRunner || (workOrder.workspace.kind === "git" && !worktreeManager)) {
          return Response.json(
            { code: "EXECUTION_UNAVAILABLE", error: "Codex 执行服务尚未配置" },
            { status: 503 },
          );
        }
        let workspacePath: string | null = null;
        if (workOrder.workspace.kind === "directory") {
          const resolved = resolveExecutionWorkspace(
            store,
            id,
            workOrder.workspace.kind,
            workOrder.workspace.path,
          );
          if ("error" in resolved) return workspaceErrorResponse(resolved.error);
          workspacePath = resolved.path;
        }
        if (executionCapacityReached()) {
          const { maxConcurrency } = store.getExecutionSettings();
          return Response.json(
            {
              code: "CONCURRENCY_LIMIT_REACHED",
              error: `已达到本机最大并发数（${maxConcurrency}），请等待一项委托结束或调整设置`,
            },
            { status: 409 },
          );
        }

        startingWorkOrderIds.add(id);
        try {
          let delegatedWorktree: DelegatedWorktree | null = null;
          if (workOrder.workspace.kind === "git") {
            try {
              delegatedWorktree = await worktreeManager!.prepare(workOrder);
              workspacePath = delegatedWorktree.path;
            } catch (error) {
              const message = "无法准备独立 Git worktree，请确认仓库和分支状态后重试";
              store.recordStartFailure(id, message, "委托工作区准备失败，请处理后重试");
              return Response.json(
                { code: "WORKTREE_PREPARATION_FAILED", error: message },
                { status: 500 },
              );
            }
          }

          if (workspaceOwner(id, workspacePath!)) {
            return Response.json(
              {
                code: "WORKSPACE_IN_USE",
                error: "这个工作区已由另一项活动委托使用，请选择其他工作区",
              },
              { status: 409 },
            );
          }
          startingWorkspacePaths.set(id, workspacePath!);

          if (workOrder.workspace.kind === "git") {
            store.saveWorktree(id, delegatedWorktree!);
          } else {
            store.saveDirectWorkspace(id, workspacePath!);
          }
          let startedWorkOrder;
          try {
            startedWorkOrder = store.markStarted(id);
          } catch {
            return Response.json(
              {
                code: "EXECUTION_STATE_FAILED",
                error: "无法保存运行状态，Codex 尚未启动，请重试",
              },
              { status: 500 },
            );
          }
          if (workOrder.workspace.kind === "git" && checkpointManager) {
            const checkpointId = crypto.randomUUID();
            try {
              const treeHash = await checkpointManager.capture(
                workspacePath!,
                checkpointReference("checkpoints", id, checkpointId),
              );
              store.saveCheckpoint(id, {
                id: checkpointId,
                kind: "baseline",
                planVersion: startedWorkOrder.plan!.version,
                stageId: null,
                stageOutcome: null,
                runNumber: startedWorkOrder.runNumber,
                treeHash,
              });
              startedWorkOrder = store.get(id)!;
            } catch {
              const message = "无法保存执行起始位置，Codex 尚未启动";
              store.recordStartFailure(id, message, "起始位置保存失败，请处理后重试");
              return Response.json(
                { code: "CHECKPOINT_SAVE_FAILED", error: message },
                { status: 500 },
              );
            }
          }
          let run;
          try {
            run = await codexRunner.start({
              workOrder: startedWorkOrder,
              workspacePath: workspacePath!,
            });
          } catch (error) {
            const message = safeCodexStartError(error);
            store.recordStartFailure(id, message, "Codex 启动失败，请处理后重试");
            return Response.json(
              { code: "CODEX_START_FAILED", error: message },
              { status: 502 },
            );
          }

          store.recordRunPid(id, run.pid ?? null);
          activeRuns.set(id, run);
          startRunTimeout(id);
          void consumeRunEvents(store, id, run, activeRuns, {
            resultProcessor,
            clearRunTimeout: () => clearRunTimeout(id),
            finishReason: () => finishReason(id),
            checkpointManager,
            afterRunSettled: scheduleAutoRunCheck,
          });
          return Response.json({ workOrder: startedWorkOrder });
        } finally {
          startingWorkOrderIds.delete(id);
          startingWorkspacePaths.delete(id);
        }
      }

      const interruptMatch = url.pathname.match(
        /^\/api\/work-orders\/([^/]+)\/interrupt$/,
      );
      if (request.method === "POST" && interruptMatch) {
        const id = decodeURIComponent(interruptMatch[1]);
        const workOrder = store.get(id);
        if (!workOrder) {
          return Response.json(
            { code: "WORK_ORDER_NOT_FOUND", error: "找不到这项委托" },
            { status: 404 },
          );
        }
        if (workOrder.runStatus === "stopping") {
          return Response.json({ workOrder });
        }
        const activeRun = activeRuns.get(id);
        if (workOrder.runStatus === "running" && !activeRun && workOrder.runPid) {
          return Response.json(
            {
              code: "RUN_CONTROL_LOST",
              error:
                "服务重启后无法控制这次仍在运行的 Codex，请在终端停止或待其结束后重启 Teamline",
            },
            { status: 409 },
          );
        }
        if (workOrder.runStatus !== "running" || !activeRun) {
          return Response.json(
            { code: "WORK_ORDER_NOT_RUNNING", error: "这项委托当前没有可中断的运行" },
            { status: 409 },
          );
        }

        const stopping = store.markStopping(id);
        activeRun.interrupt();
        return Response.json({ workOrder: stopping });
      }

      const continueMatch = url.pathname.match(
        /^\/api\/work-orders\/([^/]+)\/continue$/,
      );
      if (request.method === "POST" && continueMatch) {
        const id = decodeURIComponent(continueMatch[1]);
        const workOrder = store.get(id);
        if (!workOrder) {
          return Response.json(
            { code: "WORK_ORDER_NOT_FOUND", error: "找不到这项委托" },
            { status: 404 },
          );
        }
        if (workOrder.status !== "interrupted") {
          return Response.json(
            { code: "WORK_ORDER_NOT_INTERRUPTED", error: "只有已中断的委托可以继续" },
            { status: 409 },
          );
        }
        if (!codexRunner) {
          return Response.json(
            { code: "EXECUTION_UNAVAILABLE", error: "Codex 执行服务尚未配置" },
            { status: 503 },
          );
        }
        if (!workOrder.workspace) {
          return Response.json(
            {
              code: "WORKSPACE_REQUIRED",
              error: "请选择一个本地文件夹作为执行工作空间",
            },
            { status: 409 },
          );
        }
        if (!workOrder.worktreePath) {
          return Response.json(
            {
              code: "WORKTREE_MISSING",
              error: "委托工作区不存在，无法继续；Teamline 不会自动重建或覆盖现场",
            },
            { status: 409 },
          );
        }
        const resolvedWorkspace = resolveExecutionWorkspace(
          store,
          id,
          workOrder.workspace.kind,
          workOrder.worktreePath,
        );
        if ("error" in resolvedWorkspace) {
          if (workOrder.workspace.kind === "git" && resolvedWorkspace.error === "missing") {
            return Response.json(
              {
                code: "WORKTREE_MISSING",
                error: "委托工作区不存在，无法继续；Teamline 不会自动重建或覆盖现场",
              },
              { status: 409 },
            );
          }
          return workspaceErrorResponse(resolvedWorkspace.error);
        }
        const workspacePath =
          workOrder.workspace.kind === "directory"
            ? resolvedWorkspace.path
            : workOrder.worktreePath;
        if (executionCapacityReached()) {
          const { maxConcurrency } = store.getExecutionSettings();
          return Response.json(
            {
              code: "CONCURRENCY_LIMIT_REACHED",
              error: `已达到本机最大并发数（${maxConcurrency}），请等待一项委托结束或调整设置`,
            },
            { status: 409 },
          );
        }
        startingWorkOrderIds.add(id);
        if (workspaceOwner(id, workspacePath)) {
          startingWorkOrderIds.delete(id);
          return Response.json(
            {
              code: "WORKSPACE_IN_USE",
              error: "这个工作区已由另一项活动委托使用，请选择其他工作区",
            },
            { status: 409 },
          );
        }
        startingWorkspacePaths.set(id, workspacePath);
        try {
          const continued = store.markContinued(id);
          let run;
          try {
            run = workOrder.sessionId
              ? await codexRunner.resume({
                  workOrder: continued,
                  workspacePath,
                  sessionId: workOrder.sessionId,
                })
              : await codexRunner.start({
                  workOrder: continued,
                  workspacePath,
                  continuation: await continuationContext(
                    store,
                    id,
                    workspacePath,
                  ),
                });
          } catch (error) {
            const message = safeCodexStartError(error);
            store.recordExit(id, -1, message);
            return Response.json(
              { code: "CODEX_CONTINUE_FAILED", error: message },
              { status: 502 },
            );
          }
          store.recordRunPid(id, run.pid ?? null);
          activeRuns.set(id, run);
          startRunTimeout(id);
          void consumeRunEvents(store, id, run, activeRuns, {
            resultProcessor,
            clearRunTimeout: () => clearRunTimeout(id),
            finishReason: () => finishReason(id),
            checkpointManager,
            afterRunSettled: scheduleAutoRunCheck,
            fallback:
              workOrder.sessionId && codexRunner
                ? async () => {
                    const context = await continuationContext(
                      store,
                      id,
                      workspacePath,
                    );
                    if (store.get(id)?.runStatus === "stopping") {
                      return null;
                    }
                    store.recordProgress(
                      id,
                      "保存的 Codex 会话不可用，已使用当前现场启动新的执行",
                    );
                    return codexRunner.start({
                      workOrder: store.get(id)!,
                      workspacePath,
                      continuation: context,
                    });
                  }
                : undefined,
          });
          return Response.json({ workOrder: continued });
        } finally {
          startingWorkOrderIds.delete(id);
          startingWorkspacePaths.delete(id);
        }
      }

      const reexecuteMatch = url.pathname.match(
        /^\/api\/work-orders\/([^/]+)\/reexecute$/,
      );
      if (request.method === "POST" && reexecuteMatch) {
        const id = decodeURIComponent(reexecuteMatch[1]);
        const workOrder = store.get(id);
        if (!workOrder) {
          return Response.json(
            { code: "WORK_ORDER_NOT_FOUND", error: "找不到这项委托" },
            { status: 404 },
          );
        }
        if (workOrder.status !== "interrupted") {
          return Response.json(
            { code: "WORK_ORDER_NOT_INTERRUPTED", error: "只有已中断的委托可以重新执行" },
            { status: 409 },
          );
        }
        if (
          !codexRunner ||
          !checkpointManager ||
          workOrder.workspace?.kind !== "git"
        ) {
          return Response.json(
            {
              code: "CHECKPOINT_RECOVERY_UNAVAILABLE",
              error: "当前工作空间不支持从阶段检查点重新执行，可以继续当前现场",
            },
            { status: 409 },
          );
        }
        if (!workOrder.worktreePath || !workOrder.plan) {
          return Response.json(
            { code: "WORKTREE_MISSING", error: "委托工作区不存在，无法重新执行" },
            { status: 409 },
          );
        }
        const resolvedWorkspace = resolveExecutionWorkspace(
          store,
          id,
          "git",
          workOrder.worktreePath,
        );
        if ("error" in resolvedWorkspace) {
          return Response.json(
            { code: "WORKTREE_MISSING", error: "委托工作区不存在，无法重新执行" },
            { status: 409 },
          );
        }
        const checkpoint = store.latestRecoveryCheckpoint(id);
        if (!checkpoint) {
          return Response.json(
            { code: "CHECKPOINT_MISSING", error: "没有可用的完整恢复位置" },
            { status: 409 },
          );
        }
        if (executionCapacityReached()) {
          const { maxConcurrency } = store.getExecutionSettings();
          return Response.json(
            {
              code: "CONCURRENCY_LIMIT_REACHED",
              error: `已达到本机最大并发数（${maxConcurrency}），请等待一项委托结束或调整设置`,
            },
            { status: 409 },
          );
        }
        if (workspaceOwner(id, resolvedWorkspace.path)) {
          return Response.json(
            {
              code: "WORKSPACE_IN_USE",
              error: "这个工作区已由另一项活动委托使用，请选择其他工作区",
            },
            { status: 409 },
          );
        }

        startingWorkOrderIds.add(id);
        startingWorkspacePaths.set(id, resolvedWorkspace.path);
        try {
          const residueId = crypto.randomUUID();
          try {
            await checkpointManager.restore(
              resolvedWorkspace.path,
              checkpoint.treeHash,
              checkpointReference("residue", id, residueId),
            );
          } catch {
            return Response.json(
              {
                code: "CHECKPOINT_RESTORE_FAILED",
                error: "无法恢复最近完整位置，新的运行尚未启动；请检查工作区后重试",
              },
              { status: 500 },
            );
          }

          const currentStage = recoveryStage(workOrder, checkpoint);
          const reexecuted = store.markReexecuted(id);
          store.recordProgress(
            id,
            checkpoint.kind === "stage"
              ? `已恢复到“${checkpoint.stageOutcome}”检查点，开始重新执行${currentStage ? `“${currentStage.outcome}”` : "当前节点"}`
              : `已恢复到执行起始位置，开始重新执行${currentStage ? `“${currentStage.outcome}”` : "当前节点"}`,
          );
          let run;
          try {
            run = await codexRunner.start({
              workOrder: reexecuted,
              workspacePath: resolvedWorkspace.path,
              continuation: {
                ...(await continuationContext(store, id, resolvedWorkspace.path)),
                reexecuteStage: currentStage
                  ? { id: currentStage.id, outcome: currentStage.outcome }
                  : undefined,
              },
            });
          } catch (error) {
            const message = safeCodexStartError(error);
            store.recordExit(id, -1, message);
            return Response.json(
              { code: "CODEX_REEXECUTE_FAILED", error: message },
              { status: 502 },
            );
          }
          store.recordRunPid(id, run.pid ?? null);
          activeRuns.set(id, run);
          startRunTimeout(id);
          void consumeRunEvents(store, id, run, activeRuns, {
            resultProcessor,
            checkpointManager,
            clearRunTimeout: () => clearRunTimeout(id),
            finishReason: () => finishReason(id),
            afterRunSettled: scheduleAutoRunCheck,
          });
          return Response.json({ workOrder: store.get(id)! });
        } finally {
          startingWorkOrderIds.delete(id);
          startingWorkspacePaths.delete(id);
        }
      }

      const eventsMatch = url.pathname.match(/^\/api\/work-orders\/([^/]+)\/events$/);
      if (request.method === "GET" && eventsMatch) {
        const id = decodeURIComponent(eventsMatch[1]);
        if (!store.get(id)) {
          return Response.json(
            { code: "WORK_ORDER_NOT_FOUND", error: "找不到这项委托" },
            { status: 404 },
          );
        }
        return Response.json({ events: store.listRunEvents(id) });
      }

      const deliverMatch = url.pathname.match(
        /^\/api\/work-orders\/([^/]+)\/deliver$/,
      );
      if (request.method === "POST" && deliverMatch) {
        const id = decodeURIComponent(deliverMatch[1]);
        if (!store.get(id)) {
          return Response.json(
            { code: "WORK_ORDER_NOT_FOUND", error: "找不到这项委托" },
            { status: 404 },
          );
        }
        try {
          return Response.json({ workOrder: store.confirmDelivered(id) });
        } catch {
          return Response.json(
            { code: "WORK_ORDER_NOT_IN_REVIEW", error: "只有待验收的委托可以确认交付" },
            { status: 409 },
          );
        }
      }

      const reviseMatch = url.pathname.match(/^\/api\/work-orders\/([^/]+)\/revise$/);
      if (request.method === "POST" && reviseMatch) {
        const id = decodeURIComponent(reviseMatch[1]);
        if (!store.get(id)) {
          return Response.json(
            { code: "WORK_ORDER_NOT_FOUND", error: "找不到这项委托" },
            { status: 404 },
          );
        }
        try {
          const body = (await request.json()) as { revisionNote?: string };
          return Response.json({ workOrder: store.revise(id, body.revisionNote ?? "") });
        } catch (error) {
          const message = error instanceof Error ? error.message : "无法补充要求";
          const invalidState = message.includes("只有待验收");
          return Response.json(
            {
              code: invalidState ? "WORK_ORDER_NOT_IN_REVIEW" : "INVALID_REVISION_NOTE",
              error: message,
            },
            { status: invalidState ? 409 : 400 },
          );
        }
      }

      const generatePlanMatch = url.pathname.match(
        /^\/api\/work-orders\/([^/]+)\/plan\/generate$/,
      );
      if (request.method === "POST" && generatePlanMatch) {
        const id = decodeURIComponent(generatePlanMatch[1]);
        const workOrder = store.get(id);
        if (!workOrder) {
          return Response.json(
            { code: "WORK_ORDER_NOT_FOUND", error: "找不到这项委托" },
            { status: 404 },
          );
        }
        if (!planIsEditable(workOrder)) {
          return Response.json(
            { code: "WORK_ORDER_PLAN_LOCKED", error: "委托开始执行后不能直接修改计划" },
            { status: 409 },
          );
        }
        if (!planGenerator) {
          return Response.json(
            { code: "PLAN_GENERATOR_UNAVAILABLE", error: "Codex 规划服务尚未配置" },
            { status: 503 },
          );
        }

        try {
          const controller = new AbortController();
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const generated = await Promise.race([
            planGenerator.generate(workOrder, controller.signal),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(() => {
                controller.abort();
                reject(new PlanGenerationTimeoutError());
              }, planGenerationTimeoutMs);
            }),
          ]).finally(() => clearTimeout(timeout));
          return Response.json({ workOrder: store.savePlan(id, generated.stages) });
        } catch (error) {
          if (error instanceof PlanGenerationTimeoutError) {
            return Response.json(
              { code: "PLAN_GENERATION_TIMEOUT", error: "生成计划超时，请重试" },
              { status: 504 },
            );
          }
          if (error instanceof PlanLockedError) {
            return Response.json(
              { code: "WORK_ORDER_PLAN_LOCKED", error: error.message },
              { status: 409 },
            );
          }
          return Response.json(
            {
              code: "PLAN_GENERATION_FAILED",
              error: "Codex 无法生成计划，请确认已经安装并登录后重试",
            },
            { status: 502 },
          );
        }
      }

      const planMatch = url.pathname.match(/^\/api\/work-orders\/([^/]+)\/plan$/);
      if (request.method === "PUT" && planMatch) {
        const id = decodeURIComponent(planMatch[1]);
        const workOrder = store.get(id);
        if (!workOrder) {
          return Response.json(
            { code: "WORK_ORDER_NOT_FOUND", error: "找不到这项委托" },
            { status: 404 },
          );
        }
        if (!planIsEditable(workOrder)) {
          return Response.json(
            { code: "WORK_ORDER_PLAN_LOCKED", error: "委托开始执行后不能直接修改计划" },
            { status: 409 },
          );
        }

        try {
          const body = (await request.json()) as { stages?: PlanStageInput[] };
          if (!Array.isArray(body.stages)) {
            throw new Error("请填写委托计划");
          }
          return Response.json({ workOrder: store.savePlan(id, body.stages) });
        } catch (error) {
          if (error instanceof PlanLockedError) {
            return Response.json(
              { code: "WORK_ORDER_PLAN_LOCKED", error: error.message },
              { status: 409 },
            );
          }
          return Response.json(
            {
              code: "INVALID_PLAN",
              error: "计划内容不完整，请检查每个阶段",
            },
            { status: 400 },
          );
        }
      }

      const settingsMatch = url.pathname.match(
        /^\/api\/work-orders\/([^/]+)\/execution-settings$/,
      );
      if (request.method === "PUT" && settingsMatch) {
        const id = decodeURIComponent(settingsMatch[1]);
        if (!store.get(id)) {
          return Response.json(
            { code: "WORK_ORDER_NOT_FOUND", error: "找不到这项委托" },
            { status: 404 },
          );
        }
        try {
          const body = (await request.json()) as { maxRunMinutes?: number };
          return Response.json({
            workOrder: store.saveMaxRunMinutes(id, body.maxRunMinutes ?? NaN),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "无法保存执行条件";
          return Response.json(
            { code: "INVALID_EXECUTION_SETTINGS", error: message },
            { status: error instanceof PlanLockedError ? 409 : 400 },
          );
        }
      }

      const resourcePlanMatch = url.pathname.match(
        /^\/api\/work-orders\/([^/]+)\/resource-plan$/,
      );
      if (request.method === "PUT" && resourcePlanMatch) {
        const id = decodeURIComponent(resourcePlanMatch[1]);
        if (!store.get(id)) {
          return Response.json(
            { code: "WORK_ORDER_NOT_FOUND", error: "找不到这项委托" },
            { status: 404 },
          );
        }
        try {
          const body = (await request.json()) as {
            priority?: WorkOrder["resourcePlan"]["priority"];
            pace?: WorkOrder["resourcePlan"]["pace"];
            runWhenQuotaAvailable?: boolean;
          };
          if (
            body.priority === undefined ||
            body.pace === undefined ||
            body.runWhenQuotaAvailable === undefined
          ) {
            throw new Error("请完整填写委托资源安排");
          }
          const workOrder = store.saveResourcePlan(id, {
            priority: body.priority,
            pace: body.pace,
            runWhenQuotaAvailable: body.runWhenQuotaAvailable,
          });
          scheduleAutoRunCheck();
          return Response.json({ workOrder });
        } catch (error) {
          return Response.json(
            {
              code: "INVALID_RESOURCE_PLAN",
              error: error instanceof Error ? error.message : "无法保存资源安排",
            },
            { status: 400 },
          );
        }
      }

      const workspaceMatch = url.pathname.match(
        /^\/api\/work-orders\/([^/]+)\/workspace$/,
      );
      if (request.method === "PUT" && workspaceMatch) {
        const id = decodeURIComponent(workspaceMatch[1]);
        if (!store.get(id)) {
          return Response.json(
            { code: "WORK_ORDER_NOT_FOUND", error: "找不到这项委托" },
            { status: 404 },
          );
        }
        try {
          const body = (await request.json()) as { path?: string };
          const path = body.path?.trim() ?? "";
          const resolved = validateWorkspacePath(path);
          if ("error" in resolved) return workspaceErrorResponse(resolved.error);
          const canonicalPath = resolved.path;
          const kind = isGitRepository(canonicalPath) ? "git" : "directory";
          if (kind === "directory" && directoryWorkspaceInUse(store, id, canonicalPath)) {
            return workspaceErrorResponse("in_use");
          }
          return Response.json({
            workOrder: store.saveWorkspace(id, {
              kind,
              path: canonicalPath,
            }),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "无法保存工作空间";
          return Response.json(
            {
              code:
                error instanceof PlanLockedError
                  ? "WORKSPACE_LOCKED"
                  : "INVALID_WORKSPACE",
              error: message,
            },
            { status: error instanceof PlanLockedError ? 409 : 400 },
          );
        }
      }

      const workOrderMatch = url.pathname.match(/^\/api\/work-orders\/([^/]+)$/);
      if (request.method === "GET" && workOrderMatch) {
        const workOrder = store.get(decodeURIComponent(workOrderMatch[1]));
        if (!workOrder) {
          return Response.json(
            { code: "WORK_ORDER_NOT_FOUND", error: "找不到这项委托" },
            { status: 404 },
          );
        }
        return Response.json({
          workOrder: await withRecoverySite(workOrder, checkpointManager),
        });
      }

      if (request.method === "POST" && url.pathname === "/api/work-orders") {
        try {
          const body = (await request.json()) as {
            repositoryPath?: string;
            goal?: string;
            acceptance?: string;
            materials?: Array<{ kind?: string; value?: string }>;
          };
          const requestedRepositoryPath = body.repositoryPath?.trim() ?? "";
          if (requestedRepositoryPath && !isGitRepository(requestedRepositoryPath)) {
            return Response.json(
              { error: "请选择一个有效的本地 Git 仓库" },
              { status: 400 },
            );
          }

          const materials = normalizeMaterials(body.materials);
          const workOrder = store.create({
            repositoryPath: requestedRepositoryPath,
            goal: body.goal ?? "",
            acceptance: body.acceptance,
            materials,
          });
          return Response.json({ workOrder }, { status: 201 });
        } catch (error) {
          const message = error instanceof Error ? error.message : "创建委托失败";
          return Response.json({ error: message }, { status: 400 });
        }
      }

      const staticFile = staticFiles[url.pathname];
      if (request.method === "GET" && staticFile) {
        return new Response(Bun.file(join(projectRoot, staticFile.path)), {
          headers: { "content-type": staticFile.type },
        });
      }

      if (
        request.method === "GET" &&
        (url.pathname === "/resources" || /^\/work-orders\/[^/]+$/.test(url.pathname))
      ) {
        return new Response(Bun.file(join(projectRoot, "public/index.html")), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      return new Response("Not found", { status: 404 });
  };
  scheduleAutoRunCheck();
  return { fetch: handleRequest };
}

async function consumeRunEvents(
  store: WorkOrderStore,
  workOrderId: string,
  run: StartedCodexRun,
  activeRuns: Map<string, StartedCodexRun>,
  options: {
    fallback?: () => Promise<StartedCodexRun | null>;
    resultProcessor?: WorkOrderResultProcessor;
    clearRunTimeout?: () => void;
    finishReason?: () => string | undefined;
    checkpointManager?: CheckpointManager;
    afterRunSettled?: () => void;
  } = {},
): Promise<void> {
  let settled = false;
  try {
    for await (const event of run.events) {
      if (event.type === "session") {
        store.recordSession(workOrderId, event.sessionId);
      } else if (event.type === "progress") {
        store.recordProgress(workOrderId, event.message);
      } else {
        if (store.get(workOrderId)?.runStatus === "stopping") {
          options.clearRunTimeout?.();
          store.recordInterrupted(workOrderId, options.finishReason?.());
          settled = true;
        } else if (event.resumeUnavailable && options.fallback) {
          let fallbackRun: StartedCodexRun | null;
          try {
            fallbackRun = await options.fallback();
          } catch {
            if (store.get(workOrderId)?.runStatus === "stopping") {
              options.clearRunTimeout?.();
              store.recordInterrupted(workOrderId, options.finishReason?.());
            } else {
              options.clearRunTimeout?.();
              store.recordExit(
                workOrderId,
                -1,
                "Codex 无法从当前现场启动，请检查本机 Codex 后重试",
              );
            }
            settled = true;
            return;
          }
          if (!fallbackRun) {
            if (store.get(workOrderId)?.runStatus === "stopping") {
              options.clearRunTimeout?.();
              store.recordInterrupted(workOrderId, options.finishReason?.());
              settled = true;
            }
            return;
          }
          activeRuns.set(workOrderId, fallbackRun);
          store.recordRunPid(workOrderId, fallbackRun.pid ?? null);
          if (store.get(workOrderId)?.runStatus === "stopping") {
            try {
              fallbackRun.interrupt();
            } catch {
              // Keep waiting for the fallback process exit; stopping is not interrupted yet.
            }
          }
          void consumeRunEvents(store, workOrderId, fallbackRun, activeRuns, {
            resultProcessor: options.resultProcessor,
            checkpointManager: options.checkpointManager,
            clearRunTimeout: options.clearRunTimeout,
            finishReason: options.finishReason,
            afterRunSettled: options.afterRunSettled,
          });
          return;
        } else if (event.exitCode === 0 && options.resultProcessor) {
          options.clearRunTimeout?.();
          const verifying = store.beginResultProcessing(workOrderId, event.message);
          try {
            const result = await options.resultProcessor.process(verifying);
            await saveVerifiedBoundaryCheckpoint(
              store,
              workOrderId,
              result,
              options.checkpointManager,
            );
            if (result.verifications.some((verification) => verification.status === "failed")) {
              store.recordVerificationFailure(workOrderId, result);
            } else {
              store.completeReview(workOrderId, result);
            }
          } catch {
            store.recordResultProcessingFailure(workOrderId);
          }
          settled = true;
        } else {
          options.clearRunTimeout?.();
          store.recordExit(workOrderId, event.exitCode, event.message);
          settled = true;
        }
      }
    }
  } catch {
    if (run.exited) {
      await run.exited;
    }
    if (store.get(workOrderId)?.runStatus === "stopping") {
      options.clearRunTimeout?.();
      store.recordInterrupted(workOrderId, options.finishReason?.());
    } else {
      options.clearRunTimeout?.();
      store.recordExit(
        workOrderId,
        -1,
        "Codex 运行异常结束，请检查本机 Codex 后重试",
      );
    }
    settled = true;
  } finally {
    if (activeRuns.get(workOrderId) === run) {
      activeRuns.delete(workOrderId);
    }
    if (settled) options.afterRunSettled?.();
  }
}

async function saveVerifiedBoundaryCheckpoint(
  store: WorkOrderStore,
  workOrderId: string,
  result: Awaited<ReturnType<WorkOrderResultProcessor["process"]>>,
  checkpointManager?: CheckpointManager,
): Promise<void> {
  const workOrder = store.get(workOrderId);
  if (
    !checkpointManager ||
    !workOrder?.plan ||
    workOrder.workspace?.kind !== "git" ||
    !workOrder.worktreePath
  ) {
    return;
  }
  const verificationsByStage = new Map(
    result.verifications.map((verification) => [verification.stageId, verification]),
  );
  const completeBoundary = workOrder.plan.stages.every(
    (stage) => verificationsByStage.get(stage.id)?.status === "passed",
  );
  if (!completeBoundary) return;

  const finalStage = workOrder.plan.stages.at(-1);
  if (!finalStage) return;
  const checkpointId = crypto.randomUUID();
  const treeHash = await checkpointManager.capture(
    workOrder.worktreePath,
    checkpointReference("checkpoints", workOrderId, checkpointId),
  );
  store.saveCheckpoint(workOrderId, {
    id: checkpointId,
    kind: "stage",
    planVersion: result.planVersion,
    stageId: finalStage.id,
    stageOutcome: finalStage.outcome,
    runNumber: workOrder.runNumber,
    treeHash,
  });
}

async function continuationContext(
  store: WorkOrderStore,
  workOrderId: string,
  workspacePath: string,
): Promise<ContinuationContext> {
  const recentProgress = store
    .listRunEvents(workOrderId, 20)
    .filter((event) => event.type === "progress")
    .slice(-5)
    .map((event) => event.message);
  if (store.get(workOrderId)?.workspace?.kind === "directory") {
    return {
      recentProgress,
      gitStatus: "普通文件夹现场保留在当前执行目录",
    };
  }
  const subprocess = Bun.spawn(["git", "-C", workspacePath, "status", "--short"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
  ]);
  return {
    recentProgress,
    gitStatus: exitCode === 0 ? stdout.trimEnd() : "无法读取当前 Git 状态",
  };
}

function isGitRepository(repositoryPath: string): boolean {
  if (!repositoryPath || !existsSync(repositoryPath)) {
    return false;
  }

  return existsSync(join(repositoryPath, ".git"));
}

type WorkspaceValidationError =
  | "missing"
  | "not_directory"
  | "permission_denied"
  | "in_use";

type WorkspaceValidation =
  | { path: string }
  | { error: WorkspaceValidationError };

function validateWorkspacePath(path: string): WorkspaceValidation {
  if (!path) return { error: "missing" };
  try {
    if (!statSync(path).isDirectory()) return { error: "not_directory" };
    accessSync(path, constants.R_OK | constants.W_OK | constants.X_OK);
    return { path: realpathSync(path) };
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      if (error.code === "ENOENT") return { error: "missing" };
      if (error.code === "EACCES" || error.code === "EPERM") {
        return { error: "permission_denied" };
      }
      if (error.code === "ENOTDIR") return { error: "not_directory" };
    }
    return { error: "not_directory" };
  }
}

function workspaceErrorResponse(error: WorkspaceValidationError): Response {
  const details = {
    missing: {
      code: "WORKSPACE_NOT_FOUND",
      error: "这个文件夹不存在，请重新选择一个本地文件夹",
    },
    not_directory: {
      code: "WORKSPACE_NOT_DIRECTORY",
      error: "所选路径不是文件夹，请重新选择",
    },
    permission_denied: {
      code: "WORKSPACE_PERMISSION_DENIED",
      error: "Teamline 无法读写或进入这个文件夹，请调整权限或选择其他文件夹",
    },
    in_use: {
      code: "WORKSPACE_IN_USE",
      error: "这个文件夹正在被另一项委托使用，请等待其结束或选择其他文件夹",
    },
  }[error];
  return Response.json(details, { status: error === "in_use" ? 409 : 400 });
}

function directoryWorkspaceInUse(
  store: WorkOrderStore,
  workOrderId: string,
  path: string,
): boolean {
  return store.list().some(
    (workOrder) =>
      workOrder.id !== workOrderId &&
      workOrder.workspace?.kind === "directory" &&
      canonicalWorkspacePath(workOrder.worktreePath ?? workOrder.workspace.path) === path &&
      ["running", "stopping", "verifying"].includes(workOrder.runStatus ?? ""),
  );
}

function resolveExecutionWorkspace(
  store: WorkOrderStore,
  workOrderId: string,
  kind: "git" | "directory",
  path: string,
): WorkspaceValidation {
  const resolved = validateWorkspacePath(path);
  if ("error" in resolved) return resolved;
  if (kind === "directory" && directoryWorkspaceInUse(store, workOrderId, resolved.path)) {
    return { error: "in_use" };
  }
  return resolved;
}

function normalizeMaterials(
  materials: Array<{ kind?: string; value?: string }> | undefined,
): Array<{ kind: WorkOrderMaterialKind; value: string }> {
  if (!materials) return [];
  if (!Array.isArray(materials)) throw new Error("素材格式无法识别");
  return materials.map((material) => {
    const kind = material?.kind;
    const value = material?.value?.trim() ?? "";
    if (!workOrderMaterialKinds.includes(kind as WorkOrderMaterialKind) || !value) {
      throw new Error("请检查添加的素材");
    }
    return { kind: kind as WorkOrderMaterialKind, value };
  });
}

function planIsEditable(workOrder: { status: string; runStatus: string | null }): boolean {
  return workOrder.runStatus === null && ["draft", "ready"].includes(workOrder.status);
}

function safeCodexStartError(error: unknown): string {
  if (error instanceof Error && error.message.includes("找不到 Codex")) {
    return "找不到 Codex，请先安装并登录 Codex";
  }
  return "Codex 无法启动，请确认本机 Codex 安装和配置后重试";
}

function scheduleTimeout(callback: () => void, delayMs: number): () => void {
  const timeout = setTimeout(callback, delayMs);
  timeout.unref?.();
  return () => clearTimeout(timeout);
}

function canonicalWorkspacePath(workspacePath: string): string {
  const absolutePath = resolve(workspacePath);
  return existsSync(absolutePath) ? realpathSync(absolutePath) : absolutePath;
}

function checkpointReference(
  kind: "checkpoints" | "residue",
  workOrderId: string,
  recordId: string,
): string {
  return `refs/teamline/${kind}/${workOrderId}/${recordId}`;
}

function recoveryStage(
  workOrder: WorkOrder,
  checkpoint: WorkOrderCheckpoint,
): PlanStage | null {
  if (!workOrder.plan) return null;
  const finalStage = workOrder.plan.stages.at(-1) ?? null;
  if (checkpoint.kind === "stage" && checkpoint.stageId === finalStage?.id) {
    return finalStage;
  }
  const completedStageIds = new Set(
    workOrder.checkpoints
      .filter(
        (candidate) =>
          candidate.kind === "stage" &&
          candidate.planVersion === workOrder.plan!.version &&
          candidate.sequence <= checkpoint.sequence &&
          candidate.stageId,
      )
      .map((candidate) => candidate.stageId!),
  );
  return (
    workOrder.plan.stages.find((stage) => !completedStageIds.has(stage.id)) ??
    finalStage ??
    null
  );
}

async function withRecoverySite(
  workOrder: WorkOrder,
  checkpointManager?: CheckpointManager,
): Promise<WorkOrder> {
  if (
    workOrder.status !== "interrupted" ||
    workOrder.workspace?.kind !== "git" ||
    !workOrder.worktreePath ||
    !checkpointManager
  ) {
    return workOrder;
  }
  const checkpoint = workOrder.checkpoints
    .filter((candidate) => candidate.planVersion === workOrder.plan?.version)
    .at(-1);
  if (!checkpoint) return workOrder;
  try {
    return {
      ...workOrder,
      recoverySite: await checkpointManager.describe(
        workOrder.worktreePath,
        checkpoint.treeHash,
      ),
    };
  } catch {
    return workOrder;
  }
}
