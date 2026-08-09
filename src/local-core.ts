import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "./app";
import { CodexPlanGenerator } from "./codex-plan-generator";
import { CodexExecutionRunner, type CodexRunner } from "./codex-runner";
import { LocalClaudeCodeSessionProvider } from "./claude-code-session-discovery";
import { LocalCodexIdentityEnvironment } from "./execution-identity-environment";
import { LocalCodexSessionProvider } from "./codex-session-discovery";
import { LocalWorkOrderResultProcessor } from "./result-processor";
import { createServerIdentityResourceProvider, createServerResourceProvider } from "./server-resources";
import { CodexSessionOrganizer } from "./session-organizer";
import type { SessionOrganizationResourceSelector } from "./resource-provider";
import { GitCheckpointManager } from "./checkpoint-manager";
import { WorkOrderStore } from "./work-order-store";
import { GitWorktreeManager } from "./worktree-manager";

export type LocalCoreOptions = {
  dataDirectory?: string;
  projectRoot?: string;
  port?: number;
  codexRunner?: CodexRunner;
  environment?: Record<string, string | undefined>;
};

export type LocalCore = {
  url: URL;
  dataDirectory: string;
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
};

export function resolveLocalCoreDataDirectory(
  environment: Record<string, string | undefined> = process.env,
  projectRoot = resolve(import.meta.dir, ".."),
): string {
  const configured = environment.TEAMLINE_DATA_DIR?.trim();
  if (configured) return resolve(configured);
  return join(projectRoot, ".teamline");
}

export function localCoreIdentity(dataDirectory: string): string {
  return createHash("sha256")
    .update(resolve(dataDirectory))
    .digest("hex")
    .slice(0, 16);
}

export async function startLocalCore(options: LocalCoreOptions = {}): Promise<LocalCore> {
  const environment = options.environment ?? process.env;
  const projectRoot = resolve(options.projectRoot ?? resolve(import.meta.dir, ".."));
  const dataDirectory = resolve(
    options.dataDirectory ?? resolveLocalCoreDataDirectory(environment, projectRoot),
  );
  const systemCodexHome = resolve(
    environment.CODEX_HOME?.trim() || join(homedir(), ".codex"),
  );
  mkdirSync(dataDirectory, { recursive: true });

  const store = new WorkOrderStore(
    new Database(join(dataDirectory, "teamline.db"), { create: true }),
  );
  store.interruptActiveRunsAfterRestart();
  const executionIdentityEnvironment = new LocalCodexIdentityEnvironment(
    join(dataDirectory, "codex-identities"),
    {
      executable: environment.TEAMLINE_CODEX_PATH,
      systemHome: systemCodexHome,
    },
  );
  const sessionOrganizationModel =
    environment.TEAMLINE_SESSION_ORGANIZER_MODEL?.trim() || "gpt-5.6-luna";
  const sessionOrganizationResourceSelector: SessionOrganizationResourceSelector = {
    async select(request) {
      const identityId = request.accountId ??
        store.getCurrentExecutionIdentityId() ??
        store.getDefaultExecutionIdentityId();
      const identity = identityId ? store.getExecutionIdentity(identityId) : null;
      if (
        !identity ||
        identity.status !== "enabled" ||
        (identity.loginState !== "ready" &&
          !(identity.homeKind === "system" && identity.loginState === "unknown"))
      ) {
        return null;
      }
      return {
        tool: "codex",
        model: sessionOrganizationModel,
        accountId: identity.id,
        accountLabel: identity.label,
      };
    },
  };
  const app = createApp({
    store,
    planGenerator: new CodexPlanGenerator(),
    codexRunner: options.codexRunner ?? new CodexExecutionRunner(),
    worktreeManager: new GitWorktreeManager(join(dataDirectory, "worktrees")),
    resultProcessor: new LocalWorkOrderResultProcessor(),
    resourceProvider: createServerResourceProvider(environment),
    identityResourceProvider: createServerIdentityResourceProvider(systemCodexHome),
    checkpointManager: new GitCheckpointManager(),
    codexSessionProvider: new LocalCodexSessionProvider(systemCodexHome),
    codexSessionProviderForIdentity: (identity) =>
      new LocalCodexSessionProvider(
        identity.homeKind === "managed"
          ? identity.managedHomePath!
          : systemCodexHome,
      ),
    claudeCodeSessionProvider: new LocalClaudeCodeSessionProvider(
      resolve(
        environment.CLAUDE_CODE_PROJECTS_DIR?.trim() ||
          join(homedir(), ".claude", "projects"),
      ),
    ),
    sessionOrganizationResourceSelector,
    sessionOrganizer: new CodexSessionOrganizer({
      codexPath: environment.TEAMLINE_CODEX_PATH,
      defaultModel: sessionOrganizationModel,
      codexHomeForAccount: (accountId) => {
        const identity = store.getExecutionIdentity(accountId);
        if (
          !identity ||
          identity.status !== "enabled" ||
          (identity.loginState !== "ready" &&
            !(identity.homeKind === "system" && identity.loginState === "unknown"))
        ) {
          return undefined;
        }
        return identity?.homeKind === "managed"
          ? identity.managedHomePath ?? undefined
          : systemCodexHome;
      },
    }),
    projectRoot,
    dataDirectory,
    executionIdentityEnvironment,
  });
  const coreIdentity = localCoreIdentity(dataDirectory);
  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/local-core/health") {
      return Response.json({
        service: "teamline-local-core",
        identity: coreIdentity,
      });
    }
    return app.fetch(request);
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? Number(environment.TEAMLINE_PORT ?? 4310),
    idleTimeout: 0,
    fetch,
  });

  let closed = false;
  return {
    url: server.url,
    dataDirectory,
    fetch,
    async close() {
      if (closed) return;
      closed = true;
      server.stop(true);
      await app.close();
      await executionIdentityEnvironment.close();
      store.database.close();
    },
  };
}
