import assert from "node:assert/strict";
import { test } from "node:test";
import { GhExecutionError } from "../extensions/gh/index.ts";
import { createFakeExecutor, loadExtension, projectionOf, toolCtx } from "./helpers.ts";

function loadClose(confirm: (title: string, message: string) => Promise<boolean>) {
  const executor = createFakeExecutor((request) => request.argv[0] === "--version"
    ? { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false }
    : { stdout: "closed\n", stderr: "", code: 0, killed: false });
  const loaded = loadExtension({ executor: executor.execute, confirm });
  const tool = loaded.tools.get("gh_close_issue");
  assert.ok(tool);
  return { executor, tool };
}

test("issue closure shows normalized target and exact effect, and decline executes nothing", async () => {
  let prompt: [string, string] | undefined;
  const { executor, tool } = loadClose(async (title, message) => {
    prompt = [title, message];
    return false;
  });
  const result = await tool.execute("guard-issue-decline", { target: "https://github.com/cli/cli/issues/42" }, undefined, undefined, toolCtx() as never);
  assert.deepEqual(projectionOf(result), { kind: "cancelled", cancelled: true, target: { kind: "issue", host: "github.com", owner: "cli", name: "cli", number: 42 }, effect: "Close issue cli/cli#42" });
  assert.equal(prompt?.[0], "Confirm GitHub write");
  assert.match(prompt?.[1] ?? "", /Close issue cli\/cli#42/);
  assert.equal(executor.calls.some((call) => call.argv[0] === "issue"), false);
});

test("pull-request guarded effects show exact target and fail closed", async () => {
  let prompt = "";
  const executor = createFakeExecutor((request) => request.argv[0] === "--version"
    ? { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false }
    : { stdout: "ok\n", stderr: "", code: 0, killed: false });
  const loaded = loadExtension({ executor: executor.execute, confirm: async (_title, message) => { prompt = message; return false; } });
  const tool = loaded.tools.get("gh_merge_pull_request");
  assert.ok(tool);
  const result = await tool.execute("guard-pr", { target: "https://github.com/cli/cli/pull/12", method: "squash" }, undefined, undefined, toolCtx() as never);
  assert.equal((projectionOf(result) as { cancelled: boolean }).cancelled, true);
  assert.match(prompt, /Merge pull request cli\/cli#12 using squash/);
  assert.equal(executor.calls.some((call) => call.argv[0] === "pr"), false);
});

test("workflow and release guarded effects decline and fail closed", async () => {
  const executor = createFakeExecutor((request) => request.argv[0] === "--version"
    ? { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false }
    : { stdout: "ok\n", stderr: "", code: 0, killed: false });
  const loaded = loadExtension({ executor: executor.execute, confirm: async () => false });
  for (const [name, params] of [
    ["gh_dispatch_workflow", { repo: "cli/cli", workflow: "build.yml" }],
    ["gh_cancel_workflow_run", { target: "https://github.com/cli/cli/actions/runs/100" }],
    ["gh_create_release", { repo: "cli/cli", tag: "v1" }],
    ["gh_delete_release", { target: "https://github.com/cli/cli/releases/tag/v1" }],
    ["gh_delete_release_asset", { target: "https://github.com/cli/cli/releases/tag/v1", asset: "app.zip" }],
  ] as const) {
    const tool = loaded.tools.get(name);
    assert.ok(tool);
    const result = await tool.execute("guard-action", params, undefined, undefined, toolCtx() as never);
    assert.equal((projectionOf(result) as { cancelled: boolean }).cancelled, true);
  }
  assert.equal(executor.calls.some((call) => ["workflow", "run", "release"].includes(call.argv[0] ?? "")), false);
  const headless = loadExtension({ executor: executor.execute, confirm: async () => true });
  const tool = headless.tools.get("gh_cancel_workflow_run");
  assert.ok(tool);
  await assert.rejects(() => tool.execute("headless-action", { target: "https://github.com/cli/cli/actions/runs/100" }, undefined, undefined, toolCtx("/tmp/checkout", false) as never), (error: unknown) => error instanceof GhExecutionError && error.category === "validation");
});

test("issue closure approval executes once and headless mode fails closed", async () => {
  let confirmations = 0;
  const approved = loadClose(async () => {
    confirmations += 1;
    return true;
  });
  await approved.tool.execute("guard-issue-approve", { target: "cli/cli#42" }, undefined, undefined, toolCtx() as never);
  assert.equal(confirmations, 1);
  assert.equal(approved.executor.calls.filter((call) => call.argv[0] === "issue").length, 1);

  const headless = loadClose(async () => true);
  await assert.rejects(
    () => headless.tool.execute("guard-issue-headless", { target: "cli/cli#42" }, undefined, undefined, toolCtx("/tmp/checkout", false) as never),
    (error: unknown) => error instanceof GhExecutionError && error.category === "validation",
  );
  assert.equal(headless.executor.calls.some((call) => call.argv[0] === "issue"), false);
});
