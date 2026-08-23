import assert from "node:assert/strict";
import { test } from "node:test";
import { GhExecutionError } from "../extensions/gh/index.ts";
import { FAILED_LOG_TAB_DELIMITED_FIXTURE } from "./fixtures/ci-live-format.ts";
import { createFakeExecutor, loadExtension, projectionOf, toolCtx } from "./helpers.ts";

function version() {
  return { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false };
}

function loadLogs(response: { stdout: string; stderr: string; code: number; killed: boolean }) {
  const executor = createFakeExecutor((request) => request.argv[0] === "--version" ? version() : response);
  const loaded = loadExtension({ executor: executor.execute });
  const tool = loaded.tools.get("gh_failed_logs");
  assert.ok(tool);
  return { executor, tool };
}

test("failed logs select a failed step and obey line and byte bounds", async () => {
  const output = [
    "build / test\n",
    "2026-01-01T00:00:00Z first failure\n",
    "2026-01-01T00:00:01Z second failure\n",
    "2026-01-01T00:00:02Z third failure\n",
    "deploy / publish\n",
    "should not be selected\n",
  ].join("");
  const { executor, tool } = loadLogs({ stdout: output, stderr: "", code: 0, killed: false });
  const result = await tool.execute(
    "logs-1",
    { target: "https://github.com/cli/cli/actions/runs/100", step: "test", maxLines: 2, maxBytes: 90 },
    undefined,
    undefined,
    toolCtx() as never,
  );
  const projection = projectionOf(result) as { step: string; log: string; lineCount: number; byteCount: number; partial: boolean };
  assert.equal(projection.step, "test");
  assert.match(projection.log, /first failure/);
  assert.equal(projection.lineCount, 2);
  assert.ok(projection.byteCount <= 90);
  assert.equal(projection.partial, true);
  const request = executor.calls.find((call) => call.argv[0] === "run");
  assert.ok(request);
  assert.ok(request.argv.includes("--log-failed"));
});

test("failed logs parse gh's live tab-delimited job, step, timestamp, and message format", async () => {
  const { tool } = loadLogs({ stdout: FAILED_LOG_TAB_DELIMITED_FIXTURE, stderr: "", code: 0, killed: false });
  const result = await tool.execute(
    "logs-tab-format",
    { target: "https://github.com/cli/cli/actions/runs/100", maxLines: 1 },
    undefined,
    undefined,
    toolCtx() as never,
  );
  const projection = projectionOf(result) as { job: string; step: string; log: string; lineCount: number; partial: boolean };
  assert.equal(projection.job, "test (node 24)");
  assert.equal(projection.step, "Run tests");
  assert.match(projection.log, /2026-01-01T00:00:03.000Z # npm test/);
  assert.doesNotMatch(projection.log, /publish failed/);
  assert.equal(projection.lineCount, 1);
  assert.equal(projection.partial, true);
});

test("failed logs only use strict spaced legacy headings, never paths or commands", async () => {
  const output = [
    "packages/foo/test",
    "npm test ./...",
    "echo result / failure",
    "ls -la / failure",
    "cat output / failure",
    "build / touch sentinel",
    "build / test",
    "2026-01-01T00:00:00Z real failure",
  ].join("\n");
  const { tool } = loadLogs({ stdout: output, stderr: "", code: 0, killed: false });
  const result = await tool.execute(
    "logs-legacy-heading",
    { target: "https://github.com/cli/cli/actions/runs/100", step: "test" },
    undefined,
    undefined,
    toolCtx() as never,
  );
  const projection = projectionOf(result) as { step: string; availableSteps: string[]; log: string };
  assert.equal(projection.step, "test");
  assert.deepEqual(projection.availableSteps, ["test"]);
  assert.match(projection.log, /real failure/);
  assert.doesNotMatch(projection.log, /packages\/foo|ls -la|cat output|touch sentinel/);
});

test("failed logs prefer a named failed step and redact secrets from labels and lines", async () => {
  const token = "ghp_exampleSecretTokenValue1234567890";
  const output = [
    `job-${token}\tUNKNOWN STEP\t2026-01-01T00:00:00Z setup ${token}`,
    `job-${token}\tRun tests ${token}\t2026-01-01T00:00:01Z failure ${token}`,
  ].join("\n");
  const { tool } = loadLogs({ stdout: output, stderr: "", code: 0, killed: false });
  const result = await tool.execute(
    "logs-redacted",
    { target: "https://github.com/cli/cli/actions/runs/100" },
    undefined,
    undefined,
    toolCtx() as never,
  );
  const projection = projectionOf(result) as { job: string; step: string; availableSteps: string[]; log: string };
  assert.equal(projection.step, "Run tests [redacted]");
  assert.equal(projection.job, "job-[redacted]");
  assert.match(projection.log, /failure \[redacted\]/);
  assert.doesNotMatch(JSON.stringify(projection), /ghp_/);
  assert.deepEqual(projection.availableSteps, ["UNKNOWN STEP", "Run tests [redacted]"]);
});

test("failed logs distinguish step-not-found from a clean run", async () => {
  const { tool } = loadLogs({ stdout: "build / test\n2026-01-01T00:00:00Z failed\n", stderr: "", code: 0, killed: false });
  const result = await tool.execute(
    "logs-2",
    { target: "https://github.com/cli/cli/actions/runs/100", step: "missing" },
    undefined,
    undefined,
    toolCtx() as never,
  );
  const projection = projectionOf(result) as { step: string | null; requestedStep: string; availableSteps: string[]; log: string; note: string };
  assert.equal(projection.step, null);
  assert.equal(projection.requestedStep, "missing");
  assert.deepEqual(projection.availableSteps, ["test"]);
  assert.equal(projection.log, "");
  assert.match(projection.note, /No failed step named "missing"/);

  const clean = loadLogs({ stdout: "", stderr: "", code: 0, killed: false });
  const cleanResult = await clean.tool.execute("logs-clean", { target: "https://github.com/cli/cli/actions/runs/200" }, undefined, undefined, toolCtx() as never);
  const cleanProjection = projectionOf(cleanResult) as { step: string | null; note: string; log: string };
  assert.equal(cleanProjection.step, null);
  assert.equal(cleanProjection.log, "");
  assert.match(cleanProjection.note, /no failed steps|expired/i);
});

test("failed logs classify missing logs, timeouts, and aborts", async () => {
  const missing = loadLogs({ stdout: "", stderr: "log not found for run", code: 1, killed: false });
  await assert.rejects(
    () => missing.tool.execute("logs-missing", { target: "https://github.com/cli/cli/actions/runs/100" }, undefined, undefined, toolCtx() as never),
    (error: unknown) => error instanceof GhExecutionError && error.category === "not_found",
  );

  const timeout = loadLogs({ stdout: "", stderr: "", code: 1, killed: true });
  await assert.rejects(
    () => timeout.tool.execute("logs-timeout", { target: "https://github.com/cli/cli/actions/runs/100" }, undefined, undefined, toolCtx() as never),
    (error: unknown) => error instanceof GhExecutionError && error.category === "timeout",
  );

  const abort = loadLogs({ stdout: "", stderr: "", code: 1, killed: true });
  await assert.rejects(
    () => abort.tool.execute("logs-abort", { target: "https://github.com/cli/cli/actions/runs/100" }, AbortSignal.abort(), undefined, toolCtx() as never),
    (error: unknown) => error instanceof GhExecutionError && error.category === "aborted",
  );
});
