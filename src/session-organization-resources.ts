import type { ExecutionIdentity } from "./execution-identity";
import type {
  ResourceSelection,
  SessionOrganizationResourceRequest,
  SessionOrganizationResourceSelector,
} from "./resource-provider";

export type SessionOrganizationSourcePreference = {
  /** An opaque model reference understood by the source adapter. */
  automaticModel: string | null;
  /** A one-off high-quality choice; it never becomes the automatic default. */
  deepModel: string | null;
  /** An explicitly configured model used only when automaticModel is not configured. */
  fallbackModel: string | null;
  accountId: string | null;
};

export type SessionOrganizationModelSettings = {
  sources: Record<string, SessionOrganizationSourcePreference>;
};

export type SessionOrganizationResourceSelectorDependencies = {
  getSettings: () => SessionOrganizationModelSettings;
  getIdentity: (id: string) => ExecutionIdentity | null;
  getCurrentIdentityId: () => string | null;
  getDefaultIdentityId: () => string | null;
};

const sourceAliases = new Map([
  ["codex", "codex"],
  ["codex_session", "codex"],
]);

function sourceKey(sourceKind: string): string | null {
  return sourceAliases.get(sourceKind.trim().toLowerCase()) ?? null;
}

function configuredIdentity(
  dependencies: SessionOrganizationResourceSelectorDependencies,
  request: SessionOrganizationResourceRequest,
  preference: SessionOrganizationSourcePreference,
): ExecutionIdentity | null {
  const identityId = request.accountId?.trim() ||
    preference.accountId?.trim() ||
    dependencies.getCurrentIdentityId() ||
    dependencies.getDefaultIdentityId();
  if (!identityId) return null;
  const identity = dependencies.getIdentity(identityId);
  if (!identity || identity.tool !== "codex") return null;
  if (
    identity.status !== "enabled" ||
    (identity.loginState !== "ready" &&
      !(identity.homeKind === "system" && identity.loginState === "unknown"))
  ) {
    return null;
  }
  return identity;
}

export function createSessionOrganizationResourceSelector(
  dependencies: SessionOrganizationResourceSelectorDependencies,
): SessionOrganizationResourceSelector {
  return {
    async select(request): Promise<ResourceSelection | null> {
      const source = sourceKey(request.sourceKind);
      // The selector only knows how to execute Codex resources. A source
      // without its own adapter must wait or fail explicitly, never switch
      // tools behind the user's back.
      if (!source) return null;

      const preference = dependencies.getSettings().sources[source];
      if (!preference) return null;

      const model = request.preference === "high_quality"
        ? preference.deepModel
        : preference.automaticModel ?? preference.fallbackModel;
      // Deep is intentionally strict: missing deep configuration does not
      // silently fall back to the automatic model.
      if (!model) return null;

      const identity = configuredIdentity(dependencies, request, preference);
      if (!identity) return null;

      return {
        tool: source,
        model,
        accountId: identity.id,
        accountLabel: identity.label,
      };
    },
  };
}

export function emptySessionOrganizationModelSettings(): SessionOrganizationModelSettings {
  return { sources: {} };
}

function normalizeOptionalText(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new Error(`模型设置中的 ${field} 无效`);
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > 200) throw new Error(`模型设置中的 ${field} 过长`);
  return normalized;
}

export function normalizeSessionOrganizationModelSettings(
  value: unknown,
): SessionOrganizationModelSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("模型设置无效");
  }
  const sourcesValue = (value as { sources?: unknown }).sources;
  if (!sourcesValue || typeof sourcesValue !== "object" || Array.isArray(sourcesValue)) {
    throw new Error("模型来源设置无效");
  }
  const sources: Record<string, SessionOrganizationSourcePreference> = {};
  for (const [rawSource, rawPreference] of Object.entries(sourcesValue)) {
    const source = rawSource.trim();
    if (!source || source.length > 80 || !/^[a-z0-9:_-]+$/i.test(source)) {
      throw new Error("模型来源名称无效");
    }
    if (!rawPreference || typeof rawPreference !== "object" || Array.isArray(rawPreference)) {
      throw new Error("模型来源设置无效");
    }
    const preference = rawPreference as Record<string, unknown>;
    sources[source] = {
      automaticModel: normalizeOptionalText(preference.automaticModel, "自动模型"),
      deepModel: normalizeOptionalText(preference.deepModel, "深度模型"),
      fallbackModel: normalizeOptionalText(preference.fallbackModel, "替代模型"),
      accountId: normalizeOptionalText(preference.accountId, "账号"),
    };
  }
  return { sources };
}
