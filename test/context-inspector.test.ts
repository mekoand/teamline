import { describe, expect, test } from "bun:test";
import {
  clearContextInspector,
  closeContextInspector,
  createContextInspectorState,
  refreshContextInspector,
  selectContextInspector,
  setContextInspectorBusy,
} from "../public/context-inspector.js";

describe("context inspector state", () => {
  test("starts closed and opens only after an explicit selection", () => {
    const initial = createContextInspectorState();
    expect(initial).toEqual({ open: false, selection: null, closedByUser: false, busy: false });

    const opened = selectContextInspector(initial, { type: "stage", id: "stage-a" });
    expect(opened).toEqual({
      open: true,
      selection: { type: "stage", id: "stage-a" },
      closedByUser: false,
      busy: false,
    });
  });

  test("keeps a manual close across polling and reopens on another explicit selection", () => {
    const opened = selectContextInspector(createContextInspectorState(), {
      type: "artifact",
      id: "/tmp/result.md",
    });
    const closed = closeContextInspector(opened);
    const refreshed = refreshContextInspector(closed);

    expect(refreshed.open).toBe(false);
    expect(refreshed.closedByUser).toBe(true);
    expect(refreshed.selection).toEqual({ type: "artifact", id: "/tmp/result.md" });

    expect(selectContextInspector(refreshed, { type: "goal", id: "goal-b" })).toEqual({
      open: true,
      selection: { type: "goal", id: "goal-b" },
      closedByUser: false,
      busy: false,
    });
  });

  test("clears the selected object when navigating away", () => {
    const opened = selectContextInspector(createContextInspectorState(), {
      type: "goal",
      id: "goal-a",
    });

    expect(clearContextInspector(opened)).toEqual({
      open: false,
      selection: null,
      closedByUser: false,
      busy: false,
    });
  });

  test("keeps a busy inspector locked across polling until the operation settles", () => {
    const selected = selectContextInspector(createContextInspectorState(), {
      type: "goal",
      id: "goal-1",
    });
    const busy = setContextInspectorBusy(selected, true);

    expect(refreshContextInspector(busy)).toEqual(busy);
    expect(closeContextInspector(refreshContextInspector(busy))).toEqual(busy);

    const settled = setContextInspectorBusy(refreshContextInspector(busy), false);
    expect(closeContextInspector(settled)).toMatchObject({
      open: false,
      busy: false,
      closedByUser: true,
    });
  });
});
