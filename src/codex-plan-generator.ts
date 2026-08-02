import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { GeneratedPlan, PlanGenerator } from "./plan-generator";
import type { WorkOrder } from "./work-order";

const schemaPath = resolve(import.meta.dir, "plan-output-schema.json");

export class CodexPlanGenerator implements PlanGenerator {
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
          Bun.env.TEAMLINE_CODEX_PATH || "codex",
          "exec",
          "--sandbox",
          "read-only",
          "--cd",
          workOrder.repositoryPath,
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

      const [exitCode, , stderr] = await Promise.all([
        subprocess.exited,
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
      ]);

      if (signal?.aborted) {
        throw new Error("生成计划已停止");
      }

      if (exitCode !== 0) {
        const diagnostic = lastUsefulLine(stderr);
        if (diagnostic) {
          console.error("Codex plan process failed", diagnostic);
        }
        throw new Error("Codex 无法生成计划，请确认已经安装并登录后重试");
      }

      const result = JSON.parse(await Bun.file(outputPath).text()) as Partial<GeneratedPlan>;
      if (!Array.isArray(result.stages)) {
        throw new Error("Codex 返回的计划格式无法识别");
      }

      return { stages: result.stages };
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

  return `你正在为一项编码工作生成简短的委托计划。只读取仓库，不要修改文件或运行会产生写入的命令。

工作目标：
${workOrder.goal}${acceptance}

请把工作拆成少量能够独立检查的阶段。每个阶段只填写：
- outcome：完成后得到什么结果
- scope：预计影响哪些代码范围
- verification：如何检查这一阶段完成

不要执行计划，只返回符合指定 JSON Schema 的结果。`;
}

function lastUsefulLine(output: string): string {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? "";
}
