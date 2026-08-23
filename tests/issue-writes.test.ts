import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakeExecutor, loadExtension, projectionOf, toolCtx } from "./helpers.ts";

function load(name: string, confirm?: () => Promise<boolean>) {
  const executor = createFakeExecutor((request) => request.argv[0] === "--version"
    ? { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false }
    : { stdout: "https://github.com/cli/cli/issues/42\n", stderr: "", code: 0, killed: false });
  const loaded = loadExtension({ executor: executor.execute, confirm });
  const tool = loaded.tools.get(name);
  assert.ok(tool, `${name} must be registered`);
  return { executor, tool };
}

test("issue write tools create, comment, edit metadata, assign, and label with exact argv", async () => {
  const create = load("gh_create_issue");
  const created = await create.tool.execute("issue-create", { repo: "cli/cli", title: "Bug", body: "line 1\nline 2", assignees: ["alice"], labels: ["bug", "urgent"] }, undefined, undefined, toolCtx() as never);
  assert.equal((projectionOf(created) as { output: string }).output, "https://github.com/cli/cli/issues/42");
  assert.deepEqual(create.executor.calls[1]?.argv, ["issue", "create", "--repo", "cli/cli", "--title", "Bug", "--body", "line 1\nline 2", "--assignee", "alice", "--label", "bug", "--label", "urgent"]);

  const comment = load("gh_comment_issue");
  await comment.tool.execute("issue-comment", { target: "https://github.com/cli/cli/issues/42", body: "hello @alice; echo $HOME" }, undefined, undefined, toolCtx() as never);
  assert.deepEqual(comment.executor.calls[1]?.argv, ["issue", "comment", "42", "--repo", "cli/cli", "--body", "hello @alice; echo $HOME"]);

  const edit = load("gh_edit_issue");
  await edit.tool.execute("issue-edit", { target: "cli/cli#42", title: "Updated", body: "quoted \"body\"", assignees: ["alice"], labels: ["bug"] }, undefined, undefined, toolCtx() as never);
  assert.deepEqual(edit.executor.calls[1]?.argv, ["issue", "edit", "42", "--repo", "cli/cli", "--title", "Updated", "--body", "quoted \"body\"", "--add-assignee", "alice", "--add-label", "bug"]);
});

test("issue reopen and guarded close return stable mutation projections", async () => {
  const reopen = load("gh_reopen_issue");
  const reopened = await reopen.tool.execute("issue-reopen", { target: "https://github.com/cli/cli/issues/42" }, undefined, undefined, toolCtx() as never);
  assert.deepEqual(projectionOf(reopened), { kind: "issue_reopened", target: { kind: "issue", host: "github.com", owner: "cli", name: "cli", number: 42 }, output: "https://github.com/cli/cli/issues/42" });

  const close = load("gh_close_issue", async () => true);
  const closed = await close.tool.execute("issue-close", { target: "https://github.com/cli/cli/issues/42" }, undefined, undefined, toolCtx() as never);
  assert.deepEqual(projectionOf(closed), { kind: "issue_closed", target: { kind: "issue", host: "github.com", owner: "cli", name: "cli", number: 42 }, output: "https://github.com/cli/cli/issues/42" });
});
