import { accessSync, constants, existsSync } from "node:fs";
import {
  workOrderMaterialKinds,
  workOrderPaces,
  workOrderPriorities,
  workOrderStatuses,
  type ClarificationQuestion,
  type PlanReference,
  type PlanStage,
  type WorkOrder,
  type WorkOrderCheckpoint,
  type WorkOrderConversationMessage,
  type WorkOrderImportSource,
  type WorkOrderMaterial,
  type WorkOrderPlan,
  type WorkOrderResourcePlan,
  type WorkOrderStatus,
  type WorkOrderWorkspace,
} from "./work-order";
import type { WorkOrderStore } from "./work-order-store";

const bundleFormat = "teamline-local-state" as const;
const bundleVersion = 1 as const;
const maxBundleBytes = 5 * 1024 * 1024;

export type LocalStateBundle = {
  format: typeof bundleFormat;
  version: typeof bundleVersion;
  exportedAt: string;
  settings: {
    maxConcurrency: number;
    executionMapView: "map" | "list";
  };
  workOrders: ExportedWorkOrder[];
};

type ExportedWorkOrder = {
  id: string;
  title: string;
  goal: string;
  acceptance: string | null;
  status: WorkOrderStatus;
  currentSummary: string;
  revisionNote: string | null;
  workspace: WorkOrderWorkspace | null;
  materials: WorkOrderMaterial[];
  resourcePlan: WorkOrderResourcePlan;
  maxRunMinutes: number;
  sessionReferences: {
    imported: WorkOrderImportSource | null;
    active: string | null;
  };
  executionMap: WorkOrderPlan | null;
  pendingClarification: {
    questions: ClarificationQuestion[];
    requiresPlanConfirmation: boolean;
    createdAt: string;
  } | null;
  checkpoints: WorkOrderCheckpoint[];
  conversationDecisions: Array<
    Pick<
      WorkOrderConversationMessage,
      | "role"
      | "kind"
      | "content"
      | "stageId"
      | "decisionTarget"
      | "requiresPlanConfirmation"
      | "createdAt"
    >
  >;
  createdAt: string;
  updatedAt: string;
};

export type RestoreAttention = {
  kind: "workspace" | "reference" | "session";
  label: string;
  location: string;
  status: "needs_attention" | "unverified";
  reason: string;
};

export type RestorePreview = {
  previewId: string;
  summary: { total: number; conflicts: number; needsAttention: number };
  settingsConflict: boolean;
  workOrders: Array<{
    sourceId: string;
    title: string;
    conflict: boolean;
    attention: RestoreAttention[];
  }>;
};

export type RestoreResolution = "keep_existing" | "import_copy";

type PendingPreview = {
  bundle: LocalStateBundle;
  databaseFingerprint: string;
  conflictIds: Set<string>;
  settingsConflict: boolean;
};

export class InvalidStateBundleError extends Error {}
export class RestorePreviewMissingError extends Error {}
export class RestorePreviewStaleError extends Error {}
export class RestoreChoiceRequiredError extends Error {
  constructor(readonly conflicts: string[], readonly settingsConflict: boolean) {
    super("请先选择如何处理已有数据");
  }
}

export class LocalStateTransfer {
  private readonly previews = new Map<string, PendingPreview>();

  constructor(private readonly store: WorkOrderStore) {}

  export(): LocalStateBundle {
    const workOrders = this.store.database.transaction(() => this.store.list())();
    return {
      format: bundleFormat,
      version: bundleVersion,
      exportedAt: new Date().toISOString(),
      settings: {
        maxConcurrency: this.store.getExecutionSettings().maxConcurrency,
        executionMapView: this.store.getExecutionMapView(),
      },
      workOrders: workOrders.map(exportWorkOrder),
    };
  }

  preview(value: unknown): RestorePreview {
    const bundle = parseBundle(value);
    const existing = new Set(this.store.list().map((workOrder) => workOrder.id));
    const conflictIds = new Set(
      bundle.workOrders.filter((workOrder) => existing.has(workOrder.id)).map((workOrder) => workOrder.id),
    );
    const currentSettings = {
      maxConcurrency: this.store.getExecutionSettings().maxConcurrency,
      executionMapView: this.store.getExecutionMapView(),
    };
    const settingsConflict =
      this.store.list().length > 0 &&
      (currentSettings.maxConcurrency !== bundle.settings.maxConcurrency ||
        currentSettings.executionMapView !== bundle.settings.executionMapView);
    const workOrders = bundle.workOrders.map((workOrder) => ({
      sourceId: workOrder.id,
      title: workOrder.title,
      conflict: conflictIds.has(workOrder.id),
      attention: inspectReferences(workOrder),
    }));
    const previewId = crypto.randomUUID();
    this.previews.set(previewId, {
      bundle,
      databaseFingerprint: databaseFingerprint(this.store),
      conflictIds,
      settingsConflict,
    });
    prunePreviews(this.previews);
    return {
      previewId,
      summary: {
        total: workOrders.length,
        conflicts: conflictIds.size,
        needsAttention: workOrders.filter((item) =>
          item.attention.some((attention) => attention.status === "needs_attention"),
        ).length,
      },
      settingsConflict,
      workOrders,
    };
  }

  confirm(input: {
    previewId: string;
    resolutions?: Record<string, RestoreResolution>;
    settingsResolution?: "keep_existing" | "use_imported";
  }): { imported: number; copied: number; skipped: number } {
    const preview = this.previews.get(input.previewId);
    if (!preview) throw new RestorePreviewMissingError("恢复预览已失效，请重新预览");
    if (preview.databaseFingerprint !== databaseFingerprint(this.store)) {
      this.previews.delete(input.previewId);
      throw new RestorePreviewStaleError("本地数据已变化，请重新预览");
    }
    const resolutions = input.resolutions ?? {};
    const unresolved = [...preview.conflictIds].filter(
      (id) => resolutions[id] !== "keep_existing" && resolutions[id] !== "import_copy",
    );
    const unresolvedSettings =
      preview.settingsConflict &&
      input.settingsResolution !== "keep_existing" &&
      input.settingsResolution !== "use_imported";
    if (unresolved.length || unresolvedSettings) {
      throw new RestoreChoiceRequiredError(unresolved, unresolvedSettings);
    }

    let imported = 0;
    let copied = 0;
    let skipped = 0;
    this.store.database.transaction(() => {
      for (const workOrder of preview.bundle.workOrders) {
        const resolution = resolutions[workOrder.id];
        if (preview.conflictIds.has(workOrder.id) && resolution === "keep_existing") {
          skipped += 1;
          continue;
        }
        const targetId = resolution === "import_copy" ? crypto.randomUUID() : workOrder.id;
        insertWorkOrder(
          this.store,
          workOrder,
          targetId,
          resolution === "import_copy",
        );
        if (resolution === "import_copy") copied += 1;
        else imported += 1;
      }
      if (!preview.settingsConflict || input.settingsResolution === "use_imported") {
        this.store.saveMaxConcurrency(preview.bundle.settings.maxConcurrency);
        this.store.saveExecutionMapView(preview.bundle.settings.executionMapView);
      }
    })();
    this.previews.delete(input.previewId);
    return { imported, copied, skipped };
  }
}

export function assertStateBundleSize(value: string): void {
  if (new TextEncoder().encode(value).byteLength > maxBundleBytes) {
    throw new InvalidStateBundleError("导出文件过大，无法预览");
  }
}

function exportWorkOrder(workOrder: WorkOrder): ExportedWorkOrder {
  return redactObject({
    id: workOrder.id,
    title: workOrder.title,
    goal: workOrder.goal,
    acceptance: workOrder.acceptance,
    status: workOrder.status,
    currentSummary: workOrder.currentSummary,
    revisionNote: workOrder.revisionNote,
    workspace: workOrder.workspace,
    materials: workOrder.materials,
    resourcePlan: workOrder.resourcePlan,
    maxRunMinutes: workOrder.maxRunMinutes,
    sessionReferences: {
      imported: workOrder.importSource,
      active: workOrder.sessionId,
    },
    executionMap: workOrder.plan,
    pendingClarification: workOrder.pendingClarification,
    checkpoints: workOrder.checkpoints,
    conversationDecisions: workOrder.conversation
      .filter((message) => message.kind === "decision")
      .map(({ role, kind, content, stageId, decisionTarget, requiresPlanConfirmation, createdAt }) => ({
        role,
        kind,
        content,
        stageId,
        decisionTarget,
        requiresPlanConfirmation,
        createdAt,
      })),
    createdAt: workOrder.createdAt,
    updatedAt: workOrder.updatedAt,
  }) as ExportedWorkOrder;
}

function redactObject<T>(value: T): T {
  if (typeof value === "string") return redactString(value) as T;
  if (Array.isArray(value)) return value.map(redactObject) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactObject(item)]),
    ) as T;
  }
  return value;
}

function redactString(value: string): string {
  let redacted = value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [已隐藏凭据]")
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[opsu]_[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_-]{8,}|AKIA[A-Z0-9]{12,})\b/g, "[已隐藏凭据]")
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)\s*[:=]\s*[^\s,;&]+/gi, "$1=[已隐藏凭据]");
  redacted = redacted.replace(/https?:\/\/[^\s<>"']+/gi, (candidate) =>
    sanitizeUrl(candidate),
  );
  return redacted;
}

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/(token|key|secret|password|signature|credential|auth)/i.test(key)) {
        url.searchParams.set(key, "[已隐藏凭据]");
      }
    }
    return url.toString();
  } catch {
    return value;
  }
}

function inspectReferences(workOrder: ExportedWorkOrder): RestoreAttention[] {
  const attention: RestoreAttention[] = [];
  if (workOrder.workspace && !isReadableLocalPath(workOrder.workspace.path)) {
    attention.push({
      kind: "workspace",
      label: "工作空间",
      location: workOrder.workspace.path,
      status: "needs_attention",
      reason: "本机找不到或无法读取这个工作空间",
    });
  }
  if (workOrder.status === "running" || workOrder.status === "interrupted") {
    attention.push({
      kind: "workspace",
      label: "运行现场",
      location: workOrder.workspace?.path ?? "未关联工作空间",
      status: "needs_attention",
      reason: "导出不复制运行现场，恢复后不会自动继续旧运行",
    });
  }
  for (const material of workOrder.materials) {
    inspectLocation(attention, "reference", material.kind, material.value, material.kind);
  }
  for (const stage of workOrder.executionMap?.stages ?? []) {
    for (const reference of [...stage.materials, ...stage.artifacts]) {
      inspectLocation(attention, "reference", reference.label, reference.location, reference.type);
    }
  }
  if (workOrder.sessionReferences.active || workOrder.sessionReferences.imported) {
    attention.push({
      kind: "session",
      label: "Codex 会话",
      location:
        workOrder.sessionReferences.active ?? workOrder.sessionReferences.imported?.id ?? "",
      status: "unverified",
      reason: "恢复后需在本机重新确认会话是否可用",
    });
  }
  return deduplicateAttention(attention);
}

function inspectLocation(
  target: RestoreAttention[],
  kind: "reference",
  label: string,
  location: string,
  type: string,
): void {
  if (type === "link") {
    if (!isWebUrl(location)) {
      target.push({
        kind,
        label,
        location,
        status: "needs_attention",
        reason: "链接格式不可用",
      });
    } else {
      target.push({
        kind,
        label,
        location,
        status: "needs_attention",
        reason: "恢复时不会访问外部链接，请重新确认是否可用",
      });
    }
    return;
  }
  if (!isReadableLocalPath(location)) {
    target.push({
      kind,
      label,
      location,
      status: "needs_attention",
      reason: "本机找不到或无法读取这个引用",
    });
  }
}

function isReadableLocalPath(path: string): boolean {
  if (!path || !existsSync(path)) return false;
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function deduplicateAttention(items: RestoreAttention[]): RestoreAttention[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.kind}\0${item.location}\0${item.status}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function databaseFingerprint(store: WorkOrderStore): string {
  const workOrders = store
      .list()
      .map(({ id, updatedAt }) => [id, updatedAt])
      .sort(([left], [right]) => left.localeCompare(right));
  const checkpoints = store.database
    .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM work_order_checkpoints")
    .get()?.count ?? 0;
  const decisions = store.database
    .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM work_order_conversation")
    .get()?.count ?? 0;
  return JSON.stringify({
    workOrders,
    checkpoints,
    decisions,
    executionSettings: store.getExecutionSettings(),
    executionMapView: store.getExecutionMapView(),
  });
}

function prunePreviews(previews: Map<string, PendingPreview>): void {
  while (previews.size > 10) previews.delete(previews.keys().next().value!);
}

function insertWorkOrder(
  store: WorkOrderStore,
  source: ExportedWorkOrder,
  id: string,
  copy: boolean,
): void {
  const status = source.status === "running" ? "interrupted" : source.status;
  const summary =
    source.status === "running"
      ? "已恢复委托状态；原运行不会自动继续，请先确认工作空间和会话"
      : source.currentSummary;
  const runNumber = source.checkpoints.reduce(
    (maximum, checkpoint) => Math.max(maximum, checkpoint.runNumber),
    0,
  );
  store.database
    .query(`
      INSERT INTO work_orders (
        id, title, repository_path, workspace_kind, materials_json,
        import_source_json, resource_plan_json, goal, acceptance, status,
        current_summary, plan_json, clarification_json, result_json,
        revision_note, worktree_path, execution_branch, base_commit, session_id,
        run_status, run_started_at, run_ended_at, run_pid, run_number,
        runtime_ms, runtime_updated_at, max_run_minutes, last_error,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?,
        NULL, NULL, NULL, NULL, ?, 0, NULL, ?, ?, ?, ?
      )
    `)
    .run(
      id,
      copy ? `${source.title}（恢复副本）` : source.title,
      source.workspace?.path ?? "",
      source.workspace?.kind ?? null,
      JSON.stringify(source.materials),
      source.sessionReferences.imported
        ? JSON.stringify(source.sessionReferences.imported)
        : null,
      JSON.stringify(source.resourcePlan),
      source.goal,
      source.acceptance,
      status,
      summary,
      source.executionMap ? JSON.stringify(source.executionMap) : null,
      source.pendingClarification ? JSON.stringify(source.pendingClarification) : null,
      source.revisionNote,
      source.sessionReferences.active,
      runNumber,
      source.maxRunMinutes,
      status === "interrupted"
        ? "从本地导出恢复；请确认工作空间和会话后继续"
        : null,
      source.createdAt,
      source.updatedAt,
    );
  for (const checkpoint of source.checkpoints) {
    store.database
      .query(`
        INSERT INTO work_order_checkpoints (
          id, work_order_id, checkpoint_kind, plan_version, stage_id,
          stage_outcome, run_number, sequence, tree_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        crypto.randomUUID(),
        id,
        checkpoint.kind,
        checkpoint.planVersion,
        checkpoint.stageId,
        checkpoint.stageOutcome,
        checkpoint.runNumber,
        checkpoint.sequence,
        checkpoint.treeHash,
        checkpoint.createdAt,
      );
  }
  for (const message of source.conversationDecisions) {
    store.database
      .query(`
        INSERT INTO work_order_conversation (
          work_order_id, role, message_kind, content, stage_id,
          decision_target, requires_plan_confirmation, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        message.role,
        "decision",
        message.content,
        message.stageId,
        message.decisionTarget,
        message.requiresPlanConfirmation ? 1 : 0,
        message.createdAt,
      );
  }
}

function parseBundle(value: unknown): LocalStateBundle {
  const bundle = object(value, "导出文件格式无法识别");
  exactKeys(bundle, ["format", "version", "exportedAt", "settings", "workOrders"]);
  if (bundle.format !== bundleFormat || bundle.version !== bundleVersion) {
    throw new InvalidStateBundleError("导出文件版本不受支持");
  }
  const exportedAt = dateString(bundle.exportedAt);
  const settingsObject = object(bundle.settings, "本机设置格式无法识别");
  exactKeys(settingsObject, ["maxConcurrency", "executionMapView"]);
  const maxConcurrency = integer(settingsObject.maxConcurrency, 1, 32);
  const executionMapView = oneOf(settingsObject.executionMapView, ["map", "list"] as const);
  if (!Array.isArray(bundle.workOrders) || bundle.workOrders.length > 10_000) {
    throw new InvalidStateBundleError("委托列表格式无法识别");
  }
  return {
    format: bundleFormat,
    version: bundleVersion,
    exportedAt,
    settings: { maxConcurrency, executionMapView },
    workOrders: bundle.workOrders.map(parseWorkOrder),
  };
}

function parseWorkOrder(value: unknown): ExportedWorkOrder {
  const item = object(value, "委托格式无法识别");
  exactKeys(item, [
    "id", "title", "goal", "acceptance", "status", "currentSummary", "revisionNote",
    "workspace", "materials", "resourcePlan", "maxRunMinutes", "sessionReferences",
    "executionMap", "pendingClarification", "checkpoints", "conversationDecisions",
    "createdAt", "updatedAt",
  ]);
  const id = nonempty(item.id);
  const title = nonempty(item.title);
  const goal = nonempty(item.goal);
  const acceptance = nullableString(item.acceptance);
  const status = oneOf(item.status, workOrderStatuses);
  const currentSummary = string(item.currentSummary);
  const revisionNote = nullableString(item.revisionNote);
  const workspace = parseWorkspace(item.workspace);
  const materials = array(item.materials, parseMaterial, 10_000);
  const resourcePlan = parseResourcePlan(item.resourcePlan);
  const maxRunMinutes = oneOf(item.maxRunMinutes, [30, 60, 120, 240] as const);
  const sessionReferences = parseSessionReferences(item.sessionReferences);
  const executionMap = item.executionMap === null ? null : parsePlan(item.executionMap);
  const pendingClarification = parseClarification(item.pendingClarification);
  const checkpoints = array(item.checkpoints, parseCheckpoint, 100_000);
  const conversationDecisions = array(item.conversationDecisions, parseDecision, 100_000);
  return {
    id,
    title,
    goal,
    acceptance,
    status,
    currentSummary,
    revisionNote,
    workspace,
    materials,
    resourcePlan,
    maxRunMinutes,
    sessionReferences,
    executionMap,
    pendingClarification,
    checkpoints,
    conversationDecisions,
    createdAt: dateString(item.createdAt),
    updatedAt: dateString(item.updatedAt),
  };
}

function parseWorkspace(value: unknown): WorkOrderWorkspace | null {
  if (value === null) return null;
  const workspace = object(value, "工作空间格式无法识别");
  exactKeys(workspace, ["kind", "path"]);
  return {
    kind: oneOf(workspace.kind, ["git", "directory"] as const),
    path: nonempty(workspace.path),
  };
}

function parseMaterial(value: unknown): WorkOrderMaterial {
  const material = object(value, "素材引用格式无法识别");
  exactKeys(material, ["id", "kind", "value"]);
  return {
    id: nonempty(material.id),
    kind: oneOf(material.kind, workOrderMaterialKinds),
    value: nonempty(material.value),
  };
}

function parseResourcePlan(value: unknown): WorkOrderResourcePlan {
  const plan = object(value, "资源设置格式无法识别");
  exactKeys(plan, ["priority", "pace", "runWhenQuotaAvailable", "autoRunReason"]);
  return {
    priority: oneOf(plan.priority, workOrderPriorities),
    pace: oneOf(plan.pace, workOrderPaces),
    runWhenQuotaAvailable: boolean(plan.runWhenQuotaAvailable),
    autoRunReason: nullableString(plan.autoRunReason),
  };
}

function parseSessionReferences(value: unknown): ExportedWorkOrder["sessionReferences"] {
  const references = object(value, "会话引用格式无法识别");
  exactKeys(references, ["imported", "active"]);
  let imported: WorkOrderImportSource | null = null;
  if (references.imported !== null) {
    const source = object(references.imported, "会话来源格式无法识别");
    exactKeys(source, ["kind", "id", "lastActiveAt", "version"]);
    if (source.kind !== "codex_session" || source.version !== 1) {
      throw new InvalidStateBundleError("会话来源格式无法识别");
    }
    imported = {
      kind: "codex_session",
      id: nonempty(source.id),
      lastActiveAt: dateString(source.lastActiveAt),
      version: 1,
    };
  }
  return { imported, active: nullableString(references.active) };
}

function parsePlan(value: unknown): WorkOrderPlan {
  const plan = object(value, "执行地图格式无法识别");
  exactKeys(plan, ["version", "stages", "confirmationRequired", "updatedAt"], true);
  return {
    version: integer(plan.version, 1, Number.MAX_SAFE_INTEGER),
    stages: array(plan.stages, parseStage, 10_000),
    ...(plan.confirmationRequired === true ? { confirmationRequired: true } : {}),
    updatedAt: dateString(plan.updatedAt),
  };
}

function parseStage(value: unknown): PlanStage {
  const stage = object(value, "执行节点格式无法识别");
  exactKeys(stage, [
    "id", "outcome", "scope", "verification", "verificationCommand", "dependsOn",
    "executionMethod", "workspace", "materials", "artifacts", "externalResult",
    "contextNotes", "status", "statusReason",
  ], true);
  const executionMethod = oneOf(stage.executionMethod, ["codex", "external"] as const);
  const workspaceObject = object(stage.workspace, "节点工作空间格式无法识别");
  exactKeys(workspaceObject, ["kind", "path"]);
  const workspaceKind = oneOf(workspaceObject.kind, ["git", "directory", "external"] as const);
  const workspace = {
    kind: workspaceKind,
    path: workspaceObject.path === null ? null : nonempty(workspaceObject.path),
  };
  let externalResult: PlanStage["externalResult"];
  if (stage.externalResult !== undefined) {
    const result = object(stage.externalResult, "外部成果格式无法识别");
    exactKeys(result, ["conclusion", "completedAt"]);
    externalResult = {
      conclusion: nullableString(result.conclusion),
      completedAt: dateString(result.completedAt),
    };
  }
  const verificationCommand = stage.verificationCommand === undefined
    ? undefined
    : nonempty(stage.verificationCommand);
  const contextNotes = stage.contextNotes === undefined
    ? undefined
    : array(stage.contextNotes, string, 10_000);
  return {
    id: nonempty(stage.id),
    outcome: nonempty(stage.outcome),
    scope: nonempty(stage.scope),
    verification: nonempty(stage.verification),
    ...(verificationCommand ? { verificationCommand } : {}),
    dependsOn: array(stage.dependsOn, nonempty, 10_000),
    executionMethod,
    workspace,
    materials: array(stage.materials, parseReference, 10_000),
    artifacts: array(stage.artifacts, parseReference, 10_000),
    ...(externalResult ? { externalResult } : {}),
    ...(contextNotes ? { contextNotes } : {}),
    status: oneOf(stage.status, ["planning", "running", "queued", "response", "completed"] as const),
    statusReason: string(stage.statusReason),
  };
}

function parseReference(value: unknown): PlanReference {
  const reference = object(value, "引用格式无法识别");
  exactKeys(reference, ["id", "type", "label", "location"]);
  return {
    id: nonempty(reference.id),
    type: oneOf(reference.type, workOrderMaterialKinds),
    label: nonempty(reference.label),
    location: nonempty(reference.location),
  };
}

function parseCheckpoint(value: unknown): WorkOrderCheckpoint {
  const checkpoint = object(value, "检查点引用格式无法识别");
  exactKeys(checkpoint, [
    "id", "kind", "planVersion", "stageId", "stageOutcome", "runNumber",
    "sequence", "treeHash", "createdAt",
  ]);
  return {
    id: nonempty(checkpoint.id),
    kind: oneOf(checkpoint.kind, ["baseline", "stage"] as const),
    planVersion: integer(checkpoint.planVersion, 1, Number.MAX_SAFE_INTEGER),
    stageId: nullableString(checkpoint.stageId),
    stageOutcome: nullableString(checkpoint.stageOutcome),
    runNumber: integer(checkpoint.runNumber, 0, Number.MAX_SAFE_INTEGER),
    sequence: integer(checkpoint.sequence, 1, Number.MAX_SAFE_INTEGER),
    treeHash: nonempty(checkpoint.treeHash),
    createdAt: dateString(checkpoint.createdAt),
  };
}

function parseDecision(value: unknown): ExportedWorkOrder["conversationDecisions"][number] {
  const decision = object(value, "对话决定格式无法识别");
  exactKeys(decision, [
    "role", "kind", "content", "stageId", "decisionTarget",
    "requiresPlanConfirmation", "createdAt",
  ]);
  if (decision.kind !== "decision") {
    throw new InvalidStateBundleError("只允许恢复已形成的对话决定");
  }
  const targets = ["goal", "acceptance", "materials", "resources", "plan", "stage"] as const;
  return {
    role: oneOf(decision.role, ["user", "teamline"] as const),
    kind: "decision",
    content: nonempty(decision.content),
    stageId: nullableString(decision.stageId),
    decisionTarget: decision.decisionTarget === null ? null : oneOf(decision.decisionTarget, targets),
    requiresPlanConfirmation: boolean(decision.requiresPlanConfirmation),
    createdAt: dateString(decision.createdAt),
  };
}

function parseClarification(value: unknown): ExportedWorkOrder["pendingClarification"] {
  if (value === null) return null;
  const clarification = object(value, "待澄清状态格式无法识别");
  exactKeys(clarification, ["questions", "requiresPlanConfirmation", "createdAt"]);
  return {
    questions: array(clarification.questions, (question) => {
      const item = object(question, "澄清问题格式无法识别");
      exactKeys(item, ["id", "prompt", "reason", "target"]);
      return {
        id: nonempty(item.id),
        prompt: nonempty(item.prompt),
        reason: nonempty(item.reason),
        target: oneOf(item.target, ["goal", "acceptance", "materials", "resources", "plan"] as const),
      };
    }, 1_000),
    requiresPlanConfirmation: boolean(clarification.requiresPlanConfirmation),
    createdAt: dateString(clarification.createdAt),
  };
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidStateBundleError(message);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  optional = false,
): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new InvalidStateBundleError("导出文件包含不支持的字段");
  }
  if (!optional && keys.some((key) => !(key in value))) {
    throw new InvalidStateBundleError("导出文件缺少必要字段");
  }
}

function array<T>(
  value: unknown,
  parser: (item: unknown) => T,
  maximum: number,
): T[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new InvalidStateBundleError("导出文件列表格式无法识别");
  }
  return value.map(parser);
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new InvalidStateBundleError("文本格式无法识别");
  return value;
}

function nonempty(value: unknown): string {
  const result = string(value).trim();
  if (!result) throw new InvalidStateBundleError("必要文本不能为空");
  return result;
}

function nullableString(value: unknown): string | null {
  return value === null ? null : string(value);
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new InvalidStateBundleError("开关格式无法识别");
  return value;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new InvalidStateBundleError("数字格式无法识别");
  }
  return value as number;
}

function dateString(value: unknown): string {
  const result = nonempty(value);
  if (!Number.isFinite(Date.parse(result))) throw new InvalidStateBundleError("时间格式无法识别");
  return result;
}

function oneOf<const T extends readonly unknown[]>(value: unknown, allowed: T): T[number] {
  if (!allowed.includes(value)) throw new InvalidStateBundleError("枚举值无法识别");
  return value as T[number];
}
