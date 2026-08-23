import assert from "node:assert/strict";
import { test } from "node:test";
import { callView, loadExtension, projectionOf, scriptedExecutor, toolCtx } from "./helpers.ts";

test("initial GitHub tools are active additively and unrelated tools survive", () => {
  const loaded = loadExtension({}, { activeTools: ["read", "other_extension_tool"] });
  assert.deepEqual(loaded.activeTools, ["read", "other_extension_tool", "gh_view", "gh_find"]);
  assert.equal(loaded.tools.has("gh_view"), true);
  assert.equal(loaded.tools.has("gh_find"), true);
});

test("gh_find ranks aliases and activates only the bounded exact matches", async () => {
  const loaded = loadExtension({}, { activeTools: ["read", "gh_view", "gh_find"] });
  const tool = loaded.tools.get("gh_find");
  assert.ok(tool);

  const result = await tool.execute("find-1", { query: "inspect repository", limit: 1 }, undefined, undefined, toolCtx() as never);
  const projection = projectionOf(result) as {
    matches: Array<{ name: string; purpose: string }>;
    activated: string[];
  };
  assert.equal(projection.matches.length, 1);
  assert.equal(projection.matches[0]?.name, "gh_view");
  assert.match(projection.matches[0]?.purpose ?? "", /Inspect/);
  assert.deepEqual(projection.activated, []);
});

test("gh_find repeat calls are stable and reload does not duplicate active tools", async () => {
  const loaded = loadExtension({}, { activeTools: ["read"] });
  const tool = loaded.tools.get("gh_find");
  assert.ok(tool);

  const first = projectionOf(await tool.execute("find-1", { query: "gh_view", limit: 1 }, undefined, undefined, toolCtx() as never)) as {
    activated: string[];
  };
  const second = projectionOf(await tool.execute("find-2", { query: "gh_view", limit: 1 }, undefined, undefined, toolCtx() as never)) as {
    activated: string[];
  };
  assert.deepEqual(first.activated, []);
  assert.deepEqual(second.activated, []);
  assert.deepEqual(new Set(loaded.activeTools).size, loaded.activeTools.length);

  loadExtension({}, { activeTools: loaded.activeTools });
  assert.deepEqual(new Set(loaded.activeTools).size, loaded.activeTools.length);
});

test("gh_find loads exact search and content tools for representative tasks", async () => {
  const loaded = loadExtension();
  const tool = loaded.tools.get("gh_find");
  assert.ok(tool);
  const cases = [
    ["search issues", "gh_search_issues"],
    ["search repositories", "gh_search_repositories"],
    ["read file", "gh_read_file"],
    ["list directory", "gh_list_directory"],
    ["pull request files", "gh_pr_files"],
    ["pull request diff", "gh_pr_diff"],
  ] as const;
  for (const [query, expected] of cases) {
    const projection = projectionOf(await tool.execute(query, { query, limit: 1 }, undefined, undefined, toolCtx() as never)) as {
      matches: Array<{ name: string }>;
    };
    assert.equal(projection.matches[0]?.name, expected);
    assert.equal(loaded.activeTools.includes(expected), true);
  }
});

test("gh_find loads exact issue write tools", async () => {
  const loaded = loadExtension();
  const tool = loaded.tools.get("gh_find");
  assert.ok(tool);
  const cases = [
    ["create issue", "gh_create_issue"],
    ["comment on issue", "gh_comment_issue"],
    ["edit issue labels", "gh_edit_issue"],
    ["close issue", "gh_close_issue"],
  ] as const;
  for (const [query, expected] of cases) {
    const projection = projectionOf(await tool.execute(query, { query, limit: 1 }, undefined, undefined, toolCtx() as never)) as {
      matches: Array<{ name: string }>;
    };
    assert.equal(projection.matches[0]?.name, expected);
    assert.equal(loaded.activeTools.includes(expected), true);
  }
});

test("gh_find loads exact pull request write tools", async () => {
  const loaded = loadExtension();
  const tool = loaded.tools.get("gh_find");
  assert.ok(tool);
  const cases = [
    ["create pull request", "gh_create_pull_request"],
    ["comment pull request", "gh_comment_pull_request"],
    ["edit pull request", "gh_edit_pull_request"],
    ["review pull request", "gh_review_pull_request"],
    ["merge pull request", "gh_merge_pull_request"],
    ["update pull request branch", "gh_update_pull_request_branch"],
  ] as const;
  for (const [query, expected] of cases) {
    const projection = projectionOf(await tool.execute(query, { query, limit: 1 }, undefined, undefined, toolCtx() as never)) as { matches: Array<{ name: string }> };
    assert.equal(projection.matches[0]?.name, expected);
    assert.equal(loaded.activeTools.includes(expected), true);
  }
});

test("gh_find loads the REST API escape hatch and yields to focused tools", async () => {
  const loaded = loadExtension();
  const tool = loaded.tools.get("gh_find");
  assert.ok(tool);
  const projection = projectionOf(await tool.execute("api read", { query: "REST API read", limit: 1 }, undefined, undefined, toolCtx() as never)) as { matches: Array<{ name: string }> };
  assert.equal(projection.matches[0]?.name, "gh_api_get");
  assert.equal(loaded.activeTools.includes("gh_api_get"), true);
  /* "api get pulls list" must surface the escape hatch, not drown it (#12). */
  const escape = projectionOf(await tool.execute("api-escape", { query: "api get pulls list", limit: 3 }, undefined, undefined, toolCtx() as never)) as { matches: Array<{ name: string }> };
  assert.equal(escape.matches.some((match) => match.name === "gh_api_get"), true);
  assert.equal(loaded.activeTools.includes("gh_api_get"), true);
  for (const [query, expected] of [
    ["get and read issue", "gh_view"],
    ["get and read directory", "gh_list_directory"],
    ["get and read checks", "gh_pr_checks"],
    ["get and read logs", "gh_failed_logs"],
    ["get and read pull_request", "gh_view"],
    ["get and read workflow_run", "gh_view"],
    ["REST API read issue", "gh_view"],
    ["REST API read directory", "gh_list_directory"],
    ["REST API read checks", "gh_pr_checks"],
    ["read API logs", "gh_failed_logs"],
  ] as const) {
    const focused = projectionOf(await tool.execute("focused", { query, limit: 1 }, undefined, undefined, toolCtx() as never)) as { matches: Array<{ name: string }> };
    assert.equal(focused.matches[0]?.name, expected);
    const bounded = projectionOf(await tool.execute("focused-bounded", { query, limit: 3 }, undefined, undefined, toolCtx() as never)) as { matches: Array<{ name: string }> };
    assert.equal(bounded.matches.some((match) => match.name === "gh_api_get"), false);
  }
});

test("gh_find loads dispatch rerun cancel and release tools", async () => {
  const loaded = loadExtension();
  const tool = loaded.tools.get("gh_find");
  assert.ok(tool);
  const cases = [
    ["dispatch workflow", "gh_dispatch_workflow"],
    ["cancel workflow run", "gh_cancel_workflow_run"],
    ["rerun workflow run", "gh_rerun_workflow_run"],
    ["create release", "gh_create_release"],
    ["upload release asset", "gh_upload_release_asset"],
    ["delete release", "gh_delete_release"],
  ] as const;
  for (const [query, expected] of cases) {
    const projection = projectionOf(await tool.execute(query, { query, limit: 1 }, undefined, undefined, toolCtx() as never)) as { matches: Array<{ name: string }> };
    assert.equal(projection.matches[0]?.name, expected);
    assert.equal(loaded.activeTools.includes(expected), true);
  }
});

test("gh_find loads CI checks, workflow jobs, and failed logs tools", async () => {
  const loaded = loadExtension();
  const tool = loaded.tools.get("gh_find");
  assert.ok(tool);
  const cases = [
    ["workflow runs", "gh_list_workflow_runs"],
    ["view workflow run", "gh_view_workflow_run"],
    ["view job", "gh_view_job"],
    ["pull request checks", "gh_pr_checks"],
    ["failed logs", "gh_failed_logs"],
  ] as const;
  for (const [query, expected] of cases) {
    const projection = projectionOf(await tool.execute(query, { query, limit: 1 }, undefined, undefined, toolCtx() as never)) as {
      matches: Array<{ name: string }>;
    };
    assert.equal(projection.matches[0]?.name, expected);
    assert.equal(loaded.activeTools.includes(expected), true);
  }
});

test("gh_view remains callable after additive loading", async () => {
  const loaded = loadExtension({ executor: scriptedExecutor().execute }, { activeTools: ["read"] });
  const tool = loaded.tools.get("gh_view");
  assert.ok(tool);
  const result = await callView(tool, { target: "cli/cli" });
  assert.equal((projectionOf(result) as { kind: string }).kind, "repository");
});
