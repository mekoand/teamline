export type DiscoveredSession = {
  id: string;
  title: string;
  workspacePath: string | null;
  projectLabel: string;
  lastActiveAt: string;
  sourcePath: string | null;
  availability: "available" | "degraded" | "unavailable";
  message: string | null;
};

export type SessionDiscoveryResult = {
  status: "available" | "partial" | "unavailable";
  message: string;
  sessions: DiscoveredSession[];
};

export interface SessionProvider {
  discover(): Promise<SessionDiscoveryResult>;
}
