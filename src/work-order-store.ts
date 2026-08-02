import { Database } from "bun:sqlite";
import {
  createWorkOrder,
  type CreateWorkOrderInput,
  type PlanStageInput,
  type WorkOrder,
  type WorkOrderPlan,
  type WorkOrderRunEvent,
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
  worktree_path: string | null;
  execution_branch: string | null;
  base_commit: string | null;
  session_id: string | null;
  run_status: WorkOrder["runStatus"];
  run_started_at: string | null;
  run_ended_at: string | null;
  runtime_ms: number;
  runtime_updated_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type RunEventRow = {
  id: number;
  event_type: WorkOrderRunEvent["type"];
  message: string;
  created_at: string;
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
    this.addExecutionColumnsToExistingDatabase();
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_order_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (work_order_id) REFERENCES work_orders(id)
      )
    `);
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

  saveWorktree(
    id: string,
    worktree: { path: string; branch: string; baseCommit: string },
  ): WorkOrder {
    const now = new Date().toISOString();
    this.database
      .query(`
        UPDATE work_orders
        SET worktree_path = ?, execution_branch = ?, base_commit = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(worktree.path, worktree.branch, worktree.baseCommit, now, id);
    return this.get(id)!;
  }

  markStarted(id: string): WorkOrder {
    const now = new Date().toISOString();
    this.database
      .query(`
        UPDATE work_orders
        SET status = 'running', current_summary = 'Codex 已启动',
            run_status = 'running', session_id = NULL,
            run_started_at = ?, run_ended_at = NULL, runtime_updated_at = ?,
            last_error = NULL, updated_at = ?
        WHERE id = ?
      `)
      .run(now, now, now, id);
    return this.get(id)!;
  }

  recordStartFailure(id: string, error: string, summary: string): WorkOrder {
    const now = new Date().toISOString();
    this.database
      .query(`
        UPDATE work_orders
        SET status = 'ready', current_summary = ?, run_status = NULL,
            last_error = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(summary, error, now, id);
    return this.get(id)!;
  }

  hasActiveRun(): boolean {
    return Boolean(
      this.database
        .query<{ present: number }, []>(
          "SELECT 1 AS present FROM work_orders WHERE run_status = 'running' LIMIT 1",
        )
        .get(),
    );
  }

  interruptActiveRunsAfterRestart(): number {
    const active = this.database
      .query<{ id: string }, []>(
        "SELECT id FROM work_orders WHERE run_status = 'running'",
      )
      .all();
    const message = "本地服务重启，无法继续跟踪这次运行";
    for (const workOrder of active) {
      this.recordExit(workOrder.id, -1, message);
    }
    return active.length;
  }

  recordSession(id: string, sessionId: string): void {
    this.appendRunEvent(id, "session", "Codex 会话已连接", {
      sessionId,
      summary: "Codex 会话已连接",
    });
  }

  recordProgress(id: string, message: string): void {
    this.appendRunEvent(id, "progress", message, { summary: message });
  }

  recordExit(id: string, exitCode: number, message: string): void {
    const failed = exitCode !== 0;
    this.appendRunEvent(id, "exit", message, {
      summary: message,
      ended: true,
      failed,
    });
  }

  listRunEvents(id: string, limit = 20): WorkOrderRunEvent[] {
    const rows = this.database
      .query<RunEventRow, [string, number]>(`
        SELECT id, event_type, message, created_at
        FROM run_events
        WHERE work_order_id = ?
        ORDER BY id DESC
        LIMIT ?
      `)
      .all(id, limit)
      .reverse();

    return rows.map((row) => ({
      id: row.id,
      type: row.event_type,
      message: row.message,
      createdAt: row.created_at,
    }));
  }

  private appendRunEvent(
    id: string,
    type: WorkOrderRunEvent["type"],
    message: string,
    options: {
      sessionId?: string;
      summary: string;
      ended?: boolean;
      failed?: boolean;
    },
  ): void {
    const row = this.database
      .query<WorkOrderRow, [string]>("SELECT * FROM work_orders WHERE id = ?")
      .get(id);
    if (!row || row.run_status !== "running") {
      return;
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const lastUpdated = row.runtime_updated_at
      ? Date.parse(row.runtime_updated_at)
      : now.getTime();
    const runtimeMs = row.runtime_ms + Math.max(0, now.getTime() - lastUpdated);
    const status = options.ended && options.failed ? "interrupted" : row.status;
    const runStatus = options.ended
      ? options.failed
        ? "failed"
        : "completed"
      : "running";

    this.database.transaction(() => {
      this.database
        .query(`
          UPDATE work_orders
          SET status = ?, current_summary = ?, session_id = COALESCE(?, session_id),
              run_status = ?, run_ended_at = ?, runtime_ms = ?, runtime_updated_at = ?,
              last_error = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(
          status,
          options.summary,
          options.sessionId ?? null,
          runStatus,
          options.ended ? nowIso : null,
          runtimeMs,
          nowIso,
          options.failed ? message : null,
          nowIso,
          id,
        );
      this.database
        .query(`
          INSERT INTO run_events (work_order_id, event_type, message, created_at)
          VALUES (?, ?, ?, ?)
        `)
        .run(id, type, message, nowIso);
    })();
  }

  private addPlanColumnToExistingDatabase(): void {
    const columns = this.database
      .query<{ name: string }, []>("PRAGMA table_info(work_orders)")
      .all();

    if (!columns.some((column) => column.name === "plan_json")) {
      this.database.exec("ALTER TABLE work_orders ADD COLUMN plan_json TEXT");
    }
  }

  private addExecutionColumnsToExistingDatabase(): void {
    const columns = new Set(
      this.database
        .query<{ name: string }, []>("PRAGMA table_info(work_orders)")
        .all()
        .map((column) => column.name),
    );
    const additions = [
      ["worktree_path", "TEXT"],
      ["execution_branch", "TEXT"],
      ["base_commit", "TEXT"],
      ["session_id", "TEXT"],
      ["run_status", "TEXT"],
      ["run_started_at", "TEXT"],
      ["run_ended_at", "TEXT"],
      ["runtime_ms", "INTEGER NOT NULL DEFAULT 0"],
      ["runtime_updated_at", "TEXT"],
      ["last_error", "TEXT"],
    ] as const;

    for (const [name, definition] of additions) {
      if (!columns.has(name)) {
        this.database.exec(`ALTER TABLE work_orders ADD COLUMN ${name} ${definition}`);
      }
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
    worktreePath: row.worktree_path,
    executionBranch: row.execution_branch,
    baseCommit: row.base_commit,
    sessionId: row.session_id,
    runStatus: row.run_status,
    runStartedAt: row.run_started_at,
    runEndedAt: row.run_ended_at,
    runtimeMs: currentRuntime(row),
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function currentRuntime(row: WorkOrderRow): number {
  if (row.run_status !== "running" || !row.runtime_updated_at) {
    return row.runtime_ms;
  }
  return row.runtime_ms + Math.max(0, Date.now() - Date.parse(row.runtime_updated_at));
}
