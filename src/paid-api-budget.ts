import { RESOURCE_SIGNAL_STALE_AFTER_MS } from "./resource-provider";
import type { ResourceProviderSnapshot, WorkOrderUsage } from "./resource-provider";
import type { WorkOrder } from "./work-order";

const FUTURE_TOLERANCE_MS = 60_000;

export type PaidApiBudgetSettings = {
  monthlyBudgetUsd: number | null;
};

export type PaidApiDecision =
  | { allowed: true; reason: null }
  | { allowed: false; reason: string };

export function decidePaidApiRun(
  workOrder: WorkOrder,
  snapshot: ResourceProviderSnapshot,
  settings: PaidApiBudgetSettings,
  paidApiAvailable: boolean,
  now = new Date(),
): PaidApiDecision {
  const plan = workOrder.resourcePlan;
  if (!plan.paidApiFallbackEnabled) {
    return blocked("这个目标未允许使用付费 API");
  }
  if (!isPositiveAmount(plan.paidApiLimitUsd)) {
    return blocked("请先设置这个目标的付费限额");
  }
  if (!isPositiveAmount(settings.monthlyBudgetUsd)) {
    return blocked("请先设置 API 月度预算");
  }
  if (!paidApiAvailable) {
    return blocked("本机未提供付费 API 凭证");
  }

  const account = snapshot.openaiApi;
  if (
    account.status !== "available" ||
    account.source !== "openai-usage-api" ||
    account.scope !== "project" ||
    !account.usage ||
    account.usage.unit !== "usd" ||
    !isNonNegativeAmount(account.usage.amount) ||
    !isCurrentObservation(account.observedAt, now) ||
    !coversCurrentMonth(
      account.usage.periodStart,
      account.usage.periodEnd,
      account.observedAt,
      now,
    )
  ) {
    return blocked("API 实际用量不可用，暂不启动付费执行");
  }
  if (account.usage.amount >= settings.monthlyBudgetUsd) {
    return blocked("API 月度预算已用完");
  }
  if (snapshot.pendingPaidUsageWorkOrderId) {
    return blocked("等待上一笔 API 实际用量更新");
  }
  if (
    plan.lastPaidApiRunAt &&
    Date.parse(account.observedAt) < Date.parse(plan.lastPaidApiRunAt)
  ) {
    return blocked("等待 API 月度用量更新");
  }

  const attributed = snapshot.workOrderUsage.find(
    (usage) => usage.workOrderId === workOrder.id,
  );
  if (!attributed) {
    return plan.lastPaidApiRunAt
      ? blocked("等待这个目标的 API 实际用量更新")
      : { allowed: true, reason: null };
  }
  if (!validAttributedUsage(attributed, now)) {
    return blocked("这个目标的 API 实际用量不可用");
  }
  if (
    plan.lastPaidApiRunAt &&
    Date.parse(attributed.observedAt) < Date.parse(plan.lastPaidApiRunAt)
  ) {
    return blocked("等待这个目标的 API 实际用量更新");
  }
  if (attributed.amount >= plan.paidApiLimitUsd) {
    return blocked("这个目标的付费限额已用完");
  }
  return { allowed: true, reason: null };
}

function validAttributedUsage(usage: WorkOrderUsage, now: Date): boolean {
  return (
    usage.source === "openai-usage-api" &&
    usage.unit === "usd" &&
    isNonNegativeAmount(usage.amount) &&
    isCurrentObservation(usage.observedAt, now)
  );
}

function isCurrentObservation(observedAt: string, now: Date): boolean {
  const timestamp = Date.parse(observedAt);
  const age = now.getTime() - timestamp;
  return (
    Number.isFinite(timestamp) &&
    age <= RESOURCE_SIGNAL_STALE_AFTER_MS &&
    age >= -FUTURE_TOLERANCE_MS
  );
}

function coversCurrentMonth(
  periodStart: string,
  periodEnd: string,
  observedAt: string,
  now: Date,
): boolean {
  const start = Date.parse(periodStart);
  const end = Date.parse(periodEnd);
  const observed = Date.parse(observedAt);
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  return (
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    Number.isFinite(observed) &&
    start <= monthStart &&
    end >= monthStart &&
    end >= observed - FUTURE_TOLERANCE_MS &&
    end <= now.getTime() + FUTURE_TOLERANCE_MS
  );
}

function isPositiveAmount(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeAmount(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function blocked(reason: string): PaidApiDecision {
  return { allowed: false, reason };
}
