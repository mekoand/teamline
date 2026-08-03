import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CheckpointManager {
  capture(workspacePath: string, reference: string): Promise<string>;
  describe(
    workspacePath: string,
    treeHash: string,
  ): Promise<{ diffStat: string; statusShort: string }>;
  restore(
    workspacePath: string,
    treeHash: string,
    residueReference: string,
  ): Promise<{ residueTreeHash: string }>;
}

export class GitCheckpointManager implements CheckpointManager {
  async capture(workspacePath: string, reference: string): Promise<string> {
    assertReference(reference);
    const directory = mkdtempSync(join(tmpdir(), "teamline-checkpoint-"));
    const indexPath = join(directory, "index");
    const environment = { ...process.env, GIT_INDEX_FILE: indexPath };

    try {
      await runGit(workspacePath, ["read-tree", "HEAD"], environment);
      await runGit(workspacePath, ["add", "-A", "--", "."], environment);
      const treeHash = await runGit(workspacePath, ["write-tree"], environment);
      await runGit(workspacePath, ["update-ref", reference, treeHash]);
      return treeHash;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  async describe(
    workspacePath: string,
    treeHash: string,
  ): Promise<{ diffStat: string; statusShort: string }> {
    const directory = mkdtempSync(join(tmpdir(), "teamline-checkpoint-status-"));
    const indexPath = join(directory, "index");
    const environment = { ...process.env, GIT_INDEX_FILE: indexPath };
    try {
      await runGit(workspacePath, ["read-tree", treeHash], environment);
      await runGit(workspacePath, ["add", "-A", "--", "."], environment);
      const [diffStat, statusShort] = await Promise.all([
        runGit(
          workspacePath,
          ["diff", "--cached", "--stat", treeHash, "--"],
          environment,
        ),
        runGit(
          workspacePath,
          ["diff", "--cached", "--name-status", treeHash, "--"],
          environment,
        ),
      ]);
      return {
        diffStat: diffStat || "现场与最近完整位置一致",
        statusShort: statusShort || "现场与最近完整位置一致",
      };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  async restore(
    workspacePath: string,
    treeHash: string,
    residueReference: string,
  ): Promise<{ residueTreeHash: string }> {
    const residueTreeHash = await this.capture(workspacePath, residueReference);
    await runGit(workspacePath, ["cat-file", "-e", `${treeHash}^{tree}`]);
    await runGit(workspacePath, ["clean", "-fd", "--", "."]);
    await runGit(workspacePath, ["read-tree", "--reset", "-u", treeHash]);
    await runGit(workspacePath, ["reset", "--mixed", "HEAD"]);
    return { residueTreeHash };
  }
}

async function runGit(
  workspacePath: string,
  args: string[],
  env?: Record<string, string | undefined>,
): Promise<string> {
  const subprocess = Bun.spawn(["git", "-C", workspacePath, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || "无法保存或恢复 Git 检查点");
  }
  return stdout.trim();
}

function assertReference(reference: string): void {
  if (!/^refs\/teamline\/(checkpoints|residue)\/[a-zA-Z0-9._/-]+$/.test(reference)) {
    throw new Error("检查点引用无效");
  }
}
