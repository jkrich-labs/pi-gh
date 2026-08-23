import assert from "node:assert/strict";
import { test } from "node:test";
import { GhExecutionError } from "../extensions/gh/index.ts";
import { createFakeExecutor, loadExtension, projectionOf, toolCtx } from "./helpers.ts";

function version() {
  return { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false };
}

function json(value: unknown) {
  return { stdout: JSON.stringify(value), stderr: "", code: 0, killed: false };
}

function load(name: string, response: unknown) {
  const executor = createFakeExecutor((request) => request.argv[0] === "--version" ? version() : json(response));
  const loaded = loadExtension({ executor: executor.execute });
  const tool = loaded.tools.get(name);
  assert.ok(tool, `${name} must be registered`);
  return { executor, tool };
}

test("CI tools list workflow runs with repository qualification, filters, and bounds", async () => {
  const runs = [{ databaseId: 100, workflowName: "build", status: "completed", conclusion: "success" }];
  const { executor, tool } = load("gh_list_workflow_runs", { total_count: 1, workflow_runs: runs });
  const result = await tool.execute(
    "ci-list",
    { repo: "cli/cli", workflow: "build.yml", branch: "main", limit: 4, page: 2 },
    undefined,
    undefined,
    toolCtx() as never,
  );
  const projection = projectionOf(result) as { runs: unknown[]; page: number; limit: number };
  assert.deepEqual(projection.runs, runs);
  assert.equal(projection.page, 2);
  assert.equal(projection.limit, 4);
  const request = executor.calls.find((call) => call.argv[0] === "api");
  assert.ok(request);
  assert.ok(request.argv.includes("repos/cli/cli/actions/runs"));
  assert.ok(request.argv.includes("workflow_id=build.yml"));
  assert.ok(request.argv.includes("branch=main"));
  assert.ok(request.argv.includes("per_page=4"));
  assert.ok(request.argv.includes("page=2"));
});

test("CI tools view workflow attempts, jobs, and pull-request checks", async () => {
  const run = { databaseId: 100, attempt: 2, status: "completed", conclusion: "failure" };
  const runCall = load("gh_view_workflow_run", run);
  const runResult = await runCall.tool.execute(
    "ci-run",
    { target: "https://github.com/cli/cli/actions/runs/100", attempt: 2 },
    undefined,
    undefined,
    toolCtx() as never,
  );
  assert.equal((projectionOf(runResult) as { conclusion: string }).conclusion, "failure");
  const runRequest = runCall.executor.calls.find((call) => call.argv[0] === "run");
  assert.ok(runRequest);
  assert.ok(runRequest.argv.includes("--attempt"));
  assert.ok(runRequest.argv.includes("2"));

  const jobCall = load("gh_view_job", { databaseId: 200, status: "completed", conclusion: "success" });
  const jobResult = await jobCall.tool.execute(
    "ci-job",
    { target: "https://github.com/cli/cli/actions/runs/100/job/200" },
    undefined,
    undefined,
    toolCtx() as never,
  );
  assert.equal((projectionOf(jobResult) as { databaseId: number }).databaseId, 200);
  const jobRequest = jobCall.executor.calls.find((call) => call.argv[0] === "run");
  assert.ok(jobRequest);
  assert.ok(jobRequest.argv.includes("--job"));
  assert.ok(jobRequest.argv.includes("200"));

  const checksCall = load("gh_pr_checks", [{ name: "build", state: "FAILURE", bucket: "fail" }]);
  const checksResult = await checksCall.tool.execute(
    "ci-checks",
    { target: "https://github.com/cli/cli/pull/12" },
    undefined,
    undefined,
    toolCtx() as never,
  );
  const checksProjection = projectionOf(checksResult) as { checks: unknown[] };
  assert.deepEqual(checksProjection.checks, [{ name: "build", state: "FAILURE", bucket: "fail" }]);
  const checksRequest = checksCall.executor.calls.find((call) => call.argv[0] === "pr");
  assert.ok(checksRequest);
  assert.deepEqual(checksRequest.argv.slice(0, 3), ["pr", "checks", "12"]);
});

test("CI tools preserve pending conclusions and reject unqualified repositories", async () => {
  const { tool } = load("gh_list_workflow_runs", { total_count: 0, workflow_runs: [] });
  const pending = await tool.execute("ci-pending", { repo: "cli/cli" }, undefined, undefined, toolCtx() as never);
  assert.deepEqual((projectionOf(pending) as { runs: unknown[] }).runs, []);
  await assert.rejects(
    () => tool.execute("ci-invalid", { repo: "." }, undefined, undefined, toolCtx() as never),
    (error: unknown) => error instanceof GhExecutionError && error.category === "validation",
  );
});
