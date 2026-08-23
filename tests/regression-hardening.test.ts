import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { test } from "node:test";
import { buildViewArgv, createSecureTempOutput, estimateProjectionTokens, projectResource } from "../extensions/gh/execute.ts";
import { GhExecutionError, resolveResourceTarget } from "../extensions/gh/index.ts";
import { createFakeExecutor, loadExtension, projectionOf, toolCtx } from "./helpers.ts";

function version() {
  return { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false };
}

function json(value: unknown) {
  return { stdout: JSON.stringify(value), stderr: "", code: 0, killed: false };
}

function viewTool(response: unknown) {
  const executor = createFakeExecutor((request) => request.argv[0] === "--version" ? version() : json(response));
  const loaded = loadExtension({ executor: executor.execute });
  const tool = loaded.tools.get("gh_view");
  assert.ok(tool);
  return { executor, tool };
}

test("gh_view tree requests a recursive tree and filters nested entries to its path", async () => {
  const { executor, tool } = viewTool({
    sha: "root",
    truncated: false,
    tree: [
      { path: "README.md", type: "blob", sha: "root-file", size: 10 },
      { path: "docs", type: "tree", sha: "docs-tree" },
      { path: "docs/guide.md", type: "blob", sha: "guide", size: 20 },
      { path: "docs/nested/example.md", type: "blob", sha: "nested", size: 30 },
    ],
  });
  const result = await tool.execute("tree", { target: "https://github.com/cli/cli/tree/trunk/docs" }, undefined, undefined, toolCtx() as never);
  const projection = projectionOf(result) as { kind: string; path: string; entries: Array<{ path: string }>; data?: unknown };
  assert.equal(projection.kind, "tree");
  assert.equal(projection.path, "docs");
  assert.deepEqual(projection.entries.map((entry) => entry.path), ["docs/guide.md", "docs/nested/example.md"]);
  assert.equal(projection.data, undefined);
  const request = executor.calls.find((call) => call.argv[0] === "api");
  assert.ok(request);
  assert.ok(request.argv.includes("repos/cli/cli/git/trees/trunk?recursive=1"));
  assert.equal(request.argv.some((arg) => arg.includes("path=")), false);
});

test("gh_view commit uses a compact explicit commit projection", async () => {
  const { tool } = viewTool({
    sha: "abc123",
    html_url: "https://github.com/cli/cli/commit/abc123",
    commit: {
      message: "Fix projection\n\nKeep only useful metadata.",
      author: { name: "Ada", email: "ada@example.test", date: "2026-01-01T00:00:00Z" },
      committer: { name: "Lin", date: "2026-01-01T01:00:00Z" },
      verification: { verified: true, reason: "valid" },
    },
    author: { login: "ada" },
    committer: { login: "lin" },
    parents: [{ sha: "parent1", html_url: "https://github.com/cli/cli/commit/parent1" }],
    stats: { total: 3, additions: 2, deletions: 1 },
    files: [{ filename: "ignored-in-compact" }],
  });
  const result = await tool.execute("commit", { target: "https://github.com/cli/cli/commit/abc123" }, undefined, undefined, toolCtx() as never);
  const projection = projectionOf(result) as Record<string, unknown>;
  assert.equal(projection.kind, "commit");
  assert.equal(projection.sha, "abc123");
  assert.equal(projection.message, "Fix projection\n\nKeep only useful metadata.");
  assert.deepEqual(projection.author, { login: "ada", name: "Ada", date: "2026-01-01T00:00:00Z" });
  assert.deepEqual(projection.parentShas, ["parent1"]);
  assert.deepEqual(projection.stats, { total: 3, additions: 2, deletions: 1 });
  assert.equal(projection.data, undefined);
  assert.equal("files" in projection, false);
});

test("gh_view compare uses compact commit and file previews", async () => {
  const { tool } = viewTool({
    status: "ahead",
    ahead_by: 2,
    behind_by: 1,
    total_commits: 2,
    html_url: "https://github.com/cli/cli/compare/main...feature",
    base_commit: { sha: "base", commit: { message: "Base", author: { name: "Base author", date: "2026-01-01T00:00:00Z" } } },
    merge_base_commit: { sha: "merge", commit: { message: "Merge base", author: { name: "Merger", date: "2026-01-01T00:00:00Z" } } },
    commits: [
      { sha: "one", html_url: "https://example.test/one", commit: { message: "First", author: { name: "Ada", date: "2026-01-02T00:00:00Z" } } },
      { sha: "two", commit: { message: "Second", author: { name: "Lin", date: "2026-01-03T00:00:00Z" } } },
    ],
    files: [{ filename: "src/index.ts", status: "modified", additions: 2, deletions: 1, changes: 3, patch: "large patch omitted" }],
  });
  const result = await tool.execute("compare", { target: "https://github.com/cli/cli/compare/main...feature" }, undefined, undefined, toolCtx() as never);
  const projection = projectionOf(result) as Record<string, unknown>;
  assert.equal(projection.kind, "compare");
  assert.equal(projection.aheadBy, 2);
  assert.equal(projection.behindBy, 1);
  assert.equal(projection.baseSha, "base");
  assert.deepEqual((projection.commits as Array<Record<string, unknown>>).map((commit) => commit.sha), ["one", "two"]);
  assert.deepEqual(projection.files, [{ filename: "src/index.ts", status: "modified", additions: 2, deletions: 1, changes: 3 }]);
  assert.equal(projection.data, undefined);
});

test("gh_view expanded issue, pull request, and release projections include their useful fields", async () => {
  const cases = [
    {
      target: "https://github.com/cli/cli/issues/7",
      raw: { number: 7, title: "Issue", state: "OPEN", body: "Issue body", comments: [{ body: "A comment", author: { login: "ada" }, createdAt: "2026-01-01T00:00:00Z" }] },
      expected: "Issue body",
    },
    {
      target: "https://github.com/cli/cli/pull/8",
      raw: { number: 8, title: "Pull request", state: "OPEN", body: "Pull body", changedFiles: 1, commits: [{ oid: "abc", messageHeadline: "Commit" }], files: [{ path: "src/index.ts", additions: 1, deletions: 0 }] },
      expected: "Pull body",
    },
    {
      target: "https://github.com/cli/cli/releases/tag/v1",
      raw: { name: "v1", tagName: "v1", body: "Release notes", targetCommitish: "trunk", assets: [{ name: "pi-gh.tgz", size: 12, downloadUrl: "https://example.test/asset" }] },
      expected: "Release notes",
    },
  ];
  for (const fixture of cases) {
    const { executor, tool } = viewTool(fixture.raw);
    const result = await tool.execute("expanded", { target: fixture.target, detail: "expanded" }, undefined, undefined, toolCtx() as never);
    const projection = projectionOf(result) as Record<string, unknown>;
    assert.equal(projection.body, fixture.expected);
    assert.equal(projection.data, undefined);
    const request = executor.calls.find((call) => call.argv.includes("--json"));
    assert.ok(request);
    assert.ok(request.argv[request.argv.indexOf("--json") + 1]?.includes("body"));
  }
});

test("common pull-request subroutes normalize only one segment while comment and review anchors are rejected", () => {
  assert.deepEqual(resolveResourceTarget("https://github.com/cli/cli/pull/42/files"), {
    kind: "pull_request", host: "github.com", owner: "cli", name: "cli", number: 42,
  });
  assert.deepEqual(resolveResourceTarget("https://github.com/cli/cli/pull/42/commits"), {
    kind: "pull_request", host: "github.com", owner: "cli", name: "cli", number: 42,
  });
  for (const target of [
    "https://github.com/cli/cli/issues/42#issuecomment-123",
    "https://github.com/cli/cli/pull/42#issuecomment-123",
    "https://github.com/cli/cli/pull/42#discussion_r123",
    "https://github.com/cli/cli/pull/42#pullrequestreview-123",
    "https://github.com/cli/cli/pull/42#pullrequestreviewcomment-123",
    "https://github.com/cli/cli/pull/42#commitcomment-123",
    "https://github.com/cli/cli/issues/42#issuecomment%2D123",
    "https://github.com/cli/cli/pull/42#discussion%5Fr123",
  ]) {
    assert.throws(
      () => resolveResourceTarget(target),
      (error: unknown) => error instanceof GhExecutionError && error.category === "validation" && /(?:comment|review) anchor/i.test(error.message),
    );
  }
  assert.throws(
    () => resolveResourceTarget("https://github.com/cli/cli/pull/42/files/changed"),
    (error: unknown) => error instanceof GhExecutionError && error.category === "unsupported",
  );
});

test("expanded pull-request status checks preserve check-run and status-context shapes", async () => {
  const { tool } = viewTool({
    number: 8,
    title: "Pull request",
    state: "OPEN",
    statusCheckRollup: [
      {
        __typename: "CheckRun",
        name: "build",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        detailsUrl: "https://example.test/build",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:02:00Z",
        workflowName: "CI",
      },
      {
        __typename: "StatusContext",
        context: "codecov/project",
        state: "SUCCESS",
        targetUrl: "https://example.test/codecov",
        createdAt: "2026-01-01T00:03:00Z",
        description: "Coverage passed",
      },
    ],
  });
  const result = await tool.execute("status-rollup", { target: "https://github.com/cli/cli/pull/8", detail: "expanded" }, undefined, undefined, toolCtx() as never);
  const projection = projectionOf(result) as Record<string, unknown>;
  assert.equal(projection.statusCheckCount, 2);
  assert.equal(projection.statusChecksTruncated, false);
  assert.equal(projection.listsTruncated, false);
  assert.deepEqual(projection.statusChecks, [
    {
      __typename: "CheckRun",
      name: "build",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      detailsUrl: "https://example.test/build",
      startedAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-01T00:02:00Z",
      workflowName: "CI",
    },
    {
      __typename: "StatusContext",
      context: "codecov/project",
      state: "SUCCESS",
      targetUrl: "https://example.test/codecov",
      createdAt: "2026-01-01T00:03:00Z",
      description: "Coverage passed",
    },
  ]);
});

test("expanded pull-request status checks report bounded counts and aggregate truncation", async () => {
  const { tool } = viewTool({
    number: 8,
    title: "Pull request",
    state: "OPEN",
    statusCheckRollup: Array.from({ length: 26 }, (_, index) => ({
      __typename: "CheckRun",
      name: `check-${index}`,
      status: "COMPLETED",
      conclusion: "SUCCESS",
    })),
  });
  const result = await tool.execute("status-rollup-limit", { target: "https://github.com/cli/cli/pull/8", detail: "expanded" }, undefined, undefined, toolCtx() as never);
  const projection = projectionOf(result) as Record<string, unknown>;
  assert.equal(projection.statusCheckCount, 26);
  assert.equal((projection.statusChecks as unknown[]).length, 25);
  assert.equal(projection.statusChecksTruncated, true);
  assert.equal(projection.listsTruncated, true);
});

test("CI tools report malformed GHES authentication output with host context", async () => {
  const executor = createFakeExecutor((request) => request.argv[0] === "--version"
    ? version()
    : { stdout: "{", stderr: "", code: 0, killed: false });
  const { tools } = loadExtension({ executor: executor.execute });
  const tool = tools.get("gh_view_workflow_run");
  assert.ok(tool);
  await assert.rejects(
    () => tool.execute(
      "ci-auth-malformed",
      { target: "https://ghe/team/project/actions/runs/100" },
      undefined,
      undefined,
      toolCtx() as never,
    ),
    (error: unknown) => error instanceof GhExecutionError
      && error.category === "malformed_json"
      && /checking authentication.*ghe/i.test(error.message),
  );
});

test("malformed view and CI projections name their requested resource", async () => {
  const cases = [
    ["gh_view", { target: "https://github.com/cli/cli/issues/7" }, {}, /cli\/cli issue #7/i],
    ["gh_view_job", { target: "https://github.com/cli/cli/actions/runs/100/job/200" }, {}, /cli\/cli job 200 \(run 100\)/i],
  ] as const;
  for (const [name, params, response, context] of cases) {
    const executor = createFakeExecutor((request) => request.argv[0] === "--version" ? version() : json(response));
    const { tools } = loadExtension({ executor: executor.execute });
    const tool = tools.get(name);
    assert.ok(tool);
    await assert.rejects(
      () => tool.execute("malformed-context", params, undefined, undefined, toolCtx() as never),
      (error: unknown) => error instanceof GhExecutionError
        && error.category === "malformed_json"
        && context.test(error.message),
    );
  }
});

test("binary files expose metadata without base64 content", async () => {
  const bytes = Buffer.from([0, 255, 1, 2]);
  const { tool } = viewTool({ type: "file", encoding: "base64", content: bytes.toString("base64"), size: bytes.length, sha: "blob-sha" });
  const result = await tool.execute("binary", { target: "https://github.com/cli/cli/blob/trunk/image.png" }, undefined, undefined, toolCtx() as never);
  const projection = projectionOf(result) as Record<string, unknown>;
  assert.equal(projection.binary, true);
  assert.equal(projection.byteCount, bytes.length);
  assert.equal(projection.sha, "blob-sha");
  assert.equal("content" in projection, false);
  assert.equal("contentBase64" in projection, false);
});

test("binary file views reject malformed contents shapes contextually", async () => {
  for (const raw of [
    {},
    null,
    [],
    "not a file object",
    7,
    { type: "file", encoding: "base64", content: "%%%", size: 3 },
    { type: "file", encoding: "base64", content: "A===", size: 1 },
    { type: "file", encoding: "base64", content: "Y WJj", size: 3 },
  ]) {
    const { tool } = viewTool(raw);
    await assert.rejects(
      () => tool.execute("invalid-file", { target: "https://github.com/cli/cli/blob/trunk/README.md" }, undefined, undefined, toolCtx() as never),
      (error: unknown) => error instanceof GhExecutionError
        && error.category === "malformed_json"
        && /GitHub file contents JSON/i.test(error.message),
    );
  }
});

test("projectResource rejects invalid top-level and incompatible resource shapes", () => {
  const issue = resolveResourceTarget("https://github.com/cli/cli/issues/7");
  const repository = resolveResourceTarget("cli/cli");
  for (const raw of [null, [], "not an object", 7, {}]) {
    assert.throws(
      () => projectResource(raw, issue),
      (error: unknown) => error instanceof GhExecutionError && error.category === "malformed_json",
    );
    assert.throws(
      () => projectResource(raw, repository),
      (error: unknown) => error instanceof GhExecutionError && error.category === "malformed_json",
    );
  }
  assert.throws(
    () => projectResource({ number: "7", title: "Issue", state: "OPEN" }, issue),
    (error: unknown) => error instanceof GhExecutionError && error.category === "malformed_json",
  );
  assert.throws(
    () => projectResource({ sha: "root", tree: {} }, resolveResourceTarget("https://github.com/cli/cli/tree/trunk")),
    (error: unknown) => error instanceof GhExecutionError && error.category === "malformed_json",
  );
});

test("secure spill files recursively redact JSON keys and values without corrupting JSON", async () => {
  const token = "ghp_exampleSecretTokenValue1234567890";
  const written = await createSecureTempOutput().write(JSON.stringify({
    [`token=${token}`]: "outer value",
    [token]: "second secret-key value",
    "[redacted]": "literal redacted-key value",
    nested: { [token]: { credential: `access_token=${token}` } },
  }));
  try {
    const contents = await readFile(written.path, "utf8");
    assert.deepEqual(JSON.parse(contents), {
      "[redacted]": "outer value",
      "[redacted]#2": "second secret-key value",
      "[redacted]#3": "literal redacted-key value",
      nested: { "[redacted]": { credential: "[redacted]" } },
    });
    assert.equal(contents.includes(token), false);
  } finally {
    await rm(written.path, { force: true });
    await rm(written.path.slice(0, written.path.lastIndexOf("/")), { recursive: true, force: true });
  }
});

test("truncated tree sources expose returned partial counts without claiming totals", async () => {
  const { tool } = viewTool({
    sha: "root",
    truncated: true,
    tree: [
      { path: "docs/guide.md", type: "blob", sha: "guide" },
      { path: "docs/nested/example.md", type: "blob", sha: "nested" },
      { path: "README.md", type: "blob", sha: "readme" },
    ],
  });
  const result = await tool.execute("truncated-tree", { target: "https://github.com/cli/cli/tree/trunk/docs" }, undefined, undefined, toolCtx() as never);
  const projection = projectionOf(result) as Record<string, unknown>;
  assert.equal(projection.sourceTruncated, true);
  assert.equal(projection.returnedEntryCount, 3);
  assert.equal(projection.returnedMatchingEntryCount, 2);
  assert.equal(projection.entryCount, 2);
  assert.equal("totalEntryCount" in projection, false);
  assert.equal("matchingEntryCount" in projection, false);
});

test("oversized tree targets compact identifiers to the final token budget", async () => {
  const path = "very-long-tree-segment/".repeat(2_000);
  const { tool } = viewTool({ sha: "root", tree: [] });
  const result = await tool.execute(
    "tree-budget",
    { target: `https://github.com/cli/cli/tree/trunk/${path}` },
    undefined,
    undefined,
    toolCtx() as never,
  );
  const projection = projectionOf(result) as Record<string, unknown>;
  assert.equal(projection.truncated, true);
  assert.ok(estimateProjectionTokens(JSON.stringify(projection)) <= 2_000);
  assert.ok(!projection.target || JSON.stringify(projection.target).length < 1_000);
});

test("compare targets preserve slash-containing head refs without discarding path segments", () => {
  for (const target of [
    resolveResourceTarget("https://github.com/cli/cli/compare/main...feature/with/slash"),
    resolveResourceTarget("https://github.com/cli/cli/compare/main...feature%2Fwith%2Fslash"),
  ]) {
    assert.equal(target.kind, "compare");
    if (target.kind !== "compare") assert.fail("expected a compare target");
    assert.equal(target.base, "main");
    assert.equal(target.head, "feature/with/slash");
    assert.ok(buildViewArgv(target).includes("repos/cli/cli/compare/main...feature%2Fwith%2Fslash"));
  }
});

test("bounded expanded lists retain a secure full-output fallback", async () => {
  const { tool } = viewTool({
    number: 7,
    title: "Issue with many small comments",
    state: "OPEN",
    body: "small body",
    comments: Array.from({ length: 26 }, (_, index) => ({ body: `comment-${index}` })),
  });
  const result = await tool.execute(
    "bounded-list-fallback",
    { target: "https://github.com/cli/cli/issues/7", detail: "expanded" },
    undefined,
    undefined,
    toolCtx() as never,
  );
  const projection = projectionOf(result) as Record<string, unknown>;
  assert.equal(projection.commentCount, 26);
  assert.equal((projection.comments as unknown[]).length, 25);
  assert.equal(projection.commentsTruncated, true);
  assert.equal(projection.truncated, true);
  assert.match(String(projection.fullPath), /pi-gh-/);
});

test("oversized resource spills retain numeric resource counts", async () => {
  const { tool } = viewTool({
    number: 7,
    title: "Large issue",
    state: "OPEN",
    body: "large body ".repeat(20_000),
    comments: Array.from({ length: 31 }, (_, index) => ({ body: `comment-${index}` })),
  });
  const result = await tool.execute(
    "resource-count-spill",
    { target: "https://github.com/cli/cli/issues/7", detail: "expanded" },
    undefined,
    undefined,
    toolCtx() as never,
  );
  const projection = projectionOf(result) as Record<string, unknown>;
  assert.equal(projection.truncated, true);
  assert.equal(projection.commentCount, 31);
  assert.ok(estimateProjectionTokens(JSON.stringify(projection)) <= 8_000);
});

test("oversized projections spill to readable secure JSON with a bounded preview", async () => {
  const temp = createSecureTempOutput();
  const written = await temp.write(JSON.stringify({ description: "large value" }));
  try {
    const contents = await readFile(written.path, "utf8");
    assert.match(contents, /\n  "description": "large value"\n/);
  } finally {
    await rm(written.path, { force: true });
    await rm(written.path.slice(0, written.path.lastIndexOf("/")), { recursive: true, force: true });
  }

  const secret = "unrecognised-long-lived-secret-1234567890";
  let nestedSecret = `Authorization\\u003A\\u0020Bearer\\u0020${secret}`;
  for (let depth = 0; depth < 10; depth += 1) nestedSecret = nestedSecret.replaceAll("\\", "\\u005c");
  const executor = createFakeExecutor((request) => request.argv[0] === "--version"
    ? version()
    : json({ name: "cli", nameWithOwner: "cli/cli", description: `${nestedSecret}\n${"x".repeat(20_000)}` }));
  const loaded = loadExtension({
    executor: executor.execute,
    tempOutput: { async write() { return { path: "/tmp/pi-gh-private/full-output" }; } },
  });
  const tool = loaded.tools.get("gh_view");
  assert.ok(tool);
  const result = await tool.execute("spill", { target: "cli/cli" }, undefined, undefined, toolCtx() as never);
  const projection = projectionOf(result) as Record<string, unknown>;
  assert.equal(projection.truncated, true);
  assert.equal(typeof projection.preview, "string");
  assert.doesNotMatch(JSON.stringify(projection), new RegExp(secret));
  assert.match(JSON.stringify(projection), /\[redacted\]/);
  assert.ok((projection.preview as string).length <= 1_000);
  assert.ok(estimateProjectionTokens(JSON.stringify(projection)) <= 2_000);
});
