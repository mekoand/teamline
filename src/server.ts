import { startLocalCore } from "./local-core";

const core = await startLocalCore({
  port: Number(process.env.TEAMLINE_PORT ?? 4310),
});

console.log(`Teamline Local Core is running at ${core.url}`);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await core.close();
};
const shutdownForSignal = () => {
  void shutdown().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.once("SIGINT", shutdownForSignal);
process.once("SIGTERM", shutdownForSignal);
