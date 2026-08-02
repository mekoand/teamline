import { Database } from "bun:sqlite";
import {
  createWorkOrder,
  type CreateWorkOrderInput,
  type PlanStageInput,
  type WorkOrder,
  type WorkOrderPlan,
} from "./work-order";

type WorkOrderRow = {
  id: string;
  title: string;
  repository_path: string;
  goal: string;
  acceptance: string | null;
  status: WorkOrder["status"];
  current_summary: string;
  plan_json: string | null;
  created_at: string;
  updated_at: string;
};

export class WorkOrderStore {
  readonly database: Database;

  constructor(database: Database) {
    this.database = database;
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS work_orders (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        repository_path TEXT NOT NULL,
        goal TEXT NOT NULL,
        acceptance TEXT,
        status TEXT NOT NULL,
        current_summary TEXT NOT NULL,
        plan_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.addPlanColumnToExistingDatabase();
  }

  list(): WorkOrder[] {
    const rows = this.database
      .query<WorkOrderRow, []>("SELECT * FROM work_orders ORDER BY created_at DESC")
      .all();

    return rows.map(mapRow);
  }

  get(id: string): WorkOrder | null {
    const row = this.database
      .query<WorkOrderRow, [string]>("SELECT * FROM work_orders WHERE id = ?")
      .get(id);

    return row ? mapRow(row) : null;
  }

  create(input: CreateWorkOrderInput): WorkOrder {
    const workOrder = createWorkOrder(input);
    this.database
      .query(`
        INSERT INTO work_orders (
          id, title, repository_path, goal, acceptance, status,
          current_summary, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        workOrder.id,
        workOrder.title,
        workOrder.repositoryPath,
        workOrder.goal,
        workOrder.acceptance,
        workOrder.status,
        workOrder.currentSummary,
        workOrder.createdAt,
        workOrder.updatedAt,
      );

    return workOrder;
  }

  savePlan(id: string, stages: PlanStageInput[]): WorkOrder {
    const workOrder = this.get(id);
    if (!workOrder) {
      throw new Error("找不到这项委托");
    }

    if (
      stages.length === 0 ||
      stages.some(
        (stage) =>
          typeof stage?.outcome !== "string" ||
          typeof stage?.scope !== "string" ||
          typeof stage?.verification !== "string",
      )
    ) {
      throw new Error("计划内容不完整，请检查每个阶段");
    }

    const normalizedStages = stages.map((stage) => ({
      id: stage.id || crypto.randomUUID(),
      outcome: stage.outcome.trim(),
      scope: stage.scope.trim(),
      verification: stage.verification.trim(),
    }));

    if (
      normalizedStages.some(
        (stage) => !stage.outcome || !stage.scope || !stage.verification,
      )
    ) {
      throw new Error("计划内容不完整，请检查每个阶段");
    }

    const now = new Date().toISOString();
    const plan: WorkOrderPlan = {
      version: (workOrder.plan?.version ?? 0) + 1,
      stages: normalizedStages,
      updatedAt: now,
    };

    this.database
      .query(`
        UPDATE work_orders
        SET plan_json = ?, status = ?, current_summary = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(JSON.stringify(plan), "ready", "计划等待确认", now, id);

    return this.get(id)!;
  }

  private addPlanColumnToExistingDatabase(): void {
    const columns = this.database
      .query<{ name: string }, []>("PRAGMA table_info(work_orders)")
      .all();

    if (!columns.some((column) => column.name === "plan_json")) {
      this.database.exec("ALTER TABLE work_orders ADD COLUMN plan_json TEXT");
    }
  }
}

function mapRow(row: WorkOrderRow): WorkOrder {
  return {
    id: row.id,
    title: row.title,
    repositoryPath: row.repository_path,
    goal: row.goal,
    acceptance: row.acceptance,
    status: row.status,
    currentSummary: row.current_summary,
    plan: row.plan_json ? JSON.parse(row.plan_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
