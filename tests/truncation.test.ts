import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateProjectionTokens } from "../extensions/gh/execute.ts";
import { createFakeExecutor, loadExtension, projectionOf, toolCtx } from "./helpers.ts";

function version() {
  return { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false };
}

test("search projections stay within compact and expanded token budgets", async () => {
  const items = Array.from({ length: 60 }, (_, index) => ({
    id: index,
    full_name: `org/repository-${index}`,
    name: `repository-${index}`,
    title: "large title ".repeat(400),
    description: "large description ".repeat(400),
    html_url: `https://github.com/org/repository-${index}`,
  }));
  const executor = createFakeExecutor((request) => {
    if (request.argv[0] === "--version") return version();
    return { stdout: JSON.stringify({ total_count: items.length, incomplete_results: false, items }), stderr: "", code: 0, killed: false };
  });
  const loaded = loadExtension({ executor: executor.execute });
  const tool = loaded.tools.get("gh_search_repositories");
  assert.ok(tool);

  for (const [detail, budget] of [["compact", 2_000], ["expanded", 8_000]] as const) {
    const projection = projectionOf(
      await tool.execute("budget", { query: "large", detail }, undefined, undefined, toolCtx() as never),
    );
    assert.ok(estimateProjectionTokens(JSON.stringify(projection)) <= budget);
    const record = projection as Record<string, unknown>;
    assert.equal(record.truncated, true);
    assert.equal(typeof record.fullPath, "string");
    assert.equal(record.totalCount, items.length);
  }
});

test("large file content reports byte counts and a restrictive temporary path", async () => {
  const content = "0123456789abcdef".repeat(4_000);
  const writes: string[] = [];
  const executor = createFakeExecutor((request) => {
    if (request.argv[0] === "--version") return version();
    return {
      stdout: JSON.stringify({ type: "file", encoding: "base64", content: Buffer.from(content).toString("base64"), size: content.length }),
      stderr: "",
      code: 0,
      killed: false,
    };
  });
  const loaded = loadExtension({
    executor: executor.execute,
    tempOutput: {
      async write(value) {
        writes.push(value);
        return { path: "/tmp/pi-gh-private/full-output" };
      },
    },
  });
  const tool = loaded.tools.get("gh_read_file");
  assert.ok(tool);
  const projection = projectionOf(
    await tool.execute("file-budget", { repo: "cli/cli", path: "large.txt" }, undefined, undefined, toolCtx() as never),
  ) as Record<string, unknown>;
  assert.equal(projection.truncated, true);
  assert.equal(projection.byteCount, content.length);
  assert.equal(projection.fullPath, "/tmp/pi-gh-private/full-output");
  assert.ok(writes[0]?.includes(content));
  assert.ok(estimateProjectionTokens(JSON.stringify(projection)) <= 2_000);
});
