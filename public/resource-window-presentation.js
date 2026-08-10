export function availableQuotaWindows(quota = {}) {
  return [
    quota.shortWindow ? { key: "short", label: "5 小时", englishLabel: "5-hour", window: quota.shortWindow } : null,
    quota.longWindow ? { key: "long", label: "周额度", englishLabel: "Weekly", window: quota.longWindow } : null,
  ].filter(Boolean);
}

export function quotaWindowSummary(quota = {}, locale = "zh-CN") {
  if (quota.status !== "available") return null;
  const windows = availableQuotaWindows(quota);
  if (!windows.length) return null;
  const summaries = windows.map(({ label, englishLabel, window }) => {
    const remaining = Math.max(0, 100 - window.usedPercent);
    return `${locale === "zh-CN" ? label : englishLabel} ${remaining}%`;
  });
  return locale === "zh-CN"
    ? `${summaries.join(" · ")} 可用`
    : `${summaries.join(" · ")} available`;
}
