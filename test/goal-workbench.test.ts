import { describe, expect, test } from "bun:test";
import {
  completedGoalHighlights,
  defaultGoalWorkbenchView,
  visibleGoalConversation,
} from "../public/goal-workbench.js";

describe("goal workbench presentation", () => {
  test("selects the first tab from the visible goal state", () => {
    expect(defaultGoalWorkbenchView("running")).toBe("progress");
    expect(defaultGoalWorkbenchView("response")).toBe("conversation");
    expect(defaultGoalWorkbenchView("review")).toBe("result");
    expect(defaultGoalWorkbenchView("completed")).toBe("result");
  });

  test("keeps only decisions, questions and user input in the conversation", () => {
    const messages = [
      { role: "teamline", kind: "question", content: "需要选择哪一个目录？" },
      { role: "user", kind: "reply", content: "使用 docs。" },
      { role: "teamline", kind: "decision", content: "已确认使用 docs。" },
      { role: "user", kind: "supplement", content: "同时检查移动端。" },
      { role: "teamline", kind: "progress", content: "正在读取文件。" },
    ];

    expect(visibleGoalConversation(messages).map((message) => message.content)).toEqual([
      "需要选择哪一个目录？",
      "使用 docs。",
      "已确认使用 docs。",
      "同时检查移动端。",
    ]);
  });

  test("shows at most three unique completed highlights", () => {
    const workOrder = {
      plan: {
        stages: [
          { status: "completed", outcome: "完成页面结构" },
          { status: "completed", outcome: "完成移动端" },
          { status: "running", outcome: "发布" },
        ],
      },
      importContext: {
        completedHighlights: ["完成页面结构", "确认产品范围", "整理历史会话"],
      },
    };

    expect(completedGoalHighlights(workOrder)).toEqual([
      "完成页面结构",
      "完成移动端",
      "确认产品范围",
    ]);
  });
});
