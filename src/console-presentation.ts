import type { WorkOrder } from "./work-order";
import {
  semanticMessage,
  semanticMessageFromLegacy,
  type SemanticMessage,
} from "./semantic-message";

export type UserVisibleStatus =
  | "planning"
  | "running"
  | "queued"
  | "response"
  | "review"
  | "completed";

export type ConsoleWorkOrder = WorkOrder & {
  userStatus: UserVisibleStatus;
  statusReason: string;
  statusMessage: SemanticMessage;
};

export function presentConsoleWorkOrders(
  workOrders: WorkOrder[],
  maxConcurrency = 2,
  currentExecutionIdentityId: string | null = null,
  defaultExecutionIdentityId: string | null = null,
): ConsoleWorkOrder[] {
  const activeCount = workOrders.filter((workOrder) =>
    ["running", "stopping", "verifying"].includes(workOrder.runStatus ?? ""),
  ).length;
  return workOrders.map((workOrder) => ({
    ...workOrder,
    ...presentStatus(
      workOrder,
      activeCount >= maxConcurrency,
      currentExecutionIdentityId,
      defaultExecutionIdentityId,
    ),
  }));
}

function presentStatus(
  workOrder: WorkOrder,
  capacityReached: boolean,
  currentExecutionIdentityId: string | null,
  defaultExecutionIdentityId: string | null,
): Pick<ConsoleWorkOrder, "userStatus" | "statusReason" | "statusMessage"> {
  const presented = (
    userStatus: UserVisibleStatus,
    statusReason: string,
    code: string,
    params: SemanticMessage["params"] = {},
  ) => ({ userStatus, statusReason, statusMessage: semanticMessage(code, params) });
  if (workOrder.pendingClarification) {
    return presented("response", "待补充关键信息", "status.awaiting_clarification");
  }
  if (workOrder.importContext && !workOrder.sourceContext && !workOrder.plan) {
    if (workOrder.importContext.status === "pending") {
      return presented("planning", "正在整理历史", "status.organizing_history");
    }
    if (workOrder.importContext.status === "failed") {
      const interrupted = semanticMessageFromLegacy(
        workOrder.importContext.error ?? "",
      ).code === "import.interrupted";
      return presented(
        "planning",
        interrupted ? "历史整理中断" : "历史整理失败",
        interrupted ? "import.interrupted" : "import.failed",
      );
    }
    if (workOrder.importContext.error) {
      const interrupted = semanticMessageFromLegacy(
        workOrder.importContext.error,
      ).code === "import.interrupted";
      return presented(
        "planning",
        interrupted ? "历史整理中断" : "历史整理失败",
        interrupted ? "import.interrupted" : "import.failed",
      );
    }
    return presented("planning", "待生成后续计划", "status.awaiting_followup_plan");
  }
  if (workOrder.status === "delivered") {
    return presented("completed", "已确认交付", "status.delivered");
  }
  if (workOrder.status === "review") {
    return presented("review", "待验收", "status.awaiting_review");
  }
  if (workOrder.status === "interrupted") {
    const externalStage = workOrder.plan?.stages.find(
      (stage) => stage.executionMethod === "external" && stage.status === "response",
    );
    const failedVerification = workOrder.result?.verifications.some(
      (verification) => verification.status === "failed",
    );
    const needsNodeConfirmation = workOrder.result?.verifications.some(
      (verification) => verification.status === "not_configured",
    );
    if (externalStage) {
      return presented(
        "response",
        `待完成外部节点：${externalStage.outcome}`,
        "status.awaiting_external_stage",
        { outcome: externalStage.outcome },
      );
    }
    const interruption = semanticMessageFromLegacy(workOrder.currentSummary);
    if (interruption.code === "status.run_limit_reached") {
      return presented("response", "已达到本轮上限", interruption.code);
    }
    if (failedVerification) {
      return presented("response", "自动验证未通过", "status.verification_failed");
    }
    if (needsNodeConfirmation) {
      return presented("response", "待确认当前节点结果", "status.awaiting_node_confirmation");
    }
    return workOrder.runStatus === "failed"
      ? presented("response", "执行失败", "status.execution_failed")
      : presented("response", "执行中断", "status.execution_interrupted");
  }
  if (workOrder.status === "running") {
    const statusReason =
      {
        stopping: "正在停止",
        verifying: "正在整理结果",
        completed: "正在整理结果",
        running: "Codex 执行中",
      }[workOrder.runStatus ?? ""] ?? "正在推进";
    const code = {
      stopping: "status.stopping",
      verifying: "status.processing_result",
      completed: "status.processing_result",
      running: "status.running_codex",
    }[workOrder.runStatus ?? ""] ?? "status.running";
    return presented("running", statusReason, code);
  }
  if (workOrder.status === "ready") {
    if (workOrder.plan?.confirmationRequired) {
      return presented("planning", "待确认计划", "status.awaiting_plan_confirmation");
    }
    const externalStage = workOrder.plan?.stages.find(
      (stage) => stage.executionMethod === "external" && stage.status === "response",
    );
    if (externalStage) {
      return presented(
        "response",
        `待完成外部节点：${externalStage.outcome}`,
        "status.awaiting_external_stage",
        { outcome: externalStage.outcome },
      );
    }
    if (!workOrder.workspace) {
      return presented("queued", "等待选择工作空间", "status.awaiting_workspace");
    }
    const targetExecutionIdentityId =
      workOrder.executionIdentityId ?? defaultExecutionIdentityId;
    if (
      currentExecutionIdentityId &&
      targetExecutionIdentityId &&
      currentExecutionIdentityId !== targetExecutionIdentityId
    ) {
      return presented("queued", "等待账号", "status.awaiting_identity");
    }
    if (
      workOrder.resourcePlan.runWhenQuotaAvailable &&
      workOrder.resourcePlan.autoRunReason
    ) {
      return {
        userStatus: "queued",
        statusReason: workOrder.resourcePlan.autoRunReason,
        statusMessage: semanticMessageFromLegacy(workOrder.resourcePlan.autoRunReason),
      };
    }
    return capacityReached
      ? presented("queued", "等待可用并发位置", "status.awaiting_capacity")
      : presented("queued", "可以开始运行", "status.ready_to_run");
  }
  return presented("planning", "待生成计划", "status.awaiting_plan");
}
