import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp } from "../src/app";
import { WorkOrderStore } from "../src/work-order-store";

function request(path: string, body?: unknown) {
  return new Request(`http://teamline.local${path}`, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
}

function sourceState() {
  const store = new WorkOrderStore(new Database(":memory:"));
  const created = store.create({
    goal: "恢复本地委托，不要泄露 api_key=super-secret-value；Authorization: Basic dXNlcjpwYXNz；GEMINI_API_KEY=AIzaSyDUMMYSECRET1234567890",
    acceptance: "在新数据库预览后恢复；不要访问 https://inline:password@example.test/path?auth=hidden-value",
    workspace: { kind: "directory", path: "/missing/teamline-workspace" },
    materials: [
      { kind: "file", value: "/missing/brief.md" },
      { kind: "link", value: "https://user:pass@example.test/brief?token=private" },
    ],
    importSource: {
      kind: "codex_session",
      id: "session-source-reference",
      lastActiveAt: "2026-08-03T00:00:00.000Z",
      version: 1,
    },
  });
  const planned = store.savePlan(created.id, [
    {
      id: "restore-state",
      outcome: "本地状态可以恢复",
      scope: "Teamline 自有结构化状态",
      verification: "运行状态迁移测试",
      executionMethod: "external",
      artifacts: [
        {
          id: "artifact-reference",
          type: "link",
          label: "外部成果",
          location: "not-a-link",
        },
      ],
    },
  ]);
  store.saveResourcePlan(created.id, {
    priority: "high",
    pace: "saving",
    runWhenQuotaAvailable: true,
  });
  store.saveMaxRunMinutes(created.id, 120);
  store.saveMaxConcurrency(3);
  store.saveExecutionMapView("list");
  store.addStageSupplement(
    created.id,
    planned.plan!.stages[0]!.id,
    "使用 Bearer another-secret-token 完成迁移",
  );
  store.saveCheckpoint(created.id, {
    id: "checkpoint-reference",
    kind: "stage",
    planVersion: planned.plan!.version,
    stageId: planned.plan!.stages[0]!.id,
    stageOutcome: planned.plan!.stages[0]!.outcome,
    runNumber: 1,
    treeHash: "0123456789abcdef0123456789abcdef01234567",
  });
  store.database
    .query("UPDATE work_orders SET session_id = ? WHERE id = ?")
    .run("session-runtime-reference", created.id);
  store.database
    .query("INSERT INTO run_events (work_order_id, event_type, message, run_number, created_at) VALUES (?, 'progress', ?, 1, ?)")
    .run(created.id, "日志正文和密码 password=hunter2", new Date().toISOString());
  return { store, id: created.id };
}

describe("local Teamline state transfer", () => {
  test("exports only Teamline-owned state and references with credentials redacted", async () => {
    const { store, id } = sourceState();
    const app = createApp({ store });

    const response = await app.fetch(request("/api/local-state/export"));
    const bundle = await response.json();
    const serialized = JSON.stringify(bundle);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("teamline-state-");
    expect(bundle).toMatchObject({
      format: "teamline-local-state",
      version: 1,
      settings: { maxConcurrency: 3, executionMapView: "list" },
      workOrders: [
        {
          id,
          workspace: { kind: "directory", path: "/missing/teamline-workspace" },
          resourcePlan: { priority: "high", pace: "saving" },
          maxRunMinutes: 120,
          sessionReferences: {
            imported: { id: "session-source-reference" },
            active: "session-runtime-reference",
          },
          executionMap: { version: 1 },
          checkpoints: [{ treeHash: "0123456789abcdef0123456789abcdef01234567" }],
          conversationDecisions: [{ kind: "decision" }],
        },
      ],
    });
    expect(serialized).not.toContain("super-secret-value");
    expect(serialized).not.toContain("another-secret-token");
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("user:pass");
    expect(serialized).not.toContain("inline:password");
    expect(serialized).not.toContain("hidden-value");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("dXNlcjpwYXNz");
    expect(serialized).not.toContain("AIzaSyDUMMYSECRET1234567890");
    expect(serialized).not.toContain("run_events");
    expect(serialized).not.toContain("runEvents");
    expect(serialized).not.toContain("runPid");
    expect(serialized).not.toContain("worktreePath");
  });

  test("previews a restore into a new database without writing and flags missing references", async () => {
    const source = sourceState();
    const sourceApp = createApp({ store: source.store });
    const bundle = await (await sourceApp.fetch(request("/api/local-state/export"))).json();
    const targetStore = new WorkOrderStore(new Database(":memory:"));
    const targetApp = createApp({ store: targetStore });

    const response = await targetApp.fetch(
      request("/api/local-state/restore/preview", { bundle }),
    );
    const preview = await response.json();

    expect(response.status).toBe(200);
    expect(targetStore.list()).toHaveLength(0);
    expect(preview).toMatchObject({
      previewId: expect.any(String),
      summary: { total: 1, conflicts: 0, needsAttention: 1 },
      workOrders: [
        {
          sourceId: source.id,
          conflict: false,
          attention: expect.arrayContaining([
            expect.objectContaining({ kind: "workspace", status: "needs_attention" }),
            expect.objectContaining({ kind: "reference", status: "needs_attention" }),
          ]),
        },
      ],
    });
  });

  test("confirms a preview transactionally and restores references without resuming a run", async () => {
    const source = sourceState();
    const sourceApp = createApp({ store: source.store });
    const bundle = await (await sourceApp.fetch(request("/api/local-state/export"))).json();
    const targetStore = new WorkOrderStore(new Database(":memory:"));
    const targetApp = createApp({ store: targetStore });
    const preview = await (
      await targetApp.fetch(request("/api/local-state/restore/preview", { bundle }))
    ).json();

    const response = await targetApp.fetch(
      request("/api/local-state/restore/confirm", { previewId: preview.previewId }),
    );
    const result = await response.json();
    const restored = targetStore.get(source.id)!;

    expect(response.status).toBe(201);
    expect(result).toEqual({ imported: 1, copied: 0, skipped: 0 });
    expect(restored).toMatchObject({
      id: source.id,
      workspace: { kind: "directory", path: "/missing/teamline-workspace" },
      status: "draft",
      resourcePlan: { priority: "high", pace: "saving", runWhenQuotaAvailable: false },
      maxRunMinutes: 120,
      sessionId: "session-runtime-reference",
      runStatus: null,
      runPid: null,
      plan: {
        confirmationRequired: true,
        stages: [{ artifacts: [{ location: "not-a-link" }] }],
      },
      checkpoints: [{ treeHash: "0123456789abcdef0123456789abcdef01234567" }],
      conversation: [{ kind: "decision" }],
    });
    expect(targetStore.getExecutionSettings()).toEqual({ maxConcurrency: 3 });
    expect(targetStore.getExecutionMapView()).toBe("list");
  });

  test("never overwrites a conflict and requires keep-or-copy choice", async () => {
    const source = sourceState();
    const sourceApp = createApp({ store: source.store });
    const bundle = await (await sourceApp.fetch(request("/api/local-state/export"))).json();
    const targetStore = new WorkOrderStore(new Database(":memory:"));
    const targetApp = createApp({ store: targetStore });
    const firstPreview = await (
      await targetApp.fetch(request("/api/local-state/restore/preview", { bundle }))
    ).json();
    await targetApp.fetch(
      request("/api/local-state/restore/confirm", { previewId: firstPreview.previewId }),
    );
    const originalGoal = targetStore.get(source.id)!.goal;
    bundle.workOrders[0].goal = "冲突版本";

    const previewResponse = await targetApp.fetch(
      request("/api/local-state/restore/preview", { bundle }),
    );
    const preview = await previewResponse.json();
    expect(preview.summary.conflicts).toBe(1);

    const unresolved = await targetApp.fetch(
      request("/api/local-state/restore/confirm", { previewId: preview.previewId }),
    );
    expect(unresolved.status).toBe(409);
    expect((await unresolved.json()).code).toBe("RESTORE_CHOICE_REQUIRED");
    expect(targetStore.get(source.id)!.goal).toBe(originalGoal);
    expect(targetStore.list()).toHaveLength(1);

    const copied = await targetApp.fetch(
      request("/api/local-state/restore/confirm", {
        previewId: preview.previewId,
        resolutions: { [source.id]: "import_copy" },
      }),
    );
    expect(copied.status).toBe(201);
    expect(await copied.json()).toEqual({ imported: 0, copied: 1, skipped: 0 });
    expect(targetStore.get(source.id)!.goal).toBe(originalGoal);
    expect(targetStore.list()).toHaveLength(2);
    expect(targetStore.list()).toContainEqual(
      expect.objectContaining({ goal: "冲突版本", title: expect.stringContaining("恢复副本") }),
    );
  });

  test("requires one explicit choice for different local settings in an existing database", async () => {
    const source = sourceState();
    const bundle = await (
      await createApp({ store: source.store }).fetch(request("/api/local-state/export"))
    ).json();
    const targetStore = new WorkOrderStore(new Database(":memory:"));
    targetStore.create({ goal: "目标库原有委托" });
    const target = createApp({ store: targetStore });
    const preview = await (
      await target.fetch(request("/api/local-state/restore/preview", { bundle }))
    ).json();

    expect(preview.settingsConflict).toBe(true);
    const unresolved = await target.fetch(
      request("/api/local-state/restore/confirm", { previewId: preview.previewId }),
    );
    expect(unresolved.status).toBe(409);
    expect(await unresolved.json()).toMatchObject({
      code: "RESTORE_CHOICE_REQUIRED",
      settingsConflict: true,
    });

    const confirmed = await target.fetch(
      request("/api/local-state/restore/confirm", {
        previewId: preview.previewId,
        settingsResolution: "keep_existing",
      }),
    );
    expect(confirmed.status).toBe(201);
    expect(targetStore.getExecutionSettings()).toEqual({ maxConcurrency: 2 });
    expect(targetStore.getExecutionMapView()).toBe("map");
  });

  test("makes a preview stale when target data changes before confirmation", async () => {
    const source = sourceState();
    const bundle = await (
      await createApp({ store: source.store }).fetch(request("/api/local-state/export"))
    ).json();
    const targetStore = new WorkOrderStore(new Database(":memory:"));
    const target = createApp({ store: targetStore });
    const preview = await (
      await target.fetch(request("/api/local-state/restore/preview", { bundle }))
    ).json();
    targetStore.create({ goal: "预览后新增的数据" });

    const response = await target.fetch(
      request("/api/local-state/restore/confirm", { previewId: preview.previewId }),
    );

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("RESTORE_PREVIEW_STALE");
    expect(targetStore.get(source.id)).toBeNull();
  });

  test("revokes imported execution authorization and requires plan confirmation", async () => {
    const source = sourceState();
    const bundle = await (
      await createApp({ store: source.store }).fetch(request("/api/local-state/export"))
    ).json();
    bundle.workOrders[0].status = "running";
    bundle.workOrders[0].resourcePlan.runWhenQuotaAvailable = true;
    bundle.workOrders[0].executionMap.stages[0].verificationCommand =
      "touch /tmp/teamline-restore-must-not-run";
    bundle.workOrders[0].executionMap.stages[0].status = "running";
    const targetStore = new WorkOrderStore(new Database(":memory:"));
    const target = createApp({ store: targetStore });

    const previewResponse = await target.fetch(
      request("/api/local-state/restore/preview", { bundle }),
    );
    const preview = await previewResponse.json();
    expect(preview.workOrders[0].attention).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "resource", status: "needs_attention" }),
        expect.objectContaining({ kind: "command", status: "needs_attention" }),
        expect.objectContaining({ kind: "workspace", status: "needs_attention" }),
      ]),
    );

    const confirmed = await target.fetch(
      request("/api/local-state/restore/confirm", { previewId: preview.previewId }),
    );
    expect(confirmed.status).toBe(201);
    const restored = targetStore.get(source.id)!;
    expect(restored).toMatchObject({
      status: "draft",
      runStatus: null,
      worktreePath: null,
      resourcePlan: { runWhenQuotaAvailable: false, autoRunReason: null },
      plan: {
        confirmationRequired: true,
        stages: [{ status: "response", statusReason: "恢复后需重新确认并启动" }],
      },
    });
    expect(restored.plan!.stages[0]!.verificationCommand).toBeUndefined();
    expect(() =>
      targetStore.saveWorkspace(source.id, { kind: "directory", path: "/tmp" }),
    ).not.toThrow();
  });

  test("rejects invalid checkpoint references and cyclic execution maps", async () => {
    const source = sourceState();
    const exported = await (
      await createApp({ store: source.store }).fetch(request("/api/local-state/export"))
    ).json();
    const target = createApp({ store: new WorkOrderStore(new Database(":memory:")) });

    const invalidCheckpoint = structuredClone(exported);
    invalidCheckpoint.workOrders[0].checkpoints[0].treeHash = "deadbeef";
    const checkpointResponse = await target.fetch(
      request("/api/local-state/restore/preview", { bundle: invalidCheckpoint }),
    );
    expect(checkpointResponse.status).toBe(400);
    expect((await checkpointResponse.json()).code).toBe("INVALID_STATE_BUNDLE");

    const cyclicPlan = structuredClone(exported);
    const stageId = cyclicPlan.workOrders[0].executionMap.stages[0].id;
    cyclicPlan.workOrders[0].executionMap.stages[0].dependsOn = [stageId];
    const cycleResponse = await target.fetch(
      request("/api/local-state/restore/preview", { bundle: cyclicPlan }),
    );
    expect(cycleResponse.status).toBe(400);
    expect((await cycleResponse.json()).code).toBe("INVALID_STATE_BUNDLE");
  });

  test("rejects unknown fields and embedded credential properties before preview", async () => {
    const source = sourceState();
    const bundle = await (
      await createApp({ store: source.store }).fetch(request("/api/local-state/export"))
    ).json();
    bundle.credentials = { apiKey: "must-not-import" };
    const target = createApp({ store: new WorkOrderStore(new Database(":memory:")) });

    const response = await target.fetch(
      request("/api/local-state/restore/preview", { bundle }),
    );
    const result = await response.json();

    expect(response.status).toBe(400);
    expect(result.code).toBe("INVALID_STATE_BUNDLE");
  });
});
