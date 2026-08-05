import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createApp } from "./app";
import { CodexPlanGenerator } from "./codex-plan-generator";
import { CodexExecutionRunner } from "./codex-runner";
import { WorkOrderStore } from "./work-order-store";
import { GitWorktreeManager } from "./worktree-manager";
import { LocalWorkOrderResultProcessor } from "./result-processor";
import { createServerResourceProvider } from "./server-resources";
import { GitCheckpointManager } from "./checkpoint-manager";
import { LocalCodexSessionProvider } from "./codex-session-discovery";
import { LocalClaudeCodeSessionProvider } from "./claude-code-session-discovery";
import { CodexSessionOrganizer } from "./session-organizer";
import { LocalCodexIdentityEnvironment } from "./execution-identity-environment";

const projectRoot = resolve(import.meta.dir, "..");
const dataDirectory = resolve(process.env.TEAMLINE_DATA_DIR ?? join(projectRoot, ".teamline"));
const systemCodexHome = resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"));
mkdirSync(dataDirectory, { recursive: true });

const store = new WorkOrderStore(new Database(join(dataDirectory, "teamline.db"), { create: true }));
store.interruptActiveRunsAfterRestart();
const port = Number(process.env.TEAMLINE_PORT ?? 4310);
const app = createApp({
  store,
  planGenerator: new CodexPlanGenerator(),
  codexRunner: new CodexExecutionRunner(),
  worktreeManager: new GitWorktreeManager(join(dataDirectory, "worktrees")),
  resultProcessor: new LocalWorkOrderResultProcessor(),
  resourceProvider: createServerResourceProvider(),
  checkpointManager: new GitCheckpointManager(),
  codexSessionProvider: new LocalCodexSessionProvider(systemCodexHome),
  codexSessionProviderForIdentity: (identity) =>
    new LocalCodexSessionProvider(
      identity.homeKind === "managed"
        ? identity.managedHomePath!
        : systemCodexHome,
    ),
  claudeCodeSessionProvider: new LocalClaudeCodeSessionProvider(
    resolve(process.env.CLAUDE_CODE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects")),
  ),
  sessionOrganizer: new CodexSessionOrganizer(),
  projectRoot,
  dataDirectory,
  executionIdentityEnvironment: new LocalCodexIdentityEnvironment(
    join(dataDirectory, "codex-identities"),
    {
      executable: process.env.TEAMLINE_CODEX_PATH,
      systemHome: systemCodexHome,
    },
  ),
});

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 0,
  fetch: app.fetch,
});

console.log(`Teamline is running at ${server.url}`);
