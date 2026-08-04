# The Control Layer Owns the Goal Plan and the Model Suggests Decomposition

Intelligent decomposition is a core control-layer capability, but it does not require Teamline to build a coding agent. The control layer owns the execution plan's structure, versions, boundaries, and quality. A user first authorizes Codex to read the selected repository through the Generate Plan action. After the interface discloses the receiving service and data scope, Codex receives the necessary context and proposes a structured draft. The user can edit the draft or fill it manually; Teamline does not add a separate cloud planning model. Every execution stage must produce an independently verifiable intermediate result and include at least the intended result, expected scope of change, validation method, and retained evidence. Stages are not divided by time, conversation turn, or file count. Teamline checks only that these fields are complete, and a stage completes only after its planned validation passes. Only a human-confirmed plan version receives execution authorization. Changes to the goal, completion conditions, authorization boundary, effective rule set, or hard resource limits create a new version and require renewed confirmation. Goal priority, execution pace, and “run when quota is available” remain user-editable run preferences and do not change the AI plan version.

---

## 中文

# 工作控制层拥有执行计划而模型只提供切分建议

智能切分是工作控制层的核心能力，但不要求产品自建编码 Agent。控制层拥有执行计划的数据结构、版本、边界和质量责任；用户先通过生成计划动作授权 Codex 只读访问所选仓库，并在界面披露接收服务与数据范围后发送必要上下文，Codex 才提出结构化草案。用户可以修改草案或改为手动填写，Teamline 不另建独立的云端规划模型。计划中的每个执行阶段必须是能够独立验证的中间结果，至少包含目标结果、预计影响范围、验证方式和应保留的证据，不按时间、对话轮次或文件数量划分；Teamline 只校验这些字段是否完整，阶段按计划验证通过后才能完成。只有经人确认的计划版本能够获得执行授权；改变目标、完成条件、授权边界、生效规则集或资源硬上限必须形成新版本并重新确认。目标优先级、执行节奏和“额度充足时运行”开关是用户可变的运行偏好，不触发 AI 计划版本变化。
