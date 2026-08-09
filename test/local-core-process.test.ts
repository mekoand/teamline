import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const coreProcess = join(import.meta.dir, "fixtures", "local-core-process.ts");
const clientProcess = join(import.meta.dir, "fixtures", "local-core-client.ts");

describe("Local Core process lifecycle", () => {
  test("continues a goal after one client disconnects and restores it for a new client", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "teamline-local-core-process-"));
    const port = await findFreePort();
    const core = Bun.spawn([process.execPath, coreProcess, dataDirectory, String(port)], {
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const ready = JSON.parse(await readLine(core.stdout)) as { url: string };
      const { ensureLocalCore } = await import("../src/electron/local-core-client.mjs");
      const reusedCore = await ensureLocalCore({
        url: ready.url,
        dataDirectory,
        spawnImpl: () => {
          throw new Error("the lifecycle test must reuse the running Local Core");
        },
      });
      expect(reusedCore).toEqual({ url: new URL(ready.url), reused: true });

      const firstClient = await runClient([ready.url, "start", dataDirectory]);
      const { projectId, goalId } = firstClient;
      expect(firstClient).toMatchObject({
        projectId: expect.any(String),
        goalId: expect.any(String),
      });

      await waitForRemoteState(ready.url, goalId, (workOrder) =>
        workOrder.currentSummary === "客户端已断开，Local Core 仍在运行" &&
        workOrder.runStatus === "running",
      );

      await waitForRemoteState(ready.url, goalId, (workOrder) =>
        workOrder.currentSummary === "Local Core 保存了最新状态" &&
        workOrder.runStatus === "running",
      );

      const restored = await runClient([ready.url, "read", goalId]);
      expect(restored).toMatchObject({
        projectIds: [projectId],
        workOrder: {
          id: goalId,
          currentSummary: "Local Core 保存了最新状态",
          runStatus: "running",
        },
      });

      await waitForRemoteState(ready.url, goalId, (workOrder) => workOrder.runStatus === "failed");
    } finally {
      core.kill("SIGTERM");
      await core.exited;
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  });
});

async function runClient(args: string[]): Promise<any> {
  const client = Bun.spawn([process.execPath, clientProcess, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    client.exited,
    new Response(client.stdout).text(),
    new Response(client.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`client exited with ${exitCode}: ${stderr || stdout}`);
  }
  return JSON.parse(stdout);
}

async function waitForRemoteState(
  baseUrl: string,
  goalId: string,
  predicate: (workOrder: any) => boolean,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  let lastState: unknown = null;
  let lastResponse: { status: number; body: string } | null = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/console`);
    const body = await response.text();
    lastResponse = { status: response.status, body };
    if (response.ok) {
      const payload = JSON.parse(body) as { workOrders?: any[] };
      lastState = payload.workOrders?.find((workOrder) => workOrder.id === goalId) ?? null;
      if (lastState && predicate(lastState)) return;
    }
    await Bun.sleep(10);
  }
  throw new Error(
    `timed out waiting for Local Core state: ${JSON.stringify(lastState)}; response=${JSON.stringify(lastResponse)}`,
  );
}

async function readLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const result = await reader.read();
    if (result.done) throw new Error(`Local Core exited before readiness: ${buffer}`);
    buffer += decoder.decode(result.value, { stream: true });
    const lineEnd = buffer.indexOf("\n");
    if (lineEnd >= 0) return buffer.slice(0, lineEnd).trim();
  }
}

async function findFreePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve());
  });
  const address = probe.address();
  if (!address || typeof address === "string") {
    probe.close();
    throw new Error("could not determine a free port");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => error ? reject(error) : resolve());
  });
  return port;
}
