import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp } from "../src/app";
import {
  createSessionOrganizationResourceSelector,
  type SessionOrganizationModelSettings,
} from "../src/session-organization-resources";
import type { ExecutionIdentity } from "../src/execution-identity";
import { WorkOrderStore } from "../src/work-order-store";

const identity: ExecutionIdentity = {
  id: "codex-account-1",
  tool: "codex",
  label: "个人 Codex",
  status: "enabled",
  homeKind: "system",
  managedHomePath: null,
  accountFingerprint: null,
  loginState: "ready",
  capabilities: [],
  lastObservedAt: null,
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
  removedAt: null,
};

describe("resource preferences", () => {
  test("selects only configured models from the requested source", async () => {
    const settings: SessionOrganizationModelSettings = {
      sources: {
        codex: {
          automaticModel: "codex-fast",
          deepModel: "codex-deep",
          fallbackModel: "codex-explicit-alternative",
          accountId: identity.id,
        },
        claude_code: {
          automaticModel: "claude-fast",
          deepModel: "claude-deep",
          fallbackModel: null,
          accountId: null,
        },
      },
    };
    const selector = createSessionOrganizationResourceSelector({
      getSettings: () => settings,
      getIdentity: (id) => id === identity.id ? identity : null,
      getCurrentIdentityId: () => identity.id,
      getDefaultIdentityId: () => identity.id,
    });

    await expect(selector.select({
      purpose: "session_organization",
      sessionKey: "codex:session-1",
      sourceKind: "codex_session",
      accountId: null,
      preference: "low_cost",
    })).resolves.toEqual({
      tool: "codex",
      model: "codex-fast",
      accountId: identity.id,
      accountLabel: identity.label,
    });
    await expect(selector.select({
      purpose: "session_organization",
      sessionKey: "codex:session-1",
      sourceKind: "codex_session",
      accountId: null,
      preference: "high_quality",
    })).resolves.toMatchObject({ model: "codex-deep" });
    await expect(selector.select({
      purpose: "session_organization",
      sessionKey: "claude:session-1",
      sourceKind: "claude_code_session",
      accountId: null,
      preference: "low_cost",
    })).resolves.toBeNull();
  });

  test("does not silently downgrade a deep request or invent a model", async () => {
    const selector = createSessionOrganizationResourceSelector({
      getSettings: () => ({
        sources: {
          codex: {
            automaticModel: null,
            deepModel: null,
            fallbackModel: null,
            accountId: identity.id,
          },
        },
      }),
      getIdentity: () => identity,
      getCurrentIdentityId: () => identity.id,
      getDefaultIdentityId: () => identity.id,
    });

    await expect(selector.select({
      purpose: "session_organization",
      sessionKey: "codex:session-2",
      sourceKind: "codex_session",
      accountId: null,
      preference: "low_cost",
    })).resolves.toBeNull();
    await expect(selector.select({
      purpose: "session_organization",
      sessionKey: "codex:session-2",
      sourceKind: "codex_session",
      accountId: null,
      preference: "high_quality",
    })).resolves.toBeNull();
  });

  test("persists source-scoped model and notification preferences", async () => {
    const database = new Database(":memory:");
    const store = new WorkOrderStore(database);
    const app = createApp({ store });
    const modelSettings = {
      sources: {
        codex: {
          automaticModel: "adapter-fast",
          deepModel: "adapter-deep",
          fallbackModel: "adapter-alt",
          accountId: "codex-account-1",
        },
      },
    };
    const notificationPreferences = {
      needsResponse: true,
      runFailed: false,
      goalPendingAcceptance: true,
      resourceUnavailable: false,
    };

    const modelResponse = await app.fetch(new Request(
      "http://teamline.local/api/preferences/models",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sources: modelSettings.sources }),
      },
    ));
    const notificationResponse = await app.fetch(new Request(
      "http://teamline.local/api/preferences/notifications",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(notificationPreferences),
      },
    ));

    expect(modelResponse.status).toBe(200);
    expect(notificationResponse.status).toBe(200);
    expect(await (await app.fetch(new Request(
      "http://teamline.local/api/preferences/models",
    ))).json()).toEqual({ settings: modelSettings });
    expect(await (await app.fetch(new Request(
      "http://teamline.local/api/preferences/notifications",
    ))).json()).toEqual({ settings: notificationPreferences });

    const reopenedApp = createApp({ store: new WorkOrderStore(database) });
    expect(await (await reopenedApp.fetch(new Request(
      "http://teamline.local/api/preferences/models",
    ))).json()).toEqual({ settings: modelSettings });
    expect(await (await reopenedApp.fetch(new Request(
      "http://teamline.local/api/preferences/notifications",
    ))).json()).toEqual({ settings: notificationPreferences });
  });

  test("serves the auxiliary settings surface without making a second workspace", async () => {
    const app = createApp({ store: new WorkOrderStore(new Database(":memory:")) });
    const [pageResponse, scriptResponse, stylesResponse] = await Promise.all([
      app.fetch(new Request("http://teamline.local/settings")),
      app.fetch(new Request("http://teamline.local/settings.js")),
      app.fetch(new Request("http://teamline.local/settings.css")),
    ]);
    const page = await pageResponse.text();
    const script = await scriptResponse.text();
    const styles = await stylesResponse.text();

    expect(pageResponse.status).toBe(200);
    expect(page).toContain("偏好设置");
    for (const section of ["常规", "会话监控", "模型", "通知", "高级"]) {
      expect(page).toContain(section);
    }
    expect(page).toContain('id="settings-close"');
    expect(script).toContain("/api/session-monitoring/automatic");
    expect(script).toContain("/api/preferences/models");
    expect(script).toContain("/api/preferences/notifications");
    expect(script).toContain("/api/local-state/export");
    expect(script).not.toContain("/api/notifications/claim");
    expect(styles).toContain(':root[data-theme="dark"]');
    expect(styles).toContain("@media (max-width: 680px)");
    expect(styles).toContain("line-break: strict");
  });

  test("keeps missing and failed quota data unknown while reserving unavailable for explicit states", async () => {
    const app = createApp({ store: new WorkOrderStore(new Database(":memory:")) });
    const script = await (await app.fetch(new Request("http://teamline.local/app.js"))).text();

    expect(script).toContain('if (["unavailable", "not_connected"].includes(status))');
    expect(script).toContain('<strong>未知</strong><small>暂无数据</small>');
    expect(script).toContain('const displayStatus = hasUsage ? "available" : explicitlyUnavailable ? "unavailable" : "unknown";');
    expect(script).toContain('<p class="resource-message">${explicitlyUnavailable ? "当前来源未提供 API 用量" : "暂无 API 用量数据"}</p>');
    expect(script).not.toContain("暂时无法读取 API 用量");
    expect(script).toContain('quotaWindowSummary(quota, state.locale)');
    expect(script).toContain('function resourceAvailabilityLabel(status)');
    expect(script).toContain('return "未知";');
    expect(script).not.toContain('return `<div><span>${label}</span><strong>不可用</strong><small>暂无数据</small></div>`');
  });

});
