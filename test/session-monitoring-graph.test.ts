import { describe, expect, test } from "bun:test";
import {
  buildMonitoringProjectGraph,
  normalizeSessionMonitoringGraph,
  monitoringProjectEntries,
  monitoringProjectEntriesForSelection,
} from "../public/session-monitoring-graph.js";

function monitoredSession(key: string, title: string, snapshot: unknown, projectId = "project-a") {
  return {
    key,
    id: key,
    title,
    projectId,
    monitoringEnabled: true,
    sourceKind: "codex_session",
    executionIdentityLabel: "个人账号",
    projectLabel: "teamline",
    workGraphSnapshot: snapshot,
  };
}

describe("session monitoring work graph", () => {
  test("treats a missing organization snapshot as an empty graph", () => {
    for (const snapshot of [null, undefined]) {
      expect(normalizeSessionMonitoringGraph(snapshot, { id: "source-empty" })).toMatchObject({
        nodes: [],
        inferredRelations: [],
        artifacts: [],
        activities: { toolCalls: [], logs: [] },
        enumerablePlan: null,
      });
    }
  });

  test("keeps meaningful history and current state, and only admits explicit future steps", () => {
    const graph = normalizeSessionMonitoringGraph({
      historicalStages: [{ id: "history", outcome: "完成会话发现", status: "completed" }],
      currentState: "正在整理项目进展",
      currentProgressPercent: 42,
      nextAction: "继续观察新的来源变化",
      futureStages: [
        { id: "future", outcome: "核对移动端布局", status: "in_progress", explicit: true },
        { id: "unconfirmed", outcome: "未经确认的后续步骤", status: "unknown" },
      ],
      toolCalls: ["读取会话记录"],
      logs: ["已完成一次增量整理"],
    }, { id: "source-a" });

    expect(graph.nodes.map((node) => [node.id, node.status, node.outcome])).toEqual([
      ["history", "historical", "完成会话发现"],
      ["current-state", "current", "正在整理项目进展"],
      ["future", "future", "核对移动端布局"],
    ]);
    expect(graph.nodes.find((node) => node.status === "current")?.estimatedProgress).toBe(42);
    expect(graph.nodes.some((node) => node.outcome === "继续观察新的来源变化")).toBe(false);
    expect(graph.nodes.some((node) => node.outcome === "未经确认的后续步骤")).toBe(false);
    expect(graph.nodes.find((node) => node.id === "future")).toMatchObject({
      status: "future",
      explicit: true,
    });
    expect(graph.activities.toolCalls.map((item) => item.label)).toEqual(["读取会话记录"]);
    expect(graph.activities.logs.map((item) => item.label)).toEqual(["已完成一次增量整理"]);
  });

  test("renders independent source lanes and keeps inferred links separate", () => {
    const sessions = [
      monitoredSession("source-a", "设计会话", {
        nodes: [{ id: "a-history", outcome: "确认界面边界", status: "historical" }],
        inferredRelations: [{ from: "a-history", to: "b-current", label: "可能影响实现" }],
      }),
      monitoredSession("source-b", "实现会话", {
        nodes: [{ id: "b-current", outcome: "完成工作图骨架", status: "current" }],
      }),
    ];

    const graph = buildMonitoringProjectGraph(sessions);

    expect(graph.lanes.map((lane) => lane.session.key)).toEqual(["source-a", "source-b"]);
    expect(graph.lanes[0].nodes.map((node) => node.key)).toEqual(["source-a:a-history"]);
    expect(graph.lanes[1].nodes.map((node) => node.key)).toEqual(["source-b:b-current"]);
    expect(graph.inferredRelations).toEqual([
      expect.objectContaining({
        fromKey: "source-a:a-history",
        toKey: "source-b:b-current",
        label: "可能影响实现",
      }),
    ]);
    expect(graph.overallProgress).toBeNull();
  });

  test("shows an overall estimate only when every monitored lane has an enumerable plan", () => {
    const sessions = [
      monitoredSession("source-a", "会话 A", {
        enumerablePlan: { completed: 1, total: 2 },
        currentState: "进行中",
      }),
      monitoredSession("source-b", "会话 B", {
        enumerablePlan: { completed: 2, total: 4 },
        currentState: "进行中",
      }),
      { ...monitoredSession("source-c", "未监控", null), monitoringEnabled: false },
    ];

    expect(buildMonitoringProjectGraph(sessions).overallProgress).toEqual({
      completed: 3,
      total: 6,
      percent: 50,
    });
  });

  test("renders one lane for an explicit monitoring work and keeps source references on nodes", () => {
    const sessions = [
      monitoredSession("source-a", "会话 A", { nodes: [{ id: "a", outcome: "A 当前", status: "current" }] }),
      monitoredSession("source-b", "会话 B", { nodes: [{ id: "b", outcome: "B 当前", status: "current" }] }),
    ];
    const graph = buildMonitoringProjectGraph(sessions, [{
      id: "work-a",
      name: "合并后的工作",
      sourceSessionKeys: ["source-a", "source-b"],
      aggregateSnapshot: {
        sourceSessionKeys: ["source-a", "source-b"],
        nodes: [
          { id: "source-a:a", outcome: "A 当前", status: "current", sourceSessionKeys: ["source-a"] },
          { id: "source-b:b", outcome: "B 当前", status: "current", sourceSessionKeys: ["source-b"] },
        ],
        enumerablePlan: { completed: 2, total: 4 },
        inferredRelations: [],
      },
      aggregateStatus: "ready",
      aggregateMessage: null,
      projectId: "project-a",
    }]);

    expect(graph.lanes.map((lane) => lane.session.key)).toEqual(["work-a"]);
    expect(graph.lanes[0].nodes.map((node) => node.sourceSessionKeys[0])).toEqual(["source-a", "source-b"]);
    expect(graph.lanes[0].sourceLanes.map((lane) => [lane.source.key, lane.nodes.length])).toEqual([
      ["source-a", 1],
      ["source-b", 1],
    ]);
    expect(graph.lanes[0].aggregateLane).toBeNull();
    expect(graph.overallProgress).toEqual({ completed: 2, total: 4, percent: 50 });
  });

  test("keeps multiple shared nodes in an unconnected aggregate lane", () => {
    const sessions = [
      monitoredSession("source-a", "会话 A", null),
      monitoredSession("source-b", "会话 B", null),
    ];
    const graph = buildMonitoringProjectGraph(sessions, [{
      id: "work-a",
      name: "合并工作",
      sourceSessionKeys: ["source-a", "source-b"],
      aggregateStatus: "ready",
      aggregateSnapshot: {
        nodes: [
          { id: "shared-1", outcome: "共同节点一", sourceSessionKeys: ["source-a", "source-b"] },
          { id: "shared-2", outcome: "共同节点二", sourceSessionKeys: ["source-a", "source-b"] },
        ],
      },
      projectId: "project-a",
    }]);

    expect(graph.lanes[0].aggregateLane?.nodes.map((node) => node.outcome)).toEqual([
      "共同节点一",
      "共同节点二",
    ]);
    expect(graph.lanes[0].aggregateLane?.nodes).toHaveLength(2);
  });

  test("keeps sessions grouped by the selected project without inventing a project", () => {
    const entries = monitoringProjectEntries([
      monitoredSession("source-a", "会话 A", null, "project-a"),
      monitoredSession("source-b", "会话 B", null, "missing-project"),
    ], [{ id: "project-a", name: "Teamline" }]);

    expect(entries).toEqual([
      { key: "project-a", name: "Teamline", sessions: [expect.objectContaining({ key: "source-a" })] },
      { key: "unclassified", name: "未归类", sessions: [expect.objectContaining({ key: "source-b" })] },
    ]);
  });

  test("keeps a known empty project selected without inventing an unknown project", () => {
    expect(monitoringProjectEntriesForSelection(
      [monitoredSession("source-b", "会话 B", null, "project-b")],
      [{ id: "project-a", name: "Teamline" }, { id: "project-b", name: "发布" }],
      "project-a",
    )).toEqual([
      { key: "project-a", name: "Teamline", sessions: [] },
      { key: "project-b", name: "发布", sessions: [expect.objectContaining({ key: "source-b" })] },
    ]);
    expect(monitoringProjectEntriesForSelection(
      [],
      [{ id: "project-a", name: "Teamline" }],
      "missing-project",
    )).toEqual([]);
  });
});
