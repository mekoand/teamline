import {
  CodexAppServerResourceProvider,
  OpenAIOrganizationUsageProvider,
  type ResourceProvider,
} from "./resource-provider";

type ResourceEnvironment = {
  TEAMLINE_CODEX_PATH?: string;
  OPENAI_ADMIN_KEY?: string;
};

export function createServerResourceProvider(
  environment: ResourceEnvironment = process.env,
): ResourceProvider {
  return new CodexAppServerResourceProvider(
    environment.TEAMLINE_CODEX_PATH || "codex",
    5_000,
    environment.OPENAI_ADMIN_KEY
      ? new OpenAIOrganizationUsageProvider(environment.OPENAI_ADMIN_KEY)
      : undefined,
  );
}
