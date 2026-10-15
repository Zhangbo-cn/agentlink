#!/usr/bin/env node
// Launcher: runs the TypeScript CLI with Node's built-in type stripping (Node >= 22.13).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const entry = fileURLToPath(new URL("../cli/main.ts", import.meta.url));
const child = spawn(process.execPath, ["--experimental-transform-types", "--no-warnings", entry, ...process.argv.slice(2)], { stdio: "inherit" });
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => child.kill(s));
child.on("exit", (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
