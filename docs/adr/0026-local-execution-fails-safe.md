---
status: proposed
---

# Local Execution Uses Revocable and Fail-Safe Boundaries by Default

The local execution host has extensive permissions, so the first version must provide least privilege, secret redaction, a single execution lease, fencing of older processes, recovery positions bound to a commit or worktree fingerprint, and user-triggered pause and authorization revocation. Authorization has two steps. Plan generation only allows Codex to read the selected repository and send necessary context to the disclosed receiving service. Confirming the plan then authorizes an execution workspace, tool, network access, maximum run time, and rules for high-risk operations. Execution may continue within that scope; a request for new permissions causes Teamline to pause the goal and return the decision to a person. Budget and quota without reliable sources can only produce warnings, not hard-limit claims. If the control plane disconnects, the host cannot receive new authorization and may only continue within its existing scope to the next stable stopping point, then pause and create a pause savepoint. Emergency security rules may invalidate an old rule set and pause a goal but cannot silently replace it and resume execution. The local web interface listens only on loopback by default and requires an installation-level access credential. The technical specification validates the threat model, process fencing, and recovery mechanism.

---

## 中文

# 本地执行默认采用可撤销和失效安全的边界

本地执行端拥有高权限，因此第一版必须提供最小权限、秘密脱敏、单一执行租约、旧进程围栏、与提交或工作树指纹绑定的恢复位置，以及用户可随时触发的暂停与撤销授权。授权分为两步：生成计划只允许 Codex 只读访问所选仓库并向已披露的接收服务发送必要上下文，确认计划后才批准包含执行工作区、执行工具、网络权限、最长运行时间和高风险操作规则的执行授权。范围内可以持续执行，新增权限请求必须由 Teamline 暂停目标并重新交给人决定。缺少可靠来源的预算与额度只能提示风险，不能被宣称为硬限制。控制面失联时不能取得新授权，只能在既有边界内推进到下一个可停稳位置后暂停并创建暂停保存点；紧急安全规则可以让旧规则集失效并暂停目标，但不能静默替换后继续执行。本地网页默认只监听回环地址并要求安装级访问凭据，具体威胁模型、进程围栏与恢复机制在技术规格中验证。
