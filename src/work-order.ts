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
  message: string;
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
  status: PlanNodeStatus;
  statusReason: string;
};

export const workOrderMaterialKinds = [
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
  git: GitChangeSummary;
  verifications: VerificationResult[];
  completedAt: string;
};

export type WorkOrderPlan = {
  version: number;
  stages: PlanStage[];
  updatedAt: string;
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
      | "status"
      | "statusReason"
    >
  > & { id?: string };

export type WorkOrder = {
  id: string;
  title: string;
  /** Legacy SQLite storage alias for workspace.path. Never derive it from materials. */
  repositoryPath: string;
  workspace: WorkOrderWorkspace | null;
  materials: WorkOrderMaterial[];
  resourcePlan: WorkOrderResourcePlan;
  goal: string;
  acceptance: string | null;
  status: WorkOrderStatus;
  currentSummary: string;
  plan: WorkOrderPlan | null;
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
  repositoryPath?: string;
  workspace?: WorkOrderWorkspace | null;
  materials?: Array<{ kind: WorkOrderMaterialKind; value: string }>;
  goal: string;
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
  const goal = input.goal.trim();
  const acceptance = input.acceptance?.trim() || null;

  if (!goal) {
    throw new Error("请描述想完成的工作");
  }

  const now = new Date().toISOString();
  const firstLine = goal.split(/\r?\n/, 1)[0] ?? goal;
  const title = firstLine.length > 56 ? `${firstLine.slice(0, 56)}…` : firstLine;

  return {
    id: crypto.randomUUID(),
    title,
    repositoryPath,
    workspace,
    materials: (input.materials ?? []).map((material) => ({
      id: crypto.randomUUID(),
      kind: material.kind,
      value: material.value.trim(),
    })),
    resourcePlan: {
      priority: "normal",
      pace: "balanced",
      runWhenQuotaAvailable: false,
      autoRunReason: null,
    },
    goal,
    acceptance,
    status: "draft",
    currentSummary: "等待生成计划",
    plan: null,
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
