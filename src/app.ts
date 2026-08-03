import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PlanGenerator } from "./plan-generator";
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
  type WorkOrderMaterialKind,
} from "./work-order";
import { PlanLockedError, type WorkOrderStore } from "./work-order-store";
import type { WorktreeManager } from "./worktree-manager";

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
};

class PlanGenerationTimeoutError extends Error {}

const staticFiles: Record<string, { path: string; type: string }> = {
  "/": { path: "public/index.html", type: "text/html; charset=utf-8" },
  "/app.js": { path: "public/app.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { path: "public/styles.css", type: "text/css; charset=utf-8" },
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
}: AppDependencies) {
  let startingWorkOrderId: string | null = null;
  const activeRuns = new Map<string, StartedCodexRun>();
  const runTimeouts = new Map<string, () => void>();
  const stopReasons = new Map<string, string>();

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

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/api/health") {
        return Response.json({ ok: true });
      }

      if (request.method === "GET" && url.pathname === "/api/work-orders") {
        return Response.json({ workOrders: store.list() });
      }

      if (request.method === "GET" && url.pathname === "/api/console") {
        return Response.json({ workOrders: presentConsoleWorkOrders(store.list()) });
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
        if (workOrder.runStatus === "running" || startingWorkOrderId === id) {
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
        if (store.hasActiveRun() || startingWorkOrderId) {
          return Response.json(
            {
              code: "ACTIVE_WORK_ORDER_EXISTS",
              error: "已有另一项委托正在运行，请等待它结束后再启动",
            },
            { status: 409 },
          );
        }

        startingWorkOrderId = id;
        try {
          if (workOrder.workspace.kind === "git") {
            try {
              const delegatedWorktree = await worktreeManager!.prepare(workOrder);
              store.saveWorktree(id, delegatedWorktree);
              workspacePath = delegatedWorktree.path;
            } catch (error) {
              const message = "无法准备独立 Git worktree，请确认仓库和分支状态后重试";
              store.recordStartFailure(id, message, "委托工作区准备失败，请处理后重试");
              return Response.json(
                { code: "WORKTREE_PREPARATION_FAILED", error: message },
                { status: 500 },
              );
            }
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
          });
          return Response.json({ workOrder: startedWorkOrder });
        } finally {
          startingWorkOrderId = null;
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
        if (store.hasActiveRun() || startingWorkOrderId) {
          return Response.json(
            {
              code: "ACTIVE_WORK_ORDER_EXISTS",
              error: "已有另一项委托正在运行，请等待它结束后再继续",
            },
            { status: 409 },
          );
        }
        startingWorkOrderId = id;
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
          startingWorkOrderId = null;
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
        return Response.json({ workOrder });
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

      if (request.method === "GET" && /^\/work-orders\/[^/]+$/.test(url.pathname)) {
        return new Response(Bun.file(join(projectRoot, "public/index.html")), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      return new Response("Not found", { status: 404 });
    },
  };
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
  } = {},
): Promise<void> {
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
            return;
          }
          if (!fallbackRun) {
            if (store.get(workOrderId)?.runStatus === "stopping") {
              options.clearRunTimeout?.();
              store.recordInterrupted(workOrderId, options.finishReason?.());
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
            clearRunTimeout: options.clearRunTimeout,
            finishReason: options.finishReason,
          });
          return;
        } else if (event.exitCode === 0 && options.resultProcessor) {
          options.clearRunTimeout?.();
          const verifying = store.beginResultProcessing(workOrderId, event.message);
          try {
            const result = await options.resultProcessor.process(verifying);
            if (result.verifications.some((verification) => verification.status === "failed")) {
              store.recordVerificationFailure(workOrderId, result);
            } else {
              store.completeReview(workOrderId, result);
            }
          } catch {
            store.recordResultProcessingFailure(workOrderId);
          }
        } else {
          options.clearRunTimeout?.();
          store.recordExit(workOrderId, event.exitCode, event.message);
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
  } finally {
    if (activeRuns.get(workOrderId) === run) {
      activeRuns.delete(workOrderId);
    }
  }
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

function canonicalWorkspacePath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
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
