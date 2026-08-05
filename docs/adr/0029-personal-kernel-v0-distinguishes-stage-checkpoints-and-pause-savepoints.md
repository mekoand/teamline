# Personal Kernel v0 Distinguishes Stage Checkpoints from Pause Savepoints

Personal kernel v0 records a starting baseline before execution and creates a stage checkpoint only after a planned validation passes for an execution stage. A stage checkpoint serves as both a recovery position and evidence of stage completion. An orderly manual pause or handoff creates a pause savepoint. It can be resumed safely but does not prove that the current stage is complete. Both records are bound to the goal, plan version, stage, execution lease, Git tree hash, and sequence number, and neither is produced merely because of time, file changes, or AI judgment. An unexpected process crash creates neither record; later changes remain as unresolved working residue.

---

## 中文

# 个人内核 v0 区分阶段检查点与暂停保存点

个人内核 v0 在执行开始前记录起始基线，并只在执行阶段按计划验证通过后创建阶段检查点；阶段检查点同时承担恢复位置和阶段完成证据。已经停稳的主动暂停或交接创建暂停保存点，它可以安全接续，但不能证明当前阶段完成。两者都绑定目标、计划版本、阶段、执行租约、Git tree hash 和顺序号，也都不根据时间、文件变化或 AI 判断产生。进程意外崩溃不会生成任何一种保存记录，其后的变化作为待处理现场保留。
