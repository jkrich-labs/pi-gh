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

const detailParameter = () =>
  StringEnum(["compact", "expanded"], {
    description: "Projection detail. compact is the default.",
    default: "compact",
  });

export const searchParameters = Type.Object(
  {
    query: Type.String({ description: "Search terms passed to GitHub" }),
    repo: Type.Optional(Type.String({ description: "Optional repository target used to scope the search" })),
    limit: Type.Optional(Type.Integer({ description: "Maximum results", minimum: 1, maximum: 50, default: 10 })),
    page: Type.Optional(Type.Integer({ description: "Result page, capped at 10", minimum: 1, maximum: 10, default: 1 })),
    detail: Type.Optional(detailParameter()),
  },
  { additionalProperties: false },
);

export const readFileParameters = Type.Object(
  {
    repo: Type.String({ description: "Repository URL or owner/repo" }),
    path: Type.String({ description: "Repository-relative file path" }),
    ref: Type.Optional(Type.String({ description: "Branch, tag, or commit ref" })),
    detail: Type.Optional(detailParameter()),
  },
  { additionalProperties: false },
);

export const listDirectoryParameters = Type.Object(
  {
    repo: Type.String({ description: "Repository URL or owner/repo" }),
    path: Type.Optional(Type.String({ description: "Repository-relative directory path" })),
    ref: Type.Optional(Type.String({ description: "Branch, tag, or commit ref" })),
    limit: Type.Optional(Type.Integer({ description: "Maximum directory entries", minimum: 1, maximum: 50, default: 50 })),
    detail: Type.Optional(detailParameter()),
  },
  { additionalProperties: false },
);

export const pullRequestFilesParameters = Type.Object(
  {
    target: Type.String({ description: "Pull-request URL or owner/repo#number" }),
    limit: Type.Optional(Type.Integer({ description: "Maximum changed files", minimum: 1, maximum: 50, default: 30 })),
    page: Type.Optional(Type.Integer({ description: "Result page, capped at 10", minimum: 1, maximum: 10, default: 1 })),
    detail: Type.Optional(detailParameter()),
  },
  { additionalProperties: false },
);

export const pullRequestDiffParameters = Type.Object(
  {
    target: Type.String({ description: "Pull-request URL or owner/repo#number" }),
    detail: Type.Optional(detailParameter()),
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

function readOperation(
  definition: Omit<Operation, "classification" | "decoderFixture" | "projectorFixture" | "decode" | "project">,
): Operation {
  return {
    ...definition,
    classification: "read",
    decoderFixture: identity,
    projectorFixture: identity,
    decode: identity,
    project: identity,
  };
}

export const searchOperationKinds = {
  gh_search_issues: "issues",
  gh_search_pull_requests: "pull_requests",
  gh_search_repositories: "repositories",
  gh_search_code: "code",
  gh_search_commits: "commits",
} as const;

export type SearchOperationName = keyof typeof searchOperationKinds;
export type SearchKind = (typeof searchOperationKinds)[SearchOperationName];

export const searchOperations: readonly Operation[] = [
  readOperation({
    name: "gh_search_issues",
    label: "Search Issues",
    description: "Search GitHub issues with bounded results and optional repository scoping.",
    aliases: ["search issues", "issues", "bug reports", "tickets"],
    keywords: ["search", "issue", "issues", "bug", "open", "closed"],
    resourceKind: "issue",
    verb: "search",
    parameters: searchParameters,
    argvFixture: ["api", "search/issues", "--method", "GET", "--field", "q=bug"],
    buildArgv: () => ["api", "search/issues", "--method", "GET"],
  }),
  readOperation({
    name: "gh_search_pull_requests",
    label: "Search Pull Requests",
    description: "Search GitHub pull requests with bounded results and optional repository scoping.",
    aliases: ["search pull requests", "search prs", "pull requests", "prs", "reviews"],
    keywords: ["search", "pull", "request", "pr", "review", "changes"],
    resourceKind: "pull request",
    verb: "search",
    parameters: searchParameters,
    argvFixture: ["api", "search/issues", "--method", "GET", "--field", "q=is:pr"],
    buildArgv: () => ["api", "search/issues", "--method", "GET"],
  }),
  readOperation({
    name: "gh_search_repositories",
    label: "Search Repositories",
    description: "Search GitHub repositories with bounded results and compact projections.",
    aliases: ["search repositories", "search repos", "repositories", "repos", "projects"],
    keywords: ["search", "repository", "repositories", "repo", "project"],
    resourceKind: "repository",
    verb: "search",
    parameters: searchParameters,
    argvFixture: ["api", "search/repositories", "--method", "GET", "--field", "q=pi"],
    buildArgv: () => ["api", "search/repositories", "--method", "GET"],
  }),
  readOperation({
    name: "gh_search_code",
    label: "Search Code",
    description: "Search GitHub code with bounded results and optional repository scoping.",
    aliases: ["search code", "code search", "source search", "symbols"],
    keywords: ["search", "code", "source", "path", "file"],
    resourceKind: "code",
    verb: "search",
    parameters: searchParameters,
    argvFixture: ["api", "search/code", "--method", "GET", "--field", "q=main"],
    buildArgv: () => ["api", "search/code", "--method", "GET"],
  }),
  readOperation({
    name: "gh_search_commits",
    label: "Search Commits",
    description: "Search GitHub commits with bounded results and compact projections.",
    aliases: ["search commits", "commits", "commit history", "history"],
    keywords: ["search", "commit", "commits", "history", "sha"],
    resourceKind: "commit",
    verb: "search",
    parameters: searchParameters,
    argvFixture: ["api", "search/commits", "--method", "GET", "--field", "q=fix"],
    buildArgv: () => ["api", "search/commits", "--method", "GET"],
  }),
];

export const contentOperations: readonly Operation[] = [
  readOperation({
    name: "gh_read_file",
    label: "Read Repository File",
    description: "Read a repository file at an optional ref without cloning the repository.",
    aliases: ["read file", "file contents", "repository file", "source file"],
    keywords: ["read", "file", "contents", "ref", "blob"],
    resourceKind: "file",
    verb: "read",
    parameters: readFileParameters,
    argvFixture: ["api", "repos/OWNER/REPO/contents/path", "--method", "GET"],
    buildArgv: () => ["api", "repos/OWNER/REPO/contents/path", "--method", "GET"],
  }),
  readOperation({
    name: "gh_list_directory",
    label: "List Repository Directory",
    description: "List a repository directory at an optional ref without cloning the repository.",
    aliases: ["list directory", "directory", "folder", "tree listing"],
    keywords: ["list", "directory", "folder", "tree", "contents"],
    resourceKind: "directory",
    verb: "list",
    parameters: listDirectoryParameters,
    argvFixture: ["api", "repos/OWNER/REPO/contents", "--method", "GET"],
    buildArgv: () => ["api", "repos/OWNER/REPO/contents", "--method", "GET"],
  }),
  readOperation({
    name: "gh_pr_files",
    label: "Pull Request Files",
    description: "List changed files in a pull request with bounded pagination.",
    aliases: ["pull request files", "pr files", "changed files", "file list"],
    keywords: ["pull", "request", "pr", "files", "changes", "diff"],
    resourceKind: "pull request",
    verb: "files",
    parameters: pullRequestFilesParameters,
    argvFixture: ["api", "repos/OWNER/REPO/pulls/1/files", "--method", "GET"],
    buildArgv: () => ["api", "repos/OWNER/REPO/pulls/1/files", "--method", "GET"],
  }),
  readOperation({
    name: "gh_pr_diff",
    label: "Pull Request Diff",
    description: "Inspect a pull request patch with bounded output and truncation fallback.",
    aliases: ["pull request diff", "pr diff", "patch", "changes diff"],
    keywords: ["pull", "request", "pr", "diff", "patch", "changes"],
    resourceKind: "pull request",
    verb: "diff",
    parameters: pullRequestDiffParameters,
    argvFixture: ["pr", "diff", "1", "--repo", "OWNER/REPO"],
    buildArgv: () => ["pr", "diff", "1", "--repo", "OWNER/REPO"],
  }),
];

export interface OperationRegistry {
  readonly operations: readonly Operation[];
  get(name: string): Operation | undefined;
  searchable(): readonly Operation[];
  search(query: string, limit?: number): Operation[];
}

export function createRegistry(additional: readonly Operation[] = []): OperationRegistry {
  const operations = [viewOperation, findOperation, ...searchOperations, ...contentOperations, ...additional];
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
