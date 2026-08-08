import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");

const bilingualPairs = [
  ["CONTEXT.md", "CONTEXT.zh-CN.md"],
  ["PRODUCT-HYPOTHESIS.md", "PRODUCT-HYPOTHESIS.zh-CN.md"],
  ["docs/specs/personal-v0.md", "docs/specs/personal-v0.zh-CN.md"],
  ["docs/specs/personal-v2.md", "docs/specs/personal-v2.zh-CN.md"],
] as const;

const documentationEntryPoints = [
  "README.md",
  "README.zh-CN.md",
  "docs/agents/domain.md",
  ...bilingualPairs.flat(),
] as const;

function localMarkdownTargets(path: string): string[] {
  const absolutePath = join(repositoryRoot, path);
  const markdown = readFileSync(absolutePath, "utf8");
  const links = markdown.matchAll(/(?<!!)\[[^\]]*\]\(([^)]+)\)/g);

  return [...links]
    .map((match) => match[1].trim().replace(/^<|>$/g, ""))
    .filter((target) => !/^(?:[a-z]+:|#)/i.test(target))
    .map((target) => decodeURIComponent(target.split("#", 1)[0]))
    .filter(Boolean)
    .map((target) => resolve(dirname(absolutePath), target));
}

describe("documentation navigation", () => {
  test("English canonical documents and Chinese companions link to each other", () => {
    for (const [englishPath, chinesePath] of bilingualPairs) {
      const english = readFileSync(join(repositoryRoot, englishPath), "utf8");
      const chinese = readFileSync(join(repositoryRoot, chinesePath), "utf8");
      const englishTarget = `./${englishPath.split("/").at(-1)}`;
      const chineseTarget = `./${chinesePath.split("/").at(-1)}`;

      expect(english).toContain(`](${chineseTarget})`);
      expect(chinese).toContain(`](${englishTarget})`);
    }
  });

  test("local links from bilingual documentation entry points resolve", () => {
    for (const entryPoint of documentationEntryPoints) {
      for (const target of localMarkdownTargets(entryPoint)) {
        expect(existsSync(target), `${entryPoint} links to missing ${target}`).toBe(true);
        expect(statSync(target).isFile() || statSync(target).isDirectory()).toBe(true);
      }
    }
  });

  test("agent guidance identifies one English glossary authority", () => {
    const agentGuidance = readFileSync(
      join(repositoryRoot, "docs/agents/domain.md"),
      "utf8",
    );

    expect(agentGuidance).toContain("`CONTEXT.md` at the repository root. It is the canonical English glossary.");
    expect(agentGuidance).toContain("does not define a second vocabulary authority");
  });
});
