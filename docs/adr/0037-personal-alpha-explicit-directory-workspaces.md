# Personal Alpha Lets Users Select Regular Directories Explicitly

Personal Alpha separates reference materials from the execution workspace. Repositories, folders, files, images, and links may be saved as materials only and never receive execution permission automatically. A goal without a workspace can generate and confirm a plan, but the user must select a local directory explicitly before execution begins.

For regular-directory execution in Personal Alpha, this decision partially supersedes ADR-0028. When a user selects a Git repository, Teamline still creates and uses a separate Git worktree. When a user selects a regular directory, Codex runs directly in that directory without Git worktree isolation, version history, or a Git rollback guarantee. The result view must make this difference clear.

Regular-directory execution is a convenience path, not an expansion of reliable recovery promises for managed Git goals. Teamline checks the directory type, read, write and entry permissions, and current use before starting or continuing, but the user remains responsible for versioning and rollback of the directory contents.

---

## 中文

# 个人 Alpha 允许用户显式选择普通目录

个人 Alpha 将参考素材与执行工作空间分开。仓库、文件夹、文件、图片和链接都只能作为素材保存，不会自动取得执行权限；没有工作空间的目标可以先生成和确认计划，但启动前必须由用户显式选择一个本地目录。

本决定仅在个人 Alpha 的普通目录路径上部分取代 ADR-0028。用户选择 Git 仓库时，Teamline 仍创建并使用独立 Git worktree；用户选择普通目录时，Codex 直接在该目录中执行，不提供 Git worktree 隔离、版本记录或 Git 回滚保证，结果页也必须明确这一差异。

普通目录执行是便利路径，不扩大为受控 Git 目标的可靠恢复承诺。Teamline 会在启动与继续前检查目录类型、读写和进入权限及当前占用，但目录内容的版本管理与回滚仍由用户自行承担。
