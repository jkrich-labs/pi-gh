import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateProjectionTokens } from "../extensions/gh/execute.ts";
import { GhExecutionError } from "../extensions/gh/index.ts";
import { createFakeExecutor, loadExtension, projectionOf, toolCtx } from "./helpers.ts";

function version() {
  return { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false };
}

function json(stdout: unknown) {
  return { stdout: JSON.stringify(stdout), stderr: "", code: 0, killed: false };
}

function load(name: string, handler: (argv: string[]) => ReturnType<typeof json> | { stdout: string; stderr: string; code: number; killed: boolean }) {
  const executor = createFakeExecutor((request) => {
    if (request.argv[0] === "--version") return version();
    return handler(request.argv);
  });
  const loaded = loadExtension({ executor: executor.execute });
  const tool = loaded.tools.get(name);
  assert.ok(tool, `${name} must be registered`);
  return { executor, tool };
}

test("gh_read_file reads text at an explicit ref", async () => {
  const { executor, tool } = load("gh_read_file", () =>
    json({ type: "file", encoding: "base64", content: Buffer.from("hello world", "utf8").toString("base64"), size: 11 }),
  );
  const result = await tool.execute(
    "file-1",
    { repo: "cli/cli", path: "README.md", ref: "trunk" },
    undefined,
    undefined,
    toolCtx() as never,
  );
  const projection = projectionOf(result) as Record<string, unknown>;
  assert.equal(projection.kind, "file");
  assert.equal(projection.path, "README.md");
  assert.equal(projection.ref, "trunk");
  assert.equal(projection.content, "hello world");
  const request = executor.calls.find((call) => call.argv[0] === "api");
  assert.ok(request);
  assert.ok(request.argv.includes("repos/cli/cli/contents/README.md"));
  assert.ok(request.argv.includes("--method") && request.argv.includes("GET"));
  assert.ok(request.argv.includes("ref=trunk"));
});

test("gh_list_directory returns bounded directory entries at a ref", async () => {
  const { executor, tool } = load("gh_list_directory", () =>
    json([
      { name: "src", path: "src", type: "dir", size: 0, sha: "one" },
      { name: "README.md", path: "README.md", type: "file", size: 11, sha: "two" },
    ]),
  );
  const result = await tool.execute(
    "dir-1",
    { repo: "cli/cli", path: "docs", ref: "trunk", limit: 1 },
    undefined,
    undefined,
    toolCtx() as never,
  );
  const projection = projectionOf(result) as { kind: string; path: string; entries: Array<{ name: string }> };
  assert.equal(projection.kind, "directory");
  assert.equal(projection.path, "docs");
  assert.deepEqual(projection.entries.map((entry) => entry.name), ["src"]);
  const request = executor.calls.find((call) => call.argv[0] === "api");
  assert.ok(request);
  assert.ok(request.argv.includes("repos/cli/cli/contents/docs"));
});

test("gh_pr_files reads pull-request files and gh_pr_diff preserves diff text", async () => {
  const files = [{ filename: "src/index.ts", status: "modified", additions: 2, deletions: 1, changes: 3, sha: "abc" }];
  const filesCall = load("gh_pr_files", () => json(files));
  const filesResult = await filesCall.tool.execute(
    "pr-files-1",
    { target: "https://github.com/cli/cli/pull/12", limit: 4, page: 2 },
    undefined,
    undefined,
    toolCtx() as never,
  );
  const fileProjection = projectionOf(filesResult) as { kind: string; files: unknown[]; page: number };
  assert.equal(fileProjection.kind, "pull_request_files");
  assert.deepEqual(fileProjection.files, files);
  assert.equal(fileProjection.page, 2);
  const filesRequest = filesCall.executor.calls.find((call) => call.argv[0] === "api");
  assert.ok(filesRequest);
  assert.ok(filesRequest.argv.includes("repos/cli/cli/pulls/12/files"));
  assert.ok(filesRequest.argv.includes("per_page=4"));
  assert.ok(filesRequest.argv.includes("page=2"));

  const diff = "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n";
  const diffCall = load("gh_pr_diff", () => ({ stdout: diff, stderr: "", code: 0, killed: false }));
  const diffResult = await diffCall.tool.execute(
    "pr-diff-1",
    { target: "https://github.com/cli/cli/pull/12" },
    undefined,
    undefined,
    toolCtx() as never,
  );
  const diffProjection = projectionOf(diffResult) as { kind: string; diff: string; fileCount: number };
  assert.equal(diffProjection.kind, "pull_request_diff");
  assert.equal(diffProjection.diff, diff);
  assert.equal(diffProjection.fileCount, 1);
  const diffRequest = diffCall.executor.calls.find((call) => call.argv[0] === "pr");
  assert.deepEqual(diffRequest?.argv.slice(0, 5), ["pr", "diff", "12", "--repo", "cli/cli"]);
});

test("gh_read_file identifies binary responses without decoding them as text", async () => {
  const bytes = Buffer.from([0, 255, 1, 2]);
  const { tool } = load("gh_read_file", () =>
    json({ type: "file", encoding: "base64", content: bytes.toString("base64"), size: bytes.length }),
  );
  const result = await tool.execute(
    "file-binary",
    { repo: "cli/cli", path: "image.png", ref: "trunk" },
    undefined,
    undefined,
    toolCtx() as never,
  );
  const projection = projectionOf(result) as Record<string, unknown>;
  assert.equal(projection.binary, true);
  assert.equal(projection.byteCount, bytes.length);
  assert.equal("content" in projection, false);
  assert.equal("contentBase64" in projection, false);
});

test("content tools reject unsafe repository paths before invoking gh", async () => {
  const { executor, tool } = load("gh_read_file", () => json({}));
  for (const path of ["../secret", "/absolute/path", "src/../../secret", "src\\secret", "src/\u0000file"]) {
    await assert.rejects(
      () => tool.execute("unsafe", { repo: "cli/cli", path }, undefined, undefined, toolCtx() as never),
      (error: unknown) => error instanceof GhExecutionError && error.category === "validation",
    );
  }
  assert.equal(executor.calls.some((call) => call.argv[0] === "api"), false);
});

test("gh_list_releases returns bounded paged compact and expanded release projections", async () => {
  const releases = [
    {
      id: 1,
      name: "v2.0.0",
      tag_name: "v2.0.0",
      draft: false,
      prerelease: false,
      published_at: "2026-01-02T00:00:00Z",
      created_at: "2026-01-01T00:00:00Z",
      html_url: "https://github.com/cli/cli/releases/tag/v2.0.0",
      author: { login: "maintainer" },
      body: "Release notes ghp_exampleSecret",
      target_commitish: "trunk",
      immutable: false,
      assets: [{ name: "cli.tgz", size: 12, content_type: "application/gzip", browser_download_url: "https://example.test/cli.tgz" }],
    },
    { id: 2, name: "v1.0.0", tag_name: "v1.0.0", draft: false, prerelease: false },
  ];
  const { executor, tool } = load("gh_list_releases", () => json(releases));
  const compact = projectionOf(await tool.execute(
    "releases-compact",
    { repo: "cli/cli", limit: 1, page: 2 },
    undefined,
    undefined,
    toolCtx() as never,
  )) as Record<string, unknown>;
  assert.equal(compact.kind, "releases");
  assert.equal(compact.page, 2);
  assert.equal(compact.limit, 1);
  assert.equal(compact.releaseCount, 1);
  assert.equal((compact.releases as Array<Record<string, unknown>>)[0]?.tagName, "v2.0.0");
  assert.equal("body" in (compact.releases as Array<Record<string, unknown>>)[0]!, false);
  const request = executor.calls.find((call) => call.argv[0] === "api");
  assert.deepEqual(request?.argv, [
    "api", "repos/cli/cli/releases", "--method", "GET", "--field", "per_page=1", "--field", "page=2",
  ]);

  const expanded = projectionOf(await tool.execute(
    "releases-expanded",
    { repo: "cli/cli", limit: 1, detail: "expanded" },
    undefined,
    undefined,
    toolCtx() as never,
  )) as Record<string, unknown>;
  const release = (expanded.releases as Array<Record<string, unknown>>)[0]!;
  assert.equal(release.body, "Release notes [redacted]");
  assert.deepEqual(release.assets, [{ name: "cli.tgz", size: 12, contentType: "application/gzip", downloadUrl: "https://example.test/cli.tgz" }]);
});

test("gh_list_releases reports malformed output with release context and keeps expanded output budgeted", async () => {
  const malformed = load("gh_list_releases", () => ({ stdout: "{", stderr: "", code: 0, killed: false }));
  await assert.rejects(
    () => malformed.tool.execute("bad-releases", { repo: "cli/cli" }, undefined, undefined, toolCtx() as never),
    (error: unknown) => error instanceof GhExecutionError
      && error.category === "malformed_json"
      && /listing releases.*cli\/cli/i.test(error.message),
  );

  const oversized = load("gh_list_releases", () => json([{
    name: "v1", tag_name: "v1", body: "notes ".repeat(20_000), assets: [],
  }]));
  const result = await oversized.tool.execute(
    "large-releases",
    { repo: "cli/cli", detail: "expanded" },
    undefined,
    undefined,
    toolCtx() as never,
  );
  const projection = projectionOf(result) as Record<string, unknown>;
  assert.equal(projection.truncated, true);
  assert.ok(estimateProjectionTokens(JSON.stringify(projection)) <= 8_000);
});

test("focused reads redact token-shaped resource targets from content and details", async () => {
  const token = "ghp_exampleSecretTokenValue1234567890";
  for (const [name, params] of [
    ["gh_list_releases", { repo: `cli/${token}` }],
    ["gh_issue_comments", { target: `cli/${token}#7` }],
  ] as const) {
    const { tool } = load(name, () => json([]));
    const result = await tool.execute("redacted-target", params, undefined, undefined, toolCtx() as never) as {
      content: Array<{ type: string; text?: string }>;
      details?: unknown;
    };
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /ghp_/);
    assert.match(serialized, /\[redacted\]/);
  }
});

test("expanded focused reads redact token-shaped object keys", async () => {
  const token = "ghp_exampleSecretTokenValue1234567890";
  const { tool } = load("gh_issue_comments", () => json([{
    id: 10,
    body: "safe",
    reactions: { [token]: "value" },
  }]));
  const result = await tool.execute(
    "redacted-key",
    { target: "cli/cli#7", detail: "expanded" },
    undefined,
    undefined,
    toolCtx() as never,
  );
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /ghp_/);
  assert.match(serialized, /\[redacted\]/);
});

test("focused reads reject malformed array entries with resource context", async () => {
  for (const [name, params, context] of [
    ["gh_list_releases", { repo: "cli/cli" }, /listing releases.*cli\/cli/i],
    ["gh_issue_comments", { target: "cli/cli#7" }, /issue comments.*cli\/cli issue #7/i],
  ] as const) {
    const { tool } = load(name, () => json([{}]));
    await assert.rejects(
      () => tool.execute("malformed-entry", params, undefined, undefined, toolCtx() as never),
      (error: unknown) => error instanceof GhExecutionError
        && error.category === "malformed_json"
        && context.test(error.message),
    );
  }
});

test("gh_issue_comments returns bounded paged comments for an issue target", async () => {
  const comments = [
    {
      id: 10,
      body: "First ghp_exampleSecret",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T01:00:00Z",
      html_url: "https://github.com/cli/cli/issues/7#issuecomment-10",
      user: { login: "ada" },
    },
    { id: 11, body: "Second", user: { login: "lin" } },
  ];
  const { executor, tool } = load("gh_issue_comments", () => json(comments));
  const result = await tool.execute(
    "issue-comments",
    { target: "https://github.com/cli/cli/issues/7", limit: 1, page: 3 },
    undefined,
    undefined,
    toolCtx() as never,
  );
  const projection = projectionOf(result) as Record<string, unknown>;
  assert.equal(projection.kind, "issue_comments");
  assert.equal(projection.page, 3);
  assert.equal(projection.limit, 1);
  assert.equal(projection.commentCount, 1);
  assert.deepEqual(projection.comments, [{
    id: 10,
    body: "First [redacted]",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T01:00:00Z",
    url: "https://github.com/cli/cli/issues/7#issuecomment-10",
    author: { login: "ada" },
  }]);
  const request = executor.calls.find((call) => call.argv[0] === "api");
  assert.deepEqual(request?.argv, [
    "api", "repos/cli/cli/issues/7/comments", "--method", "GET", "--field", "per_page=1", "--field", "page=3",
  ]);
});
