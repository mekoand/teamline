import type { CodexRunEvent, CodexRunner } from "../../src/codex-runner";
import { startLocalCore } from "../../src/local-core";

const dataDirectory = Bun.argv[2];
if (!dataDirectory) throw new Error("data directory is required");
const port = Number(Bun.argv[3]);
if (!Number.isInteger(port) || port < 1) throw new Error("port is required");

const fakeRunner: CodexRunner = {
  async start() {
    return {
      interrupt() {},
      events: fakeEvents(),
    };
  },
  async resume() {
    return {
      interrupt() {},
      events: fakeEvents(),
    };
  },
};

async function* fakeEvents(): AsyncGenerator<CodexRunEvent> {
  yield {
    type: "progress",
    message: "客户端已断开，Local Core 仍在运行",
  };
  await Bun.sleep(500);
  yield {
    type: "progress",
    message: "Local Core 保存了最新状态",
  };
  await Bun.sleep(500);
  yield {
    type: "exit",
    exitCode: 1,
    message: "fake runner finished",
  };
}

const core = await startLocalCore({
  dataDirectory,
  port,
  codexRunner: fakeRunner,
});

console.log(JSON.stringify({ url: core.url.toString().replace(/\/$/, "") }));

const shutdown = async () => {
  await core.close();
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
