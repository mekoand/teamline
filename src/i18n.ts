export const interfaceLocales = ["en", "zh-CN"] as const;

export type InterfaceLocale = (typeof interfaceLocales)[number];

const en = {
  "language.english": "English",
  "language.chinese": "Simplified Chinese",
  "cli.help": `Teamline CLI

Usage:
  teamline create <goal> [--acceptance <criteria>]
  teamline list
  teamline show <goal ID or unique prefix>
  teamline interrupt <goal ID or unique prefix>
  teamline continue <goal ID or unique prefix>
  teamline open <goal ID or unique prefix>

Options:
  --lang <en|zh-CN>  Use this language for one command.

The CLI provides everyday entry points. Edit plans, inspect the execution graph, and arrange resources in the web interface.`,
  "cli.failed": "Teamline CLI failed",
  "cli.unknown_command": "Unknown command: {command}",
  "cli.unknown_option": "Unknown option: {option}",
  "cli.created": "Created: {title}",
  "cli.id": "ID: {id}",
  "cli.web": "Web: {url}",
  "cli.no_goals": "There are no goals yet.",
  "cli.current": "  Current: {value}",
  "cli.reason": "  Reason: {value}",
  "cli.opened": "Opened: {url}",
  "cli.interrupting": "Interrupting: {title}",
  "cli.continued": "Continued: {title}",
  "cli.status": "Status: {status} ({reason})",
  "cli.current_node": "Current node: {value}",
  "cli.workspace": "Workspace: {value}",
  "cli.goal": "Goal: {value}",
  "cli.acceptance": "Acceptance: {value}",
  "cli.not_selected": "Not selected",
  "cli.not_provided": "Not provided",
  "cli.invalid_create_result": "The local service returned an unrecognized creation result",
  "cli.invalid_goal_state": "The local service returned an unrecognized goal state",
  "cli.invalid_goal_list": "The local service returned an unrecognized goal list",
  "cli.invalid_response": "The local service returned an unrecognized response",
  "cli.connect_failed": "Cannot connect to the Teamline local service ({origin}). Run bun run dev first.",
  "cli.request_failed": "Local service request failed ({status})",
  "cli.acceptance_required": "--acceptance requires acceptance criteria",
  "cli.goal_required": "Provide a goal: teamline create <goal> [--acceptance <criteria>]",
  "cli.ambiguous_id": "Goal ID prefix \"{reference}\" is ambiguous; enter more characters",
  "cli.goal_not_found": "Goal not found: {reference}",
  "cli.invalid_url": "Invalid TEAMLINE_URL: {value}",
  "cli.local_url_required": "TEAMLINE_URL must be a local HTTP address, for example http://127.0.0.1:4310",
  "cli.reference_usage": "Usage: teamline {command} <goal ID or unique prefix>",
  "cli.command_usage": "Usage: teamline {command}",
  "cli.open_failed": "Unable to open the Teamline web interface",
  "locale.invalid": "Unsupported language: {value}. Use en or zh-CN.",
  "status.planning": "Planning",
  "status.running": "Running",
  "status.queued": "Queued",
  "status.response": "Needs response",
  "status.review": "Review-ready",
  "status.completed": "Completed",
  "reason.key_information": "Waiting for key information",
  "reason.organizing_history": "Organizing history",
  "reason.organization_interrupted": "History organization interrupted",
  "reason.organization_failed": "History organization failed",
  "reason.followup_plan": "Waiting to generate the follow-up plan",
  "reason.delivered": "Delivery confirmed",
  "reason.review": "Waiting for acceptance",
  "reason.external_stage": "Waiting for external node: {outcome}",
  "reason.run_limit": "Per-run limit reached",
  "reason.validation_failed": "Automatic validation failed",
  "reason.node_confirmation": "Waiting for current node confirmation",
  "reason.execution_failed": "Execution failed",
  "reason.execution_interrupted": "Execution interrupted",
  "reason.stopping": "Stopping",
  "reason.processing_result": "Processing results",
  "reason.codex_running": "Codex is running",
  "reason.advancing": "Advancing",
  "reason.confirm_plan": "Waiting for plan confirmation",
  "reason.select_workspace": "Waiting for workspace selection",
  "reason.account": "Waiting for account",
  "reason.capacity": "Waiting for available concurrency",
  "reason.ready": "Ready to run",
  "reason.generate_plan": "Waiting to generate a plan",
  "scheduler.awaiting_higher_priority": "Waiting for a higher-priority goal",
  "scheduler.awaiting_round_capacity": "Waiting for capacity in this round",
  "scheduler.completed": "Goal completed",
  "scheduler.running": "Currently running",
  "scheduler.awaiting_external_stage": "Waiting for the external node",
  "scheduler.run_limit_reached": "Run limit reached; waiting to continue",
  "scheduler.verification_failed": "Verification failed; waiting for resolution",
  "scheduler.awaiting_node_confirmation": "Waiting for current node confirmation",
  "scheduler.awaiting_response": "Waiting for a response before continuing",
  "scheduler.awaiting_plan": "Waiting for plan confirmation",
  "scheduler.workspace_unavailable": "Workspace unavailable; waiting for recheck",
  "scheduler.awaiting_dependencies": "Waiting for dependencies",
  "scheduler.awaiting_run_limit": "Waiting for run-limit confirmation",
  "scheduler.workspace_in_use": "Workspace is in use",
  "scheduler.quota_conflict": "Quota data conflicts; waiting for refresh",
  "scheduler.quota_stale": "Quota data is stale; waiting for refresh",
  "scheduler.quota_unavailable": "Quota data unavailable; remaining queued",
  "scheduler.quota_incomplete": "Quota windows incomplete; remaining queued",
  "scheduler.quota_insufficient": "Quota insufficient; waiting for availability",
  "scheduler.awaiting_identity_selection": "Waiting for a Codex account selection",
  "scheduler.identity_unavailable": "Codex account unavailable; waiting for resolution",
} as const;

export type MessageKey = keyof typeof en;
export type MessageParams = Record<string, string | number>;

export type LocalizableMessage = {
  code: string;
  params?: Record<string, string | number | boolean | null>;
};

const zhCN: Record<MessageKey, string> = {
  "language.english": "英文",
  "language.chinese": "简体中文",
  "cli.help": `Teamline CLI

用法：
  teamline create <目标> [--acceptance <验收标准>]
  teamline list
  teamline show <目标 ID 或唯一前缀>
  teamline interrupt <目标 ID 或唯一前缀>
  teamline continue <目标 ID 或唯一前缀>
  teamline open <目标 ID 或唯一前缀>

选项：
  --lang <en|zh-CN>  仅为本次命令选择语言。

CLI 只负责日常入口；计划编辑、执行图和资源安排请在网页中完成。`,
  "cli.failed": "Teamline CLI 执行失败",
  "cli.unknown_command": "未知命令：{command}",
  "cli.unknown_option": "未知选项：{option}",
  "cli.created": "已创建：{title}",
  "cli.id": "ID：{id}",
  "cli.web": "网页：{url}",
  "cli.no_goals": "还没有目标。",
  "cli.current": "  当前：{value}",
  "cli.reason": "  原因：{value}",
  "cli.opened": "已打开：{url}",
  "cli.interrupting": "正在中断：{title}",
  "cli.continued": "已继续：{title}",
  "cli.status": "状态：{status}（{reason}）",
  "cli.current_node": "当前节点：{value}",
  "cli.workspace": "工作空间：{value}",
  "cli.goal": "目标：{value}",
  "cli.acceptance": "验收：{value}",
  "cli.not_selected": "未选择",
  "cli.not_provided": "未填写",
  "cli.invalid_create_result": "本地服务返回了无法识别的创建结果",
  "cli.invalid_goal_state": "本地服务返回了无法识别的目标状态",
  "cli.invalid_goal_list": "本地服务返回了无法识别的目标列表",
  "cli.invalid_response": "本地服务返回了无法识别的响应",
  "cli.connect_failed": "无法连接 Teamline 本地服务（{origin}）。请先运行 bun run dev。",
  "cli.request_failed": "本地服务请求失败（{status}）",
  "cli.acceptance_required": "--acceptance 需要一个验收标准",
  "cli.goal_required": "请提供目标：teamline create <目标> [--acceptance <验收标准>]",
  "cli.ambiguous_id": "目标 ID 前缀“{reference}”不唯一，请多输入几位",
  "cli.goal_not_found": "找不到目标：{reference}",
  "cli.invalid_url": "TEAMLINE_URL 无效：{value}",
  "cli.local_url_required": "TEAMLINE_URL 必须是本机 HTTP 地址，例如 http://127.0.0.1:4310",
  "cli.reference_usage": "用法：teamline {command} <目标 ID 或唯一前缀>",
  "cli.command_usage": "用法：teamline {command}",
  "cli.open_failed": "无法打开 Teamline 网页",
  "locale.invalid": "不支持的语言：{value}。请使用 en 或 zh-CN。",
  "status.planning": "规划中",
  "status.running": "运行中",
  "status.queued": "待运行",
  "status.response": "需响应",
  "status.review": "待验收",
  "status.completed": "已完成",
  "reason.key_information": "待补充关键信息",
  "reason.organizing_history": "正在整理历史",
  "reason.organization_interrupted": "历史整理中断",
  "reason.organization_failed": "历史整理失败",
  "reason.followup_plan": "待生成后续计划",
  "reason.delivered": "已确认交付",
  "reason.review": "待验收",
  "reason.external_stage": "待完成外部节点：{outcome}",
  "reason.run_limit": "已达到本轮上限",
  "reason.validation_failed": "自动验证未通过",
  "reason.node_confirmation": "待确认当前节点结果",
  "reason.execution_failed": "执行失败",
  "reason.execution_interrupted": "执行中断",
  "reason.stopping": "正在停止",
  "reason.processing_result": "正在整理结果",
  "reason.codex_running": "Codex 执行中",
  "reason.advancing": "正在推进",
  "reason.confirm_plan": "待确认计划",
  "reason.select_workspace": "等待选择工作空间",
  "reason.account": "等待账号",
  "reason.capacity": "等待可用并发位置",
  "reason.ready": "可以开始运行",
  "reason.generate_plan": "待生成计划",
  "scheduler.awaiting_higher_priority": "等待更高优先级目标",
  "scheduler.awaiting_round_capacity": "等待本轮资源位置",
  "scheduler.completed": "目标已完成",
  "scheduler.running": "当前正在运行",
  "scheduler.awaiting_external_stage": "等待完成外部节点",
  "scheduler.run_limit_reached": "已达到本轮上限，等待继续",
  "scheduler.verification_failed": "验证失败，等待处理后继续",
  "scheduler.awaiting_node_confirmation": "等待确认当前节点结果",
  "scheduler.awaiting_response": "需要响应后继续",
  "scheduler.awaiting_plan": "等待确认计划",
  "scheduler.workspace_unavailable": "工作空间不可用，等待重新检查",
  "scheduler.awaiting_dependencies": "等待前置节点完成",
  "scheduler.awaiting_run_limit": "等待确认单轮运行上限",
  "scheduler.workspace_in_use": "工作空间正在使用",
  "scheduler.quota_conflict": "额度数据冲突，等待重新读取",
  "scheduler.quota_stale": "额度数据已过期，等待重新读取",
  "scheduler.quota_unavailable": "额度数据不可用，保持排队",
  "scheduler.quota_incomplete": "额度窗口不完整，保持排队",
  "scheduler.quota_insufficient": "额度不足，等待可用额度",
  "scheduler.awaiting_identity_selection": "等待选择 Codex 账号",
  "scheduler.identity_unavailable": "Codex 账号不可用，等待处理",
};

export const messageCatalogs: Record<InterfaceLocale, Record<MessageKey, string>> = {
  en,
  "zh-CN": zhCN,
};

export function normalizeLocale(value: unknown): InterfaceLocale | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  if (
    normalized === "zh" ||
    normalized === "zh-cn" ||
    normalized === "zh-hans" ||
    normalized.startsWith("zh-hans-")
  ) {
    return "zh-CN";
  }
  return null;
}

export function resolveInterfaceLocale(options: {
  explicit?: unknown;
  environment?: unknown;
  saved?: unknown;
  browserLanguages?: readonly string[];
}): InterfaceLocale {
  for (const candidate of [options.explicit, options.environment, options.saved]) {
    const locale = normalizeLocale(candidate);
    if (locale) return locale;
  }
  for (const candidate of options.browserLanguages ?? []) {
    const locale = normalizeLocale(candidate);
    if (locale) return locale;
  }
  return "en";
}

export function formatMessage(
  locale: InterfaceLocale,
  key: MessageKey,
  params: MessageParams = {},
): string {
  return messageCatalogs[locale][key].replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_, name) =>
    String(params[name] ?? `{${name}}`),
  );
}

const legacyReasonKeys = new Map<string, MessageKey>([
  ["待补充关键信息", "reason.key_information"],
  ["正在整理历史", "reason.organizing_history"],
  ["历史整理中断", "reason.organization_interrupted"],
  ["历史整理失败", "reason.organization_failed"],
  ["待生成后续计划", "reason.followup_plan"],
  ["已确认交付", "reason.delivered"],
  ["待验收", "reason.review"],
  ["已达到本轮上限", "reason.run_limit"],
  ["自动验证未通过", "reason.validation_failed"],
  ["待确认当前节点结果", "reason.node_confirmation"],
  ["执行失败", "reason.execution_failed"],
  ["执行中断", "reason.execution_interrupted"],
  ["正在停止", "reason.stopping"],
  ["正在整理结果", "reason.processing_result"],
  ["Codex 执行中", "reason.codex_running"],
  ["正在推进", "reason.advancing"],
  ["待确认计划", "reason.confirm_plan"],
  ["等待选择工作空间", "reason.select_workspace"],
  ["等待账号", "reason.account"],
  ["等待可用并发位置", "reason.capacity"],
  ["可以开始运行", "reason.ready"],
  ["待生成计划", "reason.generate_plan"],
]);

const semanticMessageKeys = new Map<string, MessageKey>([
  ["status.awaiting_clarification", "reason.key_information"],
  ["status.organizing_history", "reason.organizing_history"],
  ["import.interrupted", "reason.organization_interrupted"],
  ["import.failed", "reason.organization_failed"],
  ["status.awaiting_followup_plan", "reason.followup_plan"],
  ["status.delivered", "reason.delivered"],
  ["status.awaiting_review", "reason.review"],
  ["status.awaiting_external_stage", "reason.external_stage"],
  ["status.run_limit_reached", "reason.run_limit"],
  ["status.verification_failed", "reason.validation_failed"],
  ["status.awaiting_node_confirmation", "reason.node_confirmation"],
  ["status.execution_failed", "reason.execution_failed"],
  ["status.execution_interrupted", "reason.execution_interrupted"],
  ["status.stopping", "reason.stopping"],
  ["status.processing_result", "reason.processing_result"],
  ["status.running_codex", "reason.codex_running"],
  ["status.running", "reason.advancing"],
  ["status.awaiting_plan_confirmation", "reason.confirm_plan"],
  ["status.awaiting_workspace", "reason.select_workspace"],
  ["status.awaiting_identity", "reason.account"],
  ["status.awaiting_capacity", "reason.capacity"],
  ["status.ready_to_run", "reason.ready"],
  ["status.awaiting_plan", "reason.generate_plan"],
  ...[...Object.keys(en)]
    .filter((key) => key.startsWith("scheduler."))
    .map((key) => [key, key as MessageKey] as const),
]);

export function formatSemanticMessage(
  locale: InterfaceLocale,
  message: LocalizableMessage | null | undefined,
  fallback: string,
): string {
  if (!message?.code || message.code === "legacy.text") {
    const legacy = message?.params?.text;
    return formatLegacyMessage(locale, typeof legacy === "string" ? legacy : fallback);
  }
  const key = semanticMessageKeys.get(message.code);
  if (!key) return formatLegacyMessage(locale, fallback);
  const params = Object.fromEntries(
    Object.entries(message.params ?? {}).map(([name, value]) => [name, String(value ?? "")]),
  );
  return formatMessage(locale, key, params);
}

export function formatLegacyMessage(locale: InterfaceLocale, value: string): string {
  const key = legacyReasonKeys.get(value);
  if (key) return formatMessage(locale, key);
  const external = value.match(/^待完成外部节点：(.+)$/);
  if (external) {
    return formatMessage(locale, "reason.external_stage", { outcome: external[1] });
  }
  return value;
}

export function catalogParameterNames(value: string): string[] {
  return [...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)]
    .map((match) => match[1])
    .sort();
}
