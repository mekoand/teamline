import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { WorkOrderStore } from "./work-order-store";

const projectRoot = resolve(import.meta.dir, "..");
const dataDirectory = resolve(process.env.TEAMLINE_DATA_DIR ?? join(projectRoot, ".teamline"));
mkdirSync(dataDirectory, { recursive: true });

const store = new WorkOrderStore(new Database(join(dataDirectory, "teamline.db"), { create: true }));
const port = Number(process.env.TEAMLINE_PORT ?? 4310);

const staticFiles: Record<string, { path: string; type: string }> = {
  "/": { path: "public/index.html", type: "text/html; charset=utf-8" },
  "/app.js": { path: "public/app.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { path: "public/styles.css", type: "text/css; charset=utf-8" },
};

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/health") {
      return Response.json({ ok: true });
    }

    if (request.method === "GET" && url.pathname === "/api/work-orders") {
      return Response.json({ workOrders: store.list() });
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

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Teamline is running at ${server.url}`);

function isGitRepository(repositoryPath: string): boolean {
  if (!repositoryPath || !existsSync(repositoryPath)) {
    return false;
  }

  return existsSync(join(repositoryPath, ".git"));
}
