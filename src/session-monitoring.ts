import type { DiscoveredSession } from "./session-discovery";

export type SessionMonitoringOrganizationStatus =
  | "not_started"
  | "pending"
  | "ready"
  | "failed";

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
  availability: DiscoveredSession["availability"];
  message: string | null;
  projectId: string | null;
  monitoringEnabled: boolean;
  lastDiscoveredAt: string;
  lastReadPosition: number | null;
  lastReadAt: string | null;
  organizationStatus: SessionMonitoringOrganizationStatus;
  workGraphSnapshot: unknown | null;
  createdAt: string;
  updatedAt: string;
};

export type SessionMonitoringUpdate = {
  projectId?: string | null;
  monitoringEnabled?: boolean;
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
