import assert from "node:assert/strict";
import { test } from "node:test";
import { loadExtension } from "./helpers.ts";

test("initial tools keep combined gh_view and gh_find metadata within 800 estimated tokens", () => {
  const loaded = loadExtension();
  const metadata = ["gh_view", "gh_find"].map((name) => {
    const tool = loaded.tools.get(name);
    assert.ok(tool);
    return {
      name: tool.name,
      label: tool.label,
      description: tool.description,
      promptSnippet: tool.promptSnippet,
      parameters: tool.parameters,
    };
  });
  const estimatedTokens = Math.ceil(JSON.stringify(metadata).length / 4);
  assert.ok(estimatedTokens <= 800, `initial metadata estimated at ${estimatedTokens} tokens`);
});
