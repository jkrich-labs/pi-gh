import assert from "node:assert/strict";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { createSecureTempOutput, GhExecutionError } from "../extensions/gh/index.ts";
import { callView, loadExtension, scriptedExecutor } from "./helpers.ts";

test("secure temporary output uses exclusive 0600 files and redacts credentials", async () => {
  const token = "ghp_exampleSecretTokenValue1234567890";
  const writer = createSecureTempOutput();
  const { path } = await writer.write(`body token=${token}`);
  try {
    const info = await stat(path);
    const dir = await stat(dirname(path));
    assert.equal(info.mode & 0o777, 0o600);
    assert.equal(dir.mode & 0o777, 0o700);
    const saved = await readFile(path, "utf8");
    assert.equal(saved.includes(token), false);
    await assert.rejects(() => writeFile(path, "collision", { flag: "wx" }));
  } finally {
    await rm(dirname(path), { recursive: true, force: true });
  }
});

test("gh_view passes argv as an array and keeps shell metacharacters as data", async () => {
  const executor = scriptedExecutor();
  const { tools } = loadExtension({ executor: executor.execute });
  const tool = tools.get("gh_view");
  assert.ok(tool);
  await callView(tool, { target: "https://github.com/ow;ner/re|po$(whoami)" });
  const view = executor.calls.find((call) => call.argv[0] === "repo");
  assert.ok(view);
  assert.ok(Array.isArray(view.argv));
  assert.equal(view.argv[2], "ow;ner/re|po$(whoami)");
  assert.equal(
    view.argv.some((part) => part.includes(" && ") || part.includes(" sh -c ")),
    false,
  );
});

test("gh_view rejects resource target URLs that include credentials", async () => {
  const token = "ghp_exampleSecretTokenValue1234567890";
  const executor = scriptedExecutor();
  const { tools } = loadExtension({ executor: executor.execute });
  const tool = tools.get("gh_view");
  assert.ok(tool);
  try {
    await callView(tool, { target: `https://user:${token}@github.com/cli/cli` });
    assert.fail("expected validation error");
  } catch (error) {
    assert.ok(error instanceof GhExecutionError);
    assert.equal(error.category, "validation");
    assert.equal(error.message.includes(token), false);
    assert.equal(JSON.stringify(error).includes(token), false);
  }
  assert.equal(
    executor.calls.some((call) => call.argv[0] === "repo"),
    false,
  );
});

test("credentials never appear in projections or errors", async () => {
  const token = "ghp_exampleSecretTokenValue1234567890";
  const executor = scriptedExecutor({
    onView: () => ({
      stdout: "",
      stderr: `HTTP 401: Bad credentials (https://api.github.com/graphql) token=${token}`,
      code: 4,
      killed: false,
    }),
  });
  const { tools } = loadExtension({ executor: executor.execute });
  const tool = tools.get("gh_view");
  assert.ok(tool);
  try {
    await callView(tool, { target: "cli/cli" });
    assert.fail("expected authentication error");
  } catch (error) {
    assert.ok(error instanceof GhExecutionError);
    assert.equal(error.category, "auth");
    assert.equal(error.message.includes(token), false);
    assert.equal(JSON.stringify(error).includes(token), false);
  }
});
