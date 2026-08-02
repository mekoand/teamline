import { Database } from "bun:sqlite";
import { createWorkOrder, type CreateWorkOrderInput, type WorkOrder } from "./work-order";

type WorkOrderRow = {
  id: string;
  title: string;
  repository_path: string;
  goal: string;
  acceptance: string | null;
  status: WorkOrder["status"];
  current_summary: string;
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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  list(): WorkOrder[] {
    const rows = this.database
      .query<WorkOrderRow, []>("SELECT * FROM work_orders ORDER BY created_at DESC")
      .all();

    return rows.map(mapRow);
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
