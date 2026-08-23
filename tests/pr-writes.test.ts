import assert from "node:assert/strict";
import { test } from "node:test";
import { GhExecutionError } from "../extensions/gh/index.ts";
import { createFakeExecutor, loadExtension, projectionOf, toolCtx } from "./helpers.ts";

function load(name: string, response = "https://github.com/cli/cli/pull/12\n", confirm?: () => Promise<boolean>) {
  const executor = createFakeExecutor((request) => request.argv[0] === "--version"
    ? { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false }
    : { stdout: response, stderr: "", code: 0, killed: false });
  const loaded = loadExtension({ executor: executor.execute, confirm });
  const tool = loaded.tools.get(name);
  assert.ok(tool, `${name} must be registered`);
  return { executor, tool };
}

test("pull-request writes preserve create fields and exact metadata argv", async () => {
  const create = load("gh_create_pull_request");
  await create.tool.execute("pr-create", { repo: "cli/cli", title: "Feature", body: "body", head: "feature", base: "main", draft: true, reviewers: ["alice"], assignees: ["bob"], labels: ["enhancement"] }, undefined, undefined, toolCtx() as never);
  assert.deepEqual(create.executor.calls[1]?.argv, ["pr", "create", "--repo", "cli/cli", "--title", "Feature", "--body", "body", "--head", "feature", "--base", "main", "--draft", "--reviewer", "alice", "--assignee", "bob", "--label", "enhancement"]);

  const edit = load("gh_edit_pull_request");
  await edit.tool.execute("pr-edit", { target: "https://github.com/cli/cli/pull/12", title: "Updated", body: "new body", base: "develop", draft: false, reviewers: ["alice"], assignees: ["bob"], labels: ["bug"] }, undefined, undefined, toolCtx() as never);
  assert.deepEqual(edit.executor.calls[1]?.argv, ["pr", "edit", "12", "--repo", "cli/cli", "--title", "Updated", "--body", "new body", "--base", "develop", "--ready", "--add-reviewer", "alice", "--add-assignee", "bob", "--add-label", "bug"]);
});

test("pull-request comment, review, close, reopen, merge, and branch update use exact tools", async () => {
  const comment = load("gh_comment_pull_request");
  await comment.tool.execute("pr-comment", { target: "cli/cli#12", body: "comment" }, undefined, undefined, toolCtx() as never);
  assert.deepEqual(comment.executor.calls[1]?.argv, ["pr", "comment", "12", "--repo", "cli/cli", "--body", "comment"]);

  const review = load("gh_review_pull_request", "reviewed\n", async () => true);
  await review.tool.execute("pr-review", { target: "https://github.com/cli/cli/pull/12", event: "approve", body: "LGTM" }, undefined, undefined, toolCtx() as never);
  assert.deepEqual(review.executor.calls[1]?.argv, ["pr", "review", "12", "--repo", "cli/cli", "--approve", "--body", "LGTM"]);

  const close = load("gh_close_pull_request", "closed\n", async () => true);
  await close.tool.execute("pr-close", { target: "https://github.com/cli/cli/pull/12" }, undefined, undefined, toolCtx() as never);
  assert.deepEqual(close.executor.calls[1]?.argv, ["pr", "close", "12", "--repo", "cli/cli"]);

  const reopen = load("gh_reopen_pull_request", "reopened\n");
  await reopen.tool.execute("pr-reopen", { target: "https://github.com/cli/cli/pull/12" }, undefined, undefined, toolCtx() as never);
  assert.deepEqual(reopen.executor.calls[1]?.argv, ["pr", "reopen", "12", "--repo", "cli/cli"]);

  const merge = load("gh_merge_pull_request", "merged\n", async () => true);
  const merged = await merge.tool.execute("pr-merge", { target: "https://github.com/cli/cli/pull/12", method: "squash", deleteBranch: true }, undefined, undefined, toolCtx() as never);
  assert.equal((projectionOf(merged) as { kind: string }).kind, "pull_request_merged");
  assert.deepEqual(merge.executor.calls[1]?.argv, ["pr", "merge", "12", "--repo", "cli/cli", "--squash", "--delete-branch"]);

  const update = load("gh_update_pull_request_branch", "updated\n", async () => true);
  await update.tool.execute("pr-update", { target: "https://github.com/cli/cli/pull/12" }, undefined, undefined, toolCtx() as never);
  assert.deepEqual(update.executor.calls[1]?.argv, ["pr", "update-branch", "12", "--repo", "cli/cli"]);
});

test("pull-request writes classify conflict, mergeability, required checks, and permission failures", async () => {
  for (const [stderr, category] of [
    ["HTTP 409: conflict", "conflict"],
    ["Pull request is not mergeable", "not_mergeable"],
    ["required status checks have not passed", "required_checks"],
    ["HTTP 403: permission denied", "permission"],
  ] as const) {
    const executor = createFakeExecutor((request) => request.argv[0] === "--version"
      ? { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false }
      : { stdout: "", stderr, code: 1, killed: false });
    const loaded = loadExtension({ executor: executor.execute, confirm: async () => true });
    const tool = loaded.tools.get("gh_merge_pull_request");
    assert.ok(tool);
    await assert.rejects(
      () => tool.execute("pr-error", { target: "cli/cli#12", method: "merge" }, undefined, undefined, toolCtx() as never),
      (error: unknown) => error instanceof GhExecutionError && error.category === category,
    );
  }
});
