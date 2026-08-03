import { Database } from "bun:sqlite";
import {
  createWorkOrder,
  type CreateWorkOrderInput,
  type ClarificationQuestion,
  type PlanReference,
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
  type WorkOrderWorkspace,
  workOrderPaces,
  workOrderPriorities,
  workOrderMaterialKinds,
} from "./work-order";

type WorkOrderRow = {
  id: string;
  title: string;
  repository_path: string;
  workspace_kind: "git" | "directory" | null;
  materials_json: string | null;
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

type RunEventRow = {
  id: number;
  event_type: WorkOrderRunEvent["type"];
  message: string;
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

export class PlanLockedError extends Error {}

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
    this.addResultColumnsToExistingDatabase();
    this.addMaterialColumnsToExistingDatabase();
    this.addImportSourceColumnToExistingDatabase();
    this.addResourcePlanColumnToExistingDatabase();
    this.addClarificationColumnToExistingDatabase();
    this.migrateDeliveredStatus();
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_order_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        message TEXT NOT NULL,
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
    if (!workOrder) throw new Error("找不到这项委托");
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
    if (!workOrder) throw new Error("找不到这项委托");
    if (!workOrderPriorities.includes(input.priority)) {
      throw new Error("请选择有效的优先级");
    }
    if (!workOrderPaces.includes(input.pace)) {
      throw new Error("请选择有效的执行节奏");
    }
    if (typeof input.runWhenQuotaAvailable !== "boolean") {
      throw new Error("额度充足时运行设置无效");
    }
    const resourcePlan: WorkOrderResourcePlan = {
      priority: input.priority,
      pace: input.pace,
      runWhenQuotaAvailable: input.runWhenQuotaAvailable,
      autoRunReason: input.runWhenQuotaAvailable
        ? workOrder.resourcePlan.autoRunReason
        : null,
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

  saveAutoRunReason(id: string, reason: string | null): WorkOrder {
    const workOrder = this.get(id);
    if (!workOrder) throw new Error("找不到这项委托");
    const resourcePlan = { ...workOrder.resourcePlan, autoRunReason: reason };
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
    this.database
      .query(`
        INSERT INTO work_orders (
          id, title, repository_path, workspace_kind, materials_json, import_source_json,
          goal, acceptance, status, current_summary, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        workOrder.id,
        workOrder.title,
        workOrder.repositoryPath,
        workOrder.workspace?.kind ?? null,
        JSON.stringify(workOrder.materials),
        workOrder.importSource ? JSON.stringify(workOrder.importSource) : null,
        workOrder.goal,
        workOrder.acceptance,
        workOrder.status,
        workOrder.currentSummary,
        workOrder.createdAt,
        workOrder.updatedAt,
      );

    return workOrder;
  }

  saveClarification(
    id: string,
    questions: ClarificationQuestion[],
    requiresPlanConfirmation = false,
    pendingReply?: string,
  ): WorkOrder {
    const workOrder = this.get(id);
    if (!workOrder) throw new Error("找不到这项委托");
    if (workOrder.runStatus !== null || !["draft", "ready"].includes(workOrder.status)) {
      throw new PlanLockedError("委托开始执行后不能直接修改计划");
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
          SET clarification_json = ?, status = 'draft', current_summary = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(
          JSON.stringify(clarification),
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
    if (!workOrder?.plan) throw new Error("请先生成委托计划");
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
  ): WorkOrder {
    const current = this.get(id);
    if (!current) throw new Error("找不到这项委托");
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
    const title = titleForGoal(goal);
    const acceptance = !canUpdateGoal || generated.acceptance === undefined
      ? current.acceptance
      : generated.acceptance?.trim()
        ? publicPlanningText(generated.acceptance.trim())
        : null;
    const canUpdateMaterials = Boolean(pendingReply) && clarificationTargets.has("materials");
    const materials = !canUpdateMaterials || generated.materials === undefined
      ? current.materials
      : normalizeMaterialInputs(generated.materials).map((material) => ({
          id: crypto.randomUUID(),
          ...material,
        }));
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
    const structuralChange =
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
              clarification_json = NULL, status = ?, current_summary = ?, updated_at = ?
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
          structuralChange ? current.status : "ready",
          structuralChange
            ? current.currentSummary
            : canUpdateResources
              ? "资源偏好已更新"
              : "委托上下文已更新",
          now,
          id,
        );
      if (structuralChange) {
        this.savePlan(id, stages, { confirmationRequired: true });
      }
      if (current.conversation.length > 0 || requiresPlanConfirmation) {
        this.appendConversation(id, {
          role: "teamline",
          kind: "decision",
          content: structuralChange
            ? publicPlanningText(generated.message?.trim() || "计划已更新，请重新确认后再启动。")
            : canUpdateResources
              ? "资源偏好已更新，不改变计划版本。"
              : "委托上下文已更新，不改变计划版本。",
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
      }
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
      throw new Error("找不到这项委托");
    }
    if (
      workOrder.runStatus !== null ||
      !["draft", "ready"].includes(workOrder.status)
    ) {
      throw new PlanLockedError("委托开始执行后不能直接修改计划");
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
        throw new Error("计划节点必须使用当前委托选择的执行工作空间");
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
    if (!workOrder?.plan) throw new Error("找不到可更新的委托计划");
    if (workOrder.runStatus !== null || workOrder.status !== "ready") {
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
    const hasReadyWork = nextPlan.stages.some(
      (candidate) =>
        (candidate.executionMethod === "external" && candidate.status === "response") ||
        (candidate.executionMethod === "codex" && candidate.status === "planning"),
    );
    const summary = allCompleted
      ? "全部节点已完成，等待验收"
      : hasReadyWork
        ? nextPlanSummary(nextPlan)
        : "等待人工验收";
    this.database
      .query(`
        UPDATE work_orders
        SET plan_json = ?, status = ?, current_summary = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        JSON.stringify(nextPlan),
        allCompleted || !hasReadyWork ? "review" : "ready",
        summary,
        now,
        id,
      );
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
    if (!workOrder) throw new Error("找不到这项委托");
    if (workOrder.runStatus !== null || !["draft", "ready"].includes(workOrder.status)) {
      throw new PlanLockedError("委托开始执行后不能更换工作空间");
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
    const workOrder = this.get(id);
    if (!workOrder?.plan) throw new Error("找不到可执行的委托计划");
    const runnableStageIds = codexStageIdsForNextRun(workOrder.plan);
    if (runnableStageIds.size === 0) throw new Error("当前没有可以启动的 Codex 节点");
    const confirmedPlan = {
      ...workOrder.plan,
      confirmationRequired: false,
      stages: workOrder.plan.stages.map((stage) =>
        runnableStageIds.has(stage.id)
          ? { ...stage, status: "running" as const, statusReason: "Codex 执行中" }
          : stage,
      ),
    };
    const now = new Date().toISOString();
    this.database
      .query(`
        UPDATE work_orders
        SET status = 'running', current_summary = 'Codex 已启动', plan_json = ?,
            run_status = 'running', session_id = NULL,
            run_pid = NULL,
            run_number = run_number + 1,
            run_started_at = ?, run_ended_at = NULL, runtime_updated_at = ?,
            last_error = NULL, updated_at = ?
        WHERE id = ?
      `)
      .run(JSON.stringify(confirmedPlan), now, now, now, id);
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
    const now = new Date().toISOString();
    this.database
      .query(`
        UPDATE work_orders
        SET status = 'running', current_summary = '正在从最近阶段重新执行',
            run_status = 'running', run_number = run_number + 1,
            session_id = NULL, run_pid = NULL,
            run_started_at = ?, run_ended_at = NULL, runtime_updated_at = ?,
            last_error = NULL, updated_at = ?
        WHERE id = ?
      `)
      .run(now, now, now, id);
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

  beginResultProcessing(id: string, message: string): WorkOrder {
    const row = this.database
      .query<WorkOrderRow, [string]>("SELECT * FROM work_orders WHERE id = ?")
      .get(id);
    if (!row || row.run_status !== "running") {
      throw new Error("这项委托当前不能整理结果");
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
    const mergedResult = mergeResults(workOrder?.result ?? null, result);
    const pendingExternal = plan?.stages.some(
      (stage) => stage.executionMethod === "external" && stage.status !== "completed",
    ) === true;
    if (pendingExternal && plan) {
      plan = advanceAfterCodexRun(plan, result);
    }
    const externalReady = plan?.stages.some(
      (stage) => stage.executionMethod === "external" && stage.status === "response",
    ) === true;
    const now = new Date().toISOString();
    this.database
      .query(`
        UPDATE work_orders
        SET status = ?, run_status = ?, result_json = ?, plan_json = ?,
            current_summary = ?, last_error = NULL, updated_at = ?
        WHERE id = ? AND run_status = 'verifying'
      `)
      .run(
        externalReady ? "ready" : "review",
        externalReady ? null : "completed",
        JSON.stringify(mergedResult),
        plan ? JSON.stringify(plan) : null,
        externalReady
          ? nextPlanSummary(plan)
          : pendingExternal
            ? "请确认当前 AI 节点结果后继续"
            : hasConfiguredCommand
              ? "自动验证通过，等待人工验收"
              : "等待人工验收",
        now,
        id,
      );
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
        (workOrder.status === "ready" && workOrder.runStatus === null)
      )
    ) {
      throw new PlanLockedError("当前没有需要确认的 AI 节点结果");
    }
    const hasExternalStage = workOrder.plan.stages.some(
      (stage) => stage.executionMethod === "external",
    );
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
    if (!hasExternalStage || confirmedIds.size === 0) {
      throw new PlanLockedError("当前没有需要确认的 AI 节点结果");
    }

    const now = new Date().toISOString();
    const plan = advancePlanWithCompletedStages(
      workOrder.plan,
      confirmedIds,
      "已由你确认完成",
    );
    const hasReadyWork = plan.stages.some(
      (stage) =>
        (stage.executionMethod === "external" && stage.status === "response") ||
        (stage.executionMethod === "codex" && stage.status === "planning"),
    );
    this.database
      .query(`
        UPDATE work_orders
        SET status = ?, run_status = ?, plan_json = ?, current_summary = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        hasReadyWork ? "ready" : "review",
        hasReadyWork ? null : "completed",
        JSON.stringify(plan),
        hasReadyWork ? nextPlanSummary(plan) : "等待人工验收",
        now,
        id,
      );
    return this.get(id)!;
  }

  recordVerificationFailure(id: string, result: WorkOrderResult): WorkOrder {
    const workOrder = this.get(id);
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
      .run(JSON.stringify(result), plan ? JSON.stringify(plan) : null, error, now, id);
    return this.get(id)!;
  }

  recordResultProcessingFailure(id: string): WorkOrder {
    const now = new Date().toISOString();
    const error = "无法整理代码变化或验证结果，请检查委托工作区后继续处理";
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
      throw new Error("只有待验收的委托可以确认交付");
    }
    const now = new Date().toISOString();
    this.database
      .query(`
        UPDATE work_orders
        SET status = 'delivered', current_summary = '已由用户确认交付', updated_at = ?
        WHERE id = ? AND status = 'review'
      `)
      .run(now, id);
    return this.get(id)!;
  }

  revise(id: string, revisionNote: string): WorkOrder {
    const workOrder = this.get(id);
    const note = revisionNote.trim();
    if (!workOrder || workOrder.status !== "review" || !workOrder.plan) {
      throw new Error("只有待验收的委托可以补充要求");
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

  listRunEvents(id: string, limit = 20): WorkOrderRunEvent[] {
    const rows = this.database
      .query<RunEventRow, [string, number]>(`
        SELECT id, event_type, message, run_number, created_at
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
      summary: string;
      ended?: boolean;
      failed?: boolean;
      interrupted?: boolean;
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
              run_status = ?, run_ended_at = ?, run_pid = ?,
              runtime_ms = ?, runtime_updated_at = ?,
              last_error = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(
          status,
          options.summary,
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
          INSERT INTO run_events (work_order_id, event_type, message, run_number, created_at)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(id, type, message, row.run_number, nowIso);
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

function mapRow(
  row: WorkOrderRow,
  checkpoints: WorkOrderCheckpoint[] = [],
  conversation: WorkOrderConversationMessage[] = [],
): WorkOrder {
  return {
    id: row.id,
    title: row.title,
    repositoryPath: row.repository_path,
    workspace: row.workspace_kind
      ? { kind: row.workspace_kind, path: row.repository_path }
      : null,
    materials: row.materials_json ? JSON.parse(row.materials_json) : [],
    importSource: normalizeImportSource(row.import_source_json),
    resourcePlan: normalizeResourcePlan(row.resource_plan_json),
    goal: row.goal,
    acceptance: row.acceptance,
    status: row.status === "completed" ? "delivered" : row.status,
    currentSummary: row.current_summary,
    plan: row.plan_json
      ? normalizeStoredPlan(
          JSON.parse(row.plan_json),
          row.workspace_kind
            ? { kind: row.workspace_kind, path: row.repository_path }
            : null,
        )
      : null,
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

function normalizeImportSource(value: string | null): WorkOrderImportSource | null {
  if (!value) return null;
  try {
    const stored = JSON.parse(value) as Partial<WorkOrderImportSource>;
    if (
      stored.kind !== "codex_session" ||
      typeof stored.id !== "string" ||
      !stored.id.trim() ||
      typeof stored.lastActiveAt !== "string" ||
      !Number.isFinite(Date.parse(stored.lastActiveAt)) ||
      stored.version !== 1
    ) {
      return null;
    }
    return {
      kind: "codex_session",
      id: stored.id.trim(),
      lastActiveAt: new Date(stored.lastActiveAt).toISOString(),
      version: 1,
    };
  } catch {
    return null;
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
  return value.map((item, index) => {
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
          status: checkpointedStages.has(stage.id) ? "completed" : "response",
          statusReason: checkpointedStages.has(stage.id)
            ? "验证通过，检查点已保存"
            : "自动验证通过，等待阶段检查点",
        };
      }
      if (verification.status === "failed") {
        return { ...stage, status: "response", statusReason: "自动验证未通过" };
      }
      return { ...stage, status: "response", statusReason: "等待人工验收" };
    }),
  };
}

function codexStageIdsForNextRun(plan: WorkOrderPlan): Set<string> {
  const stageById = new Map(plan.stages.map((stage) => [stage.id, stage]));
  const blockedCache = new Map<string, boolean>();
  const blockedByExternalDependency = (stageId: string, visiting = new Set<string>()): boolean => {
    const cached = blockedCache.get(stageId);
    if (cached !== undefined) return cached;
    if (visiting.has(stageId)) return true;
    visiting.add(stageId);
    const stage = stageById.get(stageId);
    const blocked = (stage?.dependsOn ?? []).some((dependencyId) => {
      const dependency = stageById.get(dependencyId);
      if (!dependency) return true;
      if (dependency.executionMethod === "external") {
        return dependency.status !== "completed";
      }
      return blockedByExternalDependency(dependencyId, visiting);
    });
    visiting.delete(stageId);
    blockedCache.set(stageId, blocked);
    return blocked;
  };
  return new Set(
    plan.stages
      .filter(
        (stage) =>
          stage.executionMethod === "codex" &&
          (stage.status === "planning" || stage.status === "running") &&
          !blockedByExternalDependency(stage.id),
      )
      .map((stage) => stage.id),
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
    verifications: [...byStage.values()],
  };
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

function titleForGoal(goal: string): string {
  const firstLine = goal.split(/\r?\n/, 1)[0] ?? goal;
  return firstLine.length > 56 ? `${firstLine.slice(0, 56)}…` : firstLine;
}

function publicPlanningText(value: string): string {
  return value.replace(/Ask\s+Matt/gi, "Teamline");
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
