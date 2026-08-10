export const navigationStorageKey = "teamline-client-navigation";

const modes = new Set(["monitoring", "execution"]);
const workKinds = new Set(["goal", "session", "monitoring-work"]);

const quickNavigationKinds = new Set(["project", "monitoring-work", "goal"]);

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
  monitoringWorks = [],
} = {}) {
  const normalized = normalizeNavigationState(saved);
  const projectIds = new Set(projects.map((project) => project.id));
  const hasUnclassified = workOrders.some((workOrder) =>
    !workOrder.projectId || !projectIds.has(workOrder.projectId),
  ) || monitoringSessions.some((session) =>
    !session.projectId || !projectIds.has(session.projectId),
  ) || monitoringWorks.some((work) =>
    !work.projectId || !projectIds.has(work.projectId),
  );
  const availableProjectIds = new Set(projectIds);
  if (hasUnclassified) availableProjectIds.add("unclassified");
  const dataExists = projects.length > 0 || workOrders.length > 0 || monitoringSessions.length > 0 || monitoringWorks.length > 0;
  const projectId = availableProjectIds.has(normalized.projectId)
    ? normalized.projectId
    : projects[0]?.id ?? (hasUnclassified ? "unclassified" : null);
  const selectedWorkObject = validWorkObject(
    normalized.workObject,
    projectId,
    normalized.mode,
    workOrders,
    monitoringSessions,
    monitoringWorks,
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
  return "/projects/unclassified";
}

/**
 * Build the deliberately small client-side quick-open index. The inputs are
 * already persisted presentation records; this function never reads or
 * searches source-session contents, run events, logs, or files.
 */
export function buildQuickNavigationIndex({
  projects = [],
  workOrders = [],
  monitoringWorks = [],
} = {}) {
  const projectIds = new Set(
    projects
      .map((project) => typeof project?.id === "string" ? project.id : "")
      .filter(Boolean),
  );
  const normalizeProjectId = (projectId) =>
    typeof projectId === "string" && projectIds.has(projectId)
      ? projectId
      : "unclassified";
  const projectNameById = new Map(
    projects
      .filter((project) => typeof project?.id === "string")
      .map((project) => [project.id, String(project.name ?? "")]),
  );
  const projectItems = projects
    .filter((project) => typeof project?.id === "string" && project.id.trim())
    .map((project) => ({
      kind: "project",
      id: project.id,
      label: String(project.name ?? project.id),
      detail: "项目",
      projectId: project.id,
      projectName: String(project.name ?? project.id),
    }));
  const goalItems = workOrders
    .filter((workOrder) => typeof workOrder?.id === "string" && workOrder.id.trim())
    .map((workOrder) => {
      const projectId = normalizeProjectId(workOrder.projectId);
      return {
        kind: "goal",
        id: workOrder.id,
        label: String(workOrder.title ?? workOrder.name ?? workOrder.id),
        detail: "目标",
        projectId,
        projectName: projectNameById.get(projectId) ?? "未归类",
      };
    });
  const monitoringWorkItems = monitoringWorks
    .filter((work) => typeof work?.id === "string" && work.id.trim())
    .map((work) => {
      const projectId = normalizeProjectId(work.projectId);
      return {
        kind: "monitoring-work",
        id: work.id,
        label: String(work.name ?? work.id),
        detail: "监控工作",
        projectId,
        projectName: projectNameById.get(projectId) ?? "未归类",
      };
    });
  const hasUnclassified = [...goalItems, ...monitoringWorkItems]
    .some((item) => item.projectId === "unclassified");
  const virtualProject = hasUnclassified
    ? [{
        kind: "project",
        id: "unclassified",
        label: "未归类",
        detail: "项目",
        projectId: "unclassified",
        projectName: "未归类",
      }]
    : [];
  return [...projectItems, ...virtualProject, ...monitoringWorkItems, ...goalItems]
    .filter((item) => quickNavigationKinds.has(item.kind));
}

export function filterQuickNavigationIndex(items, query = "") {
  const normalizedQuery = String(query).trim().toLocaleLowerCase();
  if (!normalizedQuery) return [...items];
  return items.filter((item) => [item.label, item.detail, item.projectName]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase()
    .includes(normalizedQuery));
}

export function quickNavigationTarget(item, currentMode = "monitoring") {
  if (!item || !quickNavigationKinds.has(item.kind)) return null;
  if (item.kind === "project") {
    return {
      mode: modes.has(currentMode) ? currentMode : "monitoring",
      projectId: item.id,
      workObject: null,
      rightSidebarCollapsed: true,
    };
  }
  return {
    mode: item.kind === "goal" ? "execution" : "monitoring",
    projectId: item.projectId || "unclassified",
    workObject: { kind: item.kind, id: item.id },
    rightSidebarCollapsed: false,
  };
}

export function routeForNotification(notification) {
  const targetCode = typeof notification?.targetCode === "string"
    ? notification.targetCode
    : "";
  const workOrderId = typeof notification?.workOrderId === "string" && notification.workOrderId.trim()
    ? notification.workOrderId.trim()
    : null;
  const targetUrl = typeof notification?.targetUrl === "string" && notification.targetUrl.startsWith("/")
    ? notification.targetUrl
    : "/";
  if (targetCode === "resource.account") {
    const source = new URL(targetUrl, "http://teamline.local");
    const query = new URLSearchParams();
    for (const key of ["account", "goal", "project"]) {
      const value = source.searchParams.get(key);
      if (value) query.set(key, value);
    }
    return query.toString() ? `/resources?${query.toString()}` : "/resources";
  }
  if (targetCode.startsWith("goal.") && workOrderId) {
    const path = `/goals/${encodeURIComponent(workOrderId)}`;
    const stageId = typeof notification.stageId === "string" && notification.stageId.trim()
      ? notification.stageId.trim()
      : null;
    return stageId ? `${path}?stage=${encodeURIComponent(stageId)}` : path;
  }
  return targetUrl;
}

function validWorkObject(
  workObject,
  projectId,
  mode,
  workOrders,
  monitoringSessions,
  monitoringWorks,
  projectIds,
) {
  if (!workObject) return null;
  if (mode === "monitoring" && !["session", "monitoring-work"].includes(workObject.kind)) return null;
  if (mode === "execution" && workObject.kind !== "goal") return null;
  if (workObject.kind === "goal") {
    const goal = workOrders.find((candidate) => candidate.id === workObject.id);
    if (!goal || normalizedProjectId(goal.projectId, projectIds) !== projectId) return null;
    return workObject;
  }
  if (workObject.kind === "monitoring-work") {
    const work = monitoringWorks.find((candidate) => candidate.id === workObject.id);
    if (!work || normalizedProjectId(work.projectId, projectIds) !== projectId) return null;
    return workObject;
  }
  const session = monitoringSessions.find((candidate) => candidate.key === workObject.id);
  if (!session || normalizedProjectId(session.projectId, projectIds) !== projectId) return null;
  return workObject;
}

function normalizedProjectId(projectId, projectIds) {
  return projectId && projectIds.has(projectId) ? projectId : "unclassified";
}
