import assert from "node:assert/strict";
import { test } from "node:test";
import { createRegistry } from "../extensions/gh/index.ts";

type TSchemaLike = { type?: string; additionalProperties?: unknown };

test("every registered operation has strict metadata and executable contract fixtures", () => {
  const registry = createRegistry();
  const names = new Set<string>();
  for (const operation of registry.operations) {
    assert.match(operation.name, /^gh_[a-z0-9_]+$/);
    assert.equal(names.has(operation.name), false);
    names.add(operation.name);
    assert.ok(operation.label);
    assert.ok(operation.description);
    assert.ok(operation.aliases.length > 0);
    assert.ok(operation.resourceKind);
    assert.ok(operation.verb);
    assert.ok(["read", "routine", "guarded"].includes(operation.classification));
    const schema = operation.parameters as TSchemaLike;
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.ok(Array.isArray(operation.argvFixture));
    assert.equal(typeof operation.decoderFixture, "function");
    assert.equal(typeof operation.projectorFixture, "function");
    const decoded = operation.decoderFixture({ fixture: true });
    assert.deepEqual(operation.projectorFixture(decoded), { fixture: true });
  }
});

test("focused release and issue-comment reads have bounded strict registry fixtures", () => {
  const registry = createRegistry();
  const releases = registry.get("gh_list_releases");
  const comments = registry.get("gh_issue_comments");
  assert.equal(releases?.classification, "read");
  assert.equal(comments?.classification, "read");
  assert.deepEqual(releases?.argvFixture, ["api", "repos/OWNER/REPO/releases", "--method", "GET"]);
  assert.deepEqual(comments?.argvFixture, ["api", "repos/OWNER/REPO/issues/1/comments", "--method", "GET"]);
  const releaseSchema = releases?.parameters as { properties?: Record<string, { minimum?: number; maximum?: number }> };
  const commentSchema = comments?.parameters as { properties?: Record<string, { minimum?: number; maximum?: number }> };
  assert.equal(releaseSchema.properties?.limit?.minimum, 1);
  assert.equal(releaseSchema.properties?.limit?.maximum, 50);
  assert.equal(commentSchema.properties?.page?.minimum, 1);
  assert.equal(commentSchema.properties?.page?.maximum, 10);
});
