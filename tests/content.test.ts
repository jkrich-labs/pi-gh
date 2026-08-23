import assert from "node:assert/strict";
import { test } from "node:test";
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
