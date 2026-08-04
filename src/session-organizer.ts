import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DiscoveredCodexSession } from "./codex-session-discovery";
import type { WorkOrderImportContext } from "./work-order";

export type SessionOrganization = {
  description: string;
  summary: string;
  currentState: string;
  historicalStages: WorkOrderImportContext["historicalStages"];
  artifacts: WorkOrderImportContext["artifacts"];
};

export type SessionOrganizationInput = {
  name: string;
  sessions: Array<DiscoveredCodexSession & { sourcePath: string }>;
};

export interface SessionOrganizer {
  organize(
    input: SessionOrganizationInput,
    signal?: AbortSignal,
  ): Promise<SessionOrganization>;
}

const schemaPath = resolve(import.meta.dir, "session-organization-schema.json");

export class CodexSessionOrganizer implements SessionOrganizer {
  constructor(private readonly codexPath = Bun.env.TEAMLINE_CODEX_PATH || "codex") {}

  async organize(
    input: SessionOrganizationInput,
    signal?: AbortSignal,
  ): Promise<SessionOrganization> {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "teamline-session-import-"));
    const outputPath = join(temporaryDirectory, "organization.json");
    let subprocess: ReturnType<typeof Bun.spawn> | undefined;
    const stop = () => {
      try {
        subprocess?.kill();
      } catch {
        // The process may already have exited.
      }
    };

    try {
      if (signal?.aborted) throw new Error("会话整理已停止");
      subprocess = Bun.spawn(
        [
          this.codexPath,
          "exec",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "--cd",
          temporaryDirectory,
          "--output-schema",
          schemaPath,
          "--output-last-message",
          outputPath,
          "--json",
          "--color",
          "never",
          "--ephemeral",
          buildPrompt(input),
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      signal?.addEventListener("abort", stop, { once: true });
      const [exitCode, stdout, stderr] = await Promise.all([
        subprocess.exited,
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
      ]);
      if (signal?.aborted) throw new Error("会话整理已停止");
      if (exitCode !== 0) {
        const diagnostic = lastCodexError(stdout) ?? lastUsefulLine(stderr);
        if (diagnostic) console.error("Codex session organization failed", diagnostic);
        throw new Error("Codex 暂时无法整理会话，请确认已经安装并登录后重试");
      }
      return JSON.parse(await Bun.file(outputPath).text()) as SessionOrganization;
    } catch (error) {
      if (error instanceof Error && error.message.includes("ENOENT")) {
        throw new Error("找不到 Codex，请先安装并登录 Codex");
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", stop);
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

function buildPrompt(input: SessionOrganizationInput): string {
  const sources = input.sessions.map((session) => ({
    id: session.id,
    title: session.title,
    workspacePath: session.workspacePath,
    lastActiveAt: session.lastActiveAt,
    sourcePath: session.sourcePath,
  }));
  return `你正在把一个或多个 Codex 历史会话整理成 Teamline 中的一个目标。只读取下面列出的本地 JSONL 会话文件，不要修改任何文件，不要继续执行原会话，也不要创建新的开发任务。

目标名称：${input.name}
来源会话：
${JSON.stringify(sources, null, 2)}

请完整读取每个来源文件，再返回：
- description：这个目标真正要得到的结果，适合作为后续生成计划的目标说明；
- summary：简短的历史摘要；
- currentState：现在已经做到哪里、还缺什么；
- historicalStages：经过整理的少量关键历史节点。它们只是历史，不是未来可执行计划；每个节点引用实际相关的来源会话 ID；
- artifacts：会话中明确出现的主要文件、文件夹、仓库、图片或链接。无法确认位置时不要猜。

不要复制大段原始对话或日志，不要把每次工具调用当成节点。多个来源有冲突时在摘要中如实说明。只返回符合 JSON Schema 的结果。`;
}

function lastUsefulLine(output: string): string {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? "";
}

function lastCodexError(output: string): string | null {
  for (const line of output.split(/\r?\n/).reverse()) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        message?: string;
        error?: { message?: string };
      };
      if (event.type !== "error" && event.type !== "turn.failed") continue;
      const message = event.error?.message ?? event.message;
      if (message) return lastUsefulLine(message);
    } catch {
      // Ignore non-JSON diagnostic lines.
    }
  }
  return null;
}
