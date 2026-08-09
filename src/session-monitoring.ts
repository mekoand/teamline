import type { DiscoveredSession } from "./session-discovery";

export type SessionMonitoringOrganizationStatus =
  | "not_started"
  | "pending"
  | "ready"
  | "failed";

export const sessionMonitoringRefreshModes = [
  "automatic",
  "manual",
  "deep",
] as const;

export type SessionMonitoringRefreshMode = (typeof sessionMonitoringRefreshModes)[number];

export type SessionMonitoringRefreshIntent = {
  mode: SessionMonitoringRefreshMode;
  requestedAt: string;
};

export type SessionMonitoringWork = {
  id: string;
  projectId: string | null;
  name: string;
  sourceSessionKeys: string[];
  aggregateSnapshotRef: string | null;
  aggregateSnapshot: unknown | null;
  aggregateStatus: SessionMonitoringOrganizationStatus;
  aggregateMessage: string | null;
  aggregateUpdatedAt: string | null;
  lastAutomaticCompletedAt: string | null;
  pendingRefreshIntent: SessionMonitoringRefreshIntent | null;
  createdAt: string;
  updatedAt: string;
};

export type SessionMonitoringRecord = {
  key: string;
  sourceKind: "codex_session" | "claude_code_session";
  executionIdentityId: string | null;
  executionIdentityLabel: string | null;
  id: string;
  title: string;
  workspacePath: string | null;
  projectLabel: string;
  lastActiveAt: string;
  sourcePath: string | null;
  sourcePosition: number | null;
  sourceModifiedAt: string | null;
  availability: DiscoveredSession["availability"];
  message: string | null;
  projectId: string | null;
  monitoringEnabled: boolean;
  monitoringOverride: boolean | null;
  lastDiscoveredAt: string;
  lastReadPosition: number | null;
  lastReadAt: string | null;
  organizationStatus: SessionMonitoringOrganizationStatus;
  workGraphSnapshot: unknown | null;
  createdAt: string;
  updatedAt: string;
};

export type SessionMonitoringResourceUsage = {
  id: string;
  sessionKey: string;
  sourceKind: SessionMonitoringRecord["sourceKind"];
  tool: string;
  model: string;
  accountId: string | null;
  accountLabel: string | null;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  completedAt: string | null;
  message: string | null;
};

export type SessionMonitoringUpdate = {
  projectId?: string | null;
  monitoringEnabled?: boolean;
  monitoringOverride?: boolean | null;
  message?: string | null;
  lastReadPosition?: number | null;
  lastReadAt?: string | null;
  organizationStatus?: SessionMonitoringOrganizationStatus;
  workGraphSnapshot?: unknown | null;
};

export function sessionMonitoringKey(
  sourceKind: SessionMonitoringRecord["sourceKind"],
  executionIdentityId: string | null,
  id: string,
): string {
  return `${sourceKind}:${executionIdentityId ?? "none"}:${id}`;
}
