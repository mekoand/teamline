import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DiscoveredSession } from "./session-discovery";
import type { WorkOrderImportContext, WorkOrderImportSource } from "./work-order";
import { codexProcessEnvironment } from "./codex-environment";

export type SessionOrganization = {
  description: string;
  summary: string;
  currentState: string;
  completedHighlights?: string[];
  nextAction?: string;
  historicalStages: WorkOrderImportContext["historicalStages"];
  artifacts: WorkOrderImportContext["artifacts"];
};

export type SessionOrganizationInput = {
  name: string;
  sourceLabel?: string;
  sourceKind?: WorkOrderImportSource["kind"];
  sessions: Array<DiscoveredSession & { sourcePath: string }>;
};

export interface SessionOrganizer {
  organize(
    input: SessionOrganizationInput,
    signal?: AbortSignal,
  ): Promise<SessionOrganization>;
}

const schemaPath = resolve(import.meta.dir, "session-organization-schema.json");
const organizationModel = "gpt-5.6-luna";

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
      const preparedInput = prepareOrganizationInput(input, temporaryDirectory);
      subprocess = Bun.spawn(
        [
          this.codexPath,
          "exec",
          "--model",
          organizationModel,
          "--config",
          "model_reasoning_effort=medium",
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
          buildSessionOrganizationPrompt(preparedInput),
        ],
        {
          env: codexProcessEnvironment(),
          stdout: "pipe",
          stderr: "pipe",
        },
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

function prepareOrganizationInput(
  input: SessionOrganizationInput,
  temporaryDirectory: string,
): SessionOrganizationInput {
  if (input.sourceKind !== "claude_code_session") return input;
  const sessions = input.sessions.map((session, index) => {
    const filteredPath = join(temporaryDirectory, `claude-code-source-${index + 1}.jsonl`);
    try {
      writeFileSync(
        filteredPath,
        filterClaudeCodeMainChain(readFileSync(session.sourcePath, "utf8")),
        "utf8",
      );
    } catch {
      throw new Error("Claude Code 来源会话当前不可读取，请刷新后重试");
    }
    return { ...session, sourcePath: filteredPath };
  });
  return { ...input, sessions };
}

export function filterClaudeCodeMainChain(input: string): string {
  const lines: string[] = [];
  for (const line of input.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.isSidechain === true) continue;
      lines.push(JSON.stringify(record));
    } catch {
      // Damaged JSONL records are not useful context and cannot be classified safely.
    }
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

export function buildSessionOrganizationPrompt(input: SessionOrganizationInput): string {
  const sources = input.sessions.map((session) => ({
    id: session.id,
    title: session.title,
    workspacePath: session.workspacePath,
    lastActiveAt: session.lastActiveAt,
    sourcePath: session.sourcePath,
  }));
  return `You are organizing one or more historical ${input.sourceLabel ?? "AI coding tool"} sessions into one Teamline goal. Read only the listed local JSONL files. Do not modify files, continue the original sessions, or create development tasks.

Goal name: ${input.name}
Source sessions:
${JSON.stringify(sources, null, 2)}

Infer the working language from the user's goal name and the dominant user language in the source conversations, never from Teamline's interface language. Write all newly generated user-visible fields in that working language. Preserve quoted or mixed-language source content, file names, commands, and URLs as written; do not translate imported history.

Read every source file fully, then return:
- description: one outcome-focused goal, without process history, current failures, or proposed solutions, at most 120 characters;
- summary: an internal historical summary for later planning, at most 240 characters;
- currentState: one line describing the current state, at most 100 characters;
- completedHighlights: up to three completed highlights, at most 80 characters each;
- nextAction: one line with the most appropriate next action, at most 100 characters;
- historicalStages: up to eight important historical nodes. Outcomes are at most 80 characters and summaries at most 120 characters. They are history, not a future executable plan, and each cites the relevant source session IDs;
- artifacts: major files, folders, repositories, images, or links explicitly present in the sessions. Do not guess locations.

Do not copy long passages of conversation or logs and do not turn every tool call into a node. Report conflicts between sources truthfully in the summary. Return only a result matching the JSON Schema.`;
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
