import type { ConsoleWorkOrder, UserVisibleStatus } from "./console-presentation";
import {
  formatLegacyMessage,
  formatMessage,
  normalizeLocale,
  resolveInterfaceLocale,
  type InterfaceLocale,
  type MessageKey,
  type MessageParams,
} from "./i18n";
import type { PlanStage, WorkOrder } from "./work-order";

type CliDependencies = {
  cwd: () => string;
  env: Record<string, string | undefined>;
  fetch: typeof globalThis.fetch;
  openUrl: (url: string) => void | Promise<void>;
  resolveWorkspace: (cwd: string) => Promise<string>;
  stdout: (message: string) => void;
  stderr: (message: string) => void;
};

type JsonObject = Record<string, unknown>;

class CliUsageError extends Error {}

class CliRequestError extends Error {}

const statusKeys: Record<UserVisibleStatus, MessageKey> = {
  planning: "status.planning",
  running: "status.running",
  queued: "status.queued",
  response: "status.response",
  review: "status.review",
  completed: "status.completed",
};

export async function runCli(
  args: string[],
  overrides: Partial<CliDependencies> = {},
): Promise<number> {
  const dependencies: CliDependencies = {
    cwd: () => process.cwd(),
    env: process.env,
    fetch: globalThis.fetch,
    openUrl: openInBrowser,
    resolveWorkspace: resolveWorkspacePath,
    stdout: console.log,
    stderr: console.error,
    ...overrides,
  };

  let locale = resolveInterfaceLocale({ environment: dependencies.env.TEAMLINE_LANG });
  try {
    const language = extractLanguageOption(args, locale);
    if (
      dependencies.env.TEAMLINE_LANG &&
      !normalizeLocale(dependencies.env.TEAMLINE_LANG)
    ) {
      throw new CliUsageError(t(locale, "locale.invalid", {
        value: dependencies.env.TEAMLINE_LANG,
      }));
    }
    const baseUrl = localBaseUrl(dependencies.env, locale);
    const saved = language.explicit || dependencies.env.TEAMLINE_LANG
      ? null
      : await readSavedLocale(baseUrl, dependencies);
    locale = resolveInterfaceLocale({
      explicit: language.explicit,
      environment: dependencies.env.TEAMLINE_LANG,
      saved,
    });
    const [command, ...commandArgs] = language.args;
    if (!command || command === "help" || command === "--help" || command === "-h") {
      dependencies.stdout(formatMessage(locale, "cli.help"));
      return 0;
    }

    if (command === "create") {
      await createCommand(commandArgs, baseUrl, dependencies, locale);
      return 0;
    }
    if (command === "list" || command === "ls") {
      requireNoArguments(commandArgs, command, locale);
      await listCommand(baseUrl, dependencies, locale);
      return 0;
    }
    if (["show", "interrupt", "continue", "open"].includes(command)) {
      const reference = requireReference(commandArgs, command, locale);
      await workOrderCommand(command, reference, baseUrl, dependencies, locale);
      return 0;
    }

    throw new CliUsageError(
      `${t(locale, "cli.unknown_command", { command })}\n\n${t(locale, "cli.help")}`,
    );
  } catch (error) {
    dependencies.stderr(error instanceof Error ? error.message : t(locale, "cli.failed"));
    return error instanceof CliUsageError ? 2 : 1;
  }
}

export async function main(args = Bun.argv.slice(2)): Promise<void> {
  process.exitCode = await runCli(args);
}

async function createCommand(
  args: string[],
  baseUrl: URL,
  dependencies: CliDependencies,
  locale: InterfaceLocale,
): Promise<void> {
  const { goal, acceptance } = parseCreateArguments(args, locale);
  const response = await requestJson(
    baseUrl,
    "/api/work-orders",
    dependencies,
    locale,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspacePath: await dependencies.resolveWorkspace(dependencies.cwd()),
        goal,
        ...(acceptance ? { acceptance } : {}),
      }),
    },
  );
  const workOrder = response.workOrder as WorkOrder | undefined;
  if (!workOrder?.id) throw new CliRequestError(t(locale, "cli.invalid_create_result"));

  dependencies.stdout(t(locale, "cli.created", { title: workOrder.title }));
  dependencies.stdout(t(locale, "cli.id", { id: workOrder.id }));
  dependencies.stdout(t(locale, "cli.web", { url: workOrderUrl(baseUrl, workOrder.id) }));
}

async function listCommand(
  baseUrl: URL,
  dependencies: CliDependencies,
  locale: InterfaceLocale,
): Promise<void> {
  const workOrders = await consoleWorkOrders(baseUrl, dependencies, locale);
  if (workOrders.length === 0) {
    dependencies.stdout(t(locale, "cli.no_goals"));
    return;
  }

  for (const workOrder of workOrders) {
    dependencies.stdout(
      `${shortId(workOrder.id)}  ${t(locale, statusKeys[workOrder.userStatus])}  ${workOrder.title}`,
    );
    dependencies.stdout(t(locale, "cli.current", { value: currentNode(workOrder, locale) }));
    dependencies.stdout(t(locale, "cli.reason", {
      value: formatLegacyMessage(locale, workOrder.statusReason),
    }));
  }
}

async function workOrderCommand(
  command: string,
  reference: string,
  baseUrl: URL,
  dependencies: CliDependencies,
  locale: InterfaceLocale,
): Promise<void> {
  const workOrders = await consoleWorkOrders(baseUrl, dependencies, locale);
  const workOrder = resolveWorkOrder(workOrders, reference, locale);

  if (command === "show") {
    showWorkOrder(workOrder, baseUrl, dependencies, locale);
    return;
  }
  if (command === "open") {
    const url = workOrderUrl(baseUrl, workOrder.id);
    try {
      await dependencies.openUrl(url);
    } catch (error) {
      if (error instanceof Error && error.message !== t("en", "cli.open_failed")) {
        throw error;
      }
      throw new CliRequestError(t(locale, "cli.open_failed"));
    }
    dependencies.stdout(t(locale, "cli.opened", { url }));
    return;
  }

  const action = command;
  const response = await requestJson(
    baseUrl,
    `/api/work-orders/${encodeURIComponent(workOrder.id)}/${action}`,
    dependencies,
    locale,
    { method: "POST" },
  );
  const updated = response.workOrder as WorkOrder | undefined;
  if (!updated?.id) throw new CliRequestError(t(locale, "cli.invalid_goal_state"));
  dependencies.stdout(
    command === "interrupt"
      ? t(locale, "cli.interrupting", { title: updated.title })
      : t(locale, "cli.continued", { title: updated.title }),
  );
}

function showWorkOrder(
  workOrder: ConsoleWorkOrder,
  baseUrl: URL,
  dependencies: CliDependencies,
  locale: InterfaceLocale,
): void {
  dependencies.stdout(workOrder.title);
  dependencies.stdout(t(locale, "cli.id", { id: workOrder.id }));
  dependencies.stdout(t(locale, "cli.status", {
    status: t(locale, statusKeys[workOrder.userStatus]),
    reason: formatLegacyMessage(locale, workOrder.statusReason),
  }));
  dependencies.stdout(t(locale, "cli.current_node", { value: currentNode(workOrder, locale) }));
  dependencies.stdout(t(locale, "cli.workspace", {
    value: workOrder.workspace?.path ?? t(locale, "cli.not_selected"),
  }));
  dependencies.stdout(t(locale, "cli.goal", { value: workOrder.goal }));
  dependencies.stdout(t(locale, "cli.acceptance", {
    value: workOrder.acceptance ?? t(locale, "cli.not_provided"),
  }));
  dependencies.stdout(t(locale, "cli.web", { url: workOrderUrl(baseUrl, workOrder.id) }));
}

async function consoleWorkOrders(
  baseUrl: URL,
  dependencies: CliDependencies,
  locale: InterfaceLocale,
): Promise<ConsoleWorkOrder[]> {
  const response = await requestJson(baseUrl, "/api/console", dependencies, locale);
  if (!Array.isArray(response.workOrders)) {
    throw new CliRequestError(t(locale, "cli.invalid_goal_list"));
  }
  return response.workOrders as ConsoleWorkOrder[];
}

async function requestJson(
  baseUrl: URL,
  path: string,
  dependencies: CliDependencies,
  locale: InterfaceLocale,
  init?: RequestInit,
): Promise<JsonObject> {
  let response: Response;
  try {
    response = await dependencies.fetch(new URL(path, baseUrl), {
      ...init,
      redirect: "manual",
    });
  } catch {
    throw new CliRequestError(
      t(locale, "cli.connect_failed", { origin: baseUrl.origin }),
    );
  }

  let body: JsonObject = {};
  try {
    body = (await response.json()) as JsonObject;
  } catch {
    if (response.ok) throw new CliRequestError(t(locale, "cli.invalid_response"));
  }
  if (!response.ok) {
    throw new CliRequestError(
      typeof body.error === "string"
        ? formatLegacyMessage(locale, body.error)
        : t(locale, "cli.request_failed", { status: response.status }),
    );
  }
  return body;
}

function parseCreateArguments(
  args: string[],
  locale: InterfaceLocale,
): { goal: string; acceptance?: string } {
  const goalParts: string[] = [];
  let acceptance: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--acceptance" || argument === "-a") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new CliUsageError(t(locale, "cli.acceptance_required"));
      }
      acceptance = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--acceptance=")) {
      acceptance = argument.slice("--acceptance=".length);
      if (!acceptance) throw new CliUsageError(t(locale, "cli.acceptance_required"));
      continue;
    }
    if (argument.startsWith("-")) {
      throw new CliUsageError(t(locale, "cli.unknown_option", { option: argument }));
    }
    goalParts.push(argument);
  }
  const goal = goalParts.join(" ").trim();
  if (!goal) {
    throw new CliUsageError(t(locale, "cli.goal_required"));
  }
  return { goal, ...(acceptance ? { acceptance } : {}) };
}

function resolveWorkOrder(
  workOrders: ConsoleWorkOrder[],
  reference: string,
  locale: InterfaceLocale,
): ConsoleWorkOrder {
  const exact = workOrders.find((workOrder) => workOrder.id === reference);
  if (exact) return exact;
  const matches = workOrders.filter((workOrder) => workOrder.id.startsWith(reference));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new CliUsageError(t(locale, "cli.ambiguous_id", { reference }));
  }
  throw new CliUsageError(t(locale, "cli.goal_not_found", { reference }));
}

function currentNode(workOrder: WorkOrder, locale: InterfaceLocale): string {
  const stages = workOrder.plan?.stages ?? [];
  const stage =
    stages.find((candidate) => candidate.status === "running") ??
    stages.find((candidate) => candidate.status === "response") ??
    stages.find((candidate) => candidate.status !== "completed") ??
    stages.at(-1);
  return stage ? describeStage(stage, locale) : formatLegacyMessage(locale, workOrder.currentSummary);
}

function describeStage(stage: PlanStage, locale: InterfaceLocale): string {
  if (!stage.statusReason) return stage.outcome;
  const reason = formatLegacyMessage(locale, stage.statusReason);
  return locale === "zh-CN" ? `${stage.outcome}（${reason}）` : `${stage.outcome} (${reason})`;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function workOrderUrl(baseUrl: URL, id: string): string {
  return new URL(`/goals/${encodeURIComponent(id)}`, baseUrl).toString();
}

function localBaseUrl(
  env: Record<string, string | undefined>,
  locale: InterfaceLocale,
): URL {
  const raw = env.TEAMLINE_URL ?? `http://127.0.0.1:${env.TEAMLINE_PORT ?? "4310"}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliUsageError(t(locale, "cli.invalid_url", { value: raw }));
  }
  const localHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  if (
    url.protocol !== "http:" ||
    !localHosts.has(url.hostname) ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new CliUsageError(t(locale, "cli.local_url_required"));
  }
  return url;
}

function requireReference(
  args: string[],
  command: string,
  locale: InterfaceLocale,
): string {
  if (args.length !== 1 || !args[0]) {
    throw new CliUsageError(t(locale, "cli.reference_usage", { command }));
  }
  return args[0];
}

function requireNoArguments(
  args: string[],
  command: string,
  locale: InterfaceLocale,
): void {
  if (args.length > 0) {
    throw new CliUsageError(t(locale, "cli.command_usage", { command }));
  }
}

function t(
  locale: InterfaceLocale,
  key: MessageKey,
  params: MessageParams = {},
): string {
  return formatMessage(locale, key, params);
}

function extractLanguageOption(
  args: string[],
  errorLocale: InterfaceLocale,
): { args: string[]; explicit: InterfaceLocale | null } {
  const remaining: string[] = [];
  let explicit: InterfaceLocale | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--lang" || argument === "--language") {
      const value = args[index + 1];
      const locale = normalizeLocale(value);
      if (!locale) {
        throw new CliUsageError(t(errorLocale, "locale.invalid", {
          value: value ?? "",
        }));
      }
      explicit = locale;
      index += 1;
      continue;
    }
    if (argument.startsWith("--lang=") || argument.startsWith("--language=")) {
      const value = argument.slice(argument.indexOf("=") + 1);
      const locale = normalizeLocale(value);
      if (!locale) {
        throw new CliUsageError(t(errorLocale, "locale.invalid", { value }));
      }
      explicit = locale;
      continue;
    }
    remaining.push(argument);
  }
  return { args: remaining, explicit };
}

async function readSavedLocale(
  baseUrl: URL,
  dependencies: CliDependencies,
): Promise<InterfaceLocale | null> {
  try {
    const response = await dependencies.fetch(
      new URL("/api/preferences/language", baseUrl),
      { redirect: "manual" },
    );
    if (!response.ok) return null;
    const body = await response.json() as { language?: unknown };
    return normalizeLocale(body.language);
  } catch {
    return null;
  }
}

export function openInBrowser(
  url: string,
  spawn: (command: string[]) => { exitCode: number; stderr: { toString(): string } } =
    (command) => Bun.spawnSync(command, { stdout: "ignore", stderr: "pipe" }),
): void {
  const result = spawn(["open", url]);
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim();
    throw new CliRequestError(detail || formatMessage("en", "cli.open_failed"));
  }
}

export async function resolveWorkspacePath(cwd: string): Promise<string> {
  let subprocess: ReturnType<typeof Bun.spawn>;
  try {
    subprocess = Bun.spawn(["git", "-C", cwd, "rev-parse", "--show-toplevel"], {
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    return cwd;
  }

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      subprocess.kill(9);
    } catch {
      // The Git probe may have exited between scheduling and firing the timeout.
    }
  }, 1_500);
  try {
    const [exitCode, stdout] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
    ]);
    const repositoryRoot = stdout.trim();
    return !timedOut && exitCode === 0 && repositoryRoot ? repositoryRoot : cwd;
  } catch {
    return cwd;
  } finally {
    clearTimeout(timeout);
  }
}
