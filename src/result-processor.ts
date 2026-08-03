import type {
  VerificationResult,
  WorkOrder,
  WorkOrderResult,
} from "./work-order";

const maximumOutputLength = 4_000;

export interface WorkOrderResultProcessor {
  process(workOrder: WorkOrder): Promise<WorkOrderResult>;
}

export class LocalWorkOrderResultProcessor implements WorkOrderResultProcessor {
  async process(workOrder: WorkOrder): Promise<WorkOrderResult> {
    if (!workOrder.worktreePath || !workOrder.plan) {
      throw new Error("缺少委托工作区或已确认计划");
    }
    if (workOrder.workspace?.kind === "git" && !workOrder.baseCommit) {
      throw new Error("Git 委托缺少起始提交");
    }

    const verifications: VerificationResult[] = [];
    for (const stage of workOrder.plan.stages.filter(
      (candidate) => candidate.executionMethod === "codex",
    )) {
      const command = stage.verificationCommand?.trim();
      if (!command) {
        verifications.push({
          stageId: stage.id,
          stageOutcome: stage.outcome,
          command: null,
          status: "not_configured",
          exitCode: null,
          output: "未配置自动验证命令",
        });
        continue;
      }

      const subprocess = Bun.spawn(["/bin/sh", "-c", command], {
        cwd: workOrder.worktreePath,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        subprocess.exited,
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
      ]);
      verifications.push({
        stageId: stage.id,
        stageOutcome: stage.outcome,
        command,
        status: exitCode === 0 ? "passed" : "failed",
        exitCode,
        output: briefOutput(stdout, stderr),
      });
    }

    const git =
      workOrder.workspace?.kind === "directory"
        ? {
            diffStat: "普通文件夹不提供 Git 变化统计",
            statusShort: "结果保留在所选本地文件夹中",
          }
        : await gitSummary(workOrder.worktreePath, workOrder.baseCommit!);

    return {
      planVersion: workOrder.plan.version,
      git,
      verifications,
      completedAt: new Date().toISOString(),
    };
  }
}

async function gitSummary(
  repositoryPath: string,
  baseCommit: string,
): Promise<WorkOrderResult["git"]> {
  const [diffStat, statusShort] = await Promise.all([
    runGit(repositoryPath, "diff", "--stat", baseCommit, "--"),
    runGit(repositoryPath, "status", "--short"),
  ]);
  return {
    diffStat: diffStat || "无已跟踪文件变化",
    statusShort: statusShort || "工作区无变化",
  };
}

async function runGit(repositoryPath: string, ...args: string[]): Promise<string> {
  const subprocess = Bun.spawn(["git", "-C", repositoryPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  if (exitCode !== 0) {
    const diagnostic = stderr.trim();
    throw new Error(diagnostic || "无法读取 Git 变化摘要");
  }
  return stdout.trimEnd();
}

function briefOutput(stdout: string, stderr: string): string {
  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  if (!output) return "（无输出）";
  if (output.length <= maximumOutputLength) return output;
  return `${output.slice(0, maximumOutputLength)}\n…（输出已截断）`;
}
