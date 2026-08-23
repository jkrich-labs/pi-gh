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

export const listWorkflowRunsParameters = Type.Object(
  {
    repo: Type.String({ description: "Repository URL or owner/repo" }),
    workflow: Type.Optional(Type.String({ description: "Workflow name or identifier" })),
    branch: Type.Optional(Type.String({ description: "Branch filter" })),
    status: Type.Optional(Type.String({ description: "Run status filter" })),
    conclusion: Type.Optional(Type.String({ description: "Run conclusion filter" })),
    limit: Type.Optional(Type.Integer({ description: "Maximum runs", minimum: 1, maximum: 50, default: 20 })),
    page: Type.Optional(Type.Integer({ description: "Result page, capped at 10", minimum: 1, maximum: 10, default: 1 })),
    detail: Type.Optional(detailParameter()),
  },
  { additionalProperties: false },
);

export const workflowRunParameters = Type.Object(
  {
    target: Type.String({ description: "Workflow-run URL" }),
    attempt: Type.Optional(Type.Integer({ description: "Workflow attempt number", minimum: 1, maximum: 100 })),
    detail: Type.Optional(detailParameter()),
  },
  { additionalProperties: false },
);

export const jobParameters = Type.Object(
  {
    target: Type.String({ description: "Workflow-job URL" }),
    detail: Type.Optional(detailParameter()),
  },
  { additionalProperties: false },
);

export const checksParameters = Type.Object(
  {
    target: Type.String({ description: "Pull-request URL or owner/repo#number" }),
    detail: Type.Optional(detailParameter()),
  },
  { additionalProperties: false },
);

export const failedLogsParameters = Type.Object(
  {
    target: Type.String({ description: "Workflow-run or job URL" }),
    step: Type.Optional(Type.String({ description: "Failed step name to select" })),
    maxLines: Type.Optional(Type.Integer({ description: "Maximum log lines", minimum: 1, maximum: 10000, default: 500 })),
    maxBytes: Type.Optional(Type.Integer({ description: "Maximum log bytes", minimum: 1, maximum: 1000000, default: 100000 })),
    detail: Type.Optional(detailParameter()),
  },
  { additionalProperties: false },
);

const stringArrayParameter = (description: string) => Type.Optional(Type.Array(Type.String(), { description, maxItems: 20 }));

export const createIssueParameters = Type.Object(
  {
    repo: Type.String({ description: "Repository URL or owner/repo" }),
    title: Type.String({ description: "Issue title" }),
    body: Type.Optional(Type.String({ description: "Issue body" })),
    assignees: stringArrayParameter("Users to assign"),
    labels: stringArrayParameter("Labels to add"),
    milestone: Type.Optional(Type.String({ description: "Milestone name" })),
  },
  { additionalProperties: false },
);

export const issueCommentParameters = Type.Object(
  {
    target: Type.String({ description: "Issue URL or owner/repo#number" }),
    body: Type.String({ description: "Comment body" }),
  },
  { additionalProperties: false },
);

export const editIssueParameters = Type.Object(
  {
    target: Type.String({ description: "Issue URL or owner/repo#number" }),
    title: Type.Optional(Type.String({ description: "Replacement issue title" })),
    body: Type.Optional(Type.String({ description: "Replacement issue body" })),
    assignees: stringArrayParameter("Users to assign"),
    labels: stringArrayParameter("Labels to add"),
    milestone: Type.Optional(Type.String({ description: "Milestone name" })),
  },
  { additionalProperties: false },
);

export const issueStateParameters = Type.Object(
  { target: Type.String({ description: "Issue URL or owner/repo#number" }) },
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

function operationWithClass(
  classification: GuardClass,
  definition: Omit<Operation, "classification" | "decoderFixture" | "projectorFixture" | "decode" | "project">,
): Operation {
  return {
    ...definition,
    classification,
    decoderFixture: identity,
    projectorFixture: identity,
    decode: identity,
    project: identity,
  };
}

function readOperation(
  definition: Omit<Operation, "classification" | "decoderFixture" | "projectorFixture" | "decode" | "project">,
): Operation {
  return operationWithClass("read", definition);
}

function writeOperation(
  classification: "routine" | "guarded",
  definition: Omit<Operation, "classification" | "decoderFixture" | "projectorFixture" | "decode" | "project">,
): Operation {
  return operationWithClass(classification, definition);
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

export const ciOperationKinds = {
  gh_list_workflow_runs: "list_runs",
  gh_view_workflow_run: "view_run",
  gh_view_job: "view_job",
  gh_pr_checks: "pr_checks",
  gh_failed_logs: "failed_logs",
} as const;

export type CiOperationName = keyof typeof ciOperationKinds;
export type CiKind = (typeof ciOperationKinds)[CiOperationName];

export const ciOperations: readonly Operation[] = [
  readOperation({
    name: "gh_list_workflow_runs",
    label: "List Workflow Runs",
    description: "List bounded workflow runs for a repository with filters and conclusions.",
    aliases: ["list workflow runs", "workflow runs", "actions runs", "ci runs"],
    keywords: ["workflow", "run", "runs", "actions", "ci", "builds"],
    resourceKind: "workflow run",
    verb: "list",
    parameters: listWorkflowRunsParameters,
    argvFixture: ["api", "repos/OWNER/REPO/actions/runs", "--method", "GET"],
    buildArgv: () => ["api", "repos/OWNER/REPO/actions/runs", "--method", "GET"],
  }),
  readOperation({
    name: "gh_view_workflow_run",
    label: "View Workflow Run",
    description: "Inspect one workflow run, including a selected attempt and conclusion.",
    aliases: ["view workflow run", "workflow run details", "run details"],
    keywords: ["workflow", "run", "attempt", "status", "conclusion"],
    resourceKind: "workflow run",
    verb: "view",
    parameters: workflowRunParameters,
    argvFixture: ["run", "view", "1", "--json"],
    buildArgv: () => ["run", "view", "1", "--json"],
  }),
  readOperation({
    name: "gh_view_job",
    label: "View Workflow Job",
    description: "Inspect a workflow job and its step conclusions.",
    aliases: ["view job", "workflow job", "job details"],
    keywords: ["job", "workflow", "step", "steps", "conclusion"],
    resourceKind: "job",
    verb: "view",
    parameters: jobParameters,
    argvFixture: ["run", "view", "1", "--job", "2", "--json"],
    buildArgv: () => ["run", "view", "1", "--job", "2", "--json"],
  }),
  readOperation({
    name: "gh_pr_checks",
    label: "Pull Request Checks",
    description: "View pull-request checks with success, failure, and pending conclusions.",
    aliases: ["pull request checks", "pr checks", "checks", "status checks"],
    keywords: ["pull", "request", "pr", "checks", "pending", "failure", "success"],
    resourceKind: "pull request",
    verb: "checks",
    parameters: checksParameters,
    argvFixture: ["pr", "checks", "1", "--json"],
    buildArgv: () => ["pr", "checks", "1", "--json"],
  }),
  readOperation({
    name: "gh_failed_logs",
    label: "Failed Workflow Logs",
    description: "Retrieve bounded failed workflow logs and select a named failed step.",
    aliases: ["failed logs", "workflow logs", "ci logs", "failure logs"],
    keywords: ["logs", "failed", "failure", "step", "diagnose", "debug"],
    resourceKind: "workflow logs",
    verb: "read",
    parameters: failedLogsParameters,
    argvFixture: ["run", "view", "1", "--log-failed"],
    buildArgv: () => ["run", "view", "1", "--log-failed"],
  }),
];

export const issueOperationKinds = {
  gh_create_issue: "create_issue",
  gh_comment_issue: "comment_issue",
  gh_edit_issue: "edit_issue",
  gh_close_issue: "close_issue",
  gh_reopen_issue: "reopen_issue",
} as const;

export type IssueOperationName = keyof typeof issueOperationKinds;
export type IssueKind = (typeof issueOperationKinds)[IssueOperationName];

export const issueOperations: readonly Operation[] = [
  writeOperation("routine", {
    name: "gh_create_issue",
    label: "Create Issue",
    description: "Create an issue with a title, body, labels, and assignees.",
    aliases: ["create issue", "new issue", "open issue"],
    keywords: ["issue", "create", "new", "title", "body", "labels", "assignees"],
    resourceKind: "issue",
    verb: "create",
    parameters: createIssueParameters,
    argvFixture: ["issue", "create", "--repo", "OWNER/REPO", "--title", "Title"],
    buildArgv: () => ["issue", "create", "--repo", "OWNER/REPO", "--title", "Title"],
  }),
  writeOperation("routine", {
    name: "gh_comment_issue",
    label: "Comment on Issue",
    description: "Add a comment to an issue while preserving the body as data.",
    aliases: ["comment on issue", "issue comment", "comment issue"],
    keywords: ["issue", "comment", "reply", "body"],
    resourceKind: "issue",
    verb: "comment",
    parameters: issueCommentParameters,
    argvFixture: ["issue", "comment", "1", "--repo", "OWNER/REPO", "--body", "text"],
    buildArgv: () => ["issue", "comment", "1", "--repo", "OWNER/REPO", "--body", "text"],
  }),
  writeOperation("routine", {
    name: "gh_edit_issue",
    label: "Edit Issue",
    description: "Edit issue metadata, including title, body, assignees, labels, and milestone.",
    aliases: ["edit issue", "assign issue", "label issue", "issue metadata"],
    keywords: ["issue", "edit", "assign", "assignee", "label", "labels", "milestone"],
    resourceKind: "issue",
    verb: "edit",
    parameters: editIssueParameters,
    argvFixture: ["issue", "edit", "1", "--repo", "OWNER/REPO"],
    buildArgv: () => ["issue", "edit", "1", "--repo", "OWNER/REPO"],
  }),
  writeOperation("guarded", {
    name: "gh_close_issue",
    label: "Close Issue",
    description: "Close an issue after confirming the normalized target and lifecycle effect.",
    aliases: ["close issue", "resolve issue"],
    keywords: ["issue", "close", "resolve", "lifecycle"],
    resourceKind: "issue",
    verb: "close",
    parameters: issueStateParameters,
    argvFixture: ["issue", "close", "1", "--repo", "OWNER/REPO"],
    buildArgv: () => ["issue", "close", "1", "--repo", "OWNER/REPO"],
  }),
  writeOperation("routine", {
    name: "gh_reopen_issue",
    label: "Reopen Issue",
    description: "Reopen an issue using its normalized target.",
    aliases: ["reopen issue", "open issue again"],
    keywords: ["issue", "reopen", "open", "lifecycle"],
    resourceKind: "issue",
    verb: "reopen",
    parameters: issueStateParameters,
    argvFixture: ["issue", "reopen", "1", "--repo", "OWNER/REPO"],
    buildArgv: () => ["issue", "reopen", "1", "--repo", "OWNER/REPO"],
  }),
];

export interface OperationRegistry {
  readonly operations: readonly Operation[];
  get(name: string): Operation | undefined;
  searchable(): readonly Operation[];
  search(query: string, limit?: number): Operation[];
}

export function createRegistry(additional: readonly Operation[] = []): OperationRegistry {
  const operations = [viewOperation, findOperation, ...searchOperations, ...contentOperations, ...ciOperations, ...issueOperations, ...additional];
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
  let score = aliases.some((alias) => alias.replace(/[^a-z0-9]+/g, " ").trim() === terms.join(" ")) ? 300 : 0;

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
