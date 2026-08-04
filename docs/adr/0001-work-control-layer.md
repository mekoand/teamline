# The Product Is a Work Control Layer, Not a New Coding Agent

The product is responsible for planning work goals, making resource decisions, defining authorization boundaries, tracking execution state, supporting recovery, and collecting acceptance evidence. It uses official interfaces to call existing tools such as Claude Code, Codex, and GLM for code generation. We will not build a new model gateway or coding agent because mature tools already provide those capabilities. Rebuilding them would increase maintenance cost and blur the core value: helping long-running development work finish reliably.

---

## 中文

# 产品是工作控制层，而不是新的编码 Agent

产品负责工作目标的计划、资源决策、授权边界、执行状态、恢复和验收证据，并通过官方接口调用 Claude Code、Codex、GLM 等现有工具完成代码生成。我们不自建模型网关或新的编码 Agent，因为这些能力已有成熟工具，重复建设会扩大维护面，并模糊“让长程开发工作可靠完成”的核心价值。
