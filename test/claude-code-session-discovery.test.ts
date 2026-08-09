import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalClaudeCodeSessionProvider } from "../src/claude-code-session-discovery";

describe("local Claude Code session discovery", () => {
  test("reads only stable metadata and never returns conversation text", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-claude-sessions-"));
    const project = join(root, "-Users-yeko-project");
    const workspace = join(root, "project");
    const source = join(project, "session-a.jsonl");
    mkdirSync(project, { recursive: true });
    mkdirSync(workspace);
    writeFileSync(source, [
      JSON.stringify({ type: "user", sessionId: "session-a", cwd: workspace, message: { content: "private prompt" } }),
      JSON.stringify({ type: "assistant", sessionId: "session-a", cwd: workspace, message: { content: "private response" } }),
    ].join("\n"));
    utimesSync(source, new Date("2026-08-04T06:00:00Z"), new Date("2026-08-04T06:00:00Z"));

    try {
      const result = await new LocalClaudeCodeSessionProvider(root).discover();
      expect(result).toEqual({
        status: "available",
        message: "只读取本机 Claude Code 会话的必要元数据",
        sessions: [{
          id: "session-a",
          title: "Claude Code · project",
          workspacePath: workspace,
          projectLabel: "project",
          lastActiveAt: "2026-08-04T06:00:00.000Z",
          sourcePath: source,
          sourcePosition: expect.any(Number),
          sourceModifiedAt: "2026-08-04T06:00:00.000Z",
          availability: "available",
          message: null,
        }],
      });
      expect(JSON.stringify(result)).not.toContain("private prompt");
      expect(JSON.stringify(result)).not.toContain("private response");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reads an appended increment and rejects a disappeared source", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-claude-sessions-"));
    const project = join(root, "project-a");
    const workspace = join(root, "project");
    const source = join(project, "session-a.jsonl");
    mkdirSync(project, { recursive: true });
    mkdirSync(workspace);
    const initial = `${JSON.stringify({ type: "user", sessionId: "session-a", cwd: workspace })}\n`;
    const appended = `${JSON.stringify({ type: "assistant", sessionId: "session-a" })}\n`;
    writeFileSync(source, initial);
    const provider = new LocalClaudeCodeSessionProvider(root);

    try {
      const session = (await provider.discover()).sessions[0]!;
      const first = await provider.read!(session, 0);
      expect(first).toEqual({ content: initial, nextPosition: Buffer.byteLength(initial) });
      writeFileSync(source, initial + appended);
      expect(await provider.read!(session, Buffer.byteLength(initial))).toEqual({
        content: appended,
        nextPosition: Buffer.byteLength(initial + appended),
      });
      rmSync(source);
      await expect(provider.read!(session, 0)).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps a session with missing workspace as degraded", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-claude-sessions-"));
    const project = join(root, "project-a");
    mkdirSync(project);
    writeFileSync(join(project, "session-a.jsonl"), `${JSON.stringify({ type: "user", sessionId: "session-a" })}\n`);
    try {
      const result = await new LocalClaudeCodeSessionProvider(root).discover();
      expect(result.status).toBe("partial");
      expect(result.sessions[0]).toMatchObject({
        id: "session-a",
        workspacePath: null,
        title: "未命名 Claude Code 会话",
        projectLabel: "文件夹不可用",
        availability: "degraded",
        message: "工作文件夹不可用",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ignores nested and symlinked session files", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-claude-sessions-"));
    const project = join(root, "project-a");
    const elsewhere = join(root, "elsewhere.jsonl");
    mkdirSync(join(project, "subagents"), { recursive: true });
    writeFileSync(elsewhere, `${JSON.stringify({ type: "user", sessionId: "outside" })}\n`);
    writeFileSync(join(project, "subagents", "nested.jsonl"), `${JSON.stringify({ type: "user", sessionId: "nested" })}\n`);
    symlinkSync(elsewhere, join(project, "linked.jsonl"));
    try {
      expect((await new LocalClaudeCodeSessionProvider(root).discover()).sessions).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("filters a direct file that contains only explicit sidechain records", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-claude-sessions-"));
    const project = join(root, "project-a");
    mkdirSync(project);
    writeFileSync(join(project, "sidechain.jsonl"), [
      JSON.stringify({ type: "user", sessionId: "sidechain", isSidechain: true }),
      JSON.stringify({ type: "assistant", sessionId: "sidechain", isSidechain: true }),
    ].join("\n"));
    try {
      expect((await new LocalClaudeCodeSessionProvider(root).discover()).sessions).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports a missing local source without failing", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-claude-sessions-"));
    rmSync(root, { recursive: true, force: true });
    expect(await new LocalClaudeCodeSessionProvider(root).discover()).toEqual({
      status: "unavailable",
      message: "没有找到 Claude Code 本机会话目录，请确认 Claude Code 已在这台电脑上使用过",
      sessions: [],
    });
  });
});
