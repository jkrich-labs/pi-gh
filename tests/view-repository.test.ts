import assert from "node:assert/strict";
import { test } from "node:test";
import { GhExecutionError } from "../extensions/gh/index.ts";
import {
  REPO_PROJECTION,
  REPO_VIEW_JSON,
  callView,
  loadExtension,
  projectionOf,
  repoViewArgv,
  scriptedExecutor,
} from "./helpers.ts";

function loadView(executor = scriptedExecutor()) {
  const { tools } = loadExtension({ executor: executor.execute });
  const tool = tools.get("gh_view");
  assert.ok(tool, "gh_view must be registered");
  return { tool, executor };
}

async function viewError(params: Record<string, unknown>, executor = scriptedExecutor()) {
  const { tool } = loadView(executor);
  try {
    await callView(tool, params);
  } catch (error) {
    assert.ok(error instanceof GhExecutionError);
    return error;
  }
  throw new Error("expected gh_view to throw");
}

test("gh_view inspects a github.com repository URL", async () => {
  const { tool, executor } = loadView();
  const result = await callView(tool, { target: "https://github.com/cli/cli" });
  assert.deepEqual(projectionOf(result), REPO_PROJECTION);
  assert.deepEqual(executor.calls[1]?.argv, repoViewArgv("cli/cli"));
});

test("gh_view inspects an owner/repo resource target", async () => {
  const { tool, executor } = loadView();
  const result = await callView(tool, { target: "cli/cli" });
  assert.deepEqual(projectionOf(result), REPO_PROJECTION);
  assert.deepEqual(executor.calls[1]?.argv, repoViewArgv("cli/cli"));
});

test("gh_view inspects the current checkout when the target is omitted", async () => {
  const { tool, executor } = loadView();
  const result = await callView(tool, {}, undefined, "/tmp/checkout");
  assert.deepEqual(projectionOf(result), REPO_PROJECTION);
  assert.deepEqual(executor.calls[1]?.argv, repoViewArgv());
  assert.equal(executor.calls[1]?.cwd, "/tmp/checkout");
});

test("gh_view reports missing gh", async () => {
  const error = await viewError(
    { target: "cli/cli" },
    scriptedExecutor({
      version: Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }),
    }),
  );
  assert.equal(error.category, "missing_cli");
});

test("gh_view reports an unsupported gh version", async () => {
  const error = await viewError(
    { target: "cli/cli" },
    scriptedExecutor({
      version: {
        stdout: "gh version 2.80.9 (2025-09-01)\n",
        stderr: "",
        code: 0,
        killed: false,
      },
    }),
  );
  assert.equal(error.category, "unsupported_version");
});

test("gh_view reports malformed JSON from gh", async () => {
  const error = await viewError(
    { target: "cli/cli" },
    scriptedExecutor({
      onView: () => ({ stdout: "not-json", stderr: "", code: 0, killed: false }),
    }),
  );
  assert.equal(error.category, "malformed_json");
});

test("gh_view reports authentication failures", async () => {
  const error = await viewError(
    { target: "cli/cli" },
    scriptedExecutor({
      onView: () => ({
        stdout: "",
        stderr: "gh: To use GitHub CLI, run gh auth login",
        code: 4,
        killed: false,
      }),
    }),
  );
  assert.equal(error.category, "auth");
});

test("gh_view reports permission failures", async () => {
  const error = await viewError(
    { target: "private/repo" },
    scriptedExecutor({
      onView: () => ({
        stdout: "",
        stderr: "GraphQL: Resource not accessible by integration (repository)",
        code: 1,
        killed: false,
      }),
    }),
  );
  assert.equal(error.category, "permission");
});

test("gh_view reports not-found failures", async () => {
  const error = await viewError(
    { target: "missing/repo" },
    scriptedExecutor({
      onView: () => ({
        stdout: "",
        stderr: "GraphQL: Could not resolve to a Repository with the name 'missing/repo'. (repository)",
        code: 1,
        killed: false,
      }),
    }),
  );
  assert.equal(error.category, "not_found");
});

test("gh_view reports timeouts", async () => {
  const error = await viewError(
    { target: "cli/cli" },
    scriptedExecutor({
      onView: () => ({ stdout: "", stderr: "", code: 1, killed: true }),
    }),
  );
  assert.equal(error.category, "timeout");
});

test("gh_view reports a timed-out version probe", async () => {
  const error = await viewError(
    { target: "cli/cli" },
    scriptedExecutor({
      version: { stdout: "", stderr: "", code: 1, killed: true },
    }),
  );
  assert.equal(error.category, "timeout");
});

test("gh_view truncates an oversized repository projection", async () => {
  const description = "x".repeat(20_000);
  const writes: string[] = [];
  const { tools } = loadExtension({
    executor: scriptedExecutor({
      onView: () => ({
        stdout: JSON.stringify({ ...REPO_VIEW_JSON, description }),
        stderr: "",
        code: 0,
        killed: false,
      }),
    }).execute,
    tempOutput: {
      async write(content) {
        writes.push(content);
        return { path: "/tmp/pi-gh/opaque" };
      },
    },
  });
  const tool = tools.get("gh_view");
  assert.ok(tool);
  const projection = projectionOf(await callView(tool, { target: "cli/cli" })) as Record<string, unknown>;
  assert.equal(projection.truncated, true);
  assert.equal(projection.fullPath, "/tmp/pi-gh/opaque");
  assert.equal(projection.nameWithOwner, "cli/cli");
  assert.equal(projection.stars, REPO_VIEW_JSON.stargazerCount);
  assert.equal(projection.forks, REPO_VIEW_JSON.forkCount);
  assert.equal(projection.omittedCount, 15);
  assert.ok((projection.tokenCount as number) > (projection.tokenBudget as number));
  assert.ok(writes[0]?.includes(description));
});

test("gh_view reports abort when the signal is aborted", async () => {
  const { tool } = loadView(
    scriptedExecutor({
      onView: () => ({ stdout: "", stderr: "", code: 1, killed: true }),
    }),
  );
  const signal = AbortSignal.abort();
  await assert.rejects(
    () => callView(tool, { target: "cli/cli" }, signal),
    (error: unknown) => error instanceof GhExecutionError && error.category === "aborted",
  );
});
