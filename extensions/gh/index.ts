import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPipeline, createPiExecutor, type GhDependencies } from "./execute.ts";
import { createRegistry, viewParameters } from "./registry.ts";

export { GhExecutionError, type ErrorCategory } from "./errors.ts";
export { createSecureTempOutput, type GhDependencies, type GhExecRequest, type GhExecResult } from "./execute.ts";
export { createRegistry, viewOperation, type Operation } from "./registry.ts";
export { resolveResourceTarget, type ResourceTarget } from "./targets.ts";

export function createGhExtension(overrides: GhDependencies = {}) {
  return (pi: ExtensionAPI) => {
    const executor = overrides.executor ?? createPiExecutor(pi);
    const pipeline = createPipeline({
      executor,
      tempOutput: overrides.tempOutput,
    });
    const view = createRegistry().get("gh_view");
    if (!view) throw new Error("gh_view is missing from the operation registry");

    pi.registerTool({
      name: view.name,
      label: view.label,
      description: view.description,
      promptSnippet: view.promptSnippet,
      parameters: viewParameters,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const { projection } = await pipeline.runView(
          {
            target: typeof params.target === "string" ? params.target : undefined,
            detail: params.detail === "expanded" ? "expanded" : "compact",
          },
          { cwd: ctx.cwd, signal },
        );
        return {
          content: [{ type: "text", text: JSON.stringify(projection) }],
          details: { kind: "repository" },
        };
      },
    });
  };
}

export default function ghExtension(pi: ExtensionAPI) {
  createGhExtension()(pi);
}
