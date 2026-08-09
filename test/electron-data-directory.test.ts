import { describe, expect, test } from "bun:test";
import {
  DataDirectoryChoiceRequiredError,
  resolveClientDataDirectory,
} from "../src/electron/data-directory.mjs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeDataDirectory(parent: string, name: string): string {
  const directory = join(parent, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "teamline.db"), "");
  return directory;
}

describe("Electron client data directory binding", () => {
  test("explicit TEAMLINE_DATA_DIR wins over source and packaged defaults", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-data-explicit-"));
    try {
      const result = await resolveClientDataDirectory({
        environment: { TEAMLINE_DATA_DIR: join(root, "explicit") },
        packaged: true,
        projectRoot: join(root, "repo"),
        userDataPath: join(root, "user-data"),
      });
      expect(result).toMatchObject({
        dataDirectory: join(root, "explicit"),
        source: "explicit",
        bindingPath: null,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("source mode keeps the project .teamline directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-data-source-"));
    try {
      await expect(resolveClientDataDirectory({
        environment: {},
        packaged: false,
        projectRoot: join(root, "repo"),
      })).resolves.toMatchObject({
        dataDirectory: join(root, "repo", ".teamline"),
        source: "source",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("packages use the canonical Teamline directory and remember a legacy choice", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-data-legacy-"));
    try {
      const userDataPath = join(root, "user-data");
      const projectRoot = join(root, "repo");
      const legacy = makeDataDirectory(projectRoot, ".teamline");
      let choices = 0;
      const first = await resolveClientDataDirectory({
        environment: {},
        packaged: true,
        projectRoot,
        userDataPath,
        legacyDirectories: [legacy],
        chooseDataDirectory: async ({ candidates }) => {
          choices += 1;
          expect(candidates).toEqual([legacy]);
          return { action: "use", dataDirectory: legacy };
        },
      });
      expect(first).toMatchObject({ dataDirectory: legacy, source: "legacy" });
      expect(existsSync(join(userDataPath, "Teamline", "client-binding.json"))).toBe(true);

      const reopened = await resolveClientDataDirectory({
        environment: {},
        packaged: true,
        projectRoot,
        userDataPath,
      });
      expect(reopened).toMatchObject({ dataDirectory: legacy, source: "binding" });
      expect(choices).toBe(1);
      expect(JSON.parse(readFileSync(join(userDataPath, "Teamline", "client-binding.json"), "utf8"))).toMatchObject({
        kind: "legacy",
        dataDirectory: legacy,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("requires an explicit choice instead of silently creating an empty packaged store", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamline-data-choice-"));
    try {
      const projectRoot = join(root, "repo");
      const legacy = makeDataDirectory(projectRoot, ".teamline");
      await expect(resolveClientDataDirectory({
        environment: {},
        packaged: true,
        projectRoot,
        userDataPath: join(root, "user-data"),
        legacyDirectories: [legacy],
      })).rejects.toBeInstanceOf(DataDirectoryChoiceRequiredError);

      const created = await resolveClientDataDirectory({
        environment: {},
        packaged: true,
        projectRoot,
        userDataPath: join(root, "new-user-data"),
        legacyDirectories: [],
        chooseDataDirectory: async () => ({ action: "create" }),
      });
      expect(created.source).toBe("canonical-created");
      expect(existsSync(created.dataDirectory)).toBe(true);
      expect(existsSync(join(created.dataDirectory, "client-binding.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
