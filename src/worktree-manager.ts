import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { WorkOrder } from "./work-order";

export type DelegatedWorktree = {
  path: string;
  branch: string;
  baseCommit: string;
};

export interface WorktreeManager {
  prepare(workOrder: WorkOrder): Promise<DelegatedWorktree>;
}

export class GitWorktreeManager implements WorktreeManager {
  constructor(private readonly rootPath: string) {}

  async prepare(workOrder: WorkOrder): Promise<DelegatedWorktree> {
    try {
      mkdirSync(this.rootPath, { recursive: true });
      const branch = workOrder.executionBranch ?? `teamline/work-order-${workOrder.id}`;
      const path = workOrder.worktreePath ?? join(this.rootPath, workOrder.id);
      if (existsSync(path)) {
        return await inspectExistingWorktree(workOrder, path, branch);
      }
      const registered = findRegisteredWorktree(
        await runGit(workOrder.repositoryPath, "worktree", "list", "--porcelain"),
        path,
      );
      let reattachingMissingWorktree = false;

      if (registered) {
        assertExpectedWorktree(workOrder, branch, registered);
        if (existsSync(path)) {
          throw new Error("拒绝清理仍然存在的执行 worktree");
        }
        await runGit(workOrder.repositoryPath, "worktree", "remove", path);
        reattachingMissingWorktree = true;
      }

      const existingBranchHead = await tryRunGit(
        workOrder.repositoryPath,
        "rev-parse",
        "--verify",
        `refs/heads/${branch}`,
      );
      if (existingBranchHead) {
        if (workOrder.baseCommit && existingBranchHead !== workOrder.baseCommit) {
          throw new Error("目标分支基线已经变化");
        }
        await runGit(
          workOrder.repositoryPath,
          "worktree",
          "add",
          ...(reattachingMissingWorktree ? ["--force"] : []),
          path,
          branch,
        );
        return {
          path,
          branch,
          baseCommit: workOrder.baseCommit ?? existingBranchHead,
        };
      }

      const baseCommit =
        workOrder.baseCommit ??
        (await runGit(workOrder.repositoryPath, "rev-parse", "HEAD"));
      await runGit(
        workOrder.repositoryPath,
        "worktree",
        "add",
        "-b",
        branch,
        path,
        baseCommit,
      );

      return { path, branch, baseCommit };
    } catch {
      throw new Error("无法准备独立 Git worktree，请确认仓库和分支状态后重试");
    }
  }
}

async function inspectExistingWorktree(
  workOrder: WorkOrder,
  path: string,
  branch: string,
): Promise<DelegatedWorktree> {
  const [actualBranch, head, sourceCommonDirectory, worktreeCommonDirectory] =
    await Promise.all([
      runGit(path, "branch", "--show-current"),
      runGit(path, "rev-parse", "HEAD"),
      runGit(workOrder.repositoryPath, "rev-parse", "--git-common-dir"),
      runGit(path, "rev-parse", "--git-common-dir"),
    ]);
  const sourceCommonPath = realpathSync(
    resolve(workOrder.repositoryPath, sourceCommonDirectory),
  );
  const worktreeCommonPath = realpathSync(resolve(path, worktreeCommonDirectory));
  if (sourceCommonPath !== worktreeCommonPath || actualBranch !== branch) {
    throw new Error("执行 worktree 与仓库或分支不一致");
  }
  if (workOrder.baseCommit && head !== workOrder.baseCommit) {
    throw new Error("执行 worktree 基线与记录不一致");
  }
  return {
    path,
    branch,
    baseCommit: workOrder.baseCommit ?? head,
  };
}

type RegisteredWorktree = {
  path: string;
  head: string;
  branch: string | null;
};

function findRegisteredWorktree(
  output: string,
  expectedPath: string,
): RegisteredWorktree | null {
  const worktrees = output
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const fields = new Map(
        block
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const separator = line.indexOf(" ");
            return separator === -1
              ? [line, ""]
              : [line.slice(0, separator), line.slice(separator + 1)];
          }),
      );
      const path = fields.get("worktree");
      const head = fields.get("HEAD");
      if (!path || !head) {
        return null;
      }
      return {
        path,
        head,
        branch: fields.get("branch")?.replace(/^refs\/heads\//, "") ?? null,
      };
    })
    .filter((worktree): worktree is RegisteredWorktree => worktree !== null);

  return (
    worktrees.find(
      (worktree) => canonicalizePotentialPath(worktree.path) === canonicalizePotentialPath(expectedPath),
    ) ??
    null
  );
}

function canonicalizePotentialPath(path: string): string {
  let existingAncestor = resolve(path);
  const missingSegments: string[] = [];
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) {
      break;
    }
    missingSegments.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }
  return join(realpathSync(existingAncestor), ...missingSegments);
}

function assertExpectedWorktree(
  workOrder: WorkOrder,
  branch: string,
  registered: RegisteredWorktree,
): void {
  if (registered.branch !== branch) {
    throw new Error("执行 worktree 分支与记录不一致");
  }
  if (workOrder.baseCommit && registered.head !== workOrder.baseCommit) {
    throw new Error("执行 worktree 基线与记录不一致");
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
    const diagnostic = lastLine(stderr);
    throw new Error(
      diagnostic
        ? `无法创建独立 Git worktree：${diagnostic}`
        : "无法创建独立 Git worktree",
    );
  }
  return stdout.trim();
}

async function tryRunGit(repositoryPath: string, ...args: string[]): Promise<string | null> {
  try {
    return await runGit(repositoryPath, ...args);
  } catch {
    return null;
  }
}

function lastLine(output: string): string {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? "";
}
