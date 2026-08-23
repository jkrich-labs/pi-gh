import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createGhExtension, type GhDependencies, type GhExecRequest, type GhExecResult } from "../extensions/gh/index.ts";

export const REPO_VIEW_JSON = {
  name: "cli",
  nameWithOwner: "cli/cli",
  description: "GitHub CLI",
  url: "https://github.com/cli/cli",
  visibility: "PUBLIC",
  isPrivate: false,
  isFork: false,
  isArchived: false,
  stargazerCount: 10,
  forkCount: 2,
  primaryLanguage: { name: "Go" },
  defaultBranchRef: { name: "trunk" },
  homepageUrl: "https://cli.github.com",
  licenseInfo: { name: "MIT License" },
  repositoryTopics: [{ name: "cli" }],
  createdAt: "2019-10-03T15:24:53Z",
  updatedAt: "2026-01-01T00:00:00Z",
  owner: { login: "cli" },
};

export const REPO_PROJECTION = {
  kind: "repository",
  name: "cli",
  nameWithOwner: "cli/cli",
  description: "GitHub CLI",
  url: "https://github.com/cli/cli",
  visibility: "PUBLIC",
  isPrivate: false,
  isFork: false,
  isArchived: false,
  stars: 10,
  forks: 2,
  primaryLanguage: "Go",
  defaultBranch: "trunk",
  homepageUrl: "https://cli.github.com",
  license: "MIT License",
  topics: ["cli"],
  createdAt: "2019-10-03T15:24:53Z",
  updatedAt: "2026-01-01T00:00:00Z",
  owner: "cli",
};

export type FakeExecutor = {
  calls: GhExecRequest[];
  execute: NonNullable<GhDependencies["executor"]>;
};

export function createFakeExecutor(
  handler: (request: GhExecRequest) => GhExecResult | Promise<GhExecResult>,
): FakeExecutor {
  const calls: GhExecRequest[] = [];
  return {
    calls,
    async execute(request) {
      calls.push(request);
      return handler(request);
    },
  };
}

export function defaultVersionResult(): GhExecResult {
  return {
    stdout: "gh version 2.81.0 (2025-10-01)\nhttps://github.com/cli/cli/releases/tag/v2.81.0\n",
    stderr: "",
    code: 0,
    killed: false,
  };
}

export function scriptedExecutor(
  options: {
    version?: GhExecResult | Error;
    onView?: (request: GhExecRequest) => GhExecResult | Promise<GhExecResult> | Error;
  } = {},
): FakeExecutor {
  return createFakeExecutor(async (request) => {
    if (request.argv[0] === "--version") {
      if (options.version instanceof Error) throw options.version;
      return options.version ?? defaultVersionResult();
    }
    if (options.onView) {
      const result = await options.onView(request);
      if (result instanceof Error) throw result;
      return result;
    }
    return {
      stdout: JSON.stringify(REPO_VIEW_JSON),
      stderr: "",
      code: 0,
      killed: false,
    };
  });
}

export function loadExtension(overrides: Partial<GhDependencies> = {}) {
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    on() {},
    exec: async () => {
      throw new Error("pi.exec must not be called when a fake executor is injected");
    },
  } as unknown as ExtensionAPI;

  createGhExtension(overrides)(pi);
  return { tools, pi };
}

export function toolCtx(cwd = "/tmp/checkout") {
  return {
    cwd,
    hasUI: true,
    mode: "tui" as const,
  };
}

export async function callView(
  tool: ToolDefinition,
  params: Record<string, unknown>,
  signal?: AbortSignal,
  cwd?: string,
) {
  return tool.execute("call-1", params, signal, undefined, toolCtx(cwd) as never);
}

export function projectionOf(result: { content: Array<{ type: string; text?: string }> }) {
  const text = result.content[0]?.text;
  if (typeof text !== "string") throw new Error("expected text tool result");
  return JSON.parse(text) as unknown;
}

export function repoViewArgv(repository?: string) {
  const fields =
    "name,nameWithOwner,description,url,visibility,isPrivate,isFork,isArchived,stargazerCount,forkCount,primaryLanguage,defaultBranchRef,updatedAt,createdAt,homepageUrl,licenseInfo,repositoryTopics,owner";
  return repository
    ? ["repo", "view", repository, "--json", fields]
    : ["repo", "view", "--json", fields];
}
