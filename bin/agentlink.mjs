#!/usr/bin/env node
// Launcher for the AgentLink CLI.
//
// Installed: runs the compiled JavaScript in dist/ (Node refuses to strip types
// inside node_modules, so a published package must ship plain JS).
// From a source checkout: falls back to running the TypeScript entry directly,
// which needs Node >= 22.13 but no build step.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const compiled = fileURLToPath(new URL("dist/cli/main.js", root));
const source = fileURLToPath(new URL("cli/main.ts", root));

const args = existsSync(compiled)
  ? [compiled, ...process.argv.slice(2)]
  : ["--experimental-transform-types", "--no-warnings", source, ...process.argv.slice(2)];

const child = spawn(process.execPath, args, { stdio: "inherit" });
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => child.kill(s));
child.on("exit", (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
