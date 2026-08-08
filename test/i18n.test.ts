import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp } from "../src/app";
import { runCli } from "../src/cli";
import {
  catalogParameterNames,
  formatMessage,
  interfaceLocales,
  messageCatalogs,
  normalizeLocale,
  resolveInterfaceLocale,
} from "../src/i18n";
import { WorkOrderStore } from "../src/work-order-store";
import {
  catalogParameterNames as browserParameterNames,
  catalogs as browserCatalogs,
  resolveLocale as resolveBrowserLocale,
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
  });

  test("normalizes supported variants and defaults to English", () => {
    expect(normalizeLocale("en-US")).toBe("en");
    expect(normalizeLocale("zh-Hans-CN")).toBe("zh-CN");
    expect(normalizeLocale("fr")).toBeNull();
    expect(resolveInterfaceLocale({ browserLanguages: ["fr-FR"] })).toBe("en");
    expect(resolveBrowserLocale({ browserLanguages: ["zh-Hans", "en-US"] })).toBe("zh-CN");
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
  });
});
