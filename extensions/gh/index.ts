import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GhExecutionError } from "./errors.ts";
import {
  createPipeline,
  createPiExecutor,
  type ApiGetRequestInput,
  type ActionReleaseRequestInput,
  type ContentRequestInput,
  type GhDependencies,
  type IssueRequestInput,
  type PullRequestRequestInput,
  type SearchRequestInput,
} from "./execute.ts";
import {
  actionReleaseOperationKinds,
  apiGetParameters,
  apiOperationKinds,
  checksParameters,
  createReleaseParameters,
  deleteReleaseAssetParameters,
  deleteReleaseParameters,
  dispatchWorkflowParameters,
  ciOperationKinds,
  createIssueParameters,
  createRegistry,
  editIssueParameters,
  editReleaseParameters,
  failedLogsParameters,
  findParameters,
  issueOperationKinds,
  issueCommentParameters,
  issueStateParameters,
  jobParameters,
  createPullRequestParameters,
  editPullRequestParameters,
  mergePullRequestParameters,
  pullRequestCommentParameters,
  pullRequestOperationKinds,
  reviewPullRequestParameters,
  updatePullRequestBranchParameters,
  listDirectoryParameters,
  pullRequestDiffParameters,
  pullRequestFilesParameters,
  readFileParameters,
  searchParameters,
  uploadReleaseAssetParameters,
  workflowRunWriteParameters,
  listWorkflowRunsParameters,
  workflowRunParameters,
  searchOperationKinds,
  type Operation,
  type ActionReleaseKind,
  type ApiKind,
  type CiKind,
  type OperationRegistry,
  type PullRequestKind,
  type SearchKind,
  viewParameters,
} from "./registry.ts";

export { GhExecutionError, type ErrorCategory } from "./errors.ts";
export {
  createSecureTempOutput,
  type GhDependencies,
  type GhExecRequest,
  type GhExecResult,
} from "./execute.ts";
export { createRegistry, findOperation, viewOperation, type Operation, type OperationRegistry } from "./registry.ts";
export {
  formatHost,
  formatRepositoryTarget,
  isGithubHost,
  normalizeHost,
  resolveResourceTarget,
  type ResourceTarget,
  type ViewResourceKind,
} from "./targets.ts";

export function createGhExtension(overrides: GhDependencies = {}, suppliedRegistry?: OperationRegistry) {
  return (pi: ExtensionAPI) => {
    const executor = overrides.executor ?? createPiExecutor(pi);
    const pipeline = createPipeline({
      executor,
      tempOutput: overrides.tempOutput,
      confirm: overrides.confirm,
    });
    const registry = suppliedRegistry ?? createRegistry();

    for (const operation of registry.operations) {
      if (operation.name === "gh_view") {
        registerViewTool(pi, operation, pipeline);
      } else if (operation.name === "gh_find") {
        registerFindTool(pi, operation, registry);
      } else if (operation.name in searchOperationKinds) {
        registerSearchTool(pi, operation, pipeline, searchOperationKinds[operation.name as keyof typeof searchOperationKinds]);
      } else if (isContentOperation(operation.name)) {
        registerContentTool(pi, operation, pipeline);
      } else if (operation.name in ciOperationKinds) {
        registerCiTool(pi, operation, pipeline, ciOperationKinds[operation.name as keyof typeof ciOperationKinds]);
      } else if (operation.name in issueOperationKinds) {
        registerIssueTool(pi, operation, pipeline, issueOperationKinds[operation.name as keyof typeof issueOperationKinds]);
      } else if (operation.name in pullRequestOperationKinds) {
        registerPullRequestTool(pi, operation, pipeline, pullRequestOperationKinds[operation.name as keyof typeof pullRequestOperationKinds]);
      } else if (operation.name in actionReleaseOperationKinds) {
        registerActionReleaseTool(pi, operation, pipeline, actionReleaseOperationKinds[operation.name as keyof typeof actionReleaseOperationKinds]);
      } else if (operation.name in apiOperationKinds) {
        registerApiTool(pi, operation, pipeline, apiOperationKinds[operation.name as keyof typeof apiOperationKinds]);
      } else {
        registerUnimplementedTool(pi, operation);
      }
    }

    const searchable = new Set(registry.searchable().map((operation) => operation.name));
    /* Activated tools accumulate across gh_find calls so later queries can never
     * evict earlier activations (report issue 13). session_start only trims the
     * initial set, never tools the session itself turned on. */
    let sessionActivations = new Set<string>();
    pi.on("session_start", () => {
      const active = pi.getActiveTools?.() ?? [];
      const initial = active.filter((name) => !searchable.has(name));
      const next = [...new Set([...initial, "gh_view", "gh_find"])];
      sessionActivations = new Set(["gh_view", "gh_find"]);
      pi.setActiveTools?.(next);
    });
  };
}

function registerViewTool(
  pi: ExtensionAPI,
  operation: Operation,
  pipeline: ReturnType<typeof createPipeline>,
): void {
  pi.registerTool({
    name: operation.name,
    label: operation.label,
    description: operation.description,
    promptSnippet: operation.promptSnippet,
    parameters: viewParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { projection, target } = await pipeline.runView(
        {
          target: typeof params.target === "string" ? params.target : undefined,
          kind: typeof params.kind === "string" ? params.kind : undefined,
          detail: params.detail === "expanded" ? "expanded" : "compact",
        },
        { cwd: ctx.cwd, signal },
      );
      return {
        content: [{ type: "text", text: JSON.stringify(projection) }],
        details: { kind: target.kind === "current_checkout" ? "repository" : target.kind, target },
      };
    },
  });
}

function registerFindTool(pi: ExtensionAPI, operation: Operation, registry: OperationRegistry): void {
  pi.registerTool({
    name: operation.name,
    label: operation.label,
    description: operation.description,
    promptSnippet: operation.promptSnippet,
    parameters: findParameters,
    async execute(_toolCallId, params) {
      const matches = registry.search(params.query, params.limit ?? 3);
      const active = pi.getActiveTools?.() ?? [];
      const names = matches.map((match) => match.name);
      const activated = names.filter((name) => !active.includes(name));
      /* Merge with prior session activations so later gh_find calls add to the
       * working set instead of silently dropping tools activated earlier. */
      if (activated.length > 0) pi.setActiveTools?.([...new Set([...active, ...activated])]);

      const projections = matches.map((match) => ({
        name: match.name,
        label: match.label,
        purpose: match.description,
        resourceKind: match.resourceKind,
        verb: match.verb,
        classification: match.classification,
      }));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              query: params.query,
              matches: projections,
              activated,
              alreadyActive: names.filter((name) => active.includes(name)),
            }),
          },
        ],
        details: { query: params.query, matches: names, activated },
      };
    },
  });
}

function registerSearchTool(
  pi: ExtensionAPI,
  operation: Operation,
  pipeline: ReturnType<typeof createPipeline>,
  kind: SearchKind,
): void {
  pi.registerTool({
    name: operation.name,
    label: operation.label,
    description: operation.description,
    parameters: searchParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const input = params as SearchRequestInput;
      const { projection, target } = await pipeline.runSearch(
        { ...input, kind },
        { cwd: ctx.cwd, signal },
      );
      return {
        content: [{ type: "text", text: JSON.stringify(projection) }],
        details: { kind: `search_${kind}`, target },
      };
    },
  });
}

function registerContentTool(pi: ExtensionAPI, operation: Operation, pipeline: ReturnType<typeof createPipeline>): void {
  const schema = operation.name === "gh_read_file"
    ? readFileParameters
    : operation.name === "gh_list_directory"
      ? listDirectoryParameters
      : operation.name === "gh_pr_files"
        ? pullRequestFilesParameters
        : pullRequestDiffParameters;
  const kind = operation.name === "gh_read_file"
    ? "read_file"
    : operation.name === "gh_list_directory"
      ? "list_directory"
      : operation.name === "gh_pr_files"
        ? "pr_files"
        : "pr_diff";
  pi.registerTool({
    name: operation.name,
    label: operation.label,
    description: operation.description,
    parameters: schema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const values = params as Record<string, unknown>;
      const input: ContentRequestInput = {
        kind,
        repo: typeof values.repo === "string" ? values.repo : undefined,
        path: typeof values.path === "string" ? values.path : undefined,
        ref: typeof values.ref === "string" ? values.ref : undefined,
        target: typeof values.target === "string" ? values.target : undefined,
        limit: typeof values.limit === "number" ? values.limit : undefined,
        page: typeof values.page === "number" ? values.page : undefined,
        detail: values.detail === "expanded" ? "expanded" : "compact",
      };
      const { projection, target } = await pipeline.runContent(input, { cwd: ctx.cwd, signal });
      return {
        content: [{ type: "text", text: JSON.stringify(projection) }],
        details: { kind, target },
      };
    },
  });
}

function isContentOperation(name: string): boolean {
  return name === "gh_read_file" || name === "gh_list_directory" || name === "gh_pr_files" || name === "gh_pr_diff";
}

function registerCiTool(pi: ExtensionAPI, operation: Operation, pipeline: ReturnType<typeof createPipeline>, kind: CiKind): void {
  const schema = operation.name === "gh_list_workflow_runs"
    ? listWorkflowRunsParameters
    : operation.name === "gh_view_workflow_run"
      ? workflowRunParameters
      : operation.name === "gh_view_job"
        ? jobParameters
        : operation.name === "gh_pr_checks"
          ? checksParameters
          : failedLogsParameters;
  pi.registerTool({
    name: operation.name,
    label: operation.label,
    description: operation.description,
    parameters: schema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const values = params as Record<string, unknown>;
      const input = {
        kind,
        repo: typeof values.repo === "string" ? values.repo : undefined,
        workflow: typeof values.workflow === "string" ? values.workflow : undefined,
        branch: typeof values.branch === "string" ? values.branch : undefined,
        status: typeof values.status === "string" ? values.status : undefined,
        conclusion: typeof values.conclusion === "string" ? values.conclusion : undefined,
        target: typeof values.target === "string" ? values.target : undefined,
        attempt: typeof values.attempt === "number" ? values.attempt : undefined,
        step: typeof values.step === "string" ? values.step : undefined,
        maxLines: typeof values.maxLines === "number" ? values.maxLines : undefined,
        maxBytes: typeof values.maxBytes === "number" ? values.maxBytes : undefined,
        limit: typeof values.limit === "number" ? values.limit : undefined,
        page: typeof values.page === "number" ? values.page : undefined,
        detail: values.detail === "expanded" ? "expanded" as const : "compact" as const,
      };
      const { projection, target } = await pipeline.runCi(input, { cwd: ctx.cwd, signal });
      return {
        content: [{ type: "text", text: JSON.stringify(projection) }],
        details: { kind, target },
      };
    },
  });
}

function registerIssueTool(pi: ExtensionAPI, operation: Operation, pipeline: ReturnType<typeof createPipeline>, kind: IssueRequestInput["kind"]): void {
  const schema = operation.name === "gh_create_issue"
    ? createIssueParameters
    : operation.name === "gh_comment_issue"
      ? issueCommentParameters
      : operation.name === "gh_edit_issue"
        ? editIssueParameters
        : issueStateParameters;
  pi.registerTool({
    name: operation.name,
    label: operation.label,
    description: operation.description,
    parameters: schema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const values = params as Record<string, unknown>;
      const extensionContext = ctx as unknown as { ui?: { confirm(title: string, message: string): Promise<boolean> } };
      const input: IssueRequestInput = {
        kind,
        repo: typeof values.repo === "string" ? values.repo : undefined,
        target: typeof values.target === "string" ? values.target : undefined,
        title: typeof values.title === "string" ? values.title : undefined,
        body: typeof values.body === "string" ? values.body : undefined,
        assignees: Array.isArray(values.assignees) ? values.assignees.filter((value): value is string => typeof value === "string") : undefined,
        labels: Array.isArray(values.labels) ? values.labels.filter((value): value is string => typeof value === "string") : undefined,
        milestone: typeof values.milestone === "string" ? values.milestone : undefined,
      };
      const { projection, target } = await pipeline.runIssueWrite(input, {
        cwd: ctx.cwd,
        signal,
        hasUI: ctx.hasUI,
        confirm: extensionContext.ui?.confirm,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(projection) }],
        details: { kind, target },
      };
    },
  });
}

function registerPullRequestTool(pi: ExtensionAPI, operation: Operation, pipeline: ReturnType<typeof createPipeline>, kind: PullRequestKind): void {
  const schema = operation.name === "gh_create_pull_request"
    ? createPullRequestParameters
    : operation.name === "gh_comment_pull_request"
      ? pullRequestCommentParameters
      : operation.name === "gh_edit_pull_request"
        ? editPullRequestParameters
        : operation.name === "gh_review_pull_request"
          ? reviewPullRequestParameters
          : operation.name === "gh_merge_pull_request"
            ? mergePullRequestParameters
            : operation.name === "gh_update_pull_request_branch"
              ? updatePullRequestBranchParameters
              : issueStateParameters;
  pi.registerTool({
    name: operation.name,
    label: operation.label,
    description: operation.description,
    parameters: schema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const values = params as Record<string, unknown>;
      const input: PullRequestRequestInput = {
        kind,
        repo: typeof values.repo === "string" ? values.repo : undefined,
        target: typeof values.target === "string" ? values.target : undefined,
        title: typeof values.title === "string" ? values.title : undefined,
        body: typeof values.body === "string" ? values.body : undefined,
        head: typeof values.head === "string" ? values.head : undefined,
        base: typeof values.base === "string" ? values.base : undefined,
        draft: typeof values.draft === "boolean" ? values.draft : undefined,
        reviewers: Array.isArray(values.reviewers) ? values.reviewers.filter((value): value is string => typeof value === "string") : undefined,
        assignees: Array.isArray(values.assignees) ? values.assignees.filter((value): value is string => typeof value === "string") : undefined,
        labels: Array.isArray(values.labels) ? values.labels.filter((value): value is string => typeof value === "string") : undefined,
        event: values.event === "approve" || values.event === "request_changes" || values.event === "comment" ? values.event : undefined,
        method: values.method === "merge" || values.method === "squash" || values.method === "rebase" ? values.method : undefined,
        deleteBranch: typeof values.deleteBranch === "boolean" ? values.deleteBranch : undefined,
      };
      const extensionContext = ctx as unknown as { ui?: { confirm(title: string, message: string): Promise<boolean> } };
      const { projection, target } = await pipeline.runPullRequestWrite(input, { cwd: ctx.cwd, signal, hasUI: ctx.hasUI, confirm: extensionContext.ui?.confirm });
      return { content: [{ type: "text", text: JSON.stringify(projection) }], details: { kind, target } };
    },
  });
}

function registerActionReleaseTool(pi: ExtensionAPI, operation: Operation, pipeline: ReturnType<typeof createPipeline>, kind: ActionReleaseKind): void {
  const schema = operation.name === "gh_dispatch_workflow"
    ? dispatchWorkflowParameters
    : operation.name === "gh_cancel_workflow_run" || operation.name === "gh_rerun_workflow_run"
      ? workflowRunWriteParameters
      : operation.name === "gh_create_release"
        ? createReleaseParameters
        : operation.name === "gh_edit_release"
          ? editReleaseParameters
          : operation.name === "gh_upload_release_asset"
            ? uploadReleaseAssetParameters
            : operation.name === "gh_delete_release"
              ? deleteReleaseParameters
              : deleteReleaseAssetParameters;
  pi.registerTool({
    name: operation.name,
    label: operation.label,
    description: operation.description,
    parameters: schema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const values = params as Record<string, unknown>;
      const input: ActionReleaseRequestInput = {
        kind,
        repo: typeof values.repo === "string" ? values.repo : undefined,
        workflow: typeof values.workflow === "string" ? values.workflow : undefined,
        ref: typeof values.ref === "string" ? values.ref : undefined,
        inputs: values.inputs && typeof values.inputs === "object" ? Object.fromEntries(Object.entries(values.inputs).filter(([, value]) => typeof value === "string")) as Record<string, string> : undefined,
        target: typeof values.target === "string" ? values.target : undefined,
        tag: typeof values.tag === "string" ? values.tag : undefined,
        title: typeof values.title === "string" ? values.title : undefined,
        notes: typeof values.notes === "string" ? values.notes : undefined,
        draft: typeof values.draft === "boolean" ? values.draft : undefined,
        prerelease: typeof values.prerelease === "boolean" ? values.prerelease : undefined,
        path: typeof values.path === "string" ? values.path : undefined,
        label: typeof values.label === "string" ? values.label : undefined,
        asset: typeof values.asset === "string" ? values.asset : undefined,
      };
      const extensionContext = ctx as unknown as { ui?: { confirm(title: string, message: string): Promise<boolean> } };
      const { projection, target } = await pipeline.runActionReleaseWrite(input, { cwd: ctx.cwd, signal, hasUI: ctx.hasUI, confirm: extensionContext.ui?.confirm });
      return { content: [{ type: "text", text: JSON.stringify(projection) }], details: { kind, target } };
    },
  });
}

function registerApiTool(pi: ExtensionAPI, operation: Operation, pipeline: ReturnType<typeof createPipeline>, kind: ApiKind): void {
  pi.registerTool({
    name: operation.name,
    label: operation.label,
    description: operation.description,
    parameters: apiGetParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const values = params as Record<string, unknown>;
      const allowed = new Set(["endpoint", "host", "query", "page", "perPage", "cache", "jq", "detail"]);
      const unknown = Object.keys(values).find((key) => !allowed.has(key));
      if (unknown) throw new GhExecutionError("validation", `Unsupported GitHub API GET parameter: ${unknown}`);
      const input: ApiGetRequestInput = {
        kind,
        endpoint: typeof values.endpoint === "string" ? values.endpoint : "",
        host: typeof values.host === "string" ? values.host : undefined,
        query: values.query && typeof values.query === "object" ? (() => {
          const entries = Object.entries(values.query);
          if (entries.some(([, value]) => typeof value !== "string")) throw new GhExecutionError("validation", "API GET query parameters must be strings.");
          return Object.fromEntries(entries) as Record<string, string>;
        })() : undefined,
        page: typeof values.page === "number" ? values.page : undefined,
        perPage: typeof values.perPage === "number" ? values.perPage : undefined,
        cache: typeof values.cache === "string" ? values.cache : undefined,
        jq: typeof values.jq === "string" ? values.jq : undefined,
        detail: values.detail === "compact" || values.detail === "expanded" ? values.detail : undefined,
      };
      const { projection, target } = await pipeline.runApiGet(input, { cwd: ctx.cwd, signal });
      return { content: [{ type: "text", text: JSON.stringify(projection) }], details: { kind, target } };
    },
  });
}

function registerUnimplementedTool(pi: ExtensionAPI, operation: Operation): void {
  pi.registerTool({
    name: operation.name,
    label: operation.label,
    description: operation.description,
    parameters: operation.parameters,
    async execute() {
      throw new Error(`${operation.name} is registered but its implementation is not loaded.`);
    },
  });
}

export default function ghExtension(pi: ExtensionAPI) {
  createGhExtension()(pi);
}
