import { describe, expect, test } from "bun:test";
import {
  buildQuickNavigationIndex,
  chooseInitialNavigation,
  defaultNavigationState,
  filterQuickNavigationIndex,
  normalizeNavigationState,
  quickNavigationTarget,
  routeForNotification,
  routeForNavigation,
} from "../public/navigation-state.js";

describe("desktop navigation state", () => {
  test("normalizes modes, project ids, work objects, and panel state", () => {
    expect(normalizeNavigationState({
      mode: "invalid",
      projectId: "  project-a ",
      workObject: { kind: "goal", id: " goal-1 " },
      leftSidebarCollapsed: true,
      rightSidebarCollapsed: "yes",
    })).toEqual({
      version: 1,
      mode: "monitoring",
      projectId: "project-a",
      workObject: { kind: "goal", id: "goal-1" },
      leftSidebarCollapsed: true,
      rightSidebarCollapsed: false,
    });
  });

  test("restores a valid project and matching work object, including virtual unclassified", () => {
    const projects = [{ id: "project-a", name: "A" }];
    const workOrders = [
      { id: "goal-a", projectId: "project-a" },
      { id: "goal-unclassified", projectId: null },
    ];
    const restored = chooseInitialNavigation({
      saved: {
        ...defaultNavigationState(),
        mode: "execution",
        projectId: "missing",
        workObject: { kind: "goal", id: "goal-unclassified" },
      },
      projects,
      workOrders,
    });
    expect(restored).toMatchObject({
      mode: "execution",
      projectId: "project-a",
      workObject: null,
    });

    const unclassified = chooseInitialNavigation({
      saved: { ...defaultNavigationState(), mode: "execution", projectId: "unclassified" },
      projects,
      workOrders,
    });
    expect(unclassified.projectId).toBe("unclassified");
    expect(routeForNavigation(unclassified)).toBe("/projects/unclassified");
  });

  test("routes monitoring and execution without mixing their work object kinds", () => {
    const monitoring = chooseInitialNavigation({
      saved: {
        ...defaultNavigationState(),
        mode: "monitoring",
        projectId: "project-a",
        workObject: { kind: "goal", id: "goal-a" },
      },
      projects: [{ id: "project-a" }],
      workOrders: [{ id: "goal-a", projectId: "project-a" }],
      monitoringSessions: [{ key: "session-a", projectId: "project-a" }],
    });
    expect(monitoring.workObject).toBeNull();
    expect(routeForNavigation(monitoring)).toBe("/session-monitoring?project=project-a");

    const execution = chooseInitialNavigation({
      saved: {
        ...defaultNavigationState(),
        mode: "execution",
        projectId: "project-a",
        workObject: { kind: "goal", id: "goal-a" },
      },
      projects: [{ id: "project-a" }],
      workOrders: [{ id: "goal-a", projectId: "project-a" }],
    });
    expect(routeForNavigation(execution)).toBe("/goals/goal-a");
  });

  test("restores a monitoring work selection in the monitoring mode", () => {
    const restored = chooseInitialNavigation({
      saved: {
        ...defaultNavigationState(),
        mode: "monitoring",
        projectId: "project-a",
        workObject: { kind: "monitoring-work", id: "work-a" },
      },
      projects: [{ id: "project-a" }],
      monitoringSessions: [{ key: "session-a", projectId: "project-a" }],
      monitoringWorks: [{ id: "work-a", projectId: "project-a", sourceSessionKeys: ["session-a"] }],
    });
    expect(restored.workObject).toEqual({ kind: "monitoring-work", id: "work-a" });
    expect(routeForNavigation(restored)).toBe("/session-monitoring?project=project-a");
  });

  test("restores an unclassified monitoring work selection", () => {
    const restored = chooseInitialNavigation({
      saved: {
        ...defaultNavigationState(),
        mode: "monitoring",
        projectId: "unclassified",
        workObject: { kind: "monitoring-work", id: "work-unclassified" },
      },
      projects: [{ id: "project-a" }],
      monitoringWorks: [{ id: "work-unclassified", projectId: null }],
    });
    expect(restored).toMatchObject({
      projectId: "unclassified",
      workObject: { kind: "monitoring-work", id: "work-unclassified" },
    });
    expect(routeForNavigation(restored)).toBe("/session-monitoring");
  });

  test("indexes only projects, monitoring works, goals, and virtual unclassified", () => {
    const index = buildQuickNavigationIndex({
      projects: [{ id: "project-a", name: "Teamline" }],
      workOrders: [
        { id: "goal-a", title: "发布客户端", projectId: "project-a", description: "日志正文不应被搜索" },
        { id: "goal-unclassified", title: "未归类目标", projectId: null },
      ],
      monitoringWorks: [
        { id: "monitor-a", name: "发布监控", projectId: "project-a", sourceSessionKeys: ["session-a"] },
        { id: "monitor-unclassified", name: "未归类监控", projectId: null },
      ],
    });

    expect(index.map(({ kind, id }) => `${kind}:${id}`)).toEqual([
      "project:project-a",
      "project:unclassified",
      "monitoring-work:monitor-a",
      "monitoring-work:monitor-unclassified",
      "goal:goal-a",
      "goal:goal-unclassified",
    ]);
    expect(filterQuickNavigationIndex(index, "日志正文")).toEqual([]);
    expect(filterQuickNavigationIndex(index, "发布监控")).toEqual([
      expect.objectContaining({ kind: "monitoring-work", id: "monitor-a" }),
    ]);
  });

  test("maps explicit quick-open choices to project, mode, object, and panel state", () => {
    expect(quickNavigationTarget({ kind: "project", id: "project-a" }, "execution")).toEqual({
      mode: "execution",
      projectId: "project-a",
      workObject: null,
      rightSidebarCollapsed: true,
    });
    expect(quickNavigationTarget({ kind: "monitoring-work", id: "work-a", projectId: "project-a" })).toEqual({
      mode: "monitoring",
      projectId: "project-a",
      workObject: { kind: "monitoring-work", id: "work-a" },
      rightSidebarCollapsed: false,
    });
    expect(quickNavigationTarget({ kind: "goal", id: "goal-a", projectId: "unclassified" })).toEqual({
      mode: "execution",
      projectId: "unclassified",
      workObject: { kind: "goal", id: "goal-a" },
      rightSidebarCollapsed: false,
    });
  });

  test("routes notification clicks by stable target code and object ids", () => {
    expect(routeForNotification({
      targetCode: "goal.failure",
      workOrderId: "goal/7",
      stageId: "stage-2",
      targetUrl: "/unexpected",
    })).toBe("/goals/goal%2F7?stage=stage-2");
    expect(routeForNotification({
      targetCode: "resource.account",
      targetUrl: "/resources?account=account-a&goal=goal-7&project=project-a",
    })).toBe("/resources?account=account-a&goal=goal-7&project=project-a");
  });
});
