export const navigationStorageKey = "teamline-client-navigation";

const modes = new Set(["monitoring", "execution"]);
const workKinds = new Set(["goal", "session"]);

export function defaultNavigationState() {
  return {
    version: 1,
    mode: "monitoring",
    projectId: null,
    workObject: null,
    leftSidebarCollapsed: false,
    rightSidebarCollapsed: false,
  };
}

export function normalizeNavigationState(value) {
  const fallback = defaultNavigationState();
  if (!value || typeof value !== "object") return fallback;
  const candidate = value;
  const workObject = candidate.workObject && typeof candidate.workObject === "object"
    && workKinds.has(candidate.workObject.kind)
    && typeof candidate.workObject.id === "string"
    && candidate.workObject.id.trim()
    ? { kind: candidate.workObject.kind, id: candidate.workObject.id.trim() }
    : null;
  return {
    version: 1,
    mode: modes.has(candidate.mode) ? candidate.mode : fallback.mode,
    projectId: typeof candidate.projectId === "string" && candidate.projectId.trim()
      ? candidate.projectId.trim()
      : null,
    workObject,
    leftSidebarCollapsed: candidate.leftSidebarCollapsed === true,
    rightSidebarCollapsed: candidate.rightSidebarCollapsed === true,
  };
}

export function chooseInitialNavigation({
  saved,
  projects = [],
  workOrders = [],
  monitoringSessions = [],
} = {}) {
  const normalized = normalizeNavigationState(saved);
  const projectIds = new Set(projects.map((project) => project.id));
  const hasUnclassified = workOrders.some((workOrder) =>
    !workOrder.projectId || !projectIds.has(workOrder.projectId),
  ) || monitoringSessions.some((session) =>
    !session.projectId || !projectIds.has(session.projectId),
  );
  const availableProjectIds = new Set(projectIds);
  if (hasUnclassified) availableProjectIds.add("unclassified");
  const dataExists = projects.length > 0 || workOrders.length > 0 || monitoringSessions.length > 0;
  const projectId = availableProjectIds.has(normalized.projectId)
    ? normalized.projectId
    : projects[0]?.id ?? (hasUnclassified ? "unclassified" : null);
  const selectedWorkObject = validWorkObject(
    normalized.workObject,
    projectId,
    normalized.mode,
    workOrders,
    monitoringSessions,
    projectIds,
  );
  return {
    ...normalized,
    projectId,
    workObject: selectedWorkObject,
    mode: dataExists ? normalized.mode : "monitoring",
  };
}

export function routeForNavigation(state) {
  const normalized = normalizeNavigationState(state);
  const query = normalized.projectId && normalized.projectId !== "unclassified"
    ? `?project=${encodeURIComponent(normalized.projectId)}`
    : "";
  if (normalized.mode === "monitoring") return `/session-monitoring${query}`;
  if (normalized.workObject?.kind === "goal") {
    return `/goals/${encodeURIComponent(normalized.workObject.id)}`;
  }
  if (normalized.projectId === "unclassified") return "/projects/unclassified";
  if (normalized.projectId) return `/projects/${encodeURIComponent(normalized.projectId)}`;
  return "/";
}

function validWorkObject(workObject, projectId, mode, workOrders, monitoringSessions, projectIds) {
  if (!workObject) return null;
  if (mode === "monitoring" && workObject.kind !== "session") return null;
  if (mode === "execution" && workObject.kind !== "goal") return null;
  if (workObject.kind === "goal") {
    const goal = workOrders.find((candidate) => candidate.id === workObject.id);
    if (!goal || normalizedProjectId(goal.projectId, projectIds) !== projectId) return null;
    return workObject;
  }
  const session = monitoringSessions.find((candidate) => candidate.key === workObject.id);
  if (!session || normalizedProjectId(session.projectId, projectIds) !== projectId) return null;
  return workObject;
}

function normalizedProjectId(projectId, projectIds) {
  return projectId && projectIds.has(projectId) ? projectId : "unclassified";
}
