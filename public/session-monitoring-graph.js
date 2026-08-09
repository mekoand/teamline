const MAX_GRAPH_NODES = 24;
const MAX_RELATIONS = 24;
const MAX_ACTIVITY_ITEMS = 8;

/**
 * Turn one persisted organization snapshot into the small set of visual
 * objects used by the monitoring workspace. A snapshot is deliberately
 * treated as untrusted presentation data: unknown fields are ignored and a
 * generic nextAction never becomes a future node by itself.
 */
export function normalizeSessionMonitoringGraph(snapshot, session) {
  const value = asRecord(snapshot) ?? {};
  const graph = asRecord(value.graph) || value;
  const sourceSessionIds = [session.id];
  const nodes = [];
  const seenIds = new Set();

  const addNode = (raw, fallbackId, fallbackStatus, forcedStatus = null) => {
    const candidate = asRecord(raw);
    const outcome = text(candidate.outcome ?? candidate.title ?? candidate.label);
    if (!outcome) return null;
    const status = forcedStatus || normalizeNodeStatus(
      candidate.status ?? candidate.kind ?? fallbackStatus,
      fallbackStatus,
    );
    if (status === "future" && candidate.explicit !== true) return null;
    const id = uniqueId(text(candidate.id) || fallbackId, seenIds);
    const sourceIds = uniqueStrings(
      candidate.sourceSessionIds ?? candidate.sources ?? sourceSessionIds,
    );
    const node = {
      id,
      outcome,
      summary: text(candidate.summary ?? candidate.description),
      status,
      sourceSessionIds: sourceIds.length ? sourceIds : [...sourceSessionIds],
      estimatedProgress: progressPercent(
        candidate.estimatedProgress ?? candidate.progressEstimate ?? candidate.percent,
      ),
      explicit: status === "future",
      toolCalls: activityItems(candidate.toolCalls ?? candidate.tools, "tool"),
      logs: activityItems(candidate.logs, "log"),
      artifacts: references(candidate.artifacts),
    };
    nodes.push(node);
    return node;
  };

  const rawNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  rawNodes.slice(0, MAX_GRAPH_NODES).forEach((raw, index) => {
    addNode(raw, `node-${index + 1}`, "historical");
  });

  if (!nodes.length) {
    const historicalStages = Array.isArray(graph.historicalStages)
      ? graph.historicalStages
      : [];
    historicalStages.slice(0, MAX_GRAPH_NODES).forEach((stage, index) => {
      addNode(stage, `history-${index + 1}`, "historical");
    });
  }

  const currentNodeId = text(graph.currentNodeId);
  const currentNode = nodes.find((node) =>
    node.id === currentNodeId || node.status === "current",
  );
  if (currentNode) currentNode.status = "current";

  if (!currentNode && text(graph.currentState) && nodes.length < MAX_GRAPH_NODES) {
    addNode(
      {
        id: "current-state",
        outcome: graph.currentState,
        summary: text(graph.summary),
        sourceSessionIds,
      },
      "current-state",
      "current",
    );
  }

  const futureStages = Array.isArray(graph.futureStages)
    ? graph.futureStages
    : Array.isArray(graph.proposedNextSteps)
      ? graph.proposedNextSteps
      : [];
  futureStages.slice(0, MAX_GRAPH_NODES - nodes.length).forEach((stage, index) => {
    addNode(stage, `future-${index + 1}`, "future", "future");
  });

  if (graph.nextActionExplicit === true && text(graph.nextAction)) {
    addNode(
      {
        id: "explicit-next-action",
        outcome: graph.nextAction,
        summary: "来源会话明确提出的后续步骤",
        sourceSessionIds,
        explicit: true,
      },
      "explicit-next-action",
      "future",
    );
  }

  const normalizedCurrent = nodes.find((node) => node.status === "current") ?? null;
  const currentProgress = progressPercent(
    normalizedCurrent?.estimatedProgress ??
      graph.currentProgressPercent ??
      asRecord(graph.currentProgress)?.percent,
  );
  if (normalizedCurrent && currentProgress !== null) {
    normalizedCurrent.estimatedProgress = currentProgress;
  }

  const activities = {
    toolCalls: activityItems(graph.toolCalls ?? graph.tools, "tool"),
    logs: activityItems(graph.logs, "log"),
  };
  const inferredRelations = relationItems(
    graph.inferredRelations ?? graph.crossSessionRelations ?? graph.relations,
  );

  return {
    description: text(graph.description),
    summary: text(graph.summary),
    currentState: text(graph.currentState),
    nextAction: text(graph.nextAction),
    nodes,
    inferredRelations,
    artifacts: references(graph.artifacts),
    activities,
    enumerablePlan: enumerablePlan(graph.enumerablePlan),
  };
}

/**
 * Merge independently organized source sessions into one project view. The
 * lanes stay independent; only explicitly supplied inferred relations may
 * cross from one lane to another.
 */
export function buildMonitoringProjectGraph(sessions) {
  const lanes = (Array.isArray(sessions) ? sessions : [])
    .filter((session) => session?.monitoringEnabled)
    .map((session) => {
      const graph = normalizeSessionMonitoringGraph(session.workGraphSnapshot, session);
      return {
        session,
        graph,
        nodes: graph.nodes.map((node) => ({
          ...node,
          key: `${session.key}:${node.id}`,
          sessionKey: session.key,
          sessionId: session.id,
        })),
      };
    });

  const nodes = lanes.flatMap((lane) => lane.nodes);
  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
  const inferredRelations = [];
  for (const lane of lanes) {
    for (const relation of lane.graph.inferredRelations) {
      const from = resolveNodeKey(relation.from, lane, nodes, nodeByKey);
      const to = resolveNodeKey(relation.to, lane, nodes, nodeByKey);
      if (!from || !to || from.sessionKey === to.sessionKey) continue;
      const key = `${from.key}->${to.key}`;
      if (inferredRelations.some((candidate) => candidate.key === key)) continue;
      inferredRelations.push({
        ...relation,
        key,
        fromKey: from.key,
        toKey: to.key,
        label: relation.label || "推断",
      });
      if (inferredRelations.length >= MAX_RELATIONS) break;
    }
    if (inferredRelations.length >= MAX_RELATIONS) break;
  }

  const artifacts = [];
  const artifactKeys = new Set();
  for (const lane of lanes) {
    const laneArtifacts = [
      ...lane.graph.artifacts,
      ...lane.nodes.flatMap((node) => node.artifacts),
    ];
    for (const artifact of laneArtifacts) {
      const key = `${lane.session.key}:${artifact.id || artifact.location}`;
      if (artifactKeys.has(key)) continue;
      artifactKeys.add(key);
      artifacts.push({
        ...artifact,
        key,
        sessionKey: lane.session.key,
        sourceSessionIds: artifact.sourceSessionIds.length
          ? artifact.sourceSessionIds
          : [lane.session.id],
      });
    }
  }

  const activities = {
    toolCalls: mergeActivityItems(lanes.flatMap((lane) => [
      ...lane.graph.activities.toolCalls,
      ...lane.nodes.flatMap((node) => node.toolCalls),
    ])),
    logs: mergeActivityItems(lanes.flatMap((lane) => [
      ...lane.graph.activities.logs,
      ...lane.nodes.flatMap((node) => node.logs),
    ])),
  };

  const plans = lanes
    .map((lane) => lane.graph.enumerablePlan)
    .filter(Boolean);
  const overallProgress = plans.length === lanes.length && plans.length > 0
    ? {
        completed: plans.reduce((total, plan) => total + plan.completed, 0),
        total: plans.reduce((total, plan) => total + plan.total, 0),
      }
    : null;
  if (overallProgress && overallProgress.total > 0) {
    overallProgress.percent = Math.round(
      (overallProgress.completed / overallProgress.total) * 100,
    );
  }

  return {
    lanes,
    nodes,
    inferredRelations,
    artifacts,
    activities,
    overallProgress,
  };
}

export function monitoringProjectEntries(sessions, projects) {
  const projectById = new Map(
    (Array.isArray(projects) ? projects : []).map((project) => [project.id, project]),
  );
  const grouped = new Map();
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const key = session.projectId && projectById.has(session.projectId)
      ? session.projectId
      : "unclassified";
    const current = grouped.get(key) ?? [];
    current.push(session);
    grouped.set(key, current);
  }
  return [...grouped.entries()].map(([key, groupedSessions]) => ({
    key,
    name: key === "unclassified" ? "未归类" : projectById.get(key)?.name ?? "未归类",
    sessions: groupedSessions,
  }));
}

export function monitoringProjectEntriesForSelection(sessions, projects, requestedProjectId) {
  const entries = monitoringProjectEntries(sessions, projects);
  if (!requestedProjectId || requestedProjectId === "unclassified") return entries;
  if (entries.some((entry) => entry.key === requestedProjectId)) return entries;
  const project = (Array.isArray(projects) ? projects : [])
    .find((candidate) => candidate.id === requestedProjectId);
  if (!project) return entries;
  return [{ key: project.id, name: project.name, sessions: [] }, ...entries];
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueStrings(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))]
    : [];
}

function uniqueId(value, seen) {
  const base = value || `node-${seen.size + 1}`;
  let id = base;
  let suffix = 2;
  while (seen.has(id)) id = `${base}-${suffix++}`;
  seen.add(id);
  return id;
}

function normalizeNodeStatus(value, fallback) {
  const normalized = String(value || fallback).toLowerCase();
  if (["future", "proposed", "queued", "next"].includes(normalized)) return "future";
  if (["current", "in_progress", "running", "active"].includes(normalized)) return "current";
  return "historical";
}

function progressPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || value > 100) return null;
  return Math.round(value);
}

function enumerablePlan(value) {
  const plan = asRecord(value);
  if (!plan || !Number.isInteger(plan.completed) || !Number.isInteger(plan.total)) return null;
  if (plan.total <= 0 || plan.completed < 0 || plan.completed > plan.total) return null;
  return { completed: plan.completed, total: plan.total };
}

function activityItems(value, kind) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => {
      if (typeof item === "string") {
        const label = text(item);
        return label ? { id: `${kind}-${index + 1}`, label, kind } : null;
      }
      const record = asRecord(item);
      if (!record) return null;
      const label = text(record.label ?? record.summary ?? record.message ?? record.name);
      return label
        ? {
            id: text(record.id) || `${kind}-${index + 1}`,
            label,
            kind,
            sourceSessionIds: uniqueStrings(record.sourceSessionIds),
            nodeId: text(record.nodeId),
          }
        : null;
    })
    .filter(Boolean)
    .slice(0, MAX_ACTIVITY_ITEMS);
}

function mergeActivityItems(items) {
  const seen = new Set();
  return items
    .filter((item) => {
      const key = `${item.kind}:${item.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_ACTIVITY_ITEMS);
}

function relationItems(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => {
      const record = asRecord(item);
      if (!record) return null;
      const from = text(record.from ?? record.fromNodeId ?? record.source);
      const to = text(record.to ?? record.toNodeId ?? record.target);
      if (!from || !to) return null;
      return {
        id: text(record.id) || `inferred-${index + 1}`,
        from,
        to,
        label: text(record.label) || "推断",
      };
    })
    .filter(Boolean)
    .slice(0, MAX_RELATIONS);
}

function references(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => {
      const record = asRecord(item);
      if (!record) return null;
      const location = text(record.location ?? record.path ?? record.url);
      const label = text(record.label ?? location);
      if (!location || !label) return null;
      return {
        id: text(record.id) || `artifact-${index + 1}`,
        type: text(record.type) || "file",
        label,
        location,
        sourceSessionIds: uniqueStrings(record.sourceSessionIds),
      };
    })
    .filter(Boolean)
    .slice(0, MAX_ACTIVITY_ITEMS);
}

function resolveNodeKey(value, lane, nodes, nodeByKey) {
  const id = text(value);
  if (!id) return null;
  if (nodeByKey.has(id)) return nodeByKey.get(id);
  const laneMatch = lane.nodes.find((node) => node.id === id);
  if (laneMatch) return laneMatch;
  const matches = nodes.filter((node) => node.id === id);
  return matches.length === 1 ? matches[0] : null;
}
