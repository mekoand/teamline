export const interfaceLocales = ["en", "zh-CN"];

const en = {
  "app.title": "Teamline — local AI work control",
  "language.label": "Language",
  "language.en": "English",
  "language.zh-CN": "简体中文",
  "nav.goals": "Goals",
  "nav.projects": "Projects",
  "nav.resources": "Resources",
  "nav.local_state": "Export and restore",
  "nav.notifications": "Notifications",
  "action.create_goal": "Create goal",
  "action.import_session": "Import session",
  "action.close": "Close",
  "action.cancel": "Cancel",
  "action.confirm": "Confirm",
  "shell.goals": "Goals",
  "shell.goal_count": "0 local goals",
  "shell.loading_goals": "Loading local goals…",
  "shell.context": "Context inspector",
  "status.planning": "Planning",
  "status.running": "Running",
  "status.queued": "Queued",
  "status.response": "Needs response",
  "status.review": "Review-ready",
  "status.completed": "Completed",
};

const zhCN = {
  "app.title": "Teamline — 本地 AI 工作控制",
  "language.label": "语言",
  "language.en": "English",
  "language.zh-CN": "简体中文",
  "nav.goals": "目标",
  "nav.projects": "项目",
  "nav.resources": "资源",
  "nav.local_state": "导出与恢复",
  "nav.notifications": "通知",
  "action.create_goal": "新建目标",
  "action.import_session": "导入会话",
  "action.close": "关闭",
  "action.cancel": "取消",
  "action.confirm": "确认",
  "shell.goals": "目标",
  "shell.goal_count": "0 个本地目标",
  "shell.loading_goals": "正在读取本地目标…",
  "shell.context": "上下文检查栏",
  "status.planning": "规划中",
  "status.running": "运行中",
  "status.queued": "待运行",
  "status.response": "需响应",
  "status.review": "待验收",
  "status.completed": "已完成",
};

export const catalogs = { en, "zh-CN": zhCN };

export function normalizeLocale(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  if (
    normalized === "zh" ||
    normalized === "zh-cn" ||
    normalized === "zh-hans" ||
    normalized.startsWith("zh-hans-")
  ) {
    return "zh-CN";
  }
  return null;
}

export function resolveLocale({ saved, browserLanguages = [] } = {}) {
  const savedLocale = normalizeLocale(saved);
  if (savedLocale) return savedLocale;
  for (const language of browserLanguages) {
    const locale = normalizeLocale(language);
    if (locale) return locale;
  }
  return "en";
}

export function translate(locale, key, params = {}) {
  const template = catalogs[normalizeLocale(locale) || "en"]?.[key] ?? catalogs.en[key] ?? key;
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_, name) =>
    String(params[name] ?? `{${name}}`),
  );
}

export function catalogParameterNames(value) {
  return [...String(value).matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)]
    .map((match) => match[1])
    .sort();
}

export function applyStaticTranslations(root, locale) {
  root.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = translate(locale, element.dataset.i18n);
  });
  root.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
    element.setAttribute("aria-label", translate(locale, element.dataset.i18nAriaLabel));
  });
  root.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
    element.setAttribute("placeholder", translate(locale, element.dataset.i18nPlaceholder));
  });
  document.documentElement.lang = normalizeLocale(locale) || "en";
  document.title = translate(locale, "app.title");
}
