import assert from "node:assert/strict";
import { test } from "node:test";
import { GhExecutionError } from "../extensions/gh/index.ts";
import { createFakeExecutor, loadExtension, projectionOf, toolCtx } from "./helpers.ts";

function load(name: string, response = "ok\n", confirm?: () => Promise<boolean>) {
  const executor = createFakeExecutor((request) => request.argv[0] === "--version"
    ? { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false }
    : { stdout: response, stderr: "", code: 0, killed: false });
  const loaded = loadExtension({ executor: executor.execute, confirm });
  const tool = loaded.tools.get(name);
  assert.ok(tool, `${name} must be registered`);
  return { executor, tool };
}

test("release create/edit/upload/delete operations use exact argv and projections", async () => {
  const create = load("gh_create_release", "https://github.com/cli/cli/releases/tag/v1\n", async () => true);
  await create.tool.execute("release-create", { repo: "cli/cli", tag: "v1", title: "Release", notes: "notes", draft: true, prerelease: false }, undefined, undefined, toolCtx() as never);
  assert.deepEqual(create.executor.calls[1]?.argv, ["release", "create", "v1", "--repo", "cli/cli", "--title", "Release", "--notes", "notes", "--draft"]);

  const edit = load("gh_edit_release");
  await edit.tool.execute("release-edit", { target: "https://github.com/cli/cli/releases/tag/v1", title: "Updated", notes: "new notes", prerelease: true }, undefined, undefined, toolCtx() as never);
  assert.deepEqual(edit.executor.calls[1]?.argv, ["release", "edit", "v1", "--repo", "cli/cli", "--title", "Updated", "--notes", "new notes", "--prerelease"]);

  const upload = load("gh_upload_release_asset");
  await upload.tool.execute("release-upload", { target: "https://github.com/cli/cli/releases/tag/v1", path: "/tmp/app.tar.gz", label: "app" }, undefined, undefined, toolCtx() as never);
  assert.deepEqual(upload.executor.calls[1]?.argv, ["release", "upload", "v1", "/tmp/app.tar.gz#app", "--repo", "cli/cli"]);

  const del = load("gh_delete_release", "deleted\n", async () => true);
  const deleted = await del.tool.execute("release-delete", { target: "https://github.com/cli/cli/releases/tag/v1" }, undefined, undefined, toolCtx() as never);
  assert.equal((projectionOf(deleted) as { kind: string }).kind, "release_deleted");
  assert.deepEqual(del.executor.calls[1]?.argv, ["release", "delete", "v1", "--repo", "cli/cli", "--yes"]);

  const asset = load("gh_delete_release_asset", "deleted\n", async () => true);
  await asset.tool.execute("asset-delete", { target: "https://github.com/cli/cli/releases/tag/v1", asset: "app.tar.gz" }, undefined, undefined, toolCtx() as never);
  assert.deepEqual(asset.executor.calls[1]?.argv, ["release", "delete-asset", "app.tar.gz", "--repo", "cli/cli", "--yes"]);
});

test("release writes reject unsafe asset paths and preserve immutable-release errors", async () => {
  const upload = load("gh_upload_release_asset");
  for (const path of ["../app.tar.gz", "", "relative\\asset.zip"]) {
    await assert.rejects(() => upload.tool.execute("asset-path", { target: "cli/cli@v1", path }, undefined, undefined, toolCtx() as never), (error: unknown) => error instanceof GhExecutionError && error.category === "validation");
  }
  const immutable = createFakeExecutor((request) => request.argv[0] === "--version"
    ? { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false }
    : { stdout: "", stderr: "release is immutable", code: 1, killed: false });
  const loaded = loadExtension({ executor: immutable.execute, confirm: async () => true });
  const tool = loaded.tools.get("gh_edit_release");
  assert.ok(tool);
  await assert.rejects(() => tool.execute("immutable", { target: "cli/cli@v1", title: "nope" }, undefined, undefined, toolCtx() as never), (error: unknown) => error instanceof GhExecutionError);
});
