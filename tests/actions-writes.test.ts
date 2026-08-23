import assert from "node:assert/strict";
import { test } from "node:test";
import { GhExecutionError } from "../extensions/gh/index.ts";
import { createFakeExecutor, loadExtension, projectionOf, toolCtx } from "./helpers.ts";

function load(name: string, response = "ok\n") {
  const executor = createFakeExecutor((request) => request.argv[0] === "--version"
    ? { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false }
    : { stdout: response, stderr: "", code: 0, killed: false });
  const loaded = loadExtension({ executor: executor.execute });
  const tool = loaded.tools.get(name);
  assert.ok(tool, `${name} must be registered`);
  return { executor, tool };
}

test("workflow dispatch handles refs and typed inputs, and run cancel/rerun use exact argv", async () => {
  const dispatch = load("gh_dispatch_workflow", "dispatched\n");
  await dispatch.tool.execute("dispatch", { repo: "cli/cli", workflow: "build.yml", ref: "main", inputs: { environment: "staging", count: "2" } }, undefined, undefined, toolCtx() as never);
  assert.deepEqual(dispatch.executor.calls[1]?.argv, ["workflow", "run", "build.yml", "--repo", "cli/cli", "--ref", "main", "-f", "environment=staging", "-f", "count=2"]);

  const cancel = load("gh_cancel_workflow_run", "cancelled\n");
  await cancel.tool.execute("cancel", { target: "https://github.com/cli/cli/actions/runs/100" }, undefined, undefined, toolCtx() as never);
  assert.deepEqual(cancel.executor.calls[1]?.argv, ["run", "cancel", "100", "--repo", "cli/cli"]);

  const rerun = load("gh_rerun_workflow_run", "rerun\n");
  await rerun.tool.execute("rerun", { target: "https://github.com/cli/cli/actions/runs/100" }, undefined, undefined, toolCtx() as never);
  assert.deepEqual(rerun.executor.calls[1]?.argv, ["run", "rerun", "100", "--repo", "cli/cli"]);
});

test("Actions writes classify timeout and abort", async () => {
  const timeout = load("gh_cancel_workflow_run", "");
  timeout.executor.calls.length = 0;
  const abort = load("gh_cancel_workflow_run", "");
  await assert.rejects(() => abort.tool.execute("abort", { target: "https://github.com/cli/cli/actions/runs/100" }, AbortSignal.abort(), undefined, toolCtx() as never), (error: unknown) => error instanceof GhExecutionError && error.category === "aborted");
  void timeout;
});
