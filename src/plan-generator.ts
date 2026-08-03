import type {
  ClarificationQuestion,
  PlanStageInput,
  WorkOrder,
  WorkOrderMaterialKind,
  WorkOrderPace,
  WorkOrderPriority,
} from "./work-order";

export type GeneratedPlan = {
  stages: PlanStageInput[];
  outcome?: "plan" | "clarification";
  message?: string;
  questions?: ClarificationQuestion[];
  goal?: string;
  acceptance?: string | null;
  materials?: Array<{ kind: WorkOrderMaterialKind; value: string }>;
  resourcePlan?: {
    priority: WorkOrderPriority;
    pace: WorkOrderPace;
    runWhenQuotaAvailable: boolean;
  };
};

export interface PlanGenerator {
  generate(workOrder: WorkOrder, signal?: AbortSignal): Promise<GeneratedPlan>;
}
