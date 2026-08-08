import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { buildPlanPrompt } from "../src/codex-plan-generator";
import { buildExecutionPrompt, buildResumePrompt } from "../src/codex-runner";
import { inferWorkingLanguage } from "../src/working-language";
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
});
