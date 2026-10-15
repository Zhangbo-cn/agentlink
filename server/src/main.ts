#!/usr/bin/env node
import { startServer } from "./server.ts";

const server = await startServer();

let stopping = false;
const stop = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), level: "info", msg: "server.stopping", signal }) + "\n");
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  await server.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("unhandledRejection", (e) => {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), level: "error", msg: "unhandledRejection", err: String((e as Error)?.stack ?? e) }) + "\n");
});
