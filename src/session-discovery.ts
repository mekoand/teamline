import { open } from "node:fs/promises";

const MAX_SESSION_SOURCE_READ_BYTES = 512 * 1024;

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
  truncated?: true;
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
    const requestedStart = fromPosition <= details.size ? fromPosition : 0;
    const truncated = details.size - requestedStart > MAX_SESSION_SOURCE_READ_BYTES;
    const start = truncated
      ? Math.max(requestedStart, details.size - MAX_SESSION_SOURCE_READ_BYTES)
      : requestedStart;
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
    let firstCompleteByte = 0;
    if (truncated && start > requestedStart) {
      const previousByte = Buffer.alloc(1);
      await descriptor.read(previousByte, 0, 1, start - 1);
      if (previousByte[0] !== 0x0a) {
        const firstNewline = readable.indexOf(0x0a);
        firstCompleteByte = firstNewline < 0 ? -1 : firstNewline + 1;
      }
    }
    const lastNewline = readable.lastIndexOf(0x0a);
    if (truncated && (firstCompleteByte < 0 || firstCompleteByte > lastNewline)) {
      return { content: "", nextPosition: details.size, truncated: true };
    }
    if (lastNewline < 0) {
      return { content: "", nextPosition: start };
    }
    const completeBytes = lastNewline + 1;
    return {
      content: readable.subarray(firstCompleteByte, completeBytes).toString("utf8"),
      nextPosition: start + completeBytes,
      ...(truncated ? { truncated: true as const } : {}),
    };
  } finally {
    await descriptor.close();
  }
}
