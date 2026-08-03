import type { WorkOrder } from "./work-order";

export type CodexRunEvent =
  | { type: "session"; sessionId: string }
  | { type: "progress"; message: string }
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
    continuation?: ContinuationContext;
  }): Promise<StartedCodexRun>;
  resume(input: {
    workOrder: WorkOrder;
    workspacePath: string;
    sessionId: string;
  }): Promise<StartedCodexRun>;
}

export class CodexExecutionRunner implements CodexRunner {
  constructor(private readonly commandPath = Bun.env.TEAMLINE_CODEX_PATH || "codex") {}

  async start(input: {
    workOrder: WorkOrder;
    workspacePath: string;
    continuation?: ContinuationContext;
  }): Promise<StartedCodexRun> {
    try {
      const subprocess = Bun.spawn(
        [
          this.commandPath,
          "exec",
          "--cd",
          input.workspacePath,
          "--json",
          "--color",
          "never",
          buildExecutionPrompt(input.workOrder, input.continuation),
        ],
        {
          cwd: input.workspacePath,
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
  }): Promise<StartedCodexRun> {
    try {
      const subprocess = Bun.spawn(
        [
          this.commandPath,
          "exec",
          "resume",
          input.sessionId,
          buildResumePrompt(input.workOrder),
          "--json",
        ],
        {
          cwd: input.workspacePath,
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
      return {
        event: {
          type: "progress",
          message: diagnostic ? "Codex 报告运行错误" : message,
        },
        valid: Boolean(item?.text) && !diagnostic,
        diagnostic,
      };
    }

    return eventType
      ? {
          event: { type: "progress", message: readableEventType(eventType) },
          valid: ["thread.started", "turn.started", "turn.completed"].includes(eventType),
        }
      : null;
  } catch {
    return {
      event: {
        type: "progress",
        message: "收到一条无法识别的 Codex 输出",
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
    .map(
      (stage, index) =>
        `${index + 1}. 节点：${stage.id}\n   目标结果：${stage.outcome}\n   前置节点：${stage.dependsOn.length ? stage.dependsOn.join("、") : "无"}\n   执行方式：${stage.executionMethod === "external" ? "外部工作" : "Codex AI 执行"}\n   工作空间：${stage.workspace.path || stage.workspace.kind}\n   影响范围：${stage.scope}\n   验证方式：${stage.verification}\n   自动验证命令：${stage.verificationCommand || "未配置"}`,
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

  const workspaceRule =
    workOrder.workspace?.kind === "directory"
      ? "请在用户明确选择的当前本地文件夹中完成以下已确认的工作委托。"
      : "请在当前独立 Git worktree 中完成以下已确认的工作委托。";
  return `${workspaceRule}不要修改工作区之外的文件。\n\n工作目标：\n${workOrder.goal}${acceptance}${revision}${materials}\n\n已确认计划：\n${stages ?? "未提供"}${currentContext}`;
}

function buildResumePrompt(workOrder: WorkOrder): string {
  const revision = workOrder.revisionNote
    ? `\n补充要求：\n${workOrder.revisionNote}`
    : "";
  return `请继续推进已确认的工作委托：${workOrder.goal}${revision}`;
}

function readableEventType(type: string): string {
  if (type === "turn.started") {
    return "Codex 正在处理委托";
  }
  if (type === "turn.completed") {
    return "Codex 已完成本轮处理";
  }
  return `Codex 进展：${type}`;
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
