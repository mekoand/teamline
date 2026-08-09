export const workOrderStatuses = [
  "draft",
  "ready",
  "running",
  "interrupted",
  "review",
  "delivered",
] as const;

export type WorkOrderStatus = (typeof workOrderStatuses)[number];

export type RunStatus =
  | "running"
  | "stopping"
  | "verifying"
  | "interrupted"
  | "completed"
  | "failed";

export type WorkOrderRunEvent = {
  id: number;
  type: "session" | "progress" | "exit";
  category: "lifecycle" | "message" | "tool" | "log" | "report";
  message: string;
  stageId: string | null;
  detail: string | null;
  runNumber: number;
  createdAt: string;
};

export type WorkOrderCheckpoint = {
  id: string;
  kind: "baseline" | "stage";
  planVersion: number;
  stageId: string | null;
  stageOutcome: string | null;
  runNumber: number;
  sequence: number;
  treeHash: string;
  createdAt: string;
};

export type PlanNodeStatus =
  | "planning"
  | "running"
  | "queued"
  | "response"
  | "completed";

export type PlanReference = {
  id: string;
  type: "repository" | "folder" | "file" | "image" | "link";
  label: string;
  location: string;
};

export type PlanWorkspace = {
  kind: "git" | "directory" | "external";
  path: string | null;
};

export type PlanStage = {
  id: string;
  outcome: string;
  scope: string;
  verification: string;
  verificationCommand?: string;
  dependsOn: string[];
  executionMethod: "codex" | "external";
  workspace: PlanWorkspace;
  materials: PlanReference[];
  artifacts: PlanReference[];
  externalResult?: {
    conclusion: string | null;
    completedAt: string;
  };
  contextNotes?: string[];
  status: PlanNodeStatus;
  statusReason: string;
  /** Stable execution flag; statusReason remains presentation/compatibility text. */
  pendingVerification?: boolean;
};

export const workOrderMaterialKinds = [
  "text",
  "repository",
  "folder",
  "file",
  "image",
  "link",
] as const;

export type WorkOrderMaterialKind = (typeof workOrderMaterialKinds)[number];

export type WorkOrderMaterial = {
  id: string;
  kind: WorkOrderMaterialKind;
  value: string;
  projectMaterialId?: string;
};

export type WorkOrderImportSource = {
  kind: "codex_session" | "claude_code_session";
  id: string;
  lastActiveAt: string;
  lastReadAt?: string | null;
  executionIdentityId?: string | null;
  openInCodex?: boolean;
  version: 1;
};

export type SessionHandoff = {
  fromExecutionIdentityId: string;
  previousSessionId: string | null;
  summary: string;
  currentStageId: string | null;
  currentStageOutcome: string | null;
  createdAt: string;
};

export type ImportedHistoricalStage = {
  id: string;
  outcome: string;
  summary: string;
  status: "completed" | "in_progress" | "unknown";
  sourceSessionIds: string[];
};

export type WorkOrderMonitoringImportArtifact = PlanReference & {
  sourceSessionIds: string[];
  sourceSessionKeys: string[];
};

export type WorkOrderMonitoringImportContext = {
  workId: string;
  workName: string;
  sourceSessionKeys: string[];
  aggregateSnapshotRef: string | null;
  aggregateStatus: "not_started" | "pending" | "ready" | "failed";
  aggregateUpdatedAt: string | null;
  summary: string | null;
  currentState: string | null;
  nextAction: string | null;
  focusNodeId: string | null;
  focusNode: {
    id: string;
    outcome: string;
    summary: string;
    status: string;
    sourceSessionIds: string[];
    sourceSessionKeys: string[];
  } | null;
  artifacts: WorkOrderMonitoringImportArtifact[];
  toolCalls: string[];
  logs: string[];
};

export type WorkOrderImportContext = {
  status: "pending" | "ready" | "failed";
  summary: string | null;
  currentState: string | null;
  completedHighlights?: string[];
  nextAction?: string | null;
  historicalStages: ImportedHistoricalStage[];
  artifacts: PlanReference[];
  organizedAt: string | null;
  error: string | null;
  monitoringContext?: WorkOrderMonitoringImportContext;
};

export type WorkOrderSourceContextSession = {
  key: string;
  source: WorkOrderImportSource;
  title: string;
  projectLabel: string;
  lastActiveAt: string;
  monitoringEnabled: boolean;
  organizationStatus: "not_started" | "pending" | "ready" | "failed";
  lastReadPosition: number | null;
  lastReadAt: string | null;
  workGraphSnapshot: unknown | null;
};

export type WorkOrderSourceContextMonitoringWork = {
  id: string;
  name: string;
  projectId: string | null;
  sourceSessionKeys: string[];
  aggregateSnapshotRef: string | null;
  aggregateSnapshot: unknown | null;
  aggregateStatus: "not_started" | "pending" | "ready" | "failed";
  aggregateMessage: string | null;
  aggregateUpdatedAt: string | null;
  updatedAt: string;
  focusNodeId?: string | null;
};

export type WorkOrderSourceContext = {
  kind: "session_monitoring";
  version: 1;
  createdAt: string;
  projectId: string | null;
  monitoringWork?: WorkOrderSourceContextMonitoringWork;
  sessions: WorkOrderSourceContextSession[];
};

export type WorkOrderWorkspace = {
  kind: "git" | "directory";
  path: string;
};

export const workOrderPriorities = ["high", "normal", "background"] as const;
export type WorkOrderPriority = (typeof workOrderPriorities)[number];

export const workOrderPaces = ["fast", "balanced", "saving"] as const;
export type WorkOrderPace = (typeof workOrderPaces)[number];

export type WorkOrderResourcePlan = {
  priority: WorkOrderPriority;
  pace: WorkOrderPace;
  runWhenQuotaAvailable: boolean;
  autoRunReason: string | null;
  paidApiFallbackEnabled: boolean;
  paidApiLimitUsd: number | null;
  lastPaidApiRunAt: string | null;
  lastBillingMode: "subscription" | "paid_api" | null;
};

export type GitChangeSummary = {
  diffStat: string;
  statusShort: string;
};

export type VerificationResult = {
  stageId: string;
  stageOutcome: string;
  command: string | null;
  status: "passed" | "failed" | "not_configured";
  exitCode: number | null;
  output: string;
};

export type WorkOrderResult = {
  planVersion: number;
  artifacts?: PlanReference[];
  git: GitChangeSummary;
  verifications: VerificationResult[];
  completedAt: string;
};

export type WorkOrderPlan = {
  version: number;
  stages: PlanStage[];
  confirmationRequired?: boolean;
  updatedAt: string;
};

export type ClarificationTarget = "goal" | "acceptance" | "materials" | "resources" | "plan";

export type ClarificationQuestion = {
  id: string;
  prompt: string;
  reason: string;
  target: ClarificationTarget;
};

export type WorkOrderClarification = {
  questions: ClarificationQuestion[];
  requiresPlanConfirmation: boolean;
  createdAt: string;
};

export type WorkOrderConversationMessage = {
  id: number;
  role: "user" | "teamline";
  kind: "question" | "reply" | "decision" | "supplement";
  content: string;
  stageId: string | null;
  decisionTarget: ClarificationTarget | "stage" | null;
  requiresPlanConfirmation: boolean;
  createdAt: string;
};

export type PlanStageInput = Omit<
  PlanStage,
  | "id"
  | "dependsOn"
  | "executionMethod"
  | "workspace"
  | "materials"
  | "artifacts"
  | "status"
  | "statusReason"
> &
  Partial<
    Pick<
      PlanStage,
      | "dependsOn"
      | "executionMethod"
      | "workspace"
      | "materials"
      | "artifacts"
      | "contextNotes"
      | "status"
      | "statusReason"
    >
  > & { id?: string };

export type WorkOrder = {
  id: string;
  name: string;
  description: string;
  projectId: string | null;
  projectMaterialSelectionConfirmed: boolean;
  title: string;
  /** Legacy SQLite storage alias for workspace.path. Never derive it from materials. */
  repositoryPath: string;
  workspace: WorkOrderWorkspace | null;
  materials: WorkOrderMaterial[];
  sourceSessions: WorkOrderImportSource[];
  importContext: WorkOrderImportContext | null;
  sourceContext: WorkOrderSourceContext | null;
  currentSessionId: string | null;
  executionIdentityId: string | null;
  sessionIdentityId: string | null;
  sessionHandoff: SessionHandoff | null;
  importSource: WorkOrderImportSource | null;
  resourcePlan: WorkOrderResourcePlan;
  goal: string;
  acceptance: string | null;
  status: WorkOrderStatus;
  currentSummary: string;
  plan: WorkOrderPlan | null;
  pendingClarification: WorkOrderClarification | null;
  conversation: WorkOrderConversationMessage[];
  result: WorkOrderResult | null;
  revisionNote: string | null;
  worktreePath: string | null;
  executionBranch: string | null;
  baseCommit: string | null;
  sessionId: string | null;
  runStatus: RunStatus | null;
  runStartedAt: string | null;
  runEndedAt: string | null;
  runPid: number | null;
  runNumber: number;
  checkpoints: WorkOrderCheckpoint[];
  recoverySite?: { diffStat: string; statusShort: string };
  runtimeMs: number;
  maxRunMinutes: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateWorkOrderInput = {
  name?: string;
  description?: string;
  projectId?: string | null;
  projectMaterialSelectionConfirmed?: boolean;
  repositoryPath?: string;
  workspace?: WorkOrderWorkspace | null;
  materials?: Array<{
    kind: WorkOrderMaterialKind;
    value: string;
    projectMaterialId?: string;
  }>;
  sourceSessions?: WorkOrderImportSource[];
  importContext?: WorkOrderImportContext | null;
  sourceContext?: WorkOrderSourceContext | null;
  importSource?: WorkOrderImportSource;
  executionIdentityId?: string | null;
  goal?: string;
  acceptance?: string;
};

export function createWorkOrder(input: CreateWorkOrderInput): WorkOrder {
  const legacyRepositoryPath = input.repositoryPath?.trim() ?? "";
  const workspace = input.workspace
    ? { kind: input.workspace.kind, path: input.workspace.path.trim() }
    : legacyRepositoryPath
      ? { kind: "git" as const, path: legacyRepositoryPath }
      : null;
  const repositoryPath = workspace?.path ?? "";
  const usesV2Fields = input.name !== undefined || input.description !== undefined;
  const goal = (usesV2Fields ? input.description : input.goal)?.trim() ?? "";
  const acceptance = input.acceptance?.trim() || null;
  const rawSourceSessions: unknown =
    input.sourceSessions ?? (input.importSource ? [input.importSource] : []);
  if (!Array.isArray(rawSourceSessions) || rawSourceSessions.length > 20) {
    throw new Error("来源会话格式无效");
  }
  const sourceSessions = rawSourceSessions.map(normalizeSourceSession);
  if (new Set(sourceSessions.map((source) => source.kind)).size > 1) {
    throw new Error("一个目标的来源会话必须来自同一个工具");
  }
  if (
    new Set(sourceSessions.map((source) => `${source.kind}:${source.id}`)).size !==
    sourceSessions.length
  ) {
    throw new Error("来源会话不能重复");
  }

  const sourceContext = input.sourceContext === null || input.sourceContext === undefined
    ? null
    : normalizeWorkOrderSourceContext(input.sourceContext);
  if (input.sourceContext !== null && input.sourceContext !== undefined && !sourceContext) {
    throw new Error("来源上下文格式无效");
  }

  if (!goal) {
    throw new Error("请描述想完成的工作");
  }

  const now = new Date().toISOString();
  const firstLine = goal.split(/\r?\n/, 1)[0] ?? goal;
  const legacyTitle = firstLine.length > 56 ? `${firstLine.slice(0, 56)}…` : firstLine;
  const title = usesV2Fields ? input.name?.trim() ?? "" : legacyTitle;
  if (!title) throw new Error("请填写目标名称");

  return {
    id: crypto.randomUUID(),
    name: title,
    description: goal,
    projectId: input.projectId?.trim() || null,
    projectMaterialSelectionConfirmed:
      input.projectMaterialSelectionConfirmed ?? false,
    title,
    repositoryPath,
    workspace,
    materials: (input.materials ?? []).map((material) => ({
      id: crypto.randomUUID(),
      kind: material.kind,
      value: material.value.trim(),
      ...(material.projectMaterialId
        ? { projectMaterialId: material.projectMaterialId }
        : {}),
    })),
    sourceSessions,
    importContext: input.importContext ?? null,
    sourceContext,
    currentSessionId: null,
    executionIdentityId: input.executionIdentityId?.trim() || null,
    sessionIdentityId: null,
    sessionHandoff: null,
    importSource: sourceSessions[0] ?? null,
    resourcePlan: {
      priority: "normal",
      pace: "balanced",
      runWhenQuotaAvailable: false,
      autoRunReason: null,
      paidApiFallbackEnabled: false,
      paidApiLimitUsd: null,
      lastPaidApiRunAt: null,
      lastBillingMode: null,
    },
    goal,
    acceptance,
    status: "draft",
    currentSummary:
      input.importContext?.status === "ready"
        ? input.importContext.currentState || "已保存来源进展"
        : input.importContext
          ? "正在整理历史"
          : "等待生成计划",
    plan: null,
    pendingClarification: null,
    conversation: [],
    result: null,
    revisionNote: null,
    worktreePath: null,
    executionBranch: null,
    baseCommit: null,
    sessionId: null,
    runStatus: null,
    runStartedAt: null,
    runEndedAt: null,
    runPid: null,
    runNumber: 0,
    checkpoints: [],
    runtimeMs: 0,
    maxRunMinutes: 60,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function normalizeWorkOrderSourceContext(value: unknown): WorkOrderSourceContext | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const context = value as Record<string, unknown>;
    if (
      context.kind !== "session_monitoring" ||
      context.version !== 1 ||
      typeof context.createdAt !== "string" ||
      !Number.isFinite(Date.parse(context.createdAt)) ||
      (context.projectId !== null && typeof context.projectId !== "string") ||
      !Array.isArray(context.sessions) ||
      context.sessions.length === 0
    ) {
      return null;
    }
    const sessions = context.sessions.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("invalid source context session");
      }
      const session = value as Record<string, unknown>;
      const key = typeof session.key === "string" ? session.key.trim() : "";
      const title = typeof session.title === "string" ? session.title.trim() : "";
      const projectLabel = typeof session.projectLabel === "string"
        ? session.projectLabel.trim()
        : "";
      const lastActiveAt = session.lastActiveAt;
      const lastReadAt = session.lastReadAt;
      if (
        !key ||
        !title ||
        !projectLabel ||
        typeof lastActiveAt !== "string" ||
        !Number.isFinite(Date.parse(lastActiveAt)) ||
        typeof session.monitoringEnabled !== "boolean" ||
        !["not_started", "pending", "ready", "failed"].includes(
          String(session.organizationStatus),
        ) ||
        (session.lastReadPosition !== null &&
          (!Number.isInteger(session.lastReadPosition) || session.lastReadPosition < 0)) ||
        (lastReadAt !== null &&
          (typeof lastReadAt !== "string" || !Number.isFinite(Date.parse(lastReadAt))))
      ) {
        throw new Error("invalid source context session");
      }
      const source = normalizeSourceSession(session.source);
      return {
        key,
        source,
        title,
        projectLabel,
        lastActiveAt: new Date(lastActiveAt).toISOString(),
        monitoringEnabled: session.monitoringEnabled,
        organizationStatus: session.organizationStatus as WorkOrderSourceContextSession["organizationStatus"],
        lastReadPosition: session.lastReadPosition as number | null,
        lastReadAt: lastReadAt === null ? null : new Date(lastReadAt).toISOString(),
        workGraphSnapshot: session.workGraphSnapshot ?? null,
      };
    });
    if (new Set(sessions.map((session) => session.key)).size !== sessions.length) return null;
    let monitoringWork: WorkOrderSourceContextMonitoringWork | undefined;
    if (context.monitoringWork !== undefined && context.monitoringWork !== null) {
      if (
        typeof context.monitoringWork !== "object" ||
        Array.isArray(context.monitoringWork)
      ) {
        return null;
      }
      const work = context.monitoringWork as Record<string, unknown>;
      const id = typeof work.id === "string" ? work.id.trim() : "";
      const name = typeof work.name === "string" ? work.name.trim() : "";
      const workProjectId = work.projectId === null
        ? null
        : typeof work.projectId === "string"
          ? work.projectId.trim() || null
          : "invalid";
      const sourceSessionKeys = Array.isArray(work.sourceSessionKeys)
        ? work.sourceSessionKeys.map((key) => typeof key === "string" ? key.trim() : "")
        : [];
      const aggregateUpdatedAt = work.aggregateUpdatedAt;
      const updatedAt = work.updatedAt;
      if (
        !id ||
        !name ||
        (workProjectId === "invalid") ||
        !sourceSessionKeys.length ||
        sourceSessionKeys.some((key) => !key) ||
        new Set(sourceSessionKeys).size !== sourceSessionKeys.length ||
        sourceSessionKeys.length !== sessions.length ||
        sourceSessionKeys.some((key) => !sessions.some((session) => session.key === key)) ||
        work.aggregateSnapshotRef !== null && typeof work.aggregateSnapshotRef !== "string" ||
        !["not_started", "pending", "ready", "failed"].includes(String(work.aggregateStatus)) ||
        work.aggregateMessage !== null && typeof work.aggregateMessage !== "string" ||
        (aggregateUpdatedAt !== null &&
          (typeof aggregateUpdatedAt !== "string" || !Number.isFinite(Date.parse(aggregateUpdatedAt)))) ||
        typeof updatedAt !== "string" ||
        !Number.isFinite(Date.parse(updatedAt)) ||
        (work.focusNodeId !== undefined &&
          work.focusNodeId !== null && typeof work.focusNodeId !== "string")
      ) {
        return null;
      }
      const contextProjectId = context.projectId === null
        ? null
        : typeof context.projectId === "string"
          ? context.projectId.trim() || null
          : null;
      if (workProjectId !== contextProjectId) return null;
      monitoringWork = {
        id,
        name,
        projectId: workProjectId,
        sourceSessionKeys,
        aggregateSnapshotRef: work.aggregateSnapshotRef as string | null,
        aggregateSnapshot: work.aggregateSnapshot ?? null,
        aggregateStatus: work.aggregateStatus as WorkOrderSourceContextMonitoringWork["aggregateStatus"],
        aggregateMessage: work.aggregateMessage as string | null,
        aggregateUpdatedAt: aggregateUpdatedAt === null
          ? null
          : new Date(aggregateUpdatedAt as string).toISOString(),
        updatedAt: new Date(updatedAt).toISOString(),
        ...(work.focusNodeId === undefined
          ? {}
          : { focusNodeId: work.focusNodeId === null ? null : (work.focusNodeId as string).trim() || null }),
      };
    }
    return {
      kind: "session_monitoring",
      version: 1,
      createdAt: new Date(context.createdAt).toISOString(),
      projectId: context.projectId === null ? null : context.projectId.trim() || null,
      ...(monitoringWork ? { monitoringWork } : {}),
      sessions,
    };
  } catch {
    return null;
  }
}

function normalizeSourceSession(value: unknown): WorkOrderImportSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("来源会话格式无效");
  }
  const source = value as Record<string, unknown>;
  const id = typeof source.id === "string" ? source.id.trim() : "";
  const lastActiveAt = source.lastActiveAt;
  if (
    !["codex_session", "claude_code_session"].includes(String(source.kind)) ||
    source.version !== 1 ||
    !id ||
    typeof lastActiveAt !== "string" ||
    !Number.isFinite(Date.parse(lastActiveAt))
  ) {
    throw new Error("来源会话格式无效");
  }
  return {
    kind: source.kind as WorkOrderImportSource["kind"],
    id,
    lastActiveAt,
    ...(source.lastReadAt === null
      ? { lastReadAt: null }
      : typeof source.lastReadAt === "string" && Number.isFinite(Date.parse(source.lastReadAt))
        ? { lastReadAt: new Date(source.lastReadAt).toISOString() }
        : {}),
    ...(typeof source.executionIdentityId === "string" && source.executionIdentityId.trim()
      ? { executionIdentityId: source.executionIdentityId.trim() }
      : {}),
    ...(source.openInCodex === true ? { openInCodex: true } : {}),
    version: 1,
  };
}
