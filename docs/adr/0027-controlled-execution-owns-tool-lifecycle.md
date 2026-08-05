# Managed Execution Owns the Tool Lifecycle

Teamline may call work managed execution only when it starts or resumes the tool under a confirmed plan and authorization boundary and continues to own pause, termination, fencing, and recovery. An expired execution lease does not prove that the old process has stopped. Teamline must not issue a new lease or start new managed execution until it confirms that the old process tree can no longer write. A tool process discovered after an external manual start may be observed and displayed, but remains marked as unmanaged because attaching afterward cannot establish the integrity of its original authorization, rule set, or checkpoints.

---

## 中文

# 受控执行由 Teamline 启动并持有工具生命周期

Teamline 只有在已确认计划和授权边界下启动或恢复执行工具，并持续拥有暂停、终止、围栏与恢复能力时，才能把一项工作声明为受控执行。执行租约失效不证明旧进程已经停止；未确认旧进程树不能继续写入前，不得签发新租约或启动新的受控执行。外部手动启动后才被发现的工具进程可以被观察和展示，但仍标记为非受控执行，因为事后接入无法证明启动时的授权、规则集与检查点完整性。
