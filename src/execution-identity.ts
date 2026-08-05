export const executionIdentityStatuses = ["enabled", "disabled", "removed"] as const;
export type ExecutionIdentityStatus = (typeof executionIdentityStatuses)[number];

export const executionIdentityLoginStates = [
  "unknown",
  "signed_out",
  "pending",
  "ready",
  "expired",
] as const;
export type ExecutionIdentityLoginState =
  (typeof executionIdentityLoginStates)[number];

export type ExecutionIdentityHomeKind = "system" | "managed";

export type ExecutionIdentity = {
  id: string;
  tool: "codex";
  label: string;
  status: ExecutionIdentityStatus;
  homeKind: ExecutionIdentityHomeKind;
  managedHomePath: string | null;
  accountFingerprint: string | null;
  loginState: ExecutionIdentityLoginState;
  capabilities: string[];
  lastObservedAt: string | null;
  createdAt: string;
  updatedAt: string;
  removedAt: string | null;
};

export type ExecutionIdentitySummary = Omit<
  ExecutionIdentity,
  "managedHomePath" | "accountFingerprint"
> & {
  isDefault: boolean;
  executable: boolean;
};

export type ExecutionIdentityObservation = {
  accountFingerprint?: string | null;
  loginState: ExecutionIdentityLoginState;
  capabilities?: string[];
  observedAt?: string;
};

export function presentExecutionIdentity(
  identity: ExecutionIdentity,
  defaultIdentityId: string | null,
): ExecutionIdentitySummary {
  return {
    id: identity.id,
    tool: identity.tool,
    label: identity.label,
    status: identity.status,
    homeKind: identity.homeKind,
    loginState: identity.loginState,
    capabilities: identity.capabilities,
    lastObservedAt: identity.lastObservedAt,
    createdAt: identity.createdAt,
    updatedAt: identity.updatedAt,
    removedAt: identity.removedAt,
    isDefault: identity.id === defaultIdentityId,
    executable:
      identity.status === "enabled" &&
      (identity.loginState === "ready" ||
        (identity.homeKind === "system" && identity.loginState === "unknown")),
  };
}
