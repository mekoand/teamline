# Managed Goals Use Isolated Git Worktrees

Every managed goal creates a Teamline-owned Git worktree and execution branch from the repository and baseline branch selected by the user instead of using the developer's current working directory. If the personal kernel cannot create or validate an independent worktree, it refuses to start managed execution. This provides stable checkpoints and an explicit execution lease, while allowing future parallel goals without replacing the underlying isolation model. A worktree isolates Git working state only. It is not a filesystem, credential, network, or subprocess sandbox; validated tool and host capabilities must provide those boundaries.

---

## 中文

# 受控目标使用独立 Git worktree

每项受控目标都从用户选择的仓库和基线分支创建一个由 Teamline 独占管理的 Git worktree 与执行分支，不直接使用开发者当前打开的工作目录。个人内核无法创建或验证独立 worktree 时拒绝启动受控执行，以换取稳定的检查点、明确的执行租约以及未来并行目标不需要重建底层隔离模型。worktree 只隔离 Git 工作状态，不构成文件系统、凭据、网络或子进程安全沙箱；这些边界必须由经过验证的执行工具与主机能力承担。
