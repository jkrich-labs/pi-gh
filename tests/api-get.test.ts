import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { GhExecutionError } from "../extensions/gh/index.ts";
import { createFakeExecutor, loadExtension, projectionOf, toolCtx } from "./helpers.ts";

function nestJsonEscapes(value: string, depth: number): string {
  let nested = value;
  for (let index = 0; index < depth; index += 1) nested = nested.replaceAll("\\", "\\u005c");
  return nested;
}

function load(response: unknown = { id: 1, name: "item" }, authHosts?: string[], raw = false) {
  const executor = createFakeExecutor((request) => {
    if (request.argv[0] === "--version") return { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false };
    if (request.argv[0] === "auth") return { stdout: JSON.stringify({ hosts: authHosts ? Object.fromEntries(authHosts.map((host) => [host, [{ state: "success", active: true }]])) : {} }), stderr: "", code: 0, killed: false };
    return { stdout: raw ? String(response) : JSON.stringify(response), stderr: "", code: 0, killed: false };
  });
  const loaded = loadExtension({ executor: executor.execute });
  const tool = loaded.tools.get("gh_api_get");
  assert.ok(tool);
  return { executor, tool };
}

test("gh_api_get normalizes endpoints, forces GET, scopes hosts, queries typed values, and bounds pages", async () => {
  const { executor, tool } = load({ items: [1, 2] }, ["ghe.example.com"]);
  const result = await tool.execute(
    "api-1",
    { endpoint: "/repos/team/project/issues", host: "ghe.example.com", query: { state: "open", labels: "bug" }, page: 99, perPage: 999, cache: "60s", jq: ".items" },
    undefined,
    undefined,
    toolCtx() as never,
  );
  const projection = projectionOf(result) as { endpoint: string; page: number; perPage: number; data: unknown };
  assert.equal(projection.endpoint, "repos/team/project/issues");
  assert.equal(projection.page, 10);
  assert.equal(projection.perPage, 50);
  assert.equal(projection.data, JSON.stringify({ items: [1, 2] }));
  const request = executor.calls.find((call) => call.argv[0] === "api");
  assert.ok(request);
  assert.deepEqual(request.argv.slice(0, 5), ["api", "--hostname", "ghe.example.com", "repos/team/project/issues", "--method"]);
  assert.ok(request.argv.includes("GET"));
  assert.ok(request.argv.includes("--raw-field"));
  assert.ok(request.argv.includes("state=open"));
  assert.ok(request.argv.includes("labels=bug"));
  assert.ok(request.argv.includes("page=10"));
  assert.ok(request.argv.includes("per_page=50"));
  assert.ok(request.argv.includes("--cache") && request.argv.includes("60s"));
  assert.ok(request.argv.includes("--jq") && request.argv.includes(".items"));
});

test("gh_api_get pins the default host to github.com", async () => {
  const { executor, tool } = load({ ok: true });
  await tool.execute("api-host", { endpoint: "repos/cli/cli/issues" }, undefined, undefined, toolCtx() as never);
  const request = executor.calls.find((call) => call.argv[0] === "api");
  assert.ok(request);
  assert.deepEqual(request.argv.slice(0, 4), ["api", "--hostname", "github.com", "repos/cli/cli/issues"]);
});

test("gh_api_get allows release-asset metadata reads", async () => {
  const { executor, tool } = load({ id: 123, name: "asset.zip" });
  await tool.execute("asset-metadata", { endpoint: "repos/cli/cli/releases/assets/123" }, undefined, undefined, toolCtx() as never);
  assert.equal(executor.calls.some((call) => call.argv[0] === "api"), true);
});

test("gh_api_get rejects unsafe endpoints and impossible mutation inputs", async () => {
  for (const params of [
    { endpoint: "https://api.github.com/repos/cli/cli" },
    { endpoint: "/https://evil.example/repos/cli/cli" },
    { endpoint: "//evil.example/repos/cli/cli" },
    { endpoint: "ftp://evil.example/repos/cli/cli" },
    { endpoint: "graphql" },
    { endpoint: "/GraphQL" },
    { endpoint: "--input" },
    { endpoint: "repos/cli/cli", method: "POST" },
    { endpoint: "repos/cli/cli", body: "{}" },
    { endpoint: "repos/cli/cli", headers: { Authorization: "x" } },
    { endpoint: "repos/cli/cli", jq: "env" },
    { endpoint: "repos/cli/cli", jq: ".items | {name}" },
    { endpoint: "repos/cli/cli", jq: ".resources.core.limit-now" },
    { endpoint: "repos/cli/cli", preview: "foo" },
    { endpoint: "repos/cli/cli", input: "@payload.json" },
    { endpoint: "repos/{owner}/{repo}" },
    { endpoint: "repos/:owner/:repo/issues" },
    { endpoint: "repos/cli/cli/%2e%2e/%2e%2e/graphql" },
    { endpoint: "repos/cli/cli/@secret" },
    { endpoint: "repos/cli/cli/actions/artifacts/123/zip" },
    { endpoint: "repos/cli/cli/actions/runs/123/logs" },
    { endpoint: "repos/cli/cli/actions/jobs/123/logs" },
    { endpoint: "repos/cli/cli/actions//runs/123/logs" },
    { endpoint: `repos/cli/cli/${"x".repeat(600)}` },
    { endpoint: "repos/cli/cli", query: { q: "@/etc/passwd" } },
    { endpoint: "repos/cli/cli", query: { "nested[per_page]": "100" } },
    { endpoint: "repos/cli/cli", query: { page: "100" } },
    { endpoint: "repos/cli/cli", query: { page: 100 } as unknown as Record<string, string> },
  ]) {
    const { executor, tool } = load();
    await assert.rejects(
      () => tool.execute("api-reject", params, undefined, undefined, toolCtx() as never),
      (error: unknown) => error instanceof GhExecutionError && error.category === "validation",
    );
    assert.equal(executor.calls.some((call) => call.argv[0] === "api"), false);
  }
});

test("gh_api_get bounds query parameter count and bytes", async () => {
  const { executor, tool } = load();
  const query = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`key${index}`, "value"]));
  await assert.rejects(() => tool.execute("api-query-limit", { endpoint: "repos/cli/cli", query }, undefined, undefined, toolCtx() as never), (error: unknown) => error instanceof GhExecutionError && error.category === "validation");
  assert.equal(executor.calls.some((call) => call.argv[0] === "api"), false);
});

test("gh_api_get rejects query key, value, and aggregate byte limits", async () => {
  const cases = [
    { query: { ["k".repeat(101)]: "value" } },
    { query: { key: "v".repeat(2_001) } },
    { query: Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`key${index}`, "v".repeat(1_000)])) },
    { query: { key: "😀".repeat(2_001) } },
  ];
  for (const params of cases) {
    const { executor, tool } = load();
    await assert.rejects(() => tool.execute("api-query-bound", { endpoint: "repos/cli/cli/issues", ...params }, undefined, undefined, toolCtx() as never), (error: unknown) => error instanceof GhExecutionError && error.category === "validation");
    assert.equal(executor.calls.some((call) => call.argv[0] === "api"), false);
  }
});

test("gh_api_get accepts scalar and line-oriented jq output", async () => {
  const { tool } = load("cli\n", undefined, true);
  const projection = projectionOf(await tool.execute("api-jq", { endpoint: "repos/cli/cli", jq: ".name" }, undefined, undefined, toolCtx() as never)) as { data: string };
  assert.equal(projection.data, "cli");
});

test("gh_api_get permits safe root jq indexes and slices", async () => {
  for (const jq of [".[0]", ".[:2]", ".[]"]) {
    const { executor, tool } = load("[1,2,3]\n", undefined, true);
    await tool.execute("api-root-jq", { endpoint: "repos/cli/cli", jq }, undefined, undefined, toolCtx() as never);
    const request = executor.calls.find((call) => call.argv[0] === "api");
    assert.ok(request);
    assert.ok(request.argv.includes("--jq") && request.argv.includes(jq));
  }
  for (const jq of ["[0]", "[:2]", "[]"]) {
    const { executor, tool } = load();
    await assert.rejects(
      () => tool.execute("api-unsafe-root-jq", { endpoint: "repos/cli/cli", jq }, undefined, undefined, toolCtx() as never),
      (error: unknown) => error instanceof GhExecutionError && error.category === "validation",
    );
    assert.equal(executor.calls.some((call) => call.argv[0] === "api"), false);
  }
});

test("gh_api_get keeps jq scalar text from being reparsed as JSON", async () => {
  const { tool } = load("123", undefined, true);
  const projection = projectionOf(await tool.execute("api-jq-number", { endpoint: "repos/cli/cli", jq: ".count" }, undefined, undefined, toolCtx() as never)) as { data: unknown };
  assert.equal(projection.data, "123");
});

test("gh_api_get bounds oversized responses to a secure temporary projection", async () => {
  const { tool } = load({ payload: Array.from({ length: 50 }, () => "x".repeat(4_000)) });
  const projection = projectionOf(await tool.execute("api-large", { endpoint: "repos/cli/cli" }, undefined, undefined, toolCtx() as never)) as { truncated?: boolean; fullPath?: string };
  assert.equal(projection.truncated, true);
  assert.match(projection.fullPath ?? "", /pi-gh-/);
});

test("gh_api_get truncates oversized output to secure temporary storage", async () => {
  const { tool } = load("x".repeat(1_000_001), undefined, true);
  const projection = projectionOf(await tool.execute("api-too-large", { endpoint: "repos/cli/cli/issues" }, undefined, undefined, toolCtx() as never)) as { truncated: boolean; fullPath: string; byteCount: number; preview: string };
  assert.equal(projection.truncated, true);
  assert.equal(projection.byteCount, 1_000_001);
  assert.match(projection.fullPath, /pi-gh-/);
  assert.equal(typeof projection.preview, "string");
  assert.ok(projection.preview.length > 0);
});

test("gh_api_get keeps an identifying compact preview when API output overflows", async () => {
  const response = JSON.stringify([{ body: "😀".repeat(260_000), id: 1, name: "first useful item" }]);
  const { tool } = load(response, undefined, true);
  const projection = projectionOf(await tool.execute("api-overflow-preview", { endpoint: "repos/cli/cli/issues" }, undefined, undefined, toolCtx() as never)) as {
    truncated: boolean;
    preview: string;
    fullPath: string;
  };
  assert.equal(projection.truncated, true);
  assert.match(projection.fullPath, /pi-gh-/);
  assert.match(projection.preview, /first useful item/);
  assert.ok(projection.preview.length <= 1_000);
});

test("gh_api_get redacts token-shaped endpoint, response keys, and credential fields", async () => {
  const fieldSecret = "unrecognised-long-lived-secret-1234567890";
  const { tool } = load({
    ghp_responsekeysecret: "value",
    access_token: fieldSecret,
    client_secret: fieldSecret,
    api_key: fieldSecret,
    privateKey: fieldSecret,
  }, undefined, false);
  const result = await tool.execute("api-secret", { endpoint: "repos/ghp_secretvalue/issues" }, undefined, undefined, toolCtx() as never);
  const text = JSON.stringify(projectionOf(result));
  assert.doesNotMatch(text, /ghp_secretvalue/);
  assert.doesNotMatch(text, new RegExp(fieldSecret));
  assert.match(text, /\[redacted\]/);
});

test("gh_api_get redacts nested escaped credentials from normal parsed projections", async () => {
  const secret = "unrecognised-long-lived-secret-1234567890";
  const { tool } = load({ value: nestJsonEscapes(`Authorization\\u003A\\u0020Bearer\\u0020${secret}`, 10) });
  const result = await tool.execute("api-nested-secret", { endpoint: "repos/cli/cli" }, undefined, undefined, toolCtx() as never);
  const serialized = JSON.stringify(projectionOf(result));
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.match(serialized, /\[redacted\]/);
});

test("gh_api_get redacts unconventional and escaped sensitive keys in raw jq output", async () => {
  const secret = "unrecognised-long-lived-secret-1234567890";
  for (const raw of [
    `{"_token":"${secret}"}`,
    `{"123token":"${secret}"}`,
    `{"pass\\u0022word":"${secret}"}`,
  ]) {
    const { tool } = load(raw, undefined, true);
    const result = await tool.execute("api-raw-key-secret", { endpoint: "repos/cli/cli", jq: "." }, undefined, undefined, toolCtx() as never);
    const serialized = JSON.stringify(projectionOf(result));
    assert.doesNotMatch(serialized, new RegExp(secret));
    assert.match(serialized, /\[redacted\]/);
  }
});

test("gh_api_get bounds oversized error diagnostics", async () => {
  const executor = createFakeExecutor((request) => request.argv[0] === "--version"
    ? { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false }
    : { stdout: "", stderr: `HTTP 404: not found ${"😀".repeat(600_000)}`, code: 1, killed: false });
  const loaded = loadExtension({ executor: executor.execute });
  const tool = loaded.tools.get("gh_api_get");
  assert.ok(tool);
  await assert.rejects(() => tool.execute("api-error-large", { endpoint: "repos/cli/cli/missing" }, undefined, undefined, toolCtx() as never), (error: unknown) => {
    assert.ok(error instanceof GhExecutionError);
    assert.ok(Buffer.byteLength(String(error.details.stderr), "utf8") <= 1_000_000);
    return error.category === "not_found";
  });
});

test("gh_api_get redacts authorization credentials and private keys from previews and malformed excerpts", async () => {
  const secret = "unrecognised-long-lived-secret-1234567890";
  const privateKey = `-----BEGIN PRIVATE KEY-----\n${"K".repeat(2_000)}\n-----END PRIVATE KEY-----`;
  const pgpPrivateKey = `-----BEGIN PGP PRIVATE KEY BLOCK-----\n${"P".repeat(2_000)}\n-----END PGP PRIVATE KEY BLOCK-----`;
  for (const sensitive of [
    `Authorization: Bearer ${secret}`,
    `Authorization: token ${secret}`,
    `Bearer\\u0020${secret}`,
    `Authorization: B\\u0065arer\\u0020${secret}`,
    `Authorization\\\\u003A\\\\u0020B\\\\u0065arer\\\\u0020${secret}`,
    `Authorization\\\\\\\\u003A\\\\\\\\u0020B\\\\\\\\u0065arer\\\\\\\\u0020${secret}`,
    nestJsonEscapes(`Authorization\\u003A\\u0020Bearer\\u0020${secret}`, 10),
    `Authorization: Bearer alpha\\/beta\\/${secret}`,
    `${"\\u002d".repeat(5)}BEGIN PRIVATE KEY${"\\u002d".repeat(5)}\\n${"K".repeat(2_000)}\\n${"\\u002d".repeat(5)}END PRIVATE KEY${"\\u002d".repeat(5)}`,
    privateKey,
    pgpPrivateKey,
    `prefix {"nested":{"password":"${secret}"}}`,
    `prefix {"nested":{"pass\\u0077ord":"${secret}\\u0022 battery staple"}}`,
    `prefix {"private\\u004bey":"${secret}"}`,
  ]) {
    const oversized = load(`${sensitive}\n${"x".repeat(1_000_001)}`, undefined, true);
    const projection = projectionOf(await oversized.tool.execute(
      "api-secret-overflow",
      { endpoint: "repos/cli/cli" },
      undefined,
      undefined,
      toolCtx() as never,
    )) as { fullPath: string };
    const serialized = `${JSON.stringify(projection)}\n${await readFile(projection.fullPath, "utf8")}`;
    assert.doesNotMatch(serialized, new RegExp(secret));
    assert.doesNotMatch(serialized, /BEGIN (?:PGP )?PRIVATE KEY|[KP]{20}|battery staple/);
    assert.match(serialized, /\[redacted\]/);
  }

  const malformed = load(`Authorization: token ${secret}`, undefined, true);
  await assert.rejects(
    () => malformed.tool.execute("api-secret-malformed", { endpoint: "repos/cli/cli" }, undefined, undefined, toolCtx() as never),
    (error: unknown) => error instanceof GhExecutionError
      && !error.message.includes(secret)
      && error.message.includes("[redacted]"),
  );
});

test("gh_api_get accepts authenticated single-label and IP GHES hosts", async () => {
  for (const host of ["ghe", "localhost", "127.0.0.1"]) {
    const { executor, tool } = load({ id: 1 }, [host]);
    await tool.execute("api-private-host", { endpoint: "repos/team/project", host }, undefined, undefined, toolCtx() as never);
    assert.ok(executor.calls.some((call) => call.argv.includes("--hostname") && call.argv.includes(host)), host);
  }
});

test("gh_api_get reports malformed authentication output with host context", async () => {
  const executor = createFakeExecutor((request) => request.argv[0] === "--version"
    ? { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false }
    : { stdout: "{", stderr: "", code: 0, killed: false });
  const loaded = loadExtension({ executor: executor.execute });
  const tool = loaded.tools.get("gh_api_get");
  assert.ok(tool);
  await assert.rejects(
    () => tool.execute("api-auth-malformed", { endpoint: "repos/team/project", host: "ghe" }, undefined, undefined, toolCtx() as never),
    (error: unknown) => error instanceof GhExecutionError
      && error.category === "malformed_json"
      && /checking authentication.*ghe/i.test(error.message),
  );
});

test("gh_api_get reports unsupported hosts and malformed output with API context", async () => {
  const unsupported = load();
  await assert.rejects(
    () => unsupported.tool.execute("api-host-reject", { endpoint: "repos/cli/cli", host: "raw.githubusercontent.com" }, undefined, undefined, toolCtx() as never),
    (error: unknown) => error instanceof GhExecutionError
      && error.category === "validation"
      && /unsupported github host.*raw\.githubusercontent\.com/i.test(error.message),
  );
  assert.equal(unsupported.executor.calls.length, 0);

  for (const [id, response, pattern] of [
    ["api-empty", "", /empty response.*API GET.*github\.com.*repos\/cli\/cli/i],
    ["api-malformed", "{", /malformed JSON.*API GET.*github\.com.*repos\/cli\/cli/i],
  ] as const) {
    const { tool } = load(response, undefined, true);
    await assert.rejects(
      () => tool.execute(id, { endpoint: "repos/cli/cli" }, undefined, undefined, toolCtx() as never),
      (error: unknown) => error instanceof GhExecutionError && error.category === "malformed_json" && pattern.test(error.message),
    );
  }
});

test("gh_api_get redacts escaped secrets from classified stderr and error details", async () => {
  const secret = "unrecognised-long-lived-secret-1234567890";
  for (const sensitive of [
    `Authorization\\u003A\\u0020B\\u0065arer\\u0020alpha\\/beta\\/${secret}`,
    `Authorization\\\\u003A\\\\u0020B\\\\u0065arer\\\\u0020${secret}`,
    `Authorization\\\\\\\\u003A\\\\\\\\u0020B\\\\\\\\u0065arer\\\\\\\\u0020${secret}`,
    nestJsonEscapes(`Authorization\\u003A\\u0020Bearer\\u0020${secret}`, 10),
    `Bearer\\u000a${secret}`,
    `${"\\u002d".repeat(5)}BEGIN PRIVATE KEY${"\\u002d".repeat(5)}\\n${"K".repeat(200)}\\n${"\\u002d".repeat(5)}END PRIVATE KEY${"\\u002d".repeat(5)}`,
    `-----BEGIN PGP PRIVATE KEY BLOCK-----\n${"P".repeat(1_000_100)}\n-----END PGP PRIVATE KEY BLOCK-----`,
    `{"private_key":"${secret}"}`,
  ]) {
    const executor = createFakeExecutor((request) => request.argv[0] === "--version"
      ? { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false }
      : { stdout: "", stderr: `HTTP 403: ${sensitive}`, code: 1, killed: false });
    const loaded = loadExtension({ executor: executor.execute });
    const tool = loaded.tools.get("gh_api_get");
    assert.ok(tool);
    await assert.rejects(
      () => tool.execute("api-secret-stderr", { endpoint: "repos/cli/cli" }, undefined, undefined, toolCtx() as never),
      (error: unknown) => {
        assert.ok(error instanceof GhExecutionError);
        const serialized = JSON.stringify({ message: error.message, details: error.details });
        assert.doesNotMatch(serialized, new RegExp(secret));
        assert.doesNotMatch(serialized, /BEGIN (?:PGP )?PRIVATE KEY|[KP]{20}/);
        assert.match(serialized, /\[redacted\]/);
        return true;
      },
    );
  }
});

test("gh_api_get preserves classified errors", async () => {
  const executor = createFakeExecutor((request) => request.argv[0] === "--version"
    ? { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false }
    : { stdout: "", stderr: "HTTP 404: not found", code: 1, killed: false });
  const loaded = loadExtension({ executor: executor.execute });
  const tool = loaded.tools.get("gh_api_get");
  assert.ok(tool);
  await assert.rejects(() => tool.execute("api-error", { endpoint: "repos/cli/cli/missing" }, undefined, undefined, toolCtx() as never), (error: unknown) => error instanceof GhExecutionError && error.category === "not_found");
});
