import type { WorkOrder } from "./work-order";

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
};

export function presentConsoleWorkOrders(
  workOrders: WorkOrder[],
  maxConcurrency = 2,
): ConsoleWorkOrder[] {
  const activeCount = workOrders.filter((workOrder) =>
    ["running", "stopping", "verifying"].includes(workOrder.runStatus ?? ""),
  ).length;
  return workOrders.map((workOrder) => ({
    ...workOrder,
    ...presentStatus(workOrder, activeCount >= maxConcurrency),
  }));
}

function presentStatus(
  workOrder: WorkOrder,
  capacityReached: boolean,
): Pick<ConsoleWorkOrder, "userStatus" | "statusReason"> {
  if (workOrder.pendingClarification) {
    return { userStatus: "response", statusReason: "待补充关键信息" };
  }
  if (workOrder.importContext && !workOrder.plan) {
    if (workOrder.importContext.status === "pending") {
      return { userStatus: "planning", statusReason: "正在整理来源会话" };
    }
    if (workOrder.importContext.status === "failed") {
      return { userStatus: "planning", statusReason: "尚未整理" };
    }
    return { userStatus: "planning", statusReason: "待生成后续计划" };
  }
  if (workOrder.status === "delivered") {
    return { userStatus: "completed", statusReason: "已确认交付" };
  }
  if (workOrder.status === "review") {
    return { userStatus: "review", statusReason: "待验收" };
  }
  if (workOrder.status === "interrupted") {
    return {
      userStatus: "response",
      statusReason: workOrder.runStatus === "failed" ? "执行失败" : "执行中断",
    };
  }
  if (workOrder.status === "running") {
    const statusReason =
      {
        stopping: "正在停止",
        verifying: "正在整理结果",
        completed: "正在整理结果",
        running: "Codex 执行中",
      }[workOrder.runStatus ?? ""] ?? "正在推进";
    return { userStatus: "running", statusReason };
  }
  if (workOrder.status === "ready") {
    if (workOrder.plan?.confirmationRequired) {
      return { userStatus: "planning", statusReason: "待确认计划" };
    }
    const externalStage = workOrder.plan?.stages.find(
      (stage) => stage.executionMethod === "external" && stage.status === "response",
    );
    if (externalStage) {
      return {
        userStatus: "response",
        statusReason: `待完成外部节点：${externalStage.outcome}`,
      };
    }
    if (
      workOrder.resourcePlan.runWhenQuotaAvailable &&
      workOrder.resourcePlan.autoRunReason
    ) {
      return {
        userStatus: "queued",
        statusReason: workOrder.resourcePlan.autoRunReason,
      };
    }
    return capacityReached
      ? { userStatus: "queued", statusReason: "等待可用并发位置" }
      : { userStatus: "planning", statusReason: "待确认计划" };
  }
  return { userStatus: "planning", statusReason: "待生成计划" };
}
