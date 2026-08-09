export async function claimLocalNotifications(coreUrl, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(new URL("/api/notifications/claim", coreUrl), {
    method: "POST",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || "无法读取本机通知");
  }
  return Array.isArray(payload?.notifications)
    ? payload.notifications.map(normalizeLocalNotification).filter(Boolean)
    : [];
}

export async function releaseLocalNotification(coreUrl, id, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(new URL("/api/notifications/release", coreUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!response.ok) {
    throw new Error("无法重新排队本机通知");
  }
}

export function normalizeLocalNotification(notification) {
  if (!notification || typeof notification !== "object") return null;
  const id = Number(notification.id);
  const targetUrl = typeof notification.targetUrl === "string"
    ? notification.targetUrl
    : "";
  const targetCode = typeof notification.targetCode === "string"
    ? notification.targetCode
    : "";
  if (!Number.isSafeInteger(id) || id < 1 || !targetCode || !targetUrl.startsWith("/")) {
    return null;
  }
  return {
    ...notification,
    id,
    targetCode,
    targetUrl,
    title: typeof notification.title === "string" ? notification.title : "Teamline",
    body: typeof notification.body === "string" ? notification.body : "",
  };
}

export function nativeNotificationOptions(notification) {
  return {
    title: notification.title || "Teamline",
    body: notification.body || "",
  };
}
