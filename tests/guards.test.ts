import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakeExecutor, loadExtension, projectionOf, toolCtx } from "./helpers.ts";

test("formerly gated write tools execute directly without UI", async () => {
  const executor = createFakeExecutor((request) => request.argv[0] === "--version"
    ? { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false }
    : { stdout: "ok\n", stderr: "", code: 0, killed: false });
  const loaded = loadExtension({ executor: executor.execute });
  const cases = [
    ["gh_close_issue", { target: "https://github.com/cli/cli/issues/42" }, "issue_closed", ["issue", "close", "42", "--repo", "cli/cli"]],
    ["gh_review_pull_request", { target: "https://github.com/cli/cli/pull/12", event: "approve" }, "pull_request_reviewed", ["pr", "review", "12", "--repo", "cli/cli", "--approve", "--body", ""]],
    ["gh_close_pull_request", { target: "https://github.com/cli/cli/pull/12" }, "pull_request_closed", ["pr", "close", "12", "--repo", "cli/cli"]],
    ["gh_merge_pull_request", { target: "https://github.com/cli/cli/pull/12", method: "squash" }, "pull_request_merged", ["pr", "merge", "12", "--repo", "cli/cli", "--squash"]],
    ["gh_update_pull_request_branch", { target: "https://github.com/cli/cli/pull/12" }, "pull_request_branch_updated", ["pr", "update-branch", "12", "--repo", "cli/cli"]],
    ["gh_dispatch_workflow", { repo: "cli/cli", workflow: "build.yml" }, "workflow_dispatched", ["workflow", "run", "build.yml", "--repo", "cli/cli"]],
    ["gh_cancel_workflow_run", { target: "https://github.com/cli/cli/actions/runs/100" }, "workflow_run_cancelled", ["run", "cancel", "100", "--repo", "cli/cli"]],
    ["gh_rerun_workflow_run", { target: "https://github.com/cli/cli/actions/runs/100" }, "workflow_run_rerun", ["run", "rerun", "100", "--repo", "cli/cli"]],
    ["gh_create_release", { repo: "cli/cli", tag: "v1" }, "release_created", ["release", "create", "v1", "--repo", "cli/cli"]],
    ["gh_delete_release", { target: "https://github.com/cli/cli/releases/tag/v1" }, "release_deleted", ["release", "delete", "v1", "--repo", "cli/cli", "--yes"]],
    ["gh_delete_release_asset", { target: "https://github.com/cli/cli/releases/tag/v1", asset: "app.zip" }, "release_asset_deleted", ["release", "delete-asset", "app.zip", "--repo", "cli/cli", "--yes"]],
  ] as const;

  for (const [name, params, kind, argv] of cases) {
    const tool = loaded.tools.get(name);
    assert.ok(tool, `${name} must be registered`);
    const result = await tool.execute(name, params, undefined, undefined, toolCtx("/tmp/checkout", false) as never);
    assert.equal((projectionOf(result) as { kind: string }).kind, kind);
    assert.ok(executor.calls.some((call) => JSON.stringify(call.argv) === JSON.stringify(argv)), `${name} must execute its exact argv`);
  }
});
