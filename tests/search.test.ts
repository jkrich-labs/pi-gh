import assert from "node:assert/strict";
import { test } from "node:test";
import { GhExecutionError } from "../extensions/gh/index.ts";
import { createFakeExecutor, loadExtension, projectionOf, toolCtx } from "./helpers.ts";

function json(stdout: unknown) {
  return { stdout: JSON.stringify(stdout), stderr: "", code: 0, killed: false };
}

function version() {
  return { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false };
}

function loadSearch(name: string, response: unknown = { total_count: 0, incomplete_results: false, items: [] }) {
  const executor = createFakeExecutor((request) => {
    if (request.argv[0] === "--version") return version();
    return json(response);
  });
  const loaded = loadExtension({ executor: executor.execute });
  const tool = loaded.tools.get(name);
  assert.ok(tool, `${name} must be registered`);
  return { executor, tool };
}

test("search tools preserve queries, scope repositories, and cover every planned kind", async () => {
  const cases = [
    ["gh_search_issues", "search/issues", "is:issue"],
    ["gh_search_pull_requests", "search/issues", "is:pr"],
    ["gh_search_repositories", "search/repositories", ""],
    ["gh_search_code", "search/code", ""],
    ["gh_search_commits", "search/commits", ""],
  ] as const;

  for (const [name, endpoint, qualifier] of cases) {
    const { executor, tool } = loadSearch(name, {
      total_count: 1,
      incomplete_results: false,
      items: [{ id: 1, full_name: "cli/cli", title: "Fix bug", html_url: "https://github.com/cli/cli" }],
    });
    const result = await tool.execute(
      "search-1",
      { query: "bug from prompt", repo: "cli/cli", limit: 7, page: 2 },
      undefined,
      undefined,
      toolCtx() as never,
    );
    const projection = projectionOf(result) as { query: string; results: unknown[]; page: number; limit: number };
    assert.equal(projection.query, "bug from prompt");
    assert.equal(projection.results.length, 1);
    assert.equal(projection.page, 2);
    assert.equal(projection.limit, 7);

    const request = executor.calls.find((call) => call.argv[0] === "api");
    assert.ok(request);
    assert.ok(request.argv.includes(endpoint));
    assert.ok(request.argv.includes("--method") && request.argv.includes("GET"));
    const query = request.argv.find((part) => part.startsWith("q="));
    assert.ok(query);
    assert.match(query, /bug from prompt/);
    assert.match(query, /repo:cli\/cli/);
    if (qualifier) assert.match(query, new RegExp(qualifier));
    assert.ok(request.argv.includes("per_page=7"));
    assert.ok(request.argv.includes("page=2"));
  }
});

test("search tools enforce bounded defaults and return empty results", async () => {
  const { executor, tool } = loadSearch("gh_search_code");
  const result = await tool.execute(
    "search-2",
    { query: "nothing", limit: 999, page: 999 },
    undefined,
    undefined,
    toolCtx() as never,
  );
  const projection = projectionOf(result) as { results: unknown[]; totalCount: number; limit: number; page: number };
  assert.deepEqual(projection.results, []);
  assert.equal(projection.totalCount, 0);
  assert.equal(projection.limit, 50);
  assert.equal(projection.page, 10);
  const request = executor.calls.find((call) => call.argv[0] === "api");
  assert.ok(request);
  assert.ok(request.argv.includes("per_page=50"));
  assert.ok(request.argv.includes("page=10"));
});

test("search tools preserve classified GitHub failures", async () => {
  const executor = createFakeExecutor((request) => {
    if (request.argv[0] === "--version") return version();
    return { stdout: "", stderr: "HTTP 403: Resource not accessible", code: 1, killed: false };
  });
  const loaded = loadExtension({ executor: executor.execute });
  const tool = loaded.tools.get("gh_search_issues");
  assert.ok(tool);
  await assert.rejects(
    () => tool.execute("search-3", { query: "private" }, undefined, undefined, toolCtx() as never),
    (error: unknown) => error instanceof GhExecutionError && error.category === "permission",
  );
});
