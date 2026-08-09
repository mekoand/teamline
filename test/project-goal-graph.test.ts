import { describe, expect, test } from "bun:test";
import {
  buildProjectGoalGraph,
  openGoalCreationDialog,
  projectGoalSelection,
  resolveCreationProjectId,
} from "../public/project-goal-graph.js";

describe("project goal graph", () => {
  test("exposes only confirmed plans and persisted node state", () => {
    const graph = buildProjectGoalGraph([
      {
        id: "goal-a",
        title: "完成设置",
        currentSummary: "正在执行第二节点",
        updatedAt: "2026-08-09T01:00:00.000Z",
        plan: {
          version: 2,
          confirmationRequired: false,
          stages: [
            { id: "a-1", outcome: "完成结构", status: "completed", statusReason: "验证通过", dependsOn: [] },
            { id: "a-2", outcome: "完成样式", status: "running", statusReason: "Codex 执行中", dependsOn: ["a-1"] },
            { id: "a-3", outcome: "完成验收", status: "queued", statusReason: "等待两个前置节点", dependsOn: ["a-1", "a-2"] },
          ],
        },
      },
      {
        id: "goal-b",
        title: "等待确认",
        currentSummary: "计划等待确认",
        plan: {
          version: 1,
          confirmationRequired: true,
          stages: [{ id: "b-1", outcome: "不要提前显示", status: "planning", statusReason: "等待确认并启动" }],
        },
      },
    ]);

    expect(graph).toEqual([
      {
        id: "goal-a",
        title: "完成设置",
        currentSummary: "正在执行第二节点",
        updatedAt: "2026-08-09T01:00:00.000Z",
        planVersion: 2,
        planConfirmed: true,
        stages: [
          { id: "a-1", index: 0, outcome: "完成结构", status: "completed", statusReason: "验证通过", dependsOn: [] },
          { id: "a-2", index: 1, outcome: "完成样式", status: "running", statusReason: "Codex 执行中", dependsOn: ["a-1"] },
          { id: "a-3", index: 2, outcome: "完成验收", status: "queued", statusReason: "等待两个前置节点", dependsOn: ["a-1", "a-2"] },
        ],
        edges: [
          { from: "a-1", to: "a-2" },
          { from: "a-1", to: "a-3" },
          { from: "a-2", to: "a-3" },
        ],
      },
      {
        id: "goal-b",
        title: "等待确认",
        currentSummary: "计划等待确认",
        updatedAt: null,
        planVersion: null,
        planConfirmed: false,
        stages: [],
        edges: [],
      },
    ]);
  });

  test("does not carry dependency edges between goals", () => {
    const [entry] = buildProjectGoalGraph([
      {
        id: "goal",
        name: "单个目标",
        plan: {
          stages: [{ id: "stage", outcome: "节点", status: "queued", statusReason: "等待前置节点", dependsOn: ["other-goal-stage"] }],
        },
      },
    ]);

    expect(entry).not.toHaveProperty("dependsOn");
    expect(entry.edges).toEqual([]);
    expect(entry.stages[0]?.dependsOn).toEqual([]);
  });

  test("keeps creation and node navigation inputs bound to real project and stage ids", () => {
    expect(resolveCreationProjectId("project-a", [{ id: "project-a" }])).toBe("project-a");
    expect(resolveCreationProjectId("unclassified", [{ id: "project-a" }])).toBe("");
    expect(resolveCreationProjectId("stale-project", [{ id: "project-a" }])).toBe("");
    expect(projectGoalSelection({ projectGoalId: "goal-a", projectGoalStageId: "stage-b" })).toEqual({
      goalId: "goal-a",
      stageId: "stage-b",
    });
    expect(projectGoalSelection({ projectGoalId: "goal-a" })).toEqual({
      goalId: "goal-a",
      stageId: null,
    });
    expect(projectGoalSelection({})).toBeNull();
  });

  test("opens creation with the current project selected and refreshes its materials", async () => {
    const calls: string[] = [];
    const projectSelect = { value: "" };
    const dialog = { showModal: () => calls.push("show") };
    openGoalCreationDialog({
      dialog,
      projectSelect,
      currentProjectId: "project-a",
      projects: [{ id: "project-a" }],
      populateProjectSelect: (select, selectedId) => {
        select.value = selectedId;
        calls.push(`populate:${selectedId}`);
      },
      resetProjectMaterials: () => calls.push("reset"),
      renderProjectMaterials: () => calls.push("render"),
      refreshProjectMaterials: async () => calls.push("refresh"),
    });

    await Promise.resolve();
    expect(projectSelect.value).toBe("project-a");
    expect(calls).toEqual(["populate:project-a", "reset", "render", "show", "refresh"]);
  });
});
