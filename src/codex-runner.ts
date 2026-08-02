import type { WorkOrder } from "./work-order";

export type CodexRunEvent =
  | { type: "session"; sessionId: string }
  | { type: "progress"; message: string }
  | { type: "exit"; exitCode: number; message: string };

export type StartedCodexRun = {
  events: AsyncIterable<CodexRunEvent>;
};

export interface CodexRunner {
  start(input: {
    workOrder: WorkOrder;
    workspacePath: string;
  }): Promise<StartedCodexRun>;
}

export class CodexExecutionRunner implements CodexRunner {
  constructor(private readonly commandPath = Bun.env.TEAMLINE_CODEX_PATH || "codex") {}

  async start(input: {
    workOrder: WorkOrder;
    workspacePath: string;
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
          buildExecutionPrompt(input.workOrder),
        ],
        {
          cwd: input.workspacePath,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const stderr = new Response(subprocess.stderr).text();
      return { events: readRunEvents(subprocess, stderr) };
    } catch (error) {
      if (isMissingCommand(error)) {
        throw new Error("找不到 Codex，请先安装并登录 Codex");
      }
      throw new Error("Codex 无法启动，请确认本机 Codex 安装和配置后重试");
    }
  }
}

async function* readRunEvents(
  subprocess: ReturnType<typeof Bun.spawn>,
  stderrResult: Promise<string>,
): AsyncGenerator<CodexRunEvent> {
  const decoder = new TextDecoder();
  let buffered = "";

  for await (const chunk of subprocess.stdout) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseJsonLine(line);
      if (event) {
        yield event;
      }
    }
  }

  buffered += decoder.decode();
  if (buffered.trim()) {
    const event = parseJsonLine(buffered);
    if (event) {
      yield event;
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
  };
}

function parseJsonLine(line: string): CodexRunEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const payload = JSON.parse(trimmed) as Record<string, unknown>;
    const sessionId = stringValue(payload.thread_id) ?? stringValue(payload.session_id);
    if (sessionId) {
      return { type: "session", sessionId };
    }

    const item = isRecord(payload.item) ? payload.item : null;
    const error = isRecord(payload.error) ? payload.error : null;
    const message =
      stringValue(item?.text) ??
      stringValue(payload.message) ??
      stringValue(payload.text) ??
      stringValue(error?.message);
    if (message) {
      return { type: "progress", message };
    }

    const eventType = stringValue(payload.type);
    return eventType
      ? { type: "progress", message: readableEventType(eventType) }
      : null;
  } catch {
    return {
      type: "progress",
      message: "收到一条无法识别的 Codex 输出",
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

function buildExecutionPrompt(workOrder: WorkOrder): string {
  const stages = workOrder.plan?.stages
    .map(
      (stage, index) =>
        `${index + 1}. 目标结果：${stage.outcome}\n   影响范围：${stage.scope}\n   验证方式：${stage.verification}`,
    )
    .join("\n");
  const acceptance = workOrder.acceptance
    ? `\n完成要求：\n${workOrder.acceptance}`
    : "";

  return `请在当前独立 Git worktree 中完成以下已确认的工作委托。不要修改工作区之外的文件。\n\n工作目标：\n${workOrder.goal}${acceptance}\n\n已确认计划：\n${stages ?? "未提供"}`;
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
