export type MessageParameter = string | number | boolean | null;

export type SemanticMessage = {
  code: string;
  params: Record<string, MessageParameter>;
};

export function semanticMessage(
  code: string,
  params: Record<string, MessageParameter> = {},
): SemanticMessage {
  return { code, params };
}

const exactLegacyCodes = new Map<string, string>([
  ["历史整理中断", "import.interrupted"],
  ["历史整理失败", "import.failed"],
  ["等待补充关键信息", "status.awaiting_clarification"],
  ["待补充关键信息", "status.awaiting_clarification"],
  ["待确认计划", "status.awaiting_plan_confirmation"],
  ["计划有变更，等待确认", "status.awaiting_plan_confirmation"],
  ["等待验收", "status.awaiting_review"],
  ["待验收", "status.awaiting_review"],
  ["等待选择工作空间", "status.awaiting_workspace"],
  ["等待账号", "status.awaiting_identity"],
  ["等待可用并发位置", "status.awaiting_capacity"],
  ["可以开始运行", "status.ready_to_run"],
  ["自动验证未通过", "status.verification_failed"],
  ["待确认当前节点结果", "status.awaiting_node_confirmation"],
  ["执行失败", "status.execution_failed"],
  ["执行中断", "status.execution_interrupted"],
  ["等待更高优先级目标", "scheduler.awaiting_higher_priority"],
  ["等待本轮资源位置", "scheduler.awaiting_round_capacity"],
  ["目标已完成", "scheduler.completed"],
  ["当前正在运行", "scheduler.running"],
  ["等待完成外部节点", "scheduler.awaiting_external_stage"],
  ["已达到本轮上限，等待继续", "scheduler.run_limit_reached"],
  ["验证失败，等待处理后继续", "scheduler.verification_failed"],
  ["等待确认当前节点结果", "scheduler.awaiting_node_confirmation"],
  ["需要响应后继续", "scheduler.awaiting_response"],
  ["等待确认计划", "scheduler.awaiting_plan"],
  ["工作空间不可用，等待重新检查", "scheduler.workspace_unavailable"],
  ["等待前置节点完成", "scheduler.awaiting_dependencies"],
  ["等待确认单轮运行上限", "scheduler.awaiting_run_limit"],
  ["工作空间正在使用", "scheduler.workspace_in_use"],
  ["额度数据冲突，等待重新读取", "scheduler.quota_conflict"],
  ["额度数据已过期，等待重新读取", "scheduler.quota_stale"],
  ["额度数据不可用，保持排队", "scheduler.quota_unavailable"],
  ["额度窗口不完整，保持排队", "scheduler.quota_incomplete"],
  ["额度不足，等待可用额度", "scheduler.quota_insufficient"],
  ["等待选择 Codex 账号", "scheduler.awaiting_identity_selection"],
  ["Codex 账号不可用，等待处理", "scheduler.identity_unavailable"],
]);

/** Compatibility adapter for records written before semantic message codes existed. */
export function semanticMessageFromLegacy(text: string): SemanticMessage {
  const exact = exactLegacyCodes.get(text);
  if (exact) return semanticMessage(exact);
  if (text.includes("最长运行时间") || text.includes("本轮上限")) {
    return semanticMessage("status.run_limit_reached");
  }
  if (text.startsWith("待完成外部节点：")) {
    return semanticMessage("status.awaiting_external_stage", {
      outcome: text.slice("待完成外部节点：".length),
    });
  }
  return semanticMessage("legacy.text", { text });
}

export async function ensureSemanticErrorResponse(
  response: Response,
): Promise<Response> {
  if (response.ok || !response.headers.get("content-type")?.includes("application/json")) {
    return response;
  }
  const body = await response.clone().json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.error !== "string" || typeof body.code === "string") {
    return response;
  }
  const code = response.status >= 500
    ? "error.internal"
    : response.status === 404
      ? "error.not_found"
      : response.status === 409
        ? "error.conflict"
        : "error.invalid_request";
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return Response.json(
    { ...body, code, message: semanticMessage(code) },
    { status: response.status, statusText: response.statusText, headers },
  );
}
