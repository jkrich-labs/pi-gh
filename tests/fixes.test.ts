import assert from "node:assert/strict";
import { test } from "node:test";
import { GhExecutionError } from "../extensions/gh/index.ts";
import { createFakeExecutor, loadExtension, projectionOf, toolCtx } from "./helpers.ts";

async function callTool(tool: { execute: (id: string, params: Record<string, unknown>, signal?: unknown, onUpdate?: unknown, ctx?: unknown) => Promise<unknown> }, id: string, params: Record<string, unknown>) {
  return tool.execute(id, params, undefined, undefined, toolCtx() as never) as Promise<{ content: Array<{ type: string; text?: string }> }>;
}

function version() {
  return { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false };
}

function json(value: unknown) {
  return { stdout: JSON.stringify(value), stderr: "", code: 0, killed: false };
}

/** Executor whose second `run view`/`pr checks` call can fail like gh 2.81.0 does. */
function scripted(responses: Array<(argv: string[]) => ReturnType<typeof json> | { stdout: string; stderr: string; code: number; killed: boolean }>) {
  const executor = createFakeExecutor((request) => {
    if (request.argv[0] === "--version") return version();
    const handler = responses.shift();
    if (!handler) throw new Error("unexpected gh call: " + request.argv.join(" "));
    return handler(request.argv);
  });
  return executor;
}

test("gh_view retries unknown JSON fields on old gh (release isLatest, job completedAt)", async () => {
  const executor = scripted([
    () => ({ stdout: "", stderr: 'Unknown JSON field: "isLatest"\nAvailable fields: name,tagName,isDraft', code: 1, killed: false }),
    () => json({ name: "v1", tagName: "v1", isDraft: false }),
  ]);
  const { tools } = loadExtension({ executor: executor.execute });
  const tool = tools.get("gh_view");
  assert.ok(tool);
  const result = await callTool(tool as never, "v", { target: "https://github.com/cli/cli/releases/tag/v1" });
  const projection = projectionOf(result) as { kind: string };
  assert.equal(projection.kind, "release");
  // First call failed on isLatest, then the extras retry + the stripped base call follow. Expect >= 2 gh invocations.
  assert.ok(executor.calls.length >= 2);
  const secondJson = executor.calls[1]!.argv[executor.calls[1]!.argv.indexOf("--json") + 1];
  assert.equal(secondJson!.includes("isLatest"), false);
});

test("exit-0 responses are never misclassified as failures", async () => {
  const executor = createFakeExecutor((request) => {
    if (request.argv[0] === "--version") return version();
    return {
      // A search body with total_count + items echoes digits everywhere; code 0 means success.
      stdout: JSON.stringify({ total_count: 6347, items: [{ number: 1, title: "ok" }] }),
      stderr: "",
      code: 0,
      killed: false,
    };
  });
  const { tools } = loadExtension({ executor: executor.execute });
  const tool = tools.get("gh_search_issues");
  assert.ok(tool);
  const result = await tool.execute("search", { query: "is:issue", repo: "cli/cli" }, undefined, undefined, toolCtx() as never);
  const projection = projectionOf(result) as { totalCount: number };
  assert.equal(projection.totalCount, 6347);
});

test("gh_pr_checks falls back to head-commit check-runs when the head branch is gone", async () => {
  const executor = scripted([
    // `gh pr checks` on the deleted branch fails with the ga's "no checks" message.
    () => ({ stdout: "", stderr: "no checks reported on the 'gh-pr' branch", code: 1, killed: false }),
    // GraphQL resolver returns the head oid.
    () => json({ data: { repository: { pullRequest: { number: 1, headRefName: "ghp_exampleSecretTokenValue1234567890", headRefOid: "abc123", state: "MERGED" } } } }),
    // check-runs for the head commit.
    () => json({ check_runs: [{ name: "build", conclusion: "success", html_url: "https://github.com/cli/cli/runs/1" }] }),
  ]);
  const { tools } = loadExtension({ executor: executor.execute });
  const tool = tools.get("gh_pr_checks");
  assert.ok(tool);
  const result = await tool.execute("checks", { target: "https://github.com/cli/cli/pull/1" }, undefined, undefined, toolCtx() as never);
  const projection = projectionOf(result) as { source: string; headRefOid: string; checkCount: number; checks: Array<{ name: string }> };
  assert.equal(projection.source, "head-commit");
  assert.equal(projection.headRefOid, "abc123");
  assert.equal((projection as unknown as { headRefName: string }).headRefName, "[redacted]");
  assert.equal(projection.checkCount, 1);
  assert.equal(projection.checks[0]?.name, "build");
});

test("gh_pr_checks preserves pending JSON checks returned with gh exit code 8", async () => {
  const checks = [{ name: "No checks reported by pending bot", state: "IN_PROGRESS", bucket: "pending" }];
  const executor = scripted([
    () => ({ stdout: JSON.stringify(checks), stderr: "", code: 8, killed: false }),
  ]);
  const { tools } = loadExtension({ executor: executor.execute });
  const tool = tools.get("gh_pr_checks");
  assert.ok(tool);
  const result = await tool.execute("checks-pending", { target: "https://github.com/cli/cli/pull/1" }, undefined, undefined, toolCtx() as never);
  const projection = projectionOf(result) as { pendingCount: number; checks: Array<{ state: string }> };
  assert.equal(projection.pendingCount, 1);
  assert.equal(projection.checks[0]?.state, "IN_PROGRESS");
});

test("gh_pr_checks does not mistake a JSON check name for plain no-check output", async () => {
  const checks = [{ name: "No checks reported by friendly bot", state: "SUCCESS", bucket: "pass" }];
  const executor = scripted([() => json(checks)]);
  const { tools } = loadExtension({ executor: executor.execute });
  const tool = tools.get("gh_pr_checks");
  assert.ok(tool);
  const result = await tool.execute("checks-phrase", { target: "https://github.com/cli/cli/pull/1" }, undefined, undefined, toolCtx() as never);
  const projection = projectionOf(result) as { checkCount: number; checks: Array<{ name: string }> };
  assert.equal(projection.checkCount, 1);
  assert.equal(projection.checks[0]?.name, checks[0]!.name);
  assert.equal(executor.calls.filter((call) => call.argv[0] === "api").length, 0);
});

test("gh_pr_checks preserves missing-PR errors instead of treating them as no checks", async () => {
  const executor = scripted([
    () => ({ stdout: "", stderr: "GraphQL: Could not resolve to a PullRequest with the number of 999.", code: 1, killed: false }),
  ]);
  const { tools } = loadExtension({ executor: executor.execute });
  const tool = tools.get("gh_pr_checks");
  assert.ok(tool);
  await assert.rejects(
    () => tool.execute("checks-missing", { target: "https://github.com/cli/cli/pull/999" }, undefined, undefined, toolCtx() as never),
    (error: unknown) => error instanceof GhExecutionError
      && error.category === "not_found"
      && /cli\/cli pull request #999/.test(error.message),
  );
  assert.equal(executor.calls.filter((call) => call.argv[0] === "api").length, 0);
});

test("gh_pr_checks turns exit-0 plain no-check output into a contextual empty projection", async () => {
  const executor = scripted([
    () => ({ stdout: "no checks reported on the 'gh-pr' branch\n", stderr: "", code: 0, killed: false }),
    () => json({ data: { repository: { pullRequest: { number: 1, headRefName: "gh-pr", headRefOid: undefined, state: "MERGED" } } } }),
  ]);
  const { tools } = loadExtension({ executor: executor.execute });
  const tool = tools.get("gh_pr_checks");
  assert.ok(tool);
  const result = await tool.execute("checks-empty", { target: "https://github.com/cli/cli/pull/1" }, undefined, undefined, toolCtx() as never);
  const projection = projectionOf(result) as { empty: boolean; checkCount: number; note: string; source: string };
  assert.equal(projection.source, "head-branch");
  assert.equal(projection.empty, true);
  assert.equal(projection.checkCount, 0);
  assert.match(projection.note, /No checks are reported/);
});

test("gh_list_workflow_runs routes filtered listings to gh run list", async () => {
  const executor = scripted([
    () => json([{ databaseId: 9, status: "completed", conclusion: "failure" }]),
  ]);
  const { tools } = loadExtension({ executor: executor.execute });
  const tool = tools.get("gh_list_workflow_runs");
  assert.ok(tool);
  const result = await tool.execute("runs", { repo: "cli/cli", conclusion: "failure", limit: 5 }, undefined, undefined, toolCtx() as never);
  const projection = projectionOf(result) as { filtered: boolean; runs: Array<{ conclusion: string }> };
  assert.equal(projection.filtered, true);
  assert.equal(projection.runs[0]?.conclusion, "failure");
  const call = executor.calls.find((call) => call.argv[0] === "run");
  assert.ok(call);
  assert.ok(call.argv.includes("list"));
  assert.ok(call.argv.includes("--status") && call.argv.includes("failure"));
});

test("gh_api_get explains the @ credential-leak guard", async () => {
  const executor = scripted([]);
  const { tools } = loadExtension({ executor: executor.execute });
  const tool = tools.get("gh_api_get");
  assert.ok(tool);
  await assert.rejects(
    () => tool.execute("api", { endpoint: "search/users", query: { q: "user@email.com" } }, undefined, undefined, toolCtx() as never),
    (error: unknown) => error instanceof GhExecutionError && error.category === "validation" && /credential-leak guard/.test(error.message),
  );
});

test("gh_api_get accepts jq slices", async () => {
  const executor = scripted([
    () => ({ stdout: "[1,2,3]\n", stderr: "", code: 0, killed: false }),
  ]);
  const { tools } = loadExtension({ executor: executor.execute });
  const tool = tools.get("gh_api_get");
  assert.ok(tool);
  const result = await tool.execute("api", { endpoint: "repos/cli/cli/actions/runs", jq: ".workflow_runs[:3].name" }, undefined, undefined, toolCtx() as never);
  const projection = projectionOf(result) as { data: string };
  assert.equal(projection.data, "[1,2,3]");
});

test("gh_view decodes base64 files like gh_read_file", async () => {
  const executor = scripted([
    () => json({ type: "file", encoding: "base64", content: Buffer.from("decoded!", "utf8").toString("base64"), size: 8 }),
  ]);
  const { tools } = loadExtension({ executor: executor.execute });
  const tool = tools.get("gh_view");
  assert.ok(tool);
  const result = await callTool(tool as never, "v", { target: "https://github.com/cli/cli/blob/trunk/a.txt" });
  const projection = projectionOf(result) as { kind: string; content: string };
  assert.equal(projection.kind, "file");
  assert.equal(projection.content, "decoded!");
});

test("PR create and review send an explicit body flag", async () => {
  const executor = scripted([
    () => ({ stdout: "https://github.com/cli/cli/pull/1\n", stderr: "", code: 0, killed: false }),
    () => ({ stdout: "https://github.com/cli/cli/pull/1\n", stderr: "", code: 0, killed: false }),
  ]);
  const loaded = loadExtension({ executor: executor.execute });
  const create = loaded.tools.get("gh_create_pull_request");
  assert.ok(create);
  await create.execute("pr-create", { repo: "cli/cli", title: "T", head: "feature" }, undefined, undefined, toolCtx() as never);
  const createArgv = executor.calls.find((call) => call.argv[0] === "pr")!.argv;
  assert.ok(createArgv.includes("--body"));

  const review = loaded.tools.get("gh_review_pull_request");
  assert.ok(review);
  await review.execute("pr-review", { target: "cli/cli#1", event: "approve" }, undefined, undefined, toolCtx() as never);
  const reviewArgv = executor.calls.find((call) => call.argv[0] === "pr" && call.argv.includes("review"))!.argv;
  assert.ok(reviewArgv.includes("--body"));
});

test("comment review without a body is rejected with a clear message", async () => {
  const executor = scripted([]);
  const { tools } = loadExtension({ executor: executor.execute });
  const tool = tools.get("gh_review_pull_request");
  assert.ok(tool);
  await assert.rejects(
    () => tool.execute("pr-review", { target: "cli/cli#1", event: "comment" }, undefined, undefined, toolCtx() as never),
    (error: unknown) => error instanceof GhExecutionError && error.category === "validation" && /non-empty body/.test(error.message),
  );
});
