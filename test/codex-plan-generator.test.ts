import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexPlanGenerator } from "../src/codex-plan-generator";
import { WorkOrderStore } from "../src/work-order-store";

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

describe("Codex plan generator", () => {
  test("allows workspace-free planning from its temporary directory", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-plan-generator-test-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const executablePath = join(directory, "fake-codex");
    const capturedArgumentsPath = join(directory, "arguments.json");
    writeFileSync(
      executablePath,
      `#!/usr/bin/env bun
const args = Bun.argv.slice(2);
await Bun.write(${JSON.stringify(capturedArgumentsPath)}, JSON.stringify(args));
if (!args.includes("--skip-git-repo-check")) {
  console.error("Not inside a trusted directory and --skip-git-repo-check was not specified.");
  process.exit(1);
}
const schemaIndex = args.indexOf("--output-schema");
const schemaText = await Bun.file(args[schemaIndex + 1]).text();
if (schemaText.includes('"uniqueItems"')) {
  console.log(JSON.stringify({
    type: "error",
    message: "Invalid schema: 'uniqueItems' is not permitted."
  }));
  process.exit(1);
}
const outputIndex = args.indexOf("--output-last-message");
const workingDirectory = args[args.indexOf("--cd") + 1];
await Bun.write(args[outputIndex + 1], JSON.stringify({
  stages: [{
    id: "plan",
    outcome: "得到可确认计划",
    scope: workingDirectory + "/RESULT.md",
    verification: "检查计划内容",
    verificationCommand: null,
    dependsOn: [],
    executionMethod: "codex"
  }]
}));
`,
    );
    chmodSync(executablePath, 0o755);

    const database = new Database(":memory:");
    cleanup.push(() => database.close());
    const workOrder = new WorkOrderStore(database).create({
      goal: "生成一份计划",
      sourceSessions: [{
        kind: "codex_session",
        id: "source-session",
        lastActiveAt: "2026-08-04T01:00:00.000Z",
        lastReadAt: "2026-08-04T02:00:00.000Z",
        version: 1,
      }],
      importContext: {
        status: "ready",
        summary: "历史工作已经完成需求确认",
        currentState: "等待形成后续执行计划",
        historicalStages: [{
          id: "requirements",
          outcome: "确认需求",
          summary: "需求范围已经确定",
          status: "completed",
          sourceSessionIds: ["source-session"],
        }],
        artifacts: [],
        organizedAt: "2026-08-04T02:00:00.000Z",
        error: null,
      },
    });

    const result = await new CodexPlanGenerator(executablePath).generate(workOrder);
    const argumentsUsed = JSON.parse(readFileSync(capturedArgumentsPath, "utf8")) as string[];

    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]?.scope).toBe("RESULT.md");
    expect(argumentsUsed).toContain("--skip-git-repo-check");
    expect(argumentsUsed[argumentsUsed.indexOf("--cd") + 1]).toContain("teamline-plan-");
    expect(argumentsUsed.at(-1)).toContain("历史工作已经完成需求确认");
    expect(argumentsUsed.at(-1)).toContain("等待形成后续执行计划");
    expect(argumentsUsed.at(-1)).not.toContain(".jsonl");
    expect(argumentsUsed.at(-1)).toContain("不得把当前规划使用的临时目录写入 scope");
  });

  test("includes bounded prior result context without local details", async () => {
    const directory = mkdtempSync(join(tmpdir(), "teamline-plan-result-context-test-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const executablePath = join(directory, "fake-codex");
    const capturedArgumentsPath = join(directory, "arguments.json");
    writeFileSync(
      executablePath,
      `#!/usr/bin/env bun
const args = Bun.argv.slice(2);
await Bun.write(${JSON.stringify(capturedArgumentsPath)}, JSON.stringify(args));
const outputIndex = args.indexOf("--output-last-message");
await Bun.write(args[outputIndex + 1], JSON.stringify({
  stages: [{
    id: "revise",
    outcome: "完成调整",
    scope: "现有成果",
    verification: "检查调整结果",
    verificationCommand: null,
    dependsOn: [],
    executionMethod: "codex"
  }]
}));
`,
    );
    chmodSync(executablePath, 0o755);

    const database = new Database(":memory:");
    cleanup.push(() => database.close());
    const workOrder = new WorkOrderStore(database).create({ goal: "继续调整现有成果" });
    workOrder.plan = {
      version: 2,
      updatedAt: "2026-08-04T03:00:00.000Z",
      stages: [{
        id: "previous-stage",
        outcome: "得到初版",
        scope: "页面",
        verification: "人工检查",
        dependsOn: [],
        executionMethod: "codex",
        workspace: { kind: "directory", path: null },
        materials: [],
        artifacts: [{
          id: "artifact-1",
          type: "file",
          label: "approved-output.pdf",
          location: "/private/secret/result.html",
        }],
        status: "completed",
        statusReason: "自动验证通过",
      }],
    };
    workOrder.result = {
      planVersion: 2,
      git: {
        diffStat: "secret-result.html | 10 ++++++++++",
        statusShort: " M secret-result.html\n?? new-secret.txt",
      },
      verifications: [{
        stageId: "previous-stage",
        stageOutcome: "得到初版",
        command: "run-private-verification --secret",
        status: "passed",
        exitCode: 0,
        output: "private verification output",
      }],
      completedAt: "2026-08-04T04:00:00.000Z",
    };

    await new CodexPlanGenerator(executablePath).generate(workOrder);
    const argumentsUsed = JSON.parse(readFileSync(capturedArgumentsPath, "utf8")) as string[];
    const prompt = argumentsUsed.at(-1) ?? "";

    expect(prompt).toContain('"status":"completed"');
    expect(prompt).toContain('"statusReason":"自动验证通过"');
    expect(prompt).toContain('"artifacts":[{"type":"file","label":"approved-output.pdf"}]');
    expect(prompt).toContain('"planVersion":2');
    expect(prompt).toContain('"hasChanges":true');
    expect(prompt).toContain('"changedEntryCount":2');
    expect(prompt).toContain('"stageId":"previous-stage","status":"passed"');
    expect(prompt).not.toContain("/private/secret/result.html");
    expect(prompt).not.toContain("secret-result.html");
    expect(prompt).not.toContain("new-secret.txt");
    expect(prompt).not.toContain("run-private-verification --secret");
    expect(prompt).not.toContain("private verification output");
    expect(prompt).not.toContain("2026-08-04T04:00:00.000Z");
  });
});
