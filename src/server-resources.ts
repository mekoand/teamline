import {
  CodexAppServerResourceProvider,
  CodexExecutionIdentityResourceProvider,
  OpenAIOrganizationUsageProvider,
  type CodexIdentityResourceProvider,
  type ResourceProvider,
} from "./resource-provider";

type ResourceEnvironment = {
  TEAMLINE_CODEX_PATH?: string;
  OPENAI_ADMIN_KEY?: string;
  OPENAI_PROJECT_ID?: string;
};

export function createServerResourceProvider(
  environment: ResourceEnvironment = process.env,
): ResourceProvider {
  return new CodexAppServerResourceProvider(
    environment.TEAMLINE_CODEX_PATH || "codex",
    5_000,
    environment.OPENAI_ADMIN_KEY
      ? new OpenAIOrganizationUsageProvider(
          environment.OPENAI_ADMIN_KEY,
          environment.OPENAI_PROJECT_ID,
        )
      : undefined,
  );
}

export function createServerIdentityResourceProvider(
  systemCodexHome: string,
  environment: ResourceEnvironment = process.env,
): CodexIdentityResourceProvider {
  return new CodexExecutionIdentityResourceProvider(
    environment.TEAMLINE_CODEX_PATH || "codex",
    systemCodexHome,
  );
}
