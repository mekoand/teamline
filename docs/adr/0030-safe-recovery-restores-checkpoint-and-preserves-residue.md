# Safe Recovery Restores the Latest Complete Position and Preserves Residue

After an unexpected interruption, Teamline must first confirm that the old execution process tree has stopped and can no longer write. It then preserves the unresolved residue after the latest complete recovery position, restores clean state from the latest complete pause savepoint, stage checkpoint, or starting baseline, and acquires a new execution lease. Only this path is called safe recovery. An expired lease does not mean the old process has stopped. If execution fencing cannot be completed, the goal remains in “needs response” with an execution interruption note, and Teamline must not start new managed execution. An incomplete pause save must fall back to an earlier stage checkpoint or starting baseline without overwriting a reliable position. After reviewing the diff, the user may explicitly continue from the residue to preserve more progress, but this path is not reliable automatic recovery. The recovery prototype decides process fencing, content preservation, and completeness checks.

---

## 中文

# 安全恢复默认回到最新完整恢复位置并保留待处理现场

受控执行意外中断后，Teamline 必须先确认旧执行进程树已经停止且不能继续写入，再原样保留最新完整恢复位置之后的待处理现场，并从最新的完整暂停保存点、阶段检查点或起始基线建立干净状态、取得新的执行租约，这条路径才称为安全恢复。租约失效不等于旧进程已停止；无法完成执行围栏时，目标保持“需响应”并注明执行中断，不得启动新的受控执行。暂停保存不完整时必须退回此前的阶段检查点或起始基线，不能覆盖可靠位置。用户可以在查看差异后明确选择现场接续以争取保留更多进度，但该路径不属于可靠自动恢复；进程围栏、内容保存与完整性判断由恢复原型决定。
