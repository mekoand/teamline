import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp } from "../src/app";
import { runCli } from "../src/cli";
import {
  catalogParameterNames,
  formatMessage,
  formatSemanticMessage,
  interfaceLocales,
  messageCatalogs,
  normalizeLocale,
  resolveInterfaceLocale,
} from "../src/i18n";
import { WorkOrderStore } from "../src/work-order-store";
import {
  catalogParameterNames as browserParameterNames,
  catalogs as browserCatalogs,
  embeddedCatalogs,
  resolveLocale as resolveBrowserLocale,
  translateFixedText,
  translateMessage,
} from "../public/i18n.js";

function capturedCli(
  env: Record<string, string | undefined>,
  fetch: typeof globalThis.fetch,
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    dependencies: {
      cwd: () => process.cwd(),
      env,
      fetch,
      openUrl() {},
      async resolveWorkspace(cwd: string) {
        return cwd;
      },
      stdout: (message: string) => stdout.push(message),
      stderr: (message: string) => stderr.push(message),
    },
  };
}

describe("local language contract", () => {
  test("server and browser catalogs have matching keys and parameter shapes", () => {
    for (const catalogs of [messageCatalogs, browserCatalogs]) {
      const englishKeys = Object.keys(catalogs.en).sort();
      expect(Object.keys(catalogs["zh-CN"]).sort()).toEqual(englishKeys);
      for (const key of englishKeys) {
        const parameterNames = catalogs === messageCatalogs
          ? catalogParameterNames
          : browserParameterNames;
        expect(parameterNames(catalogs.en[key])).toEqual(
          parameterNames(catalogs["zh-CN"][key]),
        );
      }
    }
    expect(interfaceLocales).toEqual(["en", "zh-CN"]);

    const embeddedEnglishKeys = Object.keys(embeddedCatalogs.en).sort();
    expect(Object.keys(embeddedCatalogs["zh-CN"]).sort()).toEqual(embeddedEnglishKeys);
    for (const key of embeddedEnglishKeys) {
      expect(browserParameterNames(embeddedCatalogs.en[key])).toEqual(
        browserParameterNames(embeddedCatalogs["zh-CN"][key]),
      );
      expect(embeddedCatalogs.en[key]).not.toMatch(/[\u3400-\u9fff]/);
    }
  });

  test("normalizes supported variants and defaults to English", () => {
    expect(normalizeLocale("en-US")).toBe("en");
    expect(normalizeLocale("zh-Hans-CN")).toBe("zh-CN");
    expect(normalizeLocale("fr")).toBeNull();
    expect(resolveInterfaceLocale({ browserLanguages: ["fr-FR"] })).toBe("en");
    expect(resolveBrowserLocale({ browserLanguages: ["zh-Hans", "en-US"] })).toBe("zh-CN");
  });

  test("localizes primary workflows while preserving the Chinese interface", () => {
    expect(translateFixedText("en", "新建目标")).toBe("Create goal");
    expect(translateFixedText("en", "全部节点已完成，等待验收")).toBe(
      "All nodes are complete and ready for review",
    );
    expect(translateFixedText("en", "执行中断")).toBe("Execution interrupted");
    expect(translateFixedText("en", " · 已移除")).toBe(" · Removed");
    expect(translateFixedText("en", "将恢复 3 个目标")).toBe("Restore 3 goals");
    expect(translateFixedText("en", "依赖：节点 1")).toBe("Dependencies: Node 1");
    expect(translateFixedText("en", "会话监控")).toBe("Session monitoring");
    expect(translateFixedText("en", "已读取 2 个本机会话，排除 1 个 Teamline 执行会话")).toBe(
      "Read 2 local sessions; excluded 1 Teamline execution sessions",
    );
    expect(translateFixedText("zh-CN", "新建目标")).toBe("新建目标");
  });

  test("renders the monitoring-goal entry, dialog, and source trace in English", async () => {
    const [page, script] = await Promise.all([
      Bun.file(new URL("../public/index.html", import.meta.url)).text(),
      Bun.file(new URL("../public/app.js", import.meta.url)).text(),
    ]);
    expect(translateFixedText("en", "从当前进展创建目标")).toBe("Create goal from current progress");
    expect(translateFixedText("en", "当前监控进展")).toBe("Current monitored progress");
    expect(translateFixedText("en", "保存当前进展并创建目标；原会话继续监控。")).toBe(
      "Save the current progress and create a goal; the original sessions remain monitored.",
    );
    expect(translateFixedText("en", "创建执行目标")).toBe("Create execution goal");
    expect(translateFixedText("en", "创建时来源上下文 · 2 个会话")).toBe(
      "Source context at creation · 2 sessions",
    );
    expect(translateFixedText("en", "创建时来源上下文 · 1 个会话")).toBe(
      "Source context at creation · 1 session",
    );
    expect(translateFixedText("en", "快照中的关键节点 · 3 项")).toBe(
      "Key nodes in snapshot · 3 items",
    );
    expect(translateFixedText("en", "快照中的关键节点 · 1 项")).toBe(
      "Key nodes in snapshot · 1 item",
    );
    expect(translateFixedText("en", "最近活动 8/9 10:00")).toBe("Last active 8/9 10:00");
    expect(translateFixedText("en", "从Monitoring project当前进展继续")).toBe(
      "Continue from Monitoring project's current progress",
    );
    expect(translateFixedText("en", "从当前进展继续")).toBe("Continue from current progress");
    expect(page).toContain('id="monitoring-goal-dialog"');
    expect(page).toContain("保存当前进展并创建目标；原会话继续监控。");
    expect(script).toContain('id="open-monitoring-goal"');
    expect(script).toContain('const goalName = projectName ? `从${projectName}当前进展继续` : "从当前进展继续";');
    expect(script).toContain("monitoringGoalDialog.addEventListener(\"click\"");
    expect(script).toContain("monitoringGoalDialog.addEventListener(\"cancel\"");
  });

  test("renders stable semantic messages with parameters", () => {
    expect(
      translateMessage(
        "en",
        { code: "status.awaiting_external_stage", params: { outcome: "Publish" } },
        "待完成外部节点：Publish",
      ),
    ).toBe("Waiting for external node: Publish");
    expect(
      translateMessage("zh-CN", { code: "status.awaiting_review", params: {} }, "待验收"),
    ).toBe("待验收");
    expect(
      translateMessage(
        "en",
        { code: "notification.body.completed", params: { text: "新建目标" } },
        "新建目标",
      ),
    ).toBe("新建目标");
  });

  test("marks goal-authored content as language-preserved", async () => {
    const script = await Bun.file(new URL("../public/app.js", import.meta.url)).text();
    expect(script).toContain('<h1 data-i18n-preserve>${escapeHtml(workOrder.title)}</h1>');
    expect(script).toContain('class="goal-statement" data-i18n-preserve');
    expect(script).toContain('<p data-i18n-preserve>${escapeHtml(message.content)}</p>');
    expect(script).toContain('<strong data-i18n-preserve>${escapeHtml(stage.outcome)}</strong>');
  });

  test("persists an explicit web language without changing existing goals", async () => {
    const store = new WorkOrderStore(new Database(":memory:"));
    const goal = store.create({ goal: "保留用户原文" });
    const app = createApp({ store });

    expect(
      await app.fetch(new Request("http://teamline.local/api/preferences/language"))
        .then((response) => response.json()),
    ).toEqual({ language: null });
    const saved = await app.fetch(
      new Request("http://teamline.local/api/preferences/language", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ language: "zh-CN" }),
      }),
    );
    expect(await saved.json()).toEqual({ language: "zh-CN" });
    expect(store.getInterfaceLanguage()).toBe("zh-CN");
    expect(store.get(goal.id)?.goal).toBe("保留用户原文");
  });

  test("CLI precedence is option, environment, saved setting, then English", async () => {
    const savedChinese = (async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.pathname === "/api/preferences/language") {
        return Response.json({ language: "zh-CN" });
      }
      throw new Error("unexpected request");
    }) as typeof globalThis.fetch;

    const explicit = capturedCli(
      { TEAMLINE_URL: "http://127.0.0.1:4310", TEAMLINE_LANG: "zh-CN" },
      savedChinese,
    );
    expect(await runCli(["help", "--lang", "en"], explicit.dependencies)).toBe(0);
    expect(explicit.stdout.join("\n")).toContain("Usage:");

    const environment = capturedCli(
      { TEAMLINE_URL: "http://127.0.0.1:4310", TEAMLINE_LANG: "zh-CN" },
      savedChinese,
    );
    expect(await runCli(["help"], environment.dependencies)).toBe(0);
    expect(environment.stdout.join("\n")).toContain("用法：");

    const saved = capturedCli(
      { TEAMLINE_URL: "http://127.0.0.1:4310" },
      savedChinese,
    );
    expect(await runCli(["help"], saved.dependencies)).toBe(0);
    expect(saved.stdout.join("\n")).toContain("用法：");

    const fallback = capturedCli(
      { TEAMLINE_URL: "http://127.0.0.1:4310" },
      (async () => {
        throw new Error("service unavailable");
      }) as typeof globalThis.fetch,
    );
    expect(await runCli(["help"], fallback.dependencies)).toBe(0);
    expect(fallback.stdout.join("\n")).toContain("Usage:");
    expect(formatMessage("en", "status.review")).toBe("Review-ready");

    const explicitOverInvalidEnvironment = capturedCli(
      { TEAMLINE_URL: "not-a-url", TEAMLINE_LANG: "xx" },
      savedChinese,
    );
    expect(
      await runCli(["help", "--lang", "en"], explicitOverInvalidEnvironment.dependencies),
    ).toBe(0);
    expect(explicitOverInvalidEnvironment.stdout.join("\n")).toContain("Usage:");

    const helpIgnoresInvalidServiceUrl = capturedCli(
      { TEAMLINE_URL: "not-a-url" },
      savedChinese,
    );
    expect(await runCli(["--help"], helpIgnoresInvalidServiceUrl.dependencies)).toBe(0);
    expect(helpIgnoresInvalidServiceUrl.stdout.join("\n")).toContain("Usage:");
  });

  test("CLI semantic rendering is independent of compatibility wording", () => {
    expect(
      formatSemanticMessage(
        "en",
        { code: "scheduler.quota_unavailable", params: {} },
        "额度数据不可用，保持排队",
      ),
    ).toBe("Quota data unavailable; remaining queued");
  });

  test("CLI list consumes semantic status codes from the console API", async () => {
    const cli = capturedCli(
      { TEAMLINE_URL: "http://127.0.0.1:4310" },
      (async (input: RequestInfo | URL) => {
        const url = new URL(input.toString());
        if (url.pathname === "/api/console") {
          return Response.json({
            workOrders: [{
              id: "12345678-1234-1234-1234-123456789abc",
              title: "English goal",
              goal: "English goal",
              userStatus: "queued",
              statusReason: "额度数据不可用，保持排队",
              statusMessage: { code: "scheduler.quota_unavailable", params: {} },
              currentSummary: "Waiting",
              plan: null,
            }],
          });
        }
        throw new Error(`unexpected request: ${url.pathname}`);
      }) as typeof globalThis.fetch,
    );

    expect(await runCli(["list", "--lang", "en"], cli.dependencies)).toBe(0);
    expect(cli.stdout.join("\n")).toContain("Quota data unavailable; remaining queued");
    expect(cli.stdout.join("\n")).not.toContain("额度数据不可用");
  });
});
