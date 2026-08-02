export const workOrderStatuses = [
  "draft",
  "ready",
  "running",
  "interrupted",
  "review",
  "completed",
] as const;

export type WorkOrderStatus = (typeof workOrderStatuses)[number];

export type RunStatus = "running" | "completed" | "failed";

export type WorkOrderRunEvent = {
  id: number;
  type: "session" | "progress" | "exit";
  message: string;
  createdAt: string;
};

export type PlanStage = {
  id: string;
  outcome: string;
  scope: string;
  verification: string;
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
  worktreePath: string | null;
  executionBranch: string | null;
  baseCommit: string | null;
  sessionId: string | null;
  runStatus: RunStatus | null;
  runStartedAt: string | null;
  runEndedAt: string | null;
  runtimeMs: number;
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
    worktreePath: null,
    executionBranch: null,
    baseCommit: null,
    sessionId: null,
    runStatus: null,
    runStartedAt: null,
    runEndedAt: null,
    runtimeMs: 0,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}
