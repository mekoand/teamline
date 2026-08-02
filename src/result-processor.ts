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
    if (!workOrder.worktreePath || !workOrder.baseCommit || !workOrder.plan) {
      throw new Error("缺少委托工作区、起始提交或已确认计划");
    }

    const verifications: VerificationResult[] = [];
    for (const stage of workOrder.plan.stages) {
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

    const [diffStat, statusShort] = await Promise.all([
      runGit(workOrder.worktreePath, "diff", "--stat", workOrder.baseCommit, "--"),
      runGit(workOrder.worktreePath, "status", "--short"),
    ]);

    return {
      planVersion: workOrder.plan.version,
      git: {
        diffStat: diffStat || "无已跟踪文件变化",
        statusShort: statusShort || "工作区无变化",
      },
      verifications,
      completedAt: new Date().toISOString(),
    };
  }
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
