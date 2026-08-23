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
    ref: Type.Optional(
      Type.String({
        description: "Branch, tag, or commit ref. Defaults to the repository default branch; pass this when the file lives elsewhere, or a 404 may result.",
      }),
    ),
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
    limit: Type.Optional(Type.Integer({ description: "Maximum changed files", minimum: 1, maximum: 50, default: 10 })),
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

export const workflowRunStatusValues = [
  "queued",
  "in_progress",
  "completed",
  "requested",
  "waiting",
  "pending",
  "action_required",
] as const;

export const workflowRunConclusionValues = [
  "success",
  "failure",
  "cancelled",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
  "timed_out",
] as const;

export const listWorkflowRunsParameters = Type.Object(
  {
    repo: Type.String({ description: "Repository URL or owner/repo" }),
    workflow: Type.Optional(Type.String({ description: "Workflow name, identifier, or file" })),
    branch: Type.Optional(Type.String({ description: "Branch filter" })),
    status: Type.Optional(
      StringEnum(workflowRunStatusValues, {
        description: "Run status filter (gh run list --status values; a conclusion also works and is mapped for you)",
      }),
    ),
    conclusion: Type.Optional(
      StringEnum(workflowRunConclusionValues, {
        description: "Run conclusion filter (success, failure, cancelled...)",
      }),
    ),
    limit: Type.Optional(Type.Integer({ description: "Maximum runs", minimum: 1, maximum: 50, default: 10 })),
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

export const createPullRequestParameters = Type.Object(
  {
    repo: Type.String({ description: "Repository URL or owner/repo" }),
    title: Type.String({ description: "Pull-request title" }),
    body: Type.Optional(Type.String({ description: "Pull-request body" })),
    head: Type.String({ description: "Head branch" }),
    base: Type.Optional(Type.String({ description: "Base branch" })),
    draft: Type.Optional(Type.Boolean({ description: "Create as draft" })),
    reviewers: stringArrayParameter("Reviewers"),
    assignees: stringArrayParameter("Assignees"),
    labels: stringArrayParameter("Labels"),
  },
  { additionalProperties: false },
);

export const pullRequestCommentParameters = Type.Object(
  { target: Type.String({ description: "Pull-request URL or owner/repo#number" }), body: Type.String({ description: "Comment body" }) },
  { additionalProperties: false },
);

export const editPullRequestParameters = Type.Object(
  {
    target: Type.String({ description: "Pull-request URL or owner/repo#number" }),
    title: Type.Optional(Type.String()),
    body: Type.Optional(Type.String()),
    base: Type.Optional(Type.String()),
    draft: Type.Optional(Type.Boolean()),
    reviewers: stringArrayParameter("Reviewers to add"),
    assignees: stringArrayParameter("Assignees to add"),
    labels: stringArrayParameter("Labels to add"),
  },
  { additionalProperties: false },
);

export const reviewPullRequestParameters = Type.Object(
  {
    target: Type.String({ description: "Pull-request URL or owner/repo#number" }),
    event: StringEnum(["approve", "request_changes", "comment"], { description: "Review action" }),
    body: Type.Optional(Type.String({ description: "Review body" })),
  },
  { additionalProperties: false },
);

export const mergePullRequestParameters = Type.Object(
  {
    target: Type.String({ description: "Pull-request URL or owner/repo#number" }),
    method: StringEnum(["merge", "squash", "rebase"], { description: "Merge method" }),
    deleteBranch: Type.Optional(Type.Boolean({ description: "Delete the head branch after merge" })),
  },
  { additionalProperties: false },
);

export const updatePullRequestBranchParameters = Type.Object(
  { target: Type.String({ description: "Pull-request URL or owner/repo#number" }) },
  { additionalProperties: false },
);

export const dispatchWorkflowParameters = Type.Object(
  {
    repo: Type.String({ description: "Repository URL or owner/repo" }),
    workflow: Type.String({ description: "Workflow file or identifier" }),
    ref: Type.Optional(Type.String({ description: "Branch or ref" })),
    inputs: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Workflow input values" })),
  },
  { additionalProperties: false },
);

export const workflowRunWriteParameters = Type.Object(
  { target: Type.String({ description: "Workflow-run URL" }) },
  { additionalProperties: false },
);

export const createReleaseParameters = Type.Object(
  {
    repo: Type.String({ description: "Repository URL or owner/repo" }),
    tag: Type.String({ description: "Release tag" }),
    title: Type.Optional(Type.String()),
    notes: Type.Optional(Type.String()),
    draft: Type.Optional(Type.Boolean()),
    prerelease: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const editReleaseParameters = Type.Object(
  {
    target: Type.String({ description: "Release URL or owner/repo@tag" }),
    title: Type.Optional(Type.String()),
    notes: Type.Optional(Type.String()),
    draft: Type.Optional(Type.Boolean()),
    prerelease: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const uploadReleaseAssetParameters = Type.Object(
  { target: Type.String({ description: "Release URL or owner/repo@tag" }), path: Type.String({ description: "Local asset path" }), label: Type.Optional(Type.String()) },
  { additionalProperties: false },
);

export const deleteReleaseParameters = Type.Object(
  { target: Type.String({ description: "Release URL or owner/repo@tag" }) },
  { additionalProperties: false },
);

export const deleteReleaseAssetParameters = Type.Object(
  { target: Type.String({ description: "Release URL or owner/repo@tag" }), asset: Type.String({ description: "Release asset name" }) },
  { additionalProperties: false },
);

export const apiGetParameters = Type.Object(
  {
    endpoint: Type.String({ description: "GitHub REST endpoint path, without a host or query string", maxLength: 512 }),
    host: Type.Optional(Type.String({ description: "github.com or an authenticated GHES host" })),
    query: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Typed query parameters", maxProperties: 50 })),
    page: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 1 })),
    perPage: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 50 })),
    cache: Type.Optional(Type.String({ pattern: "^[0-9]+(s|m|h)$" })),
    jq: Type.Optional(Type.String({ description: "Read-only jq projection" })),
    detail: Type.Optional(detailParameter()),
  },
  { additionalProperties: false },
);

export const apiOperationKinds = { gh_api_get: "api_get" } as const;
export type ApiOperationName = keyof typeof apiOperationKinds;
export type ApiKind = (typeof apiOperationKinds)[ApiOperationName];
export const apiOperations: readonly Operation[] = [
  readOperation({ name: "gh_api_get", label: "GitHub API GET", description: "Read a bounded GitHub REST endpoint with a forced GET method and typed query parameters.", aliases: ["github api get", "rest api read", "get github endpoint"], keywords: ["api", "rest", "get", "endpoint", "query", "read"], resourceKind: "api response", verb: "read", parameters: apiGetParameters, argvFixture: ["api", "repos/OWNER/REPO", "--method", "GET"], buildArgv: () => ["api", "repos/OWNER/REPO", "--method", "GET"] }),
];

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

export const pullRequestOperationKinds = {
  gh_create_pull_request: "create_pull_request",
  gh_comment_pull_request: "comment_pull_request",
  gh_edit_pull_request: "edit_pull_request",
  gh_review_pull_request: "review_pull_request",
  gh_close_pull_request: "close_pull_request",
  gh_reopen_pull_request: "reopen_pull_request",
  gh_merge_pull_request: "merge_pull_request",
  gh_update_pull_request_branch: "update_pull_request_branch",
} as const;

export type PullRequestOperationName = keyof typeof pullRequestOperationKinds;
export type PullRequestKind = (typeof pullRequestOperationKinds)[PullRequestOperationName];

export const pullRequestOperations: readonly Operation[] = [
  writeOperation("routine", { name: "gh_create_pull_request", label: "Create Pull Request", description: "Create a pull request with branches, draft state, reviewers, assignees, and labels.", aliases: ["create pull request", "new pull request", "open pull request"], keywords: ["pull", "request", "create", "draft", "reviewers"], resourceKind: "pull request", verb: "create", parameters: createPullRequestParameters, argvFixture: ["pr", "create", "--repo", "OWNER/REPO", "--title", "Title"], buildArgv: () => ["pr", "create", "--repo", "OWNER/REPO"] }),
  writeOperation("routine", { name: "gh_comment_pull_request", label: "Comment on Pull Request", description: "Add a comment to a pull request while preserving body data.", aliases: ["comment pull request", "pull request comment", "comment pr"], keywords: ["pull", "request", "comment", "reply"], resourceKind: "pull request", verb: "comment", parameters: pullRequestCommentParameters, argvFixture: ["pr", "comment", "1", "--repo", "OWNER/REPO"], buildArgv: () => ["pr", "comment", "1", "--repo", "OWNER/REPO"] }),
  writeOperation("routine", { name: "gh_edit_pull_request", label: "Edit Pull Request", description: "Edit pull-request metadata, body, draft state, reviewers, assignees, and labels.", aliases: ["edit pull request", "pull request metadata", "edit pr"], keywords: ["pull", "request", "edit", "draft", "reviewers", "labels"], resourceKind: "pull request", verb: "edit", parameters: editPullRequestParameters, argvFixture: ["pr", "edit", "1", "--repo", "OWNER/REPO"], buildArgv: () => ["pr", "edit", "1", "--repo", "OWNER/REPO"] }),
  writeOperation("guarded", { name: "gh_review_pull_request", label: "Review Pull Request", description: "Submit a pull-request review; approval and request-changes effects require confirmation.", aliases: ["review pull request", "review pr", "approve pull request", "request changes"], keywords: ["pull", "request", "review", "approve", "changes", "comment"], resourceKind: "pull request", verb: "review", parameters: reviewPullRequestParameters, argvFixture: ["pr", "review", "1", "--repo", "OWNER/REPO", "--approve"], buildArgv: () => ["pr", "review", "1", "--repo", "OWNER/REPO"] }),
  writeOperation("guarded", { name: "gh_close_pull_request", label: "Close Pull Request", description: "Close a pull request after confirming the normalized target and lifecycle effect.", aliases: ["close pull request", "close pr"], keywords: ["pull", "request", "close", "lifecycle"], resourceKind: "pull request", verb: "close", parameters: issueStateParameters, argvFixture: ["pr", "close", "1", "--repo", "OWNER/REPO"], buildArgv: () => ["pr", "close", "1", "--repo", "OWNER/REPO"] }),
  writeOperation("routine", { name: "gh_reopen_pull_request", label: "Reopen Pull Request", description: "Reopen a pull request using its normalized target.", aliases: ["reopen pull request", "reopen pr"], keywords: ["pull", "request", "reopen", "open"], resourceKind: "pull request", verb: "reopen", parameters: issueStateParameters, argvFixture: ["pr", "reopen", "1", "--repo", "OWNER/REPO"], buildArgv: () => ["pr", "reopen", "1", "--repo", "OWNER/REPO"] }),
  writeOperation("guarded", { name: "gh_merge_pull_request", label: "Merge Pull Request", description: "Merge a pull request using a confirmed merge method and optional branch deletion.", aliases: ["merge pull request", "merge pr", "squash pull request"], keywords: ["pull", "request", "merge", "squash", "rebase", "branch"], resourceKind: "pull request", verb: "merge", parameters: mergePullRequestParameters, argvFixture: ["pr", "merge", "1", "--repo", "OWNER/REPO", "--squash"], buildArgv: () => ["pr", "merge", "1", "--repo", "OWNER/REPO"] }),
  writeOperation("guarded", { name: "gh_update_pull_request_branch", label: "Update Pull Request Branch", description: "Update a pull-request branch after confirming the compute effect.", aliases: ["update pull request branch", "update pr branch", "sync pull request"], keywords: ["pull", "request", "branch", "update", "sync", "compute"], resourceKind: "pull request", verb: "update branch", parameters: updatePullRequestBranchParameters, argvFixture: ["pr", "update-branch", "1", "--repo", "OWNER/REPO"], buildArgv: () => ["pr", "update-branch", "1", "--repo", "OWNER/REPO"] }),
];

export const actionReleaseOperationKinds = {
  gh_dispatch_workflow: "dispatch_workflow",
  gh_cancel_workflow_run: "cancel_workflow_run",
  gh_rerun_workflow_run: "rerun_workflow_run",
  gh_create_release: "create_release",
  gh_edit_release: "edit_release",
  gh_upload_release_asset: "upload_release_asset",
  gh_delete_release: "delete_release",
  gh_delete_release_asset: "delete_release_asset",
} as const;

export type ActionReleaseOperationName = keyof typeof actionReleaseOperationKinds;
export type ActionReleaseKind = (typeof actionReleaseOperationKinds)[ActionReleaseOperationName];

export const actionReleaseOperations: readonly Operation[] = [
  writeOperation("guarded", { name: "gh_dispatch_workflow", label: "Dispatch Workflow", description: "Dispatch a workflow on a selected ref with typed inputs after confirmation.", aliases: ["dispatch workflow", "run workflow", "workflow dispatch"], keywords: ["workflow", "dispatch", "ref", "inputs", "compute"], resourceKind: "workflow", verb: "dispatch", parameters: dispatchWorkflowParameters, argvFixture: ["workflow", "run", "build.yml", "--repo", "OWNER/REPO"], buildArgv: () => ["workflow", "run", "build.yml"] }),
  writeOperation("guarded", { name: "gh_cancel_workflow_run", label: "Cancel Workflow Run", description: "Cancel a workflow run after confirming the compute effect.", aliases: ["cancel workflow run", "cancel run", "stop workflow"], keywords: ["workflow", "run", "cancel", "stop", "compute"], resourceKind: "workflow run", verb: "cancel", parameters: workflowRunWriteParameters, argvFixture: ["run", "cancel", "1", "--repo", "OWNER/REPO"], buildArgv: () => ["run", "cancel", "1"] }),
  writeOperation("guarded", { name: "gh_rerun_workflow_run", label: "Rerun Workflow Run", description: "Rerun a workflow after confirming the compute effect.", aliases: ["rerun workflow run", "rerun run", "retry workflow"], keywords: ["workflow", "run", "rerun", "retry", "compute"], resourceKind: "workflow run", verb: "rerun", parameters: workflowRunWriteParameters, argvFixture: ["run", "rerun", "1", "--repo", "OWNER/REPO"], buildArgv: () => ["run", "rerun", "1"] }),
  writeOperation("guarded", { name: "gh_create_release", label: "Create Release", description: "Create and publish a release after confirming the publication effect.", aliases: ["create release", "publish release", "new release"], keywords: ["release", "create", "publish", "tag"], resourceKind: "release", verb: "create", parameters: createReleaseParameters, argvFixture: ["release", "create", "v1", "--repo", "OWNER/REPO"], buildArgv: () => ["release", "create", "v1"] }),
  writeOperation("routine", { name: "gh_edit_release", label: "Edit Release", description: "Edit release metadata without changing publication state.", aliases: ["edit release", "release metadata"], keywords: ["release", "edit", "notes", "draft", "prerelease"], resourceKind: "release", verb: "edit", parameters: editReleaseParameters, argvFixture: ["release", "edit", "v1", "--repo", "OWNER/REPO"], buildArgv: () => ["release", "edit", "v1"] }),
  writeOperation("routine", { name: "gh_upload_release_asset", label: "Upload Release Asset", description: "Upload a validated local file to a release.", aliases: ["upload release asset", "release asset", "upload asset"], keywords: ["release", "asset", "upload", "file"], resourceKind: "release asset", verb: "upload", parameters: uploadReleaseAssetParameters, argvFixture: ["release", "upload", "v1", "asset.zip", "--repo", "OWNER/REPO"], buildArgv: () => ["release", "upload", "v1", "asset.zip"] }),
  writeOperation("guarded", { name: "gh_delete_release", label: "Delete Release", description: "Delete a release after confirming the deletion effect.", aliases: ["delete release", "remove release"], keywords: ["release", "delete", "remove"], resourceKind: "release", verb: "delete", parameters: deleteReleaseParameters, argvFixture: ["release", "delete", "v1", "--repo", "OWNER/REPO", "--yes"], buildArgv: () => ["release", "delete", "v1"] }),
  writeOperation("guarded", { name: "gh_delete_release_asset", label: "Delete Release Asset", description: "Delete a release asset after confirming the deletion effect.", aliases: ["delete release asset", "delete asset", "remove asset"], keywords: ["release", "asset", "delete", "remove"], resourceKind: "release asset", verb: "delete", parameters: deleteReleaseAssetParameters, argvFixture: ["release", "delete-asset", "asset.zip", "--repo", "OWNER/REPO", "--yes"], buildArgv: () => ["release", "delete-asset", "asset.zip"] }),
];

export interface OperationRegistry {
  readonly operations: readonly Operation[];
  get(name: string): Operation | undefined;
  searchable(): readonly Operation[];
  search(query: string, limit?: number): Operation[];
}

export function createRegistry(additional: readonly Operation[] = []): OperationRegistry {
  const operations = [viewOperation, findOperation, ...searchOperations, ...contentOperations, ...ciOperations, ...issueOperations, ...pullRequestOperations, ...actionReleaseOperations, ...apiOperations, ...additional];
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
  if (operation.name === "gh_api_get") {
    const explicitApiInterest = terms.some((term) => ["api", "rest", "endpoint", "raw", "escape"].includes(term));
    const getStyle = terms.includes("get");
    const focusedResource = new Set(["issue", "issues", "pull", "pulls", "pr", "pull_request", "repository", "repositories", "repo", "release", "run", "runs", "workflow_run", "job", "jobs", "file", "files", "tree", "directory", "directories", "commit", "commits", "compare", "workflow", "workflows", "checks", "check", "logs", "log", "ci", "diff", "content", "search"]);
    /* The API escape hatch surfaces for "api get ..." queries, and yields to the
     * focused tools when a concrete resource dominates the query (issue 12). */
    const apiLedGet = explicitApiInterest && getStyle;
    if (!apiLedGet && terms.some((term) => focusedResource.has(term))) return 0;
  }
  const name = operation.name.toLowerCase();
  const aliases = operation.aliases.map((value) => value.toLowerCase());
  const keywords = operation.keywords.map((value) => value.toLowerCase());
  const resource = operation.resourceKind.toLowerCase();
  const verb = operation.verb.toLowerCase();
  const description = `${operation.label} ${operation.description}`.toLowerCase();

  // Alias-phrase matches still win: they are the human signal for the operation.
  let score = aliases.some((alias) => alias.replace(/[^a-z0-9]+/g, " ").trim() === terms.join(" ")) ? 300 : 0;

  // gh_view as a generic fallback should never outrank a real operation for a
  // specific action word (comment, close, merge...). Drop its bonus when any
  // verb-style term exists.
  if (operation.name === "gh_view" && terms.some((term) => ["issue", "issues", "pull", "pr", "pull_request", "repository", "repo", "release", "run", "workflow_run", "job", "file", "tree", "commit", "compare"].includes(term))) {
    score += 100;
  }
  if (operation.name === "gh_view" && terms.some((term) => ["comment", "close", "reopen", "merge", "review", "edit", "approve", "checks", "logs", "list", "search", "create", "files", "diff", "update", "branch", "release", "dispatch"].includes(term))) {
    score -= 30; // strong operations should surface above the generic viewer, report issue 12
  }
  /* Asset-publishing verbs shouldn't surface on pure read queries (issue 12). */
  if (
    ["gh_upload_release_asset", "gh_delete_release", "gh_delete_release_asset"].includes(operation.name)
    && terms.some((term) => ["read", "list", "view", "inspect"].includes(term))
  ) {
    score -= 80;
  }

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
