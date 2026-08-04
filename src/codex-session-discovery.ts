import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import type {
  DiscoveredSession,
  SessionDiscoveryResult,
  SessionProvider,
} from "./session-discovery";

export type DiscoveredCodexSession = DiscoveredSession;
export type CodexSessionDiscoveryResult = SessionDiscoveryResult;
export type CodexSessionProvider = SessionProvider;

type SessionIndexEntry = {
  id: string;
  threadName: string | null;
  updatedAt: string | null;
};

type SessionIndexReadResult = {
  entries: Map<string, SessionIndexEntry>;
  status: "available" | "degraded" | "unavailable";
  message: string | null;
};

type RolloutMetadata = {
  id: string;
  cwd: string | null;
  isSubagent: boolean;
};

const MAX_SESSION_FILES = 200;
const MAX_VISIBLE_SESSIONS = 50;
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_INDEX_BYTES = 10 * 1024 * 1024;

export class LocalCodexSessionProvider implements SessionProvider {
  constructor(private readonly codexHome: string) {}

  async discover(): Promise<CodexSessionDiscoveryResult> {
    const indexPath = join(this.codexHome, "session_index.jsonl");
    const sessionsRoot = join(this.codexHome, "sessions");
    const indexRead = readSessionIndex(indexPath);
    const index = indexRead.entries;
    const rolloutFiles = listRecentRolloutFiles(sessionsRoot);
    const sessions = new Map<string, DiscoveredCodexSession>();

    for (const file of rolloutFiles) {
      const metadata = readRolloutMetadata(file.path, file.id);
      if (metadata?.isSubagent) continue;
      const id = metadata?.id ?? file.id;
      if (!id) continue;
      const indexed = index.get(id);
      const title = indexed?.threadName || "未命名 Codex 会话";
      const workspacePath = metadata?.cwd ?? null;
      const workspaceAvailable = workspacePath ? existsSync(workspacePath) : false;
      const lastActiveAt = latestTimestamp(indexed?.updatedAt, file.modifiedAt);
      const degraded = !indexed?.threadName || !workspacePath || !workspaceAvailable;
      sessions.set(id, {
        id,
        title,
        workspacePath,
        projectLabel: workspacePath ? basename(workspacePath) || workspacePath : "文件夹不可用",
        lastActiveAt,
        sourcePath: file.path,
        availability: degraded ? "degraded" : "available",
        message: degraded
          ? [
              !indexed?.threadName ? "标题不可用" : null,
              !workspacePath
                ? "文件夹不可用"
                : !workspaceAvailable
                  ? "记录的文件夹当前不可用"
                  : null,
            ]
              .filter(Boolean)
              .join("，")
          : null,
      });
    }

    for (const indexed of index.values()) {
      if (sessions.has(indexed.id)) continue;
      sessions.set(indexed.id, {
        id: indexed.id,
        title: indexed.threadName || "未命名 Codex 会话",
        workspacePath: null,
        projectLabel: "来源文件不可用",
        lastActiveAt: indexed.updatedAt || new Date(0).toISOString(),
        sourcePath: null,
        availability: "unavailable",
        message: "本地会话索引仍在，但来源文件已经不可用",
      });
    }

    const sorted = [...sessions.values()]
      .sort((left, right) => Date.parse(right.lastActiveAt) - Date.parse(left.lastActiveAt))
      .slice(0, MAX_VISIBLE_SESSIONS);
    if (!existsSync(indexPath) && !existsSync(sessionsRoot)) {
      return {
        status: "unavailable",
        message: "没有找到 Codex 本机会话目录，请确认 Codex 已在这台电脑上使用过",
        sessions: [],
      };
    }
    if (sorted.length === 0) {
      return {
        status: "unavailable",
        message:
          indexRead.message || "Codex 会话来源存在，但没有可读取的会话元数据",
        sessions: [],
      };
    }
    const partial =
      indexRead.status !== "available" ||
      sorted.some((session) => session.availability !== "available");
    return {
      status: partial ? "partial" : "available",
      message:
        indexRead.message ||
        (partial
          ? "部分会话缺少标题、文件夹或来源文件，Teamline 已按可读取字段展示"
          : "只读取本机 Codex 会话索引和必要元数据"),
      sessions: sorted,
    };
  }
}

function readSessionIndex(path: string): SessionIndexReadResult {
  const entries = new Map<string, SessionIndexEntry>();
  if (!existsSync(path)) {
    return {
      entries,
      status: "unavailable",
      message: "Codex 会话索引不可用，已按来源文件中的可读取字段展示",
    };
  }
  try {
    const size = statSync(path).size;
    if (size > MAX_INDEX_BYTES) {
      return {
        entries,
        status: "unavailable",
        message: "Codex 会话索引过大，Teamline 未读取其内容",
      };
    }
    let invalidLines = 0;
    let nonEmptyLines = 0;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      nonEmptyLines += 1;
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (typeof value.id !== "string" || !value.id.trim()) {
          invalidLines += 1;
          continue;
        }
        const current = entries.get(value.id);
        const updatedAt = validTimestamp(value.updated_at);
        if (current && Date.parse(current.updatedAt ?? "") > Date.parse(updatedAt ?? "")) {
          continue;
        }
        entries.set(value.id, {
          id: value.id,
          threadName:
            typeof value.thread_name === "string" && value.thread_name.trim()
              ? value.thread_name.trim()
              : null,
          updatedAt,
        });
      } catch {
        invalidLines += 1;
      }
    }
    if (nonEmptyLines === 0 || entries.size === 0) {
      return {
        entries,
        status: "unavailable",
        message: "Codex 会话索引为空或无法解析",
      };
    }
    return {
      entries,
      status: invalidLines > 0 ? "degraded" : "available",
      message:
        invalidLines > 0
          ? "Codex 会话索引有部分内容无法解析，已按可读取字段展示"
          : null,
    };
  } catch {
    return {
      entries,
      status: "unavailable",
      message: "Codex 会话索引读取失败，已按来源文件中的可读取字段展示",
    };
  }
}

function listRecentRolloutFiles(root: string): Array<{
  id: string;
  path: string;
  modifiedAt: string;
}> {
  if (!existsSync(root)) return [];
  const files: Array<{ id: string; path: string; modifiedAt: string }> = [];
  const visit = (directory: string) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile() || !/^rollout-.*\.jsonl$/.test(entry.name)) continue;
      const id = entry.name.match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i)?.[1];
      if (!id) continue;
      try {
        const details = lstatSync(path);
        if (!details.isFile()) continue;
        files.push({ id, path, modifiedAt: details.mtime.toISOString() });
      } catch {
        // The file may disappear while Codex rotates local sessions.
      }
    }
  };
  visit(root);
  return files
    .sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt))
    .slice(0, MAX_SESSION_FILES);
}

function readRolloutMetadata(path: string, expectedId: string): RolloutMetadata | null {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, "r");
    const buffer = Buffer.alloc(MAX_METADATA_BYTES);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    let fallback: RolloutMetadata | null = null;
    for (const line of buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as {
          type?: unknown;
          payload?: Record<string, unknown>;
        };
        if (value.type !== "session_meta" || !value.payload) continue;
        const id =
          typeof value.payload.id === "string"
            ? value.payload.id
            : typeof value.payload.session_id === "string"
              ? value.payload.session_id
              : null;
        if (!id) continue;
        const metadata = {
          id,
          cwd:
            typeof value.payload.cwd === "string" && value.payload.cwd.trim()
              ? value.payload.cwd.trim()
              : null,
          isSubagent:
            Boolean(value.payload.parent_thread_id) ||
            Boolean(value.payload.agent_path) ||
            (typeof value.payload.source === "object" &&
              value.payload.source !== null &&
              "subagent" in value.payload.source),
        };
        if (id === expectedId) return metadata;
        fallback ??= metadata;
      } catch {
        // Ignore non-JSON or partially written lines.
      }
    }
    return fallback;
  } catch {
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function validTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function latestTimestamp(left: string | null | undefined, right: string): string {
  if (!left || !Number.isFinite(Date.parse(left))) return right;
  return Date.parse(left) > Date.parse(right) ? left : right;
}
