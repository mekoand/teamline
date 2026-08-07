import type {
  PlanReference,
  VerificationResult,
  WorkOrder,
  WorkOrderResult,
} from "./work-order";
import { existsSync, realpathSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { gitArtifactPaths } from "../public/result-artifacts.js";

const maximumOutputLength = 4_000;

export interface WorkOrderResultProcessor {
  process(workOrder: WorkOrder): Promise<WorkOrderResult>;
}

export class LocalWorkOrderResultProcessor implements WorkOrderResultProcessor {
  async process(workOrder: WorkOrder): Promise<WorkOrderResult> {
    if (!workOrder.worktreePath || !workOrder.plan) {
      throw new Error("缺少执行工作区或已确认计划");
    }
    if (workOrder.workspace?.kind === "git" && !workOrder.baseCommit) {
      throw new Error("Git 目标缺少起始提交");
    }

    const directoryArtifacts = workOrder.workspace?.kind === "directory"
      ? await directoryArtifactReferences(workOrder)
      : [];
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
    const artifacts = workOrder.workspace?.kind === "directory"
      ? directoryArtifacts
      : gitResultArtifactReferences(workOrder, git.statusShort);

    return {
      planVersion: workOrder.plan.version,
      ...(artifacts.length ? { artifacts } : {}),
      git,
      verifications,
      completedAt: new Date().toISOString(),
    };
  }
}

function gitResultArtifactReferences(
  workOrder: WorkOrder,
  statusShort: string,
): PlanReference[] {
  if (!workOrder.worktreePath) return [];
  let root: string;
  try {
    root = realpathSync(workOrder.worktreePath);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const discovered = gitArtifactPaths(statusShort).flatMap((path, index) => {
    try {
      const artifactPath = realpathSync(join(root, path));
      const childPath = relative(root, artifactPath);
      if (
        !childPath ||
        childPath === ".." ||
        childPath.startsWith(`..${sep}`) ||
        isAbsolute(childPath) ||
        !existsSync(artifactPath) ||
        !statSync(artifactPath).isFile() ||
        seen.has(artifactPath)
      ) {
        return [];
      }
      seen.add(artifactPath);
      return [{
        id: `git-result:${index}:${path}`,
        type: "file" as const,
        label: basename(path),
        location: artifactPath,
      }];
    } catch {
      return [];
    }
  });
  return discovered.slice(0, maximumArtifacts);
}

const ignoredArtifactDirectories = new Set([
  ".git",
  ".teamline",
  ".venv",
  "__pycache__",
  "node_modules",
  "venv",
]);
const maximumArtifacts = 100;

async function directoryArtifactReferences(workOrder: WorkOrder): Promise<PlanReference[]> {
  if (
    workOrder.workspace?.kind !== "directory" ||
    !workOrder.worktreePath ||
    !workOrder.runStartedAt
  ) {
    return [];
  }
  const startedAt = Date.parse(workOrder.runStartedAt);
  if (!Number.isFinite(startedAt)) return [];

  const root = workOrder.worktreePath;
  const pending = [root];
  const artifacts: PlanReference[] = [];
  while (pending.length && artifacts.length < maximumArtifacts) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredArtifactDirectories.has(entry.name)) pending.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const metadata = await stat(path);
        if (metadata.mtimeMs < startedAt) continue;
      } catch {
        continue;
      }
      const label = relative(root, path);
      artifacts.push({
        id: `directory-result:${label}`,
        type: "file",
        label,
        location: path,
      });
      if (artifacts.length >= maximumArtifacts) break;
    }
  }
  return artifacts.sort((left, right) => left.label.localeCompare(right.label, "zh-CN"));
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
