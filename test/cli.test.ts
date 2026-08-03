import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { openInBrowser, runCli } from "../src/cli";
import type { CodexRunEvent, CodexRunner } from "../src/codex-runner";
import { WorkOrderStore } from "../src/work-order-store";

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function serviceFetch(app: ReturnType<typeof createApp>): typeof globalThis.fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    app.fetch(new Request(input, init))) as typeof globalThis.fetch;
}

function cliCapture(
  baseUrl: string,
  cwd: string,
  fetch: typeof globalThis.fetch = globalThis.fetch,
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const opened: string[] = [];
  return {
    stdout,
    stderr,
    opened,
    dependencies: {
      cwd: () => cwd,
      env: { TEAMLINE_URL: baseUrl },
      fetch,
      stdout: (message: string) => stdout.push(message),
      stderr: (message: string) => stderr.push(message),
      openUrl: (url: string) => opened.push(url),
    },
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(2);
  }
}

describe("Teamline CLI", () => {
  test("creates from the current directory and reads the shared console state", async () => {
    const workspacePath = temporaryDirectory("teamline-cli-workspace-");
    const database = new Database(":memory:");
    cleanup.push(() => database.close());
    const store = new WorkOrderStore(database);
    const app = createApp({ store });
    const baseUrl = "http://127.0.0.1:4310/";
    const cli = cliCapture(baseUrl, workspacePath, serviceFetch(app));

    expect(
      await runCli(
        ["create", "修复登录页空白", "--acceptance", "相关测试通过"],
        cli.dependencies,
      ),
    ).toBe(0);
    const created = store.list()[0];
    expect(created).toMatchObject({
      goal: "修复登录页空白",
      acceptance: "相关测试通过",
      workspace: { kind: "directory", path: realpathSync(workspacePath) },
      status: "draft",
    });
    expect(cli.stdout.join("\n")).toContain(created.id);

    store.savePlan(created.id, [
      {
        outcome: "登录页稳定显示",
        scope: "登录页",
        verification: "运行相关测试",
      },
    ]);
    cli.stdout.length = 0;

    expect(await runCli(["list"], cli.dependencies)).toBe(0);
    expect(cli.stdout.join("\n")).toContain(created.id.slice(0, 8));
    expect(cli.stdout.join("\n")).toContain("当前：登录页稳定显示");
    expect(cli.stdout.join("\n")).toContain("原因：待确认计划");

    cli.stdout.length = 0;
    expect(await runCli(["show", created.id.slice(0, 8)], cli.dependencies)).toBe(0);
    expect(cli.stdout.join("\n")).toContain("状态：待规划（待确认计划）");
    expect(cli.stdout.join("\n")).toContain(`工作空间：${realpathSync(workspacePath)}`);
    expect(cli.stdout.join("\n")).toContain("验收：相关测试通过");

    expect(await runCli(["open", created.id.slice(0, 8)], cli.dependencies)).toBe(0);
    expect(cli.opened).toEqual([`${baseUrl}work-orders/${created.id}`]);
    expect(cli.stderr).toEqual([]);
  });

  test("creates from a real Git subdirectory and binds the repository root", async () => {
    const repositoryPath = temporaryDirectory("teamline-cli-git-");
    const subdirectory = join(repositoryPath, "packages", "app");
    mkdirSync(subdirectory, { recursive: true });
    const initialized = Bun.spawnSync(["git", "init", "-b", "main", repositoryPath]);
    expect(initialized.exitCode).toBe(0);

    const database = new Database(":memory:");
    cleanup.push(() => database.close());
    const store = new WorkOrderStore(database);
    const app = createApp({ store });
    const cli = cliCapture(
      "http://127.0.0.1:4310/",
      subdirectory,
      serviceFetch(app),
    );

    expect(await runCli(["create", "处理子目录工作"], cli.dependencies)).toBe(0);
    expect(store.list()[0].workspace).toEqual({
      kind: "git",
      path: realpathSync(repositoryPath),
    });
  });

  test("interrupts and continues a work order through the local service", async () => {
    const workspacePath = temporaryDirectory("teamline-cli-running-");
    const database = new Database(":memory:");
    cleanup.push(() => database.close());
    const store = new WorkOrderStore(database);
    let releaseFirstRun!: () => void;
    const firstRunExit = new Promise<void>((resolve) => {
      releaseFirstRun = resolve;
    });
    let startCount = 0;
    const runner: CodexRunner = {
      async start() {
        startCount += 1;
        if (startCount === 1) {
          return {
            interrupt: releaseFirstRun,
            events: (async function* (): AsyncGenerator<CodexRunEvent> {
              yield { type: "progress", message: "正在处理" };
              await firstRunExit;
              yield { type: "exit", exitCode: 143, message: "Codex 已退出" };
            })(),
          };
        }
        return {
          interrupt() {},
          events: (async function* (): AsyncGenerator<CodexRunEvent> {
            yield { type: "progress", message: "继续处理" };
            yield {
              type: "exit",
              exitCode: 0,
              message: "Codex 已正常结束，等待结果处理",
            };
          })(),
        };
      },
    };
    const app = createApp({ store, codexRunner: runner });
    const baseUrl = "http://127.0.0.1:4310/";
    const cli = cliCapture(baseUrl, workspacePath, serviceFetch(app));
    const created = store.create({
      workspace: { kind: "directory", path: workspacePath },
      goal: "处理可暂停任务",
    });
    store.savePlan(created.id, [
      { outcome: "完成任务", scope: "测试", verification: "检查结果" },
    ]);

    expect(await runCli(["interrupt", created.id.slice(0, 8)], cli.dependencies)).toBe(1);
    expect(cli.stderr.at(-1)).toContain("当前没有可中断的运行");
    cli.stderr.length = 0;
    cli.stdout.length = 0;

    const start = await app.fetch(
      new Request(`${baseUrl}api/work-orders/${created.id}/start`, { method: "POST" }),
    );
    expect(start.status).toBe(200);
    await waitFor(() => store.get(created.id)?.runStatus === "running");

    expect(await runCli(["interrupt", created.id.slice(0, 8)], cli.dependencies)).toBe(0);
    expect(cli.stdout.at(-1)).toBe("正在中断：处理可暂停任务");
    await waitFor(() => store.get(created.id)?.runStatus === "interrupted");

    expect(await runCli(["continue", created.id.slice(0, 8)], cli.dependencies)).toBe(0);
    expect(cli.stdout.at(-1)).toBe("已继续：处理可暂停任务");
    expect(startCount).toBe(2);
    expect(cli.stderr).toEqual([]);
  });

  test("rejects the misleading pause command and ambiguous ID prefixes", async () => {
    let fetchCount = 0;
    const fetch = (async () => {
      fetchCount += 1;
      return Response.json({
        workOrders: [
          { id: "abcd1111-first" },
          { id: "abcd2222-second" },
        ],
      });
    }) as typeof globalThis.fetch;
    const cli = cliCapture("http://127.0.0.1:4310/", process.cwd(), fetch);

    expect(await runCli(["pause", "abcd"], cli.dependencies)).toBe(2);
    expect(cli.stderr.at(-1)).toContain("未知命令：pause");
    expect(fetchCount).toBe(0);

    expect(await runCli(["show", "abcd"], cli.dependencies)).toBe(2);
    expect(cli.stderr.at(-1)).toContain("不唯一");
    expect(fetchCount).toBe(1);
  });

  test("does not follow redirects away from the local service", async () => {
    const requests: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), redirect: init?.redirect });
      return new Response(null, {
        status: 307,
        headers: { location: "https://example.com/collect" },
      });
    }) as typeof globalThis.fetch;
    const cli = cliCapture("http://127.0.0.1:4310/", process.cwd(), fetch);

    expect(
      await runCli(["create", "不能被重定向"], {
        ...cli.dependencies,
        resolveWorkspace: async (cwd) => cwd,
      }),
    ).toBe(1);
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:4310/api/work-orders",
        redirect: "manual",
      },
    ]);
    expect(cli.stderr.at(-1)).toContain("307");
  });

  test("uses the macOS open command without a shell", () => {
    const commands: string[][] = [];
    openInBrowser("http://127.0.0.1:4310/work-orders/example", (command) => {
      commands.push(command);
      return { exitCode: 0, stderr: { toString: () => "" } };
    });

    expect(commands).toEqual([
      ["open", "http://127.0.0.1:4310/work-orders/example"],
    ]);
  });

  test("reports usage and local-service failures without mutating local state", async () => {
    const cli = cliCapture("http://127.0.0.1:4310/", process.cwd());
    expect(await runCli(["create"], cli.dependencies)).toBe(2);
    expect(cli.stderr.at(-1)).toContain("请提供委托目标");

    cli.stderr.length = 0;
    expect(
      await runCli(["list"], {
        ...cli.dependencies,
        env: { TEAMLINE_URL: "https://example.com" },
      }),
    ).toBe(2);
    expect(cli.stderr.at(-1)).toContain("必须是本机 HTTP 地址");
  });
});
