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

  const first = projectionOf(await tool.execute("find-1", { query: "repository" }, undefined, undefined, toolCtx() as never)) as {
    activated: string[];
  };
  const second = projectionOf(await tool.execute("find-2", { query: "repository" }, undefined, undefined, toolCtx() as never)) as {
    activated: string[];
  };
  assert.deepEqual(first.activated, []);
  assert.deepEqual(second.activated, []);
  assert.deepEqual(new Set(loaded.activeTools).size, loaded.activeTools.length);

  loadExtension({}, { activeTools: loaded.activeTools });
  assert.deepEqual(new Set(loaded.activeTools).size, loaded.activeTools.length);
});

test("gh_view remains callable after additive loading", async () => {
  const loaded = loadExtension({ executor: scriptedExecutor().execute }, { activeTools: ["read"] });
  const tool = loaded.tools.get("gh_view");
  assert.ok(tool);
  const result = await callView(tool, { target: "cli/cli" });
  assert.equal((projectionOf(result) as { kind: string }).kind, "repository");
});
