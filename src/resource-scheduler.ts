import { existsSync, realpathSync, statSync } from "node:fs";
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

export type AutoRunIdentityContext = {
  currentExecutionIdentityId: string | null;
  defaultExecutionIdentityId: string | null;
  executableExecutionIdentityIds: ReadonlySet<string>;
  quotaByExecutionIdentityId?: ReadonlyMap<string, CodexResourceSignal>;
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
  identityContext?: AutoRunIdentityContext,
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
      blockingReason(
        workOrder,
        workOrders,
        quotaForWorkOrder(workOrder, codex, identityContext),
        capacityReached,
        now,
        identityBlockingReason(workOrder, identityContext),
      ),
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
  identityReason: string | null,
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
  if (!workspaceAvailable(workOrder.workspace.path)) return "工作空间不可用，等待重新检查";
  if (!hasRunnableStage(workOrder)) return "等待前置节点完成";
  if (!Number.isFinite(workOrder.maxRunMinutes) || workOrder.maxRunMinutes <= 0) {
    return "等待确认单轮运行上限";
  }
  if (identityReason) return identityReason;
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

function workspaceAvailable(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
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

export function quotaBlockingReason(
  codex: CodexResourceSignal,
  pace: WorkOrderPace,
  now: Date,
): string | null {
  if (pace === "fast" && codex.status !== "available") return null;
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
    if (pace === "fast") return null;
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
    if (pace === "fast") return null;
    return "额度数据冲突，等待重新读取";
  }
  if (
    pace === "fast" &&
    windows.some((window) => window.usedPercent >= 100)
  ) {
    return "额度不足，等待可用额度";
  }
  if (windows.some((window) => window.usedPercent > maximumUsedPercent[pace])) {
    return "额度不足，等待可用额度";
  }
  return null;
}

function identityBlockingReason(
  workOrder: WorkOrder,
  context?: AutoRunIdentityContext,
): string | null {
  if (!context) return null;
  const identityId =
    workOrder.executionIdentityId ?? context.defaultExecutionIdentityId;
  if (!identityId) return "等待选择 Codex 账号";
  if (!context.executableExecutionIdentityIds.has(identityId)) {
    return "Codex 账号不可用，等待处理";
  }
  if (
    context.currentExecutionIdentityId &&
    context.currentExecutionIdentityId !== identityId
  ) {
    return "等待账号";
  }
  return null;
}

function quotaForWorkOrder(
  workOrder: WorkOrder,
  fallback: CodexResourceSignal,
  context?: AutoRunIdentityContext,
): CodexResourceSignal {
  if (!context?.quotaByExecutionIdentityId) return fallback;
  const identityId =
    workOrder.executionIdentityId ?? context.defaultExecutionIdentityId;
  if (!identityId) return unavailableIdentityQuota(fallback.observedAt);
  return (
    context.quotaByExecutionIdentityId.get(identityId) ??
    unavailableIdentityQuota(fallback.observedAt)
  );
}

function unavailableIdentityQuota(observedAt: string): CodexResourceSignal {
  return {
    status: "unavailable",
    source: "codex-app-server",
    observedAt,
    message: "这个 Codex 账号暂时没有可用额度数据",
    shortWindow: null,
    longWindow: null,
  };
}
