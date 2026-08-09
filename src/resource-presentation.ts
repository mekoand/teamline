import { presentConsoleWorkOrders } from "./console-presentation";
import { RESOURCE_SIGNAL_STALE_AFTER_MS } from "./resource-provider";
import type {
  CodexResourceSignal,
  ResourceProviderSnapshot,
  WorkOrderUsage,
} from "./resource-provider";
import type { SessionMonitoringResourceUsage } from "./session-monitoring";
import { presentExecutionIdentity, type ExecutionIdentity } from "./execution-identity";
import type { WorkOrder } from "./work-order";
import { semanticMessage, type SemanticMessage } from "./semantic-message";

const RESOURCE_SIGNAL_FUTURE_TOLERANCE_MS = 60_000;
export const DEFAULT_BACKUP_REMAINING_THRESHOLD_PERCENT = 10;

export type IdentityQuotaObservation = {
  identity: ExecutionIdentity;
  signal: CodexResourceSignal;
};

export function presentIdentityQuota(
  observations: IdentityQuotaObservation[],
  defaultIdentityId: string | null,
  currentIdentityId: string | null,
  now = new Date(),
  remainingThreshold = DEFAULT_BACKUP_REMAINING_THRESHOLD_PERCENT,
) {
  return observations.map(({ identity, signal }) => {
    const presentedIdentity = presentExecutionIdentity(identity, defaultIdentityId);
    const current = identity.id === currentIdentityId;
    const complete = quotaSignalIsCompleteAndCurrent(signal, now);
    const aboveThreshold = presentedIdentity.executable && complete && [signal.shortWindow!, signal.longWindow!]
      .every((window) => 100 - window.usedPercent > remainingThreshold);
    const backupStatus = current
      ? "current"
      : !presentedIdentity.executable || !complete
        ? "unknown"
        : aboveThreshold
          ? "available"
          : "insufficient";
    return {
      identity: presentedIdentity,
      quota: signal,
      backupStatus,
      backupLabel: current
        ? "当前账号"
        : backupStatus === "available"
          ? "备用账号可用"
          : backupStatus === "insufficient"
            ? "备用账号额度不足"
            : "备用账号额度未知",
      backupMessage: semanticMessage(
        current
          ? "resource.identity.current"
          : backupStatus === "available"
            ? "resource.identity.backup_available"
            : backupStatus === "insufficient"
              ? "resource.identity.backup_insufficient"
              : "resource.identity.backup_unknown",
      ),
    };
  });
}

function quotaSignalIsCompleteAndCurrent(
  signal: CodexResourceSignal,
  now: Date,
): boolean {
  if (signal.status !== "available" || !signal.shortWindow || !signal.longWindow) {
    return false;
  }
  const observedAt = Date.parse(signal.observedAt);
  const nowMs = now.getTime();
  if (
    !Number.isFinite(observedAt) ||
    nowMs - observedAt > RESOURCE_SIGNAL_STALE_AFTER_MS ||
    observedAt - nowMs > RESOURCE_SIGNAL_FUTURE_TOLERANCE_MS
  ) {
    return false;
  }
  return [signal.shortWindow, signal.longWindow].every(
    (window) => Date.parse(window.resetsAt) > nowMs,
  );
}

export function presentResources(
  snapshot: ResourceProviderSnapshot,
  workOrders: WorkOrder[],
  maxConcurrency = 2,
  sessionMonitoringUsage: SessionMonitoringResourceUsage[] = [],
) {
  const usageByWorkOrder = new Map(
    snapshot.workOrderUsage.map((usage) => [usage.workOrderId, usage]),
  );
  const presented = presentConsoleWorkOrders(workOrders, maxConcurrency);

  return {
    observedAt: snapshot.observedAt,
    runningCount: workOrders.filter((workOrder) =>
      ["running", "stopping", "verifying"].includes(workOrder.runStatus ?? ""),
    ).length,
    codex: snapshot.codex,
    openaiApi: snapshot.openaiApi,
    sessionMonitoringUsage,
    workOrders: presented.map((workOrder) => ({
      id: workOrder.id,
      title: workOrder.title,
      ...(!workOrder.sourceContext && workOrder.sourceSessions[0]?.kind === "claude_code_session"
        ? { importOnly: true }
        : {}),
      status: workOrder.userStatus,
      priority: workOrder.resourcePlan.priority,
      pace: workOrder.resourcePlan.pace,
      maxRunMinutes: workOrder.maxRunMinutes,
      runWhenQuotaAvailable: workOrder.resourcePlan.runWhenQuotaAvailable,
      autoRunReason: workOrder.resourcePlan.autoRunReason,
      paidApiFallbackEnabled: workOrder.resourcePlan.paidApiFallbackEnabled,
      paidApiLimitUsd: workOrder.resourcePlan.paidApiLimitUsd,
      usage: presentWorkOrderUsage(
        usageByWorkOrder.get(workOrder.id),
        snapshot.observedAt,
      ),
      ...(() => {
        const result = !workOrder.sourceContext && workOrder.sourceSessions[0]?.kind === "claude_code_session"
          ? {
              text: "仅保留导入状态",
              message: semanticMessage("resource.recommendation.import_only"),
            }
          : recommendation(workOrder, snapshot.codex);
        return {
          recommendation: result.text,
          recommendationMessage: result.message,
        };
      })(),
    })),
  };
}

function presentWorkOrderUsage(
  usage: WorkOrderUsage | undefined,
  snapshotObservedAt: string,
) {
  if (!usage) {
    return {
      status: "unavailable" as const,
      message: "当前没有可归因到这个目标的用量",
      messageDescriptor: semanticMessage("resource.usage.unattributed"),
    };
  }
  const usageObservedAt = Date.parse(usage.observedAt);
  const snapshotTime = Date.parse(snapshotObservedAt);
  if (!Number.isFinite(usageObservedAt) || !Number.isFinite(snapshotTime)) {
    return {
      status: "unavailable" as const,
      message: "目标用量缺少有效采集时间，无法显示精确值",
      messageDescriptor: semanticMessage("resource.usage.invalid_observed_at"),
    };
  }
  if (
    typeof usage.amount !== "number" ||
    !Number.isFinite(usage.amount) ||
    usage.amount < 0 ||
    !["usd", "tokens"].includes(usage.unit) ||
    usage.source !== "openai-usage-api"
  ) {
    return {
      status: "unavailable" as const,
      observedAt: usage.observedAt,
      message: "目标用量数据无效，无法显示精确值",
      messageDescriptor: semanticMessage("resource.usage.invalid"),
    };
  }
  const age = snapshotTime - usageObservedAt;
  if (
    age > RESOURCE_SIGNAL_STALE_AFTER_MS ||
    age < -RESOURCE_SIGNAL_FUTURE_TOLERANCE_MS
  ) {
    return {
      status: "stale" as const,
      observedAt: usage.observedAt,
      message:
        age < 0
          ? "目标用量采集时间异常，需要重新读取后才能显示精确值"
          : "目标用量已过期，需要重新读取后才能显示精确值",
      messageDescriptor: semanticMessage(
        age < 0 ? "resource.usage.future" : "resource.usage.stale",
      ),
    };
  }
  return {
    status: "available" as const,
    amount: usage.amount,
    unit: usage.unit,
    observedAt: usage.observedAt,
    source: usage.source,
  };
}

function recommendation(
  workOrder: ReturnType<typeof presentConsoleWorkOrders>[number],
  codex: CodexResourceSignal,
): { text: string; message: SemanticMessage } {
  const result = (text: string, code: string, params: SemanticMessage["params"] = {}) => ({
    text,
    message: semanticMessage(code, params),
  });
  if (workOrder.userStatus === "running") {
    return result("保持观察，运行结束后再评估", "resource.recommendation.observe_running");
  }
  if (
    workOrder.userStatus === "queued" &&
    workOrder.statusMessage.code === "status.awaiting_capacity"
  ) {
    return result("等待当前运行结束", "resource.recommendation.await_capacity");
  }
  if (workOrder.statusMessage.code === "status.awaiting_workspace") {
    return result("先选择工作空间，再安排运行", "resource.recommendation.select_workspace");
  }
  if (workOrder.userStatus === "response") {
    return result("先处理这个目标需要的响应", "resource.recommendation.handle_response");
  }
  if (workOrder.userStatus === "review") {
    return result("先验收这个目标", "resource.recommendation.review");
  }
  if (workOrder.status === "ready") {
    if (workOrder.resourcePlan.runWhenQuotaAvailable) {
      return workOrder.resourcePlan.autoRunReason
        ? result(
            `待运行 · ${workOrder.resourcePlan.autoRunReason}`,
            "resource.recommendation.auto_run_waiting",
            { reason: workOrder.resourcePlan.autoRunReason },
          )
        : result("额度满足时可自动启动一轮", "resource.recommendation.auto_run_ready");
    }
    if (codex.status !== "available") {
      return result(
        "额度信号不可用，无法判断是否适合运行",
        "resource.recommendation.quota_unknown",
      );
    }
    const nearlyExhausted = [codex.shortWindow, codex.longWindow]
      .filter((window) => window !== null)
      .some((window) => window.usedPercent >= 90);
    return nearlyExhausted
      ? result("额度接近上限，建议等待重置后再运行", "resource.recommendation.await_reset")
      : result("额度可用，可以手动启动", "resource.recommendation.manual_start");
  }
  if (workOrder.userStatus === "planning") {
    return result("先确认计划，再安排运行", "resource.recommendation.confirm_plan");
  }
  return result("无需继续分配运行资源", "resource.recommendation.none");
}
