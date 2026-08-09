import { open } from "node:fs/promises";

const MAX_SESSION_SOURCE_READ_BYTES = 32 * 1024 * 1024;

export type DiscoveredSession = {
  id: string;
  title: string;
  workspacePath: string | null;
  projectLabel: string;
  lastActiveAt: string;
  sourcePath: string | null;
  sourcePosition?: number | null;
  sourceModifiedAt?: string | null;
  availability: "available" | "degraded" | "unavailable";
  message: string | null;
};

export type SessionDiscoveryResult = {
  status: "available" | "partial" | "unavailable";
  message: string;
  sessions: DiscoveredSession[];
};

export type SessionSourceRead = {
  content: string;
  nextPosition: number;
};

export interface SessionProvider {
  discover(signal?: AbortSignal): Promise<SessionDiscoveryResult>;
  read?(
    session: DiscoveredSession,
    fromPosition: number,
    signal?: AbortSignal,
  ): Promise<SessionSourceRead>;
}

export async function readSessionSource(
  session: DiscoveredSession,
  fromPosition: number,
  signal?: AbortSignal,
): Promise<SessionSourceRead> {
  if (!session.sourcePath) throw new Error("来源文件不可用");
  if (!Number.isInteger(fromPosition) || fromPosition < 0) {
    throw new Error("来源读取位置无效");
  }
  if (signal?.aborted) throw new Error("来源读取已停止");

  const descriptor = await open(session.sourcePath, "r");
  try {
    if (signal?.aborted) throw new Error("来源读取已停止");
    const details = await descriptor.stat();
    const start = fromPosition <= details.size ? fromPosition : 0;
    if (details.size - start > MAX_SESSION_SOURCE_READ_BYTES) {
      throw new Error("来源会话增量过大，请缩小来源后重试");
    }
    const buffer = Buffer.alloc(details.size - start);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      if (signal?.aborted) throw new Error("来源读取已停止");
      const result = await descriptor.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        start + bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const readable = buffer.subarray(0, bytesRead);
    const lastNewline = readable.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      return { content: "", nextPosition: start };
    }
    const completeBytes = lastNewline + 1;
    return {
      content: readable.subarray(0, completeBytes).toString("utf8"),
      nextPosition: start + completeBytes,
    };
  } finally {
    await descriptor.close();
  }
}
