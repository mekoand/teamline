import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalCodexSessionProvider } from "../src/codex-session-discovery";

describe("local Codex session discovery", () => {
  test("combines the local session index with rollout metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-codex-sessions-"));
    const id = "019fc374-5a5b-78b0-81da-c5bf1452cebf";
    const directory = join(root, "sessions", "2026", "08", "03");
    const workspace = join(root, "example-project");
    const rollout = join(directory, `rollout-2026-08-03T01-10-10-${id}.jsonl`);
    mkdirSync(directory, { recursive: true });
    mkdirSync(workspace);
    writeFileSync(
      join(root, "session_index.jsonl"),
      [
        JSON.stringify({ id, thread_name: "旧标题", updated_at: "2026-08-03T01:00:00Z" }),
        JSON.stringify({ id, thread_name: "设置页面重构", updated_at: "2026-08-03T02:00:00Z" }),
      ].join("\n"),
    );
    writeFileSync(
      rollout,
      `${JSON.stringify({ type: "session_meta", payload: { id, cwd: workspace } })}\n` +
        `${JSON.stringify({ type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: "private prompt must not be returned" }] } })}\n`,
    );
    utimesSync(rollout, new Date("2026-08-03T01:30:00Z"), new Date("2026-08-03T01:30:00Z"));

    try {
      const result = await new LocalCodexSessionProvider(root).discover();

      expect(result.status).toBe("available");
      expect(result.sessions).toEqual([
        {
          id,
          title: "设置页面重构",
          workspacePath: workspace,
          projectLabel: "example-project",
          lastActiveAt: "2026-08-03T02:00:00.000Z",
          sourcePath: rollout,
          sourcePosition: expect.any(Number),
          sourceModifiedAt: "2026-08-03T01:30:00.000Z",
          availability: "available",
          message: null,
        },
      ]);
      expect(JSON.stringify(result)).not.toContain("private prompt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reads only the requested source increment and reports a missing source", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-codex-sessions-"));
    const id = "019fc374-5a5b-78b0-81da-c5bf1452cebf";
    const directory = join(root, "sessions", "2026", "08", "03");
    const workspace = join(root, "example-project");
    const rollout = join(directory, `rollout-2026-08-03T01-10-10-${id}.jsonl`);
    mkdirSync(directory, { recursive: true });
    mkdirSync(workspace);
    const initial = `${JSON.stringify({ type: "session_meta", payload: { id, cwd: workspace } })}\n`;
    writeFileSync(rollout, initial);
    writeFileSync(
      join(root, "session_index.jsonl"),
      `${JSON.stringify({ id, thread_name: "增量会话", updated_at: "2026-08-03T02:00:00Z" })}\n`,
    );
    const provider = new LocalCodexSessionProvider(root);

    try {
      const discovered = await provider.discover();
      const session = discovered.sessions[0]!;
      const first = await provider.read!(session, 0);
      expect(first).toEqual({ content: initial, nextPosition: Buffer.byteLength(initial) });
      const appended = `${JSON.stringify({ type: "response_item", payload: { role: "assistant" } })}\n`;
      writeFileSync(rollout, initial + appended);
      const increment = await provider.read!(
        { ...session, sourcePosition: Buffer.byteLength(initial) },
        Buffer.byteLength(initial),
      );
      expect(increment).toEqual({
        content: appended,
        nextPosition: Buffer.byteLength(initial + appended),
      });
      const partial = JSON.stringify({ type: "response_item", payload: { role: "user" } });
      const completePosition = Buffer.byteLength(initial + appended);
      writeFileSync(rollout, initial + appended + partial);
      expect(await provider.read!(session, completePosition)).toEqual({
        content: "",
        nextPosition: completePosition,
      });
      writeFileSync(rollout, initial + appended + `${partial}\n`);
      expect(await provider.read!(session, completePosition)).toEqual({
        content: `${partial}\n`,
        nextPosition: Buffer.byteLength(initial + appended + `${partial}\n`),
      });
      rmSync(rollout);
      await expect(provider.read!(session, 0)).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("starts monitoring an oversized existing session from a bounded recent window", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-codex-sessions-"));
    const id = "019fc374-5a5b-78b0-81da-c5bf1452cebf";
    const directory = join(root, "sessions", "2026", "08", "03");
    const rollout = join(directory, `rollout-2026-08-03T01-10-10-${id}.jsonl`);
    mkdirSync(directory, { recursive: true });
    const recentRecord = `${JSON.stringify({
      type: "response_item",
      payload: { role: "assistant", content: "recent progress" },
    })}\n`;
    writeFileSync(rollout, `${"x".repeat(33 * 1024 * 1024)}\n${recentRecord}`);

    try {
      const sourcePosition = Buffer.byteLength(readFileSync(rollout));
      const result = await new LocalCodexSessionProvider(root).read!({
        id,
        title: "大型现有会话",
        workspacePath: root,
        projectLabel: "project",
        lastActiveAt: "2026-08-03T02:00:00.000Z",
        sourcePath: rollout,
        sourcePosition,
        availability: "available",
        message: null,
      }, 0);

      expect(result.content).toBe(recentRecord);
      expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(512 * 1024);
      expect(result.nextPosition).toBe(sourcePosition);
      expect(result.truncated).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps the first record when a bounded recent window starts at a line boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-codex-sessions-"));
    const id = "019fc374-5a5b-78b0-81da-c5bf1452cebf";
    const directory = join(root, "sessions", "2026", "08", "03");
    const rollout = join(directory, `rollout-2026-08-03T01-10-10-${id}.jsonl`);
    mkdirSync(directory, { recursive: true });
    const firstRecord = `${JSON.stringify({ type: "event_msg", payload: { message: "first recent record" } })}\n`;
    const fillerRecord = `${JSON.stringify({ type: "event_msg", payload: { message: "x".repeat(400) } })}\n`;
    let recentWindow = firstRecord;
    while (Buffer.byteLength(recentWindow + fillerRecord) <= 512 * 1024) {
      recentWindow += fillerRecord;
    }
    recentWindow += " ".repeat(512 * 1024 - Buffer.byteLength(recentWindow) - 1) + "\n";
    writeFileSync(rollout, `x\n${recentWindow}`);

    try {
      const result = await new LocalCodexSessionProvider(root).read!({
        id,
        title: "边界会话",
        workspacePath: root,
        projectLabel: "project",
        lastActiveAt: "2026-08-03T02:00:00.000Z",
        sourcePath: rollout,
        sourcePosition: Buffer.byteLength(readFileSync(rollout)),
        availability: "available",
        message: null,
      }, 0);

      expect(result.content.startsWith(firstRecord)).toBe(true);
      expect(result.truncated).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps readable sessions when optional fields are missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-codex-sessions-"));
    const id = "019fc374-5a5b-78b0-81da-c5bf1452cebf";
    const directory = join(root, "sessions", "2026", "08", "03");
    const rollout = join(directory, `rollout-2026-08-03T01-10-10-${id}.jsonl`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(rollout, `${JSON.stringify({ type: "session_meta", payload: { id } })}\n`);

    try {
      const result = await new LocalCodexSessionProvider(root).discover();

      expect(result.status).toBe("partial");
      expect(result.sessions[0]).toMatchObject({
        id,
        title: "未命名 Codex 会话",
        workspacePath: null,
        projectLabel: "文件夹不可用",
        availability: "degraded",
        message: "标题不可用，文件夹不可用",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not offer internal subagent sessions as import candidates", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-codex-sessions-"));
    const id = "019fc374-5a5b-78b0-81da-c5bf1452cebf";
    const directory = join(root, "sessions", "2026", "08", "03");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, `rollout-2026-08-03T01-10-10-${id}.jsonl`),
      `${JSON.stringify({
        type: "session_meta",
        payload: { id, cwd: "/tmp/project", source: { subagent: { thread_spawn: {} } } },
      })}\n`,
    );

    try {
      const result = await new LocalCodexSessionProvider(root).discover();
      expect(result.sessions).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports an oversized index as partial when rollout metadata remains readable", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-codex-sessions-"));
    const id = "019fc374-5a5b-78b0-81da-c5bf1452cebf";
    const directory = join(root, "sessions", "2026", "08", "03");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(root, "session_index.jsonl"), "x".repeat(10 * 1024 * 1024 + 1));
    writeFileSync(
      join(directory, `rollout-2026-08-03T01-10-10-${id}.jsonl`),
      `${JSON.stringify({ type: "session_meta", payload: { id, cwd: root } })}\n`,
    );

    try {
      const result = await new LocalCodexSessionProvider(root).discover();
      expect(result.status).toBe("partial");
      expect(result.message).toContain("索引过大");
      expect(result.sessions).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not report available when the existing index cannot be parsed", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-codex-sessions-"));
    mkdirSync(join(root, "sessions"));
    writeFileSync(join(root, "session_index.jsonl"), "{not-json}\n");
    try {
      const result = await new LocalCodexSessionProvider(root).discover();
      expect(result).toEqual({
        status: "unavailable",
        message: "Codex 会话索引为空或无法解析",
        sessions: [],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports an unavailable source instead of failing", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-codex-sessions-"));
    try {
      const result = await new LocalCodexSessionProvider(root).discover();
      expect(result).toEqual({
        status: "unavailable",
        message: "没有找到 Codex 本机会话目录，请确认 Codex 已在这台电脑上使用过",
        sessions: [],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
