import assert from "node:assert/strict";
import { test } from "node:test";
import { GhExecutionError } from "../extensions/gh/index.ts";
import { ACTIONS_JOB_REST_FIXTURE } from "./fixtures/ci-live-format.ts";
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
  const cliRuns = [{
    databaseId: 100,
    workflowDatabaseId: 7,
    workflowName: "build",
    displayTitle: "build main",
    status: "completed",
    conclusion: "success",
    event: "push",
    headBranch: "main",
    headSha: "abc123",
    attempt: 2,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:01:00Z",
    url: "https://github.com/cli/cli/actions/runs/100",
  }];
  const restRuns = [{
    id: 100,
    workflow_id: 7,
    name: "build",
    display_title: "build main",
    status: "completed",
    conclusion: "success",
    event: "push",
    head_branch: "main",
    head_sha: "abc123",
    run_attempt: 2,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:01:00Z",
    url: "https://api.github.com/repos/cli/cli/actions/runs/100",
    html_url: "https://github.com/cli/cli/actions/runs/100",
  }];
  const runs = [{
    databaseId: 100,
    workflowDatabaseId: 7,
    workflowName: "build",
    displayTitle: "build main",
    status: "completed",
    conclusion: "success",
    event: "push",
    headBranch: "main",
    headSha: "abc123",
    attempt: 2,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:01:00Z",
    url: "https://github.com/cli/cli/actions/runs/100",
  }];
  const executor = createFakeExecutor((request) => request.argv[0] === "--version"
    ? version()
    : request.argv[0] === "run"
      ? json(cliRuns)
      : json({ total_count: 1, workflow_runs: restRuns }));
  const loaded = loadExtension({ executor: executor.execute });
  const tool = loaded.tools.get("gh_list_workflow_runs");
  assert.ok(tool, "gh_list_workflow_runs must be registered");
  const result = await tool.execute(
    "ci-list",
    { repo: "cli/cli", workflow: "build", branch: "main", limit: 4 },
    undefined,
    undefined,
    toolCtx() as never,
  );
  const projection = projectionOf(result) as { runs: unknown[]; filtered: boolean; limit: number };
  assert.equal(projection.filtered, true);
  assert.deepEqual(projection.runs, runs);
  assert.equal(projection.limit, 4);
  const request = executor.calls.find((call) => call.argv[0] === "run");
  assert.ok(request);
  assert.ok(request.argv.includes("list") && request.argv.includes("--repo") && request.argv.includes("cli/cli"));
  assert.ok(request.argv.includes("--limit") && request.argv.includes(String(4)));
  assert.ok(request.argv.includes("--workflow") && request.argv.includes("build"));
  assert.ok(request.argv.includes("--branch") && request.argv.includes("main"));

  // No filters → REST endpoint used.
  const plain = await tool.execute(
    "ci-list-plain",
    { repo: "cli/cli", limit: 3 },
    undefined,
    undefined,
    toolCtx() as never,
  );
  const plainProjection = projectionOf(plain) as { runs: unknown[]; filtered: boolean };
  assert.equal(plainProjection.filtered, false);
  assert.deepEqual(plainProjection.runs, runs);
  const apiCall = executor.calls.find((call) => call.argv[0] === "api");
  assert.ok(apiCall);
  assert.ok(apiCall.argv.includes("repos/cli/cli/actions/runs"));
  assert.ok(apiCall.argv.includes("per_page=3"));
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

  const jobCall = load("gh_view_job", ACTIONS_JOB_REST_FIXTURE);
  const jobResult = await jobCall.tool.execute(
    "ci-job",
    { target: "https://github.com/cli/cli/actions/runs/100/job/200" },
    undefined,
    undefined,
    toolCtx() as never,
  );
  const jobProjection = projectionOf(jobResult) as {
    databaseId: number;
    runId: number;
    name: string;
    url: string;
    steps: Array<{ name: string; conclusion: string }>;
  };
  assert.equal(jobProjection.databaseId, 200);
  assert.equal(jobProjection.runId, 100);
  assert.equal(jobProjection.name, "test (node 24)");
  assert.equal(jobProjection.url, "https://github.com/cli/cli/actions/runs/100/job/200");
  assert.deepEqual(jobProjection.steps.map((step) => step.name), ["Set up job", "Run tests"]);
  assert.equal(jobProjection.steps[1]?.conclusion, "failure");
  const jobRequest = jobCall.executor.calls.find((call) => call.argv[0] === "api");
  assert.ok(jobRequest);
  assert.ok(jobRequest.argv.includes("repos/cli/cli/actions/jobs/200"));
  assert.ok(jobRequest.argv.includes("--method") && jobRequest.argv.includes("GET"));

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

test("CI exit-0 empty job output is contextual instead of an opaque JSON error", async () => {
  const executor = createFakeExecutor((request) => request.argv[0] === "--version"
    ? version()
    : { stdout: "", stderr: "", code: 0, killed: false });
  const { tools } = loadExtension({ executor: executor.execute });
  const tool = tools.get("gh_view_job");
  assert.ok(tool);
  await assert.rejects(
    () => tool.execute("ci-job-empty", { target: "https://github.com/cli/cli/actions/runs/100/job/200" }, undefined, undefined, toolCtx() as never),
    (error: unknown) => error instanceof GhExecutionError
      && error.category === "malformed_json"
      && /cli\/cli job 200 \(run 100\)/i.test(error.message)
      && /empty response/i.test(error.message),
  );

  const view = tools.get("gh_view");
  assert.ok(view);
  await assert.rejects(
    () => view.execute("ci-job-view-empty", { target: "https://github.com/cli/cli/actions/runs/100/job/200" }, undefined, undefined, toolCtx() as never),
    (error: unknown) => error instanceof GhExecutionError
      && error.category === "malformed_json"
      && /cli\/cli job 200 \(run 100\)/i.test(error.message)
      && /empty response/i.test(error.message),
  );
});

test("gh_view malformed job JSON names the requested job and run", async () => {
  const executor = createFakeExecutor((request) => request.argv[0] === "--version"
    ? version()
    : json({}));
  const { tools } = loadExtension({ executor: executor.execute });
  const view = tools.get("gh_view");
  assert.ok(view);
  await assert.rejects(
    () => view.execute("ci-job-view-malformed", { target: "https://github.com/cli/cli/actions/runs/100/job/200" }, undefined, undefined, toolCtx() as never),
    (error: unknown) => error instanceof GhExecutionError
      && error.category === "malformed_json"
      && /cli\/cli job 200 \(run 100\)/i.test(error.message),
  );
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
