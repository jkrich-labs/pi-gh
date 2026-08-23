import assert from "node:assert/strict";
import { test } from "node:test";
import { GhExecutionError } from "../extensions/gh/index.ts";
import { createFakeExecutor, loadExtension, projectionOf, toolCtx } from "./helpers.ts";

function load(response: unknown = { id: 1, name: "item" }, authHosts?: string[], raw = false) {
  const executor = createFakeExecutor((request) => {
    if (request.argv[0] === "--version") return { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false };
    if (request.argv[0] === "auth") return { stdout: JSON.stringify({ hosts: authHosts ? Object.fromEntries(authHosts.map((host) => [host, [{ state: "success", active: true }]])) : {} }), stderr: "", code: 0, killed: false };
    return { stdout: raw ? String(response) : JSON.stringify(response), stderr: "", code: 0, killed: false };
  });
  const loaded = loadExtension({ executor: executor.execute });
  const tool = loaded.tools.get("gh_api_get");
  assert.ok(tool);
  return { executor, tool };
}

test("gh_api_get normalizes endpoints, forces GET, scopes hosts, queries typed values, and bounds pages", async () => {
  const { executor, tool } = load({ items: [1, 2] }, ["ghe.example.com"]);
  const result = await tool.execute(
    "api-1",
    { endpoint: "/repos/team/project/issues", host: "ghe.example.com", query: { state: "open", labels: "bug" }, page: 99, perPage: 999, cache: "60s", jq: ".items" },
    undefined,
    undefined,
    toolCtx() as never,
  );
  const projection = projectionOf(result) as { endpoint: string; page: number; perPage: number; data: unknown };
  assert.equal(projection.endpoint, "repos/team/project/issues");
  assert.equal(projection.page, 10);
  assert.equal(projection.perPage, 50);
  assert.equal(projection.data, JSON.stringify({ items: [1, 2] }));
  const request = executor.calls.find((call) => call.argv[0] === "api");
  assert.ok(request);
  assert.deepEqual(request.argv.slice(0, 5), ["api", "--hostname", "ghe.example.com", "repos/team/project/issues", "--method"]);
  assert.ok(request.argv.includes("GET"));
  assert.ok(request.argv.includes("--raw-field"));
  assert.ok(request.argv.includes("state=open"));
  assert.ok(request.argv.includes("labels=bug"));
  assert.ok(request.argv.includes("page=10"));
  assert.ok(request.argv.includes("per_page=50"));
  assert.ok(request.argv.includes("--cache") && request.argv.includes("60s"));
  assert.ok(request.argv.includes("--jq") && request.argv.includes(".items"));
});

test("gh_api_get pins the default host to github.com", async () => {
  const { executor, tool } = load({ ok: true });
  await tool.execute("api-host", { endpoint: "repos/cli/cli/issues" }, undefined, undefined, toolCtx() as never);
  const request = executor.calls.find((call) => call.argv[0] === "api");
  assert.ok(request);
  assert.deepEqual(request.argv.slice(0, 4), ["api", "--hostname", "github.com", "repos/cli/cli/issues"]);
});

test("gh_api_get allows release-asset metadata reads", async () => {
  const { executor, tool } = load({ id: 123, name: "asset.zip" });
  await tool.execute("asset-metadata", { endpoint: "repos/cli/cli/releases/assets/123" }, undefined, undefined, toolCtx() as never);
  assert.equal(executor.calls.some((call) => call.argv[0] === "api"), true);
});

test("gh_api_get rejects unsafe endpoints and impossible mutation inputs", async () => {
  for (const params of [
    { endpoint: "https://api.github.com/repos/cli/cli" },
    { endpoint: "/https://evil.example/repos/cli/cli" },
    { endpoint: "//evil.example/repos/cli/cli" },
    { endpoint: "ftp://evil.example/repos/cli/cli" },
    { endpoint: "graphql" },
    { endpoint: "/GraphQL" },
    { endpoint: "--input" },
    { endpoint: "repos/cli/cli", method: "POST" },
    { endpoint: "repos/cli/cli", body: "{}" },
    { endpoint: "repos/cli/cli", headers: { Authorization: "x" } },
    { endpoint: "repos/cli/cli", jq: "env" },
    { endpoint: "repos/cli/cli", jq: ".items | {name}" },
    { endpoint: "repos/cli/cli", jq: ".resources.core.limit-now" },
    { endpoint: "repos/cli/cli", preview: "foo" },
    { endpoint: "repos/cli/cli", input: "@payload.json" },
    { endpoint: "repos/{owner}/{repo}" },
    { endpoint: "repos/:owner/:repo/issues" },
    { endpoint: "repos/cli/cli/%2e%2e/%2e%2e/graphql" },
    { endpoint: "repos/cli/cli/@secret" },
    { endpoint: "repos/cli/cli/actions/artifacts/123/zip" },
    { endpoint: "repos/cli/cli/actions/runs/123/logs" },
    { endpoint: "repos/cli/cli/actions/jobs/123/logs" },
    { endpoint: "repos/cli/cli/actions//runs/123/logs" },
    { endpoint: `repos/cli/cli/${"x".repeat(600)}` },
    { endpoint: "repos/cli/cli", query: { q: "@/etc/passwd" } },
    { endpoint: "repos/cli/cli", query: { "nested[per_page]": "100" } },
    { endpoint: "repos/cli/cli", query: { page: "100" } },
    { endpoint: "repos/cli/cli", query: { page: 100 } as unknown as Record<string, string> },
  ]) {
    const { executor, tool } = load();
    await assert.rejects(
      () => tool.execute("api-reject", params, undefined, undefined, toolCtx() as never),
      (error: unknown) => error instanceof GhExecutionError && error.category === "validation",
    );
    assert.equal(executor.calls.some((call) => call.argv[0] === "api"), false);
  }
});

test("gh_api_get bounds query parameter count and bytes", async () => {
  const { executor, tool } = load();
  const query = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`key${index}`, "value"]));
  await assert.rejects(() => tool.execute("api-query-limit", { endpoint: "repos/cli/cli", query }, undefined, undefined, toolCtx() as never), (error: unknown) => error instanceof GhExecutionError && error.category === "validation");
  assert.equal(executor.calls.some((call) => call.argv[0] === "api"), false);
});

test("gh_api_get rejects query key, value, and aggregate byte limits", async () => {
  const cases = [
    { query: { ["k".repeat(101)]: "value" } },
    { query: { key: "v".repeat(2_001) } },
    { query: Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`key${index}`, "v".repeat(1_000)])) },
    { query: { key: "😀".repeat(2_001) } },
  ];
  for (const params of cases) {
    const { executor, tool } = load();
    await assert.rejects(() => tool.execute("api-query-bound", { endpoint: "repos/cli/cli/issues", ...params }, undefined, undefined, toolCtx() as never), (error: unknown) => error instanceof GhExecutionError && error.category === "validation");
    assert.equal(executor.calls.some((call) => call.argv[0] === "api"), false);
  }
});

test("gh_api_get accepts scalar and line-oriented jq output", async () => {
  const { tool } = load("cli\n", undefined, true);
  const projection = projectionOf(await tool.execute("api-jq", { endpoint: "repos/cli/cli", jq: ".name" }, undefined, undefined, toolCtx() as never)) as { data: string };
  assert.equal(projection.data, "cli");
});

test("gh_api_get keeps jq scalar text from being reparsed as JSON", async () => {
  const { tool } = load("123", undefined, true);
  const projection = projectionOf(await tool.execute("api-jq-number", { endpoint: "repos/cli/cli", jq: ".count" }, undefined, undefined, toolCtx() as never)) as { data: unknown };
  assert.equal(projection.data, "123");
});

test("gh_api_get bounds oversized responses to a secure temporary projection", async () => {
  const { tool } = load({ payload: Array.from({ length: 50 }, () => "x".repeat(4_000)) });
  const projection = projectionOf(await tool.execute("api-large", { endpoint: "repos/cli/cli" }, undefined, undefined, toolCtx() as never)) as { truncated?: boolean; fullPath?: string };
  assert.equal(projection.truncated, true);
  assert.match(projection.fullPath ?? "", /pi-gh-/);
});

test("gh_api_get truncates oversized output to secure temporary storage", async () => {
  const { tool } = load("x".repeat(1_000_001), undefined, true);
  const projection = projectionOf(await tool.execute("api-too-large", { endpoint: "repos/cli/cli/issues" }, undefined, undefined, toolCtx() as never)) as { truncated: boolean; fullPath: string; byteCount: number };
  assert.equal(projection.truncated, true);
  assert.equal(projection.byteCount, 1_000_001);
  assert.match(projection.fullPath, /pi-gh-/);
});

test("gh_api_get redacts token-shaped endpoint and response-key text", async () => {
  const { tool } = load({ ghp_responsekeysecret: "value" }, undefined, false);
  const result = await tool.execute("api-secret", { endpoint: "repos/ghp_secretvalue/issues" }, undefined, undefined, toolCtx() as never);
  const text = JSON.stringify(projectionOf(result));
  assert.doesNotMatch(text, /ghp_secretvalue/);
  assert.match(text, /\[redacted\]/);
});

test("gh_api_get bounds oversized error diagnostics", async () => {
  const executor = createFakeExecutor((request) => request.argv[0] === "--version"
    ? { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false }
    : { stdout: "", stderr: `HTTP 404: not found ${"😀".repeat(600_000)}`, code: 1, killed: false });
  const loaded = loadExtension({ executor: executor.execute });
  const tool = loaded.tools.get("gh_api_get");
  assert.ok(tool);
  await assert.rejects(() => tool.execute("api-error-large", { endpoint: "repos/cli/cli/missing" }, undefined, undefined, toolCtx() as never), (error: unknown) => {
    assert.ok(error instanceof GhExecutionError);
    assert.ok(Buffer.byteLength(String(error.details.stderr), "utf8") <= 1_000_000);
    return error.category === "not_found";
  });
});

test("gh_api_get preserves classified errors", async () => {
  const executor = createFakeExecutor((request) => request.argv[0] === "--version"
    ? { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false }
    : { stdout: "", stderr: "HTTP 404: not found", code: 1, killed: false });
  const loaded = loadExtension({ executor: executor.execute });
  const tool = loaded.tools.get("gh_api_get");
  assert.ok(tool);
  await assert.rejects(() => tool.execute("api-error", { endpoint: "repos/cli/cli/missing" }, undefined, undefined, toolCtx() as never), (error: unknown) => error instanceof GhExecutionError && error.category === "not_found");
});
