import { describe, expect, test } from "bun:test";
import {
  chooseInitialNavigation,
  defaultNavigationState,
  normalizeNavigationState,
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
});
