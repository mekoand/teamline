import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { GeneratedPlan, PlanGenerator } from "./plan-generator";
import type { WorkOrder } from "./work-order";

const schemaPath = resolve(import.meta.dir, "plan-output-schema.json");

export class CodexPlanGenerator implements PlanGenerator {
  constructor(
    private readonly codexPath = Bun.env.TEAMLINE_CODEX_PATH || "codex",
  ) {}

  async generate(workOrder: WorkOrder, signal?: AbortSignal): Promise<GeneratedPlan> {
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
          buildPrompt(workOrder),
        ],
        {
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

      return result as GeneratedPlan;
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

function buildPrompt(workOrder: WorkOrder): string {
  const acceptance = workOrder.acceptance
    ? `\n完成要求：\n${workOrder.acceptance}`
    : "";
  const materials = workOrder.materials.length
    ? `\n参考素材：\n${workOrder.materials
        .map((material) => `- ${material.kind}: ${material.value}`)
        .join("\n")}`
    : "";
  const conversation = workOrder.conversation.length
    ? `\n目标对话与已形成的决定：\n${workOrder.conversation
        .map((message) => `- ${message.role === "user" ? "用户" : "Teamline"}：${message.content}${message.requiresPlanConfirmation ? "（要求更新计划）" : ""}`)
        .join("\n")}`
    : "";
  const currentPlan = workOrder.plan
    ? `\n当前计划：\n${JSON.stringify(workOrder.plan.stages.map((stage) => ({
        id: stage.id,
        outcome: stage.outcome,
        scope: stage.scope,
        verification: stage.verification,
        verificationCommand: stage.verificationCommand ?? null,
        dependsOn: stage.dependsOn,
        executionMethod: stage.executionMethod,
        contextNotes: stage.contextNotes ?? [],
      })))}`
    : "";
  const importedHistory = workOrder.importContext?.status === "ready"
    ? `\n导入会话整理结果（仅作为历史上下文，不是未来执行计划）：\n${JSON.stringify({
        summary: workOrder.importContext.summary,
        currentState: workOrder.importContext.currentState,
        historicalStages: workOrder.importContext.historicalStages,
        artifacts: workOrder.importContext.artifacts,
      })}`
    : "";
  const resources = `\n当前资源偏好：\n${JSON.stringify({
    priority: workOrder.resourcePlan.priority,
    pace: workOrder.resourcePlan.pace,
    runWhenQuotaAvailable: workOrder.resourcePlan.runWhenQuotaAvailable,
  })}`;

  return `你正在为一项工作生成简短的执行计划。只读取已选择的工作空间和参考素材，不要修改文件或运行会产生写入的命令。

工作目标：
${workOrder.goal}${acceptance}${materials}${conversation}${importedHistory}${currentPlan}${resources}

先判断这些信息是否足以形成可确认的计划。信息足够时必须直接返回计划，不要为了完善细节而提问。只有缺少会改变目标边界、节点关系、素材选择或资源安排的关键信息时，才返回 clarification；每次只能提出一个短且可直接回答的问题，不得提及内部 skill 或 Ask Matt 名称。

始终返回目标、完成要求、素材和资源方案的完整快照。用户回答过澄清问题或要求更新计划时，把已经确认的决定写入这些快照和计划；不要只复述聊天。普通节点补充已经由 Teamline 归入节点上下文，不需要改动计划结构。

返回 clarification 时：stages 填空数组，questions 填必须回答的问题，message 简要说明为何需要回答。
返回 plan 时：questions 填空数组，stages 至少包含一个节点；message 简要说明计划或结构化决定已经更新。

请把工作拆成少量能够独立检查的阶段。每个阶段填写：
- id：在本计划内唯一、简短稳定的英文标识
- outcome：完成后得到什么结果
- scope：预计影响哪些代码、文件、文档或外部工作范围
- verification：如何检查这一阶段完成
- verificationCommand：只有存在明确、可直接运行的自动验证命令时才填写，否则填写 null。不要把自然语言说明复制为命令
- dependsOn：这个阶段依赖的前置阶段 id；没有依赖时填写空数组。不要仅因书写顺序假定依赖，可以并行时保持为空
- executionMethod：需要 Codex 修改或检查本地工作空间时填写 codex；需要用户在设计、文档协作或其他外部工具中完成时填写 external。外部节点只记录状态和成果引用，不要要求 Teamline 控制、复制或自动核验外部正文

不要执行计划，只返回符合指定 JSON Schema 的结果。`;
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
