import { describe, expect, test } from "bun:test";
import type { SessionMonitoringRecord } from "../src/session-monitoring";
import { aggregateSessionMonitoringWork } from "../src/session-monitoring-aggregation";

function sourceRecord(
  key: string,
  id: string,
  snapshot: unknown,
): SessionMonitoringRecord {
  return {
    key,
    sourceKind: "codex_session",
    executionIdentityId: "identity-a",
    executionIdentityLabel: "个人账号",
    id,
    title: `来源 ${id}`,
    workspacePath: "/tmp/teamline",
    sourcePath: `/tmp/${id}.jsonl`,
    sourcePosition: 100,
    sourceModifiedAt: "2026-08-09T01:00:00.000Z",
    projectLabel: "Teamline",
    lastActiveAt: "2026-08-09T01:00:00.000Z",
    availability: "available",
    message: null,
    projectId: "project-a",
    monitoringEnabled: true,
    monitoringOverride: true,
    lastDiscoveredAt: "2026-08-09T01:00:00.000Z",
    lastReadPosition: 100,
    lastReadAt: "2026-08-09T01:00:00.000Z",
    organizationStatus: "ready",
    workGraphSnapshot: snapshot,
    createdAt: "2026-08-09T01:00:00.000Z",
    updatedAt: "2026-08-09T01:00:00.000Z",
  };
}

describe("session monitoring work aggregation", () => {
  test("keeps source references and labels inferred relations", () => {
    const snapshot = aggregateSessionMonitoringWork({
      work: { sourceSessionKeys: ["source-a", "source-b"] },
      records: [
        sourceRecord("source-a", "a", {
          nodes: [
            { id: "a-current", outcome: "确认边界", status: "current", estimatedProgress: 40 },
            { id: "a-next", outcome: "准备实现", status: "future", explicit: true },
          ],
          inferredRelations: [{ from: "a-current", to: "a-next", label: "可能影响" }],
          enumerablePlan: { completed: 1, total: 2 },
        }),
        sourceRecord("source-b", "b", {
          nodes: [{ id: "b-next", outcome: "等待实现", status: "future", explicit: true }],
          enumerablePlan: { completed: 1, total: 3 },
        }),
      ],
    });

    expect(snapshot).toMatchObject({
      sourceSessionKeys: ["source-a", "source-b"],
      enumerablePlan: { completed: 2, total: 5 },
      currentProgressPercent: 40,
    });
    expect(snapshot?.nodes.map((node) => node.id)).toEqual(["source-a:a-current", "source-a:a-next", "source-b:b-next"]);
    expect(snapshot?.nodes[0]).toMatchObject({
      sourceSessionIds: ["a"],
      sourceSessionKeys: ["source-a"],
    });
    expect(snapshot?.inferredRelations).toEqual([
      expect.objectContaining({
        from: "source-a:a-current",
        to: "source-a:a-next",
        inferred: true,
        sourceSessionKeys: ["source-a"],
      }),
    ]);
  });

  test("replaces only the changed source group and retains the other source", () => {
    const previous = aggregateSessionMonitoringWork({
      work: { sourceSessionKeys: ["source-a", "source-b"] },
      records: [
        sourceRecord("source-a", "a", { nodes: [{ id: "a-1", outcome: "A 初始", status: "historical" }] }),
        sourceRecord("source-b", "b", { nodes: [{ id: "b-1", outcome: "B 保留", status: "current" }] }),
      ],
    });
    const next = aggregateSessionMonitoringWork({
      work: { sourceSessionKeys: ["source-a", "source-b"] },
      records: [
        sourceRecord("source-a", "a", { nodes: [{ id: "a-2", outcome: "A 更新", status: "current" }] }),
        sourceRecord("source-b", "b", { nodes: [{ id: "b-1", outcome: "B 保留", status: "current" }] }),
      ],
      previousSnapshot: previous,
      changedSourceKeys: ["source-a"],
    });

    expect(next?.nodes.map((node) => node.outcome)).toEqual(["B 保留", "A 更新"]);
    expect(next?.nodes.every((node) => node.sourceSessionKeys.length > 0)).toBe(true);
  });

  test("does not manufacture an overall percentage without enumerable plans", () => {
    const snapshot = aggregateSessionMonitoringWork({
      work: { sourceSessionKeys: ["source-a", "source-b"] },
      records: [
        sourceRecord("source-a", "a", { nodes: [{ id: "a", outcome: "A", status: "current" }], enumerablePlan: { completed: 1, total: 2 } }),
        sourceRecord("source-b", "b", { nodes: [{ id: "b", outcome: "B", status: "current" }] }),
      ],
    });
    expect(snapshot?.enumerablePlan).toBeNull();
  });

  test("leaves an unorganized work without a synthetic success snapshot", () => {
    expect(aggregateSessionMonitoringWork({
      work: { sourceSessionKeys: ["source-a"] },
      records: [sourceRecord("source-a", "a", null)],
    })).toBeNull();
  });
});
