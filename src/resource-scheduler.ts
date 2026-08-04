import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  RESOURCE_SIGNAL_STALE_AFTER_MS,
  type CodexResourceSignal,
} from "./resource-provider";
import type { WorkOrder, WorkOrderPace, WorkOrderPriority } from "./work-order";

export type AutoRunDecision = {
  candidateId: string | null;
  reasons: Map<string, string | null>;
};

const priorityRank: Record<WorkOrderPriority, number> = {
  high: 0,
  normal: 1,
  background: 2,
};

const maximumUsedPercent: Record<WorkOrderPace, number> = {
  fast: 90,
  balanced: 75,
  saving: 50,
};

export function decideAutoRun(
  workOrders: WorkOrder[],
  codex: CodexResourceSignal,
  maxConcurrency: number,
  now = new Date(),
): AutoRunDecision {
  const enabled = workOrders
    .filter((workOrder) => workOrder.resourcePlan.runWhenQuotaAvailable)
    .sort(
      (left, right) =>
        priorityRank[left.resourcePlan.priority] -
          priorityRank[right.resourcePlan.priority] ||
        Date.parse(left.createdAt) - Date.parse(right.createdAt),
    );
  const reasons = new Map<string, string | null>();
  const capacityReached =
    workOrders.filter((workOrder) =>
      ["running", "stopping", "verifying"].includes(workOrder.runStatus ?? ""),
    ).length >= maxConcurrency;

  for (const workOrder of enabled) {
    reasons.set(
      workOrder.id,
      blockingReason(workOrder, workOrders, codex, capacityReached, now),
    );
  }

  const candidate = enabled.find((workOrder) => reasons.get(workOrder.id) === null);
  if (!candidate) return { candidateId: null, reasons };

  for (const workOrder of enabled) {
    if (workOrder.id === candidate.id || reasons.get(workOrder.id) !== null) continue;
    reasons.set(
      workOrder.id,
      priorityRank[workOrder.resourcePlan.priority] >
        priorityRank[candidate.resourcePlan.priority]
        ? "等待更高优先级目标"
        : "等待本轮资源位置",
    );
  }
  return { candidateId: candidate.id, reasons };
}

function blockingReason(
  workOrder: WorkOrder,
  workOrders: WorkOrder[],
  codex: CodexResourceSignal,
  capacityReached: boolean,
  now: Date,
): string | null {
  if (workOrder.pendingClarification) return "等待补充关键信息";
  if (workOrder.plan?.confirmationRequired) return "计划有变更，等待确认";
  if (workOrder.status === "review") return "等待验收";
  if (workOrder.status === "delivered") return "目标已完成";
  if (workOrder.status === "running") return "当前正在运行";
  if (hasRunnableExternalStage(workOrder)) return "等待完成外部节点";
  if (workOrder.status === "interrupted") {
    if (
      workOrder.currentSummary.includes("最长运行时间") ||
      workOrder.currentSummary.includes("本轮上限")
    ) {
      return "已达到本轮上限，等待继续";
    }
    if (
      workOrder.runStatus === "failed" &&
      workOrder.result?.verifications.some(
        (verification) => verification.status === "failed",
      )
    ) {
      return "验证失败，等待处理后继续";
    }
    if (
      workOrder.result?.verifications.some(
        (verification) => verification.status === "not_configured",
      )
    ) {
      return "等待确认当前节点结果";
    }
    return "需要响应后继续";
  }
  if (workOrder.status !== "ready" || !workOrder.plan) return "等待确认计划";
  if (!workOrder.workspace) return "等待选择工作空间";
  if (!hasRunnableStage(workOrder)) return "等待前置节点完成";
  if (!Number.isFinite(workOrder.maxRunMinutes) || workOrder.maxRunMinutes <= 0) {
    return "等待确认单轮运行上限";
  }
  const quotaReason = quotaBlockingReason(codex, workOrder.resourcePlan.pace, now);
  if (quotaReason) return quotaReason;
  if (capacityReached) return "等待可用并发位置";
  if (
    workOrder.workspace.kind === "directory" &&
    workOrders.some(
      (candidate) =>
        candidate.id !== workOrder.id &&
        ["running", "stopping", "verifying"].includes(candidate.runStatus ?? "") &&
        candidate.worktreePath !== null &&
        canonicalWorkspacePath(candidate.worktreePath) ===
          canonicalWorkspacePath(workOrder.workspace!.path),
    )
  ) {
    return "工作空间正在使用";
  }
  return null;
}

function hasRunnableExternalStage(workOrder: WorkOrder): boolean {
  const plan = workOrder.plan;
  if (!plan) return false;
  const completed = completedStageIds(workOrder);
  return plan.stages.some(
    (stage) =>
      stage.executionMethod === "external" &&
      stage.status !== "completed" &&
      stage.dependsOn.every((dependencyId) => completed.has(dependencyId)),
  );
}

function canonicalWorkspacePath(workspacePath: string): string {
  const absolutePath = resolve(workspacePath);
  return existsSync(absolutePath) ? realpathSync(absolutePath) : absolutePath;
}

function hasRunnableStage(workOrder: WorkOrder): boolean {
  const plan = workOrder.plan;
  if (!plan) return false;
  const completed = completedStageIds(workOrder);
  return plan.stages.some(
    (stage) =>
      stage.executionMethod === "codex" &&
      ["planning", "queued"].includes(stage.status) &&
      stage.dependsOn.every((dependencyId) => completed.has(dependencyId)),
  );
}

function completedStageIds(workOrder: WorkOrder): Set<string> {
  const plan = workOrder.plan;
  if (!plan) return new Set();
  const completed = new Set(
    plan.stages
      .filter((stage) => stage.status === "completed")
      .map((stage) => stage.id),
  );
  for (const checkpoint of workOrder.checkpoints) {
    if (
      checkpoint.kind === "stage" &&
      checkpoint.planVersion === plan.version &&
      checkpoint.stageId
    ) {
      completed.add(checkpoint.stageId);
    }
  }
  return completed;
}

function quotaBlockingReason(
  codex: CodexResourceSignal,
  pace: WorkOrderPace,
  now: Date,
): string | null {
  if (codex.status === "conflict") return "额度数据冲突，等待重新读取";
  if (codex.status === "stale") return "额度数据已过期，等待重新读取";
  if (codex.status !== "available") return "额度数据不可用，保持排队";
  const observedAt = Date.parse(codex.observedAt);
  const age = now.getTime() - observedAt;
  if (
    !Number.isFinite(observedAt) ||
    age > RESOURCE_SIGNAL_STALE_AFTER_MS ||
    age < -60_000
  ) {
    return "额度数据已过期，等待重新读取";
  }
  if (!codex.shortWindow || !codex.longWindow) {
    return "额度窗口不完整，保持排队";
  }
  const windows = [codex.shortWindow, codex.longWindow];
  if (
    windows.some(
      (window) =>
        !Number.isFinite(window.usedPercent) ||
        window.usedPercent < 0 ||
        window.usedPercent > 100 ||
        !Number.isFinite(Date.parse(window.resetsAt)) ||
        Date.parse(window.resetsAt) <= now.getTime(),
    )
  ) {
    return "额度数据冲突，等待重新读取";
  }
  if (windows.some((window) => window.usedPercent > maximumUsedPercent[pace])) {
    return "额度不足，等待可用额度";
  }
  return null;
}
