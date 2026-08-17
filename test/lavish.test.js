import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolveLavishCli, editFileName } from "../src/cli/lavish.js";

test("resolveLavishCli finds the real, installed lavish-axi CLI entry point", () => {
  const cliPath = resolveLavishCli();
  assert.ok(cliPath.endsWith(".mjs") || cliPath.endsWith(".js"), `unexpected entry: ${cliPath}`);
  assert.ok(existsSync(cliPath), `resolved path does not exist: ${cliPath}`);
});

test("editFileName matches the UI's own downloadFileName() convention", () => {
  assert.equal(
    editFileName("/quarterly-report", "8617708b7741ac5818fe8588842205b6dc9388347fbee70bad56a59c74a38386"),
    "quarterly-report-8617708b.html",
  );
  assert.equal(
    editFileName("/reports/q3/summary", "aaaaaaaabbbbbbbbccccccccddddddddaaaaaaaabbbbbbbbccccccccdddddddd"),
    "reports-q3-summary-aaaaaaaa.html",
  );
});

test("editFileName never produces an empty basename for an edge-case synthetic path", () => {
  assert.equal(editFileName("/", "8617708b7741ac5818fe8588842205b6dc9388347fbee70bad56a59c74a38386"), "document-8617708b.html");
});
