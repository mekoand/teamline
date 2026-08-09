import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolveLocalCoreDataDirectory } from "../src/local-core";

const electronMainSource = readFileSync(
  new URL("../src/electron/main.mjs", import.meta.url),
  "utf8",
);
const electronPreloadSource = readFileSync(
  new URL("../src/electron/preload.cjs", import.meta.url),
  "utf8",
);
const packageJson = JSON.parse(readFileSync(
  new URL("../package.json", import.meta.url),
  "utf8",
));

test("source installs the Electron binary before starting the desktop shell", () => {
  expect(packageJson.scripts.postinstall).toBe("node node_modules/electron/install.js");
  expect(packageJson.trustedDependencies).toContain("electron");
});

test("Local Core data directory is independent from the client window", () => {
  expect(resolveLocalCoreDataDirectory({}, "/Users/example/teamline"))
    .toBe("/Users/example/teamline/.teamline");
  expect(
    resolveLocalCoreDataDirectory({ TEAMLINE_DATA_DIR: "./custom-core" }, "/Users/example/teamline"),
  ).toBe(`${process.cwd()}/custom-core`);
});

test("Electron hides the window without stopping Local Core and reopens the same client", () => {
  expect(electronMainSource).toContain("event.preventDefault();\n    mainWindow?.hide();");
  expect(electronMainSource).toContain("if (mainWindow) {\n    mainWindow.show();\n    mainWindow.focus();");
  expect(electronMainSource).toContain('app.on("activate", () => {\n  if (coreConnection) createMainWindow();');
  expect(electronMainSource).toContain('app.on("window-all-closed", (event) => {\n  event.preventDefault();');
  expect(electronMainSource).toContain("coreConnection = await ensureLocalCore({");
});

test("Electron exposes only an authorized artifact action bridge", () => {
  expect(electronMainSource).toContain('ipcMain.handle("teamline:artifact-action"');
  expect(electronMainSource).toContain("delegate: true");
  expect(electronMainSource).toContain('preload: resolve(sourceRoot, "src/electron/preload.cjs")');
  expect(electronMainSource).toContain('child.once("close"');
  expect(electronMainSource).toContain("Quick Look 无法打开这个成果");
  expect(electronPreloadSource).toContain('contextBridge.exposeInMainWorld("teamlineDesktop"');
  expect(electronPreloadSource).toContain('ipcRenderer.invoke("teamline:artifact-action"');
  expect(electronPreloadSource).toContain('require("electron")');
  expect(electronPreloadSource).not.toContain("shell.openPath");
  expect(electronPreloadSource).not.toContain("readFile");
});

describe("Electron Local Core connection", () => {
  test("starts a detached Local Core with the shared data directory when none is available", async () => {
    let available = false;
    let spawnCount = 0;
    let spawnInput: { command: string; args: string[]; options: any } | null = null;
    const child = { unref() {} };
    const { ensureLocalCore, localCoreIdentity } = await import("../src/electron/local-core-client.mjs");
    const expectedIdentity = localCoreIdentity("/tmp/teamline-test-data");
    const connection = await ensureLocalCore({
      url: "http://127.0.0.1:43991",
      dataDirectory: "/tmp/teamline-test-data",
      serverScript: "/repo/src/server.ts",
      waitMs: 0,
      attempts: 2,
      fetchImpl: async () =>
        available
          ? Response.json({ service: "teamline-local-core", identity: expectedIdentity })
          : new Response(null, { status: 503 }),
      spawnImpl: (command: string, args: string[], options: any) => {
        spawnCount += 1;
        spawnInput = { command, args, options };
        available = true;
        return child;
      },
    });

    expect(connection).toEqual({ url: new URL("http://127.0.0.1:43991/"), reused: false });
    expect(spawnCount).toBe(1);
    expect(spawnInput).toMatchObject({
      command: "bun",
      args: ["/repo/src/server.ts"],
      options: {
        detached: true,
        stdio: "ignore",
        env: {
          TEAMLINE_DATA_DIR: "/tmp/teamline-test-data",
          TEAMLINE_PORT: "43991",
        },
      },
    });
  });

  test("reuses an existing Local Core without starting another process", async () => {
    let spawnCount = 0;
    const { ensureLocalCore, localCoreIdentity } = await import("../src/electron/local-core-client.mjs");
    const dataDirectory = "/tmp/teamline-existing-core";
    const connection = await ensureLocalCore({
      url: "http://127.0.0.1:43992",
      dataDirectory,
      fetchImpl: async () =>
        Response.json({
          service: "teamline-local-core",
          identity: localCoreIdentity(dataDirectory),
        }),
      spawnImpl: () => {
        spawnCount += 1;
        return { unref() {} };
      },
    });

    expect(connection).toEqual({ url: new URL("http://127.0.0.1:43992/"), reused: true });
    expect(spawnCount).toBe(0);
  });

  test("does not reuse a Local Core that owns another data directory", async () => {
    let spawned = false;
    let spawnCount = 0;
    const { ensureLocalCore, localCoreIdentity } = await import("../src/electron/local-core-client.mjs");
    const dataDirectory = "/tmp/teamline-correct-core";
    const otherIdentity = localCoreIdentity("/tmp/teamline-other-core");
    const expectedIdentity = localCoreIdentity(dataDirectory);
    const connection = await ensureLocalCore({
      url: "http://127.0.0.1:43994",
      dataDirectory,
      attempts: 2,
      fetchImpl: async () =>
        Response.json({
          service: "teamline-local-core",
          identity: spawned ? expectedIdentity : otherIdentity,
        }),
      spawnImpl: () => {
        spawned = true;
        spawnCount += 1;
        return { unref() {} };
      },
    });

    expect(connection).toEqual({ url: new URL("http://127.0.0.1:43994/"), reused: false });
    expect(spawnCount).toBe(1);
  });

  test("coalesces concurrent Local Core startup checks", async () => {
    let available = false;
    let spawnCount = 0;
    const { ensureLocalCore, localCoreIdentity } = await import("../src/electron/local-core-client.mjs");
    const dataDirectory = "/tmp/teamline-concurrent-core";
    const identity = localCoreIdentity(dataDirectory);
    const options = {
      url: "http://127.0.0.1:43995",
      dataDirectory,
      attempts: 3,
      waitMs: 0,
      fetchImpl: async () => {
        await Bun.sleep(5);
        return available
          ? Response.json({ service: "teamline-local-core", identity })
          : new Response(null, { status: 503 });
      },
      spawnImpl: () => {
        available = true;
        spawnCount += 1;
        return { unref() {} };
      },
    };

    const [first, second] = await Promise.all([
      ensureLocalCore(options),
      ensureLocalCore(options),
    ]);

    expect(first).toEqual({ url: new URL("http://127.0.0.1:43995/"), reused: false });
    expect(second).toEqual(first);
    expect(spawnCount).toBe(1);
  });

  test("reports a Local Core process spawn failure", async () => {
    const { ensureLocalCore } = await import("../src/electron/local-core-client.mjs");
    const spawnError = new Error("bun is unavailable");

    await expect(
      ensureLocalCore({
        url: "http://127.0.0.1:43993",
        attempts: 1,
        fetchImpl: async () => new Response(null, { status: 503 }),
        spawnImpl: (_command, _args, _options) => ({
          once(_event, handler) {
            handler(spawnError);
          },
          unref() {},
          kill() {},
        }),
      }),
    ).rejects.toThrow("无法启动 Local Core：bun is unavailable");
  });
});
