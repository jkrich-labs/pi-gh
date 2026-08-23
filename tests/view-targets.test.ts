import assert from "node:assert/strict";
import { test } from "node:test";
import { GhExecutionError, resolveResourceTarget } from "../extensions/gh/index.ts";
import { callView, loadExtension, scriptedExecutor } from "./helpers.ts";

test("gh_view resolves every supported github.com URL shape", () => {
  const cases = [
    ["https://github.com/cli/cli", { kind: "repository", host: "github.com", owner: "cli", name: "cli" }],
    ["https://github.com/cli/cli/issues/42", { kind: "issue", host: "github.com", owner: "cli", name: "cli", number: 42 }],
    ["https://github.com/cli/cli/pull/43", { kind: "pull_request", host: "github.com", owner: "cli", name: "cli", number: 43 }],
    ["https://github.com/cli/cli/commit/abc123", { kind: "commit", host: "github.com", owner: "cli", name: "cli", sha: "abc123" }],
    ["https://github.com/cli/cli/releases/tag/v2.81.0", { kind: "release", host: "github.com", owner: "cli", name: "cli", tag: "v2.81.0" }],
    ["https://github.com/cli/cli/actions/runs/100", { kind: "workflow_run", host: "github.com", owner: "cli", name: "cli", runId: 100 }],
    ["https://github.com/cli/cli/actions/runs/100/job/200", { kind: "job", host: "github.com", owner: "cli", name: "cli", runId: 100, jobId: 200 }],
    ["https://github.com/cli/cli/blob/trunk/docs/read me.md", { kind: "file", host: "github.com", owner: "cli", name: "cli", ref: "trunk", path: "docs/read me.md" }],
    ["https://github.com/cli/cli/tree/trunk/docs", { kind: "tree", host: "github.com", owner: "cli", name: "cli", ref: "trunk", path: "docs" }],
    ["https://github.com/cli/cli/compare/main...feature", { kind: "compare", host: "github.com", owner: "cli", name: "cli", base: "main", head: "feature" }],
  ] as const;

  for (const [raw, expected] of cases) assert.deepEqual(resolveResourceTarget(raw), expected);
});

test("gh_view resolves host-qualified identifiers and GHES URLs", () => {
  assert.deepEqual(resolveResourceTarget("cli/cli"), {
    kind: "repository",
    host: "github.com",
    owner: "cli",
    name: "cli",
  });
  assert.deepEqual(resolveResourceTarget("ghe.example.com/team/project"), {
    kind: "repository",
    host: "ghe.example.com",
    owner: "team",
    name: "project",
  });
  assert.deepEqual(resolveResourceTarget("https://ghe.example.com/team/project/pull/7"), {
    kind: "pull_request",
    host: "ghe.example.com",
    owner: "team",
    name: "project",
    number: 7,
  });
});

test("owner/repo#number requires an explicit issue or pull-request kind", () => {
  assert.throws(
    () => resolveResourceTarget("cli/cli#42"),
    (error: unknown) => error instanceof GhExecutionError && error.category === "validation",
  );
  assert.deepEqual(resolveResourceTarget("cli/cli#42", { kind: "issue" }), {
    kind: "issue",
    host: "github.com",
    owner: "cli",
    name: "cli",
    number: 42,
  });
  assert.deepEqual(resolveResourceTarget("cli/cli#42", { kind: "pull_request" }), {
    kind: "pull_request",
    host: "github.com",
    owner: "cli",
    name: "cli",
    number: 42,
  });
});

test("the model-facing gh_view accepts every supported URL resource kind", async () => {
  const rawTargets = [
    "https://github.com/cli/cli/issues/42",
    "https://github.com/cli/cli/pull/43",
    "https://github.com/cli/cli/commit/abc123",
    "https://github.com/cli/cli/releases/tag/v2.81.0",
    "https://github.com/cli/cli/actions/runs/100",
    "https://github.com/cli/cli/actions/runs/100/job/200",
    "https://github.com/cli/cli/blob/trunk/README.md",
    "https://github.com/cli/cli/tree/trunk/docs",
    "https://github.com/cli/cli/compare/main...feature",
  ];
  const loaded = loadExtension({ executor: scriptedExecutor().execute });
  const tool = loaded.tools.get("gh_view");
  assert.ok(tool);
  for (const target of rawTargets) {
    const result = await callView(tool, { target });
    assert.equal((result.details as { kind: string }).kind, resolveResourceTarget(target).kind);
  }
});

test("gh_view rejects unsupported and mismatched targets", () => {
  assert.throws(() => resolveResourceTarget("https://github.com/cli"), /Unsupported GitHub URL path/);
  assert.throws(() => resolveResourceTarget("https://github.com/cli/cli/issues/1", { kind: "pull_request" }), /does not match/);
  assert.throws(() => resolveResourceTarget("https://github.com/cli/cli/unknown/1"), /Unsupported GitHub URL path/);
  assert.deepEqual(resolveResourceTarget(undefined), { kind: "current_checkout" });
});
