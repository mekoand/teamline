import { spawn as defaultSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const projectRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const pendingStarts = new Map();

export function ensureLocalCore(options = {}) {
  const requestedUrl = options.url ?? "http://127.0.0.1:4310";
  const localUrl = validateLocalUrl(requestedUrl);
  const coreDataDirectory = resolve(
    options.dataDirectory ?? resolve(projectRoot, ".teamline"),
  );
  const key = `${localUrl.origin}|${coreDataDirectory}`;
  const pending = pendingStarts.get(key);
  if (pending) return pending;

  const promise = ensureLocalCoreOnce({
    ...options,
    url: localUrl,
    dataDirectory: coreDataDirectory,
  });
  pendingStarts.set(key, promise);
  void promise.then(
    () => clearPendingStart(key, promise),
    () => clearPendingStart(key, promise),
  );
  return promise;
}

async function ensureLocalCoreOnce({
  url = "http://127.0.0.1:4310",
  dataDirectory,
  serverScript = resolve(projectRoot, "src/server.ts"),
  bunCommand = process.env.TEAMLINE_BUN_PATH || "bun",
  fetchImpl = globalThis.fetch,
  spawnImpl = defaultSpawn,
  waitMs = 100,
  attempts = 50,
} = {}) {
  const localUrl = validateLocalUrl(url);
  const coreDataDirectory = resolve(dataDirectory);
  const expectedIdentity = localCoreIdentity(coreDataDirectory);
  if (await isLocalCoreAvailable(localUrl, fetchImpl, expectedIdentity)) {
    return { url: localUrl, reused: true };
  }

  const port = Number(localUrl.port || 4310);
  const environment = {
    ...process.env,
    TEAMLINE_PORT: String(port),
    TEAMLINE_DATA_DIR: coreDataDirectory,
  };
  const child = spawnImpl(bunCommand, [serverScript], {
    detached: true,
    stdio: "ignore",
    env: environment,
  });
  let spawnError = null;
  const handleSpawnError = (error) => {
    spawnError = error;
  };
  child.once?.("error", handleSpawnError);
  child.unref?.();

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (spawnError) break;
    if (await isLocalCoreAvailable(localUrl, fetchImpl, expectedIdentity)) {
      child.removeListener?.("error", handleSpawnError);
      return { url: localUrl, reused: false };
    }
    await delay(waitMs);
  }
  child.kill?.();
  if (spawnError) {
    const message = spawnError instanceof Error ? spawnError.message : String(spawnError);
    throw new Error(`无法启动 Local Core：${message}`);
  }
  throw new Error(`无法连接 Local Core：${localUrl.origin}`);
}

function clearPendingStart(key, promise) {
  if (pendingStarts.get(key) === promise) pendingStarts.delete(key);
}

export async function isLocalCoreAvailable(
  url,
  fetchImpl = globalThis.fetch,
  expectedIdentity,
) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 500);
    try {
      const response = await fetchImpl(new URL("/api/local-core/health", url), {
        signal: controller.signal,
      });
      if (!response.ok) return false;
      const payload = await response.json();
      return (
        payload?.service === "teamline-local-core" &&
        (!expectedIdentity || payload.identity === expectedIdentity)
      );
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return false;
  }
}

export function localCoreIdentity(dataDirectory) {
  return createHash("sha256")
    .update(resolve(dataDirectory))
    .digest("hex")
    .slice(0, 16);
}

function validateLocalUrl(value) {
  const localUrl = value instanceof URL ? new URL(value) : new URL(value);
  if (
    localUrl.protocol !== "http:" ||
    !loopbackHosts.has(localUrl.hostname) ||
    localUrl.username ||
    localUrl.password ||
    (localUrl.pathname !== "/" && localUrl.pathname !== "") ||
    localUrl.search ||
    localUrl.hash
  ) {
    throw new Error("Local Core URL must use the loopback HTTP interface");
  }
  localUrl.pathname = "/";
  return localUrl;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
