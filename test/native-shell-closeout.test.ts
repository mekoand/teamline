import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  buildOnboardingSelectionPayload,
  buildOnboardingToolBySessionKey,
  visibleOnboardingCandidates,
  visibleOnboardingSessionKeys,
} from "../public/session-monitoring-onboarding.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const page = read("public/index.html");
const script = read("public/app.js");
const styles = read("public/styles.css");
const settingsPage = read("public/settings.html");
const settingsScript = read("public/settings.js");
const settingsStyles = read("public/settings.css");
const electronMain = read("src/electron/main.mjs");
const preload = read("src/electron/preload.cjs");
const serverApp = read("src/app.ts");
const traySvg = read("public/teamline-tray-template.svg");

describe("native shell closeout", () => {
  test("keeps a real drag region separate from interactive topbar controls", () => {
    expect(page).toContain('class="window-heading window-drag-region" data-window-drag-region');
    expect(styles).toContain("-webkit-app-region: drag");
    expect(styles).toContain("-webkit-app-region: no-drag");
    expect(styles).toContain(".console-shell[class] .console-topbar button");
  });

  test("defaults to monitoring before execution and uses a square template tray asset", () => {
    const monitoringIndex = page.indexOf('id="open-monitoring-mode"');
    const executionIndex = page.indexOf('id="open-execution-mode"');
    expect(monitoringIndex).toBeGreaterThan(-1);
    expect(monitoringIndex).toBeLessThan(executionIndex);
    expect(page.slice(monitoringIndex, executionIndex)).toContain('aria-selected="true"');
    expect(page.slice(executionIndex, executionIndex + 160)).toContain('aria-selected="false"');
    const trayStart = electronMain.indexOf("function createTemplateTrayImage()");
    const trayEnd = electronMain.indexOf("function createTray()", trayStart);
    const trayCode = electronMain.slice(trayStart, trayEnd);
    expect(trayCode).toContain("teamline-tray-template.svg");
    expect(trayCode).not.toContain("crop(");
    expect(trayCode).toContain("width: 36");
    expect(trayCode).toContain("height: 36");
    expect(trayCode).toContain("scaleFactor: 2");
    expect(trayCode).toContain("setTemplateImage(true)");
    expect(traySvg).toContain('width="18" height="18" viewBox="0 0 18 18"');
    expect(traySvg).not.toContain("teamline-logo.png");
  });

  test("keeps notification preferences in Settings and makes the bell a dismissible panel", () => {
    expect(page).toContain('id="open-notification-settings"');
    expect(page).not.toContain('id="notification-needs-response"');
    expect(page).not.toContain('id="notification-run-failed"');
    expect(script).toContain("notificationDialog.show();");
    expect(script).toContain("if (notificationDialog.open)");
    expect(script).toContain('openSettingsView("notifications")');
    expect(script).toContain('event.target.closest?.("#notification-dialog")');
    expect(settingsPage).toContain('data-settings-panel="notifications"');
    expect(settingsScript).toContain("requestedSettingsSection()");
    expect(settingsScript).toContain("onSettingsSection");
    expect(preload).toContain('teamline:settings-section');
  });

  test("keeps first discovery rows compact and stacks their detail on narrow screens", () => {
    expect(script).toContain('class="monitoring-onboarding-project-choice"');
    expect(script).toContain('class="monitoring-onboarding-default"');
    expect(script).toContain('aria-pressed="${activeToolKeys.has(tool.key)}"');
    expect(script).toContain('class="monitoring-onboarding-session-preview"');
    expect(script).not.toContain('data-onboarding-session="${escapeHtml(key)}" checked');
    expect(script).not.toContain("当前及以后同一工作文件夹的来源会话继承此设置");
    expect(styles).toContain(".monitoring-onboarding-project-choice");
    expect(styles).toContain("grid-template-columns: minmax(0, 1fr) auto");
    expect(styles).toContain("@media (max-width: 680px)");
    expect(styles).toContain(".monitoring-onboarding-default {");
  });

  test("keeps tool filtering separate from import checkboxes", () => {
    const toolHandlerStart = script.indexOf('document.querySelectorAll("[data-onboarding-tool]")');
    const toolHandlerEnd = script.indexOf('document.querySelectorAll("[data-create-monitoring-goal-work]', toolHandlerStart);
    const toolHandler = script.slice(toolHandlerStart, toolHandlerEnd);
    expect(toolHandler).toContain("sessionMonitoringToolFilters");
    expect(toolHandler).toContain("applySessionMonitoringOnboardingToolFilter");
    expect(toolHandler).toContain('control.getAttribute("aria-pressed")');
    expect(toolHandler).not.toContain("session.checked = control.checked");
    expect(script).toContain("data-onboarding-session-tool");
    expect(script).toContain("data-onboarding-filter-empty");
    expect(script).toContain("buildOnboardingSelectionPayload");
    expect(serverApp).toContain('"/session-monitoring-onboarding.js"');

    const tools = [
      { key: "codex", sessionKeys: ["codex-1"] },
      { key: "claude", sessionKeys: ["claude-1"] },
    ];
    const candidate = { key: "project", sessionKeys: ["codex-1", "claude-1"] };
    const index = buildOnboardingToolBySessionKey(tools);
    expect(visibleOnboardingSessionKeys(candidate, index, new Set(["codex"]))).toEqual(["codex-1"]);
    expect(visibleOnboardingCandidates([candidate], index, new Set(["claude"]))).toEqual([candidate]);
    expect(buildOnboardingSelectionPayload(
      [candidate],
      tools,
      [{ candidateKey: "project", selected: true, monitoringEnabled: false }],
      new Set(["claude"]),
    )).toEqual({
      projects: [{
        candidateKey: "project",
        selected: true,
        monitoringEnabled: false,
        toolKeys: ["claude"],
      }],
      selectedSessionKeys: ["claude-1"],
    });
    expect(buildOnboardingSelectionPayload(
      [candidate],
      tools,
      [{ candidateKey: "project", selected: false, monitoringEnabled: false }],
      new Set(["codex"]),
    ).selectedSessionKeys).toEqual([]);
  });

  test("gives the Settings window its own drag region and keeps controls no-drag", () => {
    expect(settingsPage).toContain('class="settings-drag-region" data-settings-drag-region');
    expect(settingsStyles).toContain(".settings-drag-region");
    expect(settingsStyles).toContain(".settings-content select");
    expect(settingsStyles).toContain("-webkit-app-region: no-drag");
  });

  test("uses the restrained monitoring accent for controls and focus", () => {
    expect(styles).toContain("--mode-accent: #b77b73");
    expect(styles).toContain("--mode-accent-soft: #f7efec");
    expect(styles).toContain(".console-shell[class].mode-monitoring .monitoring-onboarding-tool");
    expect(styles).toContain(".console-shell[class].mode-monitoring .session-monitoring-lane.selected");
    expect(styles).not.toContain(".console-shell[class].mode-monitoring {\n  --accent:");
    expect(styles).toContain("accent-color: var(--mode-accent)");
    expect(styles).toContain(".console-shell[class].mode-monitoring button:focus-visible");
  });

  test("keeps the 640x480 settings window dense while its content scrolls", () => {
    expect(electronMain).toContain("createSettingsWindowOptions");
    expect(electronMain).toContain('preloadPath: resolve(sourceRoot, "src/electron/preload.cjs")');
    expect(settingsStyles).toContain("height: 100dvh");
    expect(settingsStyles).toContain(".settings-content");
    expect(settingsStyles).toContain("overflow: auto");
    expect(settingsPage).toContain('id="settings-language"');
    expect(settingsPage).toContain('id="settings-theme"');
    expect(settingsPage).toContain('value="system">跟随系统');
  });

  test("keeps the notification panel above responsive drawers and exposes the Tray actions", () => {
    expect(styles).toContain(".notification-dialog {");
    expect(styles).toContain("z-index: 40;");
    expect(electronMain).toContain('{ label: "设置…", click: () => openSettingsWindow("general") }');
    expect(electronMain).toContain('{ label: "检查更新…", click: () => void shell.openExternal("https://github.com/mekoand/teamline/releases") }');
    expect(electronMain).toContain('import {');
    expect(electronMain).toContain("shell,");
  });
});
