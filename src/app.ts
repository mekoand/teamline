import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PlanGenerator } from "./plan-generator";
import type { PlanStageInput } from "./work-order";
import type { WorkOrderStore } from "./work-order-store";

type AppDependencies = {
  store: WorkOrderStore;
  planGenerator?: PlanGenerator;
  planGenerationTimeoutMs?: number;
  projectRoot?: string;
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
}: AppDependencies) {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/api/health") {
        return Response.json({ ok: true });
      }

      if (request.method === "GET" && url.pathname === "/api/work-orders") {
        return Response.json({ workOrders: store.list() });
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

function isGitRepository(repositoryPath: string): boolean {
  if (!repositoryPath || !existsSync(repositoryPath)) {
    return false;
  }

  return existsSync(join(repositoryPath, ".git"));
}
