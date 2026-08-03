import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
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
          availability: "available",
          message: null,
        },
      ]);
      expect(JSON.stringify(result)).not.toContain("private prompt");
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
