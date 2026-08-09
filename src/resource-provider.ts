import type { ExecutionIdentity } from "./execution-identity";
import { codexProcessEnvironment } from "./codex-environment";

export type ResourceAvailability =
  | "available"
  | "loading"
  | "unavailable"
  | "stale"
  | "conflict"
  | "error"
  | "not_connected";

export const RESOURCE_SIGNAL_STALE_AFTER_MS = 5 * 60_000;

export type QuotaWindow = {
  usedPercent: number;
  windowMinutes: number;
  resetsAt: string;
};

export type CodexResourceSignal = {
  status: ResourceAvailability;
  source: "codex-app-server";
  observedAt: string;
  message: string | null;
  shortWindow: QuotaWindow | null;
  longWindow: QuotaWindow | null;
};

export type OpenAIAccountUsage = {
  amount: number;
  unit: "usd" | "tokens";
  periodStart: string;
  periodEnd: string;
};

export type OpenAIResourceSignal = {
  status: ResourceAvailability;
  source: "openai-usage-api" | null;
  observedAt: string;
  message: string | null;
  scope: "organization" | "project" | "api_key" | null;
  usage: OpenAIAccountUsage | null;
};

/**
 * Adapters may add a work-order usage row only when their source provides an
 * explicit Teamline work-order identifier. Account aggregates must stay out of
 * this list and are never apportioned by runtime, title, repository, or guess.
 */
export type WorkOrderUsage = {
  workOrderId: string;
  amount: number;
  unit: "usd" | "tokens";
  observedAt: string;
  source: "openai-usage-api";
};

export type ResourceProviderSnapshot = {
  observedAt: string;
  codex: CodexResourceSignal;
  openaiApi: OpenAIResourceSignal;
  workOrderUsage: WorkOrderUsage[];
  pendingPaidUsageWorkOrderId?: string | null;
};

export type SessionOrganizationResourceRequest = {
  purpose: "session_organization";
  sessionKey: string;
  sourceKind: string;
  accountId: string | null;
  preference: "low_cost";
};

export type ResourceSelection = {
  tool: string;
  model: string;
  accountId: string | null;
  accountLabel: string | null;
};

export interface SessionOrganizationResourceSelector {
  select(
    request: SessionOrganizationResourceRequest,
    signal?: AbortSignal,
  ): Promise<ResourceSelection | null>;
}

export interface ResourceProvider {
  read(): Promise<ResourceProviderSnapshot>;
  readWithoutCodex?(): Promise<ResourceProviderSnapshot>;
}

export interface CodexIdentityResourceProvider {
  read(identity: ExecutionIdentity): Promise<CodexResourceSignal>;
}

export interface OpenAIUsageProvider {
  read(requestedAt: string): Promise<OpenAIResourceSignal>;
}

type CodexRateLimitWindow = {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
};

type CodexRateLimitBucket = {
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
};

type CodexRateLimitResponse = {
  id?: unknown;
  result?: {
    rateLimits?: CodexRateLimitBucket | null;
    rateLimitsByLimitId?: Record<string, CodexRateLimitBucket> | null;
  };
  error?: unknown;
};

export class CodexAppServerResourceProvider implements ResourceProvider {
  private cachedCodex: CodexResourceSignal | undefined;
  private latestOpenAI: OpenAIResourceSignal | undefined;
  private openaiReadInFlight: Promise<void> | undefined;

  constructor(
    private readonly executable = "codex",
    private readonly codexTimeoutMs = 5_000,
    private readonly openaiUsageProvider?: OpenAIUsageProvider,
    private readonly cacheMs = 60_000,
    private readonly staleAfterMs = RESOURCE_SIGNAL_STALE_AFTER_MS,
    private readonly openaiTimeoutMs = 3_000,
    private readonly now: () => Date = () => new Date(),
    private readonly codexHome?: string,
  ) {}

  async read(): Promise<ResourceProviderSnapshot> {
    const requestedAt = this.now().toISOString();
    this.startOpenAIRead(requestedAt);
    const codex = await this.readCodexSignal();
    return {
      observedAt: requestedAt,
      codex,
      openaiApi: this.currentOpenAI(requestedAt),
      workOrderUsage: [],
    };
  }

  async readWithoutCodex(): Promise<ResourceProviderSnapshot> {
    const requestedAt = this.now().toISOString();
    this.startOpenAIRead(requestedAt);
    return {
      observedAt: requestedAt,
      codex: {
        status: "unavailable",
        source: "codex-app-server",
        observedAt: requestedAt,
        message: "系统 Codex 账号未启用",
        shortWindow: null,
        longWindow: null,
      },
      openaiApi: this.currentOpenAI(requestedAt),
      workOrderUsage: [],
    };
  }

  private startOpenAIRead(requestedAt: string): void {
    if (!this.openaiUsageProvider || this.openaiReadInFlight) return;
    const read = this.readOpenAI(requestedAt).then((signal) => {
      this.latestOpenAI = signal;
    });
    const inFlight = read.finally(() => {
      if (this.openaiReadInFlight === inFlight) {
        this.openaiReadInFlight = undefined;
      }
    });
    this.openaiReadInFlight = inFlight;
  }

  private currentOpenAI(requestedAt: string): OpenAIResourceSignal {
    if (!this.openaiUsageProvider) return disconnectedOpenAIUsage(requestedAt);
    return this.latestOpenAI
      ? openAISignalAt(this.latestOpenAI, this.now(), this.staleAfterMs)
      : {
        status: "loading",
        source: "openai-usage-api",
        observedAt: requestedAt,
        message: "正在读取可选的 OpenAI API 账户用量",
        scope: null,
        usage: null,
      };
  }

  private async readOpenAI(requestedAt: string): Promise<OpenAIResourceSignal> {
    if (!this.openaiUsageProvider) return disconnectedOpenAIUsage(requestedAt);
    try {
      return await withTimeout(
        this.openaiUsageProvider.read(requestedAt),
        this.openaiTimeoutMs,
        "OpenAI API usage request timed out",
      );
    } catch {
      return {
        status: "error",
        source: "openai-usage-api",
        observedAt: this.now().toISOString(),
        message: "OpenAI API 用量读取失败或超时，请检查连接后重试",
        scope: null,
        usage: null,
      };
    }
  }

  async readCodexSignal(): Promise<CodexResourceSignal> {
    const now = this.now();
    if (
      this.cachedCodex &&
      now.getTime() - Date.parse(this.cachedCodex.observedAt) < this.cacheMs
    ) {
      return codexSignalAt(this.cachedCodex, now, this.staleAfterMs);
    }

    try {
      const result = await this.readCodexBucket();
      const observedAt = this.now().toISOString();
      if ("conflict" in result) {
        return {
          status: "conflict",
          source: "codex-app-server",
          observedAt,
          message: "Codex 返回了不一致的额度窗口，等待重新读取",
          shortWindow: null,
          longWindow: null,
        };
      }
      const bucket = result.bucket;
      const classified = classifyWindows(
        parseWindow(bucket.primary),
        parseWindow(bucket.secondary),
      );
      if (!classified.shortWindow && !classified.longWindow) {
        return {
          status: "unavailable",
          source: "codex-app-server",
          observedAt,
          message: "Codex 已连接，但没有返回可用的额度窗口",
          shortWindow: null,
          longWindow: null,
        };
      }
      const signal: CodexResourceSignal = {
        status: "available",
        source: "codex-app-server",
        observedAt,
        message: null,
        ...classified,
      };
      this.cachedCodex = signal;
      return codexSignalAt(signal, this.now(), this.staleAfterMs);
    } catch {
      if (this.cachedCodex) {
        return codexSignalAt(this.cachedCodex, this.now(), this.staleAfterMs);
      }
      return {
        status: "error",
        source: "codex-app-server",
        observedAt: this.now().toISOString(),
        message: "Codex 额度读取失败，请确认已经安装并登录 Codex 后重试",
        shortWindow: null,
        longWindow: null,
      };
    }
  }

  private async readCodexBucket(): Promise<
    { bucket: CodexRateLimitBucket } | { conflict: true }
  > {
    const subprocess = Bun.spawn([this.executable, "app-server"], {
      env: codexProcessEnvironment(
        this.codexHome ? { codexHome: this.codexHome } : {},
      ),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const writer = subprocess.stdin;
    writer.write(
      `${JSON.stringify({
        method: "initialize",
        id: 0,
        params: {
          clientInfo: {
            name: "teamline",
            title: "Teamline",
            version: "0.1.0",
          },
        },
      })}\n`,
    );
    writer.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    writer.write(
      `${JSON.stringify({ method: "account/rateLimits/read", id: 6 })}\n`,
    );
    writer.flush();

    try {
      const response = await withTimeout(
        readRateLimitResponse(subprocess.stdout),
        this.codexTimeoutMs,
        "Codex app-server rate limit request timed out",
      );
      if (response.error || !response.result) {
        throw new Error("Codex app-server did not return rate limits");
      }
      const aggregate = response.result.rateLimits;
      const named = response.result.rateLimitsByLimitId?.codex;
      if (aggregate && named && !rateLimitBucketsAgree(aggregate, named)) {
        return { conflict: true };
      }
      const bucket = named ?? aggregate;
      if (!bucket) {
        throw new Error("Codex app-server returned no Codex quota bucket");
      }
      return { bucket };
    } finally {
      writer.end();
      subprocess.kill();
    }
  }
}

export class CodexExecutionIdentityResourceProvider
  implements CodexIdentityResourceProvider
{
  private readonly providers = new Map<string, CodexAppServerResourceProvider>();

  constructor(
    private readonly executable = "codex",
    private readonly systemHome: string,
    private readonly timeoutMs = 5_000,
    private readonly cacheMs = 60_000,
    private readonly staleAfterMs = RESOURCE_SIGNAL_STALE_AFTER_MS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async read(identity: ExecutionIdentity): Promise<CodexResourceSignal> {
    const codexHome = identity.homeKind === "managed"
      ? identity.managedHomePath
      : this.systemHome;
    if (!codexHome) throw new Error("Codex 账号目录不可用");
    let provider = this.providers.get(identity.id);
    if (!provider) {
      provider = new CodexAppServerResourceProvider(
        this.executable,
        this.timeoutMs,
        undefined,
        this.cacheMs,
        this.staleAfterMs,
        3_000,
        this.now,
        codexHome,
      );
      this.providers.set(identity.id, provider);
    }
    return provider.readCodexSignal();
  }
}

function rateLimitBucketsAgree(
  left: CodexRateLimitBucket,
  right: CodexRateLimitBucket,
): boolean {
  return (
    JSON.stringify(classifyWindows(parseWindow(left.primary), parseWindow(left.secondary))) ===
    JSON.stringify(classifyWindows(parseWindow(right.primary), parseWindow(right.secondary)))
  );
}

type OpenAICostsResponse = {
  data?: Array<{
    results?: Array<{
      amount?: { value?: unknown; currency?: unknown };
    }>;
  }>;
  has_more?: unknown;
};

export class OpenAIOrganizationUsageProvider implements OpenAIUsageProvider {
  private cached: OpenAIResourceSignal | undefined;

  constructor(
    private readonly adminKey: string,
    private readonly projectId?: string,
    private readonly fetcher: (request: Request) => Promise<Response> = fetch,
    private readonly now: () => Date = () => new Date(),
    private readonly cacheMs = 60_000,
    private readonly staleAfterMs = RESOURCE_SIGNAL_STALE_AFTER_MS,
    private readonly timeoutMs = 3_000,
  ) {}

  async read(_requestedAt: string): Promise<OpenAIResourceSignal> {
    const now = this.now();
    if (
      this.cached &&
      now.getTime() - Date.parse(this.cached.observedAt) < this.cacheMs
    ) {
      return openAISignalAt(this.cached, now, this.staleAfterMs);
    }

    const periodStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const url = new URL("https://api.openai.com/v1/organization/costs");
    url.searchParams.set("start_time", String(periodStart.getTime() / 1_000));
    url.searchParams.set("limit", "31");
    if (this.projectId) {
      url.searchParams.append("project_ids", this.projectId);
    }
    const controller = new AbortController();
    try {
      const response = await withTimeout(
        this.fetcher(
          new Request(url, {
            signal: controller.signal,
            headers: {
              authorization: `Bearer ${this.adminKey}`,
              "content-type": "application/json",
            },
          }),
        ),
        this.timeoutMs,
        "OpenAI Usage API request timed out",
        () => controller.abort(),
      );
      if (!response.ok) {
        throw new Error("OpenAI Usage API request failed");
      }
      const body = (await response.json()) as OpenAICostsResponse;
      if (!Array.isArray(body.data) || body.has_more === true) {
        throw new Error("OpenAI Usage API returned incomplete costs");
      }
      let amount = 0;
      for (const bucket of body.data) {
        if (!Array.isArray(bucket.results)) {
          throw new Error("OpenAI Usage API returned malformed cost buckets");
        }
        for (const result of bucket.results) {
          if (
            typeof result.amount?.value !== "number" ||
            !Number.isFinite(result.amount.value) ||
            result.amount.currency !== "usd"
          ) {
            throw new Error("OpenAI Usage API returned invalid costs");
          }
          amount += result.amount.value;
        }
      }
      const observedAt = this.now().toISOString();
      const signal: OpenAIResourceSignal = {
        status: "available",
        source: "openai-usage-api",
        observedAt,
        message: null,
        scope: this.projectId ? "project" : "organization",
        usage: {
          amount,
          unit: "usd",
          periodStart: periodStart.toISOString(),
          periodEnd: observedAt,
        },
      };
      this.cached = signal;
      return signal;
    } catch (error) {
      if (this.cached) {
        return openAISignalAt(this.cached, this.now(), this.staleAfterMs);
      }
      throw error;
    }
  }
}

export class UnavailableResourceProvider implements ResourceProvider {
  async read(): Promise<ResourceProviderSnapshot> {
    return unavailableResourceSnapshot();
  }
}

export function unavailableResourceSnapshot(
  message = "暂时无法读取 Codex 额度，请确认已经安装并登录 Codex",
  observedAt = new Date().toISOString(),
  status: Extract<ResourceAvailability, "unavailable" | "error"> = "unavailable",
): ResourceProviderSnapshot {
  return {
    observedAt,
    codex: {
      status,
      source: "codex-app-server",
      observedAt,
      message,
      shortWindow: null,
      longWindow: null,
    },
    openaiApi: disconnectedOpenAIUsage(observedAt),
    workOrderUsage: [],
  };
}

function disconnectedOpenAIUsage(observedAt: string): OpenAIResourceSignal {
  return {
    status: "not_connected",
    source: null,
    observedAt,
    message:
      "未连接 OpenAI API 用量；如需连接，可在本地服务环境设置 OPENAI_ADMIN_KEY 后重启",
    scope: null,
    usage: null,
  };
}

export function codexSignalAt(
  signal: CodexResourceSignal,
  now: Date,
  staleAfterMs: number,
): CodexResourceSignal {
  const age = now.getTime() - Date.parse(signal.observedAt);
  const resetHasPassed = [signal.shortWindow, signal.longWindow]
    .filter((window): window is QuotaWindow => window !== null)
    .some((window) => Date.parse(window.resetsAt) <= now.getTime());
  if (age <= staleAfterMs && !resetHasPassed) return signal;
  return {
    status: "stale",
    source: "codex-app-server",
    observedAt: signal.observedAt,
    message: resetHasPassed
      ? "额度窗口已经重置，需要重新读取后才能显示精确值"
      : "额度数据已过期，需要重新读取后才能显示精确值",
    shortWindow: null,
    longWindow: null,
  };
}

function openAISignalAt(
  signal: OpenAIResourceSignal,
  now: Date,
  staleAfterMs: number,
): OpenAIResourceSignal {
  if (now.getTime() - Date.parse(signal.observedAt) <= staleAfterMs) return signal;
  return {
    status: "stale",
    source: signal.source,
    observedAt: signal.observedAt,
    message: "OpenAI API 账户用量已过期，需要重新读取后才能显示精确值",
    scope: signal.scope,
    usage: null,
  };
}

function parseWindow(value: CodexRateLimitWindow | null | undefined) {
  if (
    typeof value?.usedPercent !== "number" ||
    !Number.isFinite(value.usedPercent) ||
    value.usedPercent < 0 ||
    value.usedPercent > 100 ||
    typeof value.windowDurationMins !== "number" ||
    !Number.isFinite(value.windowDurationMins) ||
    value.windowDurationMins <= 0 ||
    typeof value.resetsAt !== "number" ||
    !Number.isFinite(value.resetsAt)
  ) {
    return null;
  }
  return {
    usedPercent: value.usedPercent,
    windowMinutes: value.windowDurationMins,
    resetsAt: new Date(value.resetsAt * 1_000).toISOString(),
  };
}

function classifyWindows(
  primary: QuotaWindow | null,
  secondary: QuotaWindow | null,
): { shortWindow: QuotaWindow | null; longWindow: QuotaWindow | null } {
  const windows = [primary, secondary]
    .filter((window): window is QuotaWindow => window !== null)
    .sort((left, right) => left.windowMinutes - right.windowMinutes);
  if (windows.length >= 2) {
    return { shortWindow: windows[0]!, longWindow: windows.at(-1)! };
  }
  const onlyWindow = windows[0];
  if (!onlyWindow) return { shortWindow: null, longWindow: null };
  return onlyWindow.windowMinutes <= 24 * 60
    ? { shortWindow: onlyWindow, longWindow: null }
    : { shortWindow: null, longWindow: onlyWindow };
}

async function readRateLimitResponse(
  stream: ReadableStream<Uint8Array>,
): Promise<CodexRateLimitResponse> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  while (true) {
    const { done, value } = await reader.read();
    pending += value ?? "";
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as CodexRateLimitResponse;
      if (parsed.id === 6) return parsed;
    }
    if (done) break;
  }
  if (pending.trim()) {
    const parsed = JSON.parse(pending) as CodexRateLimitResponse;
    if (parsed.id === 6) return parsed;
  }
  throw new Error("Codex app-server ended before returning rate limits");
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout?: () => void,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        onTimeout?.();
        reject(new Error(message));
      }, timeoutMs);
      timeout.unref?.();
    }),
  ]).finally(() => clearTimeout(timeout));
}
