# Tool Integrations Are Defined by Control Capabilities, Not by CLI

Teamline defines an execution-tool integration by capabilities such as selecting the execution workspace, owning the execution lifecycle, obtaining structured state, restoring context, and applying authorization boundaries. It is not tied to a specific interface such as a CLI, desktop app, or IDE. Before the formal specification is frozen, candidate Codex integration surfaces must be tested and each capability classified as able to block, able to detect, advisory only, or unsupported. An integration cannot be called managed execution if it cannot reliably pause and terminate a process tree, fence old execution, or intercept requests for new permissions. The selected surface may be a CLI, local protocol, official SDK or API, or extension interface, depending on which provides the most complete and stable control. A CLI may be a fallback; UI automation cannot masquerade as a deep integration. Claude Code, OpenCode, and representative Chinese AI coding tools are first evaluated with the same capability table rather than implemented deeply alongside Codex in personal kernel v0.

---

## 中文

# 工具接入按控制能力而不是 CLI 定义

Teamline 的执行工具接入以指定执行工作区、持有执行生命周期、取得结构化状态、恢复上下文和落实授权边界等能力定义，不与 CLI、桌面应用或 IDE 等具体界面绑定。正式规格冻结前必须验证 Codex 的候选接入面，并把每项能力标为可阻止、可检测、仅提示或不支持；暂停与终止进程树、执行围栏或新增权限拦截无法可靠实现时，该接入不能被称为受控执行。实际采用 CLI、本地协议、官方 SDK/API 或扩展接口，由验证选择控制能力最完整且稳定的接入面；CLI 可以作为降级路径，UI 自动化不能冒充深度接入。Claude Code、OpenCode 和代表性中国 AI 编码工具先使用同一能力表评估，不在个人内核 v0 同时深度实现。
