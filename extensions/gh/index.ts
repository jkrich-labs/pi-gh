import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPipeline, createPiExecutor, type GhDependencies } from "./execute.ts";
import { createRegistry, findParameters, type Operation, type OperationRegistry, viewParameters } from "./registry.ts";

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
