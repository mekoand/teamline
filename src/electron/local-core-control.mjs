export async function requestLocalCoreStop({
  url,
  fetchImpl = globalThis.fetch,
  confirmStop = async () => true,
  waitMs = 100,
  attempts = 50,
} = {}) {
  const localUrl = normalizeLocalUrl(url);
  const initial = await readActiveWorkOrders(localUrl, fetchImpl);
  const interruptedIds = [];
  if (initial.length) {
    const confirmed = await confirmStop(initial);
    if (!confirmed) {
      return { stopped: false, cancelled: true, interruptedIds: [] };
    }
    for (const workOrder of initial) {
      if (!workOrder.runStatus || workOrder.runStatus === "stopping") continue;
      const response = await fetchImpl(
        new URL(`/api/work-orders/${encodeURIComponent(workOrder.id)}/interrupt`, localUrl),
        { method: "POST" },
      );
      if (!response.ok) {
        throw new Error(await responseError(response, "无法安全停止正在运行的目标"));
      }
      interruptedIds.push(workOrder.id);
    }
  }

  let remaining = initial;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    remaining = await readActiveWorkOrders(localUrl, fetchImpl);
    if (!remaining.length) break;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  if (remaining.length) {
    throw new Error("Local Core 仍有运行中的目标，未执行停止");
  }

  const shutdown = await fetchImpl(new URL("/api/local-core/shutdown", localUrl), {
    method: "POST",
  });
  if (!shutdown.ok) {
    throw new Error(await responseError(shutdown, "无法停止 Local Core"));
  }
  return { stopped: true, cancelled: false, interruptedIds };
}

export async function readActiveWorkOrders(url, fetchImpl = globalThis.fetch) {
  const localUrl = normalizeLocalUrl(url);
  const response = await fetchImpl(new URL("/api/console", localUrl), {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(await responseError(response, "无法读取 Local Core 状态"));
  }
  const payload = await response.json();
  return (payload.workOrders ?? []).filter((workOrder) =>
    ["running", "stopping", "verifying"].includes(workOrder.runStatus),
  );
}

function normalizeLocalUrl(value) {
  const localUrl = value instanceof URL ? new URL(value) : new URL(value);
  if (
    localUrl.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]", "::1"].includes(localUrl.hostname)
  ) {
    throw new Error("Local Core URL must use the loopback HTTP interface");
  }
  localUrl.pathname = "/";
  localUrl.search = "";
  localUrl.hash = "";
  return localUrl;
}

async function responseError(response, fallback) {
  try {
    const payload = await response.json();
    return payload.error || payload.message || fallback;
  } catch {
    return fallback;
  }
}
