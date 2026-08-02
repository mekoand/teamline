import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PlanGenerator } from "./plan-generator";
import type {
  ContinuationContext,
  CodexRunEvent,
  CodexRunner,
  StartedCodexRun,
} from "./codex-runner";
import type { PlanStageInput } from "./work-order";
import type { WorkOrderStore } from "./work-order-store";
import type { WorktreeManager } from "./worktree-manager";

type AppDependencies = {
  store: WorkOrderStore;
  planGenerator?: PlanGenerator;
  planGenerationTimeoutMs?: number;
  projectRoot?: string;
  codexRunner?: CodexRunner;
  worktreeManager?: WorktreeManager;
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
}: AppDependencies) {
  let startingWorkOrderId: string | null = null;
  const activeRuns = new Map<string, StartedCodexRun>();

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/api/health") {
        return Response.json({ ok: true });
      }

      if (request.method === "GET" && url.pathname === "/api/work-orders") {
        return Response.json({ workOrders: store.list() });
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
        if (!codexRunner || !worktreeManager) {
          return Response.json(
            { code: "EXECUTION_UNAVAILABLE", error: "Codex 执行服务尚未配置" },
            { status: 503 },
          );
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
          let delegatedWorktree;
          try {
            delegatedWorktree = await worktreeManager.prepare(workOrder);
          } catch (error) {
            const message = "无法准备独立 Git worktree，请确认仓库和分支状态后重试";
            store.recordStartFailure(id, message, "委托工作区准备失败，请处理后重试");
            return Response.json(
              { code: "WORKTREE_PREPARATION_FAILED", error: message },
              { status: 500 },
            );
          }

          store.saveWorktree(id, delegatedWorktree);
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
              workspacePath: delegatedWorktree.path,
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
          void consumeRunEvents(store, id, run, activeRuns);
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
        if (!workOrder.worktreePath || !existsSync(workOrder.worktreePath)) {
          return Response.json(
            {
              code: "WORKTREE_MISSING",
              error: "委托工作区不存在，无法继续；Teamline 不会自动重建或覆盖现场",
            },
            { status: 409 },
          );
        }
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
                  workspacePath: workOrder.worktreePath,
                  sessionId: workOrder.sessionId,
                })
              : await codexRunner.start({
                  workOrder: continued,
                  workspacePath: workOrder.worktreePath,
                  continuation: await continuationContext(
                    store,
                    id,
                    workOrder.worktreePath,
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
          void consumeRunEvents(store, id, run, activeRuns, {
            fallback:
              workOrder.sessionId && codexRunner
                ? async () => {
                    const context = await continuationContext(
                      store,
                      id,
                      workOrder.worktreePath!,
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
                      workspacePath: workOrder.worktreePath!,
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
        if (!store.get(id)) {
          return Response.json(
            { code: "WORK_ORDER_NOT_FOUND", error: "找不到这项委托" },
            { status: 404 },
          );
        }

        try {
          const body = (await request.json()) as { stages?: PlanStageInput[] };
          if (!Array.isArray(body.stages)) {
            throw new Error("请填写委托计划");
          }
          return Response.json({ workOrder: store.savePlan(id, body.stages) });
        } catch (error) {
          return Response.json(
            {
              code: "INVALID_PLAN",
              error: "计划内容不完整，请检查每个阶段",
            },
            { status: 400 },
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
          };
          const repositoryPath = body.repositoryPath?.trim() ?? "";

          if (!isGitRepository(repositoryPath)) {
            return Response.json(
              { error: "请选择一个有效的本地 Git 仓库" },
              { status: 400 },
            );
          }

          const workOrder = store.create({
            repositoryPath,
            goal: body.goal ?? "",
            acceptance: body.acceptance,
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
  options: { fallback?: () => Promise<StartedCodexRun | null> } = {},
): Promise<void> {
  try {
    for await (const event of run.events) {
      if (event.type === "session") {
        store.recordSession(workOrderId, event.sessionId);
      } else if (event.type === "progress") {
        store.recordProgress(workOrderId, event.message);
      } else {
        if (store.get(workOrderId)?.runStatus === "stopping") {
          store.recordInterrupted(workOrderId);
        } else if (event.resumeUnavailable && options.fallback) {
          let fallbackRun: StartedCodexRun | null;
          try {
            fallbackRun = await options.fallback();
          } catch {
            if (store.get(workOrderId)?.runStatus === "stopping") {
              store.recordInterrupted(workOrderId);
            } else {
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
              store.recordInterrupted(workOrderId);
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
          void consumeRunEvents(store, workOrderId, fallbackRun, activeRuns);
          return;
        } else {
          store.recordExit(workOrderId, event.exitCode, event.message);
        }
      }
    }
  } catch {
    if (run.exited) {
      await run.exited;
    }
    if (store.get(workOrderId)?.runStatus === "stopping") {
      store.recordInterrupted(workOrderId);
    } else {
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

function safeCodexStartError(error: unknown): string {
  if (error instanceof Error && error.message.includes("找不到 Codex")) {
    return "找不到 Codex，请先安装并登录 Codex";
  }
  return "Codex 无法启动，请确认本机 Codex 安装和配置后重试";
}
