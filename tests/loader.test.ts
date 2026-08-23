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
