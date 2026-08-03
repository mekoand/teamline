import { presentConsoleWorkOrders } from "./console-presentation";
import { RESOURCE_SIGNAL_STALE_AFTER_MS } from "./resource-provider";
import type {
  CodexResourceSignal,
  ResourceProviderSnapshot,
  WorkOrderUsage,
} from "./resource-provider";
import type { WorkOrder } from "./work-order";

const RESOURCE_SIGNAL_FUTURE_TOLERANCE_MS = 60_000;

export function presentResources(
  snapshot: ResourceProviderSnapshot,
  workOrders: WorkOrder[],
) {
  const usageByWorkOrder = new Map(
    snapshot.workOrderUsage.map((usage) => [usage.workOrderId, usage]),
  );
  const presented = presentConsoleWorkOrders(workOrders);

  return {
    observedAt: snapshot.observedAt,
    runningCount: workOrders.filter((workOrder) =>
      ["running", "stopping", "verifying"].includes(workOrder.runStatus ?? ""),
    ).length,
    codex: snapshot.codex,
    openaiApi: snapshot.openaiApi,
    workOrders: presented.map((workOrder) => ({
      id: workOrder.id,
      title: workOrder.title,
      status: workOrder.userStatus,
      priority: null,
      pace: null,
      usage: presentWorkOrderUsage(
        usageByWorkOrder.get(workOrder.id),
        snapshot.observedAt,
      ),
      recommendation: recommendation(workOrder, snapshot.codex),
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
      message: "当前没有可归因到这项委托的用量",
    };
  }
  const usageObservedAt = Date.parse(usage.observedAt);
  const snapshotTime = Date.parse(snapshotObservedAt);
  if (!Number.isFinite(usageObservedAt) || !Number.isFinite(snapshotTime)) {
    return {
      status: "unavailable" as const,
      message: "委托用量缺少有效采集时间，无法显示精确值",
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
      message: "委托用量数据无效，无法显示精确值",
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
          ? "委托用量采集时间异常，需要重新读取后才能显示精确值"
          : "委托用量已过期，需要重新读取后才能显示精确值",
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
): string {
  if (workOrder.userStatus === "running") {
    return "保持观察，运行结束后再评估";
  }
  if (workOrder.userStatus === "queued") return "等待当前运行结束";
  if (workOrder.userStatus === "response") {
    return "先处理这项委托需要的响应";
  }
  if (workOrder.status === "ready") {
    if (codex.status !== "available") {
      return "额度信号不可用，无法判断是否适合运行";
    }
    const nearlyExhausted = [codex.shortWindow, codex.longWindow]
      .filter((window) => window !== null)
      .some((window) => window.usedPercent >= 90);
    return nearlyExhausted
      ? "额度接近上限，建议等待重置后再运行"
      : "额度可用，可以手动启动";
  }
  if (workOrder.userStatus === "planning") return "先确认计划，再安排运行";
  return "无需继续分配运行资源";
}
