import assert from "node:assert/strict";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { redactRawSecrets } from "../extensions/gh/errors.ts";
import { createSecureTempOutput, GhExecutionError } from "../extensions/gh/index.ts";
import { callView, createFakeExecutor, loadExtension, projectionOf, scriptedExecutor, toolCtx } from "./helpers.ts";

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

test("write bodies preserve multiline text, mentions, quotes, and shell metacharacters", async () => {
  const executor = scriptedExecutor();
  const { tools } = loadExtension({ executor: executor.execute });
  const tool = tools.get("gh_comment_issue");
  assert.ok(tool);
  const body = "line one\n@alice \"quoted\"; echo $(whoami) && $HOME";
  await callView(tool, { target: "cli/cli#42", body });
  const comment = executor.calls.find((call) => call.argv[0] === "issue");
  assert.ok(comment);
  assert.equal(comment.argv.includes(body), true);
  assert.equal(comment.argv.some((part) => part.includes("sh -c") || part === "&&"), false);
});

test("successful write outputs redact nested escaped credentials", async () => {
  const secret = "unrecognised-long-lived-secret-1234567890";
  let nested = `Authorization\\u003A\\u0020Bearer\\u0020${secret}`;
  for (let depth = 0; depth < 10; depth += 1) nested = nested.replaceAll("\\", "\\u005c");
  for (const [name, params] of [
    ["gh_comment_issue", { target: "cli/cli#1", body: "hello" }],
    ["gh_comment_pull_request", { target: "https://github.com/cli/cli/pull/1", body: "hello" }],
    ["gh_edit_release", { target: "https://github.com/cli/cli/releases/tag/v1", title: "Updated" }],
  ] as const) {
    const executor = createFakeExecutor((request) => request.argv[0] === "--version"
      ? { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false }
      : { stdout: nested, stderr: "", code: 0, killed: false });
    const { tools } = loadExtension({ executor: executor.execute });
    const tool = tools.get(name);
    assert.ok(tool);
    const result = await tool.execute("write-output-secret", params, undefined, undefined, toolCtx() as never);
    const serialized = JSON.stringify(projectionOf(result));
    assert.doesNotMatch(serialized, new RegExp(secret));
    assert.match(serialized, /\[redacted\]/);
  }
});

test("merge verification details redact nested escaped credentials", async () => {
  const secret = "unrecognised-long-lived-secret-1234567890";
  let nested = `Authorization\\u003A\\u0020Bearer\\u0020${secret}`;
  for (let depth = 0; depth < 10; depth += 1) nested = nested.replaceAll("\\", "\\u005c");
  const executor = createFakeExecutor((request) => {
    if (request.argv[0] === "--version") return { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false };
    if (request.argv[0] === "pr" && request.argv[1] === "merge") return { stdout: "merged", stderr: "", code: 0, killed: false };
    if (request.argv.includes("state,mergedAt,mergeCommit")) {
      return { stdout: JSON.stringify({ state: "MERGED", mergedAt: "2026-01-01T00:00:00Z", mergeCommit: { message: nested } }), stderr: "", code: 0, killed: false };
    }
    return { stdout: JSON.stringify({ data: { repository: { pullRequest: { number: 1, state: "MERGED" } } } }), stderr: "", code: 0, killed: false };
  });
  const { tools } = loadExtension({ executor: executor.execute });
  const tool = tools.get("gh_merge_pull_request");
  assert.ok(tool);
  const result = await tool.execute(
    "merge-detail-secret",
    { target: "https://github.com/cli/cli/pull/1", method: "squash" },
    undefined,
    undefined,
    toolCtx() as never,
  );
  const serialized = JSON.stringify(projectionOf(result));
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.match(serialized, /\[redacted\]/);
});

test("search results and tool details redact untrusted values and targets", async () => {
  const secret = "ghp_exampleSecretTokenValue1234567890";
  const searchExecutor = createFakeExecutor((request) => request.argv[0] === "--version"
    ? { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false }
    : { stdout: JSON.stringify({ total_count: 1, items: [{ commit: { message: secret, author: { name: secret } }, repository: { full_name: secret } }] }), stderr: "", code: 0, killed: false });
  const search = loadExtension({ executor: searchExecutor.execute }).tools.get("gh_search_commits");
  assert.ok(search);
  const searchResult = await search.execute("search-secret", { query: "fix", limit: 1 }, undefined, undefined, toolCtx() as never);
  assert.doesNotMatch(JSON.stringify(searchResult), new RegExp(secret));

  const fileExecutor = createFakeExecutor((request) => request.argv[0] === "--version"
    ? { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false }
    : { stdout: JSON.stringify({ type: "file", encoding: "base64", content: Buffer.from("safe").toString("base64"), size: 4 }), stderr: "", code: 0, killed: false });
  const file = loadExtension({ executor: fileExecutor.execute }).tools.get("gh_read_file");
  assert.ok(file);
  const fileResult = await file.execute("file-target-secret", { repo: `cli/${secret}`, path: "README.md" }, undefined, undefined, toolCtx() as never);
  const serialized = JSON.stringify(fileResult);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.match(serialized, /\[redacted\]/);
});

test("nested escape redaction is linear near the diagnostic limit", () => {
  const secret = "unrecognised-long-lived-secret-1234567890";
  let nested = `Bearer\\u0020${secret}`;
  for (let depth = 0; depth < 20_000; depth += 1) nested = nested.replaceAll("\\", "\\u005c");
  let started = performance.now();
  const redacted = redactRawSecrets(nested);
  assert.equal(redacted, "[redacted]");
  assert.ok(performance.now() - started < 1_000);

  const slashRun = "\\".repeat(100_000) + "x";
  started = performance.now();
  assert.equal(redactRawSecrets(slashRun), slashRun);
  assert.ok(performance.now() - started < 1_000);

  assert.equal(redactRawSecrets("password: correct horse battery staple"), "[redacted]");
  for (const value of [
    '{"password":"correct horse\\u0022 battery staple","next":"safe"}',
    '{"pass\\u0077ord":"correct horse\\u0022 battery staple","next":"safe"}',
  ]) {
    const escapedQuote = redactRawSecrets(value);
    assert.doesNotMatch(escapedQuote, /correct horse|battery staple/);
    assert.match(escapedQuote, /\[redacted\]/);
  }

  const whitespaceRun = `Bearer${" ".repeat(100_000)}`;
  started = performance.now();
  assert.equal(redactRawSecrets(whitespaceRun), whitespaceRun);
  assert.ok(performance.now() - started < 1_000);
});

test("unexpected executor rejections are wrapped and redacted", async () => {
  const secret = "unrecognised-long-lived-secret-1234567890";
  for (const failVersion of [true, false]) {
    const executor = createFakeExecutor((request) => {
      if (!failVersion && request.argv[0] === "--version") return { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false };
      throw new Error(`Authorization: Bearer ${secret}`);
    });
    const tool = loadExtension({ executor: executor.execute }).tools.get("gh_view");
    assert.ok(tool);
    await assert.rejects(
      () => tool.execute("executor-secret", { target: "cli/cli" }, undefined, undefined, toolCtx() as never),
      (error: unknown) => {
        assert.ok(error instanceof GhExecutionError);
        const serialized = JSON.stringify({ message: error.message, details: error.details });
        assert.doesNotMatch(serialized, new RegExp(secret));
        assert.match(serialized, /\[redacted\]/);
        return true;
      },
    );
  }
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
