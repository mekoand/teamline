import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { CodexResourceSignal } from "./resource-provider";
import {
  executionIdentityLoginStates,
  type ExecutionIdentity,
  type ExecutionIdentityLoginState,
  type ExecutionIdentityObservation,
} from "./execution-identity";
import {
  createProject,
  createProjectMaterial,
  type CreateProjectMaterialInput,
  type Project,
  type ProjectMaterial,
  type ProjectMaterialKind,
} from "./project";
import {
  createWorkOrder,
  type CreateWorkOrderInput,
  type ClarificationQuestion,
  type PlanReference,
  type PlanStage,
  type PlanStageInput,
  type PlanWorkspace,
  type WorkOrder,
  type WorkOrderCheckpoint,
  type WorkOrderConversationMessage,
  type WorkOrderClarification,
  type WorkOrderPlan,
  type WorkOrderRunEvent,
  type WorkOrderResult,
  type WorkOrderPace,
  type WorkOrderPriority,
  type WorkOrderResourcePlan,
  type WorkOrderImportSource,
  type WorkOrderImportContext,
  type SessionHandoff,
  type WorkOrderWorkspace,
  workOrderPaces,
  workOrderPriorities,
  workOrderMaterialKinds,
} from "./work-order";

type WorkOrderRow = {
  id: string;
  title: string;
  project_id: string | null;
  project_materials_confirmed: number;
  repository_path: string;
  workspace_kind: "git" | "directory" | null;
  materials_json: string | null;
  source_sessions_json: string | null;
  import_context_json: string | null;
  import_source_json: string | null;
  resource_plan_json: string | null;
  goal: string;
  acceptance: string | null;
  status: WorkOrder["status"] | "completed";
  current_summary: string;
  plan_json: string | null;
  clarification_json: string | null;
  result_json: string | null;
  revision_note: string | null;
  worktree_path: string | null;
  execution_branch: string | null;
  base_commit: string | null;
  session_id: string | null;
  execution_identity_id: string | null;
  session_identity_id: string | null;
  session_handoff_json: string | null;
  run_status: WorkOrder["runStatus"];
  run_started_at: string | null;
  run_ended_at: string | null;
  run_pid: number | null;
  run_number: number;
  runtime_ms: number;
  runtime_updated_at: string | null;
  max_run_minutes: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type ProjectRow = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
};

type ProjectMaterialRow = {
  id: string;
  project_id: string;
  material_kind: ProjectMaterialKind;
  label: string;
  value: string;
  source_goal_id: string | null;
  created_at: string;
  updated_at: string;
};

type RunEventRow = {
  id: number;
  event_type: WorkOrderRunEvent["type"];
  event_category: WorkOrderRunEvent["category"] | null;
  message: string;
  stage_id: string | null;
  detail_json: string | null;
  run_number: number;
  created_at: string;
};

type CheckpointRow = {
  id: string;
  checkpoint_kind: WorkOrderCheckpoint["kind"];
  plan_version: number;
  stage_id: string | null;
  stage_outcome: string | null;
  run_number: number;
  sequence: number;
  tree_hash: string;
  created_at: string;
};

type ConversationRow = {
  id: number;
  role: WorkOrderConversationMessage["role"];
  message_kind: WorkOrderConversationMessage["kind"];
  content: string;
  stage_id: string | null;
  decision_target: WorkOrderConversationMessage["decisionTarget"];
  requires_plan_confirmation: number;
  created_at: string;
};

type ExecutionIdentityRow = {
  id: string;
  tool: "codex";
  label: string;
  identity_status: ExecutionIdentity["status"];
  home_kind: ExecutionIdentity["homeKind"];
  managed_home_path: string | null;
  account_fingerprint: string | null;
  login_state: ExecutionIdentityLoginState;
  capabilities_json: string;
  last_observed_at: string | null;
  created_at: string;
  updated_at: string;
  removed_at: string | null;
};

type ExecutionIdentityQuotaRow = {
  execution_identity_id: string;
  signal_json: string;
  observed_at: string;
  updated_at: string;
};

export type ExecutionIdentityQuotaSnapshot = {
  executionIdentityId: string;
  signal: CodexResourceSignal;
  observedAt: string;
  updatedAt: string;
};

export type LocalNotificationKind =
  | "response"
  | "review"
  | "completed"
  | "auto_run_started"
  | "auto_run_stopped";

export type LocalNotification = {
  id: number;
  kind: LocalNotificationKind;
  workOrderId: string;
  stageId: string | null;
  title: string;
  body: string;
  targetUrl: string;
  readAt: string | null;
  claimedAt: string | null;
  createdAt: string;
};

export type NotificationSettings = {
  autoRunStarted: boolean;
  autoRunStopped: boolean;
};

type LocalNotificationRow = {
  id: number;
  notification_kind: LocalNotificationKind;
  work_order_id: string;
  stage_id: string | null;
  title: string;
  body: string;
  target_url: string;
  read_at: string | null;
  claimed_at: string | null;
  created_at: string;
};

export class PlanLockedError extends Error {}

export class WorkOrderStore {
  readonly database: Database;

  constructor(database: Database) {
    this.database = database;
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS project_materials (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        material_kind TEXT NOT NULL,
        label TEXT NOT NULL,
        value TEXT NOT NULL,
        source_goal_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );
      CREATE INDEX IF NOT EXISTS project_materials_lookup
      ON project_materials(project_id, created_at DESC);
    `);
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
    this.addResultColumnsToExistingDatabase();
    this.addMaterialColumnsToExistingDatabase();
    this.addImportSourceColumnToExistingDatabase();
    this.addResourcePlanColumnToExistingDatabase();
    this.addClarificationColumnToExistingDatabase();
    this.addV2DomainColumnsToExistingDatabase();
    this.addImportContextColumnToExistingDatabase();
    this.migrateDeliveredStatus();
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_order_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_category TEXT,
        message TEXT NOT NULL,
        stage_id TEXT,
        detail_json TEXT,
        run_number INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (work_order_id) REFERENCES work_orders(id)
      )
    `);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS work_order_conversation (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_order_id TEXT NOT NULL,
        role TEXT NOT NULL,
        message_kind TEXT NOT NULL,
        content TEXT NOT NULL,
        stage_id TEXT,
        decision_target TEXT,
        requires_plan_confirmation INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (work_order_id) REFERENCES work_orders(id)
      );
      CREATE INDEX IF NOT EXISTS work_order_conversation_lookup
      ON work_order_conversation(work_order_id, id);
    `);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS local_preferences (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.createExecutionIdentityTable();
    this.ensureDefaultExecutionIdentity();
    this.addExecutionIdentityBindingColumns();
    this.createExecutionIdentityQuotaTable();
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS work_order_checkpoints (
        id TEXT PRIMARY KEY,
        work_order_id TEXT NOT NULL,
        checkpoint_kind TEXT NOT NULL,
        plan_version INTEGER NOT NULL,
        stage_id TEXT,
        stage_outcome TEXT,
        run_number INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        tree_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (work_order_id) REFERENCES work_orders(id)
      );
      CREATE INDEX IF NOT EXISTS work_order_checkpoints_lookup
      ON work_order_checkpoints(work_order_id, sequence);
    `);
    this.addRunEventColumnsToExistingDatabase();
    this.backfillLegacyRunNumbers();
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS execution_settings (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        max_concurrency INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO execution_settings (singleton, max_concurrency)
      VALUES (1, 2);
    `);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS local_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dedupe_key TEXT NOT NULL UNIQUE,
        notification_kind TEXT NOT NULL,
        work_order_id TEXT NOT NULL,
        stage_id TEXT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        target_url TEXT NOT NULL,
        read_at TEXT,
        claimed_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (work_order_id) REFERENCES work_orders(id)
      );
      CREATE INDEX IF NOT EXISTS local_notifications_recent
      ON local_notifications(created_at DESC, id DESC);
      UPDATE local_notifications
      SET notification_kind = 'review'
      WHERE notification_kind = 'response' AND dedupe_key LIKE 'response:%:review:%';
    `);
  }

  listProjects(): Project[] {
    return this.database
      .query<ProjectRow, []>("SELECT * FROM projects ORDER BY created_at DESC")
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  createProject(name: string): Project {
    const project = createProject(name);
    this.database
      .query(`
        INSERT INTO projects (id, name, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `)
      .run(project.id, project.name, project.createdAt, project.updatedAt);
    return project;
  }

  listProjectMaterials(projectId: string): ProjectMaterial[] {
    return this.database
      .query<ProjectMaterialRow, [string]>(`
        SELECT * FROM project_materials
        WHERE project_id = ?
        ORDER BY created_at DESC, id DESC
      `)
      .all(projectId)
      .map(mapProjectMaterialRow);
  }

  createProjectMaterial(
    projectId: string,
    input: CreateProjectMaterialInput,
  ): ProjectMaterial {
    if (!this.getProject(projectId)) throw new Error("找不到这个项目");
    if (input.kind === "goal") {
      const goal = this.get(input.value.trim());
      if (!goal) throw new Error("找不到引用的目标");
      if (goal.status !== "delivered") throw new Error("只能引用已完成目标");
    }
    const material = createProjectMaterial(projectId, input);
    this.database.transaction(() => {
      this.database
        .query(`
          INSERT INTO project_materials (
            id, project_id, material_kind, label, value, source_goal_id,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          material.id,
          material.projectId,
          material.kind,
          material.label,
          material.value,
          material.sourceGoalId,
          material.createdAt,
          material.updatedAt,
        );
      this.touchProject(projectId, material.updatedAt);
    })();
    return material;
  }

  listProjectScopeMaterials(projectId: string): ProjectMaterial[] {
    const explicit = this.listProjectMaterials(projectId);
    const explicitLocations = new Set(
      explicit
        .filter((material) => material.kind !== "goal")
        .map((material) => `${material.kind}:${material.value}`),
    );
    const inherited = this.list()
      .filter((workOrder) => workOrder.projectId === projectId)
      .flatMap((workOrder) =>
        workOrder.materials
          .filter(
            (material) =>
              !material.projectMaterialId &&
              !explicitLocations.has(`${material.kind}:${material.value}`),
          )
          .map((material) => ({
            id: `goal-material:${workOrder.id}:${material.id}`,
            projectId,
            kind: material.kind,
            label: `${workOrder.name} · ${projectMaterialLabel(material.value)}`,
            value: material.value,
            sourceGoalId: workOrder.id,
            createdAt: workOrder.createdAt,
            updatedAt: workOrder.updatedAt,
          })),
      );
    return [...explicit, ...inherited].sort(
      (left, right) => right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  recommendProjectMaterials(
    projectId: string,
    name: string,
    description: string,
  ): { materials: ProjectMaterial[]; recommendedIds: string[] } {
    const materials = this.listProjectScopeMaterials(projectId);
    const queryTokens = textTokens(`${name} ${description}`);
    const ranked = materials
      .map((material, index) => ({
        material,
        index,
        score: overlapScore(
          queryTokens,
          textTokens(`${material.label} ${material.value}`),
        ),
      }))
      .sort(
        (left, right) =>
          right.score - left.score || left.index - right.index,
      );
    const selected = ranked.filter((item) => item.score > 0).slice(0, 3);
    return {
      materials,
      recommendedIds: selected.map((item) => item.material.id),
    };
  }

  resolveProjectMaterials(
    projectId: string | null,
    materialIds: string[],
  ): WorkOrder["materials"] {
    if (!projectId) {
      if (materialIds.length) throw new Error("请先选择项目");
      return [];
    }
    const available = new Map(
      this.listProjectScopeMaterials(projectId).map((material) => [material.id, material]),
    );
    return [...new Set(materialIds)].map((id) => {
      const material = available.get(id);
      if (!material) throw new Error("所选项目素材已经不可用");
      return {
        id: crypto.randomUUID(),
        kind: material.kind === "goal" ? "text" : material.kind,
        value:
          material.kind === "goal"
            ? this.goalReferenceSnapshot(material.value)
            : material.value,
        projectMaterialId: material.id,
      };
    });
  }

  saveProjectContext(
    id: string,
    projectId: string | null,
    projectMaterialIds: string[],
  ): WorkOrder {
    const workOrder = this.get(id);
    if (!workOrder) throw new Error("找不到这个目标");
    if (["running", "stopping", "verifying"].includes(workOrder.runStatus ?? "")) {
      throw new Error("目标运行时不能修改项目素材");
    }
    const normalizedProjectId = projectId?.trim() || null;
    if (normalizedProjectId && !this.getProject(normalizedProjectId)) {
      throw new Error("找不到所选项目");
    }
    const inherited = this.resolveProjectMaterials(
      normalizedProjectId,
      projectMaterialIds,
    );
    const ownMaterials = workOrder.materials.filter(
      (material) => !material.projectMaterialId,
    );
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database
        .query(`
          UPDATE work_orders
          SET project_id = ?, project_materials_confirmed = 1,
              materials_json = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(
          normalizedProjectId,
          JSON.stringify([...ownMaterials, ...inherited]),
          now,
          id,
        );
      if (normalizedProjectId) this.touchProject(normalizedProjectId, now);
    })();
    return this.get(id)!;
  }

  private goalReferenceSnapshot(id: string): string {
    const workOrder = this.get(id);
    if (!workOrder) throw new Error("引用的目标已经不可用");
    const status = {
      draft: "规划中",
      ready: "待运行",
      running: "运行中",
      interrupted: "需响应",
      review: "待验收",
      delivered: "已完成",
    }[workOrder.status];
    const artifacts = workOrder.plan?.stages
      .flatMap((stage) => stage.artifacts)
      .slice(0, 5)
      .map((artifact) => `${artifact.label}（${artifact.location}）`)
      .join("；");
    const result = artifacts || workOrder.result?.git.diffStat || workOrder.currentSummary;
    return `目标“${workOrder.name}”：${status}。成果摘要：${result || "暂无成果"}`;
  }

  private touchProject(id: string, updatedAt = new Date().toISOString()): void {
    this.database
      .query("UPDATE projects SET updated_at = ? WHERE id = ?")
      .run(updatedAt, id);
  }

  list(): WorkOrder[] {
    const rows = this.database
      .query<WorkOrderRow, []>("SELECT * FROM work_orders ORDER BY created_at DESC")
      .all();

    return rows.map((row) =>
      mapRow(row, this.listCheckpoints(row.id), this.listConversation(row.id)),
    );
  }

  get(id: string): WorkOrder | null {
    const row = this.database
      .query<WorkOrderRow, [string]>("SELECT * FROM work_orders WHERE id = ?")
      .get(id);

    return row
      ? mapRow(row, this.listCheckpoints(row.id), this.listConversation(row.id))
      : null;
  }

  listConversation(id: string): WorkOrderConversationMessage[] {
    return this.database
      .query<ConversationRow, [string]>(`
        SELECT id, role, message_kind, content, stage_id, decision_target,
               requires_plan_confirmation, created_at
        FROM work_order_conversation
        WHERE work_order_id = ?
        ORDER BY id ASC
      `)
      .all(id)
      .map((row) => ({
        id: row.id,
        role: row.role,
        kind: row.message_kind,
        content: row.content,
        stageId: row.stage_id,
        decisionTarget: row.decision_target,
        requiresPlanConfirmation: row.requires_plan_confirmation === 1,
        createdAt: row.created_at,
      }));
  }

  listCheckpoints(id: string): WorkOrderCheckpoint[] {
    return this.database
      .query<CheckpointRow, [string]>(`
        SELECT id, checkpoint_kind, plan_version, stage_id, stage_outcome,
               run_number, sequence, tree_hash, created_at
        FROM work_order_checkpoints
        WHERE work_order_id = ?
        ORDER BY sequence ASC
      `)
      .all(id)
      .map(mapCheckpointRow);
  }

  saveCheckpoint(
    id: string,
    checkpoint: Omit<WorkOrderCheckpoint, "sequence" | "createdAt">,
  ): WorkOrderCheckpoint {
    const workOrder = this.get(id);
    if (!workOrder) throw new Error("找不到这个目标");
    if (checkpoint.planVersion !== workOrder.plan?.version) {
      throw new Error("检查点与当前计划版本不一致");
    }
    const sequence =
      (this.database
        .query<{ sequence: number }, [string]>(`
          SELECT sequence FROM work_order_checkpoints
          WHERE work_order_id = ?
          ORDER BY sequence DESC LIMIT 1
        `)
        .get(id)?.sequence ?? 0) + 1;
    const createdAt = new Date().toISOString();
    this.database
      .query(`
        INSERT INTO work_order_checkpoints (
          id, work_order_id, checkpoint_kind, plan_version, stage_id,
          stage_outcome, run_number, sequence, tree_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        checkpoint.id,
        id,
        checkpoint.kind,
        checkpoint.planVersion,
        checkpoint.stageId,
        checkpoint.stageOutcome,
        checkpoint.runNumber,
        sequence,
        checkpoint.treeHash,
        createdAt,
      );
    return { ...checkpoint, sequence, createdAt };
  }

  latestRecoveryCheckpoint(id: string): WorkOrderCheckpoint | null {
    const workOrder = this.get(id);
    if (!workOrder?.plan) return null;
    return (
      workOrder.checkpoints
        .filter((checkpoint) => checkpoint.planVersion === workOrder.plan!.version)
        .at(-1) ?? null
    );
  }

  listExecutionIdentities(): ExecutionIdentity[] {
    return this.database
      .query<ExecutionIdentityRow, []>(`
        SELECT id, tool, label, identity_status, home_kind, managed_home_path,
               account_fingerprint, login_state, capabilities_json,
               last_observed_at, created_at, updated_at, removed_at
        FROM execution_identities
        ORDER BY CASE identity_status WHEN 'enabled' THEN 0 WHEN 'disabled' THEN 1 ELSE 2 END,
                 created_at ASC, id ASC
      `)
      .all()
      .map(mapExecutionIdentityRow);
  }

  getExecutionIdentity(id: string): ExecutionIdentity | null {
    const row = this.database
      .query<ExecutionIdentityRow, [string]>(`
        SELECT id, tool, label, identity_status, home_kind, managed_home_path,
               account_fingerprint, login_state, capabilities_json,
               last_observed_at, created_at, updated_at, removed_at
        FROM execution_identities
        WHERE id = ?
      `)
      .get(id);
    return row ? mapExecutionIdentityRow(row) : null;
  }

  getDefaultExecutionIdentityId(): string | null {
    const value = this.database
      .query<{ value: string }, []>(`
        SELECT value FROM local_preferences
        WHERE key = 'default-codex-execution-identity-id'
      `)
      .get()?.value;
    const identity = value ? this.getExecutionIdentity(value) : null;
    return identity && identity.status !== "removed" ? identity.id : null;
  }

  setDefaultExecutionIdentityId(id: string): ExecutionIdentity {
    const identity = this.requireUsableExecutionIdentity(id);
    this.saveDefaultExecutionIdentityId(identity.id, new Date().toISOString());
    return identity;
  }

  getCurrentExecutionIdentityId(): string | null {
    const value = this.database
      .query<{ value: string }, []>(`
        SELECT value FROM local_preferences
        WHERE key = 'current-codex-execution-identity-id'
      `)
      .get()?.value;
    const identity = value ? this.getExecutionIdentity(value) : null;
    return identity && identity.status !== "removed" ? identity.id : null;
  }

  setCurrentExecutionIdentityId(id: string): ExecutionIdentity {
    const identity = this.requireUsableExecutionIdentity(id);
    this.database
      .query(`
        INSERT INTO local_preferences (key, value, updated_at)
        VALUES ('current-codex-execution-identity-id', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `)
      .run(identity.id, new Date().toISOString());
    return identity;
  }

  getSystemExecutionIdentityId(): string | null {
    return this.database
      .query<{ id: string }, []>(`
        SELECT id FROM execution_identities
        WHERE home_kind = 'system' AND identity_status <> 'removed'
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `)
      .get()?.id ?? null;
  }

  bindExecutionIdentity(id: string, requestedIdentityId?: string): WorkOrder {
    const workOrder = this.get(id);
    if (!workOrder) throw new Error("找不到这个目标");
    if (workOrder.executionIdentityId) {
      this.requireUsableExecutionIdentity(workOrder.executionIdentityId);
      return workOrder;
    }
    const identityId = requestedIdentityId ?? this.getDefaultExecutionIdentityId();
    if (!identityId) throw new Error("请先选择可用的 Codex 账号");
    this.requireUsableExecutionIdentity(identityId);
    const now = new Date().toISOString();
    this.database
      .query(`
        UPDATE work_orders
        SET execution_identity_id = ?, updated_at = ?
        WHERE id = ? AND execution_identity_id IS NULL
      `)
      .run(identityId, now, id);
    return this.get(id)!;
  }

  switchExecutionIdentity(id: string, executionIdentityId: string): WorkOrder {
    const workOrder = this.get(id);
    if (!workOrder) throw new Error("找不到这个目标");
    if (["running", "stopping", "verifying"].includes(workOrder.runStatus ?? "")) {
      throw new Error("请等待当前节点结束后再切换账号");
    }
    const identity = this.requireUsableExecutionIdentity(executionIdentityId);
    if (workOrder.executionIdentityId === identity.id) return workOrder;
    const currentStage = workOrder.plan?.stages.find((stage) =>
      ["running", "response"].includes(stage.status),
    ) ?? workOrder.plan?.stages.find((stage) => stage.status !== "completed") ?? null;
    const handoff: SessionHandoff | null = workOrder.executionIdentityId
      ? {
          fromExecutionIdentityId: workOrder.executionIdentityId,
          previousSessionId: workOrder.sessionId,
          summary: workOrder.currentSummary,
          currentStageId: currentStage?.id ?? null,
          currentStageOutcome: currentStage?.outcome ?? null,
          createdAt: new Date().toISOString(),
        }
      : null;
    const now = new Date().toISOString();
    this.database
      .query(`
        UPDATE work_orders
        SET execution_identity_id = ?, session_id = NULL,
            session_identity_id = NULL, session_handoff_json = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(identity.id, handoff ? JSON.stringify(handoff) : null, now, id);
    return this.get(id)!;
  }

  createManagedExecutionIdentity(input: {
    id: string;
    label: string;
    managedHomePath: string;
  }): ExecutionIdentity {
    const id = input.id.trim();
    const label = normalizeExecutionIdentityLabel(input.label);
    const managedHomePath = input.managedHomePath.trim();
    if (!id) throw new Error("账号标识不能为空");
    if (!managedHomePath) throw new Error("Codex 账号目录不能为空");
    const now = new Date().toISOString();
    this.database
      .query(`
        INSERT INTO execution_identities (
          id, tool, label, identity_status, home_kind, managed_home_path,
          account_fingerprint, login_state, capabilities_json,
          last_observed_at, created_at, updated_at, removed_at
        ) VALUES (?, 'codex', ?, 'enabled', 'managed', ?, NULL, 'signed_out', '[]', NULL, ?, ?, NULL)
      `)
      .run(id, label, managedHomePath, now, now);
    if (!this.getDefaultExecutionIdentityId()) {
      this.saveDefaultExecutionIdentityId(id, now);
    }
    return this.getExecutionIdentity(id)!;
  }

  renameExecutionIdentity(id: string, label: string): ExecutionIdentity {
    const identity = this.requireExecutionIdentity(id);
    if (identity.status === "removed") throw new Error("已移除的账号不能改名");
    this.database
      .query("UPDATE execution_identities SET label = ?, updated_at = ? WHERE id = ?")
      .run(normalizeExecutionIdentityLabel(label), new Date().toISOString(), id);
    return this.getExecutionIdentity(id)!;
  }

  setExecutionIdentityEnabled(id: string, enabled: boolean): ExecutionIdentity {
    const identity = this.requireExecutionIdentity(id);
    if (identity.status === "removed") throw new Error("已移除的账号不能重新启用");
    this.database
      .query(`
        UPDATE execution_identities
        SET identity_status = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(enabled ? "enabled" : "disabled", new Date().toISOString(), id);
    return this.getExecutionIdentity(id)!;
  }

  recordExecutionIdentityObservation(
    id: string,
    observation: ExecutionIdentityObservation,
  ): ExecutionIdentity {
    const identity = this.requireExecutionIdentity(id);
    if (identity.status === "removed") throw new Error("已移除的账号不能更新状态");
    if (!executionIdentityLoginStates.includes(observation.loginState)) {
      throw new Error("Codex 登录状态无效");
    }
    const observedAt = observation.observedAt ?? new Date().toISOString();
    const capabilities = normalizeExecutionIdentityCapabilities(
      observation.capabilities ?? identity.capabilities,
    );
    this.database
      .query(`
        UPDATE execution_identities
        SET account_fingerprint = ?, login_state = ?, capabilities_json = ?,
            last_observed_at = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        observation.accountFingerprint === undefined
          ? identity.accountFingerprint
          : observation.accountFingerprint,
        observation.loginState,
        JSON.stringify(capabilities),
        observedAt,
        observedAt,
        id,
      );
    return this.getExecutionIdentity(id)!;
  }

  removeExecutionIdentity(id: string): ExecutionIdentity {
    const identity = this.requireExecutionIdentity(id);
    if (identity.status === "removed") return identity;
    if (identity.homeKind === "system") {
      throw new Error("系统 Codex 账号只能停用，不能由 Teamline 删除");
    }
    const wasDefault = this.getDefaultExecutionIdentityId() === id;
    const wasCurrent = this.getCurrentExecutionIdentityId() === id;
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database
        .query(`
          UPDATE execution_identities
          SET identity_status = 'removed', managed_home_path = NULL,
              account_fingerprint = NULL, login_state = 'signed_out',
              capabilities_json = '[]', last_observed_at = NULL,
              updated_at = ?, removed_at = ?
          WHERE id = ?
        `)
        .run(now, now, id);
      if (wasDefault) {
        const replacement = this.database
          .query<{ id: string }, [string]>(`
            SELECT id FROM execution_identities
            WHERE id <> ? AND identity_status = 'enabled'
            ORDER BY created_at ASC, id ASC
            LIMIT 1
          `)
          .get(id)?.id;
        if (replacement) {
          this.saveDefaultExecutionIdentityId(replacement, now);
        } else {
          this.database
            .query("DELETE FROM local_preferences WHERE key = 'default-codex-execution-identity-id'")
            .run();
        }
      }
      if (wasCurrent) {
        this.database
          .query("DELETE FROM local_preferences WHERE key = 'current-codex-execution-identity-id'")
          .run();
      }
    })();
    return this.getExecutionIdentity(id)!;
  }

  getExecutionIdentityQuotaSnapshot(
    executionIdentityId: string,
  ): ExecutionIdentityQuotaSnapshot | null {
    const row = this.database
      .query<ExecutionIdentityQuotaRow, [string]>(`
        SELECT execution_identity_id, signal_json, observed_at, updated_at
        FROM execution_identity_quota_snapshots
        WHERE execution_identity_id = ?
      `)
      .get(executionIdentityId);
    if (!row) return null;
    try {
      return {
        executionIdentityId: row.execution_identity_id,
        signal: JSON.parse(row.signal_json) as CodexResourceSignal,
        observedAt: row.observed_at,
        updatedAt: row.updated_at,
      };
    } catch {
      return null;
    }
  }

  saveExecutionIdentityQuotaSnapshot(
    executionIdentityId: string,
    signal: CodexResourceSignal,
  ): ExecutionIdentityQuotaSnapshot {
    if (!this.getExecutionIdentity(executionIdentityId)) {
      throw new Error("找不到这个 Codex 账号");
    }
    if (
      signal.source !== "codex-app-server" ||
      !Number.isFinite(Date.parse(signal.observedAt))
    ) {
      throw new Error("Codex 额度数据无效");
    }
    const now = new Date().toISOString();
    this.database
      .query(`
        INSERT INTO execution_identity_quota_snapshots (
          execution_identity_id, signal_json, observed_at, updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(execution_identity_id) DO UPDATE SET
          signal_json = excluded.signal_json,
          observed_at = excluded.observed_at,
          updated_at = excluded.updated_at
        WHERE excluded.observed_at >= execution_identity_quota_snapshots.observed_at
      `)
      .run(
        executionIdentityId,
        JSON.stringify(signal),
        signal.observedAt,
        now,
      );
    return this.getExecutionIdentityQuotaSnapshot(executionIdentityId)!;
  }

  getExecutionMapView(): "map" | "list" {
    const row = this.database
      .query<{ value: string }, []>(
        "SELECT value FROM local_preferences WHERE key = 'execution-map-view'",
      )
      .get();
    return row?.value === "list" ? "list" : "map";
  }

  saveExecutionMapView(view: "map" | "list"): "map" | "list" {
    this.database
      .query(`
        INSERT INTO local_preferences (key, value, updated_at)
        VALUES ('execution-map-view', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `)
      .run(view, new Date().toISOString());
    return view;
  }

  getNotificationSettings(): NotificationSettings {
    const rows = this.database
      .query<{ key: string; value: string }, []>(`
        SELECT key, value FROM local_preferences
        WHERE key IN ('notification-auto-run-started', 'notification-auto-run-stopped')
      `)
      .all();
    const values = new Map(rows.map((row) => [row.key, row.value]));
    return {
      autoRunStarted: values.get("notification-auto-run-started") !== "false",
      autoRunStopped: values.get("notification-auto-run-stopped") !== "false",
    };
  }

  saveNotificationSettings(settings: NotificationSettings): NotificationSettings {
    if (
      typeof settings.autoRunStarted !== "boolean" ||
      typeof settings.autoRunStopped !== "boolean"
    ) {
      throw new Error("通知设置无效");
    }
    const now = new Date().toISOString();
    const save = this.database.query(`
      INSERT INTO local_preferences (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    const transaction = this.database.transaction(() => {
      save.run("notification-auto-run-started", String(settings.autoRunStarted), now);
      save.run("notification-auto-run-stopped", String(settings.autoRunStopped), now);
    });
    transaction();
    return this.getNotificationSettings();
  }

  syncWorkOrderNotifications(): void {
    for (const workOrder of this.list()) {
      const notification = stateNotification(workOrder);
      if (notification) this.insertNotification(notification);
    }
  }

  listNotifications(limit = 50): LocalNotification[] {
    return this.database
      .query<LocalNotificationRow, [number]>(`
        SELECT id, notification_kind, work_order_id, stage_id, title, body,
               target_url, read_at, claimed_at, created_at
        FROM local_notifications
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `)
      .all(limit)
      .map(mapLocalNotificationRow);
  }

  countUnreadNotifications(): number {
    return (
      this.database
        .query<{ count: number }, []>(`
          SELECT COUNT(*) AS count FROM local_notifications WHERE read_at IS NULL
        `)
        .get()?.count ?? 0
    );
  }

  claimPendingNotifications(limit = 10): LocalNotification[] {
    const transaction = this.database.transaction(() => {
      const pending = this.database
        .query<LocalNotificationRow, [number]>(`
          SELECT id, notification_kind, work_order_id, stage_id, title, body,
                 target_url, read_at, claimed_at, created_at
          FROM local_notifications
          WHERE claimed_at IS NULL AND read_at IS NULL
          ORDER BY created_at ASC, id ASC
          LIMIT ?
        `)
        .all(limit);
      if (pending.length === 0) return [];
      const claimedAt = new Date().toISOString();
      const claim = this.database.query(`
        UPDATE local_notifications
        SET claimed_at = ?
        WHERE id = ? AND claimed_at IS NULL
      `);
      for (const row of pending) claim.run(claimedAt, row.id);
      return pending.map((row) =>
        mapLocalNotificationRow({ ...row, claimed_at: claimedAt }),
      );
    });
    return transaction();
  }

  releaseNotificationClaim(id: number): void {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("通知编号无效");
    this.database
      .query(`
        UPDATE local_notifications
        SET claimed_at = NULL
        WHERE id = ? AND read_at IS NULL
      `)
      .run(id);
  }

  markNotificationRead(id: number): void {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("通知编号无效");
    this.database
      .query(`
        UPDATE local_notifications
        SET read_at = COALESCE(read_at, ?)
        WHERE id = ?
      `)
      .run(new Date().toISOString(), id);
  }

  markWorkOrderNotificationsRead(workOrderId: string): void {
    this.database
      .query(`
        UPDATE local_notifications
        SET read_at = COALESCE(read_at, ?)
        WHERE work_order_id = ?
      `)
      .run(new Date().toISOString(), workOrderId);
  }

  recordAutoRunStarted(workOrderId: string, runNumber: number): void {
    if (!this.getNotificationSettings().autoRunStarted) return;
    const workOrder = this.get(workOrderId);
    if (!workOrder) return;
    const stage = notificationStage(workOrder, "started");
    this.insertNotification({
      dedupeKey: `auto-run-started:${workOrderId}:${runNumber}`,
      kind: "auto_run_started",
      workOrderId,
      stageId: stage?.id ?? null,
      title: "自动运行已开始",
      body: stage ? `${workOrder.title} · ${stage.outcome}` : workOrder.title,
    });
  }

  recordAutoRunStopped(workOrderId: string, runNumber: number): void {
    if (!this.getNotificationSettings().autoRunStopped) return;
    const workOrder = this.get(workOrderId);
    if (!workOrder) return;
    const stage = notificationStage(workOrder, "stopped");
    this.insertNotification({
      dedupeKey: `auto-run-stopped:${workOrderId}:${runNumber}`,
      kind: "auto_run_stopped",
      workOrderId,
      stageId: stage?.id ?? null,
      title: "自动运行已停止",
      body: `${workOrder.title} · ${workOrder.currentSummary}`,
    });
  }

  private insertNotification(notification: {
    dedupeKey: string;
    kind: LocalNotificationKind;
    workOrderId: string;
    stageId: string | null;
    title: string;
    body: string;
  }): void {
    const targetUrl = notificationTargetUrl(
      notification.workOrderId,
      notification.stageId,
    );
    this.database
      .query(`
        INSERT OR IGNORE INTO local_notifications (
          dedupe_key, notification_kind, work_order_id, stage_id,
          title, body, target_url, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        notification.dedupeKey,
        notification.kind,
        notification.workOrderId,
        notification.stageId,
        notification.title,
        notification.body,
        targetUrl,
        new Date().toISOString(),
      );
  }

  getExecutionSettings(): { maxConcurrency: number } {
    const row = this.database
      .query<{ max_concurrency: number }, []>(
        "SELECT max_concurrency FROM execution_settings WHERE singleton = 1",
      )
      .get();
    return { maxConcurrency: row?.max_concurrency ?? 2 };
  }

  saveMaxConcurrency(maxConcurrency: number): { maxConcurrency: number } {
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new Error("最大并发数必须是正整数");
    }
    this.database
      .query(
        "UPDATE execution_settings SET max_concurrency = ? WHERE singleton = 1",
      )
      .run(maxConcurrency);
    return this.getExecutionSettings();
  }

  saveResourcePlan(
    id: string,
    input: {
      priority: WorkOrderPriority;
      pace: WorkOrderPace;
      runWhenQuotaAvailable: boolean;
    },
  ): WorkOrder {
    const workOrder = this.get(id);
    if (!workOrder) throw new Error("找不到这个目标");
    if (workOrder.status === "delivered") {
      throw new PlanLockedError("已完成目标不能修改资源设置");
    }
    const resourcePlan = updatedResourcePlan(workOrder, input);
    const now = new Date().toISOString();
    this.database
      .query(`
        UPDATE work_orders
        SET resource_plan_json = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(JSON.stringify(resourcePlan), now, id);
    return this.get(id)!;
  }

  saveTargetResourceSettings(
    id: string,
    input: {
      priority: WorkOrderPriority;
      pace: WorkOrderPace;
      runWhenQuotaAvailable: boolean;
      maxRunMinutes?: number;
    },
  ): WorkOrder {
    const workOrder = this.get(id);
    if (!workOrder) throw new Error("找不到这个目标");
    if (workOrder.status === "delivered") {
      throw new PlanLockedError("已完成目标不能修改资源设置");
    }
    if (
      input.maxRunMinutes !== undefined &&
      (workOrder.runStatus !== null || workOrder.status !== "ready")
    ) {
      throw new PlanLockedError("只能在待运行时修改单轮运行上限");
    }
    if (
      input.maxRunMinutes !== undefined &&
      ![30, 60, 120, 240].includes(input.maxRunMinutes)
    ) {
      throw new Error("请选择有效的最长运行时间");
    }
    const resourcePlan = updatedResourcePlan(workOrder, input);
    const now = new Date().toISOString();
    this.database
      .query(`
        UPDATE work_orders
        SET resource_plan_json = ?, max_run_minutes = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        JSON.stringify(resourcePlan),
        input.maxRunMinutes ?? workOrder.maxRunMinutes,
        now,
        id,
      );
    return this.get(id)!;
  }

  saveAutoRunReason(id: string, reason: string | null): WorkOrder {
    const workOrder = this.get(id);
    if (!workOrder) throw new Error("找不到这个目标");
    const resourcePlan = {
      ...workOrder.resourcePlan,
      autoRunReason: workOrder.resourcePlan.runWhenQuotaAvailable ? reason : null,
    };
    const now = new Date().toISOString();
    this.database
      .query(`
        UPDATE work_orders
        SET resource_plan_json = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(JSON.stringify(resourcePlan), now, id);
    return this.get(id)!;
  }

  saveSchedulingWaitReason(id: string, reason: string): WorkOrder {
    const workOrder = this.get(id);
    if (!workOrder) throw new Error("找不到这个目标");
    const nextStage = workOrder.plan ? nextRunnableCodexStage(workOrder.plan) : null;
    const plan = workOrder.plan && nextStage
      ? {
          ...workOrder.plan,
          stages: workOrder.plan.stages.map((stage) =>
            stage.id === nextStage.id ? { ...stage, statusReason: reason } : stage
          ),
        }
      : workOrder.plan;
    const resourcePlan = {
      ...workOrder.resourcePlan,
      autoRunReason: workOrder.resourcePlan.runWhenQuotaAvailable ? reason : null,
    };
    const now = new Date().toISOString();
    this.database
      .query(`
        UPDATE work_orders
        SET plan_json = ?, resource_plan_json = ?, current_summary = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        plan ? JSON.stringify(plan) : null,
        JSON.stringify(resourcePlan),
        reason,
        now,
        id,
      );
    return this.get(id)!;
  }

  activeRunIds(): string[] {
    return this.database
      .query<{ id: string }, []>(
        "SELECT id FROM work_orders WHERE run_status IN ('running', 'stopping', 'verifying')",
      )
      .all()
      .map((row) => row.id);
  }

  create(input: CreateWorkOrderInput): WorkOrder {
    const workOrder = createWorkOrder(input);
    const sourceIdentityIds = new Set(
      workOrder.sourceSessions
        .map((source) => source.executionIdentityId)
        .filter((identityId): identityId is string => Boolean(identityId)),
    );
    if (sourceIdentityIds.size > 1) {
      throw new Error("一个目标的来源会话必须来自同一个 Codex 账号");
    }
    const sourceIdentityId = [...sourceIdentityIds][0] ?? null;
    if (
      workOrder.executionIdentityId &&
      sourceIdentityId &&
      workOrder.executionIdentityId !== sourceIdentityId
    ) {
      throw new Error("目标账号与来源会话账号不匹配");
    }
    if (sourceIdentityId && !this.getExecutionIdentity(sourceIdentityId)) {
      throw new Error("找不到来源会话对应的 Codex 账号");
    }
    workOrder.executionIdentityId ??= sourceIdentityId;
    if (workOrder.projectId && !this.getProject(workOrder.projectId)) {
      throw new Error("找不到所选项目");
    }
    const occupiedSource = workOrder.sourceSessions.find((source) =>
      this.list().some((existing) =>
        existing.sourceSessions.some(
          (candidate) => candidate.kind === source.kind && candidate.id === source.id,
        ),
      ),
    );
    if (occupiedSource) {
      throw new Error(`来源会话 ${occupiedSource.id} 已属于另一个目标`);
    }
    this.database
      .query(`
        INSERT INTO work_orders (
          id, title, project_id, project_materials_confirmed,
          repository_path, workspace_kind, materials_json,
          source_sessions_json, import_source_json, import_context_json,
          execution_identity_id, goal, acceptance, status, current_summary,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        workOrder.id,
        workOrder.title,
        workOrder.projectId,
        workOrder.projectMaterialSelectionConfirmed ? 1 : 0,
        workOrder.repositoryPath,
        workOrder.workspace?.kind ?? null,
        JSON.stringify(workOrder.materials),
        JSON.stringify(workOrder.sourceSessions),
        workOrder.importSource ? JSON.stringify(workOrder.importSource) : null,
        workOrder.importContext ? JSON.stringify(workOrder.importContext) : null,
        workOrder.executionIdentityId,
        workOrder.goal,
        workOrder.acceptance,
        workOrder.status,
        workOrder.currentSummary,
        workOrder.createdAt,
        workOrder.updatedAt,
      );

    return workOrder;
  }

  applySessionOrganization(
    id: string,
    input: {
      description: string;
      summary: string;
      currentState: string;
      historicalStages: WorkOrderImportContext["historicalStages"];
      artifacts: PlanReference[];
    },
    observedSources: WorkOrderImportSource[],
  ): WorkOrder {
    const workOrder = this.get(id);
    if (!workOrder?.importContext || workOrder.sourceSessions.length === 0) {
      throw new Error("这个目标没有可整理的来源会话");
    }
    const expectedIds = workOrder.sourceSessions.map(sourceKey).sort();
    const observedIds = observedSources.map(sourceKey).sort();
    if (JSON.stringify(expectedIds) !== JSON.stringify(observedIds)) {
      throw new Error("来源会话已经变化，请刷新后重试");
    }
    const description = input.description.trim();
    const summary = input.summary.trim();
    const currentState = input.currentState.trim();
    if (!description || !summary || !currentState) {
      throw new Error("Codex 返回的会话整理结果不完整");
    }
    const historicalStages = normalizeImportedHistoricalStages(
      input.historicalStages,
      new Set(workOrder.sourceSessions.map((source) => source.id)),
    );
    const artifacts = normalizeReferences(input.artifacts);
    const now = new Date().toISOString();
    const sources = observedSources.map((source) => ({
      ...source,
      lastActiveAt: new Date(source.lastActiveAt).toISOString(),
      lastReadAt: now,
    }));
    const importContext: WorkOrderImportContext = {
      status: "ready",
      summary,
      currentState,
      historicalStages,
      artifacts,
      organizedAt: now,
      error: null,
    };
    this.database
      .query(`
        UPDATE work_orders
        SET goal = ?, source_sessions_json = ?, import_source_json = ?,
            import_context_json = ?, current_summary = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        description,
        JSON.stringify(sources),
        JSON.stringify(sources[0] ?? null),
        JSON.stringify(importContext),
        currentState,
        now,
        id,
      );
    return this.get(id)!;
  }

  markSessionOrganizationFailed(id: string, message: string): WorkOrder {
    const workOrder = this.get(id);
    if (!workOrder?.importContext || workOrder.sourceSessions.length === 0) {
      throw new Error("这个目标没有可整理的来源会话");
    }
    const error = message.trim() || "Codex 暂时无法整理会话";
    const importContext: WorkOrderImportContext = workOrder.importContext.status === "ready"
      ? { ...workOrder.importContext, error }
      : {
          status: "failed",
          summary: null,
          currentState: null,
          historicalStages: [],
          artifacts: [],
          organizedAt: null,
          error,
        };
    const now = new Date().toISOString();
    this.database
      .query(`
        UPDATE work_orders
        SET import_context_json = ?, current_summary = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        JSON.stringify(importContext),
        workOrder.importContext.status === "ready"
          ? workOrder.currentSummary
          : "来源会话尚未整理",
        now,
        id,
      );
    return this.get(id)!;
  }

  getProject(id: string): Project | null {
    const row = this.database
      .query<ProjectRow, [string]>("SELECT * FROM projects WHERE id = ?")
      .get(id);
    return row
      ? {
          id: row.id,
          name: row.name,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : null;
  }

  saveClarification(
    id: string,
    questions: ClarificationQuestion[],
    requiresPlanConfirmation = false,
    pendingReply?: string,
    allowReview = false,
  ): WorkOrder {
    const workOrder = this.get(id);
    if (!workOrder) throw new Error("找不到这个目标");
    if (
      (!allowReview && workOrder.runStatus !== null) ||
      (allowReview && ![null, "completed"].includes(workOrder.runStatus)) ||
      !["draft", "ready", ...(allowReview ? ["review"] : [])].includes(workOrder.status)
    ) {
      throw new PlanLockedError("目标开始执行后不能直接修改计划");
    }
    const normalized = normalizeClarificationQuestions(questions);
    if (normalized.length === 0) throw new Error("澄清问题不能为空");
    const now = new Date().toISOString();
    const clarification: WorkOrderClarification = {
      questions: normalized,
      requiresPlanConfirmation,
      createdAt: now,
    };
    this.database.transaction(() => {
      if (pendingReply) {
        this.appendConversation(id, {
          role: "user",
          kind: "reply",
          content: pendingReply,
          stageId: null,
          decisionTarget: workOrder.pendingClarification?.questions[0]?.target ?? "plan",
          requiresPlanConfirmation,
        }, now);
      }
      this.database
        .query(`
          UPDATE work_orders
          SET clarification_json = ?, plan_json = ?,
              revision_note = COALESCE(?, revision_note),
              run_status = CASE WHEN ? THEN NULL ELSE run_status END,
              status = 'draft', current_summary = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(
          JSON.stringify(clarification),
          workOrder.plan
            ? JSON.stringify({
                ...workOrder.plan,
                ...(allowReview ? { confirmationRequired: true } : {}),
                updatedAt: now,
              })
            : null,
          allowReview ? pendingReply?.trim() || null : null,
          allowReview ? 1 : 0,
          normalized.length === 1 ? "需要补充一项关键信息" : `需要补充 ${normalized.length} 项关键信息`,
          now,
          id,
        );
      for (const question of normalized) {
        this.appendConversation(id, {
          role: "teamline",
          kind: "question",
          content: question.prompt,
          stageId: null,
          decisionTarget: question.target,
          requiresPlanConfirmation,
        }, now);
      }
    })();
    return this.get(id)!;
  }

  addStageSupplement(id: string, stageId: string, content: string): WorkOrder {
    const workOrder = this.get(id);
    const note = content.trim();
    if (!workOrder?.plan) throw new Error("请先生成执行计划");
    if (!note) throw new Error("请填写补充内容");
    if (workOrder.runStatus !== null || !["draft", "ready"].includes(workOrder.status)) {
      throw new PlanLockedError("当前状态不能补充节点上下文");
    }
    const stage = workOrder.plan.stages.find((candidate) => candidate.id === stageId);
    if (!stage) throw new Error("找不到当前节点");
    const now = new Date().toISOString();
    const plan: WorkOrderPlan = {
      ...workOrder.plan,
      updatedAt: now,
      stages: workOrder.plan.stages.map((candidate) =>
        candidate.id === stageId
          ? { ...candidate, contextNotes: [...(candidate.contextNotes ?? []), note] }
          : candidate,
      ),
    };
    this.database.transaction(() => {
      this.database
        .query("UPDATE work_orders SET plan_json = ?, current_summary = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(plan), `已补充“${stage.outcome}”节点`, now, id);
      this.appendConversation(id, {
        role: "user",
        kind: "supplement",
        content: note,
        stageId,
        decisionTarget: "stage",
        requiresPlanConfirmation: false,
      }, now);
      this.appendConversation(id, {
        role: "teamline",
        kind: "decision",
        content: `已归入“${stage.outcome}”节点，不改变计划结构。`,
        stageId,
        decisionTarget: "stage",
        requiresPlanConfirmation: false,
      }, now);
    })();
    return this.get(id)!;
  }

  applyGeneratedPlan(
    id: string,
    generated: {
      stages: PlanStageInput[];
      goal?: string;
      acceptance?: string | null;
      materials?: Array<{ kind: WorkOrder["materials"][number]["kind"]; value: string }>;
      resourcePlan?: {
        priority: WorkOrderPriority;
        pace: WorkOrderPace;
        runWhenQuotaAvailable: boolean;
      };
      message?: string;
    },
    requiresPlanConfirmation = false,
    pendingReply?: string,
    forcePlanVersion = false,
  ): WorkOrder {
    const current = this.get(id);
    if (!current) throw new Error("找不到这个目标");
    const clarificationTargets = new Set(
      current.pendingClarification?.questions.map((question) => question.target) ?? [],
    );
    const canUpdateGoal =
      requiresPlanConfirmation ||
      clarificationTargets.has("goal") ||
      clarificationTargets.has("acceptance") ||
      clarificationTargets.has("plan");
    const goal = canUpdateGoal
      ? publicPlanningText(generated.goal?.trim() || current.goal)
      : current.goal;
    const title = current.title;
    const acceptance = !canUpdateGoal || generated.acceptance === undefined
      ? current.acceptance
      : generated.acceptance?.trim()
        ? publicPlanningText(generated.acceptance.trim())
        : null;
    const canUpdateMaterials = Boolean(pendingReply) && clarificationTargets.has("materials");
    const materials = !canUpdateMaterials || generated.materials === undefined
      ? current.materials
      : normalizeMaterialInputs(generated.materials).map((material) => {
          const selectedProjectMaterial = current.materials.find(
            (candidate) =>
              candidate.projectMaterialId &&
              candidate.kind === material.kind &&
              candidate.value === material.value,
          );
          return {
            id: crypto.randomUUID(),
            ...material,
            ...(selectedProjectMaterial?.projectMaterialId
              ? { projectMaterialId: selectedProjectMaterial.projectMaterialId }
              : {}),
          };
        });
    const canUpdateResources = Boolean(pendingReply) && clarificationTargets.has("resources");
    const resourcePlan = canUpdateResources && generated.resourcePlan
      ? {
          ...current.resourcePlan,
          priority: generated.resourcePlan.priority,
          pace: generated.resourcePlan.pace,
          // Auto-run remains an explicit switch; planning text never grants execution.
          runWhenQuotaAvailable: current.resourcePlan.runWhenQuotaAvailable,
        }
      : current.resourcePlan;
    validateResourcePlan(resourcePlan);
    const stages = inheritStableStageContext(
      current.plan,
      sanitizeGeneratedStages(generated.stages),
    );
    const continuingRevision =
      current.pendingClarification?.requiresPlanConfirmation === true &&
      Boolean(current.revisionNote) &&
      current.result !== null &&
      current.result.planVersion === current.plan?.version;
    const forceNewPlanVersion = forcePlanVersion || continuingRevision;
    const structuralChange =
      forceNewPlanVersion ||
      current.plan === null ||
      planStructureChanged(current, stages, goal, acceptance);
    const now = new Date().toISOString();
    this.database.transaction(() => {
      if (pendingReply) {
        this.appendConversation(id, {
          role: "user",
          kind: "reply",
          content: pendingReply,
          stageId: null,
          decisionTarget: current.pendingClarification?.questions[0]?.target ?? "plan",
          requiresPlanConfirmation,
        }, now);
      }
      this.database
        .query(`
          UPDATE work_orders
          SET title = ?, goal = ?, acceptance = ?, materials_json = ?, resource_plan_json = ?,
              clarification_json = NULL, revision_note = COALESCE(?, revision_note),
              run_status = CASE WHEN ? THEN NULL ELSE run_status END,
              status = ?, current_summary = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(
          title,
          goal,
          acceptance,
          JSON.stringify(materials),
          JSON.stringify({
            priority: resourcePlan.priority,
            pace: resourcePlan.pace,
            runWhenQuotaAvailable: resourcePlan.runWhenQuotaAvailable,
            autoRunReason: resourcePlan.runWhenQuotaAvailable
              ? current.resourcePlan.autoRunReason
              : null,
          }),
          forcePlanVersion && !continuingRevision ? pendingReply?.trim() || null : null,
          forceNewPlanVersion ? 1 : 0,
          forceNewPlanVersion ? "ready" : structuralChange ? current.status : "ready",
          structuralChange
            ? forceNewPlanVersion
              ? "正在保存后续计划"
              : current.currentSummary
            : canUpdateResources
              ? "资源偏好已更新"
              : "目标上下文已更新",
          now,
          id,
        );
      if (structuralChange) {
        this.savePlan(id, stages, { confirmationRequired: true });
      }
      this.appendConversation(id, {
        role: "teamline",
        kind: "decision",
        content: structuralChange
          ? publicPlanningText(generated.message?.trim() || "计划已更新，请重新确认后再启动。")
          : canUpdateResources
            ? "资源偏好已更新，不改变计划版本。"
            : "目标上下文已更新，不改变计划版本。",
        stageId: null,
        decisionTarget: structuralChange
          ? "plan"
          : canUpdateResources
            ? "resources"
            : canUpdateMaterials
              ? "materials"
              : "plan",
        requiresPlanConfirmation: structuralChange,
      });
    })();
    return this.get(id)!;
  }

  savePlan(
    id: string,
    stages: PlanStageInput[],
    options: { confirmationRequired?: boolean } = {},
  ): WorkOrder {
    const workOrder = this.get(id);
    if (!workOrder) {
      throw new Error("找不到这个目标");
    }
    if (
      workOrder.runStatus !== null ||
      !["draft", "ready"].includes(workOrder.status)
    ) {
      throw new PlanLockedError("目标开始执行后不能直接修改计划");
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

    const stageIds = stages.map((stage) =>
      typeof stage.id === "string" && stage.id.trim()
        ? stage.id.trim()
        : crypto.randomUUID(),
    );
    if (new Set(stageIds).size !== stageIds.length) {
      throw new Error("计划节点标识不能重复");
    }
    const validStageIds = new Set(stageIds);
    const expectedWorkspace = planWorkspaceFor(workOrder.workspace);
    const normalizedStages = stages.map((stage, index) => {
      const dependsOn = normalizeDependencies(stage.dependsOn);
      const executionMethod = normalizeExecutionMethod(stage.executionMethod);
      const workspace =
        executionMethod === "external"
          ? ({ kind: "external", path: null } as const)
          : normalizeWorkspace(stage.workspace, expectedWorkspace);
      if (
        dependsOn.includes(stageIds[index]!) ||
        dependsOn.some((dependencyId) => !validStageIds.has(dependencyId))
      ) {
        throw new Error("计划节点依赖无效");
      }
      if (
        executionMethod === "codex" &&
        (workspace.kind !== expectedWorkspace.kind ||
          workspace.path !== expectedWorkspace.path)
      ) {
        throw new Error("计划节点必须使用当前目标选择的执行工作空间");
      }
      return {
        id: stageIds[index]!,
        outcome: stage.outcome.trim(),
        scope: stage.scope.trim(),
        verification: stage.verification.trim(),
        ...(executionMethod === "codex" &&
        typeof stage.verificationCommand === "string" &&
        stage.verificationCommand.trim()
          ? { verificationCommand: stage.verificationCommand.trim() }
          : {}),
        dependsOn,
        executionMethod,
        workspace,
        materials: normalizeReferences(stage.materials),
        artifacts: normalizeReferences(stage.artifacts),
        ...(normalizeContextNotes(stage.contextNotes).length
          ? { contextNotes: normalizeContextNotes(stage.contextNotes) }
          : {}),
        status: executionMethod === "external" && dependsOn.length === 0
          ? ("response" as const)
          : executionMethod === "external"
            ? ("queued" as const)
            : ("planning" as const),
        statusReason: executionMethod === "external"
          ? dependsOn.length === 0
            ? "等待你在外部完成并标记"
            : "等待前置节点完成"
          : "等待确认并启动",
      };
    });

    if (
      normalizedStages.some(
        (stage) => !stage.outcome || !stage.scope || !stage.verification,
      )
    ) {
      throw new Error("计划内容不完整，请检查每个阶段");
    }
    if (hasDependencyCycle(normalizedStages)) {
      throw new Error("计划节点依赖不能形成循环");
    }

    const now = new Date().toISOString();
    const plan: WorkOrderPlan = {
      version: (workOrder.plan?.version ?? 0) + 1,
      stages: normalizedStages,
      ...(options.confirmationRequired ? { confirmationRequired: true } : {}),
      updatedAt: now,
    };

    this.database
      .query(`
        UPDATE work_orders
        SET plan_json = ?, clarification_json = NULL, status = ?, current_summary = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(JSON.stringify(plan), "ready", "计划等待确认", now, id);

    return this.get(id)!;
  }

  completeExternalStage(
    id: string,
    stageId: string,
    input: {
      conclusion?: string;
      reference?: { type: "file" | "link"; label?: string; location: string };
    },
  ): WorkOrder {
    const workOrder = this.get(id);
    if (!workOrder?.plan) throw new Error("找不到可更新的执行计划");
    if (
      workOrder.runStatus !== null ||
      (workOrder.status !== "ready" && workOrder.status !== "interrupted")
    ) {
      throw new PlanLockedError("当前状态不能标记外部节点完成");
    }
    const stage = workOrder.plan.stages.find((candidate) => candidate.id === stageId);
    if (!stage) throw new Error("找不到这个计划节点");
    if (stage.executionMethod !== "external") {
      throw new Error("只有外部工作节点可以这样完成");
    }
    if (stage.status === "completed") throw new Error("这个外部节点已经完成");

    const completedIds = new Set(
      workOrder.plan.stages
        .filter((candidate) => candidate.status === "completed")
        .map((candidate) => candidate.id),
    );
    if (!stage.dependsOn.every((dependencyId) => completedIds.has(dependencyId))) {
      throw new Error("请先完成这个节点的前置工作");
    }

    const conclusion = input.conclusion?.trim() || null;
    const reference = normalizeExternalCompletionReference(input.reference);
    if (!conclusion && !reference) {
      throw new Error("请填写简短结论，或添加本地文件或外部链接");
    }

    const now = new Date().toISOString();
    completedIds.add(stageId);
    const nextPlan: WorkOrderPlan = {
      ...workOrder.plan,
      updatedAt: now,
      stages: workOrder.plan.stages.map((candidate) => {
        if (candidate.id === stageId) {
          return {
            ...candidate,
            artifacts: reference ? [...candidate.artifacts, reference] : candidate.artifacts,
            externalResult: { conclusion, completedAt: now },
            status: "completed" as const,
            statusReason: "已由你标记完成",
          };
        }
        if (candidate.status === "completed") return candidate;
        const dependenciesReady = candidate.dependsOn.every((dependencyId) =>
          completedIds.has(dependencyId),
        );
        if (candidate.executionMethod === "external") {
          return {
            ...candidate,
            status: dependenciesReady ? ("response" as const) : ("queued" as const),
            statusReason: dependenciesReady
              ? "等待你在外部完成并标记"
              : "等待前置节点完成",
          };
        }
        if (candidate.status === "response") return candidate;
        return {
          ...candidate,
          status: dependenciesReady ? ("planning" as const) : ("queued" as const),
          statusReason: dependenciesReady
            ? "前置节点已完成，可以启动 Codex"
            : "等待前置节点完成",
        };
      }),
    };
    const allCompleted = nextPlan.stages.every((candidate) => candidate.status === "completed");
    const nextStage = nextRunnableStage(nextPlan);
    const summary = allCompleted
      ? "全部节点已完成，等待验收"
      : nextPlanSummary(nextPlan);
    this.database
      .query(`
        UPDATE work_orders
        SET plan_json = ?, status = ?, current_summary = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        JSON.stringify(nextPlan),
        allCompleted
          ? "review"
          : nextStage?.executionMethod === "external"
            ? "interrupted"
            : nextStage?.executionMethod === "codex"
              ? "ready"
              : "review",
        summary,
        now,
        id,
      );
    this.appendTimelineEvent(id, {
      category: "lifecycle",
      message: `“${stage.outcome}”已由你标记完成`,
      stageId,
      detail: conclusion,
      createdAt: now,
    });
    return this.get(id)!;
  }

  saveMaxRunMinutes(id: string, maxRunMinutes: number): WorkOrder {
    const workOrder = this.get(id);
    if (
      !workOrder ||
      workOrder.runStatus !== null ||
      workOrder.status !== "ready"
    ) {
      throw new PlanLockedError("只能在启动前修改最长运行时间");
    }
    if (![30, 60, 120, 240].includes(maxRunMinutes)) {
      throw new Error("请选择有效的最长运行时间");
    }

    const now = new Date().toISOString();
    this.database
      .query(`
        UPDATE work_orders
        SET max_run_minutes = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(maxRunMinutes, now, id);
    return this.get(id)!;
  }

  saveWorkspace(
    id: string,
    workspace: { kind: "git" | "directory"; path: string },
  ): WorkOrder {
    const workOrder = this.get(id);
    if (!workOrder) throw new Error("找不到这个目标");
    if (workOrder.runStatus !== null || !["draft", "ready"].includes(workOrder.status)) {
      throw new PlanLockedError("目标开始执行后不能更换工作空间");
    }
    const now = new Date().toISOString();
    const plan = workOrder.plan
      ? syncPlanWorkspace(workOrder.plan, workspace, now)
      : null;
    this.database
      .query(`
        UPDATE work_orders
        SET repository_path = ?, workspace_kind = ?, worktree_path = NULL,
            execution_branch = NULL, base_commit = NULL, plan_json = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(workspace.path, workspace.kind, plan ? JSON.stringify(plan) : null, now, id);
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

  saveDirectWorkspace(id: string, path: string): WorkOrder {
    const now = new Date().toISOString();
    this.database
      .query(`
        UPDATE work_orders
        SET worktree_path = ?, execution_branch = NULL, base_commit = NULL, updated_at = ?
        WHERE id = ?
      `)
      .run(path, now, id);
    return this.get(id)!;
  }

  markStarted(id: string): WorkOrder {
    return this.markCodexStageStarted(id, true);
  }

  markNextStageStarted(id: string): WorkOrder {
    return this.markCodexStageStarted(id, false);
  }

  private markCodexStageStarted(id: string, resetSession: boolean): WorkOrder {
    const workOrder = this.get(id);
    if (!workOrder?.plan) throw new Error("找不到可执行的目标计划");
    const nextStage = nextRunnableCodexStage(workOrder.plan);
    if (!nextStage) throw new Error("当前没有可以启动的 Codex 节点");
    const confirmedPlan = {
      ...workOrder.plan,
      confirmationRequired: false,
      stages: workOrder.plan.stages.map((stage) => {
        if (stage.id === nextStage.id) {
          return { ...stage, status: "running" as const, statusReason: "Codex 执行中" };
        }
        if (stage.executionMethod === "codex" && stage.status === "planning") {
          return {
            ...stage,
            status: "queued" as const,
            statusReason: stage.dependsOn.length
              ? "等待当前执行的前置节点"
              : "等待 Codex 推进",
          };
        }
        return stage;
      }),
    };
    const now = new Date().toISOString();
    this.database
      .query(`
        UPDATE work_orders
        SET status = 'running', current_summary = 'Codex 已启动', plan_json = ?,
            run_status = 'running', session_id = ${resetSession ? "NULL" : "session_id"},
            session_identity_id = ${resetSession ? "NULL" : "session_identity_id"},
            run_pid = NULL,
            run_number = run_number + 1,
            run_started_at = ?, run_ended_at = NULL, runtime_updated_at = ?,
            last_error = NULL, updated_at = ?
        WHERE id = ?
      `)
      .run(JSON.stringify(confirmedPlan), now, now, now, id);
    this.appendTimelineEvent(id, {
      category: "lifecycle",
      message: `开始“${nextStage.outcome}”`,
      stageId: nextStage.id,
      createdAt: now,
    });
    return this.get(id)!;
  }

  markContinued(id: string, summary = "正在继续 Codex"): WorkOrder {
    const now = new Date().toISOString();
    this.database
      .query(`
        UPDATE work_orders
        SET status = 'running', current_summary = ?,
            run_status = 'running', run_number = run_number + 1,
            run_pid = NULL,
            run_started_at = ?, run_ended_at = NULL, runtime_updated_at = ?,
            last_error = NULL, updated_at = ?
        WHERE id = ?
      `)
      .run(summary, now, now, now, id);
    return this.get(id)!;
  }

  markReexecuted(id: string): WorkOrder {
    const workOrder = this.get(id);
    if (!workOrder?.plan) throw new Error("找不到可重新执行的目标计划");
    const completed = new Set(
      workOrder.plan.stages
        .filter((stage) => stage.status === "completed")
        .map((stage) => stage.id),
    );
    const target = workOrder.plan.stages.find(
      (stage) =>
        stage.executionMethod === "codex" &&
        (stage.status === "response" || stage.status === "planning" || stage.status === "running") &&
        stage.dependsOn.every((dependencyId) => completed.has(dependencyId)),
    );
    if (!target) throw new Error("当前没有可以重新执行的 Codex 节点");
    const plan: WorkOrderPlan = {
      ...workOrder.plan,
      stages: workOrder.plan.stages.map((stage) =>
        stage.id === target.id
          ? { ...stage, status: "running" as const, statusReason: "Codex 执行中" }
          : stage,
      ),
    };
    const now = new Date().toISOString();
    this.database
      .query(`
        UPDATE work_orders
        SET status = 'running', current_summary = '正在从最近阶段重新执行',
            run_status = 'running', run_number = run_number + 1,
            session_id = NULL, session_identity_id = NULL, run_pid = NULL, plan_json = ?,
            run_started_at = ?, run_ended_at = NULL, runtime_updated_at = ?,
            last_error = NULL, updated_at = ?
        WHERE id = ?
      `)
      .run(JSON.stringify(plan), now, now, now, id);
    return this.get(id)!;
  }

  recordStartFailure(id: string, error: string, summary: string): WorkOrder {
    const workOrder = this.get(id);
    const now = new Date().toISOString();
    const plan = workOrder?.plan ? resetRunningCodexStages(workOrder.plan) : null;
    this.database
      .query(`
        UPDATE work_orders
        SET status = 'ready', current_summary = ?, run_status = NULL, plan_json = ?,
            last_error = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(summary, plan ? JSON.stringify(plan) : null, error, now, id);
    return this.get(id)!;
  }

  hasActiveRun(): boolean {
    return this.activeRunIds().length > 0;
  }

  recordRunPid(id: string, pid: number | null): void {
    const now = new Date().toISOString();
    this.database
      .query(`
        UPDATE work_orders
        SET run_pid = ?, updated_at = ?
        WHERE id = ? AND run_status IN ('running', 'stopping')
      `)
      .run(pid, now, id);
  }

  interruptActiveRunsAfterRestart(
    isProcessAlive: (pid: number) => boolean = processIsAlive,
  ): number {
    const active = this.database
      .query<{ id: string; run_pid: number | null }, []>(
        "SELECT id, run_pid FROM work_orders WHERE run_status IN ('running', 'stopping', 'verifying')",
      )
      .all();
    const message = "本地服务重启，无法继续跟踪这次运行";
    let interrupted = 0;
    for (const workOrder of active) {
      if (workOrder.run_pid !== null && isProcessAlive(workOrder.run_pid)) {
        const now = new Date().toISOString();
        this.database
          .query(`
            UPDATE work_orders
            SET status = 'running', run_status = 'running',
                current_summary = '服务重启后仍检测到 Codex 运行，但已无法控制',
                updated_at = ?
            WHERE id = ?
          `)
          .run(now, workOrder.id);
        continue;
      }
      this.recordInterrupted(workOrder.id, message);
      interrupted += 1;
    }
    return interrupted;
  }

  recordSession(id: string, sessionId: string, executionIdentityId?: string): void {
    const existing = this.get(id);
    const workOrder = existing?.executionIdentityId
      ? existing
      : this.bindExecutionIdentity(id);
    const boundIdentityId = workOrder?.executionIdentityId;
    const sessionIdentityId = executionIdentityId ?? boundIdentityId;
    if (!boundIdentityId || !sessionIdentityId || sessionIdentityId !== boundIdentityId) {
      throw new Error("Codex 会话与目标账号不匹配");
    }
    this.appendRunEvent(id, "session", "Codex 会话已连接", {
      sessionId,
      sessionIdentityId,
      summary: "Codex 会话已连接",
      category: "lifecycle",
    });
  }

  recordProgress(
    id: string,
    message: string,
    options: {
      category?: WorkOrderRunEvent["category"];
      stageId?: string | null;
      detail?: string | null;
    } = {},
  ): void {
    const category = options.category ?? "message";
    this.appendRunEvent(id, "progress", message, {
      summary: message,
      category,
      stageId: options.stageId,
      detail: options.detail,
      preserveSummary: category !== "message",
    });
  }

  private appendTimelineEvent(
    id: string,
    event: {
      category: WorkOrderRunEvent["category"];
      message: string;
      stageId?: string | null;
      detail?: string | null;
      createdAt?: string;
    },
  ): void {
    const row = this.database
      .query<{ run_number: number }, [string]>(
        "SELECT run_number FROM work_orders WHERE id = ?",
      )
      .get(id);
    if (!row) return;
    this.database
      .query(`
        INSERT INTO run_events (
          work_order_id, event_type, event_category, message, stage_id, detail_json,
          run_number, created_at
        ) VALUES (?, 'progress', ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        event.category,
        event.message,
        event.stageId ?? null,
        truncateRunDetail(event.detail),
        row.run_number,
        event.createdAt ?? new Date().toISOString(),
      );
  }

  recordStageProgress(
    id: string,
    stageId: string,
    phase: "running" | "completed",
  ): void {
    const workOrder = this.get(id);
    const stage = workOrder?.plan?.stages.find((candidate) => candidate.id === stageId);
    if (!workOrder?.plan || workOrder.runStatus !== "running" || stage?.executionMethod !== "codex") {
      return;
    }
    if (phase === "completed" && stage.status !== "running") return;
    if (
      phase === "running" &&
      (workOrder.plan.stages.some(
        (candidate) => candidate.id !== stageId && candidate.status === "running",
      ) ||
        !stage.dependsOn.every((dependencyId) => {
          const dependency = workOrder.plan!.stages.find(
            (candidate) => candidate.id === dependencyId,
          );
          return dependency?.status === "completed";
        }))
    ) {
      return;
    }
    const plan: WorkOrderPlan = {
      ...workOrder.plan,
      stages: workOrder.plan.stages.map((candidate) => {
        if (candidate.id === stageId) {
          return phase === "running"
            ? { ...candidate, status: "running" as const, statusReason: "Codex 执行中" }
            : {
                ...candidate,
                status: "completed" as const,
                statusReason: "Codex 已完成，等待验证",
              };
        }
        return candidate;
      }),
    };
    const summary = phase === "running"
      ? `Codex 正在执行“${stage.outcome}”`
      : `Codex 已完成“${stage.outcome}”`;
    const now = new Date().toISOString();
    this.database
      .query(`
        UPDATE work_orders
        SET plan_json = ?, current_summary = ?, updated_at = ?
        WHERE id = ? AND run_status = 'running'
      `)
      .run(JSON.stringify(plan), summary, now, id);
  }

  recordExit(id: string, exitCode: number, message: string): void {
    const failed = exitCode !== 0;
    this.appendRunEvent(id, "exit", message, {
      summary: message,
      ended: true,
      failed,
      category: "lifecycle",
    });
  }

  beginResultProcessing(id: string, message: string): WorkOrder {
    const row = this.database
      .query<WorkOrderRow, [string]>("SELECT * FROM work_orders WHERE id = ?")
      .get(id);
    if (!row || row.run_status !== "running") {
      throw new Error("这个目标当前不能整理结果");
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const lastUpdated = row.runtime_updated_at
      ? Date.parse(row.runtime_updated_at)
      : now.getTime();
    const runtimeMs = row.runtime_ms + Math.max(0, now.getTime() - lastUpdated);
    this.database.transaction(() => {
      this.database
        .query(`
          UPDATE work_orders
          SET status = 'running', current_summary = '正在整理代码变化并执行验证',
              run_status = 'verifying', run_ended_at = ?, run_pid = NULL,
              runtime_ms = ?, runtime_updated_at = ?, last_error = NULL, updated_at = ?
          WHERE id = ?
        `)
        .run(nowIso, runtimeMs, nowIso, nowIso, id);
      this.database
        .query(`
          INSERT INTO run_events (work_order_id, event_type, message, run_number, created_at)
          VALUES (?, 'exit', ?, ?, ?)
        `)
        .run(id, message, row.run_number, nowIso);
    })();
    return this.get(id)!;
  }

  completeReview(id: string, result: WorkOrderResult): WorkOrder {
    const workOrder = this.get(id);
    const hasConfiguredCommand = result.verifications.some(
      (verification) => verification.status !== "not_configured",
    );
    let plan = planWithVerificationStatuses(
      workOrder?.plan ?? null,
      result,
      checkpointedStageIds(workOrder),
    );
    const mergedResult = mergeResults(
      workOrder?.result ?? null,
      result,
      workOrder?.workspace?.kind === "directory",
    );
    if (plan) {
      plan = advanceAfterCodexRun(plan, result);
    }
    const needsManualConfirmation = result.verifications.some(
      (verification) => verification.status === "not_configured",
    );
    const nextStage = plan ? nextRunnableStage(plan) : undefined;
    const externalReady = nextStage?.executionMethod === "external";
    const nextCodexReady = nextStage?.executionMethod === "codex";
    const allStagesCompleted = plan?.stages.every((stage) => stage.status === "completed") === true;
    const status = needsManualConfirmation || externalReady
      ? "interrupted"
      : nextCodexReady
        ? "ready"
        : allStagesCompleted
          ? "review"
          : "interrupted";
    const runStatus = status === "review" || needsManualConfirmation ? "completed" : null;
    const now = new Date().toISOString();
    this.database
      .query(`
        UPDATE work_orders
        SET status = ?, run_status = ?, result_json = ?, plan_json = ?,
            current_summary = ?, last_error = NULL, updated_at = ?
        WHERE id = ? AND run_status = 'verifying'
      `)
      .run(
        status,
        runStatus,
        JSON.stringify(mergedResult),
        plan ? JSON.stringify(plan) : null,
        needsManualConfirmation
          ? "请确认当前 AI 节点结果后继续"
          : externalReady
          ? nextPlanSummary(plan)
          : nextCodexReady
            ? nextPlanSummary(plan)
            : hasConfiguredCommand
              ? "自动验证通过，等待人工验收"
              : "等待人工验收",
        now,
        id,
      );
    for (const verification of result.verifications) {
      this.appendTimelineEvent(id, {
        category: "lifecycle",
        message:
          verification.status === "passed"
            ? `“${verification.stageOutcome}”验证通过`
            : "等待你确认节点结果",
        stageId: verification.stageId,
      });
    }
    return this.get(id)!;
  }

  confirmCurrentCodexResults(id: string): WorkOrder {
    const workOrder = this.get(id);
    if (
      !workOrder?.plan ||
      !workOrder.result ||
      workOrder.result.planVersion !== workOrder.plan.version ||
      !(
        (workOrder.status === "review" &&
          (workOrder.runStatus === "completed" || workOrder.runStatus === null)) ||
        (workOrder.status === "interrupted" && workOrder.runStatus === "completed") ||
        (workOrder.status === "ready" && workOrder.runStatus === null)
      )
    ) {
      throw new PlanLockedError("当前没有需要确认的 AI 节点结果");
    }
    const verificationByStage = new Map(
      workOrder.result.verifications.map((verification) => [verification.stageId, verification]),
    );
    const confirmedIds = new Set(
      workOrder.plan.stages
        .filter(
          (stage) =>
            stage.executionMethod === "codex" &&
            stage.status === "response" &&
            verificationByStage.get(stage.id)?.status === "not_configured",
        )
        .map((stage) => stage.id),
    );
    if (confirmedIds.size === 0) {
      throw new PlanLockedError("当前没有需要确认的 AI 节点结果");
    }

    const now = new Date().toISOString();
    const plan = advancePlanWithCompletedStages(
      workOrder.plan,
      confirmedIds,
      "已由你确认完成",
    );
    const nextStage = nextRunnableStage(plan);
    const status = nextStage?.executionMethod === "external"
      ? "interrupted"
      : nextStage?.executionMethod === "codex"
        ? "ready"
        : "review";
    this.database
      .query(`
        UPDATE work_orders
        SET status = ?, run_status = ?, plan_json = ?, current_summary = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        status,
        status === "review" ? "completed" : null,
        JSON.stringify(plan),
        status === "review" ? "等待人工验收" : nextPlanSummary(plan),
        now,
        id,
      );
    for (const stageId of confirmedIds) {
      const stage = plan.stages.find((candidate) => candidate.id === stageId);
      this.appendTimelineEvent(id, {
        category: "lifecycle",
        message: `“${stage?.outcome ?? "当前节点"}”已由你确认完成`,
        stageId,
      });
    }
    return this.get(id)!;
  }

  recordVerificationFailure(id: string, result: WorkOrderResult): WorkOrder {
    const workOrder = this.get(id);
    const mergedResult = mergeResults(
      workOrder?.result ?? null,
      result,
      workOrder?.workspace?.kind === "directory",
    );
    const plan = planWithVerificationStatuses(
      workOrder?.plan ?? null,
      result,
      checkpointedStageIds(workOrder),
    );
    const now = new Date().toISOString();
    const error = "自动验证未通过，请查看验证结果后继续处理";
    this.database
      .query(`
        UPDATE work_orders
        SET status = 'interrupted', run_status = 'failed', result_json = ?, plan_json = ?,
            current_summary = '自动验证未通过', last_error = ?, updated_at = ?
        WHERE id = ? AND run_status = 'verifying'
      `)
      .run(JSON.stringify(mergedResult), plan ? JSON.stringify(plan) : null, error, now, id);
    for (const verification of result.verifications.filter(
      (candidate) => candidate.status === "failed",
    )) {
      this.appendTimelineEvent(id, {
        category: "lifecycle",
        message: `“${verification.stageOutcome}”验证未通过，需要处理`,
        stageId: verification.stageId,
      });
    }
    return this.get(id)!;
  }

  recordResultProcessingFailure(id: string): WorkOrder {
    const now = new Date().toISOString();
    const error = "无法整理代码变化或验证结果，请检查执行工作区后继续处理";
    this.database
      .query(`
        UPDATE work_orders
        SET status = 'interrupted', run_status = 'failed',
            current_summary = '结果整理失败', last_error = ?, updated_at = ?
        WHERE id = ? AND run_status = 'verifying'
      `)
      .run(error, now, id);
    return this.get(id)!;
  }

  confirmDelivered(id: string): WorkOrder {
    const workOrder = this.get(id);
    if (!workOrder || workOrder.status !== "review") {
      throw new Error("只有待验收的目标可以确认完成");
    }
    const plan = workOrder.plan
      ? {
          ...workOrder.plan,
          stages: workOrder.plan.stages.map((stage) => ({
            ...stage,
            status: "completed" as const,
            statusReason: "已由你确认完成",
          })),
        }
      : null;
    const now = new Date().toISOString();
    this.database
      .query(`
        UPDATE work_orders
        SET status = 'delivered', plan_json = ?, current_summary = '已由你确认完成', updated_at = ?
        WHERE id = ? AND status = 'review'
      `)
      .run(plan ? JSON.stringify(plan) : null, now, id);
    return this.get(id)!;
  }

  revise(id: string, revisionNote: string): WorkOrder {
    const workOrder = this.get(id);
    const note = revisionNote.trim();
    if (!workOrder || workOrder.status !== "review" || !workOrder.plan) {
      throw new Error("只有待验收的目标可以补充要求");
    }
    if (!note) {
      throw new Error("请填写补充要求");
    }
    const now = new Date().toISOString();
    const nextPlan: WorkOrderPlan = {
      version: workOrder.plan.version + 1,
      stages: workOrder.plan.stages.map((stage) => ({
        ...stage,
        status: "planning",
        statusReason: "等待确认并启动",
      })),
      confirmationRequired: true,
      updatedAt: now,
    };
    this.database
      .query(`
        UPDATE work_orders
        SET plan_json = ?, revision_note = ?, status = 'ready', run_status = NULL,
            run_pid = NULL, current_summary = '补充要求等待确认', last_error = NULL,
            updated_at = ?
        WHERE id = ? AND status = 'review'
      `)
      .run(JSON.stringify(nextPlan), note, now, id);
    return this.get(id)!;
  }

  markStopping(id: string, summary = "正在停止 Codex"): WorkOrder {
    const now = new Date().toISOString();
    this.database
      .query(`
        UPDATE work_orders
        SET run_status = 'stopping', current_summary = ?, updated_at = ?
        WHERE id = ? AND run_status = 'running'
      `)
      .run(summary, now, id);
    return this.get(id)!;
  }

  recordInterrupted(id: string, message = "Codex 已中断"): void {
    this.appendRunEvent(id, "exit", message, {
      summary: message,
      ended: true,
      interrupted: true,
    });
  }

  listRunEvents(id: string, limit = 200): WorkOrderRunEvent[] {
    const rows = this.database
      .query<RunEventRow, [string, number]>(`
        SELECT id, event_type, event_category, message, stage_id, detail_json,
               run_number, created_at
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
      category: row.event_category ?? legacyEventCategory(row.event_type),
      message: row.message,
      stageId: row.stage_id,
      detail: row.detail_json,
      runNumber: row.run_number,
      createdAt: row.created_at,
    }));
  }

  private appendRunEvent(
    id: string,
    type: WorkOrderRunEvent["type"],
    message: string,
    options: {
      sessionId?: string;
      sessionIdentityId?: string;
      summary: string;
      ended?: boolean;
      failed?: boolean;
      interrupted?: boolean;
      category?: WorkOrderRunEvent["category"];
      stageId?: string | null;
      detail?: string | null;
      preserveSummary?: boolean;
    },
  ): void {
    const row = this.database
      .query<WorkOrderRow, [string]>("SELECT * FROM work_orders WHERE id = ?")
      .get(id);
    if (!row || !["running", "stopping", "verifying"].includes(row.run_status ?? "")) {
      return;
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const lastUpdated = row.runtime_updated_at
      ? Date.parse(row.runtime_updated_at)
      : now.getTime();
    const runtimeMs = row.runtime_ms + Math.max(0, now.getTime() - lastUpdated);
    const status =
      options.ended && (options.failed || options.interrupted)
        ? "interrupted"
        : row.status;
    const runStatus = options.ended
      ? options.interrupted
        ? "interrupted"
        : options.failed
        ? "failed"
        : "completed"
      : row.run_status;

    this.database.transaction(() => {
      this.database
        .query(`
          UPDATE work_orders
          SET status = ?, current_summary = ?, session_id = COALESCE(?, session_id),
              session_identity_id = COALESCE(?, session_identity_id),
              session_handoff_json = CASE WHEN ? IS NULL THEN session_handoff_json ELSE NULL END,
              run_status = ?, run_ended_at = ?, run_pid = ?,
              runtime_ms = ?, runtime_updated_at = ?,
              last_error = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(
          status,
          options.preserveSummary ? row.current_summary : options.summary,
          options.sessionId ?? null,
          options.sessionIdentityId ?? null,
          options.sessionId ?? null,
          runStatus,
          options.ended ? nowIso : null,
          options.ended ? null : row.run_pid,
          runtimeMs,
          nowIso,
          options.failed ? message : null,
          nowIso,
          id,
        );
      this.database
        .query(`
          INSERT INTO run_events (
            work_order_id, event_type, event_category, message, stage_id, detail_json,
            run_number, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          id,
          type,
          options.category ?? legacyEventCategory(type),
          message,
          options.stageId ?? null,
          truncateRunDetail(options.detail),
          row.run_number,
          nowIso,
        );
    })();
  }

  private appendConversation(
    id: string,
    message: Omit<WorkOrderConversationMessage, "id" | "createdAt">,
    createdAt = new Date().toISOString(),
  ): void {
    this.database
      .query(`
        INSERT INTO work_order_conversation (
          work_order_id, role, message_kind, content, stage_id,
          decision_target, requires_plan_confirmation, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        message.role,
        message.kind,
        message.content,
        message.stageId,
        message.decisionTarget,
        message.requiresPlanConfirmation ? 1 : 0,
        createdAt,
      );
  }

  private addPlanColumnToExistingDatabase(): void {
    const columns = this.database
      .query<{ name: string }, []>("PRAGMA table_info(work_orders)")
      .all();

    if (!columns.some((column) => column.name === "plan_json")) {
      this.database.exec("ALTER TABLE work_orders ADD COLUMN plan_json TEXT");
    }
  }

  private createExecutionIdentityTable(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS execution_identities (
        id TEXT PRIMARY KEY,
        tool TEXT NOT NULL,
        label TEXT NOT NULL,
        identity_status TEXT NOT NULL,
        home_kind TEXT NOT NULL,
        managed_home_path TEXT,
        account_fingerprint TEXT,
        login_state TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        last_observed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        removed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS execution_identities_status
      ON execution_identities(tool, identity_status, created_at);
    `);
  }

  private createExecutionIdentityQuotaTable(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS execution_identity_quota_snapshots (
        execution_identity_id TEXT PRIMARY KEY,
        signal_json TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (execution_identity_id) REFERENCES execution_identities(id)
      )
    `);
  }

  private ensureDefaultExecutionIdentity(): void {
    const existing = this.database
      .query<{ id: string }, []>(`
        SELECT id FROM execution_identities
        WHERE identity_status <> 'removed'
        ORDER BY CASE identity_status WHEN 'enabled' THEN 0 ELSE 1 END,
                 created_at ASC, id ASC
        LIMIT 1
      `)
      .get()?.id;
    const now = new Date().toISOString();
    let identityId = existing;
    if (!identityId) {
      identityId = "codex-system-default";
      this.database
        .query(`
          INSERT OR IGNORE INTO execution_identities (
            id, tool, label, identity_status, home_kind, managed_home_path,
            account_fingerprint, login_state, capabilities_json,
            last_observed_at, created_at, updated_at, removed_at
          ) VALUES (?, 'codex', 'Codex', 'enabled', 'system', NULL, NULL,
                    'unknown', '[]', NULL, ?, ?, NULL)
        `)
        .run(identityId, now, now);
    }
    if (!this.getDefaultExecutionIdentityId()) {
      this.saveDefaultExecutionIdentityId(identityId, now);
    }
  }

  private saveDefaultExecutionIdentityId(id: string, updatedAt: string): void {
    this.database
      .query(`
        INSERT INTO local_preferences (key, value, updated_at)
        VALUES ('default-codex-execution-identity-id', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `)
      .run(id, updatedAt);
  }

  private requireExecutionIdentity(id: string): ExecutionIdentity {
    const identity = this.getExecutionIdentity(id);
    if (!identity) throw new Error("找不到这个 Codex 账号");
    return identity;
  }

  private requireUsableExecutionIdentity(id: string): ExecutionIdentity {
    const identity = this.requireExecutionIdentity(id);
    if (identity.status !== "enabled") throw new Error("这个 Codex 账号当前不可用");
    if (
      identity.loginState !== "ready" &&
      !(identity.homeKind === "system" && identity.loginState === "unknown")
    ) {
      throw new Error("这个 Codex 账号尚未登录");
    }
    return identity;
  }

  private addExecutionIdentityBindingColumns(): void {
    const columns = new Set(
      this.database
        .query<{ name: string }, []>("PRAGMA table_info(work_orders)")
        .all()
        .map((column) => column.name),
    );
    if (!columns.has("execution_identity_id")) {
      this.database.exec("ALTER TABLE work_orders ADD COLUMN execution_identity_id TEXT");
    }
    if (!columns.has("session_identity_id")) {
      this.database.exec("ALTER TABLE work_orders ADD COLUMN session_identity_id TEXT");
    }
    if (!columns.has("session_handoff_json")) {
      this.database.exec("ALTER TABLE work_orders ADD COLUMN session_handoff_json TEXT");
    }
    const defaultIdentityId = this.getDefaultExecutionIdentityId();
    if (defaultIdentityId) {
      this.database
        .query(`
          UPDATE work_orders
          SET execution_identity_id = ?,
              session_identity_id = CASE
                WHEN session_id IS NOT NULL THEN ?
                ELSE session_identity_id
              END
          WHERE session_id IS NOT NULL AND execution_identity_id IS NULL
        `)
        .run(defaultIdentityId, defaultIdentityId);
    }
    const systemIdentityId = this.getSystemExecutionIdentityId();
    if (systemIdentityId) {
      const imported = this.database
        .query<{
          id: string;
          source_sessions_json: string | null;
          import_source_json: string | null;
          execution_identity_id: string | null;
        }, []>(`
          SELECT id, source_sessions_json, import_source_json, execution_identity_id
          FROM work_orders
          WHERE source_sessions_json IS NOT NULL OR import_source_json IS NOT NULL
        `)
        .all();
      const save = this.database.query(`
        UPDATE work_orders
        SET source_sessions_json = ?, import_source_json = ?,
            execution_identity_id = COALESCE(execution_identity_id, ?)
        WHERE id = ?
      `);
      for (const row of imported) {
        const sources = legacyCodexSourcesWithIdentity(
          row.source_sessions_json,
          row.import_source_json,
          systemIdentityId,
        );
        if (!sources) continue;
        save.run(
          row.source_sessions_json === null
            ? null
            : JSON.stringify(sources.sourceSessions),
          sources.importSource ? JSON.stringify(sources.importSource) : null,
          systemIdentityId,
          row.id,
        );
      }
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
      ["run_pid", "INTEGER"],
      ["run_number", "INTEGER NOT NULL DEFAULT 0"],
      ["runtime_ms", "INTEGER NOT NULL DEFAULT 0"],
      ["runtime_updated_at", "TEXT"],
      ["max_run_minutes", "INTEGER NOT NULL DEFAULT 60"],
      ["last_error", "TEXT"],
    ] as const;

    for (const [name, definition] of additions) {
      if (!columns.has(name)) {
        this.database.exec(`ALTER TABLE work_orders ADD COLUMN ${name} ${definition}`);
      }
    }
  }

  private addRunEventColumnsToExistingDatabase(): void {
    const columns = new Set(
      this.database
        .query<{ name: string }, []>("PRAGMA table_info(run_events)")
        .all()
        .map((column) => column.name),
    );
    if (!columns.has("run_number")) {
      this.database.exec(
        "ALTER TABLE run_events ADD COLUMN run_number INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!columns.has("event_category")) {
      this.database.exec("ALTER TABLE run_events ADD COLUMN event_category TEXT");
    }
    if (!columns.has("stage_id")) {
      this.database.exec("ALTER TABLE run_events ADD COLUMN stage_id TEXT");
    }
    if (!columns.has("detail_json")) {
      this.database.exec("ALTER TABLE run_events ADD COLUMN detail_json TEXT");
    }
  }

  private addResultColumnsToExistingDatabase(): void {
    const columns = new Set(
      this.database
        .query<{ name: string }, []>("PRAGMA table_info(work_orders)")
        .all()
        .map((column) => column.name),
    );
    if (!columns.has("result_json")) {
      this.database.exec("ALTER TABLE work_orders ADD COLUMN result_json TEXT");
    }
    if (!columns.has("revision_note")) {
      this.database.exec("ALTER TABLE work_orders ADD COLUMN revision_note TEXT");
    }
  }

  private addMaterialColumnsToExistingDatabase(): void {
    const columns = new Set(
      this.database
        .query<{ name: string }, []>("PRAGMA table_info(work_orders)")
        .all()
        .map((column) => column.name),
    );
    if (!columns.has("workspace_kind")) {
      this.database.exec("ALTER TABLE work_orders ADD COLUMN workspace_kind TEXT");
    }
    this.database.exec(`
      UPDATE work_orders
      SET workspace_kind = 'git'
      WHERE workspace_kind IS NULL AND repository_path <> ''
    `);
    if (!columns.has("materials_json")) {
      this.database.exec("ALTER TABLE work_orders ADD COLUMN materials_json TEXT");
    }
  }

  private addResourcePlanColumnToExistingDatabase(): void {
    const columns = new Set(
      this.database
        .query<{ name: string }, []>("PRAGMA table_info(work_orders)")
        .all()
        .map((column) => column.name),
    );
    if (!columns.has("resource_plan_json")) {
      this.database.exec("ALTER TABLE work_orders ADD COLUMN resource_plan_json TEXT");
    }
  }

  private addClarificationColumnToExistingDatabase(): void {
    const columns = new Set(
      this.database
        .query<{ name: string }, []>("PRAGMA table_info(work_orders)")
        .all()
        .map((column) => column.name),
    );
    if (!columns.has("clarification_json")) {
      this.database.exec("ALTER TABLE work_orders ADD COLUMN clarification_json TEXT");
    }
  }

  private addImportSourceColumnToExistingDatabase(): void {
    const columns = new Set(
      this.database
        .query<{ name: string }, []>("PRAGMA table_info(work_orders)")
        .all()
        .map((column) => column.name),
    );
    if (!columns.has("import_source_json")) {
      this.database.exec("ALTER TABLE work_orders ADD COLUMN import_source_json TEXT");
    }
  }

  private addV2DomainColumnsToExistingDatabase(): void {
    const columns = new Set(
      this.database
        .query<{ name: string }, []>("PRAGMA table_info(work_orders)")
        .all()
        .map((column) => column.name),
    );
    if (!columns.has("project_id")) {
      this.database.exec("ALTER TABLE work_orders ADD COLUMN project_id TEXT");
    }
    if (!columns.has("project_materials_confirmed")) {
      this.database.exec(
        "ALTER TABLE work_orders ADD COLUMN project_materials_confirmed INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!columns.has("source_sessions_json")) {
      this.database.exec("ALTER TABLE work_orders ADD COLUMN source_sessions_json TEXT");
    }
    const rows = this.database
      .query<{
        id: string;
        source_sessions_json: string | null;
        import_source_json: string | null;
      }, []>(`
        SELECT id, source_sessions_json, import_source_json
        FROM work_orders
        ORDER BY created_at ASC, id ASC
      `)
      .all();
    const claimedSourceIds = new Set<string>();
    const update = this.database.query(`
      UPDATE work_orders SET source_sessions_json = ? WHERE id = ?
    `);
    this.database.transaction(() => {
      for (const row of rows) {
        const legacySource = normalizeImportSource(row.import_source_json);
        const candidates = normalizeSourceSessions(
          row.source_sessions_json,
          legacySource,
        );
        const owned = candidates.filter((source) => {
          if (claimedSourceIds.has(source.id)) return false;
          claimedSourceIds.add(source.id);
          return true;
        });
        update.run(JSON.stringify(owned), row.id);
      }
    })();
  }

  private addImportContextColumnToExistingDatabase(): void {
    const columns = new Set(
      this.database
        .query<{ name: string }, []>("PRAGMA table_info(work_orders)")
        .all()
        .map((column) => column.name),
    );
    if (!columns.has("import_context_json")) {
      this.database.exec("ALTER TABLE work_orders ADD COLUMN import_context_json TEXT");
    }
  }

  private migrateDeliveredStatus(): void {
    this.database.exec(`
      UPDATE work_orders
      SET status = 'delivered'
      WHERE status = 'completed'
    `);
  }

  private backfillLegacyRunNumbers(): void {
    this.database.exec(`
      UPDATE work_orders
      SET run_number = 1
      WHERE run_number = 0 AND run_status IS NOT NULL
    `);
    this.database.exec(`
      UPDATE run_events
      SET run_number = 1
      WHERE run_number = 0
    `);
  }
}

function mapExecutionIdentityRow(row: ExecutionIdentityRow): ExecutionIdentity {
  let capabilities: string[] = [];
  try {
    capabilities = normalizeExecutionIdentityCapabilities(
      JSON.parse(row.capabilities_json),
    );
  } catch {
    capabilities = [];
  }
  return {
    id: row.id,
    tool: row.tool,
    label: row.label,
    status: row.identity_status,
    homeKind: row.home_kind,
    managedHomePath: row.managed_home_path,
    accountFingerprint: row.account_fingerprint,
    loginState: executionIdentityLoginStates.includes(row.login_state)
      ? row.login_state
      : "unknown",
    capabilities,
    lastObservedAt: row.last_observed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    removedAt: row.removed_at,
  };
}

function normalizeExecutionIdentityLabel(value: string): string {
  const label = value.trim();
  if (!label) throw new Error("请填写账号名称");
  if (label.length > 40) throw new Error("账号名称不能超过 40 个字符");
  return label;
}

function normalizeExecutionIdentityCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((capability): capability is string => typeof capability === "string")
        .map((capability) => capability.trim())
        .filter(Boolean),
    ),
  ].sort();
}

function stateNotification(workOrder: WorkOrder): {
  dedupeKey: string;
  kind: LocalNotificationKind;
  workOrderId: string;
  stageId: string | null;
  title: string;
  body: string;
} | null {
  if (workOrder.status === "delivered") {
    const stage = workOrder.plan?.stages.at(-1) ?? null;
    return {
      dedupeKey: `completed:${workOrder.id}:delivered`,
      kind: "completed",
      workOrderId: workOrder.id,
      stageId: stage?.id ?? null,
      title: "目标已完成",
      body: workOrder.title,
    };
  }

  const externalStage = workOrder.plan?.stages.find(
    (stage) => stage.executionMethod === "external" && stage.status === "response",
  );
  if (workOrder.status === "ready" && externalStage) {
    return {
      dedupeKey: `response:${workOrder.id}:external:${externalStage.id}`,
      kind: "response",
      workOrderId: workOrder.id,
      stageId: externalStage.id,
      title: "目标需要处理",
      body: `${workOrder.title} · ${externalStage.outcome}`,
    };
  }

  if (workOrder.status === "review") {
    const stage =
      workOrder.plan?.stages.find((candidate) => candidate.status === "response") ??
      workOrder.plan?.stages.at(-1) ??
      null;
    const resultKey = workOrder.result?.completedAt ?? workOrder.plan?.version ?? 0;
    return {
      dedupeKey: `response:${workOrder.id}:review:${resultKey}`,
      kind: "review",
      workOrderId: workOrder.id,
      stageId: stage?.id ?? null,
      title: "目标等待验收",
      body: workOrder.title,
    };
  }

  if (workOrder.status === "interrupted") {
    const stage = notificationStage(workOrder, "stopped");
    return {
      dedupeKey: `response:${workOrder.id}:interrupted:${workOrder.runNumber}`,
      kind: "response",
      workOrderId: workOrder.id,
      stageId: stage?.id ?? null,
      title: "目标需要处理",
      body: `${workOrder.title} · ${workOrder.currentSummary}`,
    };
  }
  return null;
}

function notificationStage(
  workOrder: WorkOrder,
  event: "started" | "stopped",
): PlanStage | null {
  const stages = workOrder.plan?.stages ?? [];
  if (event === "started") {
    return (
      stages.find((stage) => stage.status === "running") ??
      stages.find(
        (stage) =>
          stage.executionMethod === "codex" &&
          (stage.status === "planning" || stage.status === "response"),
      ) ??
      null
    );
  }
  return (
    stages.find((stage) => stage.status === "response") ??
    stages.find((stage) => stage.status === "running") ??
    stages.find((stage) => stage.status === "planning") ??
    stages.at(-1) ??
    null
  );
}

function notificationTargetUrl(workOrderId: string, stageId: string | null): string {
  const path = `/goals/${encodeURIComponent(workOrderId)}`;
  return stageId ? `${path}?stage=${encodeURIComponent(stageId)}` : path;
}

function mapLocalNotificationRow(row: LocalNotificationRow): LocalNotification {
  return {
    id: row.id,
    kind: row.notification_kind,
    workOrderId: row.work_order_id,
    stageId: row.stage_id,
    title: row.title,
    body: row.body,
    targetUrl: row.target_url,
    readAt: row.read_at,
    claimedAt: row.claimed_at,
    createdAt: row.created_at,
  };
}

function mapRow(
  row: WorkOrderRow,
  checkpoints: WorkOrderCheckpoint[] = [],
  conversation: WorkOrderConversationMessage[] = [],
): WorkOrder {
  const status = row.status === "completed" ? "delivered" : row.status;
  const storedPlan = row.plan_json
    ? normalizeStoredPlan(
        JSON.parse(row.plan_json),
        row.workspace_kind
          ? { kind: row.workspace_kind, path: row.repository_path }
          : null,
      )
    : null;
  const plan = status === "delivered" && storedPlan
    ? advancePlanWithCompletedStages(
        storedPlan,
        new Set(storedPlan.stages.map((stage) => stage.id)),
        "已由你确认完成",
      )
    : storedPlan;
  const importSource = normalizeImportSource(row.import_source_json);
  const sourceSessions = normalizeSourceSessions(
    row.source_sessions_json,
    importSource,
  );
  return {
    id: row.id,
    name: row.title,
    description: row.goal,
    projectId: row.project_id,
    projectMaterialSelectionConfirmed: row.project_materials_confirmed === 1,
    title: row.title,
    repositoryPath: row.repository_path,
    workspace: row.workspace_kind
      ? { kind: row.workspace_kind, path: row.repository_path }
      : null,
    materials: row.materials_json ? JSON.parse(row.materials_json) : [],
    sourceSessions,
    importContext: normalizeImportContext(row.import_context_json),
    currentSessionId: row.session_id,
    executionIdentityId: row.execution_identity_id,
    sessionIdentityId: row.session_identity_id,
    sessionHandoff: normalizeSessionHandoff(row.session_handoff_json),
    importSource: sourceSessions[0] ?? null,
    resourcePlan: normalizeResourcePlan(row.resource_plan_json),
    goal: row.goal,
    acceptance: row.acceptance,
    status,
    currentSummary: row.current_summary,
    plan,
    pendingClarification: normalizeClarification(row.clarification_json),
    conversation,
    result: row.result_json ? (JSON.parse(row.result_json) as WorkOrderResult) : null,
    revisionNote: row.revision_note,
    worktreePath: row.worktree_path,
    executionBranch: row.execution_branch,
    baseCommit: row.base_commit,
    sessionId: row.session_id,
    runStatus: row.run_status,
    runStartedAt: row.run_started_at,
    runEndedAt: row.run_ended_at,
    runPid: row.run_pid,
    runNumber: row.run_number,
    checkpoints,
    runtimeMs: currentRuntime(row),
    maxRunMinutes: row.max_run_minutes ?? 60,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeSessionHandoff(value: string | null): SessionHandoff | null {
  if (!value) return null;
  try {
    const handoff = JSON.parse(value) as Partial<SessionHandoff>;
    if (
      typeof handoff.fromExecutionIdentityId !== "string" ||
      typeof handoff.summary !== "string" ||
      typeof handoff.createdAt !== "string"
    ) {
      return null;
    }
    return {
      fromExecutionIdentityId: handoff.fromExecutionIdentityId,
      previousSessionId:
        typeof handoff.previousSessionId === "string" ? handoff.previousSessionId : null,
      summary: handoff.summary,
      currentStageId:
        typeof handoff.currentStageId === "string" ? handoff.currentStageId : null,
      currentStageOutcome:
        typeof handoff.currentStageOutcome === "string" ? handoff.currentStageOutcome : null,
      createdAt: handoff.createdAt,
    };
  } catch {
    return null;
  }
}

function legacyCodexSourcesWithIdentity(
  sourceSessionsJson: string | null,
  importSourceJson: string | null,
  systemIdentityId: string,
): {
  sourceSessions: Array<Record<string, unknown>>;
  importSource: Record<string, unknown> | null;
} | null {
  try {
    const storedSources = sourceSessionsJson === null
      ? null
      : JSON.parse(sourceSessionsJson);
    const storedImport = importSourceJson === null
      ? null
      : JSON.parse(importSourceJson);
    const sourceSessions = Array.isArray(storedSources)
      ? storedSources
      : storedImport && typeof storedImport === "object"
        ? [storedImport]
        : [];
    let changed = false;
    const annotate = (source: unknown): Record<string, unknown> => {
      if (!source || typeof source !== "object" || Array.isArray(source)) return {};
      const value = source as Record<string, unknown>;
      if (value.kind !== "codex_session" || value.executionIdentityId) return value;
      changed = true;
      return {
        ...value,
        executionIdentityId: systemIdentityId,
        openInCodex: true,
      };
    };
    const annotatedSources = sourceSessions.map(annotate);
    const annotatedImport = storedImport ? annotate(storedImport) : null;
    return changed
      ? { sourceSessions: annotatedSources, importSource: annotatedImport }
      : null;
  } catch {
    return null;
  }
}

function normalizeImportSource(value: string | null): WorkOrderImportSource | null {
  if (!value) return null;
  try {
    const stored = JSON.parse(value) as Partial<WorkOrderImportSource>;
    if (
      !["codex_session", "claude_code_session"].includes(String(stored.kind)) ||
      typeof stored.id !== "string" ||
      !stored.id.trim() ||
      typeof stored.lastActiveAt !== "string" ||
      !Number.isFinite(Date.parse(stored.lastActiveAt)) ||
      stored.version !== 1
    ) {
      return null;
    }
    return {
      kind: stored.kind as WorkOrderImportSource["kind"],
      id: stored.id.trim(),
      lastActiveAt: new Date(stored.lastActiveAt).toISOString(),
      ...(stored.lastReadAt === null
        ? { lastReadAt: null }
        : typeof stored.lastReadAt === "string" && Number.isFinite(Date.parse(stored.lastReadAt))
          ? { lastReadAt: new Date(stored.lastReadAt).toISOString() }
          : {}),
      ...(typeof stored.executionIdentityId === "string" && stored.executionIdentityId.trim()
        ? { executionIdentityId: stored.executionIdentityId.trim() }
        : {}),
      ...(stored.openInCodex === true ||
      (stored.kind === "codex_session" && !stored.executionIdentityId)
        ? { openInCodex: true }
        : {}),
      version: 1,
    };
  } catch {
    return null;
  }
}

function sourceKey(source: Pick<WorkOrderImportSource, "kind" | "id">): string {
  return `${source.kind}:${source.id}`;
}

function normalizeImportContext(value: string | null): WorkOrderImportContext | null {
  if (!value) return null;
  try {
    const stored = JSON.parse(value) as Partial<WorkOrderImportContext>;
    if (
      !["pending", "ready", "failed"].includes(stored.status ?? "") ||
      (stored.summary !== null && typeof stored.summary !== "string") ||
      (stored.currentState !== null && typeof stored.currentState !== "string") ||
      (stored.organizedAt !== null &&
        (typeof stored.organizedAt !== "string" || !Number.isFinite(Date.parse(stored.organizedAt)))) ||
      (stored.error !== null && typeof stored.error !== "string")
    ) {
      return null;
    }
    const sourceIds = new Set<string>();
    const historicalStages = normalizeImportedHistoricalStages(
      stored.historicalStages ?? [],
      sourceIds,
      true,
    );
    return {
      status: stored.status!,
      summary: stored.summary ?? null,
      currentState: stored.currentState ?? null,
      historicalStages,
      artifacts: normalizeReferences(stored.artifacts ?? []),
      organizedAt: stored.organizedAt
        ? new Date(stored.organizedAt).toISOString()
        : null,
      error: stored.error ?? null,
    };
  } catch {
    return null;
  }
}

function normalizeImportedHistoricalStages(
  value: unknown,
  sourceIds: Set<string>,
  allowUnknownSources = false,
): WorkOrderImportContext["historicalStages"] {
  if (!Array.isArray(value)) throw new Error("会话历史节点格式无效");
  const stages = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("会话历史节点格式无效");
    }
    const stage = item as Partial<WorkOrderImportContext["historicalStages"][number]>;
    if (
      typeof stage.id !== "string" || !stage.id.trim() ||
      typeof stage.outcome !== "string" || !stage.outcome.trim() ||
      typeof stage.summary !== "string" || !stage.summary.trim() ||
      !["completed", "in_progress", "unknown"].includes(stage.status ?? "") ||
      !Array.isArray(stage.sourceSessionIds) ||
      stage.sourceSessionIds.some((id) =>
        typeof id !== "string" || !id.trim() || (!allowUnknownSources && !sourceIds.has(id.trim()))
      )
    ) {
      throw new Error("会话历史节点格式无效");
    }
    return {
      id: stage.id.trim(),
      outcome: stage.outcome.trim(),
      summary: stage.summary.trim(),
      status: stage.status!,
      sourceSessionIds: [...new Set(stage.sourceSessionIds.map((id) => id.trim()))],
    };
  });
  if (new Set(stages.map((stage) => stage.id)).size !== stages.length) {
    throw new Error("会话历史节点标识不能重复");
  }
  return stages;
}

function normalizeSourceSessions(
  value: string | null,
  legacySource: WorkOrderImportSource | null,
): WorkOrderImportSource[] {
  if (value === null) return legacySource ? [legacySource] : [];
  try {
    const stored = JSON.parse(value);
    if (!Array.isArray(stored)) return [];
    return stored
      .map((source) => normalizeImportSource(JSON.stringify(source)))
      .filter((source): source is WorkOrderImportSource => source !== null);
  } catch {
    return [];
  }
}

function normalizeResourcePlan(value: string | null): WorkOrderResourcePlan {
  if (!value) {
    return {
      priority: "normal",
      pace: "balanced",
      runWhenQuotaAvailable: false,
      autoRunReason: null,
    };
  }
  try {
    const stored = JSON.parse(value) as Partial<WorkOrderResourcePlan>;
    return {
      priority: workOrderPriorities.includes(stored.priority as WorkOrderPriority)
        ? (stored.priority as WorkOrderPriority)
        : "normal",
      pace: workOrderPaces.includes(stored.pace as WorkOrderPace)
        ? (stored.pace as WorkOrderPace)
        : "balanced",
      runWhenQuotaAvailable: stored.runWhenQuotaAvailable === true,
      autoRunReason:
        typeof stored.autoRunReason === "string" && stored.autoRunReason.trim()
          ? stored.autoRunReason
          : null,
    };
  } catch {
    return {
      priority: "normal",
      pace: "balanced",
      runWhenQuotaAvailable: false,
      autoRunReason: null,
    };
  }
}

function normalizeClarification(value: string | null): WorkOrderClarification | null {
  if (!value) return null;
  try {
    const stored = JSON.parse(value) as Partial<WorkOrderClarification>;
    const questions = normalizeClarificationQuestions(stored.questions ?? []);
    if (!questions.length || typeof stored.createdAt !== "string") return null;
    return {
      questions,
      requiresPlanConfirmation: stored.requiresPlanConfirmation === true,
      createdAt: stored.createdAt,
    };
  } catch {
    return null;
  }
}

function normalizeClarificationQuestions(value: unknown): ClarificationQuestion[] {
  if (!Array.isArray(value)) throw new Error("澄清问题格式无法识别");
  const targets = ["goal", "acceptance", "materials", "resources", "plan"];
  return value.slice(0, 1).map((item, index) => {
    if (!item || typeof item !== "object") throw new Error("澄清问题格式无法识别");
    const question = item as Partial<ClarificationQuestion>;
    const id = question.id?.trim() || `question-${index + 1}`;
    const prompt = publicPlanningText(question.prompt?.trim() ?? "");
    const reason = publicPlanningText(question.reason?.trim() ?? "");
    if (!prompt || !reason || !targets.includes(question.target ?? "")) {
      throw new Error("澄清问题格式无法识别");
    }
    return { id, prompt, reason, target: question.target! };
  });
}

function normalizeMaterialInputs(
  value: Array<{ kind: WorkOrder["materials"][number]["kind"]; value: string }>,
): Array<{ kind: WorkOrder["materials"][number]["kind"]; value: string }> {
  if (!Array.isArray(value)) throw new Error("素材格式无法识别");
  return value.map((material) => {
    const normalized = material.value?.trim() ?? "";
    if (!workOrderMaterialKinds.includes(material.kind) || !normalized) {
      throw new Error("素材格式无法识别");
    }
    return { kind: material.kind, value: normalized };
  });
}

function validateResourcePlan(value: {
  priority: WorkOrderPriority;
  pace: WorkOrderPace;
  runWhenQuotaAvailable: boolean;
}): void {
  if (
    !workOrderPriorities.includes(value.priority) ||
    !workOrderPaces.includes(value.pace) ||
    typeof value.runWhenQuotaAvailable !== "boolean"
  ) {
    throw new Error("资源方案格式无法识别");
  }
}

function updatedResourcePlan(
  workOrder: WorkOrder,
  input: {
    priority: WorkOrderPriority;
    pace: WorkOrderPace;
    runWhenQuotaAvailable: boolean;
  },
): WorkOrderResourcePlan {
  validateResourcePlan(input);
  return {
    priority: input.priority,
    pace: input.pace,
    runWhenQuotaAvailable: input.runWhenQuotaAvailable,
    autoRunReason: input.runWhenQuotaAvailable
      ? workOrder.resourcePlan.autoRunReason
      : null,
  };
}

function mapCheckpointRow(row: CheckpointRow): WorkOrderCheckpoint {
  return {
    id: row.id,
    kind: row.checkpoint_kind,
    planVersion: row.plan_version,
    stageId: row.stage_id,
    stageOutcome: row.stage_outcome,
    runNumber: row.run_number,
    sequence: row.sequence,
    treeHash: row.tree_hash,
    createdAt: row.created_at,
  };
}

function mapProjectMaterialRow(row: ProjectMaterialRow): ProjectMaterial {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.material_kind,
    label: row.label,
    value: row.value,
    sourceGoalId: row.source_goal_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectMaterialLabel(value: string): string {
  const parts = value.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.at(-1) || value;
}

function textTokens(value: string): Set<string> {
  const normalized = value.toLocaleLowerCase();
  const tokens = new Set(
    normalized.match(/[a-z0-9][a-z0-9._-]+/g)?.filter((token) => token.length > 1) ?? [],
  );
  for (const sequence of normalized.match(/\p{Script=Han}+/gu) ?? []) {
    if (sequence.length === 1) tokens.add(sequence);
    for (let index = 0; index < sequence.length - 1; index += 1) {
      tokens.add(sequence.slice(index, index + 2));
    }
  }
  return tokens;
}

function overlapScore(left: Set<string>, right: Set<string>): number {
  let score = 0;
  for (const token of left) {
    if (right.has(token)) score += 1;
  }
  return score;
}

function normalizeStoredPlan(
  plan: WorkOrderPlan,
  workspace: WorkOrderWorkspace | null,
): WorkOrderPlan {
  const expectedWorkspace = planWorkspaceFor(workspace);
  return {
    ...plan,
    ...(plan.confirmationRequired === true ? { confirmationRequired: true } : {}),
    stages: plan.stages.map((stage) => {
      const executionMethod = normalizeExecutionMethod(stage.executionMethod);
      const externalResult = normalizeExternalResult(stage.externalResult);
      const contextNotes = normalizeContextNotes(stage.contextNotes);
      return {
        ...stage,
        dependsOn: normalizeDependencies(stage.dependsOn),
        executionMethod,
        workspace:
          executionMethod === "codex"
            ? expectedWorkspace
            : normalizeWorkspace(stage.workspace, expectedWorkspace),
        materials: normalizeReferences(stage.materials),
        artifacts: normalizeReferences(stage.artifacts),
        ...(externalResult ? { externalResult } : {}),
        ...(contextNotes.length ? { contextNotes } : {}),
        status: stage.status ?? "planning",
        statusReason: stage.statusReason?.trim() || "等待确认并启动",
      };
    }),
  };
}

function normalizeExternalResult(value: unknown): PlanStage["externalResult"] {
  if (!value || typeof value !== "object") return undefined;
  const result = value as NonNullable<PlanStage["externalResult"]>;
  const conclusion = typeof result.conclusion === "string" && result.conclusion.trim()
    ? result.conclusion.trim()
    : null;
  if (
    typeof result.completedAt !== "string" ||
    !Number.isFinite(Date.parse(result.completedAt))
  ) {
    return undefined;
  }
  return { conclusion, completedAt: result.completedAt };
}

function normalizeExternalCompletionReference(
  value: { type: "file" | "link"; label?: string; location: string } | undefined,
): PlanReference | null {
  if (value === undefined) return null;
  const location = value.location?.trim() ?? "";
  if ((value.type !== "file" && value.type !== "link") || !location) {
    throw new Error("成果引用必须是本地文件或外部链接");
  }
  if (value.type === "link") {
    let url: URL;
    try {
      url = new URL(location);
    } catch {
      throw new Error("请填写有效的 http 或 https 外部链接");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("请填写有效的 http 或 https 外部链接");
    }
  }
  return {
    id: crypto.randomUUID(),
    type: value.type,
    label: value.label?.trim() || (value.type === "file" ? "外部成果文件" : "外部成果链接"),
    location,
  };
}

function planWithVerificationStatuses(
  plan: WorkOrderPlan | null,
  result: WorkOrderResult,
  checkpointedStages = new Set<string>(),
): WorkOrderPlan | null {
  if (!plan || result.planVersion !== plan.version) return plan;
  const evidenceByStage = new Map(
    result.verifications.map((verification) => [verification.stageId, verification]),
  );
  return {
    ...plan,
    stages: plan.stages.map((stage) => {
      const verification = evidenceByStage.get(stage.id);
      if (!verification) return stage;
      if (verification.status === "passed") {
        return {
          ...stage,
          status: "completed",
          statusReason: checkpointedStages.has(stage.id)
            ? "验证通过，检查点已保存"
            : "自动验证通过",
        };
      }
      if (verification.status === "failed") {
        return { ...stage, status: "response", statusReason: "自动验证未通过" };
      }
      return { ...stage, status: "response", statusReason: "等待人工验收" };
    }),
  };
}

function nextRunnableCodexStage(plan: WorkOrderPlan): PlanStage | undefined {
  const stage = nextRunnableStage(plan);
  return stage?.executionMethod === "codex" ? stage : undefined;
}

function nextRunnableStage(plan: WorkOrderPlan): PlanStage | undefined {
  const completed = new Set(
    plan.stages.filter((stage) => stage.status === "completed").map((stage) => stage.id),
  );
  return plan.stages.find(
    (stage) =>
      (stage.executionMethod === "codex"
        ? stage.status === "planning" || stage.status === "running"
        : stage.status === "response") &&
      stage.dependsOn.every((dependencyId) => completed.has(dependencyId)),
  );
}

function resetRunningCodexStages(plan: WorkOrderPlan): WorkOrderPlan {
  return {
    ...plan,
    stages: plan.stages.map((stage) =>
      stage.executionMethod === "codex" && stage.status === "running"
        ? { ...stage, status: "planning", statusReason: "等待确认并启动" }
        : stage,
    ),
  };
}

function advanceAfterCodexRun(
  plan: WorkOrderPlan,
  result: WorkOrderResult,
): WorkOrderPlan {
  const completedIds = new Set<string>();
  for (const verification of result.verifications) {
    if (verification.status === "passed") completedIds.add(verification.stageId);
  }
  return advancePlanWithCompletedStages(plan, completedIds, "Codex 本轮已完成");
}

function advancePlanWithCompletedStages(
  plan: WorkOrderPlan,
  newlyCompletedIds: ReadonlySet<string>,
  statusReason: string,
): WorkOrderPlan {
  const completedIds = new Set([
    ...plan.stages
      .filter((stage) => stage.status === "completed")
      .map((stage) => stage.id),
    ...newlyCompletedIds,
  ]);
  return {
    ...plan,
    stages: plan.stages.map((stage) => {
      if (completedIds.has(stage.id)) {
        return stage.status === "completed"
          ? stage
          : { ...stage, status: "completed" as const, statusReason };
      }
      const dependenciesReady = stage.dependsOn.every((dependencyId) =>
        completedIds.has(dependencyId),
      );
      if (stage.executionMethod === "external") {
        return {
          ...stage,
          status: dependenciesReady ? ("response" as const) : ("queued" as const),
          statusReason: dependenciesReady
            ? "等待你在外部完成并标记"
            : "等待前置节点完成",
        };
      }
      if (stage.status === "response") return stage;
      return {
        ...stage,
        status: dependenciesReady ? ("planning" as const) : ("queued" as const),
        statusReason: dependenciesReady
          ? "前置节点已完成，可以启动 Codex"
          : "等待前置节点完成",
      };
    }),
  };
}

function mergeResults(
  previous: WorkOrderResult | null,
  current: WorkOrderResult,
  pruneMissingDirectoryArtifacts = false,
): WorkOrderResult {
  if (!previous || previous.planVersion !== current.planVersion) return current;
  const byStage = new Map(
    previous.verifications.map((verification) => [verification.stageId, verification]),
  );
  for (const verification of current.verifications) {
    byStage.set(verification.stageId, verification);
  }
  return {
    ...current,
    artifacts: mergeResultArtifacts(
      previous.artifacts,
      current.artifacts,
      pruneMissingDirectoryArtifacts,
    ),
    verifications: [...byStage.values()],
  };
}

function mergeResultArtifacts(
  previous: WorkOrderResult["artifacts"],
  current: WorkOrderResult["artifacts"],
  pruneMissingDirectoryArtifacts: boolean,
): WorkOrderResult["artifacts"] {
  const byLocation = new Map(
    (previous ?? []).map((artifact) => [artifact.location, artifact]),
  );
  for (const artifact of current ?? []) byLocation.set(artifact.location, artifact);
  const artifacts = [...byLocation.values()].filter(
    (artifact) =>
      !pruneMissingDirectoryArtifacts ||
      artifact.type !== "file" ||
      !artifact.id.startsWith("directory-result:") ||
      existsSync(artifact.location),
  );
  return artifacts.length ? artifacts : undefined;
}

function nextPlanSummary(plan: WorkOrderPlan | null): string {
  const external = plan?.stages.find(
    (stage) => stage.executionMethod === "external" && stage.status === "response",
  );
  if (external) return `请完成外部工作“${external.outcome}”`;
  const codex = plan?.stages.find(
    (stage) => stage.executionMethod === "codex" && stage.status === "planning",
  );
  return codex ? `可以启动“${codex.outcome}”` : "等待前置节点完成";
}

function checkpointedStageIds(workOrder: WorkOrder | null | undefined): Set<string> {
  if (!workOrder?.plan) return new Set();
  const stageCheckpoints = workOrder.checkpoints.filter(
    (checkpoint) =>
      checkpoint.kind === "stage" &&
      checkpoint.planVersion === workOrder.plan!.version &&
      checkpoint.stageId,
  );
  const finalStageId = workOrder.plan.stages.at(-1)?.id;
  if (
    finalStageId &&
    stageCheckpoints.some((checkpoint) => checkpoint.stageId === finalStageId)
  ) {
    return new Set(workOrder.plan.stages.map((stage) => stage.id));
  }
  return new Set(stageCheckpoints.map((checkpoint) => checkpoint.stageId!));
}

function normalizeDependencies(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("计划节点依赖无效");
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function hasDependencyCycle(
  stages: Array<{ id: string; dependsOn: string[] }>,
): boolean {
  const dependencies = new Map(stages.map((stage) => [stage.id, stage.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependencyId of dependencies.get(id) ?? []) {
      if (visit(dependencyId)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };

  return stages.some((stage) => visit(stage.id));
}

function normalizeExecutionMethod(value: unknown): "codex" | "external" {
  if (value === undefined) return "codex";
  if (value !== "codex" && value !== "external") {
    throw new Error("计划节点执行方式无效");
  }
  return value;
}

function planWorkspaceFor(workspace: WorkOrderWorkspace | null): PlanWorkspace {
  return workspace
    ? { kind: workspace.kind, path: workspace.path }
    : { kind: "git", path: null };
}

function syncPlanWorkspace(
  plan: WorkOrderPlan,
  workspace: WorkOrderWorkspace,
  updatedAt: string,
): WorkOrderPlan {
  const selectedWorkspace = planWorkspaceFor(workspace);
  return {
    ...plan,
    updatedAt,
    stages: plan.stages.map((stage) =>
      stage.executionMethod === "codex"
        ? { ...stage, workspace: selectedWorkspace }
        : stage,
    ),
  };
}

function normalizeWorkspace(
  value: unknown,
  fallback: PlanWorkspace,
): PlanWorkspace {
  if (value === undefined) {
    return fallback;
  }
  if (!value || typeof value !== "object") {
    throw new Error("计划节点工作空间无效");
  }
  const workspace = value as Partial<PlanWorkspace>;
  if (
    !["git", "directory", "external"].includes(workspace.kind ?? "") ||
    (workspace.path !== null && typeof workspace.path !== "string")
  ) {
    throw new Error("计划节点工作空间无效");
  }
  return {
    kind: workspace.kind!,
    path: typeof workspace.path === "string" ? workspace.path.trim() || null : null,
  };
}

function normalizeReferences(value: unknown): PlanReference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("计划节点引用无效");
  }
  return value.map((reference) => {
    if (!reference || typeof reference !== "object") {
      throw new Error("计划节点引用无效");
    }
    const candidate = reference as Partial<PlanReference>;
    if (
      typeof candidate.id !== "string" ||
      !["repository", "folder", "file", "image", "link"].includes(
        candidate.type ?? "",
      ) ||
      typeof candidate.label !== "string" ||
      typeof candidate.location !== "string" ||
      !candidate.id.trim() ||
      !candidate.label.trim() ||
      !candidate.location.trim()
    ) {
      throw new Error("计划节点引用无效");
    }
    return {
      id: candidate.id.trim(),
      type: candidate.type!,
      label: candidate.label.trim(),
      location: candidate.location.trim(),
    };
  });
}

function normalizeContextNotes(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((note) => typeof note !== "string")) {
    throw new Error("节点补充上下文无效");
  }
  return value.map((note) => note.trim()).filter(Boolean);
}

function currentRuntime(row: WorkOrderRow): number {
  if (
    !["running", "stopping"].includes(row.run_status ?? "") ||
    !row.runtime_updated_at
  ) {
    return row.runtime_ms;
  }
  return row.runtime_ms + Math.max(0, Date.now() - Date.parse(row.runtime_updated_at));
}

function publicPlanningText(value: string): string {
  return value
    .replace(/\[\$?[a-z0-9_-]+\]\([^)]*\/SKILL\.md\)/gi, "Teamline")
    .replace(/\$ask-matt\b|\/ask-matt\b|Ask\s+Matt|ask-matt/gi, "Teamline");
}

function sanitizeGeneratedStages(stages: PlanStageInput[]): PlanStageInput[] {
  return stages.map((stage) => ({
    ...stage,
    outcome: publicPlanningText(stage.outcome),
    scope: publicPlanningText(stage.scope),
    verification: publicPlanningText(stage.verification),
    ...(stage.contextNotes
      ? { contextNotes: stage.contextNotes.map(publicPlanningText) }
      : {}),
  }));
}

function inheritStableStageContext(
  plan: WorkOrderPlan | null,
  stages: PlanStageInput[],
): PlanStageInput[] {
  if (!plan) return stages;
  const contextByStage = new Map(plan.stages.map((stage) => [stage.id, stage]));
  return stages.map((stage) => {
    const inherited = stage.id ? contextByStage.get(stage.id) : undefined;
    if (!inherited) return stage;
    return {
      ...stage,
      ...(!stage.contextNotes?.length && inherited.contextNotes?.length
        ? { contextNotes: [...inherited.contextNotes] }
        : {}),
      ...(!stage.materials?.length && inherited.materials.length
        ? { materials: inherited.materials.map((reference) => ({ ...reference })) }
        : {}),
      ...(!stage.artifacts?.length && inherited.artifacts.length
        ? { artifacts: inherited.artifacts.map((reference) => ({ ...reference })) }
        : {}),
    };
  });
}

function planStructureChanged(
  workOrder: WorkOrder,
  stages: PlanStageInput[],
  goal: string,
  acceptance: string | null,
): boolean {
  if (!workOrder.plan || goal !== workOrder.goal || acceptance !== workOrder.acceptance) {
    return true;
  }
  if (stages.length !== workOrder.plan.stages.length) return true;
  const expectedWorkspace = planWorkspaceFor(workOrder.workspace);
  const candidate = stages.map((stage) => ({
    id: stage.id?.trim() ?? "",
    outcome: stage.outcome.trim(),
    scope: stage.scope.trim(),
    verification: stage.verification.trim(),
    verificationCommand: stage.verificationCommand?.trim() || null,
    dependsOn: [...normalizeDependencies(stage.dependsOn)].sort(),
    executionMethod: normalizeExecutionMethod(stage.executionMethod),
    workspace: normalizeWorkspace(stage.workspace, expectedWorkspace),
  }));
  const current = workOrder.plan.stages.map((stage) => ({
    id: stage.id,
    outcome: stage.outcome,
    scope: stage.scope,
    verification: stage.verification,
    verificationCommand: stage.verificationCommand ?? null,
    dependsOn: [...stage.dependsOn].sort(),
    executionMethod: stage.executionMethod,
    workspace: stage.workspace,
  }));
  return JSON.stringify(candidate) !== JSON.stringify(current);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function legacyEventCategory(
  type: WorkOrderRunEvent["type"],
): WorkOrderRunEvent["category"] {
  return type === "progress" ? "message" : "lifecycle";
}

function truncateRunDetail(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return normalized.length > 2_000 ? `${normalized.slice(0, 2_000)}…` : normalized;
}
