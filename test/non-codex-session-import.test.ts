import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import type { SessionDiscoveryResult, SessionProvider } from "../src/session-discovery";
import { WorkOrderStore } from "../src/work-order-store";
import { CodexSessionOrganizer, filterClaudeCodeMainChain } from "../src/session-organizer";

function provider(read: () => SessionDiscoveryResult): SessionProvider {
  return { async discover() { return read(); } };
}

const claudeDiscovery: SessionDiscoveryResult = {
  status: "available",
  message: "只读取本机 Claude Code 会话的必要元数据",
  sessions: [{
    id: "shared-session-id",
    title: "Claude Code · project-a",
    workspacePath: "/tmp/project-a",
    projectLabel: "project-a",
    lastActiveAt: "2026-08-04T06:00:00.000Z",
    sourcePath: "/tmp/claude/project-a/shared-session-id.jsonl",
    availability: "available",
    message: null,
  }],
};

const organization = {
  description: "完成 project-a 的已有工作",
  summary: "已经完成主要结构调整",
  currentState: "等待生成后续计划",
  historicalStages: [{
    id: "history-1",
    outcome: "调整主要结构",
    summary: "结构调整已经完成",
    status: "completed" as const,
    sourceSessionIds: ["shared-session-id"],
  }],
  artifacts: [],
};

describe("non-Codex session import", () => {
  test("removes explicit sidechain records before Claude Code organization", () => {
    const filtered = filterClaudeCodeMainChain([
      JSON.stringify({ type: "user", sessionId: "session-a", message: "main request" }),
      JSON.stringify({ type: "assistant", sessionId: "session-a", isSidechain: true, message: "private subagent work" }),
      "{damaged-json",
      JSON.stringify({ type: "assistant", sessionId: "session-a", message: "main response" }),
    ].join("\n"));

    expect(filtered).toContain("main request");
    expect(filtered).toContain("main response");
    expect(filtered).not.toContain("private subagent work");
    expect(filtered).not.toContain("damaged-json");
  });

  test("the concrete organizer only gives Claude main-chain records to Codex", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-claude-organizer-"));
    const workspace = join(root, "workspace");
    const sourcePath = join(root, "source.jsonl");
    const fakeCodex = join(root, "fake-codex");
    mkdirSync(workspace);
    writeFileSync(sourcePath, [
      JSON.stringify({ type: "user", sessionId: "session-a", message: "main request" }),
      JSON.stringify({ type: "assistant", sessionId: "session-a", isSidechain: true, message: "private subagent work" }),
      JSON.stringify({ type: "assistant", sessionId: "session-a", message: "main response" }),
    ].join("\n"));
    writeFileSync(fakeCodex, `#!/usr/bin/env bun
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const outputPath = args[args.indexOf("--output-last-message") + 1];
const workingDirectory = args[args.indexOf("--cd") + 1];
const source = readdirSync(workingDirectory).find((name) => name.endsWith(".jsonl"));
const content = readFileSync(join(workingDirectory, source), "utf8");
writeFileSync(outputPath, JSON.stringify({
  description: "整理历史状态",
  summary: content,
  currentState: "等待后续计划",
  historicalStages: [{ id: "history", outcome: "完成主链工作", summary: content, status: "completed", sourceSessionIds: ["session-a"] }],
  artifacts: [],
}));
`);
    chmodSync(fakeCodex, 0o755);

    try {
      const result = await new CodexSessionOrganizer(fakeCodex).organize({
        name: "整理 Claude Code 历史",
        sourceLabel: "Claude Code",
        sourceKind: "claude_code_session",
        sessions: [{
          id: "session-a",
          title: "Claude Code · workspace",
          workspacePath: workspace,
          projectLabel: "workspace",
          lastActiveAt: "2026-08-04T06:00:00.000Z",
          sourcePath,
          availability: "available",
          message: null,
        }],
      });

      expect(result.summary).toContain("main request");
      expect(result.summary).toContain("main response");
      expect(result.summary).not.toContain("private subagent work");
      expect(JSON.stringify(result.historicalStages)).not.toContain("private subagent work");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects mixed source kinds while allowing the same id across separate tools", () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    expect(() => store.create({
      name: "混合来源",
      description: "不支持跨工具合并",
      sourceSessions: [
        {
          kind: "codex_session",
          id: "shared-session-id",
          lastActiveAt: "2026-08-04T05:00:00.000Z",
          version: 1,
        },
        {
          kind: "claude_code_session",
          id: "shared-session-id",
          lastActiveAt: "2026-08-04T06:00:00.000Z",
          version: 1,
        },
      ],
    })).toThrow("必须来自同一个工具");
  });

  test("lists Claude Code metadata through the shared import API", async () => {
    const app = createApp({
      store: new WorkOrderStore(new Database(":memory:")),
      claudeCodeSessionProvider: provider(() => claudeDiscovery),
    });

    const response = await app.fetch(new Request(
      "http://teamline.local/api/sessions?source=claude_code&q=project-a",
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      sourceKind: "claude_code_session",
      sourceLabel: "Claude Code",
      sourceKind: "claude_code_session",
      sessions: [{
        id: "shared-session-id",
        title: "Claude Code · project-a",
        importedWorkOrderId: null,
      }],
    });
    expect(JSON.stringify(body)).not.toContain("/tmp/claude/project-a");
  });

  test("uses the existing one-goal organization flow without starting or resuming", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const inputs: unknown[] = [];
    let runnerCalls = 0;
    const app = createApp({
      store,
      claudeCodeSessionProvider: provider(() => claudeDiscovery),
      sessionOrganizer: {
        async organize(input) {
          inputs.push(input);
          return organization;
        },
      },
      codexRunner: {
        async start() { runnerCalls += 1; throw new Error("must not run"); },
        async resume() { runnerCalls += 1; throw new Error("must not resume"); },
      },
    });

    const response = await app.fetch(new Request("http://teamline.local/api/sessions/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "claude_code",
        name: "整理 Claude Code 历史工作",
        sessionIds: ["shared-session-id"],
      }),
    }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.outcome).toBe("ready");
    expect(body.workOrder).toMatchObject({
      status: "draft",
      plan: null,
      sessionId: null,
      sourceSessions: [{
        kind: "claude_code_session",
        id: "shared-session-id",
        lastReadAt: expect.any(String),
      }],
      importContext: { status: "ready", summary: organization.summary },
    });
    expect(runnerCalls).toBe(0);
    expect(inputs).toEqual([expect.objectContaining({
      name: "整理 Claude Code 历史工作",
      sourceLabel: "Claude Code",
      sessions: [expect.objectContaining({
        id: "shared-session-id",
        sourcePath: "/tmp/claude/project-a/shared-session-id.jsonl",
      })],
    })]);
  });

  test("tracks duplicate ownership by source kind and id", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    store.create({
      name: "Codex 来源",
      description: "保留 Codex 来源",
      sourceSessions: [{
        kind: "codex_session",
        id: "shared-session-id",
        lastActiveAt: "2026-08-04T05:00:00.000Z",
        version: 1,
      }],
    });
    const app = createApp({
      store,
      claudeCodeSessionProvider: provider(() => claudeDiscovery),
      sessionOrganizer: { async organize() { return organization; } },
    });

    const response = await app.fetch(new Request("http://teamline.local/api/sessions/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "claude_code",
        name: "Claude Code 来源",
        sessionIds: ["shared-session-id"],
      }),
    }));

    expect(response.status).toBe(201);
    expect(store.list()).toHaveLength(2);
  });

  test("uses the matching provider when checking and reorganizing updates", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    let discovery = claudeDiscovery;
    let organizations = 0;
    const app = createApp({
      store,
      claudeCodeSessionProvider: provider(() => discovery),
      sessionOrganizer: {
        async organize() {
          organizations += 1;
          return organization;
        },
      },
    });
    const imported = await app.fetch(new Request("http://teamline.local/api/sessions/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "claude_code",
        name: "Claude Code 来源",
        sessionIds: ["shared-session-id"],
      }),
    }));
    const id = (await imported.json()).workOrder.id;
    discovery = {
      ...claudeDiscovery,
      sessions: claudeDiscovery.sessions.map((session) => ({
        ...session,
        lastActiveAt: "2026-08-04T08:00:00.000Z",
      })),
    };

    const detail = await app.fetch(new Request(`http://teamline.local/api/work-orders/${id}`));
    expect((await detail.json()).sourceStatus.hasUpdates).toBe(true);
    expect(organizations).toBe(1);

    const organized = await app.fetch(new Request(
      `http://teamline.local/api/work-orders/${id}/import-context/organize`,
      { method: "POST" },
    ));
    expect(organized.status).toBe(200);
    expect((await organized.json()).outcome).toBe("ready");
    expect(organizations).toBe(2);
  });

  test("roundtrips Claude Code sources and rejects a mixed-source bundle", async () => {
    const sourceStore = new WorkOrderStore(new Database(":memory:"));
    sourceStore.create({
      name: "Claude Code 历史",
      description: "整理历史状态",
      sourceSessions: [{
        kind: "claude_code_session",
        id: "shared-session-id",
        lastActiveAt: "2026-08-04T06:00:00.000Z",
        version: 1,
      }],
      importContext: {
        status: "ready",
        summary: "历史摘要",
        currentState: "当前状态",
        historicalStages: [{
          id: "history-1",
          outcome: "完成历史工作",
          summary: "历史节点",
          status: "completed",
          sourceSessionIds: ["shared-session-id"],
        }],
        artifacts: [],
        organizedAt: "2026-08-04T06:30:00.000Z",
        error: null,
      },
    });
    const sourceApp = createApp({ store: sourceStore });
    const bundle = await (
      await sourceApp.fetch(new Request("http://teamline.local/api/local-state/export"))
    ).json();
    const targetStore = new WorkOrderStore(new Database(":memory:"));
    const targetApp = createApp({ store: targetStore });
    const previewResponse = await targetApp.fetch(new Request(
      "http://teamline.local/api/local-state/restore/preview",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bundle }),
      },
    ));
    const preview = await previewResponse.json();
    expect(previewResponse.status).toBe(200);
    const confirmed = await targetApp.fetch(new Request(
      "http://teamline.local/api/local-state/restore/confirm",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ previewId: preview.previewId }),
      },
    ));
    expect(confirmed.status).toBe(201);
    expect(targetStore.list()[0]?.sourceSessions[0]?.kind).toBe("claude_code_session");

    const mixed = structuredClone(bundle);
    mixed.workOrders[0].sourceSessions.push({
      kind: "codex_session",
      id: "other-session",
      lastActiveAt: "2026-08-04T05:00:00.000Z",
      version: 1,
    });
    const rejected = await createApp({
      store: new WorkOrderStore(new Database(":memory:")),
    }).fetch(new Request("http://teamline.local/api/local-state/restore/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundle: mixed }),
    }));
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error).toContain("必须来自同一个工具");
  });

  test("keeps Claude Code imports read-only across planning and execution APIs", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const workOrder = store.create({
      name: "Claude Code 历史",
      description: "仅整理历史状态",
      sourceSessions: [{
        kind: "claude_code_session",
        id: "read-only-session",
        lastActiveAt: "2026-08-04T06:00:00.000Z",
        version: 1,
      }],
      importContext: {
        status: "ready",
        summary: "历史摘要",
        currentState: "当前状态",
        historicalStages: [],
        artifacts: [],
        organizedAt: "2026-08-04T06:30:00.000Z",
        error: null,
      },
    });
    let planCalls = 0;
    let runnerCalls = 0;
    const app = createApp({
      store,
      planGenerator: {
        async generate() {
          planCalls += 1;
          throw new Error("must not plan");
        },
      },
      codexRunner: {
        async start() { runnerCalls += 1; throw new Error("must not start"); },
        async resume() { runnerCalls += 1; throw new Error("must not resume"); },
      },
    });
    const requests = [
      new Request(`http://teamline.local/api/work-orders/${workOrder.id}/plan/generate`, { method: "POST" }),
      new Request(`http://teamline.local/api/work-orders/${workOrder.id}/plan`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stages: [] }),
      }),
      new Request(`http://teamline.local/api/work-orders/${workOrder.id}/start`, { method: "POST" }),
      new Request(`http://teamline.local/api/work-orders/${workOrder.id}/continue`, { method: "POST" }),
      new Request(`http://teamline.local/api/work-orders/${workOrder.id}/reexecute`, { method: "POST" }),
      new Request(`http://teamline.local/api/work-orders/${workOrder.id}/conversation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "replan", message: "继续" }),
      }),
      new Request(`http://teamline.local/api/work-orders/${workOrder.id}/resource-plan`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ priority: "normal", pace: "balanced", runWhenQuotaAvailable: true }),
      }),
      new Request(`http://teamline.local/api/work-orders/${workOrder.id}/resource-plan`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ priority: "high", pace: "fast", runWhenQuotaAvailable: false }),
      }),
      new Request(`http://teamline.local/api/work-orders/${workOrder.id}/execution-settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxRunMinutes: 120 }),
      }),
    ];

    for (const request of requests) {
      const response = await app.fetch(request);
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe("IMPORT_ONLY_GOAL");
    }
    expect(planCalls).toBe(0);
    expect(runnerCalls).toBe(0);
    expect(store.get(workOrder.id)?.plan).toBeNull();
    expect(store.get(workOrder.id)?.resourcePlan.runWhenQuotaAvailable).toBe(false);

    const resources = await app.fetch(new Request("http://teamline.local/api/resources"));
    expect((await resources.json()).workOrders[0]).toMatchObject({
      id: workOrder.id,
      importOnly: true,
      recommendation: "仅保留导入状态",
    });
  });
});
