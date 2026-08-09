import { accessSync, constants, existsSync } from "node:fs";
import {
  projectMaterialKinds,
  type Project,
  type ProjectMaterial,
} from "./project";
import {
  workOrderMaterialKinds,
  workOrderPaces,
  workOrderPriorities,
  workOrderStatuses,
  type ClarificationQuestion,
  type PlanReference,
  type PlanStage,
  type SessionHandoff,
  type WorkOrder,
  type WorkOrderCheckpoint,
  type WorkOrderConversationMessage,
  type WorkOrderImportSource,
  type WorkOrderImportContext,
  type WorkOrderMonitoringImportContext,
  type WorkOrderMaterial,
  type WorkOrderPlan,
  type WorkOrderResult,
  type WorkOrderResourcePlan,
  type WorkOrderStatus,
  type WorkOrderWorkspace,
  normalizeWorkOrderSourceContext,
  type WorkOrderSourceContext,
} from "./work-order";
import type { WorkOrderStore } from "./work-order-store";

const bundleFormat = "teamline-local-state" as const;
const bundleVersion = 4 as const;
type BundleVersion = 1 | 2 | 3 | typeof bundleVersion;
const maxBundleBytes = 5 * 1024 * 1024;
const maxWorkOrders = 1_000;
const maxExecutionIdentities = 1_000;
const maxCheckpointsPerWorkOrder = 1_000;
const maxGitWorkspacesToInspect = 10;
const checkpointInspectionTimeoutMs = 500;

export type LocalStateBundle = {
  format: typeof bundleFormat;
  version: BundleVersion;
  exportedAt: string;
  settings: {
    maxConcurrency: number;
    executionMapView: "map" | "list";
  };
  projects: Project[];
  projectMaterials: ProjectMaterial[];
  executionIdentities: ExportedExecutionIdentityReference[];
  workOrders: ExportedWorkOrder[];
};

type ExportedExecutionIdentityReference = {
  id: string;
  tool: "codex";
  label: string;
  homeKind: "system" | "managed";
  createdAt: string;
  updatedAt: string;
};

type ExportedWorkOrder = {
  id: string;
  name: string;
  description: string;
  projectId: string | null;
  projectMaterialSelectionConfirmed: boolean;
  title: string;
  goal: string;
  acceptance: string | null;
  status: WorkOrderStatus;
  currentSummary: string;
  revisionNote: string | null;
  workspace: WorkOrderWorkspace | null;
  materials: WorkOrderMaterial[];
  resourcePlan: Pick<
    WorkOrderResourcePlan,
    "priority" | "pace" | "runWhenQuotaAvailable" | "autoRunReason"
  >;
  maxRunMinutes: number;
  sourceSessions: WorkOrderImportSource[];
  importContext: WorkOrderImportContext | null;
  sourceContext: WorkOrderSourceContext | null;
  currentSessionId: string | null;
  executionIdentityId: string | null;
  sessionIdentityId: string | null;
  sessionHandoff: SessionHandoff | null;
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
  result: WorkOrderResult | null;
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
  kind: "workspace" | "reference" | "session" | "resource" | "command";
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
  projectMaterials: Array<{
    id: string;
    label: string;
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
    const snapshot = this.store.database.transaction(() => ({
      projects: this.store.listProjects(),
      projectMaterials: this.store
        .listProjects()
        .flatMap((project) => this.store.listProjectMaterials(project.id)),
      executionIdentities: this.store.listExecutionIdentities(),
      workOrders: this.store.list(),
    }))();
    return {
      format: bundleFormat,
      version: bundleVersion,
      exportedAt: new Date().toISOString(),
      settings: {
        maxConcurrency: this.store.getExecutionSettings().maxConcurrency,
        executionMapView: this.store.getExecutionMapView(),
      },
      projects: redactObject(snapshot.projects),
      projectMaterials: redactObject(snapshot.projectMaterials),
      executionIdentities: redactObject(
        snapshot.executionIdentities.map(
          ({ id, tool, label, homeKind, createdAt, updatedAt }) => ({
            id,
            tool,
            label,
            homeKind,
            createdAt,
            updatedAt,
          }),
        ),
      ),
      workOrders: snapshot.workOrders.map(exportWorkOrder),
    };
  }

  preview(value: unknown): RestorePreview {
    const bundle = parseBundle(value);
    for (const project of bundle.projects) {
      const existing = this.store.getProject(project.id);
      if (existing && !sameProject(existing, project)) {
        throw new InvalidStateBundleError(`项目 ${project.id} 与本机同 ID 项目不一致`);
      }
    }
    for (const material of bundle.projectMaterials) {
      const existing = this.store
        .listProjectMaterials(material.projectId)
        .find((candidate) => candidate.id === material.id);
      if (existing && !sameProjectMaterial(existing, material)) {
        throw new InvalidStateBundleError(`项目素材 ${material.id} 与本机数据不一致`);
      }
    }
    for (const workOrder of bundle.workOrders) {
      for (const source of workOrder.sourceSessions) {
        const owner = findSourceSessionOwner(this.store, source);
        if (owner && owner.id !== workOrder.id) {
          throw new InvalidStateBundleError(
            `来源会话 ${source.id} 已属于本机另一个目标`,
          );
        }
      }
    }
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
    const checkpointAvailability = inspectCheckpointAvailability(bundle.workOrders);
    const workOrders = bundle.workOrders.map((workOrder) => ({
      sourceId: workOrder.id,
      title: workOrder.title,
      conflict: conflictIds.has(workOrder.id),
      attention: inspectReferences(workOrder, checkpointAvailability),
    }));
    const projectMaterials = bundle.projectMaterials.map((material) => ({
      id: material.id,
      label: material.label,
      attention: inspectProjectMaterial(material),
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
        needsAttention:
          workOrders.filter((item) =>
            item.attention.some((attention) => attention.status === "needs_attention"),
          ).length +
          projectMaterials.filter((item) =>
            item.attention.some((attention) => attention.status === "needs_attention"),
          ).length,
      },
      settingsConflict,
      workOrders,
      projectMaterials,
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
    const targetIds = new Map(
      preview.bundle.workOrders.map((workOrder) => [
        workOrder.id,
        resolutions[workOrder.id] === "import_copy"
          ? crypto.randomUUID()
          : workOrder.id,
      ]),
    );
    const identityTargetIds = new Map(
      preview.bundle.executionIdentities.map((identity) => [
        identity.id,
        this.store.getExecutionIdentity(identity.id) ? crypto.randomUUID() : identity.id,
      ]),
    );
    const projectMaterialTargetIds = new Map(
      preview.bundle.projectMaterials.map((material) => {
        const remappedGoalId =
          material.kind === "goal"
            ? targetIds.get(material.value) ?? material.value
            : material.value;
        const existing = this.store
          .listProjectMaterials(material.projectId)
          .some((candidate) => candidate.id === material.id);
        return [
          material.id,
          material.kind === "goal" && remappedGoalId !== material.value && existing
            ? crypto.randomUUID()
            : material.id,
        ];
      }),
    );
    this.store.database.transaction(() => {
      for (const identity of preview.bundle.executionIdentities) {
        insertHistoricalExecutionIdentity(
          this.store,
          identity,
          identityTargetIds.get(identity.id)!,
        );
      }
      for (const project of preview.bundle.projects) {
        insertProject(this.store, project);
      }
      for (const material of preview.bundle.projectMaterials) {
        insertProjectMaterial(
          this.store,
          material.kind === "goal"
            ? {
                ...material,
                id: projectMaterialTargetIds.get(material.id)!,
                value: targetIds.get(material.value) ?? material.value,
                sourceGoalId: material.sourceGoalId
                  ? targetIds.get(material.sourceGoalId) ?? material.sourceGoalId
                  : null,
              }
            : material,
        );
      }
      for (const workOrder of preview.bundle.workOrders) {
        const resolution = resolutions[workOrder.id];
        if (preview.conflictIds.has(workOrder.id) && resolution === "keep_existing") {
          skipped += 1;
          continue;
        }
        const targetId = targetIds.get(workOrder.id)!;
        insertWorkOrder(
          this.store,
          {
            ...workOrder,
            materials: workOrder.materials.map((material) => ({
              ...material,
              ...(material.projectMaterialId
                ? {
                    projectMaterialId: remapInheritedMaterialId(
                      projectMaterialTargetIds.get(material.projectMaterialId) ??
                        material.projectMaterialId,
                      targetIds,
                    ),
                  }
                : {}),
            })),
          },
          targetId,
          resolution === "import_copy",
          identityTargetIds,
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

function remapInheritedMaterialId(
  materialId: string,
  targetIds: ReadonlyMap<string, string>,
): string {
  for (const [sourceId, targetId] of targetIds) {
    const prefix = `goal-material:${sourceId}:`;
    if (materialId.startsWith(prefix)) {
      return `goal-material:${targetId}:${materialId.slice(prefix.length)}`;
    }
  }
  return materialId;
}

export function assertStateBundleSize(value: string): void {
  if (new TextEncoder().encode(value).byteLength > maxBundleBytes) {
    throw new InvalidStateBundleError("导出文件过大，无法预览");
  }
}

function exportWorkOrder(workOrder: WorkOrder): ExportedWorkOrder {
  return redactObject({
    id: workOrder.id,
    name: workOrder.name,
    description: workOrder.description,
    projectId: workOrder.projectId,
    projectMaterialSelectionConfirmed:
      workOrder.projectMaterialSelectionConfirmed,
    title: workOrder.title,
    goal: workOrder.goal,
    acceptance: workOrder.acceptance,
    status: workOrder.status,
    currentSummary: workOrder.currentSummary,
    revisionNote: workOrder.revisionNote,
    workspace: workOrder.workspace,
    materials: workOrder.materials,
    resourcePlan: {
      priority: workOrder.resourcePlan.priority,
      pace: workOrder.resourcePlan.pace,
      runWhenQuotaAvailable: workOrder.resourcePlan.runWhenQuotaAvailable,
      autoRunReason: workOrder.resourcePlan.autoRunReason,
    },
    maxRunMinutes: workOrder.maxRunMinutes,
    sourceSessions: workOrder.sourceSessions.map(exportSessionSource),
    importContext: workOrder.importContext,
    sourceContext: exportSourceContext(workOrder.sourceContext),
    currentSessionId: workOrder.currentSessionId,
    executionIdentityId: workOrder.executionIdentityId,
    sessionIdentityId: workOrder.sessionIdentityId,
    sessionHandoff: workOrder.sessionHandoff,
    sessionReferences: {
      imported: workOrder.importSource ? exportSessionSource(workOrder.importSource) : null,
      active: workOrder.sessionId,
    },
    executionMap: exportExecutionMap(workOrder.plan),
    pendingClarification: workOrder.pendingClarification,
    result: workOrder.result,
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

function exportExecutionMap(plan: WorkOrderPlan | null): WorkOrderPlan | null {
  if (!plan) return null;
  return {
    ...plan,
    stages: plan.stages.map(({ pendingVerification: _pendingVerification, ...stage }) => stage),
  };
}

function exportSessionSource(source: WorkOrderImportSource): WorkOrderImportSource {
  return {
    kind: source.kind,
    id: source.id,
    lastActiveAt: source.lastActiveAt,
    ...(source.lastReadAt !== undefined ? { lastReadAt: source.lastReadAt } : {}),
    ...(source.executionIdentityId
      ? { executionIdentityId: source.executionIdentityId }
      : {}),
    version: 1,
  };
}

function exportSourceContext(
  context: WorkOrderSourceContext | null,
): WorkOrderSourceContext | null {
  if (!context) return null;
  return {
    ...context,
    sessions: context.sessions.map((session) => ({
      ...session,
      source: exportSessionSource(session.source),
    })),
  };
}

function remapSourceContext(
  context: WorkOrderSourceContext,
  identityTargetIds: Map<string, string>,
): WorkOrderSourceContext {
  return {
    ...context,
    sessions: context.sessions.map((session) => ({
      ...session,
      source: {
        ...session.source,
        ...(session.source.executionIdentityId
          ? {
              executionIdentityId:
                identityTargetIds.get(session.source.executionIdentityId) ??
                session.source.executionIdentityId,
            }
          : {}),
      },
    })),
  };
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
    .replace(
      /\bAuthorization\s*:\s*(Basic|Bearer)\s+[^\s,;，；。]+/gi,
      "Authorization: $1 [已隐藏凭据]",
    )
    .replace(/\b(Set-Cookie|Cookie)\s*:\s*[^\r\n]+/gi, "$1: [已隐藏凭据]")
    .replace(/\bBearer\s+[^\s,;，；。]+/gi, "Bearer [已隐藏凭据]")
    .replace(
      /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi,
      "[已隐藏私钥]",
    )
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[opsu]_[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_-]{8,}|AKIA[A-Z0-9]{12,}|AIza[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g, "[已隐藏凭据]")
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|TOKEN|PASSWORD|SECRET|CREDENTIALS?))\s*[:=]\s*[^\s,;&]+/gi,
      "$1=[已隐藏凭据]",
    )
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|cookie|session(?:[_-]?cookie)?)\s*[:=]\s*[^\s,;&，；。]+/gi, "$1=[已隐藏凭据]")
    .replace(
      /(?:^|[\s"'(])(?:\/?[^\s"'<>]+\/)*(?:auth|credentials?|cookies?)\.json\b/gi,
      (candidate) => `${candidate[0]?.match(/\s|["'(]/) ? candidate[0] : ""}[已隐藏认证文件]`,
    );
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
      if (/(token|key|secret|password|signature|credential|auth|cookie|session)/i.test(key)) {
        url.searchParams.set(key, "[已隐藏凭据]");
      }
    }
    return url.toString();
  } catch {
    return value;
  }
}

function inspectReferences(
  workOrder: ExportedWorkOrder,
  checkpointAvailability: ReadonlyMap<string, boolean>,
): RestoreAttention[] {
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
  if (workOrder.resourcePlan.runWhenQuotaAvailable) {
    attention.push({
      kind: "resource",
      label: "自动运行",
      location: workOrder.title,
      status: "needs_attention",
      reason: "恢复不会沿用自动运行授权，请重新确认后手动开启",
    });
  }
  for (const material of workOrder.materials) {
    if (["repository", "folder", "file", "image", "link"].includes(material.kind)) {
      inspectLocation(attention, "reference", material.kind, material.value, material.kind);
    }
  }
  for (const stage of workOrder.executionMap?.stages ?? []) {
    if (stage.verificationCommand) {
      attention.push({
        kind: "command",
        label: `验证命令 · ${stage.outcome}`,
        location: stage.verificationCommand,
        status: "needs_attention",
        reason: "恢复不会直接启用命令，请在计划中重新确认",
      });
    }
    for (const reference of [...stage.materials, ...stage.artifacts]) {
      inspectLocation(attention, "reference", reference.label, reference.location, reference.type);
    }
  }
  for (const checkpoint of workOrder.checkpoints) {
    if (!checkpointAvailability.get(checkpointKey(workOrder.workspace, checkpoint.treeHash))) {
      attention.push({
        kind: "reference",
        label: "检查点",
        location: checkpoint.treeHash,
        status: "needs_attention",
        reason: "本机工作空间中找不到这个 Git 检查点引用",
      });
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

function inspectProjectMaterial(material: ProjectMaterial): RestoreAttention[] {
  const attention: RestoreAttention[] = [];
  if (["repository", "folder", "file", "image", "link"].includes(material.kind)) {
    inspectLocation(attention, "reference", material.label, material.value, material.kind);
  }
  return attention;
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

function inspectCheckpointAvailability(
  workOrders: ExportedWorkOrder[],
): Map<string, boolean> {
  const result = new Map<string, boolean>();
  const hashesByWorkspace = new Map<string, Set<string>>();
  for (const workOrder of workOrders) {
    const workspace = workOrder.workspace;
    for (const checkpoint of workOrder.checkpoints) {
      result.set(checkpointKey(workspace, checkpoint.treeHash), false);
      if (workspace?.kind !== "git" || !isReadableLocalPath(workspace.path)) continue;
      let hashes = hashesByWorkspace.get(workspace.path);
      if (!hashes) {
        if (hashesByWorkspace.size >= maxGitWorkspacesToInspect) continue;
        hashes = new Set();
        hashesByWorkspace.set(workspace.path, hashes);
      }
      hashes.add(checkpoint.treeHash);
    }
  }
  for (const [workspacePath, hashes] of hashesByWorkspace) {
    const ordered = [...hashes];
    const checked = Bun.spawnSync(
      ["git", "-C", workspacePath, "cat-file", "--batch-check=%(objectname) %(objecttype)"],
      {
        env: {
          ...process.env,
          GIT_NO_LAZY_FETCH: "1",
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
        },
        stdin: Buffer.from(`${ordered.map((hash) => `${hash}^{tree}`).join("\n")}\n`),
        stdout: "pipe",
        stderr: "pipe",
        timeout: checkpointInspectionTimeoutMs,
      },
    );
    if (checked.exitCode !== 0) continue;
    const lines = checked.stdout.toString().trimEnd().split("\n");
    ordered.forEach((hash, index) => {
      result.set(
        checkpointKey({ kind: "git", path: workspacePath }, hash),
        lines[index]?.endsWith(" tree") === true,
      );
    });
  }
  return result;
}

function checkpointKey(
  workspace: WorkOrderWorkspace | null,
  treeHash: string,
): string {
  return `${workspace?.kind ?? "none"}\0${workspace?.path ?? ""}\0${treeHash}`;
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
  const projects = store
    .listProjects()
    .map(({ id, updatedAt }) => [id, updatedAt])
    .sort(([left], [right]) => left.localeCompare(right));
  const projectMaterials = store
    .listProjects()
    .flatMap((project) => store.listProjectMaterials(project.id))
    .map(({ id, updatedAt }) => [id, updatedAt])
    .sort(([left], [right]) => left.localeCompare(right));
  const workOrders = store
      .list()
      .map(({ id, updatedAt }) => [id, updatedAt])
      .sort(([left], [right]) => left.localeCompare(right));
  const executionIdentities = store
    .listExecutionIdentities()
    .map(({ id, status, updatedAt }) => [id, status, updatedAt])
    .sort(([left], [right]) => left.localeCompare(right));
  const checkpoints = store.database
    .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM work_order_checkpoints")
    .get()?.count ?? 0;
  const decisions = store.database
    .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM work_order_conversation")
    .get()?.count ?? 0;
  return JSON.stringify({
    projects,
    projectMaterials,
    workOrders,
    executionIdentities,
    checkpoints,
    decisions,
    executionSettings: store.getExecutionSettings(),
    executionMapView: store.getExecutionMapView(),
  });
}

function insertHistoricalExecutionIdentity(
  store: WorkOrderStore,
  identity: ExportedExecutionIdentityReference,
  id: string,
): void {
  store.database
    .query(`
      INSERT INTO execution_identities (
        id, tool, label, identity_status, home_kind, managed_home_path,
        account_fingerprint, login_state, capabilities_json,
        last_observed_at, created_at, updated_at, removed_at
      ) VALUES (?, 'codex', ?, 'removed', ?, NULL, NULL, 'signed_out', '[]', NULL, ?, ?, ?)
    `)
    .run(
      id,
      identity.label,
      identity.homeKind,
      identity.createdAt,
      identity.updatedAt,
      identity.updatedAt,
    );
}

function insertProject(store: WorkOrderStore, project: Project): void {
  const existing = store.getProject(project.id);
  if (existing) {
    if (!sameProject(existing, project)) {
      throw new InvalidStateBundleError(`项目 ${project.id} 与本机同 ID 项目不一致`);
    }
    return;
  }
  store.database
    .query(`
      INSERT INTO projects (id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `)
    .run(project.id, project.name, project.createdAt, project.updatedAt);
}

function sameProject(left: Project, right: Project): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt
  );
}

function insertProjectMaterial(store: WorkOrderStore, material: ProjectMaterial): void {
  const existing = store
    .listProjectMaterials(material.projectId)
    .find((candidate) => candidate.id === material.id);
  if (existing) {
    if (!sameProjectMaterial(existing, material)) {
      throw new InvalidStateBundleError(`项目素材 ${material.id} 与本机数据不一致`);
    }
    return;
  }
  store.database
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
}

function sameProjectMaterial(left: ProjectMaterial, right: ProjectMaterial): boolean {
  return (
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.kind === right.kind &&
    left.label === right.label &&
    left.value === right.value &&
    left.sourceGoalId === right.sourceGoalId &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt
  );
}

function prunePreviews(previews: Map<string, PendingPreview>): void {
  while (previews.size > 10) previews.delete(previews.keys().next().value!);
}

function insertWorkOrder(
  store: WorkOrderStore,
  source: ExportedWorkOrder,
  id: string,
  copy: boolean,
  identityTargetIds: ReadonlyMap<string, string>,
): void {
  const sourceSessions = source.sourceSessions.map((sourceSession) => ({
    kind: sourceSession.kind,
    id: sourceSession.id,
    lastActiveAt: sourceSession.lastActiveAt,
    ...(sourceSession.lastReadAt !== undefined
      ? { lastReadAt: sourceSession.lastReadAt }
      : {}),
    ...(sourceSession.executionIdentityId
      ? {
          executionIdentityId:
            identityTargetIds.get(sourceSession.executionIdentityId) ??
            sourceSession.executionIdentityId,
        }
      : {}),
    version: 1 as const,
  }));
  for (const sourceSession of sourceSessions) {
    const owner = findSourceSessionOwner(store, sourceSession);
    if (owner) {
      throw new InvalidStateBundleError(
        `来源会话 ${sourceSession.id} 已属于本机另一个目标`,
      );
    }
  }
  const needsReconfirmation = ["ready", "running", "interrupted"].includes(source.status);
  const status = needsReconfirmation
    ? source.executionMap
      ? "ready"
      : "draft"
    : source.status;
  const summary = needsReconfirmation
    ? "已恢复目标状态；请确认计划、工作空间和资源后再运行"
    : source.currentSummary;
  const executionMap = safeRestoredPlan(source.executionMap);
  const resourcePlan = {
    ...source.resourcePlan,
    runWhenQuotaAvailable: false,
    autoRunReason: null,
  };
  const runNumber = source.checkpoints.reduce(
    (maximum, checkpoint) => Math.max(maximum, checkpoint.runNumber),
    0,
  );
  const executionIdentityId = source.executionIdentityId
    ? identityTargetIds.get(source.executionIdentityId) ?? source.executionIdentityId
    : null;
  const sessionIdentityId = source.sessionIdentityId
    ? identityTargetIds.get(source.sessionIdentityId) ?? source.sessionIdentityId
    : null;
  const sessionHandoff = source.sessionHandoff
    ? {
        ...source.sessionHandoff,
        fromExecutionIdentityId:
          identityTargetIds.get(source.sessionHandoff.fromExecutionIdentityId) ??
          source.sessionHandoff.fromExecutionIdentityId,
      }
    : null;
  const sourceContext = source.sourceContext
    ? remapSourceContext(source.sourceContext, identityTargetIds)
    : null;
  store.database
    .query(`
      INSERT INTO work_orders (
        id, title, project_id, project_materials_confirmed,
        repository_path, workspace_kind, materials_json,
        source_sessions_json, import_source_json, import_context_json,
        source_context_json,
        execution_identity_id, session_identity_id, session_handoff_json,
        resource_plan_json, goal, acceptance, status,
        current_summary, plan_json, clarification_json, result_json,
        revision_note, worktree_path, execution_branch, base_commit, session_id,
        run_status, run_started_at, run_ended_at, run_pid, run_number,
        runtime_ms, runtime_updated_at, max_run_minutes, last_error,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?
      )
    `)
    .run(
      id,
      copy ? `${source.name}（恢复副本）` : source.name,
      source.projectId,
      source.projectMaterialSelectionConfirmed ? 1 : 0,
      source.workspace?.path ?? "",
      source.workspace?.kind ?? null,
      JSON.stringify(source.materials),
      JSON.stringify(sourceSessions),
      sourceSessions[0]
        ? JSON.stringify(sourceSessions[0])
        : null,
      source.importContext ? JSON.stringify(source.importContext) : null,
      sourceContext ? JSON.stringify(sourceContext) : null,
      executionIdentityId,
      sessionIdentityId,
      sessionHandoff ? JSON.stringify(sessionHandoff) : null,
      JSON.stringify(resourcePlan),
      source.description,
      source.acceptance,
      status,
      summary,
      executionMap ? JSON.stringify(executionMap) : null,
      source.pendingClarification ? JSON.stringify(source.pendingClarification) : null,
      source.result ? JSON.stringify(source.result) : null,
      source.revisionNote,
      null,
      null,
      null,
      source.currentSessionId,
      null,
      null,
      null,
      null,
      runNumber,
      0,
      null,
      source.maxRunMinutes,
      null,
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

function findSourceSessionOwner(
  store: WorkOrderStore,
  target: Pick<WorkOrderImportSource, "kind" | "id">,
): WorkOrder | null {
  return (
    store.list().find((workOrder) =>
      workOrder.sourceSessions.some(
        (source) => source.kind === target.kind && source.id === target.id,
      ),
    ) ?? null
  );
}

function safeRestoredPlan(plan: WorkOrderPlan | null): WorkOrderPlan | null {
  if (!plan) return null;
  return {
    ...plan,
    confirmationRequired: true,
    stages: plan.stages.map((stage) => {
      const { verificationCommand: _verificationCommand, ...restored } = stage;
      return {
        ...restored,
        status: stage.status === "running" ? "response" : stage.status,
        statusReason:
          stage.status === "running"
            ? "恢复后需重新确认并启动"
            : stage.statusReason,
      };
    }),
  };
}

function parseBundle(value: unknown): LocalStateBundle {
  const bundle = object(value, "导出文件格式无法识别");
  if (
    bundle.format !== bundleFormat ||
    (bundle.version !== 1 &&
      bundle.version !== 2 &&
      bundle.version !== 3 &&
      bundle.version !== 4)
  ) {
    throw new InvalidStateBundleError("导出文件版本不受支持");
  }
  const version = bundle.version as BundleVersion;
  exactKeys(
    bundle,
    version === 4
      ? ["format", "version", "exportedAt", "settings", "projects", "projectMaterials", "executionIdentities", "workOrders"]
      : version === 3
      ? ["format", "version", "exportedAt", "settings", "projects", "projectMaterials", "workOrders"]
      : version === 2
      ? ["format", "version", "exportedAt", "settings", "projects", "workOrders"]
      : ["format", "version", "exportedAt", "settings", "workOrders"],
  );
  const exportedAt = dateString(bundle.exportedAt);
  const settingsObject = object(bundle.settings, "本机设置格式无法识别");
  exactKeys(settingsObject, ["maxConcurrency", "executionMapView"]);
  const maxConcurrency = integer(settingsObject.maxConcurrency, 1, 32);
  const executionMapView = oneOf(settingsObject.executionMapView, ["map", "list"] as const);
  if (!Array.isArray(bundle.workOrders) || bundle.workOrders.length > maxWorkOrders) {
    throw new InvalidStateBundleError("目标列表格式无法识别");
  }
  const projects = version >= 2
    ? array(bundle.projects, parseProject, maxWorkOrders)
    : [];
  const projectMaterials = version >= 3
    ? array(bundle.projectMaterials, parseProjectMaterial, 10_000)
    : [];
  const executionIdentities = version === 4
    ? array(bundle.executionIdentities, parseExecutionIdentityReference, maxExecutionIdentities)
    : [];
  const workOrders = bundle.workOrders.map((workOrder) => parseWorkOrder(workOrder, version));
  if (version === 1) assignLegacySourceOwnership(workOrders);
  const projectIds = new Set(projects.map((project) => project.id));
  if (projectIds.size !== projects.length) {
    throw new InvalidStateBundleError("项目标识不能重复");
  }
  if (workOrders.some((workOrder) => workOrder.projectId && !projectIds.has(workOrder.projectId))) {
    throw new InvalidStateBundleError("目标关联了导出文件中不存在的项目");
  }
  if (projectMaterials.some((material) => !projectIds.has(material.projectId))) {
    throw new InvalidStateBundleError("项目素材关联了导出文件中不存在的项目");
  }
  if (new Set(projectMaterials.map((material) => material.id)).size !== projectMaterials.length) {
    throw new InvalidStateBundleError("项目素材标识不能重复");
  }
  const workOrdersById = new Map(workOrders.map((workOrder) => [workOrder.id, workOrder]));
  for (const material of projectMaterials) {
    if (material.kind === "goal") {
      const sourceGoal = material.sourceGoalId
        ? workOrdersById.get(material.sourceGoalId)
        : null;
      if (
        material.sourceGoalId !== material.value ||
        !sourceGoal
      ) {
        throw new InvalidStateBundleError("目标引用素材关联了无效的来源目标");
      }
    } else if (material.sourceGoalId !== null) {
      throw new InvalidStateBundleError("非目标素材不能关联来源目标");
    }
  }
  const materialProjects = new Map(
    projectMaterials.map((material) => [material.id, material.projectId]),
  );
  for (const workOrder of workOrders) {
    if (!workOrder.projectId) continue;
    for (const material of workOrder.materials) {
      if (!material.projectMaterialId) {
        const inheritedId = `goal-material:${workOrder.id}:${material.id}`;
        if (materialProjects.has(inheritedId)) {
          throw new InvalidStateBundleError("项目素材标识发生冲突");
        }
        materialProjects.set(inheritedId, workOrder.projectId);
      }
    }
  }
  for (const workOrder of workOrders) {
    for (const material of workOrder.materials) {
      if (
        material.projectMaterialId &&
        materialProjects.get(material.projectMaterialId) !== workOrder.projectId
      ) {
        throw new InvalidStateBundleError("目标关联了导出文件中不存在的项目素材");
      }
    }
  }
  const sourceSessionIds = new Set<string>();
  for (const workOrder of workOrders) {
    for (const source of workOrder.sourceSessions) {
      const key = `${source.kind}:${source.id}`;
      if (sourceSessionIds.has(key)) {
        throw new InvalidStateBundleError(`来源会话 ${source.id} 被多个目标重复使用`);
      }
      sourceSessionIds.add(key);
    }
  }
  const executionIdentityIds = new Set(
    executionIdentities.map((identity) => identity.id),
  );
  if (executionIdentityIds.size !== executionIdentities.length) {
    throw new InvalidStateBundleError("Codex 账号引用标识不能重复");
  }
  for (const workOrder of workOrders) {
    const referencedIdentityIds = [
      workOrder.executionIdentityId,
      workOrder.sessionIdentityId,
      workOrder.sessionHandoff?.fromExecutionIdentityId ?? null,
      ...workOrder.sourceSessions.map((source) => source.executionIdentityId ?? null),
      ...(workOrder.sourceContext?.sessions.map((session) => session.source.executionIdentityId ?? null) ?? []),
    ].filter((id): id is string => id !== null);
    if (referencedIdentityIds.some((id) => !executionIdentityIds.has(id))) {
      throw new InvalidStateBundleError("目标引用了导出文件中不存在的 Codex 账号");
    }
  }
  return {
    format: bundleFormat,
    version,
    exportedAt,
    settings: { maxConcurrency, executionMapView },
    projects,
    projectMaterials,
    executionIdentities,
    workOrders,
  };
}

function assignLegacySourceOwnership(workOrders: ExportedWorkOrder[]): void {
  const claimedSourceIds = new Set<string>();
  const stableOrder = [...workOrders].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  for (const workOrder of stableOrder) {
    workOrder.sourceSessions = workOrder.sourceSessions.filter((source) => {
      const key = `${source.kind}:${source.id}`;
      if (claimedSourceIds.has(key)) return false;
      claimedSourceIds.add(key);
      return true;
    });
  }
}

function parseProject(value: unknown): Project {
  const project = object(value, "项目格式无法识别");
  exactKeys(project, ["id", "name", "createdAt", "updatedAt"]);
  return {
    id: nonempty(project.id),
    name: nonempty(project.name),
    createdAt: dateString(project.createdAt),
    updatedAt: dateString(project.updatedAt),
  };
}

function parseProjectMaterial(value: unknown): ProjectMaterial {
  const material = object(value, "项目素材格式无法识别");
  exactKeys(material, [
    "id",
    "projectId",
    "kind",
    "label",
    "value",
    "sourceGoalId",
    "createdAt",
    "updatedAt",
  ]);
  return {
    id: nonempty(material.id),
    projectId: nonempty(material.projectId),
    kind: oneOf(material.kind, projectMaterialKinds),
    label: nonempty(material.label),
    value: nonempty(material.value),
    sourceGoalId: nullableString(material.sourceGoalId),
    createdAt: dateString(material.createdAt),
    updatedAt: dateString(material.updatedAt),
  };
}

function parseExecutionIdentityReference(
  value: unknown,
): ExportedExecutionIdentityReference {
  const identity = object(value, "Codex 账号引用格式无法识别");
  exactKeys(identity, [
    "id",
    "tool",
    "label",
    "homeKind",
    "createdAt",
    "updatedAt",
  ]);
  return {
    id: nonempty(identity.id),
    tool: oneOf(identity.tool, ["codex"] as const),
    label: nonempty(identity.label),
    homeKind: oneOf(identity.homeKind, ["system", "managed"] as const),
    createdAt: dateString(identity.createdAt),
    updatedAt: dateString(identity.updatedAt),
  };
}

function parseWorkOrder(value: unknown, version: BundleVersion): ExportedWorkOrder {
  const item = object(value, "目标格式无法识别");
  const legacyKeys = [
    "id", "title", "goal", "acceptance", "status", "currentSummary", "revisionNote",
    "workspace", "materials", "resourcePlan", "maxRunMinutes", "sessionReferences",
    "executionMap", "pendingClarification", "checkpoints", "conversationDecisions",
    "createdAt", "updatedAt",
  ];
  exactKeys(
    item,
    version === 4
      ? [
          ...legacyKeys,
          "sourceContext",
          "name",
          "description",
          "projectId",
          "projectMaterialSelectionConfirmed",
          "sourceSessions",
          "importContext",
          "currentSessionId",
          "executionIdentityId",
          "sessionIdentityId",
          "sessionHandoff",
          "result",
        ]
      : version === 3
      ? [...legacyKeys, "name", "description", "projectId", "projectMaterialSelectionConfirmed", "sourceSessions", "importContext", "currentSessionId"]
      : version === 2
      ? [...legacyKeys, "name", "description", "projectId", "sourceSessions", "currentSessionId"]
      : legacyKeys,
    version >= 3,
  );
  const id = nonempty(item.id);
  const title = nonempty(item.title);
  const goal = nonempty(item.goal);
  const name = version >= 2 ? nonempty(item.name) : title;
  const description = version >= 2 ? nonempty(item.description) : goal;
  const acceptance = nullableString(item.acceptance);
  const status = oneOf(item.status, workOrderStatuses);
  const currentSummary = string(item.currentSummary);
  const revisionNote = nullableString(item.revisionNote);
  const workspace = parseWorkspace(item.workspace);
  const materials = array(
    item.materials,
    (material) => parseMaterial(material, version),
    10_000,
  );
  const resourcePlan = parseResourcePlan(item.resourcePlan);
  const maxRunMinutes = oneOf(item.maxRunMinutes, [30, 60, 120, 240] as const);
  const sessionReferences = parseSessionReferences(item.sessionReferences, version);
  const sourceSessions = version === 1
    ? sessionReferences.imported ? [sessionReferences.imported] : []
    : array(
        item.sourceSessions,
        (source) => parseSessionSource(source, version === 4),
        20,
      );
  if (new Set(sourceSessions.map((source) => source.kind)).size > 1) {
    throw new InvalidStateBundleError("一个目标的来源会话必须来自同一个工具");
  }
  const sourceExecutionIdentityIds = new Set(
    sourceSessions
      .map((source) => source.executionIdentityId)
      .filter((id): id is string => Boolean(id)),
  );
  if (sourceExecutionIdentityIds.size > 1) {
    throw new InvalidStateBundleError("一个目标的来源会话必须来自同一个 Codex 账号");
  }
  const importContext = version >= 3 && item.importContext !== undefined
    ? parseImportContext(item.importContext)
    : null;
  const sourceContext = version === 4 && item.sourceContext !== undefined
    ? parseSourceContext(item.sourceContext)
    : null;
  if (sourceContext) {
    const workOrderProjectId = version >= 2 ? nullableString(item.projectId) : null;
    if (sourceContext.projectId !== workOrderProjectId) {
      throw new InvalidStateBundleError("来源上下文与目标项目不一致");
    }
  }
  if (importContext) {
    const sourceSessionIds = new Set([
      ...sourceSessions.map((source) => source.id),
      ...(sourceContext?.sessions.map((session) => session.source.id) ?? []),
    ]);
    const danglingSourceId = importContext.historicalStages
      .flatMap((stage) => stage.sourceSessionIds)
      .find((sourceId) => !sourceSessionIds.has(sourceId));
    if (danglingSourceId) {
      throw new InvalidStateBundleError("会话历史节点引用了不属于当前目标的来源会话");
    }
  }
  const currentSessionId = version === 1
    ? sessionReferences.active
    : nullableString(item.currentSessionId);
  const executionIdentityId = version === 4
    ? nullableString(item.executionIdentityId)
    : null;
  const sessionIdentityId = version === 4
    ? nullableString(item.sessionIdentityId)
    : null;
  const sessionHandoff = version === 4
    ? parseSessionHandoff(item.sessionHandoff)
    : null;
  const executionMap = item.executionMap === null ? null : parsePlan(item.executionMap);
  const pendingClarification = parseClarification(item.pendingClarification);
  const result = version === 4 ? parseResult(item.result) : null;
  const checkpoints = array(
    item.checkpoints,
    parseCheckpoint,
    maxCheckpointsPerWorkOrder,
  );
  const conversationDecisions = array(item.conversationDecisions, parseDecision, 100_000);
  return {
    id,
    name,
    description,
    projectId: version >= 2 ? nullableString(item.projectId) : null,
    projectMaterialSelectionConfirmed:
      version >= 3 ? boolean(item.projectMaterialSelectionConfirmed) : false,
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
    sourceSessions,
    importContext,
    sourceContext,
    currentSessionId,
    executionIdentityId,
    sessionIdentityId,
    sessionHandoff,
    sessionReferences,
    executionMap,
    pendingClarification,
    result,
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

function parseMaterial(value: unknown, version: BundleVersion): WorkOrderMaterial {
  const material = object(value, "素材引用格式无法识别");
  exactKeys(
    material,
    version >= 3
      ? ["id", "kind", "value", "projectMaterialId"]
      : ["id", "kind", "value"],
    version >= 3,
  );
  return {
    id: nonempty(material.id),
    kind: oneOf(material.kind, workOrderMaterialKinds),
    value: nonempty(material.value),
    ...(version >= 3 && material.projectMaterialId !== undefined
      ? { projectMaterialId: nonempty(material.projectMaterialId) }
      : {}),
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
    paidApiFallbackEnabled: false,
    paidApiLimitUsd: null,
    lastPaidApiRunAt: null,
    lastBillingMode: null,
  };
}

function parseSessionReferences(
  value: unknown,
  version: BundleVersion,
): ExportedWorkOrder["sessionReferences"] {
  const references = object(value, "会话引用格式无法识别");
  exactKeys(references, ["imported", "active"]);
  let imported: WorkOrderImportSource | null = null;
  if (references.imported !== null) {
    imported = parseSessionSource(references.imported, version === 4);
  }
  return { imported, active: nullableString(references.active) };
}

function parseSessionSource(
  value: unknown,
  includeIdentityReference = false,
): WorkOrderImportSource {
  const source = object(value, "会话来源格式无法识别");
  exactKeys(
    source,
    includeIdentityReference
      ? [
          "kind",
          "id",
          "lastActiveAt",
          "lastReadAt",
          "executionIdentityId",
          "version",
        ]
      : ["kind", "id", "lastActiveAt", "lastReadAt", "version"],
    true,
  );
  if (
    !["codex_session", "claude_code_session"].includes(String(source.kind)) ||
    source.version !== 1
  ) {
    throw new InvalidStateBundleError("会话来源格式无法识别");
  }
  return {
    kind: source.kind as WorkOrderImportSource["kind"],
    id: nonempty(source.id),
    lastActiveAt: dateString(source.lastActiveAt),
    ...(source.lastReadAt === null
      ? { lastReadAt: null }
      : source.lastReadAt === undefined
        ? {}
        : { lastReadAt: dateString(source.lastReadAt) }),
    ...(includeIdentityReference && source.executionIdentityId !== undefined
      ? { executionIdentityId: nonempty(source.executionIdentityId) }
      : {}),
    version: 1,
  };
}

function parseSourceContext(value: unknown): WorkOrderSourceContext | null {
  if (value === null) return null;
  const context = object(value, "来源上下文格式无法识别");
  exactKeys(context, ["kind", "version", "createdAt", "projectId", "monitoringWork", "sessions"], true);
  if (context.kind !== "session_monitoring" || context.version !== 1) {
    throw new InvalidStateBundleError("来源上下文格式无法识别");
  }
  const sessions = array(
    context.sessions,
    (value) => {
      const session = object(value, "来源上下文会话格式无法识别");
      exactKeys(session, [
        "key",
        "source",
        "title",
        "projectLabel",
        "lastActiveAt",
        "monitoringEnabled",
        "organizationStatus",
        "lastReadPosition",
        "lastReadAt",
        "workGraphSnapshot",
      ]);
      return {
        key: nonempty(session.key),
        source: parseSessionSource(session.source, true),
        title: nonempty(session.title),
        projectLabel: nonempty(session.projectLabel),
        lastActiveAt: dateString(session.lastActiveAt),
        monitoringEnabled: boolean(session.monitoringEnabled),
        organizationStatus: oneOf(session.organizationStatus, [
          "not_started",
          "pending",
          "ready",
          "failed",
        ] as const),
        lastReadPosition:
          session.lastReadPosition === null
            ? null
            : integer(session.lastReadPosition, 0, Number.MAX_SAFE_INTEGER),
        lastReadAt: session.lastReadAt === null ? null : dateString(session.lastReadAt),
        workGraphSnapshot: session.workGraphSnapshot ?? null,
      };
    },
    20,
  );
  if (new Set(sessions.map((session) => session.key)).size !== sessions.length) {
    throw new InvalidStateBundleError("来源上下文会话标识不能重复");
  }
  const projectId = nullableString(context.projectId);
  let monitoringWork: WorkOrderSourceContext["monitoringWork"];
  if (context.monitoringWork !== undefined && context.monitoringWork !== null) {
    const work = object(context.monitoringWork, "来源监控工作格式无法识别");
    const requiredKeys = [
      "id",
      "name",
      "projectId",
      "sourceSessionKeys",
      "aggregateSnapshotRef",
      "aggregateSnapshot",
      "aggregateStatus",
      "aggregateMessage",
      "aggregateUpdatedAt",
      "updatedAt",
    ] as const;
    exactKeys(work, [...requiredKeys, "focusNodeId"], true);
    if (requiredKeys.some((key) => !(key in work))) {
      throw new InvalidStateBundleError("来源监控工作格式无法识别");
    }
    const sourceSessionKeys = array(work.sourceSessionKeys, (key) => nonempty(key), 20);
    if (new Set(sourceSessionKeys).size !== sourceSessionKeys.length) {
      throw new InvalidStateBundleError("来源监控工作会话标识不能重复");
    }
    if (
      sourceSessionKeys.length !== sessions.length ||
      sourceSessionKeys.some((key) => !sessions.some((session) => session.key === key))
    ) {
      throw new InvalidStateBundleError("来源监控工作与会话引用不一致");
    }
    const workProjectId = nullableString(work.projectId);
    if (workProjectId !== projectId) {
      throw new InvalidStateBundleError("来源监控工作与目标项目不一致");
    }
    monitoringWork = {
      id: nonempty(work.id),
      name: nonempty(work.name),
      projectId: workProjectId,
      sourceSessionKeys,
      aggregateSnapshotRef: nullableString(work.aggregateSnapshotRef),
      aggregateSnapshot: work.aggregateSnapshot ?? null,
      aggregateStatus: oneOf(work.aggregateStatus, [
        "not_started",
        "pending",
        "ready",
        "failed",
      ] as const),
      aggregateMessage: nullableString(work.aggregateMessage),
      aggregateUpdatedAt: work.aggregateUpdatedAt === null ? null : dateString(work.aggregateUpdatedAt),
      updatedAt: dateString(work.updatedAt),
      ...(work.focusNodeId === undefined
        ? {}
        : { focusNodeId: work.focusNodeId === null ? null : nonempty(work.focusNodeId) }),
    };
  }
  return {
    kind: "session_monitoring",
    version: 1,
    createdAt: dateString(context.createdAt),
    projectId,
    ...(monitoringWork ? { monitoringWork } : {}),
    sessions,
  };
}

function parseSessionHandoff(value: unknown): SessionHandoff | null {
  if (value === null) return null;
  const handoff = object(value, "会话交接历史格式无法识别");
  exactKeys(handoff, [
    "fromExecutionIdentityId",
    "previousSessionId",
    "summary",
    "currentStageId",
    "currentStageOutcome",
    "createdAt",
  ]);
  return {
    fromExecutionIdentityId: nonempty(handoff.fromExecutionIdentityId),
    previousSessionId: nullableString(handoff.previousSessionId),
    summary: string(handoff.summary),
    currentStageId: nullableString(handoff.currentStageId),
    currentStageOutcome: nullableString(handoff.currentStageOutcome),
    createdAt: dateString(handoff.createdAt),
  };
}

function parseResult(value: unknown): WorkOrderResult | null {
  if (value === null) return null;
  const result = object(value, "成果格式无法识别");
  exactKeys(
    result,
    ["planVersion", "artifacts", "git", "verifications", "completedAt"],
    true,
  );
  const git = object(result.git, "Git 成果格式无法识别");
  exactKeys(git, ["diffStat", "statusShort"]);
  const artifacts = result.artifacts === undefined
    ? undefined
    : array(result.artifacts, parseReference, 10_000);
  return {
    planVersion: integer(result.planVersion, 1, Number.MAX_SAFE_INTEGER),
    ...(artifacts ? { artifacts } : {}),
    git: {
      diffStat: string(git.diffStat),
      statusShort: string(git.statusShort),
    },
    verifications: array(result.verifications, (value) => {
      const verification = object(value, "验证成果格式无法识别");
      exactKeys(verification, [
        "stageId",
        "stageOutcome",
        "command",
        "status",
        "exitCode",
        "output",
      ]);
      return {
        stageId: nonempty(verification.stageId),
        stageOutcome: nonempty(verification.stageOutcome),
        command: nullableString(verification.command),
        status: oneOf(
          verification.status,
          ["passed", "failed", "not_configured"] as const,
        ),
        exitCode:
          verification.exitCode === null
            ? null
            : integer(
                verification.exitCode,
                Number.MIN_SAFE_INTEGER,
                Number.MAX_SAFE_INTEGER,
              ),
        output: string(verification.output),
      };
    }, 10_000),
    completedAt: dateString(result.completedAt),
  };
}

function parseImportContext(value: unknown): WorkOrderImportContext | null {
  if (value === null) return null;
  const stored = object(value, "会话整理结果格式无法识别");
  const context = {
    ...stored,
    completedHighlights: stored.completedHighlights ?? [],
    nextAction: stored.nextAction ?? null,
  };
  exactKeys(context, [
    "status", "summary", "currentState", "completedHighlights", "nextAction",
    "historicalStages", "artifacts", "monitoringContext",
    "organizedAt", "error",
  ], true);
  if ([
    "status", "summary", "currentState", "historicalStages", "artifacts", "organizedAt", "error",
  ].some((key) => !(key in context))) {
    throw new InvalidStateBundleError("会话整理结果格式无法识别");
  }
  const historicalStages = array(context.historicalStages, (item) => {
    const stage = object(item, "会话历史节点格式无法识别");
    exactKeys(stage, ["id", "outcome", "summary", "status", "sourceSessionIds"]);
    return {
      id: nonempty(stage.id),
      outcome: nonempty(stage.outcome),
      summary: nonempty(stage.summary),
      status: oneOf(stage.status, ["completed", "in_progress", "unknown"] as const),
      sourceSessionIds: array(stage.sourceSessionIds, nonempty, 20),
    };
  }, 10_000);
  if (new Set(historicalStages.map((stage) => stage.id)).size !== historicalStages.length) {
    throw new InvalidStateBundleError("会话历史节点标识不能重复");
  }
  return {
    status: oneOf(context.status, ["pending", "ready", "failed"] as const),
    summary: nullableString(context.summary),
    currentState: nullableString(context.currentState),
    completedHighlights: array(context.completedHighlights, string, 3),
    nextAction: nullableString(context.nextAction),
    historicalStages,
    artifacts: array(context.artifacts, parseReference, 10_000),
    organizedAt: context.organizedAt === null ? null : dateString(context.organizedAt),
    error: nullableString(context.error),
    ...(context.monitoringContext === undefined
      ? {}
      : { monitoringContext: parseMonitoringImportContext(context.monitoringContext) }),
  };
}

function parseMonitoringImportContext(
  value: unknown,
): WorkOrderMonitoringImportContext {
  const context = object(value, "监控来源上下文格式无法识别");
  exactKeys(context, [
    "workId", "workName", "sourceSessionKeys", "aggregateSnapshotRef",
    "aggregateStatus", "aggregateUpdatedAt", "summary", "currentState", "nextAction",
    "focusNodeId", "focusNode", "artifacts", "toolCalls", "logs",
  ]);
  let focusNode: WorkOrderMonitoringImportContext["focusNode"] = null;
  if (context.focusNode !== null) {
    const candidate = object(context.focusNode, "监控聚合焦点节点格式无法识别");
    exactKeys(candidate, [
      "id", "outcome", "summary", "status", "sourceSessionIds", "sourceSessionKeys",
    ]);
    focusNode = {
      id: nonempty(candidate.id),
      outcome: candidate.outcome === "" ? "" : string(candidate.outcome),
      summary: candidate.summary === "" ? "" : string(candidate.summary),
      status: nonempty(candidate.status),
      sourceSessionIds: array(candidate.sourceSessionIds, nonempty, 20),
      sourceSessionKeys: array(candidate.sourceSessionKeys, nonempty, 20),
    };
  }
  const artifacts = array(context.artifacts, (item) => {
    const artifact = object(item, "监控成果引用格式无法识别");
    exactKeys(artifact, [
      "id", "type", "label", "location", "sourceSessionIds", "sourceSessionKeys",
    ]);
    return {
      ...parseReference({
        id: artifact.id,
        type: artifact.type,
        label: artifact.label,
        location: artifact.location,
      }),
      sourceSessionIds: array(artifact.sourceSessionIds, nonempty, 20),
      sourceSessionKeys: array(artifact.sourceSessionKeys, nonempty, 20),
    };
  }, 8);
  return {
    workId: nonempty(context.workId),
    workName: nonempty(context.workName),
    sourceSessionKeys: array(context.sourceSessionKeys, nonempty, 20),
    aggregateSnapshotRef: nullableString(context.aggregateSnapshotRef),
    aggregateStatus: oneOf(context.aggregateStatus, [
      "not_started", "pending", "ready", "failed",
    ] as const),
    aggregateUpdatedAt: context.aggregateUpdatedAt === null
      ? null
      : dateString(context.aggregateUpdatedAt),
    summary: nullableString(context.summary),
    currentState: nullableString(context.currentState),
    nextAction: nullableString(context.nextAction),
    focusNodeId: nullableString(context.focusNodeId),
    focusNode,
    artifacts,
    toolCalls: array(context.toolCalls, nonempty, 8),
    logs: array(context.logs, nonempty, 8),
  };
}

function parsePlan(value: unknown): WorkOrderPlan {
  const plan = object(value, "执行图格式无法识别");
  exactKeys(plan, ["version", "stages", "confirmationRequired", "updatedAt"], true);
  const stages = array(plan.stages, parseStage, 10_000);
  validatePlanGraph(stages);
  return {
    version: integer(plan.version, 1, Number.MAX_SAFE_INTEGER),
    stages,
    ...(plan.confirmationRequired === true ? { confirmationRequired: true } : {}),
    updatedAt: dateString(plan.updatedAt),
  };
}

function parseStage(value: unknown): PlanStage {
  const stage = object(value, "执行节点格式无法识别");
  exactKeys(stage, [
    "id", "outcome", "scope", "verification", "verificationCommand", "dependsOn",
    "executionMethod", "workspace", "materials", "artifacts", "externalResult",
    "contextNotes", "status", "statusReason", "pendingVerification",
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
    ...(stage.pendingVerification === undefined
      ? {}
      : { pendingVerification: boolean(stage.pendingVerification) }),
  };
}

function parseReference(value: unknown): PlanReference {
  const reference = object(value, "引用格式无法识别");
  exactKeys(reference, ["id", "type", "label", "location"]);
  return {
    id: nonempty(reference.id),
    type: oneOf(
      reference.type,
      ["repository", "folder", "file", "image", "link"] as const,
    ),
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
  const treeHash = nonempty(checkpoint.treeHash);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(treeHash)) {
    throw new InvalidStateBundleError("检查点引用格式无法识别");
  }
  return {
    id: nonempty(checkpoint.id),
    kind: oneOf(checkpoint.kind, ["baseline", "stage"] as const),
    planVersion: integer(checkpoint.planVersion, 1, Number.MAX_SAFE_INTEGER),
    stageId: nullableString(checkpoint.stageId),
    stageOutcome: nullableString(checkpoint.stageOutcome),
    runNumber: integer(checkpoint.runNumber, 0, Number.MAX_SAFE_INTEGER),
    sequence: integer(checkpoint.sequence, 1, Number.MAX_SAFE_INTEGER),
    treeHash,
    createdAt: dateString(checkpoint.createdAt),
  };
}

function validatePlanGraph(stages: PlanStage[]): void {
  if (!stages.length) throw new InvalidStateBundleError("执行图不能为空");
  const ids = stages.map((stage) => stage.id);
  const known = new Set(ids);
  if (known.size !== ids.length) {
    throw new InvalidStateBundleError("执行节点标识不能重复");
  }
  for (const stage of stages) {
    if (
      new Set(stage.dependsOn).size !== stage.dependsOn.length ||
      stage.dependsOn.includes(stage.id) ||
      stage.dependsOn.some((dependency) => !known.has(dependency))
    ) {
      throw new InvalidStateBundleError("执行节点依赖无法识别");
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const dependencies = new Map(stages.map((stage) => [stage.id, stage.dependsOn]));
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new InvalidStateBundleError("执行图不能包含循环依赖");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
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
