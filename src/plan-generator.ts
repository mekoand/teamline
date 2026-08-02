import type { PlanStageInput, WorkOrder } from "./work-order";

export type GeneratedPlan = {
  stages: PlanStageInput[];
};

export interface PlanGenerator {
  generate(workOrder: WorkOrder, signal?: AbortSignal): Promise<GeneratedPlan>;
}
