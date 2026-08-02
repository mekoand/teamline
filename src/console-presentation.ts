import type { WorkOrder } from "./work-order";

export type UserVisibleStatus =
  | "planning"
  | "running"
  | "queued"
  | "response"
  | "completed";

export type ConsoleWorkOrder = WorkOrder & {
  userStatus: UserVisibleStatus;
  statusReason: string;
};

export function presentConsoleWorkOrders(workOrders: WorkOrder[]): ConsoleWorkOrder[] {
  return workOrders.map((workOrder) => ({
    ...workOrder,
    ...presentStatus(workOrder, workOrders),
  }));
}

function presentStatus(
  workOrder: WorkOrder,
  workOrders: WorkOrder[],
): Pick<ConsoleWorkOrder, "userStatus" | "statusReason"> {
  if (workOrder.status === "delivered") {
    return { userStatus: "completed", statusReason: "已确认交付" };
  }
  if (workOrder.status === "review") {
    return { userStatus: "response", statusReason: "待验收" };
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
    const anotherRunIsActive = workOrders.some(
      (candidate) =>
        candidate.id !== workOrder.id &&
        ["running", "stopping", "verifying"].includes(candidate.runStatus ?? ""),
    );
    return anotherRunIsActive
      ? { userStatus: "queued", statusReason: "等待当前委托结束" }
      : { userStatus: "planning", statusReason: "待确认计划" };
  }
  return { userStatus: "planning", statusReason: "待生成计划" };
}
