import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  buildOnboardingSelectionPayload,
  buildOnboardingToolBySessionKey,
  visibleOnboardingCandidates,
  visibleOnboardingSessionKeys,
} from "../public/session-monitoring-onboarding.js";
import {
  availableQuotaWindows,
  quotaWindowSummary,
} from "../public/resource-window-presentation.js";

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

function cssBlock(source: string, selector: string): string {
  const start = source.indexOf(selector);
  const end = source.indexOf("}", start);
  return start < 0 || end < 0 ? "" : source.slice(start, end + 1);
}

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
    expect(script).not.toContain('type="checkbox" data-onboarding-session=');
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

  test("uses pink for monitoring and green for execution across each mode", () => {
    const monitoringTheme = cssBlock(styles, ".console-shell[class].mode-monitoring {");
    const executionTheme = cssBlock(styles, ".console-shell[class].mode-execution {");
    expect(monitoringTheme).toContain("--mode-accent: #b77b73");
    expect(monitoringTheme).toContain("--mode-accent-soft: #f7efec");
    expect(monitoringTheme).not.toContain("--accent:");
    expect(executionTheme).toContain("--mode-accent: #2f6b50");
    expect(executionTheme).toContain("--mode-accent-soft: #e5efe9");
    expect(executionTheme).not.toContain("--accent:");
    expect(styles).toContain(".console-shell[class].mode-monitoring .monitoring-onboarding-tool");
    expect(styles).toContain(".console-shell[class].mode-monitoring .session-monitoring-lane.selected");
    expect(styles).toContain("accent-color: var(--mode-accent)");
    expect(styles).toContain(".console-shell[class].mode-execution button:focus-visible");
    expect(styles).toContain(".console-shell[class] .secondary-button:hover");
  });

  test("keeps the selected mode tab on the active mode theme", () => {
    const monitoringTab = cssBlock(
      styles,
      '.console-shell[class].mode-monitoring .mode-switch-button[data-mode="monitoring"].selected {',
    );
    const executionTab = cssBlock(
      styles,
      '.console-shell[class].mode-execution .mode-switch-button[data-mode="execution"].selected {',
    );
    expect(monitoringTab).toContain("color: var(--mode-accent)");
    expect(monitoringTab).toContain("background: var(--mode-accent-soft)");
    expect(executionTab).toContain("color: var(--mode-accent)");
    expect(executionTab).toContain("background: var(--mode-accent-soft)");
  });

  test("normalizes compact checkboxes and button contents in the shell and Settings", () => {
    const shellCheckbox = cssBlock(styles, '.console-shell[class] input[type="checkbox"] {');
    expect(shellCheckbox).toContain("width: 16px");
    expect(shellCheckbox).toContain("height: 16px");
    expect(shellCheckbox).toContain("margin: 0");
    expect(shellCheckbox).toContain("padding: 0");

    const shellCompactButtons = cssBlock(
      styles,
      ".console-shell[class] :is(.mode-switch-button, .primary-button, .secondary-button, .notification-button, .icon-button) {",
    );
    expect(shellCompactButtons).toContain("display: inline-flex");
    expect(shellCompactButtons).toContain("align-items: center");
    expect(shellCompactButtons).toContain("justify-content: center");

    const settingsCheckbox = cssBlock(settingsStyles, '.setting-toggle input[type="checkbox"] {');
    expect(settingsCheckbox).toContain("width: 16px");
    expect(settingsCheckbox).toContain("height: 16px");
    expect(settingsCheckbox).toContain("margin: 0");
  });

  test("does not overwrite semantic running status colors with the current mode", () => {
    expect(cssBlock(styles, ".local-status i {")).toContain("background: var(--accent)");
    expect(cssBlock(styles, ".status-dot.running {")).toContain("background: var(--accent)");
    expect(cssBlock(styles, ".status-pill.running {")).toContain("color: var(--accent)");
  });

  test("keeps the compact Teamline logo left aligned", () => {
    const finalCascade = styles.slice(styles.indexOf("/* Final cascade for the native shell closeout. */"));
    const brandRow = cssBlock(finalCascade, ".console-shell[class] .sidebar-brand-row {");
    expect(brandRow).toContain("padding-inline-start: 8px");
    expect(cssBlock(finalCascade, ".console-shell[class] .sidebar-brand-row,\n.console-shell[class].left-collapsed .sidebar-brand-row {")).toContain("align-items: center");
    expect(cssBlock(finalCascade, ".console-shell[class] .sidebar-brand-row .brand {")).toContain("width: 72px");
    expect(cssBlock(finalCascade, ".console-shell[class] .sidebar-brand-row .brand {")).toContain("height: 18px");
    expect(cssBlock(finalCascade, ".console-shell[class] .brand-logo {")).toContain("width: 72px");
  });

  test("aligns compact monitoring candidates to one content rail", () => {
    expect(cssBlock(styles, ".console-shell[class].mode-monitoring .monitoring-onboarding-candidate {")).toContain("padding: 10px 12px");
    expect(cssBlock(styles, ".console-shell[class].mode-monitoring .monitoring-onboarding-project-choice > span {")).toContain("grid-template-columns: minmax(88px, 0.32fr) minmax(0, 0.68fr)");
    expect(cssBlock(styles, ".console-shell[class].mode-monitoring .monitoring-onboarding-sessions {")).toContain("padding-left: 0");
    const sessionPreview = cssBlock(styles, ".console-shell[class].mode-monitoring .monitoring-onboarding-session-preview {");
    expect(sessionPreview).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(sessionPreview).toContain("padding: 5px 0");
    expect(cssBlock(styles, ".console-shell[class].mode-monitoring .monitoring-onboarding-session-preview > span {")).toContain("grid-template-columns: minmax(0, 1fr) auto");
    expect(styles).not.toContain(".monitoring-onboarding-session-preview > input[type=\"checkbox\"]");
    expect(cssBlock(styles, ".console-shell[class].mode-monitoring :is(.monitoring-onboarding-project-choice, .monitoring-onboarding-default, .monitoring-onboarding-session-preview) > span {")).toContain("margin-bottom: 0");
  });

  test("keeps the source-session count intact beside a truncating workspace path", () => {
    expect(script).toContain('class="monitoring-onboarding-project-meta"');
    expect(script).toContain('class="monitoring-onboarding-project-path"');
    expect(script).toContain('class="monitoring-onboarding-project-count"');
    expect(cssBlock(styles, ".monitoring-onboarding-project-meta {")).toContain("display: flex");
    expect(cssBlock(styles, ".monitoring-onboarding-project-path {")).toContain("text-overflow: ellipsis");
    expect(cssBlock(styles, ".monitoring-onboarding-project-count {")).toContain("white-space: nowrap");
    expect(cssBlock(styles, ".monitoring-onboarding-candidate-heading .monitoring-onboarding-project-count {")).toContain("display: inline-flex");
    expect(cssBlock(styles, ".monitoring-onboarding-project-count [data-onboarding-candidate-count] {")).toContain("display: inline");
  });

  test("keeps the 640x480 settings window dense while its content scrolls", () => {
    expect(electronMain).toContain("createSettingsWindowOptions");
    expect(electronMain).toContain('preloadPath: resolve(sourceRoot, "src/electron/preload.cjs")');
    expect(settingsStyles).toContain("height: 100dvh");
    const nativeSettingsStyles = settingsStyles.slice(settingsStyles.indexOf("/* The native settings window is 640x480"));
    expect(cssBlock(nativeSettingsStyles, ".settings-layout {")).toContain("display: grid");
    expect(cssBlock(nativeSettingsStyles, ".settings-nav {")).toContain("display: grid");
    expect(cssBlock(nativeSettingsStyles, ".settings-nav {")).toContain("overflow: visible");
    expect(cssBlock(nativeSettingsStyles, ".settings-content {")).toContain("overflow-y: auto");
    expect(settingsPage).toContain('id="settings-language"');
    expect(settingsPage).toContain('id="settings-theme"');
    expect(settingsPage).toContain('value="system">跟随系统');
  });

  test("keeps native Settings labels, controls, and card actions on one row", () => {
    const nativeSettingsStyles = settingsStyles.slice(settingsStyles.indexOf("/* The native settings window is 640x480"));
    const settingRow = cssBlock(nativeSettingsStyles, ".setting-row {");
    const advancedCard = cssBlock(nativeSettingsStyles, ".advanced-card {");
    const sourceLabel = cssBlock(nativeSettingsStyles, ".source-settings label {");
    expect(settingRow).toContain("flex-direction: row");
    expect(settingRow).toContain("flex-wrap: nowrap");
    expect(advancedCard).toContain("flex-direction: row");
    expect(advancedCard).toContain("flex-wrap: nowrap");
    expect(sourceLabel).toContain("grid-template-columns: minmax(104px, 0.42fr) minmax(0, 1fr)");
    expect(cssBlock(nativeSettingsStyles, ".settings-feedback:empty {")).toContain("display: none");
    expect(cssBlock(nativeSettingsStyles, ".setting-row > select {")).toContain("width: 168px");
    expect(cssBlock(nativeSettingsStyles, ".restore-actions[hidden] {")).toContain("display: none");
  });

  test("does not leave a clipped shortcut trace beside Settings", () => {
    expect(page).not.toContain("<kbd>");
    expect(styles).not.toContain("#open-settings kbd");
  });

  test("shows a valid weekly-only Codex quota instead of unknown", () => {
    expect(script).toContain('quotaWindowSummary(quota, state.locale)');
    expect(script).toContain('const quotaWindows = availableQuotaWindows(codex)');
    expect(script).not.toContain('quota?.shortWindow && quota?.longWindow');
    const weeklyOnly = {
      status: "available",
      shortWindow: null,
      longWindow: { usedPercent: 24, windowMinutes: 10_080, resetsAt: "2026-08-16T00:00:00.000Z" },
    };
    expect(availableQuotaWindows(weeklyOnly).map(({ key }) => key)).toEqual(["long"]);
    expect(quotaWindowSummary(weeklyOnly, "zh-CN")).toBe("周额度 76% 可用");
    expect(quotaWindowSummary(weeklyOnly, "en")).toBe("Weekly 76% available");
    expect(quotaWindowSummary({ status: "available", shortWindow: null, longWindow: null }, "zh-CN")).toBeNull();
    expect(serverApp).toContain('"/resource-window-presentation.js"');
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
