import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createApp } from "./app";
import { CodexPlanGenerator } from "./codex-plan-generator";
import { WorkOrderStore } from "./work-order-store";

const projectRoot = resolve(import.meta.dir, "..");
const dataDirectory = resolve(process.env.TEAMLINE_DATA_DIR ?? join(projectRoot, ".teamline"));
mkdirSync(dataDirectory, { recursive: true });

const store = new WorkOrderStore(new Database(join(dataDirectory, "teamline.db"), { create: true }));
const port = Number(process.env.TEAMLINE_PORT ?? 4310);
const app = createApp({ store, planGenerator: new CodexPlanGenerator(), projectRoot });

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: app.fetch,
});

console.log(`Teamline is running at ${server.url}`);
