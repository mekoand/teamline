import type { ConsoleWorkOrder, UserVisibleStatus } from "./console-presentation";
import type { PlanStage, WorkOrder } from "./work-order";

type CliDependencies = {
  cwd: () => string;
  env: Record<string, string | undefined>;
  fetch: typeof globalThis.fetch;
  openUrl: (url: string) => void | Promise<void>;
  stdout: (message: string) => void;
  stderr: (message: string) => void;
};

type JsonObject = Record<string, unknown>;

class CliUsageError extends Error {}

class CliRequestError extends Error {}

const help = `Teamline CLI

用法：
  teamline create <目标> [--acceptance <验收标准>]
  teamline list
  teamline show <委托 ID 或唯一前缀>
  teamline pause <委托 ID 或唯一前缀>
  teamline continue <委托 ID 或唯一前缀>
  teamline open <委托 ID 或唯一前缀>

CLI 只负责日常入口；计划编辑、执行地图和资源安排请在网页中完成。`;

const statusLabels: Record<UserVisibleStatus, string> = {
  planning: "待规划",
  running: "进行中",
  queued: "排队中",
  response: "需响应",
  completed: "已完成",
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
    stdout: console.log,
    stderr: console.error,
    ...overrides,
  };

  try {
    const [command, ...commandArgs] = args;
    if (!command || command === "help" || command === "--help" || command === "-h") {
      dependencies.stdout(help);
      return 0;
    }

    const baseUrl = localBaseUrl(dependencies.env);
    if (command === "create") {
      await createCommand(commandArgs, baseUrl, dependencies);
      return 0;
    }
    if (command === "list" || command === "ls") {
      requireNoArguments(commandArgs, command);
      await listCommand(baseUrl, dependencies);
      return 0;
    }
    if (["show", "pause", "continue", "open"].includes(command)) {
      const reference = requireReference(commandArgs, command);
      await workOrderCommand(command, reference, baseUrl, dependencies);
      return 0;
    }

    throw new CliUsageError(`未知命令：${command}\n\n${help}`);
  } catch (error) {
    dependencies.stderr(error instanceof Error ? error.message : "Teamline CLI 执行失败");
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
): Promise<void> {
  const { goal, acceptance } = parseCreateArguments(args);
  const response = await requestJson(
    baseUrl,
    "/api/work-orders",
    dependencies,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspacePath: dependencies.cwd(),
        goal,
        ...(acceptance ? { acceptance } : {}),
      }),
    },
  );
  const workOrder = response.workOrder as WorkOrder | undefined;
  if (!workOrder?.id) throw new CliRequestError("本地服务返回了无法识别的创建结果");

  dependencies.stdout(`已创建：${workOrder.title}`);
  dependencies.stdout(`ID：${workOrder.id}`);
  dependencies.stdout(`网页：${workOrderUrl(baseUrl, workOrder.id)}`);
}

async function listCommand(baseUrl: URL, dependencies: CliDependencies): Promise<void> {
  const workOrders = await consoleWorkOrders(baseUrl, dependencies);
  if (workOrders.length === 0) {
    dependencies.stdout("还没有工作委托。");
    return;
  }

  for (const workOrder of workOrders) {
    dependencies.stdout(
      `${shortId(workOrder.id)}  ${statusLabels[workOrder.userStatus]}  ${workOrder.title}`,
    );
    dependencies.stdout(`  当前：${currentNode(workOrder)}`);
    dependencies.stdout(`  原因：${workOrder.statusReason}`);
  }
}

async function workOrderCommand(
  command: string,
  reference: string,
  baseUrl: URL,
  dependencies: CliDependencies,
): Promise<void> {
  const workOrders = await consoleWorkOrders(baseUrl, dependencies);
  const workOrder = resolveWorkOrder(workOrders, reference);

  if (command === "show") {
    showWorkOrder(workOrder, baseUrl, dependencies);
    return;
  }
  if (command === "open") {
    const url = workOrderUrl(baseUrl, workOrder.id);
    await dependencies.openUrl(url);
    dependencies.stdout(`已打开：${url}`);
    return;
  }

  const action = command === "pause" ? "interrupt" : "continue";
  const response = await requestJson(
    baseUrl,
    `/api/work-orders/${encodeURIComponent(workOrder.id)}/${action}`,
    dependencies,
    { method: "POST" },
  );
  const updated = response.workOrder as WorkOrder | undefined;
  if (!updated?.id) throw new CliRequestError("本地服务返回了无法识别的委托状态");
  dependencies.stdout(
    command === "pause"
      ? `正在暂停：${updated.title}`
      : `已继续：${updated.title}`,
  );
}

function showWorkOrder(
  workOrder: ConsoleWorkOrder,
  baseUrl: URL,
  dependencies: CliDependencies,
): void {
  dependencies.stdout(workOrder.title);
  dependencies.stdout(`ID：${workOrder.id}`);
  dependencies.stdout(
    `状态：${statusLabels[workOrder.userStatus]}（${workOrder.statusReason}）`,
  );
  dependencies.stdout(`当前节点：${currentNode(workOrder)}`);
  dependencies.stdout(`工作空间：${workOrder.workspace?.path ?? "未选择"}`);
  dependencies.stdout(`目标：${workOrder.goal}`);
  dependencies.stdout(`验收：${workOrder.acceptance ?? "未填写"}`);
  dependencies.stdout(`网页：${workOrderUrl(baseUrl, workOrder.id)}`);
}

async function consoleWorkOrders(
  baseUrl: URL,
  dependencies: CliDependencies,
): Promise<ConsoleWorkOrder[]> {
  const response = await requestJson(baseUrl, "/api/console", dependencies);
  if (!Array.isArray(response.workOrders)) {
    throw new CliRequestError("本地服务返回了无法识别的委托列表");
  }
  return response.workOrders as ConsoleWorkOrder[];
}

async function requestJson(
  baseUrl: URL,
  path: string,
  dependencies: CliDependencies,
  init?: RequestInit,
): Promise<JsonObject> {
  let response: Response;
  try {
    response = await dependencies.fetch(new URL(path, baseUrl), init);
  } catch {
    throw new CliRequestError(
      `无法连接 Teamline 本地服务（${baseUrl.origin}）。请先运行 bun run dev。`,
    );
  }

  let body: JsonObject = {};
  try {
    body = (await response.json()) as JsonObject;
  } catch {
    if (response.ok) throw new CliRequestError("本地服务返回了无法识别的响应");
  }
  if (!response.ok) {
    throw new CliRequestError(
      typeof body.error === "string" ? body.error : `本地服务请求失败（${response.status}）`,
    );
  }
  return body;
}

function parseCreateArguments(args: string[]): { goal: string; acceptance?: string } {
  const goalParts: string[] = [];
  let acceptance: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--acceptance" || argument === "-a") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new CliUsageError("--acceptance 需要一个验收标准");
      }
      acceptance = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--acceptance=")) {
      acceptance = argument.slice("--acceptance=".length);
      if (!acceptance) throw new CliUsageError("--acceptance 需要一个验收标准");
      continue;
    }
    if (argument.startsWith("-")) {
      throw new CliUsageError(`未知选项：${argument}`);
    }
    goalParts.push(argument);
  }
  const goal = goalParts.join(" ").trim();
  if (!goal) {
    throw new CliUsageError("请提供委托目标：teamline create <目标> [--acceptance <验收标准>]");
  }
  return { goal, ...(acceptance ? { acceptance } : {}) };
}

function resolveWorkOrder(
  workOrders: ConsoleWorkOrder[],
  reference: string,
): ConsoleWorkOrder {
  const exact = workOrders.find((workOrder) => workOrder.id === reference);
  if (exact) return exact;
  const matches = workOrders.filter((workOrder) => workOrder.id.startsWith(reference));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new CliUsageError(`委托 ID 前缀“${reference}”不唯一，请多输入几位`);
  }
  throw new CliUsageError(`找不到委托：${reference}`);
}

function currentNode(workOrder: WorkOrder): string {
  const stages = workOrder.plan?.stages ?? [];
  const stage =
    stages.find((candidate) => candidate.status === "running") ??
    stages.find((candidate) => candidate.status === "response") ??
    stages.find((candidate) => candidate.status !== "completed") ??
    stages.at(-1);
  return stage ? describeStage(stage) : workOrder.currentSummary;
}

function describeStage(stage: PlanStage): string {
  return stage.statusReason ? `${stage.outcome}（${stage.statusReason}）` : stage.outcome;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function workOrderUrl(baseUrl: URL, id: string): string {
  return new URL(`/work-orders/${encodeURIComponent(id)}`, baseUrl).toString();
}

function localBaseUrl(env: Record<string, string | undefined>): URL {
  const raw = env.TEAMLINE_URL ?? `http://127.0.0.1:${env.TEAMLINE_PORT ?? "4310"}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliUsageError(`TEAMLINE_URL 无效：${raw}`);
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
    throw new CliUsageError("TEAMLINE_URL 必须是本机 HTTP 地址，例如 http://127.0.0.1:4310");
  }
  return url;
}

function requireReference(args: string[], command: string): string {
  if (args.length !== 1 || !args[0]) {
    throw new CliUsageError(`用法：teamline ${command} <委托 ID 或唯一前缀>`);
  }
  return args[0];
}

function requireNoArguments(args: string[], command: string): void {
  if (args.length > 0) throw new CliUsageError(`用法：teamline ${command}`);
}

export function openInBrowser(
  url: string,
  spawn: (command: string[]) => { exitCode: number; stderr: { toString(): string } } =
    (command) => Bun.spawnSync(command, { stdout: "ignore", stderr: "pipe" }),
): void {
  const result = spawn(["open", url]);
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim();
    throw new CliRequestError(detail || "无法打开 Teamline 网页");
  }
}
