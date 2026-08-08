import type { WorkOrder } from "./work-order";
import type { ExecutionIdentity } from "./execution-identity";
import { codexProcessEnvironment } from "./codex-environment";
import { workingLanguageInstruction } from "./working-language";

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
      endState?:
        | "completed"
        | "transient_failure"
        | "needs_response"
        | "authentication_required"
        | "permission_required"
        | "failed";
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

export type CodexBillingMode = "subscription" | "paid_api";

export interface CodexRunner {
  start(input: {
    workOrder: WorkOrder;
    workspacePath: string;
    executionIdentity?: ExecutionIdentity;
    continuation?: ContinuationContext;
    billingMode?: CodexBillingMode;
  }): Promise<StartedCodexRun>;
  resume(input: {
    workOrder: WorkOrder;
    workspacePath: string;
    sessionId: string;
    executionIdentity?: ExecutionIdentity;
    billingMode?: CodexBillingMode;
  }): Promise<StartedCodexRun>;
  paidApiAvailable?(): boolean;
}

export class CodexExecutionRunner implements CodexRunner {
  constructor(
    private readonly commandPath = Bun.env.TEAMLINE_CODEX_PATH || "codex",
    private readonly paidApiKey = Bun.env.OPENAI_API_KEY || Bun.env.CODEX_API_KEY,
  ) {}

  paidApiAvailable(): boolean {
    return Boolean(this.paidApiKey);
  }

  async start(input: {
    workOrder: WorkOrder;
    workspacePath: string;
    executionIdentity?: ExecutionIdentity;
    continuation?: ContinuationContext;
    billingMode?: CodexBillingMode;
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
          env: executionEnvironment(
            input.executionIdentity,
            input.billingMode,
            this.paidApiKey,
          ),
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
    billingMode?: CodexBillingMode;
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
          env: executionEnvironment(
            input.executionIdentity,
            input.billingMode,
            this.paidApiKey,
          ),
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

function executionEnvironment(
  identity?: ExecutionIdentity,
  billingMode: CodexBillingMode = "subscription",
  paidApiKey?: string,
): Record<string, string | undefined> {
  if (billingMode === "paid_api" && !paidApiKey) {
    throw new Error("本机未提供付费 API 凭证");
  }
  const codexHome = identity?.homeKind === "managed"
    ? identity.managedHomePath
    : undefined;
  if (identity?.homeKind === "managed" && !codexHome) {
    throw new Error("Codex 账号目录不可用");
  }
  return codexProcessEnvironment({
    ...(codexHome ? { codexHome } : {}),
    ...(billingMode === "paid_api" && paidApiKey ? { apiKey: paidApiKey } : {}),
  });
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
      endState: "completed",
    };
    return;
  }

  const failureDetails = [stderr, ...diagnostics].join("\n");
  yield {
    type: "exit",
    exitCode,
    message: codexFailureMessage(stderr),
    endState: classifyFailureEndState(failureDetails),
    resumeUnavailable:
      resuming &&
      !receivedValidEvent &&
      isUnavailableSessionFailure(failureDetails),
  };
}

function classifyFailureEndState(
  details: string,
): Exclude<NonNullable<Extract<CodexRunEvent, { type: "exit" }>["endState"]>, "completed"> {
  const normalized = details.toLocaleLowerCase();
  if (/(?:unauthorized|authentication|not logged in|login required|\b401\b)/.test(normalized)) {
    return "authentication_required";
  }
  if (/(?:permission denied|operation not permitted|\b403\b)/.test(normalized)) {
    return "permission_required";
  }
  if (
    /(?:timed? out|timeout|connection (?:reset|closed|refused)|network error|temporarily unavailable|service unavailable|socket hang up|\beconn(?:reset|refused)\b)/
      .test(normalized)
  ) {
    return "transient_failure";
  }
  return "failed";
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

export function buildExecutionPrompt(
  workOrder: WorkOrder,
  continuation?: ContinuationContext,
): string {
  const stages = workOrder.plan?.stages
    .filter((stage) => stage.executionMethod === "codex")
    .map(
      (stage, index) =>
        `${index + 1}. Node: ${stage.id}\n   Outcome: ${stage.outcome}\n   Dependencies: ${stage.dependsOn.length ? stage.dependsOn.join(", ") : "none"}\n   Execution method: Codex AI\n   Workspace: ${stage.workspace.path || stage.workspace.kind}\n   Scope: ${stage.scope}\n   Verification: ${stage.verification}\n   Automatic verification command: ${stage.verificationCommand || "not configured"}\n   Additional context: ${stage.contextNotes?.length ? stage.contextNotes.join("; ") : "none"}`,
    )
    .join("\n");
  const acceptance = workOrder.acceptance
    ? `\nAcceptance criteria:\n${workOrder.acceptance}`
    : "";
  const revision = workOrder.revisionNote
    ? `\nAdditional requirement:\n${workOrder.revisionNote}`
    : "";
  const materials = workOrder.materials.length
    ? `\nReference materials:\n${workOrder.materials
        .map((material) => `- ${material.kind}: ${material.value}`)
        .join("\n")}`
    : "";

  const currentContext = continuation
    ? `\n\nThis is a new execution started from interrupted work.\nRecent progress:\n${
        continuation.recentProgress.length
          ? continuation.recentProgress.map((message) => `- ${message}`).join("\n")
          : "No saved progress"
      }\n\nCurrent workspace state:\n${continuation.gitStatus || "Workspace is clean"}${
        continuation.reexecuteStage
          ? `\n\nThe workspace was restored to the latest complete checkpoint. Re-execute only the current node "${continuation.reexecuteStage.outcome}" (${continuation.reexecuteStage.id}); do not redo completed nodes.`
          : ""
      }`
    : "";
  const sessionHandoff = workOrder.sessionHandoff
    ? `\n\nThis is a new session after a confirmed Codex account switch. Do not resume the old thread.\nPrior progress: ${workOrder.sessionHandoff.summary || "No summary"}\nCurrent node: ${workOrder.sessionHandoff.currentStageOutcome ?? "Waiting to continue"}${
        workOrder.sessionHandoff.currentStageId
          ? `（${workOrder.sessionHandoff.currentStageId}）`
          : ""
      }`
    : "";

  const workspaceRule =
    workOrder.workspace?.kind === "directory"
      ? "Complete the confirmed goal in the local directory explicitly selected by the user."
      : "Complete the confirmed goal in the current isolated Git worktree.";
  return `${workspaceRule} Do not modify files outside the workspace.\n\nLanguage contract:\n${workingLanguageInstruction(workOrder)}\n\nGoal:\n${workOrder.goal}${acceptance}${revision}${materials}\n\nCurrent AI node:\n${stages || "Not provided"}\n\nComplete only the current node. Do not start any other planned node, and exit when this node is complete.\n\nOptional progress markers, each on its own line:\n- TEAMLINE_STAGE_START:<node ID>\n- TEAMLINE_STAGE_COMPLETE:<node ID>\n- TEAMLINE_NEEDS_RESPONSE:<what the user must provide>\n- TEAMLINE_SUGGEST_STAGE:<suggested node>\nThese markers are display hints only. Teamline determines node state from actual start, exit, and verification evidence; a proposed node also requires user confirmation.${sessionHandoff}${currentContext}`;
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
    ? `\nAdditional requirement:\n${workOrder.revisionNote}`
    : "";
  const materials = workOrder.materials.length
    ? `\nReference materials:\n${workOrder.materials
        .map((material) => `- ${material.kind}: ${material.value}`)
        .join("\n")}`
    : "";
  const stageContext = stage
    ? `\n\nCurrent AI node:\nNode: ${stage.id}\nOutcome: ${stage.outcome}\nScope: ${stage.scope}\nVerification: ${stage.verification}\nAdditional context: ${stage.contextNotes?.length ? stage.contextNotes.join("; ") : "none"}`
    : "";
  return `Continue the confirmed goal: ${workOrder.goal}${revision}${materials}${stageContext}\n\nLanguage contract:\n${workingLanguageInstruction(workOrder)}\n\nComplete only the current node. Do not start another planned node, and exit when this node is complete. When useful, output TEAMLINE_STAGE_START:<node ID>, TEAMLINE_STAGE_COMPLETE:<node ID>, TEAMLINE_NEEDS_RESPONSE:<content>, or TEAMLINE_SUGGEST_STAGE:<suggestion> on a line by itself. These are display hints and do not determine node state.`;
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
