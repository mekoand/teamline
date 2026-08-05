import type { WorkOrder } from "./work-order";
import type { ExecutionIdentity } from "./execution-identity";

export type CodexRunEvent =
  | { type: "session"; sessionId: string }
  | {
      type: "progress";
      message: string;
      category?: "message" | "tool" | "log" | "report";
      detail?: string;
      report?: {
        kind: "stage_start" | "stage_complete" | "needs_response" | "suggest_stage";
        stageId?: string;
      };
    }
  | {
      type: "exit";
      exitCode: number;
      message: string;
      resumeUnavailable?: boolean;
    };

export type ContinuationContext = {
  recentProgress: string[];
  gitStatus: string;
  reexecuteStage?: { id: string; outcome: string };
};

export type StartedCodexRun = {
  events: AsyncIterable<CodexRunEvent>;
  interrupt(): void;
  exited?: Promise<number>;
  pid?: number;
};

export interface CodexRunner {
  start(input: {
    workOrder: WorkOrder;
    workspacePath: string;
    executionIdentity?: ExecutionIdentity;
    continuation?: ContinuationContext;
  }): Promise<StartedCodexRun>;
  resume(input: {
    workOrder: WorkOrder;
    workspacePath: string;
    sessionId: string;
    executionIdentity?: ExecutionIdentity;
  }): Promise<StartedCodexRun>;
}

export class CodexExecutionRunner implements CodexRunner {
  constructor(private readonly commandPath = Bun.env.TEAMLINE_CODEX_PATH || "codex") {}

  async start(input: {
    workOrder: WorkOrder;
    workspacePath: string;
    executionIdentity?: ExecutionIdentity;
    continuation?: ContinuationContext;
  }): Promise<StartedCodexRun> {
    try {
      const subprocess = Bun.spawn(
        [
          this.commandPath,
          "exec",
          "--skip-git-repo-check",
          "--cd",
          input.workspacePath,
          "--json",
          "--color",
          "never",
          buildExecutionPrompt(input.workOrder, input.continuation),
        ],
        {
          cwd: input.workspacePath,
          env: executionEnvironment(input.executionIdentity),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const stderr = new Response(subprocess.stderr).text();
      return {
        events: readRunEvents(subprocess, stderr),
        exited: subprocess.exited,
        pid: subprocess.pid,
        interrupt() {
          subprocess.kill();
        },
      };
    } catch (error) {
      if (isMissingCommand(error)) {
        throw new Error("找不到 Codex，请先安装并登录 Codex");
      }
      throw new Error("Codex 无法启动，请确认本机 Codex 安装和配置后重试");
    }
  }

  async resume(input: {
    workOrder: WorkOrder;
    workspacePath: string;
    sessionId: string;
    executionIdentity?: ExecutionIdentity;
  }): Promise<StartedCodexRun> {
    try {
      const subprocess = Bun.spawn(
        [
          this.commandPath,
          "exec",
          "--skip-git-repo-check",
          "resume",
          input.sessionId,
          buildResumePrompt(input.workOrder),
          "--json",
        ],
        {
          cwd: input.workspacePath,
          env: executionEnvironment(input.executionIdentity),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const stderr = new Response(subprocess.stderr).text();
      return {
        events: readRunEvents(subprocess, stderr, true),
        exited: subprocess.exited,
        pid: subprocess.pid,
        interrupt() {
          subprocess.kill();
        },
      };
    } catch (error) {
      if (isMissingCommand(error)) {
        throw new Error("找不到 Codex，请先安装并登录 Codex");
      }
      throw new Error("Codex 无法继续，请确认本机 Codex 安装和配置后重试");
    }
  }
}

function executionEnvironment(identity?: ExecutionIdentity): Record<string, string | undefined> {
  if (!identity) return process.env;
  if (identity.homeKind === "managed") {
    if (!identity.managedHomePath) throw new Error("Codex 账号目录不可用");
    return { ...process.env, CODEX_HOME: identity.managedHomePath };
  }
  return process.env;
}

async function* readRunEvents(
  subprocess: ReturnType<typeof Bun.spawn>,
  stderrResult: Promise<string>,
  resuming = false,
): AsyncGenerator<CodexRunEvent> {
  const decoder = new TextDecoder();
  let buffered = "";
  let receivedValidEvent = false;
  const diagnostics: string[] = [];

  for await (const chunk of subprocess.stdout) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      const parsed = parseJsonLine(line);
      if (parsed) {
        receivedValidEvent ||= parsed.valid;
        if (parsed.diagnostic) diagnostics.push(parsed.diagnostic);
        yield parsed.event;
      }
    }
  }

  buffered += decoder.decode();
  if (buffered.trim()) {
    const parsed = parseJsonLine(buffered);
    if (parsed) {
      receivedValidEvent ||= parsed.valid;
      if (parsed.diagnostic) diagnostics.push(parsed.diagnostic);
      yield parsed.event;
    }
  }

  const [exitCode, stderr] = await Promise.all([subprocess.exited, stderrResult]);
  if (exitCode === 0) {
    yield {
      type: "exit",
      exitCode,
      message: "Codex 已正常结束，等待结果处理",
    };
    return;
  }

  yield {
    type: "exit",
    exitCode,
    message: codexFailureMessage(stderr),
    resumeUnavailable:
      resuming &&
      !receivedValidEvent &&
      isUnavailableSessionFailure([stderr, ...diagnostics].join("\n")),
  };
}

type ParsedRunLine = {
  event: Exclude<CodexRunEvent, { type: "exit" }>;
  valid: boolean;
  diagnostic?: string;
};

function parseJsonLine(line: string): ParsedRunLine | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const payload = JSON.parse(trimmed) as Record<string, unknown>;
    const sessionId = stringValue(payload.thread_id) ?? stringValue(payload.session_id);
    if (sessionId) {
      return { event: { type: "session", sessionId }, valid: true };
    }

    const item = isRecord(payload.item) ? payload.item : null;
    const error = isRecord(payload.error) ? payload.error : null;
    const eventType = stringValue(payload.type);
    const message =
      stringValue(item?.text) ??
      stringValue(payload.message) ??
      stringValue(payload.text) ??
      stringValue(error?.message);
    if (message) {
      const diagnostic =
        error || eventType === "error" || eventType?.endsWith(".error")
          ? message
          : undefined;
      const report = parseStructuredReport(message);
      return {
        event: {
          type: "progress",
          message: diagnostic ? "Codex 报告运行错误" : report?.message ?? message,
          category: diagnostic ? "log" : report ? "report" : "message",
          ...(report ? { report: report.report } : {}),
        },
        valid: Boolean(item?.text) && !diagnostic,
        diagnostic,
      };
    }

    const tool = item ? toolProgress(item) : null;
    if (tool) {
      return {
        event: { type: "progress", ...tool },
        valid: true,
      };
    }

    return eventType
      ? {
          event: {
            type: "progress",
            message: readableEventType(eventType),
            category: "log",
          },
          valid: ["thread.started", "turn.started", "turn.completed"].includes(eventType),
        }
      : null;
  } catch {
    return {
      event: {
        type: "progress",
        message: "收到一条无法识别的 Codex 输出",
        category: "log",
      },
      valid: false,
      diagnostic: trimmed,
    };
  }
}

function codexFailureMessage(stderr: string): string {
  if (/login|log in|auth|unauthorized|401/i.test(stderr)) {
    return "Codex 运行失败，请确认已经登录后重试";
  }
  if (/permission|approval|sandbox|denied/i.test(stderr)) {
    return "Codex 需要当前配置未允许的权限，请处理后重试";
  }
  return "Codex 运行失败，请检查本机 Codex 配置后重试";
}

function buildExecutionPrompt(
  workOrder: WorkOrder,
  continuation?: ContinuationContext,
): string {
  const stages = workOrder.plan?.stages
    .filter((stage) => stage.executionMethod === "codex")
    .map(
      (stage, index) =>
        `${index + 1}. 节点：${stage.id}\n   目标结果：${stage.outcome}\n   前置节点：${stage.dependsOn.length ? stage.dependsOn.join("、") : "无"}\n   执行方式：${stage.executionMethod === "external" ? "外部工作" : "Codex AI 执行"}\n   工作空间：${stage.workspace.path || stage.workspace.kind}\n   影响范围：${stage.scope}\n   验证方式：${stage.verification}\n   自动验证命令：${stage.verificationCommand || "未配置"}\n   补充上下文：${stage.contextNotes?.length ? stage.contextNotes.join("；") : "无"}`,
    )
    .join("\n");
  const acceptance = workOrder.acceptance
    ? `\n完成要求：\n${workOrder.acceptance}`
    : "";
  const revision = workOrder.revisionNote
    ? `\n补充要求：\n${workOrder.revisionNote}`
    : "";
  const materials = workOrder.materials.length
    ? `\n参考素材：\n${workOrder.materials
        .map((material) => `- ${material.kind}: ${material.value}`)
        .join("\n")}`
    : "";

  const currentContext = continuation
    ? `\n\n这是从已中断现场启动的新执行。\n最近进展：\n${
        continuation.recentProgress.length
          ? continuation.recentProgress.map((message) => `- ${message}`).join("\n")
          : "暂无已保存进展"
      }\n\n当前工作空间状态：\n${continuation.gitStatus || "工作区干净"}${
        continuation.reexecuteStage
          ? `\n\n当前现场已恢复到最近完整检查点。只重新执行当前节点“${continuation.reexecuteStage.outcome}”（${continuation.reexecuteStage.id}），不要重做已经完成的节点。`
          : ""
      }`
    : "";
  const sessionHandoff = workOrder.sessionHandoff
    ? `\n\n这是确认切换 Codex 账号后的新会话，不要恢复旧线程。\n此前进展：${workOrder.sessionHandoff.summary || "暂无摘要"}\n当前节点：${workOrder.sessionHandoff.currentStageOutcome ?? "等待继续"}${
        workOrder.sessionHandoff.currentStageId
          ? `（${workOrder.sessionHandoff.currentStageId}）`
          : ""
      }`
    : "";

  const workspaceRule =
    workOrder.workspace?.kind === "directory"
      ? "请在用户明确选择的当前本地文件夹中完成以下已确认的工作目标。"
      : "请在当前独立 Git worktree 中完成以下已确认的工作目标。";
  return `${workspaceRule}不要修改工作区之外的文件。\n\n工作目标：\n${workOrder.goal}${acceptance}${revision}${materials}\n\n当前 AI 节点：\n${stages ?? "未提供"}\n\n只完成当前节点，不要开始计划中的其他节点；完成当前节点后退出。\n\n进展提示（可选，每条单独一行）：\n- TEAMLINE_STAGE_START:<节点 ID>\n- TEAMLINE_STAGE_COMPLETE:<节点 ID>\n- TEAMLINE_NEEDS_RESPONSE:<需要用户补充的内容>\n- TEAMLINE_SUGGEST_STAGE:<建议增加的节点>\n这些提示只用于展示；Teamline 仍会根据实际启动、退出和验证结果决定节点状态，新增节点也需要用户确认。${sessionHandoff}${currentContext}`;
}

export function buildResumePrompt(workOrder: WorkOrder): string {
  const stage = workOrder.plan?.stages.find(
    (candidate) =>
      candidate.executionMethod === "codex" &&
      (candidate.status === "running" || candidate.status === "response"),
  ) ?? workOrder.plan?.stages.find(
    (candidate) => candidate.executionMethod === "codex",
  );
  const revision = workOrder.revisionNote
    ? `\n补充要求：\n${workOrder.revisionNote}`
    : "";
  const materials = workOrder.materials.length
    ? `\n参考素材：\n${workOrder.materials
        .map((material) => `- ${material.kind}: ${material.value}`)
        .join("\n")}`
    : "";
  const stageContext = stage
    ? `\n\n当前 AI 节点：\n节点：${stage.id}\n目标结果：${stage.outcome}\n影响范围：${stage.scope}\n验证方式：${stage.verification}\n补充上下文：${stage.contextNotes?.length ? stage.contextNotes.join("；") : "无"}`
    : "";
  return `请继续推进已确认的工作目标：${workOrder.goal}${revision}${materials}${stageContext}\n\n只完成当前节点，不要开始计划中的其他节点；完成当前节点后退出。需要时可单独输出 TEAMLINE_STAGE_START:<节点 ID>、TEAMLINE_STAGE_COMPLETE:<节点 ID>、TEAMLINE_NEEDS_RESPONSE:<内容> 或 TEAMLINE_SUGGEST_STAGE:<建议>。这些提示只用于展示，不决定节点状态。`;
}

function readableEventType(type: string): string {
  if (type === "turn.started") {
    return "Codex 正在处理目标";
  }
  if (type === "turn.completed") {
    return "Codex 已完成本轮处理";
  }
  return `Codex 进展：${type}`;
}

function toolProgress(item: Record<string, unknown>): {
  message: string;
  category: "tool";
  detail?: string;
} | null {
  const type = stringValue(item.type);
  if (!type || !/(command|tool|file_change|web_search)/i.test(type)) return null;
  const command = stringValue(item.command);
  const name = stringValue(item.name) ?? stringValue(item.tool_name);
  const label = command
    ? `运行命令：${truncateDetail(command, 160)}`
    : type === "file_change"
      ? "修改文件"
      : `调用工具：${name ?? readableToolType(type)}`;
  const detailParts = [
    stringValue(item.aggregated_output),
    stringValue(item.output),
    stringValue(item.result),
  ].filter((value): value is string => Boolean(value));
  return {
    message: label,
    category: "tool",
    ...(detailParts.length ? { detail: truncateDetail(detailParts.join("\n")) } : {}),
  };
}

function readableToolType(type: string): string {
  return type.replaceAll("_", " ");
}

function parseStructuredReport(message: string): {
  message: string;
  report: {
    kind: "stage_start" | "stage_complete" | "needs_response" | "suggest_stage";
    stageId?: string;
  };
} | null {
  const stage = message.match(/(?:^|\n)\s*`?TEAMLINE_STAGE_(START|COMPLETE):([^\s`]+)`?/i);
  if (stage) {
    const kind = stage[1]?.toUpperCase() === "START" ? "stage_start" : "stage_complete";
    return {
      message: kind === "stage_start" ? "Codex 报告节点已开始" : "Codex 报告节点已完成",
      report: { kind, stageId: stage[2] },
    };
  }
  const response = message.match(/(?:^|\n)\s*`?TEAMLINE_NEEDS_RESPONSE:(.+?)`?(?:\n|$)/i);
  if (response) {
    return {
      message: response[1]?.trim() || "Codex 需要补充信息",
      report: { kind: "needs_response" },
    };
  }
  const suggestion = message.match(/(?:^|\n)\s*`?TEAMLINE_SUGGEST_STAGE:(.+?)`?(?:\n|$)/i);
  if (suggestion) {
    return {
      message: suggestion[1]?.trim() || "Codex 建议增加节点",
      report: { kind: "suggest_stage" },
    };
  }
  return null;
}

function truncateDetail(value: string, limit = 2_000): string {
  const normalized = value
    .trim()
    .replace(/\b(bearer)\s+[^\s]+/gi, "$1 [已隐藏]")
    .replace(/\b(secret|token|password|authorization|api[_-]?key)(\s*[:=]\s*|\s+)[^\s]+/gi, "$1$2[已隐藏]");
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingCommand(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("ENOENT") || error.message.includes("not found"))
  );
}

function isUnavailableSessionFailure(output: string): boolean {
  if (
    /login|log in|auth|unauthorized|401|permission|approval|sandbox|denied|config|toml|network|timeout|rate.?limit|quota|model|provider/i.test(
      output,
    )
  ) {
    return false;
  }
  return (
    /(?:session|thread|conversation).{0,100}(?:not found|does not exist|unavailable|cannot be resumed|can't be resumed|unable to resume)/i.test(
      output,
    ) ||
    /(?:not found|does not exist|unavailable|cannot resume|unable to resume).{0,100}(?:session|thread|conversation)/i.test(
      output,
    )
  );
}
