import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateProjectionTokens } from "../extensions/gh/execute.ts";
import { createFakeExecutor, loadExtension, projectionOf, toolCtx } from "./helpers.ts";

test("initial tools keep combined gh_view and gh_find metadata within 800 estimated tokens", () => {
  const loaded = loadExtension();
  const metadata = ["gh_view", "gh_find"].map((name) => {
    const tool = loaded.tools.get(name);
    assert.ok(tool);
    return {
      name: tool.name,
      label: tool.label,
      description: tool.description,
      promptSnippet: tool.promptSnippet,
      parameters: tool.parameters,
    };
  });
  const estimatedTokens = Math.ceil(JSON.stringify(metadata).length / 4);
  assert.ok(estimatedTokens <= 800, `initial metadata estimated at ${estimatedTokens} tokens`);
});

test("API GET projections stay within compact and expanded result budgets", async () => {
  const payload = { items: Array.from({ length: 5 }, () => "large response ".repeat(300)) };
  const executor = createFakeExecutor((request) => request.argv[0] === "--version"
    ? { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false }
    : { stdout: JSON.stringify(payload), stderr: "", code: 0, killed: false });
  const loaded = loadExtension({ executor: executor.execute });
  const tool = loaded.tools.get("gh_api_get");
  assert.ok(tool);
  for (const [detail, budget] of [["compact", 2_000], ["expanded", 8_000]] as const) {
    const projection = projectionOf(await tool.execute("api-budget", { endpoint: "repos/cli/cli", detail }, undefined, undefined, toolCtx() as never)) as { truncated?: boolean };
    assert.ok(estimateProjectionTokens(JSON.stringify(projection)) <= budget);
    assert.equal(Boolean(projection.truncated), detail === "compact");
  }
});

test("resource view compact and expanded projections stay within their result budgets", async () => {
  const payload = {
    number: 7,
    title: "Large issue",
    state: "OPEN",
    body: "Issue body ".repeat(10_000),
    comments: Array.from({ length: 50 }, (_, index) => ({ body: `Comment ${index} `.repeat(500), author: { login: `user-${index}` } })),
  };
  const executor = createFakeExecutor((request) => request.argv[0] === "--version"
    ? { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false }
    : { stdout: JSON.stringify(payload), stderr: "", code: 0, killed: false });
  const loaded = loadExtension({ executor: executor.execute });
  const tool = loaded.tools.get("gh_view");
  assert.ok(tool);
  for (const [detail, budget] of [["compact", 2_000], ["expanded", 8_000]] as const) {
    const projection = projectionOf(
      await tool.execute("view-budget", { target: "https://github.com/cli/cli/issues/7", detail }, undefined, undefined, toolCtx() as never),
    ) as Record<string, unknown>;
    assert.ok(estimateProjectionTokens(JSON.stringify(projection)) <= budget);
    assert.equal("body" in projection, detail === "expanded" && !projection.truncated);
  }
});

test("CI projections stay within compact and expanded result budgets", async () => {
  const runs = Array.from({ length: 50 }, (_, index) => ({
    databaseId: index,
    workflowName: "build",
    displayTitle: "large workflow ".repeat(500),
    status: "completed",
    conclusion: index % 2 === 0 ? "success" : "failure",
  }));
  const executor = createFakeExecutor((request) => request.argv[0] === "--version"
    ? { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false }
    : { stdout: JSON.stringify({ total_count: runs.length, workflow_runs: runs }), stderr: "", code: 0, killed: false });
  const loaded = loadExtension({ executor: executor.execute });
  const tool = loaded.tools.get("gh_list_workflow_runs");
  assert.ok(tool);
  for (const [detail, budget] of [["compact", 2_000], ["expanded", 8_000]] as const) {
    const projection = projectionOf(await tool.execute("ci-budget", { repo: "cli/cli", detail }, undefined, undefined, toolCtx() as never));
    assert.ok(estimateProjectionTokens(JSON.stringify(projection)) <= budget);
  }
});
