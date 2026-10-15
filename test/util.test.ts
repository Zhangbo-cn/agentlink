import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseEnv } from "node:util";
import { setEnvValue, duplicateEnvKeys } from "../server/src/util.ts";

const EXAMPLE = fs.readFileSync(new URL("../deploy/.env.example", import.meta.url), "utf8");

test("setEnvValue fills an empty slot and keeps the file valid", () => {
  const out = setEnvValue(EXAMPLE, "AGENTLINK_SMTP_PROVIDER", "qq");
  assert.equal(parseEnv(out).AGENTLINK_SMTP_PROVIDER, "qq");
  assert.equal(out.match(/^AGENTLINK_SMTP_PROVIDER=/gm)!.length, 1);
  assert.match(out, /AGENTLINK_SMTP_USER=/); // neighbours untouched
});

test("setEnvValue replaces every duplicate line with a single one", () => {
  // The real failure: a leftover block appended at the end silently won, because the last
  // duplicate is the one that takes effect.
  const text = `AGENTLINK_SMTP_PROVIDER=qq\nAGENTLINK_SMTP_PASS=NEW\n\nAGENTLINK_SMTP_PROVIDER=163\nAGENTLINK_SMTP_PASS=OLD\n`;
  assert.equal(parseEnv(text).AGENTLINK_SMTP_PASS, "OLD");
  const out = setEnvValue(text, "AGENTLINK_SMTP_PASS", "NEW");
  assert.equal(parseEnv(out).AGENTLINK_SMTP_PASS, "NEW");
  assert.equal(out.match(/^AGENTLINK_SMTP_PASS=/gm)!.length, 1);
});

test("setEnvValue appends when the key is absent and preserves the trailing newline", () => {
  const out = setEnvValue("A=1\n", "B", "2");
  assert.deepEqual(parseEnv(out), { A: "1", B: "2" });
  assert.equal(setEnvValue("A=1", "B", "2"), "A=1\nB=2");
});

test("duplicateEnvKeys reports the offending lines", () => {
  assert.deepEqual(duplicateEnvKeys("A=1\nB=2\nA=3\n# A=4\n"), ["A（第 1 行和第 3 行）"]);
  assert.deepEqual(duplicateEnvKeys("A=1\nB=2\n"), []);
  assert.deepEqual(duplicateEnvKeys(EXAMPLE), []); // the shipped example is clean
});
