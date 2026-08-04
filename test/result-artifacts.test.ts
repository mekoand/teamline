import { describe, expect, test } from "bun:test";
import { gitArtifactPaths } from "../public/result-artifacts.js";

describe("result artifact paths", () => {
  test("ignores empty state and placeholder text", () => {
    expect(gitArtifactPaths("")).toEqual([]);
    expect(gitArtifactPaths("工作区没有未提交变化")).toEqual([]);
    expect(gitArtifactPaths("no changes")).toEqual([]);
  });

  test("does not present deleted files as artifacts", () => {
    expect(gitArtifactPaths(" D removed.ts\nD  staged-delete.ts\nMD changed-then-deleted.ts"))
      .toEqual([]);
  });

  test("keeps ordinary modified, added, and untracked relative paths", () => {
    expect(gitArtifactPaths(
      " M public/app.js\nM  src/app.ts\nA  docs/result.md\n?? RESULT.md",
    )).toEqual([
      "public/app.js",
      "src/app.ts",
      "docs/result.md",
      "RESULT.md",
    ]);
  });

  test("uses only a reliably parsed rename destination", () => {
    expect(gitArtifactPaths("R  docs/old.md -> docs/new.md")).toEqual(["docs/new.md"]);
    expect(gitArtifactPaths('R  "docs/旧 名.md" -> "docs/新 名.md"')).toEqual([]);
    expect(gitArtifactPaths("R  one.md -> two.md -> three.md")).toEqual([]);
  });

  test("rejects quoted, escaped, absolute, and parent paths", () => {
    expect(gitArtifactPaths([
      ' M "quoted path.md"',
      " M escaped\\path.md",
      "?? /tmp/result.md",
      "?? ../result.md",
      "?? docs/../../result.md",
    ].join("\n"))).toEqual([]);
  });
});
