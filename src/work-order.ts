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

export type PlanStage = {
  id: string;
  outcome: string;
  scope: string;
  verification: string;
  verificationCommand?: string;
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

export type PlanStageInput = Omit<PlanStage, "id"> & { id?: string };

export type WorkOrder = {
  id: string;
  title: string;
  repositoryPath: string;
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
  runtimeMs: number;
  maxRunMinutes: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateWorkOrderInput = {
  repositoryPath: string;
  goal: string;
  acceptance?: string;
};

export function createWorkOrder(input: CreateWorkOrderInput): WorkOrder {
  const repositoryPath = input.repositoryPath.trim();
  const goal = input.goal.trim();
  const acceptance = input.acceptance?.trim() || null;

  if (!repositoryPath) {
    throw new Error("请选择本地仓库");
  }

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
    runtimeMs: 0,
    maxRunMinutes: 60,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}
