import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { buildPlanPrompt } from "../src/codex-plan-generator";
import { buildExecutionPrompt, buildResumePrompt } from "../src/codex-runner";
import { inferWorkingLanguage } from "../src/working-language";
import { buildSessionOrganizationPrompt } from "../src/session-organizer";
import { WorkOrderStore } from "../src/work-order-store";

describe("goal working language", () => {
  test("uses goal and user conversation independently from the interface language", () => {
    const english = new WorkOrderStore(new Database(":memory:")).create({
      goal: "Publish the English product experience",
      importContext: {
        status: "ready",
        summary: "历史摘要保持中文",
        currentState: "等待继续",
        historicalStages: [],
        artifacts: [],
        organizedAt: new Date().toISOString(),
        error: null,
      },
    });
    const chinese = new WorkOrderStore(new Database(":memory:")).create({
      goal: "完成英文产品体验",
      importContext: {
        status: "ready",
        summary: "Original English history stays as written",
        currentState: "Waiting to continue",
        historicalStages: [],
        artifacts: [],
        organizedAt: new Date().toISOString(),
        error: null,
      },
    });

    expect(inferWorkingLanguage(english)).toBe("English");
    expect(inferWorkingLanguage(chinese)).toBe("Simplified Chinese");
    expect(buildPlanPrompt(english)).toContain("in English");
    expect(buildPlanPrompt(english)).toContain("历史摘要保持中文");
    expect(buildPlanPrompt(chinese)).toContain("in Simplified Chinese");
    expect(buildPlanPrompt(chinese)).toContain("Original English history stays as written");
  });

  test("does not treat commands, paths, or identifiers as English prose", () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const chinese = store.create({
      goal: "修复发布流程",
      acceptance: "运行 `npm test` 和 `npm run lint`，检查 /Users/me/teamline/src/app.ts",
    });
    const english = store.create({
      goal: "Support 中文 users",
      acceptance: "Keep the existing workflow and tests",
    });

    expect(inferWorkingLanguage(chinese)).toBe("Simplified Chinese");
    expect(inferWorkingLanguage(english)).toBe("English");

    const bareCommands = store.create({
      goal: "修复发布流程",
      acceptance: "运行 npm test and npm run lint and bun test src/app.ts",
    });
    const identifiers = store.create({
      goal: "修复错误",
      acceptance: "执行 TEAMLINE_STAGE_START npm test src/app.ts --coverage",
    });
    expect(inferWorkingLanguage(bareCommands)).toBe("Simplified Chinese");
    expect(inferWorkingLanguage(identifiers)).toBe("Simplified Chinese");
  });

  test("applies the same language contract to planning, execution, and resume", () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const created = store.savePlan(
      store.create({ goal: "Ship the settings page" }).id,
      [{ outcome: "完成设置", scope: "src", verification: "check" }],
    );

    for (const prompt of [
      buildPlanPrompt(created),
      buildExecutionPrompt(created),
      buildResumePrompt(created),
    ]) {
      expect(prompt).toContain("in English");
      expect(prompt).toContain("never from Teamline's interface language");
      expect(prompt).toContain("Preserve quoted text");
    }
  });

  test("session organization preserves source history and follows the goal language", () => {
    const prompt = buildSessionOrganizationPrompt({
      name: "整理并继续中文版工作",
      sourceLabel: "Codex",
      sessions: [{
        id: "session-1",
        title: "Original English title",
        workspacePath: "/tmp/project",
        lastActiveAt: "2026-08-08T00:00:00.000Z",
        sourcePath: "/tmp/session.jsonl",
        status: "available",
      }],
    });

    expect(prompt).toContain("dominant user language in the source conversations");
    expect(prompt).toContain("Preserve quoted or mixed-language source content");
    expect(prompt).toContain("整理并继续中文版工作");
    expect(prompt).toContain("Original English title");
  });
});
