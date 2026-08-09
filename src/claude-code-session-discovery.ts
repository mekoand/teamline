import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import type {
  DiscoveredSession,
  SessionDiscoveryResult,
  SessionSourceRead,
  SessionProvider,
} from "./session-discovery";
import { readSessionSource } from "./session-discovery";

const MAX_SESSION_FILES = 200;
const MAX_VISIBLE_SESSIONS = 50;
const MAX_METADATA_BYTES = 256 * 1024;

type ClaudeSessionMetadata = {
  id: string;
  cwd: string | null;
  hasConversation: boolean;
  sidechainOnly: boolean;
};

export class LocalClaudeCodeSessionProvider implements SessionProvider {
  constructor(private readonly projectsRoot: string) {}

  async discover(): Promise<SessionDiscoveryResult> {
    if (!existsSync(this.projectsRoot)) {
      return {
        status: "unavailable",
        message: "没有找到 Claude Code 本机会话目录，请确认 Claude Code 已在这台电脑上使用过",
        sessions: [],
      };
    }

    const files = listRecentSessionFiles(this.projectsRoot);
    const sessions = files
      .map((file) => readClaudeSession(file.path, file.modifiedAt, file.size))
      .filter((session): session is DiscoveredSession => session !== null)
      .sort((left, right) => Date.parse(right.lastActiveAt) - Date.parse(left.lastActiveAt))
      .slice(0, MAX_VISIBLE_SESSIONS);

    if (sessions.length === 0) {
      return {
        status: "unavailable",
        message: "Claude Code 会话目录存在，但没有可读取的会话元数据",
        sessions: [],
      };
    }
    const partial = sessions.some((session) => session.availability !== "available");
    return {
      status: partial ? "partial" : "available",
      message: partial
        ? "部分 Claude Code 会话缺少工作文件夹，Teamline 已按可读取字段展示"
        : "只读取本机 Claude Code 会话的必要元数据",
      sessions,
    };
  }

  read(
    session: DiscoveredSession,
    fromPosition: number,
    signal?: AbortSignal,
  ): Promise<SessionSourceRead> {
    return readSessionSource(session, fromPosition, signal);
  }
}

function listRecentSessionFiles(root: string): Array<{
  path: string;
  modifiedAt: string;
  size: number;
}> {
  const files: Array<{ path: string; modifiedAt: string; size: number }> = [];
  try {
    for (const projectEntry of readdirSync(root, { withFileTypes: true })) {
      if (!projectEntry.isDirectory() || projectEntry.isSymbolicLink()) continue;
      const projectPath = join(root, projectEntry.name);
      for (const sessionEntry of readdirSync(projectPath, { withFileTypes: true })) {
        if (!sessionEntry.isFile() || sessionEntry.isSymbolicLink()) continue;
        if (extname(sessionEntry.name) !== ".jsonl") continue;
        const path = join(projectPath, sessionEntry.name);
        try {
          if (lstatSync(path).isSymbolicLink()) continue;
          const details = statSync(path);
          files.push({
            path,
            modifiedAt: details.mtime.toISOString(),
            size: details.size,
          });
        } catch {
          // A file can disappear while the local session list is being read.
        }
      }
    }
  } catch {
    return [];
  }
  return files
    .sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt))
    .slice(0, MAX_SESSION_FILES);
}

function readClaudeSession(
  path: string,
  modifiedAt: string,
  sourcePosition?: number,
): DiscoveredSession | null {
  const metadata = readMetadata(path);
  if (!metadata || !metadata.hasConversation || metadata.sidechainOnly) return null;
  const workspacePath = metadata.cwd;
  const workspaceAvailable = workspacePath ? existsSync(workspacePath) : false;
  const projectLabel = workspacePath ? basename(workspacePath) || workspacePath : "文件夹不可用";
  const degraded = !workspacePath || !workspaceAvailable;
  return {
    id: metadata.id,
    title: workspacePath ? `Claude Code · ${projectLabel}` : "未命名 Claude Code 会话",
    workspacePath,
    projectLabel,
    lastActiveAt: modifiedAt,
    sourcePath: path,
    sourcePosition: sourcePosition ?? null,
    sourceModifiedAt: modifiedAt,
    availability: degraded ? "degraded" : "available",
    message: !workspacePath
      ? "工作文件夹不可用"
      : !workspaceAvailable
        ? "记录的工作文件夹当前不可用"
        : null,
  };
}

function readMetadata(path: string): ClaudeSessionMetadata | null {
  let file: number | undefined;
  try {
    const size = Math.min(statSync(path).size, MAX_METADATA_BYTES);
    const buffer = Buffer.alloc(size);
    file = openSync(path, "r");
    const bytesRead = readSync(file, buffer, 0, size, 0);
    const fallbackId = basename(path, ".jsonl").trim();
    let id = fallbackId;
    let cwd: string | null = null;
    let conversationRecords = 0;
    let mainConversationRecords = 0;
    for (const line of buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (typeof value.sessionId === "string" && value.sessionId.trim()) {
          id = value.sessionId.trim();
        }
        if (typeof value.cwd === "string" && value.cwd.trim()) {
          cwd = value.cwd.trim();
        }
        if (value.type === "user" || value.type === "assistant") {
          conversationRecords += 1;
          if (value.isSidechain !== true) mainConversationRecords += 1;
        }
      } catch {
        // Ignore damaged records and keep scanning the bounded metadata prefix.
      }
    }
    return id
      ? {
          id,
          cwd,
          hasConversation: conversationRecords > 0,
          sidechainOnly: conversationRecords > 0 && mainConversationRecords === 0,
        }
      : null;
  } catch {
    return null;
  } finally {
    if (file !== undefined) closeSync(file);
  }
}
