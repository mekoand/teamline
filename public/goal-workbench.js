export function defaultGoalWorkbenchView(status) {
  if (status === "response") return "conversation";
  if (status === "review" || status === "completed") return "result";
  return "progress";
}

export function visibleGoalConversation(messages) {
  return (messages ?? []).filter((message) =>
    message.role === "user"
      ? message.kind === "reply" || message.kind === "supplement"
      : message.kind === "question" || message.kind === "decision",
  );
}

export function completedGoalHighlights(workOrder) {
  const imported = workOrder.importContext?.completedHighlights ?? [];
  const executed = (workOrder.plan?.stages ?? [])
    .filter((stage) => stage.status === "completed")
    .map((stage) => stage.outcome);
  return [...new Set([...executed, ...imported].map((item) => item?.trim()).filter(Boolean))]
    .slice(0, 3);
}

export function latestCompletionSummary(events, stageId) {
  const genericMessages = new Set([
    "Codex 已完成本轮处理",
    "Codex completed this run",
  ]);
  return (events ?? [])
    .filter((event) => event.type === "progress" && event.stageId === stageId)
    .slice()
    .reverse()
    .map((event) => event.message.trim())
    .find(
      (message) =>
        message &&
        !message.startsWith("Codex 进展：") &&
        !message.startsWith("Codex progress:") &&
        !genericMessages.has(message),
    ) ?? null;
}
