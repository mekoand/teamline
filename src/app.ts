import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import type { PlanGenerator } from "./plan-generator";
import type { CheckpointManager } from "./checkpoint-manager";
import { presentConsoleWorkOrders } from "./console-presentation";
import type { WorkOrderResultProcessor } from "./result-processor";
import type {
  CodexBillingMode,
  ContinuationContext,
  CodexRunEvent,
  CodexRunner,
  StartedCodexRun,
} from "./codex-runner";
import { CodexCommandNotFoundError } from "./codex-runner";
import {
  workOrderMaterialKinds,
  type PlanStageInput,
  type PlanStage,
  type WorkOrderMaterialKind,
  type WorkOrderImportSource,
  type WorkOrderCheckpoint,
  type WorkOrderWorkspace,
  type WorkOrder,
  type WorkOrderResult,
  type WorkOrderSourceContext,
  type WorkOrderImportContext,
} from "./work-order";
import {
  PlanLockedError,
  WorkOrderNotFoundError,
  type WorkOrderStore,
} from "./work-order-store";
import { projectMaterialKinds, type ProjectMaterialKind } from "./project";
import type { DelegatedWorktree, WorktreeManager } from "./worktree-manager";
import {
  codexSignalAt,
  RESOURCE_SIGNAL_STALE_AFTER_MS,
  unavailableResourceSnapshot,
  type CodexIdentityResourceProvider,
  type CodexResourceSignal,
  type ResourceProvider,
  type ResourceProviderSnapshot,
  type SessionOrganizationResourceSelector,
} from "./resource-provider";
import { decidePaidApiRun } from "./paid-api-budget";
import {
  presentIdentityQuota,
  presentResources,
  type IdentityQuotaObservation,
} from "./resource-presentation";
import {
  decideAutoRun,
  quotaBlockingReason,
  type AutoRunIdentityContext,
} from "./resource-scheduler";
import type {
  CodexSessionProvider,
} from "./codex-session-discovery";
import type { DiscoveredSession, SessionProvider } from "./session-discovery";
import type { SessionOrganizer } from "./session-organizer";
import {
  sessionMonitoringKey,
  sessionMonitoringRefreshModes,
  type SessionMonitoringRefreshMode,
  type SessionMonitoringWork,
  type SessionMonitoringRecord,
  type SessionMonitoringUpdate,
} from "./session-monitoring";
import {
  assertStateBundleSize,
  InvalidStateBundleError,
  LocalStateTransfer,
  RestoreChoiceRequiredError,
  RestorePreviewMissingError,
  RestorePreviewStaleError,
} from "./local-state-transfer";
import { presentExecutionIdentity, type ExecutionIdentity } from "./execution-identity";
import {
  ExecutionIdentityLoginInProgressError,
  type ExecutionIdentityEnvironment,
} from "./execution-identity-environment";
import { normalizeLocale } from "./i18n";
import {
  ensureSemanticErrorResponse,
  semanticMessageFromLegacy,
} from "./semantic-message";

type AppDependencies = {
  store: WorkOrderStore;
  planGenerator?: PlanGenerator;
  planGenerationTimeoutMs?: number;
  projectRoot?: string;
  codexRunner?: CodexRunner;
  worktreeManager?: WorktreeManager;
  resultProcessor?: WorkOrderResultProcessor;
  runTimeoutScheduler?: (
    callback: () => void,
    delayMs: number,
  ) => () => void;
  resourceProvider?: ResourceProvider;
  identityResourceProvider?: CodexIdentityResourceProvider;
  checkpointManager?: CheckpointManager;
  autoRunRetryScheduler?: (
    callback: () => void,
    delayMs: number,
  ) => () => void;
  autoRunRetryMs?: number;
  backgroundNow?: () => number;
  wakeDetectionThresholdMs?: number;
  codexSessionProvider?: CodexSessionProvider;
  codexSessionProviderForIdentity?: (
    identity: ExecutionIdentity,
  ) => SessionProvider | undefined;
  claudeCodeSessionProvider?: SessionProvider;
  sessionOrganizer?: SessionOrganizer;
  sessionOrganizationTimeoutMs?: number;
  sessionOrganizationScheduler?: (callback: () => void) => void;
  sessionOrganizationResourceSelector?: SessionOrganizationResourceSelector;
  sessionMonitoringScheduler?: (callback: () => void, delayMs: number) => () => void;
  sessionMonitoringIntervalMs?: number;
  sessionMonitoringConcurrency?: number;
  sessionMonitoringNow?: () => number;
  dataDirectory?: string;
  executionIdentityEnvironment?: ExecutionIdentityEnvironment;
  openLocalArtifact?: (path: string, reveal: boolean) => Promise<void>;
};

type SessionMonitoringSourceResult = {
  sourceKind: SessionMonitoringRecord["sourceKind"];
  executionIdentityId: string | null;
  executionIdentityLabel: string | null;
  status: "available" | "partial" | "unavailable";
  message: string;
  sessions: DiscoveredSession[];
  provider?: SessionProvider;
};

type NextStageRun = {
  run: StartedCodexRun;
  executionIdentityId: string;
  fallback?: () => Promise<StartedCodexRun | null>;
  retryTransient?: () => Promise<StartedCodexRun | null>;
};

class PlanGenerationTimeoutError extends Error {}

const SESSION_MONITORING_AUTOMATIC_COOLDOWN_MS = 5 * 60_000;

const staticFiles: Record<string, { path: string; type: string }> = {
  "/": { path: "public/index.html", type: "text/html; charset=utf-8" },
  "/app.js": { path: "public/app.js", type: "text/javascript; charset=utf-8" },
  "/context-inspector.js": {
    path: "public/context-inspector.js",
    type: "text/javascript; charset=utf-8",
  },
  "/goal-workbench.js": {
    path: "public/goal-workbench.js",
    type: "text/javascript; charset=utf-8",
  },
  "/i18n.js": {
    path: "public/i18n.js",
    type: "text/javascript; charset=utf-8",
  },
  "/navigation-state.js": {
    path: "public/navigation-state.js",
    type: "text/javascript; charset=utf-8",
  },
  "/result-artifacts.js": {
    path: "public/result-artifacts.js",
    type: "text/javascript; charset=utf-8",
  },
  "/session-monitoring-graph.js": {
    path: "public/session-monitoring-graph.js",
    type: "text/javascript; charset=utf-8",
  },
  "/styles.css": { path: "public/styles.css", type: "text/css; charset=utf-8" },
  "/teamline-logo.png": { path: "public/teamline-logo.png", type: "image/png" },
};

export function createApp({
  store,
  planGenerator,
  planGenerationTimeoutMs = 5 * 60 * 1000,
  projectRoot = resolve(import.meta.dir, ".."),
  codexRunner,
  worktreeManager,
  resultProcessor,
  runTimeoutScheduler = scheduleTimeout,
  resourceProvider,
  identityResourceProvider,
  checkpointManager,
  autoRunRetryScheduler = scheduleTimeout,
  autoRunRetryMs = 60_000,
  backgroundNow = Date.now,
  wakeDetectionThresholdMs = Math.max(autoRunRetryMs, 5_000),
  codexSessionProvider,
  codexSessionProviderForIdentity,
  claudeCodeSessionProvider,
  sessionOrganizer,
  sessionOrganizationTimeoutMs = 5 * 60 * 1000,
  sessionOrganizationScheduler = scheduleBackgroundTask,
  sessionOrganizationResourceSelector,
  sessionMonitoringScheduler = scheduleTimeout,
  sessionMonitoringIntervalMs = 60_000,
  sessionMonitoringConcurrency = 2,
  sessionMonitoringNow = Date.now,
  dataDirectory = join(projectRoot, ".teamline"),
  executionIdentityEnvironment,
  openLocalArtifact = openLocalArtifactWithSystem,
}: AppDependencies) {
  const startingWorkOrderIds = new Set<string>();
  const planningWorkOrderIds = new Set<string>();
  const organizingWorkOrderIds = new Set<string>();
  const organizationControllers = new Map<string, AbortController>();
  const backgroundOrganizationPromises = new Set<Promise<unknown>>();
  const monitoringControllers = new Map<string, AbortController>();
  const backgroundMonitoringPromises = new Set<Promise<unknown>>();
  const monitoringKeys = new Set<string>();
  type SessionMonitoringQueueEntry = {
    run: () => Promise<void>;
    onError?: (error: unknown) => void;
    mode: SessionMonitoringRefreshMode | "initial";
  };
  const monitoringPending = new Map<string, SessionMonitoringQueueEntry>();
  const monitoringDeferred = new Map<string, SessionMonitoringQueueEntry>();
  const monitoringConcurrency = Number.isFinite(sessionMonitoringConcurrency)
    ? Math.max(1, Math.floor(sessionMonitoringConcurrency))
    : 2;
  let monitoringActiveCount = 0;
  let sessionMonitoringDiscoveryInFlight: Promise<unknown> | null = null;
  let sessionMonitoringDiscoveryController: AbortController | null = null;
  type SessionMonitoringPreview = {
    record: SessionMonitoringRecord;
    candidateKey: string;
  };
  let sessionMonitoringPreview: Map<string, SessionMonitoringPreview> | null = null;
  let sessionMonitoringPreviewAt: string | null = null;
  let sessionMonitoringPreviewForAdd = false;
  let sessionMonitoringOnboardingDismissed = false;
  let closed = false;
  const startingWorkspacePaths = new Map<string, string>();
  const startingExecutionIdentityIds = new Map<string, string>();
  const activeRuns = new Map<string, StartedCodexRun>();
  const runTimeouts = new Map<string, () => void>();
  const stopReasons = new Map<string, string>();
  let latestIdentityQuota: IdentityQuotaObservation[] = [];
  const localStateTransfer = new LocalStateTransfer(store);
  const codexDiscoverySource = (executionIdentityId?: string | null) => {
    const identityId = executionIdentityId || store.getSystemExecutionIdentityId();
    const identity = identityId ? store.getExecutionIdentity(identityId) : null;
    if (!identity || identity.status === "removed") {
      throw new Error("找不到会话来源对应的 Codex 账号");
    }
    const provider = codexSessionProviderForIdentity?.(identity) ??
      (identity.homeKind === "system" ? codexSessionProvider : undefined);
    return { identity, provider };
  };
  const sessionProviderForSource = (
    kind: WorkOrderImportSource["kind"],
    executionIdentityId?: string | null,
  ): SessionProvider | undefined =>
    kind === "claude_code_session"
      ? claudeCodeSessionProvider
      : codexDiscoverySource(executionIdentityId).provider;

  const visibleSessionMonitoring = (workOrders = store.list()) =>
    store
      .listSessionMonitoring()
      .filter(
        (session) =>
          !isTeamlineExecutionSession(
            workOrders,
            session.executionIdentityId,
            session.id,
          ),
      );

  const discoverSessionMonitoring = async (signal?: AbortSignal) => {
    if (closed) return sessionMonitoringState();
    const discoveredAt = new Date().toISOString();
    const previousRecords = new Map(
      store.listSessionMonitoring().map((record) => [record.key, record]),
    );
    const identities = store
      .listExecutionIdentities()
      .filter((identity) => identity.tool === "codex" && identity.status !== "removed");
    const codexResults: SessionMonitoringSourceResult[] = await Promise.all(
      identities.map(async (identity) => {
        const provider = codexSessionProviderForIdentity?.(identity) ??
          (identity.homeKind === "system" ? codexSessionProvider : undefined);
        if (!provider) {
          return {
            sourceKind: "codex_session" as const,
            executionIdentityId: identity.id,
            executionIdentityLabel: identity.label,
            status: "unavailable" as const,
            message: "这个 Codex 账号的会话发现服务尚未配置",
            sessions: [] as DiscoveredSession[],
          };
        }
        try {
          const result = await discoverSessionProvider(
            provider,
            "Codex",
            sessionOrganizationTimeoutMs,
            signal,
          );
          return {
            sourceKind: "codex_session" as const,
            executionIdentityId: identity.id,
            executionIdentityLabel: identity.label,
            ...result,
            provider,
          };
        } catch {
          return {
            sourceKind: "codex_session" as const,
            executionIdentityId: identity.id,
            executionIdentityLabel: identity.label,
            status: "unavailable" as const,
            message: "暂时无法读取这个 Codex 账号的本机会话",
            sessions: [] as DiscoveredSession[],
            provider,
          };
        }
      }),
    );
    const claudeResult: SessionMonitoringSourceResult = claudeCodeSessionProvider
      ? await discoverSessionProvider(
          claudeCodeSessionProvider,
          "Claude Code",
          sessionOrganizationTimeoutMs,
          signal,
        )
          .then((result) => ({
            sourceKind: "claude_code_session" as const,
            executionIdentityId: null,
            executionIdentityLabel: null,
            ...result,
            provider: claudeCodeSessionProvider,
          }))
      : {
          sourceKind: "claude_code_session" as const,
          executionIdentityId: null,
          executionIdentityLabel: null,
          status: "unavailable" as const,
          message: "Claude Code 会话发现服务尚未配置",
          sessions: [] as DiscoveredSession[],
        };
    const sourceResults: SessionMonitoringSourceResult[] = [
      ...codexResults,
      claudeResult,
    ];
    if (closed) return sessionMonitoringState();
    if (
      !sessionMonitoringOnboardingDismissed &&
      (sessionMonitoringPreviewForAdd ||
        (previousRecords.size === 0 &&
          store.listProjects().length === 0 &&
          store.list().length === 0))
    ) {
      sessionMonitoringPreview = new Map();
      for (const result of sourceResults) {
        for (const session of result.sessions) {
          if (
            result.sourceKind === "codex_session" &&
            isTeamlineExecutionSession(store.list(), result.executionIdentityId, session.id)
          ) {
            continue;
          }
          const key = sessionMonitoringKey(
            result.sourceKind,
            result.executionIdentityId,
            session.id,
          );
          sessionMonitoringPreview.set(key, {
            candidateKey: monitoringCandidateKey(session),
            record: previewSessionMonitoringRecord(
              key,
              result,
              session,
              discoveredAt,
            ),
          });
        }
      }
      sessionMonitoringPreviewAt = discoveredAt;
      return sessionMonitoringOnboardingState(sourceResults);
    }
    const workOrders = store.list();
    const seenKeys = new Set<string>();
    let excludedCount = 0;
    for (const result of sourceResults) {
      for (const session of result.sessions) {
        if (
          result.sourceKind === "codex_session" &&
          isTeamlineExecutionSession(workOrders, result.executionIdentityId, session.id)
        ) {
          excludedCount += 1;
          continue;
        }
        const key = sessionMonitoringKey(
          result.sourceKind,
          result.executionIdentityId,
          session.id,
        );
        seenKeys.add(key);
        const previous = previousRecords.get(key);
        const sourceChanged = !previous || sessionMonitoringSourceChanged(previous, session);
        store.upsertDiscoveredSession({
          key,
          sourceKind: result.sourceKind,
          executionIdentityId: result.executionIdentityId,
          executionIdentityLabel: result.executionIdentityLabel,
          id: session.id,
          title: session.title,
          workspacePath: session.workspacePath,
          projectLabel: session.projectLabel,
          lastActiveAt: session.lastActiveAt,
          sourcePath: session.sourcePath,
          sourcePosition: session.sourcePosition,
          sourceModifiedAt: session.sourceModifiedAt,
          availability: session.availability,
          message:
            previous?.organizationStatus === "failed" && !sourceChanged
              ? previous.message
              : session.message,
          lastDiscoveredAt: discoveredAt,
        });
      }
    }
    for (const previous of previousRecords.values()) {
      if (seenKeys.has(previous.key)) continue;
      const sourceResult = sourceResults.find(
        (result) =>
          result.sourceKind === previous.sourceKind &&
          result.executionIdentityId === previous.executionIdentityId,
      );
      const knownCandidate = previous.monitoringEnabled
        ? sessionMonitoringCandidateFromRecord(previous)
        : null;
      if (knownCandidate && sourceResult?.provider) {
        seenKeys.add(previous.key);
        sourceResult.sessions.push(knownCandidate);
        store.upsertDiscoveredSession({
          key: previous.key,
          sourceKind: previous.sourceKind,
          executionIdentityId: previous.executionIdentityId,
          executionIdentityLabel: previous.executionIdentityLabel,
          id: knownCandidate.id,
          title: knownCandidate.title,
          workspacePath: knownCandidate.workspacePath,
          projectLabel: knownCandidate.projectLabel,
          lastActiveAt: knownCandidate.lastActiveAt,
          sourcePath: knownCandidate.sourcePath,
          sourcePosition: knownCandidate.sourcePosition,
          sourceModifiedAt: knownCandidate.sourceModifiedAt,
          availability: knownCandidate.availability,
          message: previous.organizationStatus === "failed"
            ? previous.message
            : knownCandidate.message,
          lastDiscoveredAt: discoveredAt,
        });
        continue;
      }
      const sourceStillExists = Boolean(previous.sourcePath && existsSync(previous.sourcePath));
      if (sourceResult?.status !== "unavailable" && sourceStillExists) continue;
      const message = sourceResult?.message || "来源会话当前不可用，请重试";
      store.upsertDiscoveredSession({
        key: previous.key,
        sourceKind: previous.sourceKind,
        executionIdentityId: previous.executionIdentityId,
        executionIdentityLabel: previous.executionIdentityLabel,
        id: previous.id,
        title: previous.title,
        workspacePath: previous.workspacePath,
        projectLabel: previous.projectLabel,
        lastActiveAt: previous.lastActiveAt,
        sourcePath: null,
        sourcePosition: null,
        sourceModifiedAt: null,
        availability: "unavailable",
        message,
        lastDiscoveredAt: discoveredAt,
      });
      if (previous.monitoringEnabled) {
        store.updateSessionMonitoring(previous.key, {
          organizationStatus: "failed",
          message,
        });
      }
    }
    store.saveSessionMonitoringDiscoveryAt(discoveredAt);
    const pendingWorkIdsBeforeDiscovery = new Set(
      store
        .listSessionMonitoringWorks()
        .filter((work) => work.pendingRefreshIntent)
        .map((work) => work.id),
    );
    queueSessionMonitoringUpdates(previousRecords, sourceResults);
    queuePendingSessionMonitoringUpdates(sourceResults, pendingWorkIdsBeforeDiscovery);
    const sessions = visibleSessionMonitoring();
    const statuses = sourceResults.map((result) => result.status);
    const status = statuses.every((value) => value === "unavailable")
      ? "unavailable"
      : statuses.some((value) => value !== "available")
        ? "partial"
        : "available";
    return {
      status,
      message: `已读取 ${sessions.length} 个本机会话${excludedCount ? `，排除 ${excludedCount} 个 Teamline 执行会话` : ""}`,
      lastScannedAt: discoveredAt,
      excludedCount,
      projects: store.listProjects(),
      sessions: sessions.map(presentSessionMonitoring),
      monitoringWorks: presentSessionMonitoringWorks(
        store.listSessionMonitoringWorks(),
        store.listSessionMonitoring(),
      ),
      projectMonitoringDefaults: store.listProjectMonitoringDefaults(),
      automaticRefreshEnabled: store.getSessionMonitoringAutomaticRefreshEnabled(),
      onboarding: false,
      onboardingDismissed: sessionMonitoringOnboardingDismissed,
    };
  };

  const discoverSessionMonitoringOnce = () => {
    if (sessionMonitoringDiscoveryInFlight) return sessionMonitoringDiscoveryInFlight;
    const controller = new AbortController();
    sessionMonitoringDiscoveryController = controller;
    const task = discoverSessionMonitoring(controller.signal).finally(() => {
      if (sessionMonitoringDiscoveryInFlight === task) {
        sessionMonitoringDiscoveryInFlight = null;
      }
      if (sessionMonitoringDiscoveryController === controller) {
        sessionMonitoringDiscoveryController = null;
      }
    });
    sessionMonitoringDiscoveryInFlight = task;
    return task;
  };

  const sessionMonitoringOnboardingState = (
    sourceResults: SessionMonitoringSourceResult[],
  ) => {
    const previewRecords = [...(sessionMonitoringPreview?.values() ?? [])]
      .map(({ record }) => record);
    const sourceLabels = new Map(
      sourceResults.map((result) => [
        `${result.sourceKind}:${result.executionIdentityId ?? "none"}`,
        result.sourceKind === "claude_code_session"
          ? "Claude Code"
          : result.executionIdentityLabel || "Codex",
      ]),
    );
    const tools = presentSessionMonitoringOnboardingTools(previewRecords, sourceLabels);
    return {
      status: previewRecords.length ? "available" : "unavailable",
      message: previewRecords.length
        ? "请选择要加入 Teamline 的本地工作"
        : "没有发现可加入的本地会话",
      lastScannedAt: sessionMonitoringPreviewAt,
      projects: store.listProjects(),
      sessions: previewRecords.map(presentSessionMonitoring),
      candidates: presentSessionMonitoringOnboardingCandidates(previewRecords, tools),
      tools,
      monitoringWorks: presentSessionMonitoringWorks(
        store.listSessionMonitoringWorks(),
        store.listSessionMonitoring(),
      ),
      projectMonitoringDefaults: store.listProjectMonitoringDefaults(),
      automaticRefreshEnabled: store.getSessionMonitoringAutomaticRefreshEnabled(),
      onboarding: true,
      onboardingDismissed: false,
    };
  };

  const sessionMonitoringState = () => {
    if (sessionMonitoringPreview && !sessionMonitoringOnboardingDismissed) {
      return sessionMonitoringOnboardingState([]);
    }
    const sessions = visibleSessionMonitoring();
    return {
      status: sessions.length ? "available" : "unavailable",
      message: sessions.length ? "本机会话目录已保存" : "还没有扫描本机会话",
      lastScannedAt: store.getLastSessionMonitoringDiscoveryAt(),
      projects: store.listProjects(),
      sessions: sessions.map(presentSessionMonitoring),
      monitoringWorks: presentSessionMonitoringWorks(
        store.listSessionMonitoringWorks(),
        store.listSessionMonitoring(),
      ),
      projectMonitoringDefaults: store.listProjectMonitoringDefaults(),
      automaticRefreshEnabled: store.getSessionMonitoringAutomaticRefreshEnabled(),
      onboarding: false,
      onboardingDismissed: sessionMonitoringOnboardingDismissed,
    };
  };

  const materializePreviewSession = (
    key: string,
    update: SessionMonitoringUpdate = {},
  ): SessionMonitoringRecord => {
    const existing = store.getSessionMonitoring(key);
    if (existing) return existing;
    const preview = sessionMonitoringPreview?.get(key);
    if (!preview) throw new Error("找不到所选来源会话");
    const projectId = update.projectId !== undefined ? update.projectId : null;
    const monitoringOverride = update.monitoringOverride !== undefined
      ? update.monitoringOverride
      : update.monitoringEnabled !== undefined
        ? Boolean(update.monitoringEnabled)
        : null;
    store.upsertDiscoveredSession({
      key: preview.record.key,
      sourceKind: preview.record.sourceKind,
      executionIdentityId: preview.record.executionIdentityId,
      executionIdentityLabel: preview.record.executionIdentityLabel,
      id: preview.record.id,
      title: preview.record.title,
      workspacePath: preview.record.workspacePath,
      projectLabel: preview.record.projectLabel,
      lastActiveAt: preview.record.lastActiveAt,
      sourcePath: preview.record.sourcePath,
      sourcePosition: preview.record.sourcePosition,
      sourceModifiedAt: preview.record.sourceModifiedAt,
      availability: preview.record.availability,
      message: preview.record.message,
      lastDiscoveredAt: preview.record.lastDiscoveredAt,
      projectId,
      monitoringOverride,
    });
    return store.getSessionMonitoring(key)!;
  };

  const updateSessionMonitoringSelections = (body: unknown) => {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("会话选择格式无效");
    }
    const rawSelections = (body as { sessions?: unknown; selections?: unknown }).sessions ??
      (body as { selections?: unknown }).selections;
    if (!Array.isArray(rawSelections) || rawSelections.length > 200) {
      throw new Error("会话选择格式无效");
    }
    const sessions = rawSelections.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("会话选择格式无效");
      }
      const selection = value as {
        key?: unknown;
        sourceKind?: unknown;
        executionIdentityId?: unknown;
        id?: unknown;
        projectId?: unknown;
        monitoringEnabled?: unknown;
        monitoringOverride?: unknown;
        lastReadPosition?: unknown;
        lastReadAt?: unknown;
        organizationStatus?: unknown;
        workGraphSnapshot?: unknown;
      };
      if (
        selection.sourceKind !== undefined &&
        selection.sourceKind !== "codex_session" &&
        selection.sourceKind !== "claude_code_session"
      ) {
        throw new Error("会话来源工具格式无效");
      }
      const key = typeof selection.key === "string" && selection.key.trim()
        ? selection.key.trim()
        : typeof selection.sourceKind === "string" &&
            (selection.executionIdentityId === null || typeof selection.executionIdentityId === "string") &&
            typeof selection.id === "string"
          ? sessionMonitoringKey(
              selection.sourceKind as SessionMonitoringRecord["sourceKind"],
              selection.executionIdentityId,
              selection.id,
            )
          : "";
      if (!key) throw new Error("会话选择格式无效");
      const update: SessionMonitoringUpdate = {};
      if (selection.projectId !== undefined) {
        if (selection.projectId !== null && typeof selection.projectId !== "string") {
          throw new Error("项目选择格式无效");
        }
        update.projectId = typeof selection.projectId === "string"
          ? selection.projectId.trim() || null
          : null;
      }
      if (selection.monitoringEnabled !== undefined) {
        if (typeof selection.monitoringEnabled !== "boolean") {
          throw new Error("监控开关格式无效");
        }
        update.monitoringEnabled = selection.monitoringEnabled;
      }
      if (selection.monitoringOverride !== undefined) {
        if (
          selection.monitoringOverride !== null &&
          typeof selection.monitoringOverride !== "boolean"
        ) {
          throw new Error("会话显式覆盖格式无效");
        }
        update.monitoringOverride = selection.monitoringOverride;
      }
      if (selection.lastReadPosition !== undefined) {
        if (
          selection.lastReadPosition !== null &&
          typeof selection.lastReadPosition !== "number"
        ) {
          throw new Error("会话读取位置无效");
        }
        update.lastReadPosition = selection.lastReadPosition;
      }
      if (selection.lastReadAt !== undefined) {
        if (selection.lastReadAt !== null && typeof selection.lastReadAt !== "string") {
          throw new Error("会话读取时间无效");
        }
        update.lastReadAt = selection.lastReadAt;
      }
      if (selection.organizationStatus !== undefined) {
        if (
          !["not_started", "pending", "ready", "failed"].includes(
            String(selection.organizationStatus),
          )
        ) {
          throw new Error("会话整理状态无效");
        }
        update.organizationStatus = selection.organizationStatus as SessionMonitoringUpdate["organizationStatus"];
      }
      if (selection.workGraphSnapshot !== undefined) {
        update.workGraphSnapshot = selection.workGraphSnapshot;
      }
      materializePreviewSession(key, update);
      const updated = store.updateSessionMonitoring(key, update);
      if (update.monitoringEnabled === false) {
        monitoringControllers.get(key)?.abort();
      }
      return updated;
    });
    if (sessionMonitoringPreview) {
      const discoveredAt = sessionMonitoringPreviewAt ?? new Date().toISOString();
      sessionMonitoringPreview = null;
      sessionMonitoringPreviewAt = null;
      sessionMonitoringPreviewForAdd = false;
      sessionMonitoringOnboardingDismissed = true;
      store.saveSessionMonitoringDiscoveryAt(discoveredAt);
    }
    scheduleSessionMonitoringScan(0);
    const visibleSessions = visibleSessionMonitoring();
    return {
      sessions: visibleSessions.map(presentSessionMonitoring),
      projects: store.listProjects(),
    };
  };

  const confirmSessionMonitoringOnboarding = (body: unknown) => {
    if (!sessionMonitoringPreview) throw new Error("首次发现已经过期，请重新扫描");
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("首次发现选择格式无效");
    }
    const input = body as Record<string, unknown>;
    if (input.skip === true || input.outcome === "skipped") {
      store.saveSessionMonitoringDiscoveryAt(
        sessionMonitoringPreviewAt ?? new Date().toISOString(),
      );
      sessionMonitoringPreview = null;
      sessionMonitoringPreviewAt = null;
      sessionMonitoringPreviewForAdd = false;
      sessionMonitoringOnboardingDismissed = true;
      return { outcome: "skipped" as const, ...sessionMonitoringState() };
    }
    const rawProjects = input.projects ?? input.candidateProjects;
    if (!Array.isArray(rawProjects) || rawProjects.length > 200) {
      throw new Error("请选择要加入的候选项目");
    }
    const explicitSessionKeys = Array.isArray(input.selectedSessionKeys)
      ? input.selectedSessionKeys
      : Array.isArray(input.sessionKeys)
        ? input.sessionKeys
        : null;
    const allowedSessionKeys = explicitSessionKeys
      ? new Set(explicitSessionKeys.filter((key): key is string => typeof key === "string"))
      : null;
    const previewEntries = [...sessionMonitoringPreview.values()];
    const selectedRecords: Array<{
      key: string;
      candidateKey: string;
      projectName: string;
      monitoringEnabled: boolean;
      workspacePath: string | null;
    }> = [];
    for (const value of rawProjects) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("候选项目选择格式无效");
      }
      const project = value as Record<string, unknown>;
      const candidateKey = typeof (project.candidateKey ?? project.key) === "string"
        ? String(project.candidateKey ?? project.key).trim()
        : "";
      if (!candidateKey) throw new Error("候选项目选择格式无效");
      if (project.selected === false) continue;
      const selectedToolKeys = Array.isArray(project.toolKeys)
        ? new Set(project.toolKeys.filter((key): key is string => typeof key === "string"))
        : null;
      const candidateEntries = previewEntries.filter((entry) =>
        entry.candidateKey === candidateKey &&
        (!allowedSessionKeys || allowedSessionKeys.has(entry.record.key)) &&
        (!selectedToolKeys || selectedToolKeys.has(monitoringToolKey(entry.record))),
      );
      if (!previewEntries.some((entry) => entry.candidateKey === candidateKey)) {
        throw new Error("找不到所选候选项目");
      }
      if (candidateEntries.length === 0) continue;
      const projectName = typeof project.name === "string" && project.name.trim()
        ? project.name.trim()
        : candidateEntries[0]!.record.projectLabel || "未命名项目";
      const monitoringEnabled = typeof project.monitoringEnabled === "boolean"
        ? project.monitoringEnabled
        : typeof project.monitoringDefault === "boolean"
          ? project.monitoringDefault
          : false;
      for (const entry of candidateEntries) {
        selectedRecords.push({
          key: entry.record.key,
          candidateKey,
          projectName,
          monitoringEnabled,
          workspacePath: entry.record.workspacePath,
        });
      }
    }
    if (selectedRecords.length === 0) {
      sessionMonitoringPreview = null;
      sessionMonitoringPreviewAt = null;
      sessionMonitoringPreviewForAdd = false;
      sessionMonitoringOnboardingDismissed = true;
      return { outcome: "skipped" as const, ...sessionMonitoringState() };
    }
    const projectByCandidate = new Map<string, { id: string }>();
    for (const selected of selectedRecords) {
      let project = projectByCandidate.get(selected.candidateKey);
      if (!project) {
        const existingProjectId = selected.workspacePath
          ? store.findProjectForMonitoringWorkspace(selected.workspacePath)
          : null;
        const created = existingProjectId
          ? store.getProject(existingProjectId)!
          : store.createProject(selected.projectName);
        store.setProjectMonitoringDefault(created.id, selected.monitoringEnabled);
        project = { id: created.id };
        projectByCandidate.set(selected.candidateKey, project);
      }
      const record = materializePreviewSession(selected.key, {
        projectId: project.id,
        monitoringOverride: null,
      });
      if (record.workspacePath) {
        store.bindProjectMonitoringWorkspace(project.id, record.workspacePath);
      }
      store.updateSessionMonitoring(selected.key, {
        projectId: project.id,
        monitoringOverride: null,
      });
    }
    sessionMonitoringPreview = null;
    sessionMonitoringPreviewAt = null;
    sessionMonitoringPreviewForAdd = false;
    sessionMonitoringOnboardingDismissed = true;
    store.saveSessionMonitoringDiscoveryAt(new Date().toISOString());
    scheduleSessionMonitoringScan(0);
    return { outcome: "confirmed" as const, ...sessionMonitoringState() };
  };

  const createGoalFromSessionMonitoring = (body: unknown) => {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("监控目标创建格式无效");
    }
    const input = body as Record<string, unknown>;
    const rawKeys = input.sessionKeys ?? input.sourceSessionKeys ?? input.selectedSessionKeys;
    const sessionKeys = normalizeMonitoringSessionKeys(rawKeys);
    const records = sessionKeys.map((key) => {
      const record = store.getSessionMonitoring(key);
      if (!record) throw new Error("找不到所选来源会话");
      if (!record.monitoringEnabled) throw new Error("只能从已启用监控的会话创建目标");
      return record;
    });
    const projectIds = new Set(records.map((record) => record.projectId));
    if (projectIds.size !== 1) throw new Error("所选来源会话必须属于同一个项目");
    const projectId = records[0]!.projectId;
    if (input.projectId !== undefined) {
      const requestedProjectId = input.projectId === null
        ? null
        : typeof input.projectId === "string"
          ? input.projectId.trim() || null
          : "invalid";
      if (requestedProjectId === "invalid" || requestedProjectId !== projectId) {
        throw new Error("目标必须归入来源会话所在的项目");
      }
    }
    const createdAt = new Date().toISOString();
    const sourceContext = createSessionMonitoringSourceContext(records, createdAt);
    const importContext = createSessionMonitoringImportContext(sourceContext);
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) throw new Error("请填写目标名称");
    const requestedDescription = typeof input.description === "string"
      ? input.description.trim()
      : typeof input.goal === "string"
        ? input.goal.trim()
        : "";
    const description = requestedDescription || monitoringGoalDescription(sourceContext);
    const acceptance = typeof input.acceptance === "string"
      ? input.acceptance.trim() || undefined
      : undefined;
    const workspacePath = commonMonitoringWorkspace(records);
    const sharedSourceIdentityId = records[0]?.executionIdentityId && records.every(
      (record) => record.executionIdentityId === records[0]!.executionIdentityId,
    )
      ? records[0]!.executionIdentityId
      : null;
    const workOrder = store.create({
      name,
      description,
      acceptance,
      projectId,
      workspace: workspacePath
        ? {
            kind: isGitRepository(workspacePath) ? "git" : "directory",
            path: workspacePath,
          }
        : null,
      sourceContext,
      importContext,
      // A mixed-account monitoring graph is reference context, not an account
      // binding. Reuse an account only when every selected Codex source agrees.
      executionIdentityId: sharedSourceIdentityId,
    });
    return { outcome: "created" as const, workOrder };
  };
  let autoRunCheckInFlight:
    | Promise<{ startedWorkOrderId: string | null; reason: string | null }>
    | null = null;
  let backgroundRefreshInFlight: Promise<unknown> | null = null;
  let sessionMonitoringScanInFlight: Promise<unknown> | null = null;
  let cancelAutoRunTimer: (() => void) | null = null;
  let cancelSessionMonitoringTimer: (() => void) | null = null;
  let handleRequest!: (request: Request) => Promise<Response>;
  let scheduleAutoRunCheck!: (delayMs?: number) => void;
  let scheduleSessionMonitoringScan!: (delayMs?: number) => void;

  store.markInterruptedSessionOrganizations();
  for (const record of store.listSessionMonitoring()) {
    if (!record.monitoringEnabled || record.organizationStatus !== "pending") continue;
    store.updateSessionMonitoring(record.key, {
      organizationStatus: "failed",
      message: "上一次会话监控在后台中断，请重试",
    });
  }
  for (const usage of store.listRunningSessionMonitoringResourceUsage()) {
    store.finishSessionMonitoringResourceUsage(
      usage.id,
      "failed",
      "上一次会话监控在后台中断，请重试",
    );
  }

  const pumpSessionMonitoring = () => {
    while (!closed && monitoringActiveCount < monitoringConcurrency && monitoringPending.size > 0) {
      const next = monitoringPending.entries().next().value as
        | [string, SessionMonitoringQueueEntry]
        | undefined;
      if (!next) return;
      const [key, entry] = next;
      monitoringPending.delete(key);
      if (!store.getSessionMonitoring(key)?.monitoringEnabled) {
        monitoringKeys.delete(key);
        monitoringControllers.delete(key);
        continue;
      }
      monitoringActiveCount += 1;
      const task = entry.run().catch((error) => {
        entry.onError?.(error);
      }).finally(() => {
        backgroundMonitoringPromises.delete(task);
        monitoringControllers.delete(key);
        const deferred = monitoringDeferred.get(key);
        if (deferred && !closed && store.getSessionMonitoring(key)?.monitoringEnabled) {
          monitoringDeferred.delete(key);
          monitoringPending.set(key, deferred);
        } else {
          monitoringDeferred.delete(key);
          const work = store.findSessionMonitoringWorkBySourceKey(key);
          const anotherSourceActive = work?.sourceSessionKeys.some((sourceKey) =>
            sourceKey !== key && (
              monitoringKeys.has(sourceKey) ||
              monitoringPending.has(sourceKey) ||
              monitoringDeferred.has(sourceKey)
            )
          ) ?? false;
          if (work && !anotherSourceActive) {
            store.clearSessionMonitoringWorkPendingRefresh(work.id);
          }
          monitoringKeys.delete(key);
        }
        monitoringActiveCount -= 1;
        pumpSessionMonitoring();
      });
      backgroundMonitoringPromises.add(task);
      void task;
    }
  };

  const enqueueSessionMonitoring = (
    key: string,
    entry: SessionMonitoringQueueEntry,
  ) => {
    if (closed) return false;
    if (monitoringKeys.has(key)) {
      if (monitoringPending.has(key)) {
        monitoringPending.set(key, entry);
      } else {
        monitoringDeferred.set(key, entry);
      }
      return true;
    }
    monitoringKeys.add(key);
    monitoringPending.set(key, entry);
    pumpSessionMonitoring();
    return true;
  };

  const queueSessionMonitoringAttempt = (
    record: SessionMonitoringRecord,
    candidate: DiscoveredSession,
    sourceProvider: SessionProvider,
    forceFromStart = false,
    mode: SessionMonitoringRefreshMode | "initial" = "automatic",
  ): boolean => {
    const work = store.ensureSessionMonitoringWork(record);
    if (mode === "automatic") {
      if (!store.getSessionMonitoringAutomaticRefreshEnabled()) return false;
      const completedAt = work.lastAutomaticCompletedAt
        ? Date.parse(work.lastAutomaticCompletedAt)
        : Number.NaN;
      const cooldownUntil = Number.isFinite(completedAt)
        ? completedAt + SESSION_MONITORING_AUTOMATIC_COOLDOWN_MS
        : null;
      if (cooldownUntil !== null && sessionMonitoringNow() < cooldownUntil) {
        store.setSessionMonitoringWorkPendingRefresh(
          work.id,
          mode,
          new Date(sessionMonitoringNow()).toISOString(),
        );
        scheduleSessionMonitoringScan(Math.max(0, cooldownUntil - sessionMonitoringNow()));
        return false;
      }
    }
    if (mode !== "initial") {
      store.setSessionMonitoringWorkPendingRefresh(
        work.id,
        mode,
        new Date(sessionMonitoringNow()).toISOString(),
      );
    }
    enqueueSessionMonitoring(record.key, {
      mode,
      run: () => monitorSessionFromSource(
        record,
        candidate,
        sourceProvider,
        forceFromStart,
        mode,
      ),
    });
    return true;
  };

  const queueSessionMonitoringUpdates = (
    previousRecords: Map<string, SessionMonitoringRecord>,
    sourceResults: SessionMonitoringSourceResult[],
  ) => {
    for (const result of sourceResults) {
      if (!result.provider) continue;
      for (const candidate of result.sessions) {
        const key = sessionMonitoringKey(
          result.sourceKind,
          result.executionIdentityId,
          candidate.id,
        );
        const current = store.getSessionMonitoring(key);
        if (!current?.monitoringEnabled) continue;
        const previous = previousRecords.get(key);
        if (!previous || sessionMonitoringSourceChanged(previous, candidate)) {
          const mode = !previous ||
            (current.lastReadPosition === null && current.organizationStatus === "not_started")
            ? "initial" as const
            : "automatic" as const;
          queueSessionMonitoringAttempt(
            current,
            candidate,
            result.provider,
            Boolean(previous && sessionMonitoringSourceNeedsFullRead(previous, candidate)),
            mode,
          );
        }
      }
    }
  };

  const queuePendingSessionMonitoringUpdates = (
    sourceResults: SessionMonitoringSourceResult[],
    pendingWorkIds: Set<string>,
  ) => {
    const candidates = new Map<string, { candidate: DiscoveredSession; provider: SessionProvider }>();
    for (const result of sourceResults) {
      if (!result.provider) continue;
      for (const candidate of result.sessions) {
        candidates.set(
          sessionMonitoringKey(result.sourceKind, result.executionIdentityId, candidate.id),
          { candidate, provider: result.provider },
        );
      }
    }
    for (const work of store.listSessionMonitoringWorks()) {
      if (!pendingWorkIds.has(work.id)) continue;
      const mode = work.pendingRefreshIntent?.mode;
      if (!mode) continue;
      for (const key of work.sourceSessionKeys) {
        const record = store.getSessionMonitoring(key);
        const source = candidates.get(key);
        if (!record?.monitoringEnabled || !source) continue;
        queueSessionMonitoringAttempt(
          record,
          source.candidate,
          source.provider,
          sessionMonitoringSourceNeedsFullRead(record, source.candidate),
          mode,
        );
      }
    }
  };

  const runSessionMonitoringRetry = async (key: string, controller: AbortController) => {
    const record = store.getSessionMonitoring(key);
    if (!record || !record.monitoringEnabled) return;
    let sourceProvider: SessionProvider | undefined;
    try {
      sourceProvider = sessionProviderForSource(record.sourceKind, record.executionIdentityId);
    } catch (error) {
      store.updateSessionMonitoring(key, {
        organizationStatus: "failed",
        message: error instanceof Error ? error.message : "来源会话不可用，请重试",
      });
      return;
    }
    if (!sourceProvider) {
      store.updateSessionMonitoring(key, {
        organizationStatus: "failed",
        message: "来源会话读取服务尚未配置，请重试",
      });
      return;
    }
    const discovered = await withSessionMonitoringTimeout(
      (signal) => sourceProvider!.discover(signal),
      sessionOrganizationTimeoutMs,
      "来源会话检查超时，请重试",
      controller,
    );
    const candidate = discovered.sessions.find((session) => session.id === record.id) ??
      sessionMonitoringCandidateFromRecord(record);
    if (!candidate) {
      store.updateSessionMonitoring(key, {
        organizationStatus: "failed",
        message: discovered.message || "来源会话当前不可用，请重试",
      });
      return;
    }
    const forceFromStart = sessionMonitoringSourceNeedsFullRead(record, candidate);
    const refreshed = store.upsertDiscoveredSession({
      key,
      sourceKind: record.sourceKind,
      executionIdentityId: record.executionIdentityId,
      executionIdentityLabel: record.executionIdentityLabel,
      id: candidate.id,
      title: candidate.title,
      workspacePath: candidate.workspacePath,
      projectLabel: candidate.projectLabel,
      lastActiveAt: candidate.lastActiveAt,
      sourcePath: candidate.sourcePath,
      sourcePosition: candidate.sourcePosition,
      sourceModifiedAt: candidate.sourceModifiedAt,
      availability: candidate.availability,
      message: candidate.message,
      lastDiscoveredAt: new Date().toISOString(),
    });
    await monitorSessionFromSource(refreshed, candidate, sourceProvider, forceFromStart, "manual");
  };

  const queueSessionMonitoringRetry = (key: string) => {
    if (monitoringKeys.has(key)) return false;
    const controller = new AbortController();
    monitoringControllers.set(key, controller);
    const queued = enqueueSessionMonitoring(key, {
      mode: "manual",
      run: () => runSessionMonitoringRetry(key, controller),
      onError: (error) => {
        if (!closed && store.getSessionMonitoring(key)) {
          store.updateSessionMonitoring(key, {
            organizationStatus: "failed",
            message: error instanceof Error ? error.message : "来源会话重试失败，请稍后重试",
          });
        }
      },
    });
    if (!queued) monitoringControllers.delete(key);
    return queued;
  };

  const requestSessionMonitoringRefresh = async (body: unknown) => {
    const input = body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
    const mode = input.mode === undefined ? "manual" : input.mode;
    if (!sessionMonitoringRefreshModes.includes(mode as SessionMonitoringRefreshMode)) {
      throw new Error("刷新方式无效");
    }
    const refreshMode = mode as SessionMonitoringRefreshMode;
    const rawKeys = input.sessionKeys ?? input.sourceSessionKeys;
    let keys: string[];
    if (Array.isArray(rawKeys)) {
      keys = normalizeMonitoringSessionKeys(rawKeys);
    } else if (typeof input.workId === "string" && input.workId.trim()) {
      const work = store.getSessionMonitoringWork(input.workId.trim());
      if (!work) throw new Error("找不到这个监控工作");
      keys = work.sourceSessionKeys;
    } else {
      keys = store.listSessionMonitoring()
        .filter((record) => record.monitoringEnabled)
        .map((record) => record.key);
    }
    const queuedKeys: string[] = [];
    for (const key of keys) {
      const record = store.getSessionMonitoring(key);
      if (!record) throw new Error("找不到所选来源会话");
      if (!record.monitoringEnabled) continue;
      let provider: SessionProvider | undefined;
      try {
        provider = sessionProviderForSource(record.sourceKind, record.executionIdentityId);
      } catch {
        provider = undefined;
      }
      if (!provider) continue;
      const candidate = sessionMonitoringCandidateFromRecord(record);
      if (!candidate) continue;
      if (queueSessionMonitoringAttempt(
        record,
        candidate,
        provider,
        sessionMonitoringSourceNeedsFullRead(record, candidate),
        refreshMode,
      )) {
        queuedKeys.push(key);
      }
    }
    return {
      outcome: "pending" as const,
      mode: refreshMode,
      queuedKeys,
      ...sessionMonitoringState(),
    };
  };

  scheduleSessionMonitoringScan = (delayMs = 0) => {
    if (closed) return;
    if (!store.listSessionMonitoring().some((record) => record.monitoringEnabled)) {
      cancelSessionMonitoringTimer?.();
      cancelSessionMonitoringTimer = null;
      return;
    }
    if (cancelSessionMonitoringTimer) {
      if (delayMs > 0) return;
      cancelSessionMonitoringTimer();
      cancelSessionMonitoringTimer = null;
    }
    let active = true;
    const cancel = sessionMonitoringScheduler(() => {
      if (!active) return;
      active = false;
      cancelSessionMonitoringTimer = null;
      sessionMonitoringScanInFlight = discoverSessionMonitoringOnce().finally(() => {
        sessionMonitoringScanInFlight = null;
        scheduleSessionMonitoringScan(sessionMonitoringIntervalMs);
      });
      void sessionMonitoringScanInFlight.catch(() => undefined);
    }, delayMs);
    cancelSessionMonitoringTimer = () => {
      if (!active) return;
      active = false;
      cancel();
    };
  };

  const monitorSessionFromSource = async (
    record: SessionMonitoringRecord,
    candidate: DiscoveredSession,
    sourceProvider: SessionProvider,
    forceFromStart = false,
    refreshMode: SessionMonitoringRefreshMode | "initial" = "automatic",
  ) => {
    const current = store.getSessionMonitoring(record.key);
    if (closed || !current?.monitoringEnabled) return;
    if (refreshMode === "automatic" && !store.getSessionMonitoringAutomaticRefreshEnabled()) return;
    const controller = new AbortController();
    monitoringControllers.set(record.key, controller);
    let usageId: string | null = null;
    let temporaryDirectory: string | null = null;
    const ensureActive = () => {
      const latest = store.getSessionMonitoring(record.key);
      if (closed || !latest?.monitoringEnabled) {
        throw new Error("会话监控已停止，请重试");
      }
    };
    try {
      ensureActive();
      store.updateSessionMonitoring(record.key, {
        organizationStatus: "pending",
        message: null,
      });
      if (candidate.availability === "unavailable" || !candidate.sourcePath) {
        throw new Error(candidate.message || "来源会话当前不可用，请重试");
      }
      if (!sourceProvider.read) {
        throw new Error("来源会话读取服务尚未配置，请重试");
      }
      const fromPosition = forceFromStart || current.lastReadPosition === null
        ? 0
        : candidate.sourcePosition !== null && candidate.sourcePosition !== undefined &&
            current.lastReadPosition > candidate.sourcePosition
          ? 0
          : current.lastReadPosition;
      const sourceRead = await withSessionMonitoringTimeout(
        (signal) => sourceProvider.read!(candidate, fromPosition, signal),
        sessionOrganizationTimeoutMs,
        "来源会话读取超时，请重试",
        controller,
      );
      const sourceMessage = sourceRead.truncated
        ? "会话历史较长，已从最近进展开始监控"
        : candidate.message;
      ensureActive();
      if (!sourceRead.content) {
        store.updateSessionMonitoring(record.key, {
          lastReadPosition: sourceRead.nextPosition,
          lastReadAt: new Date().toISOString(),
          organizationStatus: "ready",
          message: sourceMessage,
        });
        return;
      }
      if (!sessionOrganizationResourceSelector) {
        throw new Error("快速整理资源尚未配置，请重试");
      }
      const resource = await withSessionMonitoringTimeout(
        (signal) => sessionOrganizationResourceSelector.select({
          purpose: "session_organization",
          sessionKey: record.key,
          sourceKind: record.sourceKind,
          accountId: record.executionIdentityId,
          preference: refreshMode === "deep" ? "high_quality" : "low_cost",
        }, signal),
        sessionOrganizationTimeoutMs,
        "快速整理资源暂时不可用，请重试",
        controller,
      );
      ensureActive();
      if (!resource || !resource.tool.trim() || !resource.model.trim()) {
        throw new Error("当前没有可用的快速整理资源，请重试");
      }
      if (!sessionOrganizer) {
        throw new Error("会话整理服务尚未配置，请重试");
      }
      const usage = store.startSessionMonitoringResourceUsage({
        sessionKey: record.key,
        sourceKind: record.sourceKind,
        tool: resource.tool,
        model: resource.model,
        accountId: resource.accountId,
        accountLabel: resource.accountLabel,
      });
      usageId = usage.id;
      temporaryDirectory = mkdtempSync(join(tmpdir(), "teamline-session-monitoring-"));
      const temporarySourcePath = join(temporaryDirectory, "increment.jsonl");
      writeFileSync(temporarySourcePath, sourceRead.content, "utf8");
      const organization = await withSessionMonitoringTimeout(
        (signal) => sessionOrganizer.organize({
          name: candidate.title,
          sourceLabel: sourceKindLabel(record.sourceKind),
          sourceKind: record.sourceKind,
          previousSnapshot: current.workGraphSnapshot,
          resource,
          sessions: [{ ...candidate, sourcePath: temporarySourcePath }],
        }, signal),
        sessionOrganizationTimeoutMs,
        "快速整理超时，请重试",
        controller,
      );
      ensureActive();
      store.updateSessionMonitoring(record.key, {
        lastReadPosition: sourceRead.nextPosition,
        lastReadAt: new Date().toISOString(),
        organizationStatus: "ready",
        workGraphSnapshot: organization,
        message: sourceMessage,
      });
      const work = store.findSessionMonitoringWorkBySourceKey(record.key);
      if (work) {
        if (refreshMode === "automatic") {
          store.markSessionMonitoringAutomaticCompleted(
            work.id,
            new Date(sessionMonitoringNow()).toISOString(),
          );
        }
        if (work.sourceSessionKeys.length === 1) {
          store.updateSessionMonitoringWorkSnapshotRef(
            work.id,
            `session-monitoring:${record.key}:${new Date().toISOString()}`,
          );
        }
      }
      store.finishSessionMonitoringResourceUsage(usage.id, "succeeded");
    } catch (error) {
      const message = controller.signal.aborted
        ? "会话监控已停止，请重试"
        : error instanceof Error
          ? error.message
          : "会话整理失败，请重试";
      if (!closed && store.getSessionMonitoring(record.key)) {
        store.updateSessionMonitoring(record.key, {
          organizationStatus: "failed",
          message,
        });
      }
      if (usageId) store.finishSessionMonitoringResourceUsage(usageId, "failed", message);
    } finally {
      monitoringControllers.delete(record.key);
      controller.abort();
      if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  };

  const clearRunTimeout = (id: string) => {
    runTimeouts.get(id)?.();
    runTimeouts.delete(id);
  };
  const startRunTimeout = (id: string) => {
    clearRunTimeout(id);
    const maxRunMinutes = store.get(id)?.maxRunMinutes ?? 60;
    const cancel = runTimeoutScheduler(() => {
      runTimeouts.delete(id);
      const activeRun = activeRuns.get(id);
      if (store.get(id)?.runStatus !== "running" || !activeRun) return;

      const reason = `已达到本轮最长运行时间（${maxRunMinutes} 分钟），Codex 已停止；可以继续推进目标`;
      stopReasons.set(id, reason);
      store.markStopping(
        id,
        `已达到本轮最长运行时间（${maxRunMinutes} 分钟），正在停止 Codex`,
      );
      try {
        activeRun.interrupt();
      } catch {
        // The event stream still decides when the run has actually stopped.
      }
    }, maxRunMinutes * 60_000);
    runTimeouts.set(id, cancel);
  };
  const generateAndStorePlan = async (
    id: string,
    workOrder: WorkOrder,
    requiresPlanConfirmation: boolean,
    pendingReply?: string,
    forcePlanVersion = false,
  ) => {
    if (!planGenerator) throw new Error("Codex 规划服务尚未配置");
    const planningInput = pendingReply
      ? {
          ...workOrder,
          conversation: [
            ...workOrder.conversation,
            {
              id: 0,
              role: "user" as const,
              kind: "reply" as const,
              content: pendingReply,
              stageId: null,
              decisionTarget:
                workOrder.pendingClarification?.questions[0]?.target ?? "plan",
              requiresPlanConfirmation,
              createdAt: new Date().toISOString(),
            },
          ],
        }
      : workOrder;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const generated = await Promise.race([
      planGenerator.generate(planningInput, controller.signal, {
        reasoningEffort: pendingReply && workOrder.pendingClarification ? "high" : "medium",
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new PlanGenerationTimeoutError());
        }, planGenerationTimeoutMs);
      }),
    ]).finally(() => clearTimeout(timeout));
    if (
      generated.outcome === "clarification" ||
      (generated.questions?.length ?? 0) > 0
    ) {
      return {
        outcome: "clarification" as const,
        workOrder: store.saveClarification(
          id,
          generated.questions ?? [],
          requiresPlanConfirmation,
          pendingReply,
          workOrder.status === "review",
        ),
      };
    }
    const saved = store.applyGeneratedPlan(
      id,
      generated,
      requiresPlanConfirmation,
      pendingReply,
      forcePlanVersion,
    );
    scheduleAutoRunCheck();
    return { outcome: "plan" as const, workOrder: saved };
  };
  const organizeImportedWorkOrder = async (id: string) => {
    let workOrder = store.get(id);
    if (workOrder?.sourceContext) {
      throw new Error("监控来源上下文是创建时快照，不能重新整理");
    }
    if (!workOrder?.importContext || workOrder.sourceSessions.length === 0) {
      throw new Error("这个目标没有可整理的来源会话");
    }
    if (organizingWorkOrderIds.has(id)) {
      throw new Error("来源会话正在整理，请稍候");
    }
    workOrder = store.markSessionOrganizationPending(id);
    organizingWorkOrderIds.add(id);
    const controller = new AbortController();
    organizationControllers.set(id, controller);
    try {
      const sourceKinds = new Set(workOrder.sourceSessions.map((source) => source.kind));
      const sourceKind = workOrder.sourceSessions[0]!.kind;
      const sourceProvider = sourceKinds.size === 1
        ? sessionProviderForSource(
            sourceKind,
            workOrder.sourceSessions[0]?.executionIdentityId,
          )
        : undefined;
      if (!sourceProvider || !sessionOrganizer) {
        const failed = store.markSessionOrganizationFailed(
          id,
          !sourceProvider
            ? sourceKinds.size > 1
              ? "一个目标的来源会话必须来自同一个工具"
              : `${sourceKindLabel(sourceKind)} 会话发现服务尚未配置`
            : "会话整理服务尚未配置",
        );
        return { outcome: "failed" as const, workOrder: failed };
      }
      try {
        const discovered = await discoverSessionsWithin(
          sourceProvider,
          controller.signal,
          sessionOrganizationTimeoutMs,
        );
        const candidates = new Map(discovered.sessions.map((session) => [session.id, session]));
        const sessions = workOrder.sourceSessions.map((source) => {
          const candidate = candidates.get(source.id);
          if (!candidate || !candidate.sourcePath || candidate.availability === "unavailable") {
            throw new Error(`来源会话“${source.id}”当前不可用`);
          }
          return { ...candidate, sourcePath: candidate.sourcePath };
        });
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const organization = await Promise.race([
          sessionOrganizer.organize({
            name: workOrder.name,
            sourceLabel: sourceKindLabel(sourceKind),
            sourceKind,
            sessions,
          }, controller.signal),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              controller.abort();
              reject(new Error("会话整理超时，请重试"));
            }, sessionOrganizationTimeoutMs);
          }),
        ]).finally(() => clearTimeout(timeout));
        const observedSources = sessions.map((session) => {
          const original = workOrder.sourceSessions.find((source) => source.id === session.id)!;
          return {
            kind: sourceKind,
            id: session.id,
            lastActiveAt: session.lastActiveAt,
            ...(original.executionIdentityId
              ? { executionIdentityId: original.executionIdentityId }
              : {}),
            ...(original.openInCodex === true ? { openInCodex: true } : {}),
            version: 1 as const,
          };
        });
        return {
          outcome: "ready" as const,
          workOrder: store.applySessionOrganization(id, organization, observedSources),
        };
      } catch (error) {
        const message = controller.signal.aborted || closed
          ? "历史整理中断"
          : error instanceof Error
            ? error.message
            : "Codex 暂时无法整理会话";
        return {
          outcome: "failed" as const,
          workOrder: store.markSessionOrganizationFailed(id, message),
        };
      }
    } finally {
      organizationControllers.delete(id);
      organizingWorkOrderIds.delete(id);
    }
  };
  const scheduleImportedWorkOrderOrganization = (id: string) => {
    sessionOrganizationScheduler(() => {
      if (closed) return;
      const task = organizeImportedWorkOrder(id)
        .catch((error) => {
          if (!store.get(id)) return;
          store.markSessionOrganizationFailed(
            id,
            error instanceof Error ? error.message : "历史整理失败",
          );
        })
        .finally(() => backgroundOrganizationPromises.delete(task));
      backgroundOrganizationPromises.add(task);
    });
  };
  const finishReason = (id: string) => {
    const reason = stopReasons.get(id);
    stopReasons.delete(id);
    return reason;
  };
  const executionCapacityReached = () => {
    const activeOrStarting = new Set([
      ...store.activeRunIds(),
      ...startingWorkOrderIds,
    ]);
    return activeOrStarting.size >= store.getExecutionSettings().maxConcurrency;
  };
  const paidApiAvailable = () => codexRunner?.paidApiAvailable?.() === true;
  const paidFallbackReasons = (snapshot: ResourceProviderSnapshot) =>
    new Map(
      store
        .list()
        .filter((workOrder) => workOrder.resourcePlan.paidApiFallbackEnabled)
        .map((workOrder) => {
          const decision = decidePaidApiRun(
            workOrder,
            snapshot,
            store.getPaidApiBudgetSettings(),
            paidApiAvailable(),
          );
          return [workOrder.id, decision.allowed ? null : decision.reason] as const;
        }),
    );
  const identitySchedulingContext = (
    snapshot?: ResourceProviderSnapshot,
  ): AutoRunIdentityContext => ({
    currentExecutionIdentityId: store.getCurrentExecutionIdentityId(),
    defaultExecutionIdentityId: store.getDefaultExecutionIdentityId(),
    executableExecutionIdentityIds: new Set(
      store
        .listExecutionIdentities()
        .filter(
          (identity) =>
            identity.status === "enabled" &&
            (identity.loginState === "ready" ||
              (identity.homeKind === "system" && identity.loginState === "unknown")),
        )
        .map((identity) => identity.id),
    ),
    ...(identityResourceProvider
      ? {
          quotaByExecutionIdentityId: new Map(
            latestIdentityQuota.map(({ identity, signal }) => [identity.id, signal]),
          ),
        }
      : {}),
    ...(snapshot ? { paidFallbackReasons: paidFallbackReasons(snapshot) } : {}),
  });
  const billingModeFor = (
    workOrder: WorkOrder,
    snapshot: ResourceProviderSnapshot,
    codex: CodexResourceSignal,
  ): CodexBillingMode => {
    const quotaReason = quotaBlockingReason(
      codex,
      workOrder.resourcePlan.pace,
      new Date(),
    );
    if (!quotaReason) return "subscription";
    return decidePaidApiRun(
      workOrder,
      snapshot,
      store.getPaidApiBudgetSettings(),
      paidApiAvailable(),
    ).allowed
      ? "paid_api"
      : "subscription";
  };
  const claimPaidApiAttribution = (
    id: string,
    billingMode: CodexBillingMode,
    snapshot: ResourceProviderSnapshot | null,
  ): boolean => {
    if (billingMode !== "paid_api") return true;
    const usage = snapshot?.openaiApi.usage;
    if (
      snapshot?.openaiApi.status !== "available" ||
      snapshot.openaiApi.scope !== "project" ||
      usage?.unit !== "usd"
    ) {
      return false;
    }
    return store.claimPaidApiAttribution(
      id,
      usage.amount,
      usage.periodStart,
      new Date().toISOString(),
    );
  };
  const executionIdentityIdForStart = (workOrder: WorkOrder): string => {
    const identityId =
      workOrder.executionIdentityId ?? store.getDefaultExecutionIdentityId();
    if (!identityId) throw new Error("请先选择可用的 Codex 账号");
    const identity = store.getExecutionIdentity(identityId);
    if (
      !identity ||
      identity.status !== "enabled" ||
      (identity.loginState !== "ready" &&
        !(identity.homeKind === "system" && identity.loginState === "unknown"))
    ) {
      throw new Error("这个目标绑定的 Codex 账号当前不可用");
    }
    return identity.id;
  };
  const identityStartBlock = (
    workOrderId: string,
    executionIdentityId: string,
  ): { code: string; error: string } | null => {
    const occupiedIdentities = new Set<string>();
    let hasUnboundActiveRun = false;
    for (const activeId of store.activeRunIds()) {
      const identityId = store.get(activeId)?.executionIdentityId;
      if (identityId) {
        occupiedIdentities.add(identityId);
      } else {
        hasUnboundActiveRun = true;
      }
    }
    for (const [candidateId, identityId] of startingExecutionIdentityIds) {
      if (candidateId !== workOrderId) occupiedIdentities.add(identityId);
    }
    if (hasUnboundActiveRun) {
      return {
        code: "EXECUTION_IDENTITY_BUSY",
        error: "等待账号：仍有旧版 Codex 运行未结束",
      };
    }
    if (
      [...occupiedIdentities].some(
        (identityId) => identityId !== executionIdentityId,
      )
    ) {
      return {
        code: "EXECUTION_IDENTITY_BUSY",
        error: "等待账号：另一个 Codex 账号仍有节点在运行",
      };
    }
    const currentIdentityId = store.getCurrentExecutionIdentityId();
    if (currentIdentityId && currentIdentityId !== executionIdentityId) {
      return {
        code: "EXECUTION_IDENTITY_SWITCH_REQUIRED",
        error: "等待账号：请确认切换 Codex 账号后再运行",
      };
    }
    return null;
  };
  const selectExecutionIdentityForStart = (executionIdentityId: string) => {
    if (!store.getCurrentExecutionIdentityId()) {
      store.setCurrentExecutionIdentityId(executionIdentityId);
    }
  };
  const workspaceOwner = (id: string, workspacePath: string) => {
    const targetPath = canonicalWorkspacePath(workspacePath);
    const activeOwner = store
      .list()
      .find(
        (candidate) =>
          candidate.id !== id &&
          ["running", "stopping", "verifying"].includes(
            candidate.runStatus ?? "",
          ) &&
          candidate.worktreePath &&
          canonicalWorkspacePath(candidate.worktreePath) === targetPath,
      );
    if (activeOwner) return activeOwner.id;
    for (const [candidateId, candidatePath] of startingWorkspacePaths) {
      if (
        candidateId !== id &&
        canonicalWorkspacePath(candidatePath) === targetPath
      ) {
        return candidateId;
      }
    }
    return null;
  };

  const startNextCodexStage = async (
    id: string,
    workspacePath: string,
  ): Promise<NextStageRun | null> => {
    if (!codexRunner) return null;
    const bound = store.bindExecutionIdentity(id);
    const executionIdentity = executionIdentityForRun(store, bound, Boolean(bound.sessionId));
    const identityBlock = identityStartBlock(id, executionIdentity.id);
    if (identityBlock) {
      store.saveSchedulingWaitReason(id, "等待账号");
      return null;
    }
    startingExecutionIdentityIds.set(id, executionIdentity.id);
    let cancelPaidAttribution = false;
    try {
      let billingMode: CodexBillingMode = "subscription";
      let paidSnapshot: ResourceProviderSnapshot | null = null;
      if (
        bound.resourcePlan.runWhenQuotaAvailable ||
        bound.resourcePlan.paidApiFallbackEnabled
      ) {
        const snapshot = await readResourceSnapshot();
        paidSnapshot = snapshot;
        const identityQuota = latestIdentityQuota.find(
          ({ identity }) => identity.id === executionIdentity.id,
        )?.signal ?? snapshot.codex;
        const quotaReason = quotaBlockingReason(
          identityQuota,
          bound.resourcePlan.pace,
          new Date(),
        );
        if (quotaReason) {
          if (!bound.resourcePlan.paidApiFallbackEnabled) {
            store.saveSchedulingWaitReason(id, quotaReason);
            return null;
          }
          const paidDecision = decidePaidApiRun(
            bound,
            snapshot,
            store.getPaidApiBudgetSettings(),
            paidApiAvailable(),
          );
          if (!paidDecision.allowed) {
            store.saveSchedulingWaitReason(id, paidDecision.reason || quotaReason);
            return null;
          }
          billingMode = "paid_api";
        }
      }
      if (executionCapacityReached()) {
        store.saveSchedulingWaitReason(id, "等待可用并发位置");
        return null;
      }
      if (!claimPaidApiAttribution(id, billingMode, paidSnapshot)) {
        store.saveSchedulingWaitReason(id, "等待上一笔 API 实际用量更新");
        return null;
      }
      cancelPaidAttribution = billingMode === "paid_api";
      selectExecutionIdentityForStart(executionIdentity.id);
      const started = store.markNextStageStarted(id);
      const scopedWorkOrder = codexRunWorkOrder(started);
      const canResume =
        Boolean(started.sessionId) &&
        bound.resourcePlan.lastBillingMode === billingMode;
      let run: StartedCodexRun;
      let fallback: NextStageRun["fallback"];
      if (started.sessionId && canResume) {
        run = await codexRunner.resume({
          workOrder: scopedWorkOrder,
          workspacePath,
          sessionId: started.sessionId,
          executionIdentity,
          billingMode,
        });
        fallback = async () => {
          if (store.get(id)?.runStatus === "stopping") return null;
          store.recordProgress(
            id,
            "保存的 Codex 会话不可用，已使用当前现场启动新的执行",
          );
          return codexRunner.start({
            workOrder: codexRunWorkOrder(store.get(id)!),
            workspacePath,
            executionIdentity,
            billingMode,
            continuation: await continuationContext(store, id, workspacePath),
          });
        };
      } else {
        run = await codexRunner.start({
          workOrder: scopedWorkOrder,
          workspacePath,
          executionIdentity,
          billingMode,
          continuation: await continuationContext(store, id, workspacePath),
        });
      }
      if (store.get(id)?.runStatus === "stopping") {
        try {
          run.interrupt();
        } catch {
          // The run is already stopping; do not register or consume it.
        }
        if (run.exited) {
          try {
            await run.exited;
          } catch {
            // Process termination was still observed even if its exit promise rejected.
          }
          store.recordInterrupted(id);
        }
        return null;
      }
      store.recordBillingStarted(id, billingMode);
      cancelPaidAttribution = false;
      store.recordRunPid(id, run.pid ?? null);
      startRunTimeout(id);
      return {
        run,
        fallback,
        executionIdentityId: executionIdentity.id,
        retryTransient: () =>
          retryTransientCodexFailure(
            id,
            workspacePath,
            executionIdentity,
            billingMode,
          ),
      };
    } catch (error) {
      store.recordExit(id, -1, safeCodexStartError(error));
      return null;
    } finally {
      if (cancelPaidAttribution) store.cancelPaidApiAttribution(id);
      startingExecutionIdentityIds.delete(id);
    }
  };

  const retryTransientCodexFailure = async (
    id: string,
    workspacePath: string,
    executionIdentity: ExecutionIdentity,
    billingMode: CodexBillingMode,
  ): Promise<StartedCodexRun | null> => {
    if (!codexRunner || store.get(id)?.runStatus === "stopping") return null;
    const current = store.get(id);
    if (!current) return null;
    store.recordProgress(id, "Codex 短暂中断，正在自动恢复一次");
    return current.sessionId
      ? codexRunner.resume({
          workOrder: codexRunWorkOrder(current),
          workspacePath,
          sessionId: current.sessionId,
          executionIdentity,
          billingMode,
        })
      : codexRunner.start({
          workOrder: codexRunWorkOrder(current),
          workspacePath,
          executionIdentity,
          billingMode,
          continuation: await continuationContext(store, id, workspacePath),
        });
  };

  const refreshIdentityQuota = async (systemSignal: CodexResourceSignal) => {
    if (!identityResourceProvider) {
      latestIdentityQuota = [];
      return;
    }
    const now = new Date();
    const identities = store
      .listExecutionIdentities()
      .filter((identity) => identity.status === "enabled");
    latestIdentityQuota = await Promise.all(
      identities.map(async (identity) => {
        const previous = store.getExecutionIdentityQuotaSnapshot(identity.id);
        let signal: CodexResourceSignal;
        try {
          signal = identity.homeKind === "system"
            ? systemSignal
            : await identityResourceProvider.read(identity);
          if (signal.status === "error" && previous) {
            signal = failedIdentityQuotaSignal(previous.signal, now);
          }
          if (["available", "unavailable"].includes(signal.status)) {
            store.saveExecutionIdentityQuotaSnapshot(identity.id, signal);
          }
          signal = codexSignalAt(signal, now, RESOURCE_SIGNAL_STALE_AFTER_MS);
        } catch {
          signal = previous
            ? failedIdentityQuotaSignal(previous.signal, now)
            : identityQuotaErrorSignal(now);
        }
        return { identity, signal };
      }),
    );
  };

  const refreshExecutionIdentityStatus = async () => {
    if (!executionIdentityEnvironment) return;
    await Promise.all(
      store
        .listExecutionIdentities()
        .filter((identity) => identity.status === "enabled")
        .map(async (identity) => {
          try {
            const observation = await executionIdentityEnvironment.inspect(identity);
            store.recordExecutionIdentityObservation(identity.id, observation);
          } catch {
            // Keep the last known account state when a wake refresh cannot inspect it.
          }
        }),
    );
  };

  const withPaidApiAttribution = (
    snapshot: ResourceProviderSnapshot,
  ): ResourceProviderSnapshot => {
    let state = store.getPaidApiAttributionState();
    const pending = state.pending;
    if (pending) {
      const direct = snapshot.workOrderUsage.find(
        (usage) =>
          usage.workOrderId === pending.workOrderId &&
          usage.source === "openai-usage-api" &&
          usage.unit === "usd" &&
          Number.isFinite(usage.amount) &&
          usage.amount >= 0 &&
          Date.parse(usage.observedAt) > Date.parse(pending.startedAt),
      );
      if (direct) {
        store.completePaidApiAttribution(
          pending.workOrderId,
          direct.amount,
          direct.observedAt,
          "absolute",
        );
      } else {
        const account = snapshot.openaiApi;
        if (
          account.status === "available" &&
          account.source === "openai-usage-api" &&
          account.scope === "project" &&
          account.usage?.unit === "usd" &&
          account.usage.periodStart === pending.periodStart &&
          Number.isFinite(account.usage.amount) &&
          account.usage.amount > pending.baselineUsd &&
          Date.parse(account.observedAt) > Date.parse(pending.startedAt)
        ) {
          store.completePaidApiAttribution(
            pending.workOrderId,
            account.usage.amount - pending.baselineUsd,
            account.observedAt,
            "increment",
          );
        }
      }
      state = store.getPaidApiAttributionState();
    }

    const usageByWorkOrder = new Map(
      snapshot.workOrderUsage.map((usage) => [usage.workOrderId, usage]),
    );
    const currentProjectObservation =
      !state.pending &&
      snapshot.openaiApi.status === "available" &&
      snapshot.openaiApi.source === "openai-usage-api" &&
      snapshot.openaiApi.scope === "project" &&
      snapshot.openaiApi.usage?.unit === "usd"
        ? snapshot.openaiApi.observedAt
        : null;
    for (const [workOrderId, observation] of Object.entries(
      state.observedByWorkOrder,
    )) {
      usageByWorkOrder.set(workOrderId, {
        workOrderId,
        amount: observation.amountUsd,
        unit: "usd",
        observedAt: currentProjectObservation ?? observation.observedAt,
        source: "openai-usage-api",
      });
    }
    return {
      ...snapshot,
      workOrderUsage: [...usageByWorkOrder.values()],
      pendingPaidUsageWorkOrderId: state.pending?.workOrderId ?? null,
    };
  };

  const readResourceSnapshot = async () => {
    let snapshot;
    try {
      const systemIdentity = store.getExecutionIdentity(
        store.getSystemExecutionIdentityId(),
      );
      const systemCodexDisabled = Boolean(
        identityResourceProvider && systemIdentity?.status !== "enabled",
      );
      snapshot = !resourceProvider
        ? unavailableResourceSnapshot()
        : systemCodexDisabled
          ? resourceProvider.readWithoutCodex
            ? await resourceProvider.readWithoutCodex()
            : unavailableResourceSnapshot("系统 Codex 账号未启用")
          : await resourceProvider.read();
    } catch {
      snapshot = unavailableResourceSnapshot(
        "Codex 额度读取失败，请稍后重试",
        new Date().toISOString(),
        "error",
      );
    }
    await refreshIdentityQuota(snapshot.codex);
    return withPaidApiAttribution(snapshot);
  };
  const runAutoRunOnce = () => {
    if (closed) {
      return Promise.resolve({ startedWorkOrderId: null, reason: "服务已关闭" });
    }
    if (autoRunCheckInFlight) return autoRunCheckInFlight;
    cancelAutoRunTimer?.();
    cancelAutoRunTimer = null;
    autoRunCheckInFlight = (async () => {
      const snapshot = await readResourceSnapshot();
      const decision = decideAutoRun(
        store.list().filter((workOrder) => !isImportOnlyWorkOrder(workOrder)),
        snapshot.codex,
        store.getExecutionSettings().maxConcurrency,
        new Date(),
        identitySchedulingContext(snapshot),
      );
      for (const [id, reason] of decision.reasons) {
        store.saveAutoRunReason(id, reason);
      }
      if (!decision.candidateId) {
        return { startedWorkOrderId: null, reason: null };
      }

      store.saveAutoRunReason(decision.candidateId, null);
      const response = await handleRequest(
        new Request(
          `http://teamline.local/api/work-orders/${encodeURIComponent(decision.candidateId)}/start`,
          {
            method: "POST",
            headers: { "x-teamline-auto-run": "1" },
          },
        ),
      );
      if (!response.ok) {
        const result = (await response.json()) as { error?: string };
        const currentReason = store.get(decision.candidateId)?.resourcePlan.autoRunReason;
        const reason = currentReason || result.error || "自动启动失败，等待重试";
        if (!currentReason) {
          store.saveAutoRunReason(decision.candidateId, reason);
        }
        return { startedWorkOrderId: null, reason };
      }
      return { startedWorkOrderId: decision.candidateId, reason: null };
    })().finally(() => {
      autoRunCheckInFlight = null;
      scheduleAutoRunCheck(autoRunRetryMs);
    });
    return autoRunCheckInFlight;
  };
  scheduleAutoRunCheck = (delayMs = 0) => {
    if (closed) return;
    if (
      !store
        .list()
        .some(
          (workOrder) =>
            workOrder.resourcePlan.runWhenQuotaAvailable &&
            !isImportOnlyWorkOrder(workOrder) &&
            (workOrder.status === "ready" || workOrder.status === "running"),
        )
    ) {
      cancelAutoRunTimer?.();
      cancelAutoRunTimer = null;
      return;
    }
    if (cancelAutoRunTimer) {
      if (delayMs > 0) return;
      cancelAutoRunTimer();
      cancelAutoRunTimer = null;
    }
    let active = true;
    const expectedAt = backgroundNow() + delayMs;
    const cancel = autoRunRetryScheduler(() => {
      if (!active) return;
      active = false;
      cancelAutoRunTimer = null;
      const wokeFromSleep = backgroundNow() - expectedAt > wakeDetectionThresholdMs;
      backgroundRefreshInFlight = (wokeFromSleep
        ? refreshExecutionIdentityStatus().then(runAutoRunOnce)
        : runAutoRunOnce()).finally(() => {
          backgroundRefreshInFlight = null;
        });
      void backgroundRefreshInFlight.catch(() => undefined);
    }, delayMs);
    cancelAutoRunTimer = () => {
      if (!active) return;
      active = false;
      cancel();
    };
  };

  const routeRequest = async (request: Request): Promise<Response> => {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/api/health") {
        return Response.json({ ok: true });
      }

      if (request.method === "GET" && url.pathname === "/api/execution-identities") {
        const defaultIdentityId = store.getDefaultExecutionIdentityId();
        return Response.json({
          defaultIdentityId,
          currentIdentityId: store.getCurrentExecutionIdentityId(),
          identities: store
            .listExecutionIdentities()
            .map((identity) => presentExecutionIdentity(identity, defaultIdentityId)),
        });
      }

      if (request.method === "POST" && url.pathname === "/api/execution-identities") {
        if (!executionIdentityEnvironment) {
          return executionIdentityErrorResponse(
            "IDENTITY_ENVIRONMENT_UNAVAILABLE",
            "Codex 账号环境尚未配置",
            503,
          );
        }
        const id = crypto.randomUUID();
        let environmentCreated = false;
        try {
          const body = (await request.json()) as { label?: string };
          const environment = await executionIdentityEnvironment.create(id);
          environmentCreated = true;
          const identity = store.createManagedExecutionIdentity({
            id,
            label: body.label ?? "",
            managedHomePath: environment.managedHomePath,
          });
          return Response.json(
            {
              identity: presentExecutionIdentity(
                identity,
                store.getDefaultExecutionIdentityId(),
              ),
            },
            { status: 201 },
          );
        } catch (error) {
          if (environmentCreated) {
            await executionIdentityEnvironment.remove(id).catch(() => undefined);
          }
          return executionIdentityErrorResponse(
            "INVALID_EXECUTION_IDENTITY",
            error instanceof Error ? error.message : "无法添加 Codex 账号",
            400,
          );
        }
      }

      const identityMatch = url.pathname.match(/^\/api\/execution-identities\/([^/]+)$/);
      if (request.method === "PATCH" && identityMatch) {
        const id = decodeURIComponent(identityMatch[1]);
        if (!store.getExecutionIdentity(id)) {
          return executionIdentityErrorResponse(
            "EXECUTION_IDENTITY_NOT_FOUND",
            "找不到这个 Codex 账号",
            404,
          );
        }
        try {
          const body = (await request.json()) as { label?: string };
          const identity = store.renameExecutionIdentity(id, body.label ?? "");
          return Response.json({
            identity: presentExecutionIdentity(
              identity,
              store.getDefaultExecutionIdentityId(),
            ),
          });
        } catch (error) {
          return executionIdentityErrorResponse(
            "INVALID_EXECUTION_IDENTITY",
            error instanceof Error ? error.message : "无法修改 Codex 账号",
            400,
          );
        }
      }

      const identityStateMatch = url.pathname.match(
        /^\/api\/execution-identities\/([^/]+)\/(enable|disable)$/,
      );
      if (request.method === "POST" && identityStateMatch) {
        const id = decodeURIComponent(identityStateMatch[1]);
        if (!store.getExecutionIdentity(id)) {
          return executionIdentityErrorResponse(
            "EXECUTION_IDENTITY_NOT_FOUND",
            "找不到这个 Codex 账号",
            404,
          );
        }
        const enabling = identityStateMatch[2] === "enable";
        if (
          !enabling &&
          executionIdentityEnvironment?.getLoginStatus(id).status === "in_progress"
        ) {
          return executionIdentityErrorResponse(
            "EXECUTION_IDENTITY_LOGIN_IN_PROGRESS",
            "Codex 登录正在进行中，暂时不能停用这个账号",
            409,
          );
        }
        try {
          const identity = store.setExecutionIdentityEnabled(
            id,
            enabling,
          );
          return Response.json({
            identity: presentExecutionIdentity(
              identity,
              store.getDefaultExecutionIdentityId(),
            ),
          });
        } catch (error) {
          return executionIdentityErrorResponse(
            "INVALID_EXECUTION_IDENTITY_STATE",
            error instanceof Error ? error.message : "无法修改 Codex 账号状态",
            409,
          );
        }
      }

      const defaultIdentityMatch = url.pathname.match(
        /^\/api\/execution-identities\/([^/]+)\/default$/,
      );
      if (request.method === "POST" && defaultIdentityMatch) {
        const id = decodeURIComponent(defaultIdentityMatch[1]);
        try {
          const identity = store.setDefaultExecutionIdentityId(id);
          return Response.json({
            identity: presentExecutionIdentity(identity, identity.id),
            defaultIdentityId: identity.id,
          });
        } catch (error) {
          return executionIdentityErrorResponse(
            "EXECUTION_IDENTITY_UNAVAILABLE",
            error instanceof Error ? error.message : "无法设为默认 Codex 账号",
            409,
          );
        }
      }

      const currentIdentityMatch = url.pathname.match(
        /^\/api\/execution-identities\/([^/]+)\/activate$/,
      );
      if (request.method === "POST" && currentIdentityMatch) {
        const id = decodeURIComponent(currentIdentityMatch[1]);
        try {
          const body = (await request.json()) as { confirm?: boolean };
          if (body.confirm !== true) {
            throw new Error("请确认切换当前运行账号");
          }
          const currentIdentityId = store.getCurrentExecutionIdentityId();
          if (
            currentIdentityId !== id &&
            (store.activeRunIds().length > 0 || startingExecutionIdentityIds.size > 0)
          ) {
            return executionIdentityErrorResponse(
              "EXECUTION_IDENTITY_BUSY",
              "请等待当前账号的所有运行节点结束后再切换",
              409,
            );
          }
          const identity = store.setCurrentExecutionIdentityId(id);
          scheduleAutoRunCheck();
          return Response.json({
            currentIdentityId: identity.id,
            identity: presentExecutionIdentity(
              identity,
              store.getDefaultExecutionIdentityId(),
            ),
          });
        } catch (error) {
          return executionIdentityErrorResponse(
            "EXECUTION_IDENTITY_SWITCH_REJECTED",
            error instanceof Error ? error.message : "无法切换当前运行账号",
            409,
          );
        }
      }

      const identityRefreshMatch = url.pathname.match(
        /^\/api\/execution-identities\/([^/]+)\/refresh$/,
      );
      if (request.method === "POST" && identityRefreshMatch) {
        const id = decodeURIComponent(identityRefreshMatch[1]);
        const identity = store.getExecutionIdentity(id);
        if (!identity) {
          return executionIdentityErrorResponse(
            "EXECUTION_IDENTITY_NOT_FOUND",
            "找不到这个 Codex 账号",
            404,
          );
        }
        if (identity.status !== "enabled") {
          return executionIdentityErrorResponse(
            "EXECUTION_IDENTITY_DISABLED",
            "这个 Codex 账号当前不可用",
            409,
          );
        }
        if (!executionIdentityEnvironment) {
          return executionIdentityErrorResponse(
            "IDENTITY_ENVIRONMENT_UNAVAILABLE",
            "Codex 账号环境尚未配置",
            503,
          );
        }
        try {
          const observation = await executionIdentityEnvironment.inspect(identity);
          const refreshed = store.recordExecutionIdentityObservation(id, observation);
          return Response.json({
            identity: presentExecutionIdentity(
              refreshed,
              store.getDefaultExecutionIdentityId(),
            ),
          });
        } catch (error) {
          return executionIdentityErrorResponse(
            "EXECUTION_IDENTITY_REFRESH_FAILED",
            error instanceof Error ? error.message : "无法读取 Codex 账号状态",
            503,
          );
        }
      }

      const identityLoginMatch = url.pathname.match(
        /^\/api\/execution-identities\/([^/]+)\/login$/,
      );
      if (
        (request.method === "GET" || request.method === "POST") &&
        identityLoginMatch
      ) {
        const id = decodeURIComponent(identityLoginMatch[1]);
        const identity = store.getExecutionIdentity(id);
        if (!identity) {
          return executionIdentityErrorResponse(
            "EXECUTION_IDENTITY_NOT_FOUND",
            "找不到这个 Codex 账号",
            404,
          );
        }
        if (!executionIdentityEnvironment) {
          return executionIdentityErrorResponse(
            "IDENTITY_ENVIRONMENT_UNAVAILABLE",
            "Codex 账号环境尚未配置",
            503,
          );
        }
        if (request.method === "GET") {
          return Response.json({
            login: executionIdentityEnvironment.getLoginStatus(id),
          });
        }
        if (identity.status !== "enabled") {
          return executionIdentityErrorResponse(
            "EXECUTION_IDENTITY_DISABLED",
            "这个 Codex 账号当前不可用",
            409,
          );
        }
        if (identity.homeKind !== "managed") {
          return executionIdentityErrorResponse(
            "EXECUTION_IDENTITY_LOGIN_UNSUPPORTED",
            "系统 Codex 账号请使用 Codex 自身的登录状态",
            409,
          );
        }
        if (identity.loginState !== "signed_out" && identity.loginState !== "expired") {
          return executionIdentityErrorResponse(
            "EXECUTION_IDENTITY_ALREADY_AUTHENTICATED",
            "这个 Codex 账号已有登录状态，请先刷新账号状态",
            409,
          );
        }
        if (
          store.activeRunIds().some(
            (workOrderId) => {
              const runningIdentityId = store.get(workOrderId)?.executionIdentityId;
              return runningIdentityId === id || runningIdentityId == null;
            },
          ) || [...startingExecutionIdentityIds.values()].includes(id)
        ) {
          return executionIdentityErrorResponse(
            "EXECUTION_IDENTITY_BUSY",
            "请等待这个账号的所有运行节点结束后再登录",
            409,
          );
        }
        if (!request.headers.get("content-type")?.startsWith("application/json")) {
          return executionIdentityErrorResponse(
            "EXECUTION_IDENTITY_LOGIN_CONFIRMATION_REQUIRED",
            "请确认启动 Codex 登录",
            400,
          );
        }
        let body: { confirm?: boolean };
        try {
          body = (await request.json()) as { confirm?: boolean };
        } catch {
          return executionIdentityErrorResponse(
            "EXECUTION_IDENTITY_LOGIN_CONFIRMATION_REQUIRED",
            "请确认启动 Codex 登录",
            400,
          );
        }
        if (body.confirm !== true) {
          return executionIdentityErrorResponse(
            "EXECUTION_IDENTITY_LOGIN_CONFIRMATION_REQUIRED",
            "请确认启动 Codex 登录",
            400,
          );
        }
        try {
          const login = await executionIdentityEnvironment.startLogin(identity);
          return Response.json(
            {
              login,
              identity: presentExecutionIdentity(
                identity,
                store.getDefaultExecutionIdentityId(),
              ),
            },
            { status: 202 },
          );
        } catch (error) {
          if (error instanceof ExecutionIdentityLoginInProgressError) {
            return executionIdentityErrorResponse(
              "EXECUTION_IDENTITY_LOGIN_IN_PROGRESS",
              error.message,
              409,
            );
          }
          return executionIdentityErrorResponse(
            "EXECUTION_IDENTITY_LOGIN_FAILED",
            error instanceof Error ? error.message : "无法启动 Codex 登录流程",
            503,
          );
        }
      }

      if (request.method === "DELETE" && identityMatch) {
        const id = decodeURIComponent(identityMatch[1]);
        const identity = store.getExecutionIdentity(id);
        if (!identity) {
          return executionIdentityErrorResponse(
            "EXECUTION_IDENTITY_NOT_FOUND",
            "找不到这个 Codex 账号",
            404,
          );
        }
        try {
          const body = (await request.json()) as { confirm?: boolean };
          if (body.confirm !== true) throw new Error("请确认移除这个 Codex 账号");
          if (identity.homeKind === "managed") {
            if (!executionIdentityEnvironment) {
              return executionIdentityErrorResponse(
                "IDENTITY_ENVIRONMENT_UNAVAILABLE",
                "Codex 账号环境尚未配置",
                503,
              );
            }
            await executionIdentityEnvironment.remove(id);
          }
          const removed = store.removeExecutionIdentity(id);
          return Response.json({
            identity: presentExecutionIdentity(
              removed,
              store.getDefaultExecutionIdentityId(),
            ),
          });
        } catch (error) {
          return executionIdentityErrorResponse(
            "EXECUTION_IDENTITY_REMOVE_FAILED",
            error instanceof Error ? error.message : "无法移除 Codex 账号",
            400,
          );
        }
      }

      if (request.method === "GET" && url.pathname === "/api/local-state/export") {
        const date = new Date().toISOString().slice(0, 10);
        return Response.json(localStateTransfer.export(), {
          headers: {
            "content-disposition": `attachment; filename="teamline-state-${date}.json"`,
            "cache-control": "no-store",
          },
        });
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/local-state/restore/preview"
      ) {
        try {
          const text = await request.text();
          assertStateBundleSize(text);
          const body = JSON.parse(text) as { bundle?: unknown };
          return Response.json(localStateTransfer.preview(body.bundle));
        } catch (error) {
          return localStateErrorResponse(error);
        }
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/local-state/restore/confirm"
      ) {
        try {
          const text = await request.text();
          assertStateBundleSize(text);
          const body = JSON.parse(text) as {
            previewId?: string;
            resolutions?: Record<string, "keep_existing" | "import_copy">;
            settingsResolution?: "keep_existing" | "use_imported";
          };
          if (!body.previewId?.trim()) {
            throw new RestorePreviewMissingError("恢复预览已失效，请重新预览");
          }
          const result = localStateTransfer.confirm({
            previewId: body.previewId,
            resolutions: body.resolutions,
            settingsResolution: body.settingsResolution,
          });
          return Response.json(result, { status: 201 });
        } catch (error) {
          return localStateErrorResponse(error);
        }
      }

      if (request.method === "GET" && url.pathname === "/api/notifications") {
        store.syncWorkOrderNotifications();
        const notifications = store.listNotifications();
        return Response.json({
          notifications,
          unreadCount: store.countUnreadNotifications(),
          settings: store.getNotificationSettings(),
        });
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/notifications/claim"
      ) {
        store.syncWorkOrderNotifications();
        return Response.json({ notifications: store.claimPendingNotifications() });
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/notifications/release"
      ) {
        try {
          const body = (await request.json()) as { id?: number };
          store.releaseNotificationClaim(body.id ?? NaN);
          return Response.json({ ok: true });
        } catch (error) {
          return Response.json(
            {
              code: "INVALID_NOTIFICATION_RELEASE",
              error: error instanceof Error ? error.message : "无法重新排队通知",
            },
            { status: 400 },
          );
        }
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/notifications/read"
      ) {
        try {
          const body = (await request.json()) as {
            id?: number;
            workOrderId?: string;
          };
          if (body.id !== undefined) {
            store.markNotificationRead(body.id);
          } else if (body.workOrderId?.trim()) {
            store.markWorkOrderNotificationsRead(body.workOrderId.trim());
          } else {
            throw new Error("请选择要标记的通知");
          }
          return Response.json({ ok: true });
        } catch (error) {
          return Response.json(
            {
              code: "INVALID_NOTIFICATION_READ",
              error: error instanceof Error ? error.message : "无法标记通知",
            },
            { status: 400 },
          );
        }
      }

      if (
        request.method === "GET" &&
        url.pathname === "/api/notification-settings"
      ) {
        return Response.json({ settings: store.getNotificationSettings() });
      }

      if (
        request.method === "PUT" &&
        url.pathname === "/api/notification-settings"
      ) {
        try {
          const body = (await request.json()) as {
            autoRunStarted?: boolean;
            autoRunStopped?: boolean;
          };
          return Response.json({
            settings: store.saveNotificationSettings({
              autoRunStarted: body.autoRunStarted as boolean,
              autoRunStopped: body.autoRunStopped as boolean,
            }),
          });
        } catch (error) {
          return Response.json(
            {
              code: "INVALID_NOTIFICATION_SETTINGS",
              error: error instanceof Error ? error.message : "无法保存通知设置",
            },
            { status: 400 },
          );
        }
      }

      if (request.method === "GET" && url.pathname === "/api/work-orders") {
        return Response.json({ workOrders: store.list() });
      }

      if (request.method === "GET" && url.pathname === "/api/projects") {
        return Response.json({ projects: store.listProjects() });
      }

      if (request.method === "POST" && url.pathname === "/api/projects") {
        try {
          const body = (await request.json()) as { name?: string };
          return Response.json(
            { project: store.createProject(body.name ?? "") },
            { status: 201 },
          );
        } catch (error) {
          return Response.json(
            {
              code: "INVALID_PROJECT",
              error: error instanceof Error ? error.message : "无法创建项目",
            },
            { status: 400 },
          );
        }
      }

      const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (request.method === "GET" && projectMatch) {
        const projectId = decodeURIComponent(projectMatch[1]);
        const project = store.getProject(projectId);
        if (!project) {
          return Response.json(
            { code: "PROJECT_NOT_FOUND", error: "找不到这个项目" },
            { status: 404 },
          );
        }
        const goals = store.list().filter((workOrder) => workOrder.projectId === projectId);
        const results = goals
          .filter(
            (workOrder) =>
              workOrder.result ||
              workOrder.plan?.stages.some((stage) => stage.artifacts.length),
          )
          .map((workOrder) => ({
            workOrderId: workOrder.id,
            title: workOrder.name,
            status: workOrder.status,
            summary: workOrder.currentSummary,
            artifacts:
              workOrder.plan?.stages.flatMap((stage) => stage.artifacts).slice(0, 8) ?? [],
            gitSummary: workOrder.result?.git.diffStat ?? "",
          }));
        return Response.json({
          project,
          summary: {
            totalGoals: goals.length,
            completedGoals: goals.filter((workOrder) => workOrder.status === "delivered").length,
          },
          goals,
          materials: store.listProjectScopeMaterials(projectId),
          results,
        });
      }

      const recommendationsMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/material-recommendations$/,
      );
      if (request.method === "GET" && recommendationsMatch) {
        try {
          const projectId = decodeURIComponent(recommendationsMatch[1]);
          if (!store.getProject(projectId)) throw new Error("找不到这个项目");
          return Response.json(
            store.recommendProjectMaterials(
              projectId,
              url.searchParams.get("name") ?? "",
              url.searchParams.get("description") ?? "",
            ),
          );
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "无法推荐项目素材" },
            { status: 400 },
          );
        }
      }

      const projectMaterialsMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/materials$/,
      );
      if (request.method === "POST" && projectMaterialsMatch) {
        try {
          const projectId = decodeURIComponent(projectMaterialsMatch[1]);
          const body = (await request.json()) as {
            kind?: string;
            label?: string;
            value?: string;
          };
          if (!projectMaterialKinds.includes(body.kind as ProjectMaterialKind)) {
            throw new Error("素材类型无法识别");
          }
          const material = store.createProjectMaterial(projectId, {
            kind: body.kind as ProjectMaterialKind,
            label: body.label ?? "",
            value: body.value ?? "",
          });
          return Response.json({ material }, { status: 201 });
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "无法添加项目素材" },
            { status: 400 },
          );
        }
      }

      const projectUploadsMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/uploads$/,
      );
      if (request.method === "POST" && projectUploadsMatch) {
        try {
          const projectId = decodeURIComponent(projectUploadsMatch[1]);
          if (!store.getProject(projectId)) throw new Error("找不到这个项目");
          const form = await request.formData();
          const file = form.get("file");
          if (!(file instanceof File) || !file.name) throw new Error("请选择文件");
          if (file.size > 20 * 1024 * 1024) throw new Error("文件不能超过 20 MB");
          const safeName = safeUploadName(file.name);
          const uploadDirectory = join(dataDirectory, "project-files");
          mkdirSync(uploadDirectory, { recursive: true });
          const location = join(uploadDirectory, `${crypto.randomUUID()}-${safeName}`);
          let material;
          try {
            await Bun.write(location, file);
            material = store.createProjectMaterial(projectId, {
              kind: file.type.startsWith("image/") ? "image" : "file",
              label: file.name,
              value: location,
            });
          } catch (error) {
            try {
              unlinkSync(location);
            } catch {
              // The upload either did not finish or has already been removed.
            }
            throw error;
          }
          return Response.json({ material }, { status: 201 });
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "无法上传文件" },
            { status: 400 },
          );
        }
      }

      if (request.method === "GET" && url.pathname === "/api/session-monitoring") {
        return url.searchParams.get("refresh") === "1" || url.searchParams.get("refresh") === "true"
          ? Response.json(await discoverSessionMonitoringOnce())
          : Response.json(sessionMonitoringState());
      }

      if (request.method === "GET" && url.pathname === "/api/session-monitoring/automatic") {
        return Response.json({
          enabled: store.getSessionMonitoringAutomaticRefreshEnabled(),
        });
      }

      if (request.method === "PUT" && url.pathname === "/api/session-monitoring/automatic") {
        try {
          const body = (await request.json()) as { enabled?: unknown };
          if (typeof body.enabled !== "boolean") throw new Error("自动更新开关格式无效");
          const enabled = store.saveSessionMonitoringAutomaticRefreshEnabled(body.enabled);
          if (enabled) scheduleSessionMonitoringScan(0);
          else {
            cancelSessionMonitoringTimer?.();
            cancelSessionMonitoringTimer = null;
          }
          return Response.json({ enabled });
        } catch (error) {
          return Response.json(
            { code: "INVALID_SESSION_MONITORING_SETTING", error: error instanceof Error ? error.message : "无法保存自动更新设置" },
            { status: 400 },
          );
        }
      }

      const projectMonitoringDefaultMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/session-monitoring-default$/,
      );
      if (
        projectMonitoringDefaultMatch &&
        (request.method === "GET" || request.method === "PUT")
      ) {
        try {
          const projectId = decodeURIComponent(projectMonitoringDefaultMatch[1]);
          if (request.method === "GET") {
            return Response.json({
              projectId,
              enabled: store.getProjectMonitoringDefault(projectId),
            });
          }
          const body = (await request.json()) as { enabled?: unknown };
          if (typeof body.enabled !== "boolean") throw new Error("项目监控默认格式无效");
          const setting = store.setProjectMonitoringDefault(projectId, body.enabled);
          if (body.enabled) scheduleSessionMonitoringScan(0);
          return Response.json(setting);
        } catch (error) {
          return Response.json(
            { code: "INVALID_PROJECT_MONITORING_DEFAULT", error: error instanceof Error ? error.message : "无法保存项目监控默认" },
            { status: 400 },
          );
        }
      }

      if (request.method === "GET" && url.pathname === "/api/session-monitoring/works") {
        return Response.json({
          works: presentSessionMonitoringWorks(
            store.listSessionMonitoringWorks(),
            store.listSessionMonitoring(),
          ),
        });
      }

      if (request.method === "POST" && url.pathname === "/api/session-monitoring/works") {
        try {
          const body = (await request.json()) as {
            name?: string;
            projectId?: string | null;
            sourceSessionKeys?: string[];
            sessionKeys?: string[];
          };
          const work = store.createSessionMonitoringWork({
            name: body.name ?? "",
            projectId: body.projectId,
            sourceSessionKeys: body.sourceSessionKeys ?? body.sessionKeys ?? [],
          });
          return Response.json({ work: presentSessionMonitoringWorks(
            [work],
            store.listSessionMonitoring(),
          )[0] }, { status: 201 });
        } catch (error) {
          return Response.json(
            { code: "INVALID_SESSION_MONITORING_WORK", error: error instanceof Error ? error.message : "无法创建监控工作" },
            { status: 400 },
          );
        }
      }

      const sessionMonitoringWorkMatch = url.pathname.match(
        /^\/api\/session-monitoring\/works\/([^/]+)$/,
      );
      if (request.method === "PATCH" && sessionMonitoringWorkMatch) {
        try {
          const body = (await request.json()) as {
            name?: string;
            projectId?: string | null;
            sourceSessionKeys?: string[];
            sessionKeys?: string[];
          };
          const work = store.updateSessionMonitoringWork(
            decodeURIComponent(sessionMonitoringWorkMatch[1]),
            {
              name: body.name,
              projectId: body.projectId,
              sourceSessionKeys: body.sourceSessionKeys ?? body.sessionKeys,
            },
          );
          return Response.json({ work: presentSessionMonitoringWorks(
            [work],
            store.listSessionMonitoring(),
          )[0] });
        } catch (error) {
          return Response.json(
            { code: "INVALID_SESSION_MONITORING_WORK", error: error instanceof Error ? error.message : "无法修改监控工作" },
            { status: 400 },
          );
        }
      }

      if (request.method === "POST" && url.pathname === "/api/session-monitoring/onboarding") {
        try {
          return Response.json(confirmSessionMonitoringOnboarding(await request.json()));
        } catch (error) {
          return Response.json(
            { code: "INVALID_SESSION_MONITORING_ONBOARDING", error: error instanceof Error ? error.message : "无法保存首次发现选择" },
            { status: 400 },
          );
        }
      }

      if (request.method === "POST" && url.pathname === "/api/session-monitoring/refresh") {
        try {
          return Response.json(await requestSessionMonitoringRefresh(await request.json()));
        } catch (error) {
          return Response.json(
            { code: "INVALID_SESSION_MONITORING_REFRESH", error: error instanceof Error ? error.message : "无法安排会话刷新" },
            { status: 400 },
          );
        }
      }

      if (
        request.method === "POST" &&
        ["/api/session-monitoring", "/api/session-monitoring/discover"].includes(url.pathname)
      ) {
        if (
          url.pathname === "/api/session-monitoring/discover" &&
          store.listSessionMonitoring().length === 0 &&
          store.listProjects().length === 0 &&
          store.list().length === 0
        ) {
          sessionMonitoringOnboardingDismissed = false;
          sessionMonitoringPreview = null;
          sessionMonitoringPreviewAt = null;
          sessionMonitoringPreviewForAdd = url.searchParams.get("preview") === "1" ||
            url.searchParams.get("preview") === "true";
        } else if (
          url.pathname === "/api/session-monitoring/discover" &&
          (url.searchParams.get("preview") === "1" || url.searchParams.get("preview") === "true")
        ) {
          sessionMonitoringOnboardingDismissed = false;
          sessionMonitoringPreview = null;
          sessionMonitoringPreviewAt = null;
          sessionMonitoringPreviewForAdd = true;
        }
        if (url.pathname === "/api/session-monitoring") {
          let body: unknown = null;
          try {
            body = await request.json();
          } catch {
            // An empty POST starts a discovery scan.
          }
          if (
            body &&
            typeof body === "object" &&
            !Array.isArray(body) &&
            ("sessions" in body || "selections" in body)
          ) {
            try {
              return Response.json(updateSessionMonitoringSelections(body));
            } catch (error) {
              return Response.json(
                {
                  code: "INVALID_SESSION_MONITORING_SELECTION",
                  error: error instanceof Error ? error.message : "无法保存会话选择",
                },
                { status: 400 },
              );
            }
          }
        }
        return Response.json(await discoverSessionMonitoringOnce());
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/session-monitoring/selections"
      ) {
        try {
          return Response.json(
            updateSessionMonitoringSelections(await request.json()),
          );
        } catch (error) {
          return Response.json(
            {
              code: "INVALID_SESSION_MONITORING_SELECTION",
              error: error instanceof Error ? error.message : "无法保存会话选择",
            },
            { status: 400 },
          );
        }
      }

      if (
        request.method === "POST" &&
        ["/api/session-monitoring/create-goal", "/api/session-monitoring/goals"].includes(
          url.pathname,
        )
      ) {
        try {
          return Response.json(
            createGoalFromSessionMonitoring(await request.json()),
            { status: 201 },
          );
        } catch (error) {
          return Response.json(
            {
              code: "INVALID_SESSION_MONITORING_GOAL",
              error: error instanceof Error ? error.message : "无法从监控进展创建目标",
            },
            { status: 400 },
          );
        }
      }

      const sessionMonitoringRetryMatch = url.pathname.match(
        /^\/api\/session-monitoring\/([^/]+)\/retry$/,
      );
      if (request.method === "POST" && sessionMonitoringRetryMatch) {
        const key = decodeURIComponent(sessionMonitoringRetryMatch[1]);
        const record = store.getSessionMonitoring(key);
        if (!record) {
          return Response.json(
            { code: "SESSION_MONITORING_NOT_FOUND", error: "找不到这个本机会话" },
            { status: 404 },
          );
        }
        if (!record.monitoringEnabled) {
          return Response.json(
            { code: "SESSION_MONITORING_DISABLED", error: "请先启用这个会话的监控" },
            { status: 409 },
          );
        }
        if (!queueSessionMonitoringRetry(key)) {
          return Response.json(
            { code: "SESSION_MONITORING_BUSY", error: "会话监控正在整理，请稍候" },
            { status: 409 },
          );
        }
        return Response.json(
          { outcome: "pending", session: presentSessionMonitoring(record) },
          { status: 202 },
        );
      }

      const openSessionSourceMatch = url.pathname.match(
        /^\/api\/session-monitoring\/([^/]+)\/source\/open$/,
      );
      if (request.method === "POST" && openSessionSourceMatch) {
        const key = decodeURIComponent(openSessionSourceMatch[1]);
        const record = store.getSessionMonitoring(key) ?? sessionMonitoringPreview?.get(key)?.record ?? null;
        if (!record) {
          return Response.json(
            { code: "SESSION_MONITORING_NOT_FOUND", error: "找不到这个本机会话" },
            { status: 404 },
          );
        }
        if (!record.sourcePath || !existsSync(record.sourcePath)) {
          return Response.json(
            { code: "SESSION_SOURCE_UNAVAILABLE", error: "来源记录当前不可用" },
            { status: 409 },
          );
        }
        try {
          await openLocalArtifact(record.sourcePath, false);
          return Response.json({ opened: true });
        } catch (error) {
          return Response.json(
            {
              code: "SESSION_SOURCE_OPEN_FAILED",
              error: error instanceof Error ? error.message : "无法打开来源记录",
            },
            { status: 500 },
          );
        }
      }

      const sessionMonitoringMatch = url.pathname.match(
        /^\/api\/session-monitoring\/([^/]+)$/,
      );
      if (
        (request.method === "PATCH" || request.method === "PUT") &&
        sessionMonitoringMatch
      ) {
        try {
          const key = decodeURIComponent(sessionMonitoringMatch[1]);
          const body = (await request.json()) as {
            projectId?: string | null;
            monitoringEnabled?: boolean;
            enabled?: boolean;
            monitoringOverride?: boolean | null;
            lastReadPosition?: number | null;
            lastReadAt?: string | null;
            organizationStatus?: "not_started" | "pending" | "ready" | "failed";
            workGraphSnapshot?: unknown | null;
          };
          const update = {
            ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
            ...(body.monitoringEnabled !== undefined || body.enabled !== undefined
              ? { monitoringEnabled: body.monitoringEnabled ?? body.enabled }
              : {}),
            ...(body.monitoringOverride !== undefined
              ? { monitoringOverride: body.monitoringOverride }
              : {}),
            ...(body.lastReadPosition !== undefined
              ? { lastReadPosition: body.lastReadPosition }
              : {}),
            ...(body.lastReadAt !== undefined ? { lastReadAt: body.lastReadAt } : {}),
            ...(body.organizationStatus !== undefined
              ? { organizationStatus: body.organizationStatus }
              : {}),
            ...(body.workGraphSnapshot !== undefined
              ? { workGraphSnapshot: body.workGraphSnapshot }
              : {}),
          };
          materializePreviewSession(key, update);
          const updated = store.updateSessionMonitoring(key, update);
          if (update.monitoringEnabled === false) {
            monitoringControllers.get(key)?.abort();
          }
          if (body.monitoringEnabled !== undefined || body.enabled !== undefined) {
            scheduleSessionMonitoringScan(0);
          }
          return Response.json({ session: presentSessionMonitoring(updated) });
        } catch (error) {
          return Response.json(
            {
              code: "INVALID_SESSION_MONITORING_UPDATE",
              error: error instanceof Error ? error.message : "无法更新会话监控设置",
            },
            { status: 400 },
          );
        }
      }

      if (
        request.method === "GET" &&
        ["/api/sessions", "/api/codex-sessions"].includes(url.pathname)
      ) {
        const sourceKind = sessionSourceKindFromRequest(url);
        const requestedIdentityId = url.searchParams.get("executionIdentityId")?.trim() || null;
        let sourceProvider: SessionProvider | undefined;
        let sourceIdentity: ExecutionIdentity | null = null;
        try {
          if (sourceKind === "codex_session") {
            const source = codexDiscoverySource(requestedIdentityId);
            sourceProvider = source.provider;
            sourceIdentity = source.identity;
          } else {
            sourceProvider = claudeCodeSessionProvider;
          }
        } catch (error) {
          return Response.json(
            {
              code: "SESSION_SOURCE_IDENTITY_NOT_FOUND",
              error: error instanceof Error ? error.message : "找不到会话来源账号",
            },
            { status: 404 },
          );
        }
        if (!sourceProvider) {
          return Response.json({
            status: "unavailable",
            message: `${sourceKindLabel(sourceKind)} 会话发现服务尚未配置`,
            sessions: [],
          });
        }
        const result = await sourceProvider.discover();
        const query = url.searchParams.get("q")?.trim().toLocaleLowerCase() ?? "";
        const workOrders = store.list();
        const sessions = result.sessions
          .filter((session) => matchesSessionSearch(session, query))
          .map((session) => presentSession(session, workOrders, sourceKind));
        return Response.json({
          ...result,
          sourceKind,
          sourceLabel: sourceKindLabel(sourceKind),
          executionIdentityId: sourceIdentity?.id ?? null,
          sessions,
        });
      }

      if (
        request.method === "POST" &&
        ["/api/sessions/import", "/api/codex-sessions/import"].includes(url.pathname)
      ) {
        let sourceKind: WorkOrder["sourceSessions"][number]["kind"] = "codex_session";
        let sourceProvider: SessionProvider | undefined;
        if (url.pathname === "/api/codex-sessions/import") {
          sourceProvider = codexSessionProvider;
        }
        try {
          const body = (await request.json()) as {
            name?: string;
            projectId?: string | null;
            sessionIds?: string[];
            source?: string;
            executionIdentityId?: string | null;
          };
          if (url.pathname === "/api/sessions/import") {
            sourceKind = parseSessionSourceKind(body.source);
          }
          const sourceIdentity = sourceKind === "codex_session"
            ? codexDiscoverySource(body.executionIdentityId?.trim() || null).identity
            : null;
          sourceProvider = sourceKind === "codex_session"
            ? codexDiscoverySource(sourceIdentity!.id).provider
            : claudeCodeSessionProvider;
          if (!sourceProvider) {
            return Response.json(
              {
                code: "SESSION_DISCOVERY_UNAVAILABLE",
                error: `${sourceKindLabel(sourceKind)} 会话发现服务尚未配置`,
              },
              { status: 503 },
            );
          }
          const name = body.name?.trim() ?? "";
          if (!name) throw new Error("请填写目标名称");
          const sessionIds = normalizeSessionIds(body.sessionIds);
          const projectId = body.projectId?.trim() || null;
          if (projectId && !store.getProject(projectId)) throw new Error("找不到所选项目");
          const discovered = await sourceProvider.discover();
          const candidates = new Map(discovered.sessions.map((session) => [session.id, session]));
          const selected = sessionIds.map((id) => {
            const candidate = candidates.get(id);
            if (!candidate) {
              throw new Error(`选中的 ${sourceKindLabel(sourceKind)} 会话已经不可用，请刷新后重试`);
            }
            if (!candidate.sourcePath || candidate.availability === "unavailable") {
              throw new Error(`“${candidate.title}”的来源文件不可用，无法导入`);
            }
            const duplicate = findImportedSession(store.list(), sourceKind, candidate.id);
            if (duplicate) {
              throw new Error(`“${candidate.title}”已经属于目标“${duplicate.name}”`);
            }
            return candidate;
          });
          const commonWorkspacePath = sharedSessionWorkspace(selected);
          const sourceExecutionIdentityId = sourceIdentity?.id ?? null;
          const workOrder = store.create({
            name,
            description: name,
            projectId,
            workspace: commonWorkspacePath
              ? {
                  kind: isGitRepository(commonWorkspacePath) ? "git" : "directory",
                  path: commonWorkspacePath,
                }
              : null,
            sourceSessions: selected.map((candidate) => ({
                kind: sourceKind,
                id: candidate.id,
                lastActiveAt: candidate.lastActiveAt,
                lastReadAt: null,
                ...(sourceExecutionIdentityId
                  ? {
                      executionIdentityId: sourceExecutionIdentityId,
                      openInCodex: sourceIdentity?.homeKind === "system",
                    }
                  : {}),
                version: 1,
              })),
            executionIdentityId: sourceExecutionIdentityId,
            importContext: {
              status: "pending",
              summary: null,
              currentState: null,
              completedHighlights: [],
              nextAction: null,
              historicalStages: [],
              artifacts: [],
              organizedAt: null,
              error: null,
            },
          });
          scheduleImportedWorkOrderOrganization(workOrder.id);
          return Response.json(
            { outcome: "pending", workOrder },
            { status: 201 },
          );
        } catch (error) {
          return Response.json(
            {
              code: url.pathname === "/api/codex-sessions/import"
                ? "INVALID_CODEX_SESSION_IMPORT"
                : "INVALID_SESSION_IMPORT",
              error: error instanceof Error ? error.message : "无法导入会话",
            },
            { status: 400 },
          );
        }
      }

      const organizeImportMatch = url.pathname.match(
        /^\/api\/work-orders\/([^/]+)\/import-context\/organize$/,
      );
      if (request.method === "POST" && organizeImportMatch) {
        try {
          return Response.json(
            await organizeImportedWorkOrder(decodeURIComponent(organizeImportMatch[1])),
          );
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "无法整理来源会话" },
            { status: 400 },
          );
        }
      }

      if (request.method === "GET" && url.pathname === "/api/console") {
        const executionSettings = store.getExecutionSettings();
        return Response.json({
          workOrders: presentConsoleWorkOrders(
            store.list(),
            executionSettings.maxConcurrency,
            store.getCurrentExecutionIdentityId(),
            store.getDefaultExecutionIdentityId(),
          ),
          executionSettings,
        });
      }

      if (request.method === "GET" && url.pathname === "/api/execution-settings") {
        return Response.json({ executionSettings: store.getExecutionSettings() });
      }

      if (request.method === "GET" && url.pathname === "/api/preferences/language") {
        return Response.json({ language: store.getInterfaceLanguage() });
      }

      if (request.method === "PUT" && url.pathname === "/api/preferences/language") {
        const body = (await request.json()) as { language?: unknown };
        const language = normalizeLocale(body.language);
        if (!language) {
          return Response.json(
            { code: "locale.invalid", error: "界面语言无效" },
            { status: 400 },
          );
        }
        return Response.json({ language: store.saveInterfaceLanguage(language) });
      }

      if (request.method === "PUT" && url.pathname === "/api/execution-settings") {
        try {
          const body = (await request.json()) as { maxConcurrency?: number };
          const executionSettings = store.saveMaxConcurrency(
            body.maxConcurrency ?? NaN,
          );
          scheduleAutoRunCheck();
          return Response.json({ executionSettings });
        } catch (error) {
          return Response.json(
            {
              code: "INVALID_EXECUTION_SETTINGS",
              error: error instanceof Error ? error.message : "无法保存执行设置",
            },
            { status: 400 },
          );
        }
      }

      if (
        request.method === "GET" &&
        url.pathname === "/api/preferences/execution-map-view"
      ) {
        return Response.json({ view: store.getExecutionMapView() });
      }

      if (
        request.method === "PUT" &&
        url.pathname === "/api/preferences/execution-map-view"
      ) {
        const body = (await request.json()) as { view?: string };
        if (body.view !== "map" && body.view !== "list") {
          return Response.json(
            { code: "INVALID_EXECUTION_MAP_VIEW", error: "请选择节点图或纵向列表" },
            { status: 400 },
          );
        }
        return Response.json({ view: store.saveExecutionMapView(body.view) });
      }

      if (request.method === "GET" && url.pathname === "/api/resources") {
        const snapshot = await readResourceSnapshot();
        const defaultIdentityId = store.getDefaultExecutionIdentityId();
        const currentIdentityId =
          store.getCurrentExecutionIdentityId() ?? defaultIdentityId;
        const displayedSnapshot = identityResourceProvider
          ? {
              ...snapshot,
              codex:
                latestIdentityQuota.find(
                  ({ identity }) => identity.id === currentIdentityId,
                )?.signal ?? snapshot.codex,
            }
          : snapshot;
        const resources = presentResources(
          displayedSnapshot,
          store.list(),
          store.getExecutionSettings().maxConcurrency,
          store.listSessionMonitoringResourceUsage(),
        );
        const paidAttribution = store.getPaidApiAttributionState();
        return Response.json({
          ...resources,
          ...(identityResourceProvider
            ? {
                codexAccounts: presentIdentityQuota(
                  latestIdentityQuota,
                  defaultIdentityId,
                  currentIdentityId,
                ),
              }
            : {}),
          paidApi: {
            available: paidApiAvailable(),
            budget: store.getPaidApiBudgetSettings(),
            note:
              "用量由提供方延迟回传，Teamline 会在观察到限额后停止后续付费节点，但当前节点仍可能产生少量超支。",
            ...(paidAttribution.pending
              ? {
                  pending: {
                    workOrderId: paidAttribution.pending.workOrderId,
                    startedAt: paidAttribution.pending.startedAt,
                  },
                }
              : {}),
          },
        });
      }

      if (request.method === "PUT" && url.pathname === "/api/resources/paid-api-budget") {
        try {
          const body = (await request.json()) as { monthlyBudgetUsd?: number | null };
          if (body.monthlyBudgetUsd === undefined) {
            throw new Error("请填写 API 月度预算");
          }
          const budget = store.savePaidApiBudgetSettings(body.monthlyBudgetUsd);
          scheduleAutoRunCheck();
          return Response.json({ budget });
        } catch (error) {
          return Response.json(
            {
              code: "INVALID_PAID_API_BUDGET",
              error: error instanceof Error ? error.message : "无法保存 API 月度预算",
            },
            { status: 400 },
          );
        }
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/resources/paid-api-attribution/clear"
      ) {
        try {
          const body = (await request.json()) as {
            workOrderId?: string;
            confirmNoPendingCharge?: boolean;
          };
          if (body.confirmNoPendingCharge !== true || !body.workOrderId) {
            throw new Error("请确认这次执行没有尚未回传的费用");
          }
          const pending = store.getPaidApiAttributionState().pending;
          if (!pending || pending.workOrderId !== body.workOrderId) {
            throw new Error("当前没有这笔待确认的 API 用量");
          }
          store.cancelPaidApiAttribution(body.workOrderId);
          scheduleAutoRunCheck();
          return Response.json({ cleared: true });
        } catch (error) {
          return Response.json(
            {
              code: "PAID_API_ATTRIBUTION_CLEAR_REJECTED",
              error: error instanceof Error ? error.message : "无法解除 API 用量等待",
            },
            { status: 400 },
          );
        }
      }

      if (request.method === "POST" && url.pathname === "/api/resources/run-once") {
        return Response.json(await runAutoRunOnce());
      }

      const goalIdentityMatch = url.pathname.match(
        /^\/api\/work-orders\/([^/]+)\/execution-identity$/,
      );
      if (request.method === "POST" && goalIdentityMatch) {
        const id = decodeURIComponent(goalIdentityMatch[1]);
        if (!store.get(id)) {
          return Response.json(
            { code: "WORK_ORDER_NOT_FOUND", error: "找不到这个目标" },
            { status: 404 },
          );
        }
        try {
          const body = (await request.json()) as {
            executionIdentityId?: string;
            confirm?: boolean;
          };
          if (body.confirm !== true) throw new Error("请确认切换这个目标的 Codex 账号");
          const workOrder = store.switchExecutionIdentity(
            id,
            body.executionIdentityId?.trim() ?? "",
          );
          return Response.json({ workOrder });
        } catch (error) {
          return Response.json(
            {
              code: "EXECUTION_IDENTITY_SWITCH_REJECTED",
              error: error instanceof Error ? error.message : "无法切换 Codex 账号",
            },
            { status: 409 },
          );
        }
      }

      const startMatch = url.pathname.match(/^\/api\/work-orders\/([^/]+)\/start$/);
      if (request.method === "POST" && startMatch) {
        const id = decodeURIComponent(startMatch[1]);
        const autoRunRequested = request.headers.get("x-teamline-auto-run") === "1";
        const workOrder = store.get(id);
        if (!workOrder) {
          return Response.json(
            { code: "WORK_ORDER_NOT_FOUND", error: "找不到这个目标" },
            { status: 404 },
          );
        }
        if (isImportOnlyWorkOrder(workOrder)) {
          return importOnlyResponse();
        }
        if (workOrder.runStatus === "running" || startingWorkOrderIds.has(id)) {
          return Response.json(
            { code: "WORK_ORDER_ALREADY_RUNNING", error: "这个目标已经在运行" },
            { status: 409 },
          );
        }
        if (workOrder.status !== "ready" || !workOrder.plan) {
          return Response.json(
            { code: "WORK_ORDER_NOT_READY", error: "请先保存并确认执行计划" },
            { status: 409 },
          );
        }
        if (workOrder.plan.confirmationRequired) {
          return Response.json(
            {
              code: "PLAN_CONFIRMATION_REQUIRED",
              error: "请先检查并保存当前执行计划",
            },
            { status: 409 },
          );
        }
        const runnableStages = nextRunnableStages(workOrder);
        const externalStage = runnableStages.find(
          (stage) => stage.executionMethod === "external",
        );
        if (externalStage) {
          return Response.json(
            {
              code: "EXTERNAL_STAGE_ACTION_REQUIRED",
              error: `请先在外部完成“${externalStage.outcome}”，再回到 Teamline 标记结果`,
            },
            { status: 409 },
          );
        }
        if (!runnableStages.some((stage) => stage.executionMethod === "codex")) {
          return Response.json(
            { code: "NO_RUNNABLE_CODEX_STAGE", error: "当前没有可以启动的 Codex 节点" },
            { status: 409 },
          );
        }
        if (!workOrder.workspace) {
          return Response.json(
            {
              code: "WORKSPACE_REQUIRED",
              error: "请选择一个本地文件夹作为执行工作空间",
            },
            { status: 409 },
          );
        }
        if (!codexRunner || (workOrder.workspace.kind === "git" && !worktreeManager)) {
          return Response.json(
            { code: "EXECUTION_UNAVAILABLE", error: "Codex 执行服务尚未配置" },
            { status: 503 },
          );
        }
        let scheduledExecutionIdentityId: string;
        try {
          scheduledExecutionIdentityId = executionIdentityIdForStart(workOrder);
        } catch (error) {
          return Response.json(
            {
              code: "EXECUTION_IDENTITY_UNAVAILABLE",
              error: error instanceof Error ? error.message : "Codex 账号不可用",
            },
            { status: 409 },
          );
        }
        const identityBlock = identityStartBlock(id, scheduledExecutionIdentityId);
        if (identityBlock) {
          return Response.json(identityBlock, { status: 409 });
        }
        let workspacePath: string | null = null;
        const currentPlanHasBaseline = workOrder.checkpoints.some(
          (checkpoint) =>
            checkpoint.kind === "baseline" &&
            checkpoint.planVersion === workOrder.plan!.version,
        );
        const reusingWorkspace = Boolean(
          workOrder.worktreePath &&
            (workOrder.workspace.kind === "git"
              ? currentPlanHasBaseline
              : workOrder.plan.stages.some((stage) => stage.status === "completed")),
        );
        if (reusingWorkspace) {
          const resolved = resolveExecutionWorkspace(
            store,
            id,
            workOrder.workspace.kind,
            workOrder.worktreePath!,
          );
          if ("error" in resolved) return workspaceErrorResponse(resolved.error);
          workspacePath = resolved.path;
        } else if (workOrder.workspace.kind === "directory") {
          const resolved = resolveExecutionWorkspace(
            store,
            id,
            workOrder.workspace.kind,
            workOrder.workspace.path,
          );
          if ("error" in resolved) return workspaceErrorResponse(resolved.error);
          workspacePath = resolved.path;
        }
        if (executionCapacityReached()) {
          const { maxConcurrency } = store.getExecutionSettings();
          return Response.json(
            {
              code: "CONCURRENCY_LIMIT_REACHED",
              error: `已达到本机最大并发数（${maxConcurrency}），请等待一个目标结束或调整设置`,
            },
            { status: 409 },
          );
        }

        startingWorkOrderIds.add(id);
        startingExecutionIdentityIds.set(id, scheduledExecutionIdentityId);
        let cancelPaidAttribution = false;
        try {
          let delegatedWorktree: DelegatedWorktree | null = null;
          if (workOrder.workspace.kind === "git" && !reusingWorkspace) {
            try {
              delegatedWorktree = await worktreeManager!.prepare(workOrder);
              workspacePath = delegatedWorktree.path;
            } catch (error) {
              const message = "无法准备独立 Git worktree，请确认仓库和分支状态后重试";
              store.recordStartFailure(id, message, "执行工作区准备失败，请处理后重试");
              return Response.json(
                { code: "WORKTREE_PREPARATION_FAILED", error: message },
                { status: 500 },
              );
            }
          }

          let finalAutoRunDecision: ReturnType<typeof decideAutoRun> | null = null;
          let finalResourceSnapshot: ResourceProviderSnapshot | null = null;
          if (autoRunRequested) {
            const snapshot = await readResourceSnapshot();
            finalResourceSnapshot = snapshot;
            finalAutoRunDecision = decideAutoRun(
              store.list().filter((candidate) => !isImportOnlyWorkOrder(candidate)),
              snapshot.codex,
              store.getExecutionSettings().maxConcurrency,
              new Date(),
              identitySchedulingContext(snapshot),
            );
            for (const [candidateId, reason] of finalAutoRunDecision.reasons) {
              store.saveAutoRunReason(candidateId, reason);
            }
          }
          const latest = store.get(id);
          const otherReservations = new Set([
            ...store.activeRunIds().filter((candidateId) => candidateId !== id),
            ...[...startingWorkOrderIds].filter((candidateId) => candidateId !== id),
          ]);
          const finalRunnableStages = latest ? nextRunnableStages(latest) : [];
          const startConditionsChanged =
            !latest ||
            latest.status !== "ready" ||
            latest.runStatus !== null ||
            !latest.plan ||
            latest.plan.confirmationRequired === true ||
            latest.plan.version !== workOrder.plan.version ||
            !latest.workspace ||
            latest.workspace.kind !== workOrder.workspace.kind ||
            latest.workspace.path !== workOrder.workspace.path ||
            finalRunnableStages.some((stage) => stage.executionMethod === "external") ||
            !finalRunnableStages.some((stage) => stage.executionMethod === "codex") ||
            otherReservations.size >= store.getExecutionSettings().maxConcurrency ||
            (autoRunRequested && finalAutoRunDecision?.candidateId !== id);
          if (startConditionsChanged) {
            return Response.json(
              {
                code: "EXECUTION_CONDITIONS_CHANGED",
                error: autoRunRequested
                  ? "自动运行条件已变化，已停止本次启动"
                  : "执行条件已变化，请确认后重新启动",
              },
              { status: 409 },
            );
          }

          if (workspaceOwner(id, workspacePath!)) {
            return Response.json(
              {
                code: "WORKSPACE_IN_USE",
                error: "这个工作区已由另一个活动目标使用，请选择其他工作区",
              },
              { status: 409 },
            );
          }
          startingWorkspacePaths.set(id, workspacePath!);

          if (workOrder.workspace.kind === "git" && !reusingWorkspace) {
            store.saveWorktree(id, delegatedWorktree!);
          } else if (workOrder.workspace.kind === "directory" && !reusingWorkspace) {
            store.saveDirectWorkspace(id, workspacePath!);
          }
          let executionIdentity: ExecutionIdentity;
          try {
            store.bindExecutionIdentity(id, scheduledExecutionIdentityId);
            executionIdentity = executionIdentityForRun(
              store,
              store.get(id)!,
              reusingWorkspace && Boolean(store.get(id)!.sessionId),
            );
            selectExecutionIdentityForStart(scheduledExecutionIdentityId);
          } catch (error) {
            return Response.json(
              {
                code: "EXECUTION_IDENTITY_UNAVAILABLE",
                error: error instanceof Error ? error.message : "Codex 账号不可用",
              },
              { status: 409 },
            );
          }
          if (
            !finalResourceSnapshot &&
            workOrder.resourcePlan.paidApiFallbackEnabled
          ) {
            finalResourceSnapshot = await readResourceSnapshot();
          }
          const identityQuota = finalResourceSnapshot
            ? latestIdentityQuota.find(
                ({ identity }) => identity.id === executionIdentity.id,
              )?.signal ?? finalResourceSnapshot.codex
            : null;
          const billingMode = finalResourceSnapshot && identityQuota
            ? billingModeFor(workOrder, finalResourceSnapshot, identityQuota)
            : "subscription";
          if (!claimPaidApiAttribution(id, billingMode, finalResourceSnapshot)) {
            return Response.json(
              {
                code: "PAID_API_USAGE_PENDING",
                error: "等待上一笔 API 实际用量更新",
              },
              { status: 409 },
            );
          }
          cancelPaidAttribution = billingMode === "paid_api";
          let startedWorkOrder;
          try {
            startedWorkOrder = reusingWorkspace
              ? store.markNextStageStarted(id)
              : store.markStarted(id);
          } catch {
            return Response.json(
              {
                code: "EXECUTION_STATE_FAILED",
                error: "无法保存运行状态，Codex 尚未启动，请重试",
              },
              { status: 500 },
            );
          }
          if (workOrder.workspace.kind === "git" && checkpointManager && !reusingWorkspace) {
            const checkpointId = crypto.randomUUID();
            try {
              const treeHash = await checkpointManager.capture(
                workspacePath!,
                checkpointReference("checkpoints", id, checkpointId),
              );
              store.saveCheckpoint(id, {
                id: checkpointId,
                kind: "baseline",
                planVersion: startedWorkOrder.plan!.version,
                stageId: null,
                stageOutcome: null,
                runNumber: startedWorkOrder.runNumber,
                treeHash,
              });
              startedWorkOrder = store.get(id)!;
            } catch {
              const message = "无法保存执行起始位置，Codex 尚未启动";
              store.recordStartFailure(id, message, "起始位置保存失败，请处理后重试");
              return Response.json(
                { code: "CHECKPOINT_SAVE_FAILED", error: message },
                { status: 500 },
              );
            }
          }
          let run;
          let fallback: NextStageRun["fallback"];
          try {
            const canResume =
              reusingWorkspace &&
              Boolean(startedWorkOrder.sessionId) &&
              (workOrder.resourcePlan.lastBillingMode ?? "subscription") === billingMode;
            if (canResume && startedWorkOrder.sessionId) {
              run = await codexRunner.resume({
                workOrder: codexRunWorkOrder(startedWorkOrder),
                workspacePath: workspacePath!,
                sessionId: startedWorkOrder.sessionId,
                executionIdentity,
                billingMode,
              });
              fallback = async () => {
                if (store.get(id)?.runStatus === "stopping") return null;
                store.recordProgress(
                  id,
                  "保存的 Codex 会话不可用，已使用当前现场启动新的执行",
                );
                return codexRunner.start({
                  workOrder: codexRunWorkOrder(store.get(id)!),
                  workspacePath: workspacePath!,
                  executionIdentity,
                  billingMode,
                  continuation: await continuationContext(store, id, workspacePath!),
                });
              };
            } else {
              run = await codexRunner.start({
                workOrder: codexRunWorkOrder(startedWorkOrder),
                workspacePath: workspacePath!,
                executionIdentity,
                billingMode,
                continuation: reusingWorkspace
                  ? await continuationContext(store, id, workspacePath!)
                  : undefined,
              });
            }
          } catch (error) {
            const message = safeCodexStartError(error);
            store.recordStartFailure(id, message, "Codex 启动失败，请处理后重试");
            return Response.json(
              { code: "CODEX_START_FAILED", error: message },
              { status: 502 },
            );
          }

          startedWorkOrder = store.recordBillingStarted(id, billingMode);
          cancelPaidAttribution = false;
          store.recordRunPid(id, run.pid ?? null);
          if (autoRunRequested) {
            store.recordAutoRunStarted(id, startedWorkOrder.runNumber);
          }
          activeRuns.set(id, run);
          startRunTimeout(id);
          void consumeRunEvents(store, id, run, activeRuns, {
            executionIdentityId: executionIdentity.id,
            resultProcessor,
            clearRunTimeout: () => clearRunTimeout(id),
            finishReason: () => finishReason(id),
            checkpointManager,
            startNextStage: () => startNextCodexStage(id, workspacePath!),
            retryTransient: () =>
              retryTransientCodexFailure(
                id,
                workspacePath!,
                executionIdentity,
                billingMode,
              ),
            fallback,
            afterRunSettled: () => {
              if (autoRunRequested) {
                store.recordAutoRunStopped(id, startedWorkOrder.runNumber);
              }
              scheduleAutoRunCheck();
            },
          });
          return Response.json({ workOrder: startedWorkOrder });
        } finally {
          if (cancelPaidAttribution) store.cancelPaidApiAttribution(id);
          startingWorkOrderIds.delete(id);
          startingWorkspacePaths.delete(id);
          startingExecutionIdentityIds.delete(id);
        }
      }

      const interruptMatch = url.pathname.match(
        /^\/api\/work-orders\/([^/]+)\/interrupt$/,
      );
      if (request.method === "POST" && interruptMatch) {
        const id = decodeURIComponent(interruptMatch[1]);
        const workOrder = store.get(id);
        if (!workOrder) {
          return Response.json(
            { code: "WORK_ORDER_NOT_FOUND", error: "找不到这个目标" },
            { status: 404 },
          );
        }
        if (workOrder.runStatus === "stopping") {
          return Response.json({ workOrder });
        }
        const activeRun = activeRuns.get(id);
        if (workOrder.runStatus === "running" && !activeRun && workOrder.runPid) {
          return Response.json(
            {
              code: "RUN_CONTROL_LOST",
              error:
                "服务重启后无法控制这次仍在运行的 Codex，请在终端停止或待其结束后重启 Teamline",
            },
            { status: 409 },
          );
        }
        if (workOrder.runStatus !== "running" || !activeRun) {
          return Response.json(
            { code: "WORK_ORDER_NOT_RUNNING", error: "这个目标当前没有可中断的运行" },
            { status: 409 },
          );
        }

        const stopping = store.markStopping(id);
        activeRun.interrupt();
        return Response.json({ workOrder: stopping });
      }

      const continueMatch = url.pathname.match(
        /^\/api\/work-orders\/([^/]+)\/continue$/,
      );
      if (request.method === "POST" && continueMatch) {
        const id = decodeURIComponent(continueMatch[1]);
        const workOrder = store.get(id);
        if (!workOrder) {
          return Response.json(
            { code: "WORK_ORDER_NOT_FOUND", error: "找不到这个目标" },
            { status: 404 },
          );
        }
        if (isImportOnlyWorkOrder(workOrder)) {
          return importOnlyResponse();
        }
        if (workOrder.status !== "interrupted") {
          return Response.json(
            { code: "WORK_ORDER_NOT_INTERRUPTED", error: "只有已中断的目标可以继续" },
            { status: 409 },
          );
        }
        if (!codexRunner) {
          return Response.json(
            { code: "EXECUTION_UNAVAILABLE", error: "Codex 执行服务尚未配置" },
            { status: 503 },
          );
        }
        if (!workOrder.workspace) {
          return Response.json(
            {
              code: "WORKSPACE_REQUIRED",
              error: "请选择一个本地文件夹作为执行工作空间",
            },
            { status: 409 },
          );
        }
        if (!workOrder.worktreePath) {
          return Response.json(
            {
              code: "WORKTREE_MISSING",
              error: "执行工作区不存在，无法继续；Teamline 不会自动重建或覆盖现场",
            },
            { status: 409 },
          );
        }
        const resolvedWorkspace = resolveExecutionWorkspace(
          store,
          id,
          workOrder.workspace.kind,
          workOrder.worktreePath,
        );
        if ("error" in resolvedWorkspace) {
          if (workOrder.workspace.kind === "git" && resolvedWorkspace.error === "missing") {
            return Response.json(
              {
                code: "WORKTREE_MISSING",
                error: "执行工作区不存在，无法继续；Teamline 不会自动重建或覆盖现场",
              },
              { status: 409 },
            );
          }
          return workspaceErrorResponse(resolvedWorkspace.error);
        }
        const workspacePath =
          workOrder.workspace.kind === "directory"
            ? resolvedWorkspace.path
            : workOrder.worktreePath;
        let scheduledExecutionIdentityId: string;
        try {
          scheduledExecutionIdentityId = executionIdentityIdForStart(workOrder);
        } catch (error) {
          return Response.json(
            {
              code: "EXECUTION_IDENTITY_UNAVAILABLE",
              error: error instanceof Error ? error.message : "Codex 账号不可用",
            },
            { status: 409 },
          );
        }
        const identityBlock = identityStartBlock(id, scheduledExecutionIdentityId);
        if (identityBlock) return Response.json(identityBlock, { status: 409 });
        if (executionCapacityReached()) {
          const { maxConcurrency } = store.getExecutionSettings();
          return Response.json(
            {
              code: "CONCURRENCY_LIMIT_REACHED",
              error: `已达到本机最大并发数（${maxConcurrency}），请等待一个目标结束或调整设置`,
            },
            { status: 409 },
          );
        }
        startingWorkOrderIds.add(id);
        startingExecutionIdentityIds.set(id, scheduledExecutionIdentityId);
        if (workspaceOwner(id, workspacePath)) {
          startingWorkOrderIds.delete(id);
          startingExecutionIdentityIds.delete(id);
          return Response.json(
            {
              code: "WORKSPACE_IN_USE",
              error: "这个工作区已由另一个活动目标使用，请选择其他工作区",
            },
            { status: 409 },
          );
        }
        startingWorkspacePaths.set(id, workspacePath);
        let cancelPaidAttribution = false;
        try {
          let executionIdentity: ExecutionIdentity;
          try {
            executionIdentity = executionIdentityForRun(
              store,
              workOrder,
              Boolean(workOrder.sessionId),
            );
            selectExecutionIdentityForStart(scheduledExecutionIdentityId);
          } catch (error) {
            return Response.json(
              {
                code: "EXECUTION_IDENTITY_MISMATCH",
                error: error instanceof Error ? error.message : "Codex 账号与会话不匹配",
              },
              { status: 409 },
            );
          }
          const continueSnapshot = workOrder.resourcePlan.paidApiFallbackEnabled
            ? await readResourceSnapshot()
            : null;
          const continueQuota = continueSnapshot
            ? latestIdentityQuota.find(
                ({ identity }) => identity.id === executionIdentity.id,
              )?.signal ?? continueSnapshot.codex
            : null;
          const billingMode = continueSnapshot && continueQuota
            ? billingModeFor(workOrder, continueSnapshot, continueQuota)
            : "subscription";
          if (!claimPaidApiAttribution(id, billingMode, continueSnapshot)) {
            return Response.json(
              {
                code: "PAID_API_USAGE_PENDING",
                error: "等待上一笔 API 实际用量更新",
              },
              { status: 409 },
            );
          }
          cancelPaidAttribution = billingMode === "paid_api";
          const canResume =
            Boolean(workOrder.sessionId) &&
            (workOrder.resourcePlan.lastBillingMode ?? "subscription") === billingMode;
          const continued = store.markContinued(id);
          let run;
          try {
            run = workOrder.sessionId && canResume
              ? await codexRunner.resume({
                  workOrder: codexRunWorkOrder(continued),
                  workspacePath,
                  sessionId: workOrder.sessionId,
                  executionIdentity,
                  billingMode,
                })
              : await codexRunner.start({
                  workOrder: codexRunWorkOrder(continued),
                  workspacePath,
                  executionIdentity,
                  billingMode,
                  continuation: await continuationContext(
                    store,
                    id,
                    workspacePath,
                  ),
                });
          } catch (error) {
            const message = safeCodexStartError(error);
            store.recordExit(id, -1, message);
            return Response.json(
              { code: "CODEX_CONTINUE_FAILED", error: message },
              { status: 502 },
            );
          }
          store.recordBillingStarted(id, billingMode);
          cancelPaidAttribution = false;
          store.recordRunPid(id, run.pid ?? null);
          activeRuns.set(id, run);
          startRunTimeout(id);
          void consumeRunEvents(store, id, run, activeRuns, {
            executionIdentityId: executionIdentity.id,
            resultProcessor,
            clearRunTimeout: () => clearRunTimeout(id),
            finishReason: () => finishReason(id),
            checkpointManager,
            startNextStage: () => startNextCodexStage(id, resolvedWorkspace.path),
            retryTransient: () =>
              retryTransientCodexFailure(
                id,
                workspacePath,
                executionIdentity,
                billingMode,
              ),
            afterRunSettled: scheduleAutoRunCheck,
            fallback:
              workOrder.sessionId && codexRunner
                ? async () => {
                    const context = await continuationContext(
                      store,
                      id,
                      workspacePath,
                    );
                    if (store.get(id)?.runStatus === "stopping") {
                      return null;
                    }
                    store.recordProgress(
                      id,
                      "保存的 Codex 会话不可用，已使用当前现场启动新的执行",
                    );
                    return codexRunner.start({
                      workOrder: codexRunWorkOrder(store.get(id)!),
                      workspacePath,
                      executionIdentity,
                      billingMode,
                      continuation: context,
                    });
                  }
                : undefined,
          });
          return Response.json({ workOrder: continued });
        } finally {
          if (cancelPaidAttribution) store.cancelPaidApiAttribution(id);
          startingWorkOrderIds.delete(id);
          startingWorkspacePaths.delete(id);
          startingExecutionIdentityIds.delete(id);
        }
      }

      const reexecuteMatch = url.pathname.match(
        /^\/api\/work-orders\/([^/]+)\/reexecute$/,
      );
      if (request.method === "POST" && reexecuteMatch) {
        const id = decodeURIComponent(reexecuteMatch[1]);
        const workOrder = store.get(id);
        if (!workOrder) {
          return Response.json(
            { code: "WORK_ORDER_NOT_FOUND", error: "找不到这个目标" },
            { status: 404 },
          );
        }
        if (isImportOnlyWorkOrder(workOrder)) {
          return importOnlyResponse();
        }
        if (workOrder.status !== "interrupted") {
          return Response.json(
            { code: "WORK_ORDER_NOT_INTERRUPTED", error: "只有已中断的目标可以重新执行" },
            { status: 409 },
          );
        }
        if (
          !codexRunner ||
          !checkpointManager ||
          workOrder.workspace?.kind !== "git"
        ) {
          return Response.json(
            {
              code: "CHECKPOINT_RECOVERY_UNAVAILABLE",
              error: "当前工作空间不支持从阶段检查点重新执行，可以继续当前现场",
            },
            { status: 409 },
          );
        }
        if (!workOrder.worktreePath || !workOrder.plan) {
          return Response.json(
            { code: "WORKTREE_MISSING", error: "执行工作区不存在，无法重新执行" },
            { status: 409 },
          );
        }
        const resolvedWorkspace = resolveExecutionWorkspace(
          store,
          id,
          "git",
          workOrder.worktreePath,
        );
        if ("error" in resolvedWorkspace) {
          return Response.json(
            { code: "WORKTREE_MISSING", error: "执行工作区不存在，无法重新执行" },
            { status: 409 },
          );
        }
        const checkpoint = store.latestRecoveryCheckpoint(id);
        if (!checkpoint) {
          return Response.json(
            { code: "CHECKPOINT_MISSING", error: "没有可用的完整恢复位置" },
            { status: 409 },
          );
        }
        let scheduledExecutionIdentityId: string;
        try {
          scheduledExecutionIdentityId = executionIdentityIdForStart(workOrder);
        } catch (error) {
          return Response.json(
            {
              code: "EXECUTION_IDENTITY_UNAVAILABLE",
              error: error instanceof Error ? error.message : "Codex 账号不可用",
            },
            { status: 409 },
          );
        }
        const identityBlock = identityStartBlock(id, scheduledExecutionIdentityId);
        if (identityBlock) return Response.json(identityBlock, { status: 409 });
        if (executionCapacityReached()) {
          const { maxConcurrency } = store.getExecutionSettings();
          return Response.json(
            {
              code: "CONCURRENCY_LIMIT_REACHED",
              error: `已达到本机最大并发数（${maxConcurrency}），请等待一个目标结束或调整设置`,
            },
            { status: 409 },
          );
        }
        if (workspaceOwner(id, resolvedWorkspace.path)) {
          return Response.json(
            {
              code: "WORKSPACE_IN_USE",
              error: "这个工作区已由另一个活动目标使用，请选择其他工作区",
            },
            { status: 409 },
          );
        }

        startingWorkOrderIds.add(id);
        startingExecutionIdentityIds.set(id, scheduledExecutionIdentityId);
        startingWorkspacePaths.set(id, resolvedWorkspace.path);
        let cancelPaidAttribution = false;
        try {
          const residueId = crypto.randomUUID();
          try {
            await checkpointManager.restore(
              resolvedWorkspace.path,
              checkpoint.treeHash,
              checkpointReference("residue", id, residueId),
            );
          } catch {
            return Response.json(
              {
                code: "CHECKPOINT_RESTORE_FAILED",
                error: "无法恢复最近完整位置，新的运行尚未启动；请检查工作区后重试",
              },
              { status: 500 },
            );
          }

          const currentStage = recoveryStage(workOrder, checkpoint);
          let executionIdentity: ExecutionIdentity;
          try {
            executionIdentity = executionIdentityForRun(store, workOrder);
            selectExecutionIdentityForStart(scheduledExecutionIdentityId);
          } catch (error) {
            return Response.json(
              {
                code: "EXECUTION_IDENTITY_UNAVAILABLE",
                error: error instanceof Error ? error.message : "Codex 账号不可用",
              },
              { status: 409 },
            );
          }
          const reexecuteSnapshot = workOrder.resourcePlan.paidApiFallbackEnabled
            ? await readResourceSnapshot()
            : null;
          const reexecuteQuota = reexecuteSnapshot
            ? latestIdentityQuota.find(
                ({ identity }) => identity.id === executionIdentity.id,
              )?.signal ?? reexecuteSnapshot.codex
            : null;
          const billingMode = reexecuteSnapshot && reexecuteQuota
            ? billingModeFor(workOrder, reexecuteSnapshot, reexecuteQuota)
            : "subscription";
          if (!claimPaidApiAttribution(id, billingMode, reexecuteSnapshot)) {
            return Response.json(
              {
                code: "PAID_API_USAGE_PENDING",
                error: "等待上一笔 API 实际用量更新",
              },
              { status: 409 },
            );
          }
          cancelPaidAttribution = billingMode === "paid_api";
          const reexecuted = store.markReexecuted(id);
          store.recordProgress(
            id,
            checkpoint.kind === "stage"
              ? `已恢复到“${checkpoint.stageOutcome}”检查点，开始重新执行${currentStage ? `“${currentStage.outcome}”` : "当前节点"}`
              : `已恢复到执行起始位置，开始重新执行${currentStage ? `“${currentStage.outcome}”` : "当前节点"}`,
          );
          let run;
          try {
            run = await codexRunner.start({
              workOrder: codexRunWorkOrder(reexecuted),
              workspacePath: resolvedWorkspace.path,
              executionIdentity,
              billingMode,
              continuation: {
                ...(await continuationContext(store, id, resolvedWorkspace.path)),
                reexecuteStage: currentStage
                  ? { id: currentStage.id, outcome: currentStage.outcome }
                  : undefined,
              },
            });
          } catch (error) {
            const message = safeCodexStartError(error);
            store.recordExit(id, -1, message);
            return Response.json(
              { code: "CODEX_REEXECUTE_FAILED", error: message },
              { status: 502 },
            );
          }
          store.recordBillingStarted(id, billingMode);
          cancelPaidAttribution = false;
          store.recordRunPid(id, run.pid ?? null);
          activeRuns.set(id, run);
          startRunTimeout(id);
          void consumeRunEvents(store, id, run, activeRuns, {
            executionIdentityId: executionIdentity.id,
            resultProcessor,
            checkpointManager,
            startNextStage: () => startNextCodexStage(id, resolvedWorkspace.path),
            retryTransient: () =>
              retryTransientCodexFailure(
                id,
                resolvedWorkspace.path,
                executionIdentity,
                billingMode,
              ),
            clearRunTimeout: () => clearRunTimeout(id),
            finishReason: () => finishReason(id),
            afterRunSettled: scheduleAutoRunCheck,
          });
          return Response.json({ workOrder: store.get(id)! });
        } finally {
          if (cancelPaidAttribution) store.cancelPaidApiAttribution(id);
          startingWorkOrderIds.delete(id);
          startingWorkspacePaths.delete(id);
          startingExecutionIdentityIds.delete(id);
        }
      }

      const eventsMatch = url.pathname.match(/^\/api\/work-orders\/([^/]+)\/events$/);
      if (request.method === "GET" && eventsMatch) {
        const id = decodeURIComponent(eventsMatch[1]);
        if (!store.get(id)) {
          return Response.json(
            { code: "WORK_ORDER_NOT_FOUND", error: "找不到这个目标" },
            { status: 404 },
          );
        }
        return Response.json({ events: store.listRunEvents(id) });
      }

      const openArtifactMatch = url.pathname.match(
        /^\/api\/work-orders\/([^/]+)\/artifacts\/open$/,
      );
      if (request.method === "POST" && openArtifactMatch) {
        const workOrder = store.get(decodeURIComponent(openArtifactMatch[1]));
        if (!workOrder) {
          return Response.json(
            { code: "WORK_ORDER_NOT_FOUND", error: "找不到这个目标" },
            { status: 404 },
          );
        }
        try {
          const body = (await request.json()) as { path?: string; reveal?: boolean };
          const artifactPath = resolveCollectedArtifact(workOrder, body.path);
          if (!artifactPath) {
            return Response.json(
              { code: "INVALID_ARTIFACT_PATH", error: "找不到这个成果文件" },
              { status: 400 },
            );
          }
          await openLocalArtifact(artifactPath, body.reveal === true);
          return Response.json({ opened: true });
        } catch (error) {
          return Response.json(
            {
              code: "ARTIFACT_OPEN_FAILED",
              error: error instanceof Error ? error.message : "无法打开这个成果",
            },
            { status: 500 },
          );
        }
      }

      const deliverMatch = url.pathname.match(
        /^\/api\/work-orders\/([^/]+)\/deliver$/,
      );
      if (request.method === "POST" && deliverMatch) {
        const id = decodeURIComponent(deliverMatch[1]);
        if (!store.get(id)) {
          return Response.json(
            { code: "WORK_ORDER_NOT_FOUND", error: "找不到这个目标" },
            { status: 404 },
          );
        }
        try {
          const workOrder = store.confirmDelivered(id);
          scheduleAutoRunCheck();
          return Response.json({ workOrder });
        } catch {
          return Response.json(
            { code: "WORK_ORDER_NOT_IN_REVIEW", error: "只有待验收的目标可以确认交付" },
            { status: 409 },
          );
        }
      }

      const reviseMatch = url.pathname.match(/^\/api\/work-orders\/([^/]+)\/revise$/);
      if (request.method === "POST" && reviseMatch) {
        const id = decodeURIComponent(reviseMatch[1]);
        const workOrder = store.get(id);
        if (!workOrder) {
          return Response.json(
            { code: "WORK_ORDER_NOT_FOUND", error: "找不到这个目标" },
            { status: 404 },
          );
        }
        if (workOrder.status !== "review") {
          return Response.json(
            { code: "WORK_ORDER_NOT_IN_REVIEW", error: "只有待验收的目标可以继续调整" },
            { status: 409 },
          );
        }
        if (!planGenerator) {
          return Response.json(
            { code: "PLAN_GENERATOR_UNAVAILABLE", error: "Codex 规划服务尚未配置" },
            { status: 503 },
          );
        }
        if (planningWorkOrderIds.has(id)) {
          return Response.json(
            { code: "WORK_ORDER_PLANNING_IN_PROGRESS", error: "正在整理上一次更新，请稍候" },
            { status: 409 },
          );
        }
        planningWorkOrderIds.add(id);
        try {
          const body = (await request.json()) as { revisionNote?: string };
          const revisionNote = body.revisionNote?.trim() ?? "";
          if (!revisionNote) {
            return Response.json(
              { code: "INVALID_REVISION_NOTE", error: "请填写需要调整的内容" },
              { status: 400 },
            );
          }
          return Response.json(
            await generateAndStorePlan(id, workOrder, true, revisionNote, true),
          );
        } catch (error) {
          if (error instanceof PlanGenerationTimeoutError) {
            return Response.json(
              { code: "PLAN_GENERATION_TIMEOUT", error: "生成后续计划超时，请重试" },
              { status: 504 },
            );
          }
          return Response.json(
            {
              code: "PLAN_GENERATION_FAILED",
              error: "Codex 无法生成后续计划，请稍后重试",
            },
            { status: 502 },
          );
        } finally {
          planningWorkOrderIds.delete(id);
        }
      }

      const externalStageMatch = url.pathname.match(
        /^\/api\/work-orders\/([^/]+)\/plan-stages\/([^/]+)\/complete-external$/,
      );
      if (request.method === "POST" && externalStageMatch) {
        const id = decodeURIComponent(externalStageMatch[1]);
        const stageId = decodeURIComponent(externalStageMatch[2]);
        if (!store.get(id)) {
          return Response.json(
            { code: "WORK_ORDER_NOT_FOUND", error: "找不到这个目标" },
            { status: 404 },
          );
        }
        try {
          const body = (await request.json()) as {
            conclusion?: string;
            reference?: { type?: string; label?: string; location?: string };
          };
          const reference = body.reference
            ? {
                type: body.reference.type as "file" | "link",
                label: body.reference.label,
                location: body.reference.location ?? "",
              }
            : undefined;
          const workOrder = store.completeExternalStage(id, stageId, {
            conclusion: body.conclusion,
            reference,
          });
          scheduleAutoRunCheck();
          return Response.json({ workOrder });
        } catch (error) {
          const message = error instanceof Error ? error.message : "无法标记外部节点完成";
          return Response.json(
            {
              code:
                error instanceof PlanLockedError
                  ? "EXTERNAL_STAGE_LOCKED"
                  : "INVALID_EXTERNAL_STAGE_RESULT",
              error: message,
            },
            { status: error instanceof PlanLockedError ? 409 : 400 },
          );
        }
      }

      const confirmStageResultsMatch = url.pathname.match(
        /^\/api\/work-orders\/([^/]+)\/confirm-stage-results$/,
      );
      if (request.method === "POST" && confirmStageResultsMatch) {
        const id = decodeURIComponent(confirmStageResultsMatch[1]);
        if (!store.get(id)) {
          return Response.json(
            { code: "WORK_ORDER_NOT_FOUND", error: "找不到这个目标" },
            { status: 404 },
          );
        }
        try {
          await saveManuallyConfirmedStageCheckpoint(store, id, checkpointManager);
          const workOrder = store.confirmCurrentCodexResults(id);
          scheduleAutoRunCheck();
          return Response.json({ workOrder });
        } catch (error) {
          const message = error instanceof Error ? error.message : "无法确认 AI 节点结果";
          return Response.json(
            { code: "STAGE_RESULT_CONFIRMATION_LOCKED", error: message },
            { status: error instanceof PlanLockedError ? 409 : 400 },
          );
        }
      }

      const conversationMatch = url.pathname.match(
        /^\/api\/work-orders\/([^/]+)\/conversation$/,
      );
      if (request.method === "POST" && conversationMatch) {
        const id = decodeURIComponent(conversationMatch[1]);
        const workOrder = store.get(id);
        if (!workOrder) {
          return Response.json(
            { code: "WORK_ORDER_NOT_FOUND", error: "找不到这个目标" },
            { status: 404 },
          );
        }
        if (isImportOnlyWorkOrder(workOrder)) {
          return importOnlyResponse();
        }
        if (!planIsEditable(workOrder)) {
          return Response.json(
            { code: "WORK_ORDER_CONVERSATION_LOCKED", error: "当前状态不能更新目标对话" },
            { status: 409 },
          );
        }
        if (planningWorkOrderIds.has(id)) {
          return Response.json(
            { code: "WORK_ORDER_PLANNING_IN_PROGRESS", error: "正在整理上一次更新，请稍候" },
            { status: 409 },
          );
        }
        planningWorkOrderIds.add(id);
        let planningClaimed = true;
        try {
          const body = (await request.json()) as {
            message?: string;
            mode?: "reply" | "supplement" | "replan";
            stageId?: string;
          };
          const mode = body.mode ?? (workOrder.pendingClarification ? "reply" : "supplement");
          const message = body.message?.trim() ?? "";
          if (!message) {
            return Response.json(
              { code: "INVALID_CONVERSATION_REPLY", error: "请填写回复" },
              { status: 400 },
            );
          }
          if (mode === "supplement") {
            if (!workOrder.plan?.stages.some((stage) => stage.id === body.stageId)) {
              return Response.json(
                { code: "INVALID_CONVERSATION_REPLY", error: "找不到当前节点" },
                { status: 400 },
              );
            }
            return Response.json({
              outcome: "supplement",
              workOrder: store.addStageSupplement(id, body.stageId ?? "", message),
            });
          }
          if (mode === "reply" && !workOrder.pendingClarification) {
            return Response.json(
              { code: "INVALID_CONVERSATION_REPLY", error: "当前没有等待回答的问题" },
              { status: 400 },
            );
          }
          if (!planGenerator) {
            return Response.json(
              { code: "PLAN_GENERATOR_UNAVAILABLE", error: "Codex 规划服务尚未配置" },
              { status: 503 },
            );
          }
          const requiresPlanConfirmation =
            mode === "replan" || workOrder.pendingClarification?.requiresPlanConfirmation === true;
          const forcePlanVersion =
            workOrder.pendingClarification?.requiresPlanConfirmation === true &&
            Boolean(workOrder.revisionNote) &&
            workOrder.result?.planVersion === workOrder.plan?.version;
          const result = await generateAndStorePlan(
            id,
            workOrder,
            requiresPlanConfirmation,
            message,
            forcePlanVersion,
          );
          return Response.json(result);
        } catch (error) {
          if (error instanceof PlanGenerationTimeoutError) {
            return Response.json(
              { code: "PLAN_GENERATION_TIMEOUT", error: "整理决定超时，请重试" },
              { status: 504 },
            );
          }
          if (error instanceof PlanLockedError) {
            return Response.json(
              { code: "WORK_ORDER_CONVERSATION_LOCKED", error: error.message },
              { status: 409 },
            );
          }
          return Response.json(
            {
              code: "PLAN_GENERATION_FAILED",
              error: "Codex 无法整理这次更新，请稍后重试",
            },
            { status: 502 },
          );
        } finally {
          if (planningClaimed) planningWorkOrderIds.delete(id);
        }
      }

      const generatePlanMatch = url.pathname.match(
        /^\/api\/work-orders\/([^/]+)\/plan\/generate$/,
      );
      if (request.method === "POST" && generatePlanMatch) {
        const id = decodeURIComponent(generatePlanMatch[1]);
        let workOrder = store.get(id);
        if (!workOrder) {
          return Response.json(
            { code: "WORK_ORDER_NOT_FOUND", error: "找不到这个目标" },
            { status: 404 },
          );
        }
        if (isImportOnlyWorkOrder(workOrder)) {
          return importOnlyResponse();
        }
        if (workOrder.importContext && workOrder.importContext.status !== "ready") {
          return Response.json(
            { code: "WORK_ORDER_IMPORT_NOT_READY", error: "来源会话整理完成后才能生成计划" },
            { status: 409 },
          );
        }
        if (!planIsEditable(workOrder)) {
          return Response.json(
            { code: "WORK_ORDER_PLAN_LOCKED", error: "目标开始执行后不能直接修改计划" },
            { status: 409 },
          );
        }
        if (!planGenerator) {
          return Response.json(
            { code: "PLAN_GENERATOR_UNAVAILABLE", error: "Codex 规划服务尚未配置" },
            { status: 503 },
          );
        }
        if (planningWorkOrderIds.has(id)) {
          return Response.json(
            { code: "WORK_ORDER_PLANNING_IN_PROGRESS", error: "正在整理计划，请稍候" },
            { status: 409 },
          );
        }

        planningWorkOrderIds.add(id);
        try {
          const body = request.headers.get("content-type")?.includes("application/json")
            ? await request.json() as { continuationNote?: unknown; goal?: unknown }
            : {};
          if (typeof body.goal === "string") {
            workOrder = store.updatePlanningGoal(id, body.goal);
          }
          const continuationNote = typeof body.continuationNote === "string"
            ? body.continuationNote.trim() || undefined
            : undefined;
          return Response.json(
            await generateAndStorePlan(id, workOrder, false, continuationNote),
          );
        } catch (error) {
          if (error instanceof PlanGenerationTimeoutError) {
            return Response.json(
              { code: "PLAN_GENERATION_TIMEOUT", error: "生成计划超时，请重试" },
              { status: 504 },
            );
          }
          if (error instanceof PlanLockedError) {
            return Response.json(
              { code: "WORK_ORDER_PLAN_LOCKED", error: error.message },
              { status: 409 },
            );
          }
          return Response.json(
            {
              code: "PLAN_GENERATION_FAILED",
              error: "Codex 无法生成计划，请确认已经安装并登录后重试",
            },
            { status: 502 },
          );
        } finally {
          planningWorkOrderIds.delete(id);
        }
      }

      const planMatch = url.pathname.match(/^\/api\/work-orders\/([^/]+)\/plan$/);
      if (request.method === "PUT" && planMatch) {
        const id = decodeURIComponent(planMatch[1]);
        const workOrder = store.get(id);
        if (!workOrder) {
          return Response.json(
            { code: "WORK_ORDER_NOT_FOUND", error: "找不到这个目标" },
            { status: 404 },
          );
        }
        if (isImportOnlyWorkOrder(workOrder)) {
          return importOnlyResponse();
        }
        if (!planIsEditable(workOrder)) {
          return Response.json(
            { code: "WORK_ORDER_PLAN_LOCKED", error: "目标开始执行后不能直接修改计划" },
            { status: 409 },
          );
        }
        if (planningWorkOrderIds.has(id)) {
          return Response.json(
            { code: "WORK_ORDER_PLANNING_IN_PROGRESS", error: "正在整理计划，请稍候" },
            { status: 409 },
          );
        }

        try {
          const body = (await request.json()) as { stages?: PlanStageInput[] };
          if (!Array.isArray(body.stages)) {
            throw new Error("请填写执行计划");
          }
          const workOrder = store.savePlan(id, body.stages);
          scheduleAutoRunCheck();
          return Response.json({ workOrder });
        } catch (error) {
          if (error instanceof PlanLockedError) {
            return Response.json(
              { code: "WORK_ORDER_PLAN_LOCKED", error: error.message },
              { status: 409 },
            );
          }
          return Response.json(
            {
              code: "INVALID_PLAN",
              error: "计划内容不完整，请检查每个阶段",
            },
            { status: 400 },
          );
        }
      }

      const settingsMatch = url.pathname.match(
        /^\/api\/work-orders\/([^/]+)\/execution-settings$/,
      );
      if (request.method === "PUT" && settingsMatch) {
        const id = decodeURIComponent(settingsMatch[1]);
        const workOrder = store.get(id);
        if (!workOrder) {
          return Response.json(
            { code: "WORK_ORDER_NOT_FOUND", error: "找不到这个目标" },
            { status: 404 },
          );
        }
        if (isImportOnlyWorkOrder(workOrder)) {
          return importOnlyResponse();
        }
        try {
          const body = (await request.json()) as { maxRunMinutes?: number };
          const workOrder = store.saveMaxRunMinutes(
            id,
            body.maxRunMinutes ?? NaN,
          );
          scheduleAutoRunCheck();
          return Response.json({ workOrder });
        } catch (error) {
          const message = error instanceof Error ? error.message : "无法保存执行条件";
          return Response.json(
            { code: "INVALID_EXECUTION_SETTINGS", error: message },
            { status: error instanceof PlanLockedError ? 409 : 400 },
          );
        }
      }

      const resourcePlanMatch = url.pathname.match(
        /^\/api\/work-orders\/([^/]+)\/resource-plan$/,
      );
      const resourceSettingsMatch = url.pathname.match(
        /^\/api\/work-orders\/([^/]+)\/resource-settings$/,
      );
      if (request.method === "PUT" && resourceSettingsMatch) {
        const id = decodeURIComponent(resourceSettingsMatch[1]);
        const existingWorkOrder = store.get(id);
        if (!existingWorkOrder) {
          return Response.json(
            { code: "WORK_ORDER_NOT_FOUND", error: "找不到这个目标" },
            { status: 404 },
          );
        }
        if (isImportOnlyWorkOrder(existingWorkOrder)) {
          return importOnlyResponse();
        }
        if (planningWorkOrderIds.has(id)) {
          return Response.json(
            { code: "WORK_ORDER_PLANNING_IN_PROGRESS", error: "正在整理计划，请稍候" },
            { status: 409 },
          );
        }
        try {
          const body = (await request.json()) as {
            priority?: WorkOrder["resourcePlan"]["priority"];
            pace?: WorkOrder["resourcePlan"]["pace"];
            runWhenQuotaAvailable?: boolean;
            paidApiFallbackEnabled?: boolean;
            paidApiLimitUsd?: number | null;
            maxRunMinutes?: number;
          };
          if (
            body.priority === undefined ||
            body.pace === undefined ||
            body.runWhenQuotaAvailable === undefined
          ) {
            throw new Error("请完整填写目标资源设置");
          }
          const workOrder = store.saveTargetResourceSettings(id, {
            priority: body.priority,
            pace: body.pace,
            runWhenQuotaAvailable: body.runWhenQuotaAvailable,
            paidApiFallbackEnabled: body.paidApiFallbackEnabled,
            paidApiLimitUsd: body.paidApiLimitUsd,
            ...(body.maxRunMinutes === undefined
              ? {}
              : { maxRunMinutes: body.maxRunMinutes }),
          });
          scheduleAutoRunCheck();
          return Response.json({ workOrder });
        } catch (error) {
          return Response.json(
            {
              code: "INVALID_RESOURCE_SETTINGS",
              error: error instanceof Error ? error.message : "无法保存资源设置",
            },
            { status: error instanceof PlanLockedError ? 409 : 400 },
          );
        }
      }
      if (request.method === "PUT" && resourcePlanMatch) {
        const id = decodeURIComponent(resourcePlanMatch[1]);
        const existingWorkOrder = store.get(id);
        if (!existingWorkOrder) {
          return Response.json(
            { code: "WORK_ORDER_NOT_FOUND", error: "找不到这个目标" },
            { status: 404 },
          );
        }
        if (isImportOnlyWorkOrder(existingWorkOrder)) {
          return importOnlyResponse();
        }
        if (planningWorkOrderIds.has(id)) {
          return Response.json(
            { code: "WORK_ORDER_PLANNING_IN_PROGRESS", error: "正在整理计划，请稍候" },
            { status: 409 },
          );
        }
        try {
          const body = (await request.json()) as {
            priority?: WorkOrder["resourcePlan"]["priority"];
            pace?: WorkOrder["resourcePlan"]["pace"];
            runWhenQuotaAvailable?: boolean;
            paidApiFallbackEnabled?: boolean;
            paidApiLimitUsd?: number | null;
          };
          if (
            body.priority === undefined ||
            body.pace === undefined ||
            body.runWhenQuotaAvailable === undefined
          ) {
            throw new Error("请完整填写目标资源安排");
          }
          const workOrder = store.saveResourcePlan(id, {
            priority: body.priority,
            pace: body.pace,
            runWhenQuotaAvailable: body.runWhenQuotaAvailable,
            paidApiFallbackEnabled: body.paidApiFallbackEnabled,
            paidApiLimitUsd: body.paidApiLimitUsd,
          });
          scheduleAutoRunCheck();
          return Response.json({ workOrder });
        } catch (error) {
          return Response.json(
            {
              code: "INVALID_RESOURCE_PLAN",
              error: error instanceof Error ? error.message : "无法保存资源安排",
            },
            { status: error instanceof PlanLockedError ? 409 : 400 },
          );
        }
      }

      const workspaceMatch = url.pathname.match(
        /^\/api\/work-orders\/([^/]+)\/workspace$/,
      );
      if (request.method === "PUT" && workspaceMatch) {
        const id = decodeURIComponent(workspaceMatch[1]);
        if (!store.get(id)) {
          return Response.json(
            { code: "WORK_ORDER_NOT_FOUND", error: "找不到这个目标" },
            { status: 404 },
          );
        }
        try {
          const body = (await request.json()) as { path?: string };
          const path = body.path?.trim() ?? "";
          const resolved = validateWorkspacePath(path);
          if ("error" in resolved) return workspaceErrorResponse(resolved.error);
          const canonicalPath = resolved.path;
          const kind = isGitRepository(canonicalPath) ? "git" : "directory";
          if (kind === "directory" && directoryWorkspaceInUse(store, id, canonicalPath)) {
            return workspaceErrorResponse("in_use");
          }
          const workOrder = store.saveWorkspace(id, {
            kind,
            path: canonicalPath,
          });
          scheduleAutoRunCheck();
          return Response.json({ workOrder });
        } catch (error) {
          const message = error instanceof Error ? error.message : "无法保存工作空间";
          return Response.json(
            {
              code:
                error instanceof PlanLockedError
                  ? "WORKSPACE_LOCKED"
                  : "INVALID_WORKSPACE",
              error: message,
            },
            { status: error instanceof PlanLockedError ? 409 : 400 },
          );
        }
      }

      const workOrderMatch = url.pathname.match(/^\/api\/work-orders\/([^/]+)$/);
      if (request.method === "DELETE" && workOrderMatch) {
        const id = decodeURIComponent(workOrderMatch[1]);
        if (organizingWorkOrderIds.has(id)) {
          return Response.json(
            { code: "SESSION_ORGANIZATION_IN_PROGRESS", error: "历史正在整理，请稍候" },
            { status: 409 },
          );
        }
        try {
          store.deleteFailedImportedWorkOrder(id);
          return Response.json({ deleted: true });
        } catch (error) {
          const notFound = error instanceof WorkOrderNotFoundError;
          const message = error instanceof Error ? error.message : "无法删除这个目标";
          return Response.json(
            {
              code: notFound
                ? "WORK_ORDER_NOT_FOUND"
                : "WORK_ORDER_DELETE_LOCKED",
              error: message,
            },
            { status: notFound ? 404 : 409 },
          );
        }
      }
      if (request.method === "GET" && workOrderMatch) {
        const workOrder = store.get(decodeURIComponent(workOrderMatch[1]));
        if (!workOrder) {
          return Response.json(
            { code: "WORK_ORDER_NOT_FOUND", error: "找不到这个目标" },
            { status: 404 },
          );
        }
        const sourceKind = workOrder.sourceSessions[0]?.kind;
        let sourceProvider: SessionProvider | undefined;
        try {
          sourceProvider = sourceKind
            ? sessionProviderForSource(
                sourceKind,
                workOrder.sourceSessions[0]?.executionIdentityId,
              )
            : undefined;
        } catch {
          sourceProvider = undefined;
        }
        const sourceStatus = await inspectSourceSessions(
          workOrder,
          sourceProvider,
        );
        return Response.json({
          workOrder: await withRecoverySite(workOrder, checkpointManager),
          ...(sourceStatus ? { sourceStatus } : {}),
        });
      }

      if (request.method === "POST" && url.pathname === "/api/work-orders") {
        try {
          const body = (await request.json()) as {
            name?: string;
            description?: string;
            projectId?: string | null;
            sourceSessions?: WorkOrder["sourceSessions"];
            repositoryPath?: string;
            workspacePath?: string;
            goal?: string;
            acceptance?: string;
            materials?: Array<{ kind?: string; value?: string }>;
            projectMaterialIds?: string[];
          };
          const requestedRepositoryPath = body.repositoryPath?.trim() ?? "";
          const requestedWorkspacePath = body.workspacePath?.trim() ?? "";
          if (requestedRepositoryPath && requestedWorkspacePath) {
            return Response.json(
              { error: "请只提供一个工作空间路径" },
              { status: 400 },
            );
          }
          if (requestedRepositoryPath && !isGitRepository(requestedRepositoryPath)) {
            return Response.json(
              { error: "请选择一个有效的本地 Git 仓库" },
              { status: 400 },
            );
          }

          let workspace: WorkOrderWorkspace | null | undefined;
          if (requestedWorkspacePath) {
            const resolved = validateWorkspacePath(requestedWorkspacePath);
            if ("error" in resolved) return workspaceErrorResponse(resolved.error);
            const kind = isGitRepository(resolved.path) ? "git" : "directory";
            if (kind === "directory" && directoryWorkspaceInUse(store, "", resolved.path)) {
              return workspaceErrorResponse("in_use");
            }
            workspace = { kind, path: resolved.path };
          }

          const materials = normalizeMaterials(body.materials);
          const projectMaterialIds = normalizeProjectMaterialIds(body.projectMaterialIds);
          const projectMaterials = store.resolveProjectMaterials(
            body.projectId?.trim() || null,
            projectMaterialIds,
          );
          const workOrder = store.create({
            name: body.name,
            description: body.description,
            projectId: body.projectId,
            projectMaterialSelectionConfirmed:
              body.projectMaterialIds !== undefined,
            sourceSessions: body.sourceSessions,
            repositoryPath: requestedRepositoryPath,
            workspace,
            goal: body.goal ?? "",
            acceptance: body.acceptance,
            materials: [
              ...materials,
              ...projectMaterials.map(({ kind, value, projectMaterialId }) => ({
                kind,
                value,
                projectMaterialId,
              })),
            ],
          });
          return Response.json({ workOrder }, { status: 201 });
        } catch (error) {
          const message = error instanceof Error ? error.message : "创建目标失败";
          return Response.json({ error: message }, { status: 400 });
        }
      }

      const projectContextMatch = url.pathname.match(
        /^\/api\/work-orders\/([^/]+)\/project-context$/,
      );
      if (request.method === "PUT" && projectContextMatch) {
        try {
          const body = (await request.json()) as {
            projectId?: string | null;
            projectMaterialIds?: string[];
          };
          const workOrder = store.saveProjectContext(
            decodeURIComponent(projectContextMatch[1]),
            body.projectId?.trim() || null,
            normalizeProjectMaterialIds(body.projectMaterialIds),
          );
          return Response.json({ workOrder });
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "无法保存项目与素材" },
            { status: 400 },
          );
        }
      }

      const staticFile = staticFiles[url.pathname];
      if (request.method === "GET" && staticFile) {
        return new Response(Bun.file(join(projectRoot, staticFile.path)), {
          headers: { "content-type": staticFile.type },
        });
      }

      if (
        request.method === "GET" &&
        (url.pathname === "/resources" ||
          url.pathname === "/session-monitoring" ||
          url.pathname === "/projects" ||
          /^\/(?:goals|work-orders)\/[^/]+$/.test(url.pathname) ||
          /^\/projects\/[^/]+$/.test(url.pathname))
      ) {
        return new Response(Bun.file(join(projectRoot, "public/index.html")), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      return Response.json(
        { code: "error.not_found", error: "Not found" },
        { status: 404 },
      );
  };
  handleRequest = async (request: Request): Promise<Response> => {
    try {
      return await ensureSemanticErrorResponse(await routeRequest(request));
    } catch {
      return Response.json(
        {
          code: "error.internal",
          error: "Teamline could not complete the request",
          message: { code: "error.internal", params: {} },
        },
        { status: 500 },
      );
    }
  };
  scheduleAutoRunCheck();
  scheduleSessionMonitoringScan(0);
  return {
    fetch: handleRequest,
    async close() {
      if (closed) return;
      closed = true;
      cancelAutoRunTimer?.();
      cancelAutoRunTimer = null;
      cancelSessionMonitoringTimer?.();
      cancelSessionMonitoringTimer = null;
      sessionMonitoringDiscoveryController?.abort();
      for (const key of monitoringPending.keys()) monitoringKeys.delete(key);
      monitoringPending.clear();
      monitoringDeferred.clear();
      for (const controller of organizationControllers.values()) controller.abort();
      for (const controller of monitoringControllers.values()) controller.abort();
      await Promise.all([
        autoRunCheckInFlight?.catch(() => undefined),
        backgroundRefreshInFlight?.catch(() => undefined),
        sessionMonitoringDiscoveryInFlight?.catch(() => undefined),
        sessionMonitoringScanInFlight?.catch(() => undefined),
        ...[...backgroundOrganizationPromises].map((task) => task.catch(() => undefined)),
        ...[...backgroundMonitoringPromises].map((task) => task.catch(() => undefined)),
      ]);
      store.markInterruptedSessionOrganizations();
    },
  };
}

async function consumeRunEvents(
  store: WorkOrderStore,
  workOrderId: string,
  run: StartedCodexRun,
  activeRuns: Map<string, StartedCodexRun>,
  options: {
    executionIdentityId?: string;
    fallback?: () => Promise<StartedCodexRun | null>;
    resultProcessor?: WorkOrderResultProcessor;
    clearRunTimeout?: () => void;
    finishReason?: () => string | undefined;
    checkpointManager?: CheckpointManager;
    startNextStage?: () => Promise<NextStageRun | null>;
    retryTransient?: () => Promise<StartedCodexRun | null>;
    transientRetryUsed?: boolean;
    afterRunSettled?: () => void;
  } = {},
): Promise<void> {
  let settled = false;
  let needsResponseMessage: string | null = null;
  try {
    for await (const event of run.events) {
      if (event.type === "session") {
        store.recordSession(workOrderId, event.sessionId, options.executionIdentityId);
      } else if (event.type === "progress") {
        if (event.report?.kind === "needs_response") {
          needsResponseMessage = event.message || "Codex 需要补充信息";
        }
        const visibleMessage = event.message.replace(stageProgressPattern, "").trim();
        if (visibleMessage) {
          const activeStageId = store.get(workOrderId)?.plan?.stages.find(
            (stage) => stage.status === "running" && stage.executionMethod === "codex",
          )?.id;
          store.recordProgress(workOrderId, visibleMessage, {
            category: event.category,
            stageId: event.report?.stageId ?? activeStageId ?? null,
            detail: event.detail ?? (event.report
              ? JSON.stringify({ reportKind: event.report.kind })
              : undefined),
          });
        }
      } else {
        if (store.get(workOrderId)?.runStatus === "stopping") {
          options.clearRunTimeout?.();
          store.recordInterrupted(workOrderId, options.finishReason?.());
          settled = true;
        } else if (
          needsResponseMessage ||
          ["needs_response", "authentication_required", "permission_required"].includes(
            event.endState ?? "",
          )
        ) {
          options.clearRunTimeout?.();
          store.recordInterrupted(
            workOrderId,
            needsResponseMessage ?? event.message ?? "Codex 需要你响应",
          );
          settled = true;
        } else if (event.endState === "transient_failure" && options.retryTransient) {
          if (options.transientRetryUsed) {
            options.clearRunTimeout?.();
            store.recordExit(
              workOrderId,
              event.exitCode || -1,
              "自动恢复一次后仍然失败，需要你响应",
            );
            settled = true;
          } else {
            let retryRun: StartedCodexRun | null = null;
            try {
              retryRun = await options.retryTransient();
            } catch {
              // The retry result below is handled as a failed recovery.
            }
            if (!retryRun) {
              options.clearRunTimeout?.();
              store.recordExit(
                workOrderId,
                event.exitCode || -1,
                "短暂故障自动恢复失败，需要你响应",
              );
              settled = true;
            } else {
              activeRuns.set(workOrderId, retryRun);
              store.recordRunPid(workOrderId, retryRun.pid ?? null);
              void consumeRunEvents(store, workOrderId, retryRun, activeRuns, {
                ...options,
                transientRetryUsed: true,
              });
              return;
            }
          }
        } else if (event.resumeUnavailable && options.fallback) {
          let fallbackRun: StartedCodexRun | null;
          try {
            fallbackRun = await options.fallback();
          } catch {
            if (store.get(workOrderId)?.runStatus === "stopping") {
              options.clearRunTimeout?.();
              store.recordInterrupted(workOrderId, options.finishReason?.());
            } else {
              options.clearRunTimeout?.();
              store.recordExit(
                workOrderId,
                -1,
                "Codex 无法从当前现场启动，请检查本机 Codex 后重试",
              );
            }
            settled = true;
            return;
          }
          if (!fallbackRun) {
            if (store.get(workOrderId)?.runStatus === "stopping") {
              options.clearRunTimeout?.();
              store.recordInterrupted(workOrderId, options.finishReason?.());
              settled = true;
            }
            return;
          }
          activeRuns.set(workOrderId, fallbackRun);
          store.recordRunPid(workOrderId, fallbackRun.pid ?? null);
          if (store.get(workOrderId)?.runStatus === "stopping") {
            try {
              fallbackRun.interrupt();
            } catch {
              // Keep waiting for the fallback process exit; stopping is not interrupted yet.
            }
          }
          void consumeRunEvents(store, workOrderId, fallbackRun, activeRuns, {
            executionIdentityId: options.executionIdentityId,
            resultProcessor: options.resultProcessor,
            checkpointManager: options.checkpointManager,
            clearRunTimeout: options.clearRunTimeout,
            finishReason: options.finishReason,
            afterRunSettled: options.afterRunSettled,
            startNextStage: options.startNextStage,
            retryTransient: options.retryTransient,
            transientRetryUsed: options.transientRetryUsed,
          });
          return;
        } else if (event.exitCode === 0 && options.resultProcessor) {
          options.clearRunTimeout?.();
          const verifying = store.beginResultProcessing(workOrderId, event.message);
          try {
            const scopedWorkOrder = codexRunWorkOrder(verifying);
            const result = currentStageResult(
              scopedWorkOrder,
              await options.resultProcessor.process(scopedWorkOrder),
            );
            await saveVerifiedBoundaryCheckpoint(
              store,
              workOrderId,
              result,
              options.checkpointManager,
            );
            if (result.verifications.some((verification) => verification.status === "failed")) {
              store.recordVerificationFailure(workOrderId, result);
            } else {
              const reviewed = store.completeReview(workOrderId, result);
              if (reviewed.status === "ready" && options.startNextStage) {
                const next = await options.startNextStage();
                if (next) {
                  activeRuns.set(workOrderId, next.run);
                  void consumeRunEvents(store, workOrderId, next.run, activeRuns, {
                    ...options,
                    executionIdentityId: next.executionIdentityId,
                    fallback: next.fallback,
                    retryTransient: next.retryTransient,
                    transientRetryUsed: false,
                  });
                  return;
                }
              }
            }
          } catch {
            store.recordResultProcessingFailure(workOrderId);
          }
          settled = true;
        } else {
          options.clearRunTimeout?.();
          store.recordExit(workOrderId, event.exitCode, event.message);
          settled = true;
        }
      }
    }
  } catch {
    if (run.exited) {
      await run.exited;
    }
    if (store.get(workOrderId)?.runStatus === "stopping") {
      options.clearRunTimeout?.();
      store.recordInterrupted(workOrderId, options.finishReason?.());
    } else {
      options.clearRunTimeout?.();
      store.recordExit(
        workOrderId,
        -1,
        "Codex 运行异常结束，请检查本机 Codex 后重试",
      );
    }
    settled = true;
  } finally {
    if (activeRuns.get(workOrderId) === run) {
      activeRuns.delete(workOrderId);
    }
    if (settled) options.afterRunSettled?.();
  }
}

function currentStageResult(
  workOrder: WorkOrder,
  result: WorkOrderResult,
): WorkOrderResult {
  const stage = workOrder.plan?.stages[0];
  if (!stage) return { ...result, verifications: [] };
  const verification = result.verifications.find((candidate) => candidate.stageId === stage.id);
  return {
    ...result,
    verifications: verification
      ? [verification]
      : [{
          stageId: stage.id,
          stageOutcome: stage.outcome,
          command: null,
          status: "not_configured",
          exitCode: null,
          output: "未配置自动验证命令",
        }],
  };
}

async function saveVerifiedBoundaryCheckpoint(
  store: WorkOrderStore,
  workOrderId: string,
  result: Awaited<ReturnType<WorkOrderResultProcessor["process"]>>,
  checkpointManager?: CheckpointManager,
): Promise<void> {
  const workOrder = store.get(workOrderId);
  if (
    !checkpointManager ||
    !workOrder?.plan ||
    workOrder.workspace?.kind !== "git" ||
    !workOrder.worktreePath
  ) {
    return;
  }
  const verificationsByStage = new Map(
    result.verifications.map((verification) => [verification.stageId, verification]),
  );
  const completeBoundary =
    result.verifications.length > 0 &&
    result.verifications.every((verification) => verification.status === "passed");
  if (!completeBoundary) return;

  const finalStage = workOrder.plan.stages
    .filter((stage) => verificationsByStage.has(stage.id))
    .at(-1);
  if (!finalStage) return;
  const checkpointId = crypto.randomUUID();
  const treeHash = await checkpointManager.capture(
    workOrder.worktreePath,
    checkpointReference("checkpoints", workOrderId, checkpointId),
  );
  store.saveCheckpoint(workOrderId, {
    id: checkpointId,
    kind: "stage",
    planVersion: result.planVersion,
    stageId: finalStage.id,
    stageOutcome: finalStage.outcome,
    runNumber: workOrder.runNumber,
    treeHash,
  });
}

async function saveManuallyConfirmedStageCheckpoint(
  store: WorkOrderStore,
  workOrderId: string,
  checkpointManager?: CheckpointManager,
): Promise<void> {
  const workOrder = store.get(workOrderId);
  if (
    !checkpointManager ||
    !workOrder?.plan ||
    !workOrder.result ||
    workOrder.workspace?.kind !== "git" ||
    !workOrder.worktreePath
  ) {
    return;
  }
  const verificationByStage = new Map(
    workOrder.result.verifications.map((verification) => [verification.stageId, verification]),
  );
  const stage = workOrder.plan.stages.find(
    (candidate) =>
      candidate.executionMethod === "codex" &&
      candidate.status === "response" &&
      verificationByStage.get(candidate.id)?.status === "not_configured",
  );
  if (!stage) return;
  const checkpointId = crypto.randomUUID();
  const treeHash = await checkpointManager.capture(
    workOrder.worktreePath,
    checkpointReference("checkpoints", workOrderId, checkpointId),
  );
  store.saveCheckpoint(workOrderId, {
    id: checkpointId,
    kind: "stage",
    planVersion: workOrder.plan.version,
    stageId: stage.id,
    stageOutcome: stage.outcome,
    runNumber: workOrder.runNumber,
    treeHash,
  });
}

async function continuationContext(
  store: WorkOrderStore,
  workOrderId: string,
  workspacePath: string,
): Promise<ContinuationContext> {
  const recentProgress = store
    .listRunEvents(workOrderId, 20)
    .filter((event) => event.type === "progress" && event.category === "message")
    .slice(-5)
    .map((event) => event.message);
  if (store.get(workOrderId)?.workspace?.kind === "directory") {
    return {
      recentProgress,
      gitStatus: "普通文件夹现场保留在当前执行目录",
    };
  }
  const subprocess = Bun.spawn(["git", "-C", workspacePath, "status", "--short"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
  ]);
  return {
    recentProgress,
    gitStatus: exitCode === 0 ? stdout.trimEnd() : "无法读取当前 Git 状态",
  };
}

function isGitRepository(repositoryPath: string): boolean {
  if (!repositoryPath || !existsSync(repositoryPath)) {
    return false;
  }

  return existsSync(join(repositoryPath, ".git"));
}

type WorkspaceValidationError =
  | "missing"
  | "not_directory"
  | "permission_denied"
  | "in_use";

type WorkspaceValidation =
  | { path: string }
  | { error: WorkspaceValidationError };

function validateWorkspacePath(path: string): WorkspaceValidation {
  if (!path) return { error: "missing" };
  try {
    if (!statSync(path).isDirectory()) return { error: "not_directory" };
    accessSync(path, constants.R_OK | constants.W_OK | constants.X_OK);
    return { path: realpathSync(path) };
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      if (error.code === "ENOENT") return { error: "missing" };
      if (error.code === "EACCES" || error.code === "EPERM") {
        return { error: "permission_denied" };
      }
      if (error.code === "ENOTDIR") return { error: "not_directory" };
    }
    return { error: "not_directory" };
  }
}

function workspaceErrorResponse(error: WorkspaceValidationError): Response {
  const details = {
    missing: {
      code: "WORKSPACE_NOT_FOUND",
      error: "这个文件夹不存在，请重新选择一个本地文件夹",
    },
    not_directory: {
      code: "WORKSPACE_NOT_DIRECTORY",
      error: "所选路径不是文件夹，请重新选择",
    },
    permission_denied: {
      code: "WORKSPACE_PERMISSION_DENIED",
      error: "Teamline 无法读写或进入这个文件夹，请调整权限或选择其他文件夹",
    },
    in_use: {
      code: "WORKSPACE_IN_USE",
      error: "这个文件夹正在被另一个目标使用，请等待其结束或选择其他文件夹",
    },
  }[error];
  return Response.json(details, { status: error === "in_use" ? 409 : 400 });
}

function executionIdentityErrorResponse(
  code: string,
  error: string,
  status: number,
): Response {
  return Response.json({ code, error }, { status });
}

function localStateErrorResponse(error: unknown): Response {
  if (error instanceof RestoreChoiceRequiredError) {
    return Response.json(
      {
        code: "RESTORE_CHOICE_REQUIRED",
        error: error.message,
        conflicts: error.conflicts,
        settingsConflict: error.settingsConflict,
      },
      { status: 409 },
    );
  }
  if (error instanceof RestorePreviewStaleError) {
    return Response.json(
      { code: "RESTORE_PREVIEW_STALE", error: error.message },
      { status: 409 },
    );
  }
  if (error instanceof RestorePreviewMissingError) {
    return Response.json(
      { code: "RESTORE_PREVIEW_MISSING", error: error.message },
      { status: 404 },
    );
  }
  const message =
    error instanceof InvalidStateBundleError
      ? error.message
      : error instanceof SyntaxError
        ? "导出文件不是有效的 JSON"
        : "无法读取这个导出文件";
  return Response.json(
    { code: "INVALID_STATE_BUNDLE", error: message },
    { status: 400 },
  );
}

function directoryWorkspaceInUse(
  store: WorkOrderStore,
  workOrderId: string,
  path: string,
): boolean {
  return store.list().some(
    (workOrder) =>
      workOrder.id !== workOrderId &&
      workOrder.workspace?.kind === "directory" &&
      canonicalWorkspacePath(workOrder.worktreePath ?? workOrder.workspace.path) === path &&
      ["running", "stopping", "verifying"].includes(workOrder.runStatus ?? ""),
  );
}

function resolveExecutionWorkspace(
  store: WorkOrderStore,
  workOrderId: string,
  kind: "git" | "directory",
  path: string,
): WorkspaceValidation {
  const resolved = validateWorkspacePath(path);
  if ("error" in resolved) return resolved;
  if (kind === "directory" && directoryWorkspaceInUse(store, workOrderId, resolved.path)) {
    return { error: "in_use" };
  }
  return resolved;
}

function normalizeMaterials(
  materials: Array<{ kind?: string; value?: string }> | undefined,
): Array<{ kind: WorkOrderMaterialKind; value: string }> {
  if (!materials) return [];
  if (!Array.isArray(materials)) throw new Error("素材格式无法识别");
  return materials.map((material) => {
    const kind = material?.kind;
    const value = material?.value?.trim() ?? "";
    if (!workOrderMaterialKinds.includes(kind as WorkOrderMaterialKind) || !value) {
      throw new Error("请检查添加的素材");
    }
    return { kind: kind as WorkOrderMaterialKind, value };
  });
}

function normalizeProjectMaterialIds(value: string[] | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error("项目素材格式无法识别");
  }
  return [...new Set(value.map((id) => {
    if (typeof id !== "string" || !id.trim()) {
      throw new Error("项目素材格式无法识别");
    }
    return id.trim();
  }))];
}

function safeUploadName(value: string): string {
  const normalized = value
    .normalize("NFC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/^\.+/, "")
    .trim();
  return normalized.slice(0, 120) || "附件";
}

function normalizeSessionIds(sessionIds: string[] | undefined): string[] {
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    throw new Error("请选择至少一个会话");
  }
  if (sessionIds.length > 20) throw new Error("一次最多选择 20 个会话");
  const normalized = sessionIds.map((id) => typeof id === "string" ? id.trim() : "");
  if (normalized.some((id) => !id)) {
    throw new Error("选中的会话无效");
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("请勿重复选择同一个会话");
  }
  return normalized;
}

function normalizeMonitoringSessionKeys(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("请选择至少一个来源会话");
  return normalizeSessionIds(value as string[]);
}

function createSessionMonitoringSourceContext(
  records: SessionMonitoringRecord[],
  createdAt: string,
): WorkOrderSourceContext {
  return {
    kind: "session_monitoring",
    version: 1,
    createdAt,
    projectId: records[0]?.projectId ?? null,
    sessions: records.map((record) => ({
      key: record.key,
      source: {
        kind: record.sourceKind,
        id: record.id,
        lastActiveAt: record.lastActiveAt,
        lastReadAt: record.lastReadAt,
        ...(record.executionIdentityId
          ? { executionIdentityId: record.executionIdentityId }
          : {}),
        version: 1 as const,
      },
      title: record.title,
      projectLabel: record.projectLabel,
      lastActiveAt: record.lastActiveAt,
      monitoringEnabled: record.monitoringEnabled,
      organizationStatus: record.organizationStatus,
      lastReadPosition: record.lastReadPosition,
      lastReadAt: record.lastReadAt,
      workGraphSnapshot: record.workGraphSnapshot,
    })),
  };
}

function createSessionMonitoringImportContext(
  sourceContext: WorkOrderSourceContext,
): WorkOrderImportContext {
  const snapshots = sourceContext.sessions.map((session) =>
    monitoringSnapshotRecord(session.workGraphSnapshot),
  );
  const historicalStages = monitoringHistoricalStages(sourceContext);
  const summaries = uniqueMonitoringText(snapshots.map((snapshot) => snapshot.summary));
  const currentStates = uniqueMonitoringText(snapshots.map((snapshot) => snapshot.currentState));
  const nextActions = uniqueMonitoringText(snapshots.map((snapshot) => snapshot.nextAction));
  const summary = summaries.join("；") || "已保存创建时工作图快照";
  const currentState = currentStates.join("；") || "已保存创建时工作图快照";
  return {
    status: "ready",
    summary,
    currentState,
    completedHighlights: historicalStages
      .filter((stage) => stage.status === "completed")
      .map((stage) => stage.outcome)
      .slice(0, 3),
    nextAction: nextActions.join("；") || currentState,
    historicalStages,
    artifacts: [],
    organizedAt: sourceContext.createdAt,
    error: null,
  };
}

function monitoringGoalDescription(sourceContext: WorkOrderSourceContext): string {
  const snapshots = sourceContext.sessions.map((session) =>
    monitoringSnapshotRecord(session.workGraphSnapshot),
  );
  const currentState = uniqueMonitoringText(snapshots.map((snapshot) => snapshot.currentState));
  const nextAction = uniqueMonitoringText(snapshots.map((snapshot) => snapshot.nextAction));
  const sourceNames = sourceContext.sessions.map((session) => session.title).join("、");
  const details = [
    `从${sourceNames}的当前监控进展继续推进`,
    currentState.length ? `当前状态：${currentState.join("；")}` : "",
    nextAction.length ? `来源提出的下一步：${nextAction.join("；")}` : "",
  ].filter(Boolean);
  return details.join("。") + "。";
}

function commonMonitoringWorkspace(records: SessionMonitoringRecord[]): string | null {
  if (records.length === 0 || records.some((record) => !record.workspacePath)) return null;
  const paths = new Set(records.map((record) => record.workspacePath));
  return paths.size === 1 ? records[0]!.workspacePath : null;
}

function monitoringSnapshotRecord(value: unknown): {
  summary: string;
  currentState: string;
  nextAction: string;
  historicalStages: unknown[];
  nodes: unknown[];
} {
  const root = monitoringSnapshotObject(value);
  const graph = monitoringSnapshotObject(root?.graph) ?? root;
  return {
    summary: monitoringSnapshotText(graph?.summary),
    currentState: monitoringSnapshotText(graph?.currentState),
    nextAction: monitoringSnapshotText(graph?.nextAction),
    historicalStages: Array.isArray(graph?.historicalStages) ? graph.historicalStages : [],
    nodes: Array.isArray(graph?.nodes) ? graph.nodes : [],
  };
}

function monitoringHistoricalStages(
  sourceContext: WorkOrderSourceContext,
): WorkOrderImportContext["historicalStages"] {
  const stages: WorkOrderImportContext["historicalStages"] = [];
  const seenIds = new Set<string>();
  for (const session of sourceContext.sessions) {
    const snapshot = monitoringSnapshotRecord(session.workGraphSnapshot);
    const rawStages = snapshot.historicalStages.length ? snapshot.historicalStages : snapshot.nodes;
    for (const raw of rawStages) {
      const item = monitoringSnapshotObject(raw);
      const outcome = monitoringSnapshotText(item?.outcome ?? item?.title ?? item?.label);
      if (!outcome) continue;
      const rawStatus = monitoringSnapshotText(item?.status ?? item?.kind).toLowerCase();
      if (["future", "proposed", "queued", "next"].includes(rawStatus)) continue;
      const baseId = monitoringSnapshotText(item?.id) || `monitoring-stage-${stages.length + 1}`;
      let id = baseId;
      let suffix = 2;
      while (seenIds.has(id)) id = `${baseId}-${suffix++}`;
      seenIds.add(id);
      stages.push({
        id,
        outcome,
        summary:
          monitoringSnapshotText(item?.summary ?? item?.description) || "来源工作图中的关键进展",
        status: ["current", "in_progress", "running", "active"].includes(rawStatus)
          ? "in_progress"
          : rawStatus === "completed" || rawStatus === "historical"
            ? "completed"
            : "unknown",
        sourceSessionIds: [session.source.id],
      });
      if (stages.length >= 8) return stages;
    }
  }
  return stages;
}

function monitoringSnapshotObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function monitoringSnapshotText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function uniqueMonitoringText(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function sharedSessionWorkspace(sessions: DiscoveredSession[]): string | null {
  if (sessions.length === 0 || sessions.some((session) => !session.workspacePath)) return null;
  const paths = new Set(sessions.map((session) => session.workspacePath));
  return paths.size === 1 ? sessions[0]!.workspacePath : null;
}

async function inspectSourceSessions(
  workOrder: WorkOrder,
  provider?: SessionProvider,
): Promise<{
  status: "available" | "partial" | "unavailable";
  message: string;
  checkedAt: string;
  hasUpdates: boolean;
  sessions: Array<{
    id: string;
    availability: DiscoveredSession["availability"] | "unavailable";
    latestActiveAt: string | null;
    updateAvailable: boolean;
  }>;
} | null> {
  if (workOrder.sourceSessions.length === 0) return null;
  const checkedAt = new Date().toISOString();
  if (!provider) {
    return unavailableSourceStatus(workOrder, checkedAt, "会话发现服务尚未配置");
  }
  try {
    const discovery = await provider.discover();
    const candidates = new Map(discovery.sessions.map((session) => [session.id, session]));
    const sessions = workOrder.sourceSessions.map((source) => {
      const candidate = candidates.get(source.id);
      const updateAvailable = Boolean(
        candidate && Date.parse(candidate.lastActiveAt) > Date.parse(source.lastActiveAt),
      );
      return {
        id: source.id,
        availability: candidate?.availability ?? "unavailable" as const,
        latestActiveAt: candidate?.lastActiveAt ?? null,
        updateAvailable,
      };
    });
    return {
      status: discovery.status,
      message: discovery.message,
      checkedAt,
      hasUpdates: sessions.some((session) => session.updateAvailable),
      sessions,
    };
  } catch {
    return unavailableSourceStatus(workOrder, checkedAt, "暂时无法检查来源会话");
  }
}

function unavailableSourceStatus(
  workOrder: WorkOrder,
  checkedAt: string,
  message: string,
) {
  return {
    status: "unavailable" as const,
    message,
    checkedAt,
    hasUpdates: false,
    sessions: workOrder.sourceSessions.map((source) => ({
      id: source.id,
      availability: "unavailable" as const,
      latestActiveAt: null,
      updateAvailable: false,
    })),
  };
}

function matchesSessionSearch(session: DiscoveredSession, query: string): boolean {
  if (!query) return true;
  return [session.title, session.projectLabel, session.workspacePath, session.id]
    .filter(Boolean)
    .some((value) => value!.toLocaleLowerCase().includes(query));
}

function presentSession(
  session: DiscoveredSession,
  workOrders: WorkOrder[],
  sourceKind: WorkOrder["sourceSessions"][number]["kind"],
) {
  const imported = findImportedSession(workOrders, sourceKind, session.id);
  const suggested = session.workspacePath
    ? workOrders.find(
        (workOrder) =>
          workOrder.workspace?.path === session.workspacePath ||
          workOrder.materials.some(
            (material) => material.kind === "folder" && material.value === session.workspacePath,
          ),
      )
    : null;
  return {
    id: session.id,
    title: session.title,
    workspacePath: session.workspacePath,
    projectLabel: session.projectLabel,
    lastActiveAt: session.lastActiveAt,
    availability: session.availability,
    message: session.message,
    importedWorkOrderId: imported?.id ?? null,
    suggestion:
      suggested && suggested.id !== imported?.id
        ? { workOrderId: suggested.id, title: suggested.title }
        : null,
  };
}

async function discoverSessionProvider(
  provider: SessionProvider,
  sourceLabel: string,
  timeoutMs?: number,
  parentSignal?: AbortSignal,
): Promise<{
  status: "available" | "partial" | "unavailable";
  message: string;
  sessions: DiscoveredSession[];
}> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  else parentSignal?.addEventListener("abort", abort, { once: true });
  try {
    return timeoutMs === undefined
      ? await provider.discover(parentSignal)
      : await withSessionMonitoringTimeout(
          (signal) => provider.discover(signal),
          timeoutMs,
          `${sourceLabel} 会话发现超时，请重试`,
          controller,
        );
  } catch {
    return {
      status: "unavailable",
      message: `暂时无法读取 ${sourceLabel} 本机会话`,
      sessions: [],
    };
  } finally {
    parentSignal?.removeEventListener("abort", abort);
  }
}

type PresentedSessionMonitoring = Omit<SessionMonitoringRecord, "sourcePath"> & {
  sourceAvailable: boolean;
};

type PresentedSessionMonitoringWork = SessionMonitoringWork & {
  sources: Array<{
    key: string;
    id: string;
    title: string;
    sourceKind: SessionMonitoringRecord["sourceKind"];
  }>;
};

function presentSessionMonitoring(
  session: SessionMonitoringRecord,
): PresentedSessionMonitoring {
  const { sourcePath, ...publicSession } = session;
  return {
    ...publicSession,
    sourceAvailable: Boolean(sourcePath && existsSync(sourcePath)),
  };
}

function presentSessionMonitoringWorks(
  works: SessionMonitoringWork[],
  records: SessionMonitoringRecord[],
): PresentedSessionMonitoringWork[] {
  const byKey = new Map(records.map((record) => [record.key, record]));
  return works.map((work) => ({
    ...work,
    sources: work.sourceSessionKeys.flatMap((key) => {
      const source = byKey.get(key);
      return source
        ? [{ key, id: source.id, title: source.title, sourceKind: source.sourceKind }]
        : [];
    }),
  }));
}

function monitoringToolKey(
  session: Pick<SessionMonitoringRecord, "sourceKind" | "executionIdentityId">,
): string {
  return `${session.sourceKind}:${session.executionIdentityId ?? "none"}`;
}

function monitoringCandidateKey(
  session: Pick<SessionMonitoringRecord, "workspacePath" | "sourceKind" | "executionIdentityId" | "id">,
): string {
  return session.workspacePath
    ? `workspace:${session.workspacePath}`
    : `session:${monitoringToolKey(session)}:${session.id}`;
}

function previewSessionMonitoringRecord(
  key: string,
  source: Pick<SessionMonitoringSourceResult, "sourceKind" | "executionIdentityId" | "executionIdentityLabel">,
  session: DiscoveredSession,
  discoveredAt: string,
): SessionMonitoringRecord {
  return {
    key,
    sourceKind: source.sourceKind,
    executionIdentityId: source.executionIdentityId,
    executionIdentityLabel: source.executionIdentityLabel,
    id: session.id,
    title: session.title,
    workspacePath: session.workspacePath,
    projectLabel: session.projectLabel,
    lastActiveAt: session.lastActiveAt,
    sourcePath: session.sourcePath,
    sourcePosition: session.sourcePosition ?? null,
    sourceModifiedAt: session.sourceModifiedAt ?? null,
    availability: session.availability,
    message: session.message,
    projectId: null,
    monitoringEnabled: false,
    monitoringOverride: null,
    lastDiscoveredAt: discoveredAt,
    lastReadPosition: null,
    lastReadAt: null,
    organizationStatus: "not_started",
    workGraphSnapshot: null,
    createdAt: discoveredAt,
    updatedAt: discoveredAt,
  };
}

function presentSessionMonitoringOnboardingCandidates(
  records: SessionMonitoringRecord[],
  tools: Array<{ key: string; label: string; sessionKeys: string[] }>,
): Array<{
  key: string;
  name: string;
  workspacePath: string | null;
  sessionKeys: string[];
  tools: Array<{ key: string; label: string; sessionKeys: string[] }>;
}> {
  const groups = new Map<string, SessionMonitoringRecord[]>();
  for (const record of records) {
    const key = monitoringCandidateKey(record);
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, group]) => {
    const workspacePath = group[0]?.workspacePath ?? null;
    const name = workspacePath?.split(/[\\/]/).filter(Boolean).at(-1) ||
      group[0]?.projectLabel || "未归类工作";
    const sessionKeys = group.map((record) => record.key);
    return {
      key,
      name,
      workspacePath,
      sessionKeys,
      tools: tools
        .map((tool) => ({
          ...tool,
          sessionKeys: tool.sessionKeys.filter((sessionKey) => sessionKeys.includes(sessionKey)),
        }))
        .filter((tool) => tool.sessionKeys.length > 0),
    };
  });
}

function presentSessionMonitoringOnboardingTools(
  records: SessionMonitoringRecord[],
  sourceLabels: Map<string, string>,
): Array<{ key: string; label: string; sessionKeys: string[] }> {
  const groups = new Map<string, string[]>();
  for (const record of records) {
    const key = monitoringToolKey(record);
    const sessionKeys = groups.get(key) ?? [];
    sessionKeys.push(record.key);
    groups.set(key, sessionKeys);
  }
  return [...groups.entries()].map(([key, sessionKeys]) => ({
    key,
    label: sourceLabels.get(key) ??
      (key.startsWith("claude_code_session:") ? "Claude Code" : "Codex"),
    sessionKeys,
  }));
}

function sessionMonitoringSourceChanged(
  record: SessionMonitoringRecord,
  candidate: DiscoveredSession,
): boolean {
  const candidatePosition = candidate.sourcePosition ?? null;
  const candidateModifiedAt = candidate.sourceModifiedAt ?? null;
  const hasSourceMetadata =
    record.sourcePosition !== null ||
    candidatePosition !== null ||
    record.sourceModifiedAt !== null ||
    candidateModifiedAt !== null;
  return (
    (record.lastReadPosition === null && record.organizationStatus === "not_started") ||
    record.sourcePath !== candidate.sourcePath ||
    record.sourcePosition !== candidatePosition ||
    record.sourceModifiedAt !== candidateModifiedAt ||
    record.availability !== candidate.availability ||
    (!hasSourceMetadata && record.lastActiveAt !== candidate.lastActiveAt)
  );
}

function sessionMonitoringSourceNeedsFullRead(
  record: SessionMonitoringRecord,
  candidate: DiscoveredSession,
): boolean {
  const candidatePosition = candidate.sourcePosition ?? null;
  return (
    record.sourcePath === null ||
    record.sourcePath !== candidate.sourcePath ||
    record.availability === "unavailable" ||
    (record.sourcePosition !== null &&
      record.sourcePosition === candidatePosition &&
      record.sourceModifiedAt !== (candidate.sourceModifiedAt ?? null))
  );
}

function sessionMonitoringCandidateFromRecord(
  record: SessionMonitoringRecord,
): DiscoveredSession | null {
  if (!record.sourcePath) return null;
  try {
    const details = statSync(record.sourcePath);
    if (!details.isFile()) return null;
    return {
      id: record.id,
      title: record.title,
      workspacePath: record.workspacePath,
      projectLabel: record.projectLabel,
      lastActiveAt: record.lastActiveAt,
      sourcePath: record.sourcePath,
      sourcePosition: details.size,
      sourceModifiedAt: details.mtime.toISOString(),
      availability: record.availability === "unavailable" ? "available" : record.availability,
      message: record.availability === "unavailable" ? null : record.message,
    };
  } catch {
    return null;
  }
}

function isTeamlineExecutionSession(
  workOrders: WorkOrder[],
  executionIdentityId: string | null,
  sessionId: string,
): boolean {
  return workOrders.some((workOrder) => {
    if (workOrder.sessionId !== sessionId) return false;
    const identityId = workOrder.sessionIdentityId ?? workOrder.executionIdentityId;
    return Boolean(identityId && identityId === executionIdentityId);
  });
}

function findImportedSession(
  workOrders: WorkOrder[],
  sourceKind: WorkOrder["sourceSessions"][number]["kind"],
  sourceId: string,
): WorkOrder | null {
  return (
    workOrders.find(
      (workOrder) =>
        workOrder.sourceSessions.some(
          (source) => source.kind === sourceKind && source.id === sourceId,
        ),
    ) ?? null
  );
}

function parseSessionSourceKind(value: unknown): WorkOrderImportSource["kind"] {
  if (value === "codex" || value === "codex_session" || value === undefined) {
    return "codex_session";
  }
  if (value === "claude_code" || value === "claude_code_session") {
    return "claude_code_session";
  }
  throw new Error("不支持这个会话来源");
}

function sessionSourceKindFromRequest(url: URL): WorkOrderImportSource["kind"] {
  if (url.pathname === "/api/codex-sessions") return "codex_session";
  return parseSessionSourceKind(url.searchParams.get("source") ?? undefined);
}

function sourceKindLabel(kind: WorkOrderImportSource["kind"]): string {
  return kind === "claude_code_session" ? "Claude Code" : "Codex";
}

function isImportOnlyWorkOrder(workOrder: WorkOrder): boolean {
  return !workOrder.sourceContext && workOrder.sourceSessions[0]?.kind === "claude_code_session";
}

function executionIdentityForRun(
  store: WorkOrderStore,
  workOrder: WorkOrder,
  willResume = false,
): ExecutionIdentity {
  const bound = store.bindExecutionIdentity(workOrder.id);
  const identityId = bound.executionIdentityId;
  if (!identityId) throw new Error("请先选择可用的 Codex 账号");
  if (willResume && bound.sessionId && bound.sessionIdentityId !== identityId) {
    throw new Error("保存的 Codex 会话属于另一个账号，不能直接恢复");
  }
  const identity = store.getExecutionIdentity(identityId);
  if (!identity) throw new Error("找不到目标绑定的 Codex 账号");
  return identity;
}

function identityQuotaErrorSignal(now: Date): CodexResourceSignal {
  return {
    status: "error",
    source: "codex-app-server",
    observedAt: now.toISOString(),
    message: "Codex 额度读取失败，上次可用数据未被修改",
    shortWindow: null,
    longWindow: null,
  };
}

function failedIdentityQuotaSignal(
  previous: CodexResourceSignal,
  now: Date,
): CodexResourceSignal {
  return {
    status: "stale",
    source: "codex-app-server",
    observedAt: previous.observedAt,
    message: "本次额度读取失败，上次数据已保留，等待重新读取",
    shortWindow: null,
    longWindow: null,
  };
}

function importOnlyResponse(): Response {
  return Response.json(
    {
      code: "IMPORT_ONLY_GOAL",
      error: "Claude Code 来源目标目前只支持导入与状态整理",
    },
    { status: 409 },
  );
}

function planIsEditable(workOrder: { status: string; runStatus: string | null }): boolean {
  return workOrder.runStatus === null && ["draft", "ready"].includes(workOrder.status);
}

function nextRunnableStages(workOrder: WorkOrder): PlanStage[] {
  if (!workOrder.plan) return [];
  const completed = new Set(
    workOrder.plan.stages
      .filter((stage) => stage.status === "completed")
      .map((stage) => stage.id),
  );
  const next = workOrder.plan.stages.find(
    (stage) =>
      (stage.executionMethod === "external"
        ? stage.status === "response"
        : stage.status === "planning" || stage.status === "running") &&
      stage.dependsOn.every((dependencyId) => completed.has(dependencyId)),
  );
  return next ? [next] : [];
}

function codexRunWorkOrder(workOrder: WorkOrder): WorkOrder {
  if (!workOrder.plan) return workOrder;
  const running = workOrder.plan.stages.find(
    (stage) =>
      stage.executionMethod === "codex" &&
      (stage.status === "running" ||
        stage.status === "response" ||
        (stage.status === "completed" &&
          workOrder.runStatus === "verifying" &&
          (stage.pendingVerification === true ||
            (stage.pendingVerification === undefined &&
              semanticMessageFromLegacy(stage.statusReason).code ===
                "stage.awaiting_verification")))),
  );
  const next = running ?? nextRunnableStages(workOrder).find(
    (stage) => stage.executionMethod === "codex",
  );
  return {
    ...workOrder,
    plan: { ...workOrder.plan, stages: next ? [next] : [] },
  };
}

const stageProgressPattern = /`?TEAMLINE_STAGE_(START|COMPLETE):([^\s`]+)`?/g;

function safeCodexStartError(error: unknown): string {
  if (error instanceof CodexCommandNotFoundError) {
    return "找不到 Codex，请先安装并登录 Codex";
  }
  return "Codex 无法启动，请确认本机 Codex 安装和配置后重试";
}

function scheduleTimeout(callback: () => void, delayMs: number): () => void {
  const timeout = setTimeout(callback, delayMs);
  timeout.unref?.();
  return () => clearTimeout(timeout);
}

function scheduleBackgroundTask(callback: () => void): void {
  setTimeout(callback, 0);
}

async function discoverSessionsWithin(
  provider: SessionProvider,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Awaited<ReturnType<SessionProvider["discover"]>>> {
  if (signal.aborted) throw new Error("历史整理中断");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("历史整理中断"));
    signal.addEventListener("abort", abort, { once: true });
  });
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error("会话发现超时，请重试")),
      timeoutMs,
    );
    timeout.unref?.();
  });
  try {
    return await Promise.race([provider.discover(signal), interrupted, timedOut]);
  } finally {
    clearTimeout(timeout);
    if (abort) signal.removeEventListener("abort", abort);
  }
}

async function withSessionMonitoringTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
  controller = new AbortController(),
): Promise<T> {
  if (controller.signal.aborted) throw new Error("来源读取已停止");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("来源读取已停止"));
    controller.signal.addEventListener("abort", abort, { once: true });
  });
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    timeout.unref?.();
  });
  try {
    return await Promise.race([operation(controller.signal), interrupted, timedOut]);
  } finally {
    clearTimeout(timeout);
    if (abort) controller.signal.removeEventListener("abort", abort);
  }
}

function canonicalWorkspacePath(workspacePath: string): string {
  const absolutePath = resolve(workspacePath);
  return existsSync(absolutePath) ? realpathSync(absolutePath) : absolutePath;
}

function resolveCollectedArtifact(
  workOrder: WorkOrder,
  requestedPath: unknown,
): string | null {
  const rootPath = workOrder.workspace?.kind === "directory"
    ? workOrder.worktreePath || workOrder.workspace.path
    : workOrder.workspace?.kind === "git"
      ? workOrder.worktreePath
      : null;
  if (
    !rootPath ||
    typeof requestedPath !== "string" ||
    !requestedPath.trim()
  ) {
    return null;
  }
  const requested = resolve(requestedPath);
  const reference = workOrder.result?.artifacts?.find(
    (artifact) => artifact.type === "file" && resolve(artifact.location) === requested,
  );
  if (!reference) return null;
  try {
    const root = realpathSync(rootPath);
    const artifactPath = realpathSync(reference.location);
    const childPath = relative(root, artifactPath);
    if (!childPath || childPath === ".." || childPath.startsWith(`..${sep}`) || isAbsolute(childPath)) {
      return null;
    }
    if (!statSync(artifactPath).isFile()) return null;
    return artifactPath;
  } catch {
    return null;
  }
}

async function openLocalArtifactWithSystem(path: string, reveal: boolean): Promise<void> {
  const subprocess = Bun.spawn(reveal ? ["open", "-R", path] : ["open", path], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || "无法打开这个成果");
  }
}

function checkpointReference(
  kind: "checkpoints" | "residue",
  workOrderId: string,
  recordId: string,
): string {
  return `refs/teamline/${kind}/${workOrderId}/${recordId}`;
}

function recoveryStage(
  workOrder: WorkOrder,
  checkpoint: WorkOrderCheckpoint,
): PlanStage | null {
  if (!workOrder.plan) return null;
  const finalStage = workOrder.plan.stages.at(-1) ?? null;
  if (checkpoint.kind === "stage" && checkpoint.stageId === finalStage?.id) {
    return finalStage;
  }
  const completedStageIds = new Set(
    workOrder.checkpoints
      .filter(
        (candidate) =>
          candidate.kind === "stage" &&
          candidate.planVersion === workOrder.plan!.version &&
          candidate.sequence <= checkpoint.sequence &&
          candidate.stageId,
      )
      .map((candidate) => candidate.stageId!),
  );
  return (
    workOrder.plan.stages.find((stage) => !completedStageIds.has(stage.id)) ??
    finalStage ??
    null
  );
}

async function withRecoverySite(
  workOrder: WorkOrder,
  checkpointManager?: CheckpointManager,
): Promise<WorkOrder> {
  if (
    workOrder.status !== "interrupted" ||
    workOrder.workspace?.kind !== "git" ||
    !workOrder.worktreePath ||
    !checkpointManager
  ) {
    return workOrder;
  }
  const checkpoint = workOrder.checkpoints
    .filter((candidate) => candidate.planVersion === workOrder.plan?.version)
    .at(-1);
  if (!checkpoint) return workOrder;
  try {
    return {
      ...workOrder,
      recoverySite: await checkpointManager.describe(
        workOrder.worktreePath,
        checkpoint.treeHash,
      ),
    };
  } catch {
    return workOrder;
  }
}
