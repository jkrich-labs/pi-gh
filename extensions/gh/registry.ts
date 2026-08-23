import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type TSchema } from "typebox";
import type { ViewResourceKind } from "./targets.ts";

export type GuardClass = "read" | "routine" | "guarded";

export interface Operation {
  name: string;
  label: string;
  description: string;
  aliases: string[];
  keywords: string[];
  resourceKind: string;
  verb: string;
  classification: GuardClass;
  parameters: TSchema;
  /** A representative argv shape used by registry contract tests and documentation. */
  argvFixture: readonly string[];
  /** A deterministic decoder fixture for contract tests. */
  decoderFixture: (raw: unknown) => unknown;
  /** A deterministic projector fixture for contract tests. */
  projectorFixture: (decoded: unknown) => unknown;
  /** Compatibility names for operation implementations added by later slices. */
  buildArgv?: (input: unknown) => readonly string[];
  decode?: (raw: unknown) => unknown;
  project?: (decoded: unknown) => unknown;
  promptSnippet?: string;
}

export const VIEW_RESOURCE_KINDS: readonly ViewResourceKind[] = [
  "repository",
  "issue",
  "pull_request",
  "commit",
  "release",
  "workflow_run",
  "job",
  "file",
  "tree",
  "compare",
];

export const viewParameters = Type.Object(
  {
    target: Type.Optional(
      Type.String({
        description: "GitHub resource target: URL, owner/repo, or omit for the current checkout",
      }),
    ),
    kind: Type.Optional(
      StringEnum(VIEW_RESOURCE_KINDS, {
        description: "Resource kind when an identifier is ambiguous, such as owner/repo#123",
      }),
    ),
    detail: Type.Optional(
      StringEnum(["compact", "expanded"], {
        description: "Projection detail. compact is the default.",
        default: "compact",
      }),
    ),
  },
  { additionalProperties: false },
);

export const findParameters = Type.Object(
  {
    query: Type.String({ description: "Capability, resource, or GitHub action to find" }),
    limit: Type.Optional(
      Type.Integer({ description: "Maximum exact tools to activate", minimum: 1, maximum: 5, default: 3 }),
    ),
  },
  { additionalProperties: false },
);

function identity(value: unknown): unknown {
  return value;
}

const viewFixture = ["repo", "view", "cli/cli", "--json", "name,nameWithOwner"] as const;

export const viewOperation: Operation = {
  name: "gh_view",
  label: "GitHub View",
  description: "Inspect a GitHub repository or resource from a URL, identifier, or current checkout.",
  aliases: ["view", "inspect", "show", "repository", "repo", "pr", "pull", "issue", "commit", "release", "run", "job", "file", "tree", "compare"],
  keywords: [
    "github",
    "repository",
    "repo",
    "pull_request",
    "pull request",
    "pr",
    "workflow_run",
    "workflow",
    "run",
    "ci",
    ...VIEW_RESOURCE_KINDS,
    "url",
    "target",
  ],
  resourceKind: "github resource",
  verb: "view",
  classification: "read",
  parameters: viewParameters,
  argvFixture: viewFixture,
  decoderFixture: identity,
  projectorFixture: identity,
  buildArgv: () => viewFixture,
  decode: identity,
  project: identity,
  promptSnippet: "Inspect a GitHub resource target",
};

export const findOperation: Operation = {
  name: "gh_find",
  label: "GitHub Find",
  description: "Find and activate the smallest ranked set of exact GitHub operation tools for a task.",
  aliases: ["find", "search tools", "load tools", "discover"],
  keywords: ["capability", "operation", "tool", "activate", "load", "discover"],
  resourceKind: "operation",
  verb: "find",
  classification: "read",
  parameters: findParameters,
  argvFixture: [],
  decoderFixture: identity,
  projectorFixture: identity,
  buildArgv: () => [],
  decode: identity,
  project: identity,
  promptSnippet: "Find additional GitHub tools when the active tools are insufficient",
};

export interface OperationRegistry {
  readonly operations: readonly Operation[];
  get(name: string): Operation | undefined;
  searchable(): readonly Operation[];
  search(query: string, limit?: number): Operation[];
}

export function createRegistry(additional: readonly Operation[] = []): OperationRegistry {
  const operations = [viewOperation, findOperation, ...additional];
  const names = new Set<string>();
  for (const operation of operations) {
    if (!/^gh_[a-z0-9_]+$/.test(operation.name)) {
      throw new Error(`Operation names must use the gh_ prefix: ${operation.name}`);
    }
    if (names.has(operation.name)) throw new Error(`Duplicate operation name: ${operation.name}`);
    names.add(operation.name);
  }

  return {
    operations,
    get(name: string) {
      return operations.find((operation) => operation.name === name);
    },
    searchable() {
      return operations.filter((operation) => operation.name !== findOperation.name);
    },
    search(query: string, limit = 3) {
      const terms = tokenize(query);
      if (terms.length === 0) return [];
      const max = Math.max(1, Math.min(5, Math.trunc(limit)));
      return operations
        .filter((operation) => operation.name !== findOperation.name)
        .map((operation, index) => ({ operation, index, score: scoreOperation(operation, terms) }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score || left.index - right.index || left.operation.name.localeCompare(right.operation.name))
        .slice(0, max)
        .map((entry) => entry.operation);
    },
  };
}

function tokenize(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
}

function scoreOperation(operation: Operation, terms: string[]): number {
  const name = operation.name.toLowerCase();
  const aliases = operation.aliases.map((value) => value.toLowerCase());
  const keywords = operation.keywords.map((value) => value.toLowerCase());
  const resource = operation.resourceKind.toLowerCase();
  const verb = operation.verb.toLowerCase();
  const description = `${operation.label} ${operation.description}`.toLowerCase();
  let score = 0;

  for (const term of terms) {
    if (name === term || name.replace(/^gh_/, "") === term) score += 100;
    if (aliases.includes(term)) score += 70;
    if (keywords.includes(term)) score += 45;
    if (resource.split(/[^a-z0-9_]+/).includes(term)) score += 35;
    if (verb === term) score += 30;
    if (description.split(/[^a-z0-9_]+/).includes(term)) score += 20;
    if (name.includes(term)) score += 10;
    if (aliases.some((alias) => alias.includes(term))) score += 8;
    if (description.includes(term)) score += 3;
  }
  return score;
}
