#!/usr/bin/env node
// Launcher for the AgentLink relay server. See bin/agentlink.mjs for the
// compiled-vs-source resolution and why it works this way.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const compiled = fileURLToPath(new URL("dist/server/src/main.js", root));
const source = fileURLToPath(new URL("server/src/main.ts", root));

const args = existsSync(compiled)
  ? [compiled, ...process.argv.slice(2)]
  : ["--experimental-transform-types", "--no-warnings", source, ...process.argv.slice(2)];

const child = spawn(process.execPath, args, { stdio: "inherit" });
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => child.kill(s));
child.on("exit", (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
