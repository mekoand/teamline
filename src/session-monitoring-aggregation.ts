import type {
  SessionMonitoringRecord,
  SessionMonitoringWork,
} from "./session-monitoring";

const MAX_AGGREGATE_NODES = 48;
const MAX_AGGREGATE_RELATIONS = 24;
const MAX_AGGREGATE_REFERENCES = 24;
const MAX_AGGREGATE_ACTIVITY_ITEMS = 8;

export type SessionMonitoringAggregateNode = {
  id: string;
  outcome: string;
  summary: string;
  status: "historical" | "current" | "future";
  explicit?: true;
  estimatedProgress: number | null;
  sourceSessionIds: string[];
  sourceSessionKeys: string[];
  toolCalls?: string[];
  logs?: string[];
  artifacts?: Array<{
    id: string;
    type: string;
    label: string;
    location: string;
    sourceSessionIds: string[];
    sourceSessionKeys: string[];
  }>;
};

export type SessionMonitoringAggregateRelation = {
  id: string;
  from: string;
  to: string;
  label: string;
  inferred: true;
  sourceSessionIds: string[];
  sourceSessionKeys: string[];
};

export type SessionMonitoringAggregateSnapshot = {
  version: 1;
  description: string;
  summary: string;
  currentState: string;
  nextAction: string;
  currentProgressPercent: number | null;
  enumerablePlan: { completed: number; total: number } | null;
  currentNodeId: string | null;
  nodes: SessionMonitoringAggregateNode[];
  inferredRelations: SessionMonitoringAggregateRelation[];
  artifacts: Array<{
    id: string;
    type: string;
    label: string;
    location: string;
    sourceSessionIds: string[];
    sourceSessionKeys: string[];
  }>;
  toolCalls: string[];
  logs: string[];
  sourceSessionKeys: string[];
  sourceUpdatedAt: Record<string, string | null>;
};

type AggregateInput = {
  work: Pick<SessionMonitoringWork, "sourceSessionKeys">;
  records: SessionMonitoringRecord[];
  previousSnapshot?: unknown | null;
  changedSourceKeys?: string[];
};

/**
 * Merge source organization snapshots without reading or copying source
 * conversation content. When changedSourceKeys is supplied, only those
 * source node groups are replaced; the rest of the persisted aggregate is
 * retained as-is.
 */
export function aggregateSessionMonitoringWork(
  input: AggregateInput,
): SessionMonitoringAggregateSnapshot | null {
  const recordsByKey = new Map(input.records.map((record) => [record.key, record]));
  const sourceKeys = input.work.sourceSessionKeys.filter((key) => recordsByKey.has(key));
  if (!sourceKeys.length) return null;

  const previous = aggregateSnapshot(input.previousSnapshot);
  const hasSourceSnapshot = sourceKeys.some((key) =>
    Boolean(sourceGraph(recordsByKey.get(key)?.workGraphSnapshot)),
  );
  if (!hasSourceSnapshot && !previous) return null;
  const changed = new Set(
    input.changedSourceKeys?.filter((key) => sourceKeys.includes(key)) ?? sourceKeys,
  );
  const canIncrementallyReplace = Boolean(
    previous &&
      input.changedSourceKeys &&
      previous.sourceSessionKeys.length > 0 &&
      previous.nodes.every((node) => node.sourceSessionKeys.length > 0),
  );

  const retainedNodes = canIncrementallyReplace
    ? previous!.nodes.filter((node) =>
        !node.sourceSessionKeys.some((key) => changed.has(key)),
      )
    : [];
  const sourceFragments = sourceKeys
    .filter((key) => !canIncrementallyReplace || changed.has(key))
    .flatMap((key) => {
      const record = recordsByKey.get(key);
      return record ? [sourceFragment(record)] : [];
    });
  const nodes = [
    ...retainedNodes,
    ...sourceFragments.flatMap((fragment) => fragment.nodes),
  ]
    .slice(0, MAX_AGGREGATE_NODES);
  const fragmentsBySource = new Map(
    sourceFragments.map((fragment) => [fragment.sourceKey, fragment]),
  );
  const allFragments = sourceKeys.flatMap((key) => {
    const record = recordsByKey.get(key);
    if (!record) return [];
    return [fragmentsBySource.get(key) ?? sourceFragment(record)];
  });
  const currentNodes = nodes.filter((node) => node.status === "current");
  const currentProgress = currentNodes.length === 1
    ? currentNodes[0]!.estimatedProgress
    : null;
  const plans = sourceKeys
    .map((key) => sourceGraph(recordsByKey.get(key)?.workGraphSnapshot))
    .map((graph) => enumerablePlan(graph?.enumerablePlan))
    .filter((plan): plan is { completed: number; total: number } => Boolean(plan));
  const enumerable = plans.length === sourceKeys.length && plans.length > 0
    ? {
        completed: plans.reduce((sum, plan) => sum + plan.completed, 0),
        total: plans.reduce((sum, plan) => sum + plan.total, 0),
      }
    : null;
  const uniqueGraphs = allFragments.map((fragment) => fragment.graph).filter(Boolean);
  const inferredRelations = allFragments
    .flatMap((fragment) => fragment.relations)
    .slice(0, MAX_AGGREGATE_RELATIONS);
  const artifacts = mergeArtifacts(allFragments.flatMap((fragment) => fragment.artifacts));
  const sourceUpdatedAt = Object.fromEntries(sourceKeys.map((key) => [
    key,
    recordsByKey.get(key)?.lastReadAt ?? recordsByKey.get(key)?.updatedAt ?? null,
  ]));

  return {
    version: 1,
    description: firstText(uniqueGraphs.map((graph) => graph.description)),
    summary: joinText(uniqueGraphs.map((graph) => graph.summary)),
    currentState: joinText(uniqueGraphs.map((graph) => graph.currentState)),
    nextAction: joinText(uniqueGraphs.map((graph) => graph.nextAction)),
    currentProgressPercent: currentProgress,
    enumerablePlan: enumerable && enumerable.total > 0 ? enumerable : null,
    currentNodeId: currentNodes.length === 1 ? currentNodes[0]!.id : null,
    nodes,
    inferredRelations,
    artifacts: artifacts.slice(0, MAX_AGGREGATE_REFERENCES),
    toolCalls: uniqueStrings(allFragments.flatMap((fragment) => fragment.graph.toolCalls))
      .slice(0, MAX_AGGREGATE_ACTIVITY_ITEMS),
    logs: uniqueStrings(allFragments.flatMap((fragment) => fragment.graph.logs))
      .slice(0, MAX_AGGREGATE_ACTIVITY_ITEMS),
    sourceSessionKeys: sourceKeys,
    sourceUpdatedAt,
  };
}

function sourceFragment(record: SessionMonitoringRecord): {
  sourceKey: string;
  graph: SourceGraph;
  nodes: SessionMonitoringAggregateNode[];
  relations: SessionMonitoringAggregateRelation[];
  artifacts: SessionMonitoringAggregateSnapshot["artifacts"];
} {
  const graph = sourceGraph(record.workGraphSnapshot);
  if (!graph) {
    return {
      sourceKey: record.key,
      graph: {
        ...emptySourceGraph(),
        toolCalls: [],
        logs: [],
      },
      nodes: [],
      relations: [],
      artifacts: [],
    };
  }
  const sourceKey = record.key;
  const rawNodes = graphNodes(graph);
  const nodeIds = new Map<string, string>();
  const nodes = rawNodes
    .map((raw, index) => {
      const outcome = text(raw.outcome ?? raw.title ?? raw.label);
      if (!outcome) return null;
      const rawId = text(raw.id) || `node-${index + 1}`;
      const id = `${sourceKey}:${rawId}`;
      nodeIds.set(rawId, id);
      const status = nodeStatus(raw.status ?? raw.kind, "historical");
      if (status === "future" && raw.explicit !== true) return null;
      return {
        id,
        outcome,
        summary: text(raw.summary ?? raw.description),
        status,
        ...(status === "future" ? { explicit: true as const } : {}),
        estimatedProgress: progress(raw.estimatedProgress ?? raw.progressEstimate ?? raw.percent),
        sourceSessionIds: uniqueStrings([record.id, ...strings(raw.sourceSessionIds)]),
        sourceSessionKeys: [sourceKey],
        toolCalls: strings(raw.toolCalls ?? raw.tools),
        logs: strings(raw.logs),
        artifacts: references(raw.artifacts, record),
      } satisfies SessionMonitoringAggregateNode;
    })
    .filter((node): node is SessionMonitoringAggregateNode => Boolean(node));

  if (!nodes.some((node) => node.status === "current") && text(graph.currentState)) {
    nodes.push({
      id: `${sourceKey}:current-state`,
      outcome: text(graph.currentState),
      summary: text(graph.summary),
      status: "current",
      estimatedProgress: progress(graph.currentProgressPercent),
      sourceSessionIds: [record.id],
      sourceSessionKeys: [sourceKey],
      toolCalls: [],
      logs: [],
      artifacts: [],
    });
  }

  const relationItems = relations(graph.inferredRelations, record)
    .flatMap((relation) => {
      const from = nodeIds.get(relation.from) ?? resolveAggregateNodeId(relation.from, sourceKey);
      const to = nodeIds.get(relation.to) ?? resolveAggregateNodeId(relation.to, sourceKey);
      if (!from || !to) return [];
      return [{
        ...relation,
        from,
        to,
        inferred: true as const,
      }];
    });
  const nodeArtifacts = nodes.flatMap((node) => node.artifacts ?? []);
  const sourceNodes = nodes.length
    ? nodes
    : [{
        id: `${sourceKey}:empty`,
        outcome: "暂无可确认的关键进展",
        summary: "来源快照没有提供可展示节点",
        status: "historical" as const,
        estimatedProgress: null,
        sourceSessionIds: [record.id],
        sourceSessionKeys: [sourceKey],
        toolCalls: [],
        logs: [],
        artifacts: [],
      } satisfies SessionMonitoringAggregateNode];
  return {
    sourceKey,
    graph: {
      ...graph,
      toolCalls: strings(graph.toolCalls ?? graph.tools),
      logs: strings(graph.logs),
    },
    nodes: sourceNodes.map((node) => ({ ...node, artifacts: node.artifacts ?? [] })),
    relations: relationItems,
    artifacts: [...graphArtifacts(graph, record), ...nodeArtifacts],
  };
}

function emptySourceGraph(): SourceGraph {
  return {
    description: "",
    summary: "",
    currentState: "",
    nextAction: "",
    currentProgressPercent: null,
    enumerablePlan: null,
  };
}

type SourceGraph = {
  description: string;
  summary: string;
  currentState: string;
  nextAction: string;
  currentProgressPercent: number | null;
  enumerablePlan: unknown;
  nodes?: unknown[];
  historicalStages?: unknown[];
  futureStages?: unknown[];
  inferredRelations?: unknown[];
  toolCalls?: unknown[];
  tools?: unknown[];
  logs?: unknown[];
  artifacts?: unknown[];
};

function sourceGraph(value: unknown): SourceGraph | null {
  const root = record(value);
  if (!root) return null;
  const graph = record(root.graph) ?? root;
  return {
    description: text(graph.description),
    summary: text(graph.summary),
    currentState: text(graph.currentState),
    nextAction: text(graph.nextAction),
    currentProgressPercent: progress(
      graph.currentProgressPercent ?? record(graph.currentProgress)?.percent,
    ),
    enumerablePlan: graph.enumerablePlan,
    nodes: Array.isArray(graph.nodes) ? graph.nodes : undefined,
    historicalStages: Array.isArray(graph.historicalStages) ? graph.historicalStages : undefined,
    futureStages: Array.isArray(graph.futureStages) ? graph.futureStages : undefined,
    inferredRelations: Array.isArray(graph.inferredRelations)
      ? graph.inferredRelations
      : Array.isArray(graph.relations)
        ? graph.relations
        : undefined,
    toolCalls: Array.isArray(graph.toolCalls) ? graph.toolCalls : undefined,
    tools: Array.isArray(graph.tools) ? graph.tools : undefined,
    logs: Array.isArray(graph.logs) ? graph.logs : undefined,
    artifacts: Array.isArray(graph.artifacts) ? graph.artifacts : undefined,
  };
}

function graphNodes(graph: SourceGraph): Array<Record<string, unknown>> {
  const raw = graph.nodes?.length
    ? graph.nodes
    : [...(graph.historicalStages ?? []), ...(graph.futureStages ?? [])];
  return raw.map(record).filter((value): value is Record<string, unknown> => Boolean(value));
}

function relations(
  value: unknown[] | undefined,
  recordValue: SessionMonitoringRecord,
): Array<Omit<SessionMonitoringAggregateRelation, "from" | "to" | "inferred"> & { from: string; to: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    const relation = record(item);
    if (!relation) return [];
    const from = text(relation.from ?? relation.fromNodeId ?? relation.source);
    const to = text(relation.to ?? relation.toNodeId ?? relation.target);
    if (!from || !to) return [];
    return [{
      id: text(relation.id) || `inferred-${recordValue.key}-${index + 1}`,
      from,
      to,
      label: text(relation.label) || "推断",
      sourceSessionIds: uniqueStrings([recordValue.id, ...strings(relation.sourceSessionIds)]),
      sourceSessionKeys: [recordValue.key],
    }];
  });
}

function references(
  value: unknown,
  recordValue: SessionMonitoringRecord,
): SessionMonitoringAggregateNode["artifacts"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    const reference = record(item);
    if (!reference) return [];
    const location = text(reference.location ?? reference.path ?? reference.url);
    const label = text(reference.label ?? location);
    if (!location || !label) return [];
    return [{
      id: text(reference.id) || `artifact-${index + 1}`,
      type: text(reference.type) || "file",
      label,
      location,
      sourceSessionIds: uniqueStrings([recordValue.id, ...strings(reference.sourceSessionIds)]),
      sourceSessionKeys: [recordValue.key],
    }];
  });
}

function graphArtifacts(
  graph: SourceGraph,
  recordValue: SessionMonitoringRecord,
): SessionMonitoringAggregateSnapshot["artifacts"] {
  return references(graph.artifacts, recordValue) ?? [];
}

function mergeArtifacts(
  artifacts: SessionMonitoringAggregateSnapshot["artifacts"],
): SessionMonitoringAggregateSnapshot["artifacts"] {
  const merged = new Map<string, SessionMonitoringAggregateSnapshot["artifacts"][number]>();
  for (const artifact of artifacts) {
    const key = `${artifact.type}:${artifact.location}`;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { ...artifact });
      continue;
    }
    current.sourceSessionIds = uniqueStrings([
      ...current.sourceSessionIds,
      ...artifact.sourceSessionIds,
    ]);
    current.sourceSessionKeys = uniqueStrings([
      ...current.sourceSessionKeys,
      ...artifact.sourceSessionKeys,
    ]);
  }
  return [...merged.values()];
}

function aggregateSnapshot(value: unknown): SessionMonitoringAggregateSnapshot | null {
  const root = record(value);
  if (!root || root.version !== 1 || !Array.isArray(root.nodes)) return null;
  const nodes = root.nodes.map(record).filter((node): node is Record<string, unknown> => Boolean(node))
    .map((node) => ({
      ...node,
      sourceSessionKeys: strings(node.sourceSessionKeys),
    }))
    .filter((node) => node.sourceSessionKeys.length > 0) as SessionMonitoringAggregateNode[];
  if (!nodes.length && root.sourceSessionKeys !== undefined) return null;
  return {
    ...(root as unknown as SessionMonitoringAggregateSnapshot),
    nodes,
    sourceSessionKeys: strings(root.sourceSessionKeys),
  };
}

function resolveAggregateNodeId(value: string, sourceKey: string): string {
  const trimmed = text(value);
  return trimmed ? `${sourceKey}:${trimmed}` : "";
}

function nodeStatus(value: unknown, fallback: "historical" | "current" | "future"):
  | "historical"
  | "current"
  | "future" {
  const normalized = String(value ?? fallback).toLowerCase();
  if (["future", "proposed", "queued", "next"].includes(normalized)) return "future";
  if (["current", "in_progress", "running", "active"].includes(normalized)) return "current";
  return "historical";
}

function enumerablePlan(value: unknown): { completed: number; total: number } | null {
  const plan = record(value);
  if (
    !plan ||
    !Number.isInteger(plan.completed) ||
    !Number.isInteger(plan.total) ||
    plan.total <= 0 ||
    plan.completed < 0 ||
    plan.completed > plan.total
  ) {
    return null;
  }
  return { completed: plan.completed, total: plan.total };
}

function progress(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? Math.round(value)
    : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? uniqueStrings(value.filter((item): item is string => typeof item === "string"))
    : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function firstText(values: string[]): string {
  return uniqueStrings(values)[0] ?? "";
}

function joinText(values: string[]): string {
  return uniqueStrings(values).join("；");
}
