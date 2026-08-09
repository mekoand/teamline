import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { GeneratedPlan, PlanGenerationOptions, PlanGenerator } from "./plan-generator";
import type { WorkOrder } from "./work-order";
import { codexProcessEnvironment } from "./codex-environment";
import { workingLanguageInstruction } from "./working-language";

const schemaPath = resolve(import.meta.dir, "plan-output-schema.json");

export class CodexPlanGenerator implements PlanGenerator {
  constructor(
    private readonly codexPath = Bun.env.TEAMLINE_CODEX_PATH || "codex",
  ) {}

  async generate(
    workOrder: WorkOrder,
    signal?: AbortSignal,
    options: PlanGenerationOptions = {},
  ): Promise<GeneratedPlan> {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "teamline-plan-"));
    const outputPath = join(temporaryDirectory, "plan.json");
    let subprocess: ReturnType<typeof Bun.spawn> | undefined;
    const stop = () => {
      try {
        subprocess?.kill();
      } catch {
        // The process may already have exited.
      }
    };

    try {
      if (signal?.aborted) {
        throw new Error("生成计划已停止");
      }

      subprocess = Bun.spawn(
        [
          this.codexPath,
          "exec",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "--cd",
          workOrder.workspace?.path ?? temporaryDirectory,
          "--output-schema",
          schemaPath,
          "--output-last-message",
          outputPath,
          "--json",
          "--color",
          "never",
          "--ephemeral",
          "--model",
          "gpt-5.6-sol",
          "-c",
          `model_reasoning_effort=${options.reasoningEffort ?? "medium"}`,
          buildPlanPrompt(workOrder),
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

      if (signal?.aborted) {
        throw new Error("生成计划已停止");
      }

      if (exitCode !== 0) {
        const diagnostic = lastCodexError(stdout) ?? lastUsefulLine(stderr);
        if (diagnostic) {
          console.error("Codex plan process failed", diagnostic);
        }
        throw new Error("Codex 无法生成计划，请确认已经安装并登录后重试");
      }

      const result = JSON.parse(await Bun.file(outputPath).text()) as Partial<GeneratedPlan>;
      if (!Array.isArray(result.stages)) {
        throw new Error("Codex 返回的计划格式无法识别");
      }

      return workOrder.workspace
        ? result as GeneratedPlan
        : sanitizeWorkspaceFreePlan(
            result as GeneratedPlan,
            temporaryDirectory,
            workingLanguageInstruction(workOrder).includes("Simplified Chinese"),
          );
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

export function buildPlanPrompt(workOrder: WorkOrder): string {
  const acceptance = workOrder.acceptance
    ? `\nAcceptance criteria:\n${workOrder.acceptance}`
    : "";
  const materials = workOrder.materials.length
    ? `\nReference materials:\n${workOrder.materials
        .map((material) => `- ${material.kind}: ${material.value}`)
        .join("\n")}`
    : "";
  const conversation = workOrder.conversation.length
    ? `\nGoal conversation and confirmed decisions:\n${workOrder.conversation
        .map((message) => `- ${message.role === "user" ? "User" : "Teamline"}: ${message.content}${message.requiresPlanConfirmation ? " (plan update required)" : ""}`)
        .join("\n")}`
    : "";
  const currentPlan = workOrder.plan
    ? `\nCurrent plan:\n${JSON.stringify(workOrder.plan.stages.map((stage) => ({
        id: stage.id,
        outcome: stage.outcome,
        scope: stage.scope,
        verification: stage.verification,
        verificationCommand: stage.verificationCommand ?? null,
        dependsOn: stage.dependsOn,
        executionMethod: stage.executionMethod,
        contextNotes: stage.contextNotes ?? [],
        status: stage.status,
        statusReason: stage.statusReason,
        artifacts: stage.artifacts.map(({ type, label }) => ({ type, label })),
      })))}`
    : "";
  const previousResult = workOrder.result
    ? `\nCompact prior result (only for deciding remaining changes):\n${JSON.stringify({
        planVersion: workOrder.result.planVersion,
        git: {
          hasChanges: countGitChanges(workOrder.result.git.statusShort) > 0,
          changedEntryCount: countGitChanges(workOrder.result.git.statusShort),
        },
        verifications: workOrder.result.verifications.map(({ stageId, status }) => ({
          stageId,
          status,
        })),
      })}`
    : "";
  const importedHistory = workOrder.importContext?.status === "ready"
    ? `\nImported session organization (historical context, not a future plan):\n${JSON.stringify({
        summary: workOrder.importContext.summary,
        currentState: workOrder.importContext.currentState,
        completedHighlights: workOrder.importContext.completedHighlights,
        nextAction: workOrder.importContext.nextAction,
        historicalStages: workOrder.importContext.historicalStages,
        artifacts: workOrder.importContext.artifacts,
        monitoringContext: workOrder.importContext.monitoringContext ?? null,
      })}`
    : "";
  const resources = `\nCurrent resource preferences:\n${JSON.stringify({
    priority: workOrder.resourcePlan.priority,
    pace: workOrder.resourcePlan.pace,
    runWhenQuotaAvailable: workOrder.resourcePlan.runWhenQuotaAvailable,
  })}`;

  return `You are generating a concise execution plan for a delegated goal. Read only the selected workspace and reference materials. Do not modify files or run commands that write to disk.

Language contract:
${workingLanguageInstruction(workOrder)}

Goal:
${workOrder.goal}${acceptance}${materials}${conversation}${importedHistory}${currentPlan}${previousResult}${resources}

First decide whether the information is sufficient for a confirmable plan. When it is sufficient, return a plan directly. Do not ask questions merely to improve detail. Return clarification only when information is missing that would change the goal boundary, node relationships, material selection, or resource arrangement. Ask at most one short, directly answerable question at a time. Never mention internal skills or the name Ask Matt.

Always return a complete snapshot of the goal, acceptance criteria, materials, and resource plan. Incorporate confirmed decisions into those snapshots and the plan; do not merely repeat the conversation. Ordinary node supplements are already attached to node context and do not require structural plan changes.

If a compact prior result is provided, it represents existing outcomes and verification state. Plan only the remaining or changed work and do not repeat unaffected completed work.

If imported session organization includes monitoringContext, use its frozen aggregate summary, current state, next action, source keys, artifacts, and activity references as creation-time evidence. When focusNodeId and focusNode are present, treat that node as the explicit continuation boundary and carry its outcome, summary, status, and source scope into the plan; do not silently replace it with a later live refresh.

For clarification: return an empty stages array, put the required question in questions, and briefly explain why it is needed in message.
For a plan: return an empty questions array, at least one stage, and briefly state in message that the plan or structured decision was updated.

Split the work into a small number of independently verifiable stages. Without a selected workspace, use a relative scope or say that the execution workspace will be selected before start; never place the temporary planning directory in scope. Each stage must include:
- id: a short, stable English identifier unique within the plan
- outcome: the result produced by the stage
- scope: affected code, files, documentation, or external work
- verification: how completion is checked
- verificationCommand: an explicit directly runnable automatic check, or null; never copy natural-language verification into this field
- dependsOn: prerequisite stage IDs, or an empty array; do not infer dependencies from list order
- executionMethod: codex when Codex must change or inspect the local workspace, external when the user must work in another tool. External nodes track status and result references only; Teamline does not control, copy, or automatically verify their content

Do not execute the plan. Return only a result matching the supplied JSON Schema.`;
}

function sanitizeWorkspaceFreePlan(
  plan: GeneratedPlan,
  temporaryDirectory: string,
  useChinese: boolean,
): GeneratedPlan {
  const planningDirectories = new Set([temporaryDirectory]);
  try {
    planningDirectories.add(realpathSync(temporaryDirectory));
  } catch {
    // The original path is still enough when the platform has no path aliases.
  }

  return {
    ...plan,
    stages: plan.stages.map((stage) => ({
      ...stage,
      scope: removePlanningDirectory(stage.scope, planningDirectories, useChinese),
    })),
  };
}

function removePlanningDirectory(
  scope: string,
  planningDirectories: Set<string>,
  useChinese: boolean,
): string {
  let normalized = scope;
  for (const directory of [...planningDirectories].sort(
    (left, right) => right.length - left.length,
  )) {
    normalized = normalized.replaceAll(`${directory}/`, "");
    normalized = normalized.replaceAll(
      directory,
      useChinese ? "启动前选择的执行工作区" : "execution workspace selected before start",
    );
  }
  return normalized.trim() || (useChinese
    ? "启动前选择执行工作区"
    : "Select the execution workspace before start");
}

function countGitChanges(statusShort: string): number {
  return statusShort
    .split(/\r?\n/)
    .filter((line) => isGitStatusEntry(line))
    .length;
}

function isGitStatusEntry(line: string): boolean {
  if (line.length < 4 || line[2] !== " ") return false;

  const indexStatus = line[0];
  const worktreeStatus = line[1];
  if (indexStatus === "!" && worktreeStatus === "!") return false;
  if (indexStatus === "?" || worktreeStatus === "?") {
    return indexStatus === "?" && worktreeStatus === "?";
  }

  const validStatus = " MADRCU";
  return validStatus.includes(indexStatus) && validStatus.includes(worktreeStatus)
    && (indexStatus !== " " || worktreeStatus !== " ");
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
