import assert from "node:assert/strict";
import { test } from "node:test";
import { GhExecutionError } from "../extensions/gh/index.ts";
import { REPO_VIEW_JSON, callView, createFakeExecutor, loadExtension } from "./helpers.ts";

test("github.com is accepted without an auth status probe", async () => {
  const executor = createFakeExecutor((request) => {
    if (request.argv[0] === "--version") return { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false };
    return { stdout: JSON.stringify(REPO_VIEW_JSON), stderr: "", code: 0, killed: false };
  });
  const loaded = loadExtension({ executor: executor.execute });
  await callView(loaded.tools.get("gh_view")!, { target: "cli/cli" });
  assert.equal(executor.calls.some((call) => call.argv[0] === "auth"), false);
});

test("authenticated GHES hosts are read from gh auth JSON and selected for the view", async () => {
  const executor = createFakeExecutor((request) => {
    if (request.argv[0] === "--version") return { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false };
    if (request.argv[0] === "auth") {
      return { stdout: JSON.stringify({ hosts: { "ghe.example.com": [{}] } }), stderr: "", code: 0, killed: false };
    }
    return { stdout: JSON.stringify(REPO_VIEW_JSON), stderr: "", code: 0, killed: false };
  });
  const loaded = loadExtension({ executor: executor.execute });
  await callView(loaded.tools.get("gh_view")!, { target: "https://ghe.example.com/team/project" });

  const auth = executor.calls.find((call) => call.argv[0] === "auth");
  assert.deepEqual(auth?.argv, ["auth", "status", "--json", "hosts"]);
  assert.equal(auth?.argv.some((part) => /token|secret|password/i.test(part)), false);
  const view = executor.calls.find((call) => call.argv[0] === "repo");
  assert.deepEqual(view?.argv.slice(0, 3), ["repo", "view", "ghe.example.com/team/project"]);
});

test("an unauthenticated GHES host fails closed before the repository call", async () => {
  const executor = createFakeExecutor((request) => {
    if (request.argv[0] === "--version") return { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false };
    if (request.argv[0] === "auth") {
      return { stdout: JSON.stringify({ hosts: { "other.example.com": [{}] } }), stderr: "", code: 0, killed: false };
    }
    return { stdout: JSON.stringify(REPO_VIEW_JSON), stderr: "", code: 0, killed: false };
  });
  const loaded = loadExtension({ executor: executor.execute });
  await assert.rejects(
    () => callView(loaded.tools.get("gh_view")!, { target: "https://ghe.example.com/team/project" }),
    (error: unknown) => error instanceof GhExecutionError && error.category === "auth",
  );
  assert.equal(executor.calls.some((call) => call.argv[0] === "repo"), false);
});

test("the host allowlist is cached for repeated GHES views", async () => {
  const executor = createFakeExecutor((request) => {
    if (request.argv[0] === "--version") return { stdout: "gh version 2.81.0\n", stderr: "", code: 0, killed: false };
    if (request.argv[0] === "auth") {
      return { stdout: JSON.stringify({ hosts: ["ghe.example.com"] }), stderr: "", code: 0, killed: false };
    }
    return { stdout: JSON.stringify(REPO_VIEW_JSON), stderr: "", code: 0, killed: false };
  });
  const loaded = loadExtension({ executor: executor.execute });
  const tool = loaded.tools.get("gh_view")!;
  await callView(tool, { target: "ghe.example.com/team/project" });
  await callView(tool, { target: "ghe.example.com/team/project" });
  assert.equal(executor.calls.filter((call) => call.argv[0] === "auth").length, 1);
});
