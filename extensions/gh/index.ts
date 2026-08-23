import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createPipeline,
  createPiExecutor,
  type ContentRequestInput,
  type GhDependencies,
  type SearchRequestInput,
} from "./execute.ts";
import {
  checksParameters,
  ciOperationKinds,
  createRegistry,
  failedLogsParameters,
  findParameters,
  jobParameters,
  listDirectoryParameters,
  pullRequestDiffParameters,
  pullRequestFilesParameters,
  readFileParameters,
  searchParameters,
  listWorkflowRunsParameters,
  workflowRunParameters,
  searchOperationKinds,
  type Operation,
  type CiKind,
  type OperationRegistry,
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
      } else {
        registerUnimplementedTool(pi, operation);
      }
    }

    const searchable = new Set(registry.searchable().map((operation) => operation.name));
    const active = pi.getActiveTools?.() ?? [];
    const initial = active.filter((name) => !searchable.has(name));
    const next = [...new Set([...initial, "gh_view", "gh_find"])];
    pi.setActiveTools?.(next);
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
