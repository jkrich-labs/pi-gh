import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyGhFailure, describeFailure, GhExecutionError, isMissingCli, redactSecrets } from "./errors.ts";
import {
  formatHost,
  formatRepositoryTarget,
  normalizeHost,
  resolveResourceTarget,
  type ResourceTarget,
  type ViewResourceKind,
} from "./targets.ts";

export const MIN_GH_VERSION = "2.81.0";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_TOKEN_BUDGET = 2_000;
export const EXPANDED_TOKEN_BUDGET = 8_000;
export const REPO_VIEW_FIELDS =
  "name,nameWithOwner,description,url,visibility,isPrivate,isFork,isArchived,stargazerCount,forkCount,primaryLanguage,defaultBranchRef,updatedAt,createdAt,homepageUrl,licenseInfo,repositoryTopics,owner";

const ISSUE_VIEW_FIELDS = "number,title,state,author,assignees,labels,createdAt,updatedAt,url";
const PULL_REQUEST_VIEW_FIELDS = "number,title,state,isDraft,author,assignees,labels,baseRefName,headRefName,mergeStateStatus,createdAt,updatedAt,url";
const RELEASE_VIEW_FIELDS = "name,tagName,isDraft,isPrerelease,isLatest,publishedAt,createdAt,url,author";
const RUN_VIEW_FIELDS = "databaseId,workflowName,displayTitle,status,conclusion,event,headBranch,headSha,createdAt,updatedAt,url";
const JOB_VIEW_FIELDS = "databaseId,name,status,conclusion,startedAt,completedAt,url,steps";

export interface GhExecRequest {
  argv: string[];
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
  stdin?: string;
}

export interface GhExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export type GhExecutor = (request: GhExecRequest) => Promise<GhExecResult>;

export interface TempOutput {
  write(content: string): Promise<{ path: string }>;
}

export interface GhDependencies {
  executor?: GhExecutor;
  confirm?: (title: string, message: string) => Promise<boolean>;
  clock?: { now(): number };
  tempOutput?: TempOutput;
}

export function createSecureTempOutput(): TempOutput {
  return {
    async write(content: string) {
      const dir = await mkdtemp(join(tmpdir(), "pi-gh-"));
      await chmod(dir, 0o700);
      const path = join(dir, randomBytes(16).toString("hex"));
      await writeFile(path, redactSecrets(content), { mode: 0o600, flag: "wx" });
      return { path };
    },
  };
}

export function createPiExecutor(pi: ExtensionAPI): GhExecutor {
  return async (request) =>
    pi.exec("gh", request.argv, {
      cwd: request.cwd,
      timeout: request.timeout,
      signal: request.signal,
    });
}

export function createPipeline(deps: { executor: GhExecutor; tempOutput?: TempOutput }) {
  const tempOutput = deps.tempOutput ?? createSecureTempOutput();
  const authenticatedHosts = new Set<string>(["github.com"]);
  let ready = false;
  let hostsLoaded = false;

  async function ensureGh(signal?: AbortSignal): Promise<void> {
    if (ready) return;
    throwIfAborted(signal);
    let result: GhExecResult;
    try {
      result = await deps.executor({ argv: ["--version"], signal, timeout: 10_000 });
    } catch (error) {
      if (isMissingCli(error)) {
        throw new GhExecutionError("missing_cli", describeFailure("missing_cli", emptyResult()));
      }
      throw error;
    }
    const classified = classifyGhFailure(result, signal);
    if (classified === "timeout" || classified === "aborted") {
      throw new GhExecutionError(classified, describeFailure(classified, result));
    }
    const version = parseVersion(result.stdout);
    if (!version && (result.code !== 0 || isMissingCli(result))) {
      throw new GhExecutionError("missing_cli", describeFailure("missing_cli", result));
    }
    if (!version || compareSemver(version, MIN_GH_VERSION) < 0) {
      throw new GhExecutionError(
        "unsupported_version",
        `gh ${version ?? "unknown"} is too old. Install GitHub CLI ${MIN_GH_VERSION} or newer.`,
      );
    }
    ready = true;
  }

  async function ensureHost(host: string, signal?: AbortSignal): Promise<void> {
    const normalized = normalizeHost(host);
    if (authenticatedHosts.has(normalized)) return;
    if (!hostsLoaded) {
      const result = await run({ argv: ["auth", "status", "--json", "hosts"], signal, timeout: 10_000 });
      let decoded: unknown;
      try {
        decoded = JSON.parse(result.stdout);
      } catch {
        throw new GhExecutionError("malformed_json", describeFailure("malformed_json", result));
      }
      for (const host of extractAuthenticatedHosts(decoded)) authenticatedHosts.add(host);
      hostsLoaded = true;
    }
    if (!authenticatedHosts.has(normalized)) {
      throw new GhExecutionError(
        "auth",
        `GitHub host ${normalized} is not authenticated with gh. Authenticate it with gh auth login --hostname ${normalized}.`,
      );
    }
  }

  async function run(request: GhExecRequest): Promise<GhExecResult> {
    throwIfAborted(request.signal);
    let result: GhExecResult;
    try {
      result = await deps.executor(request);
    } catch (error) {
      if (isMissingCli(error)) {
        throw new GhExecutionError("missing_cli", describeFailure("missing_cli", emptyResult()));
      }
      throw error;
    }
    const category = classifyGhFailure(result, request.signal);
    if (category) {
      throw new GhExecutionError(category, describeFailure(category, result), {
        stderr: result.stderr,
        code: result.code,
      });
    }
    if (result.code !== 0) {
      throw new GhExecutionError("unsupported", describeFailure("unsupported", result), {
        stderr: result.stderr,
        code: result.code,
      });
    }
    return result;
  }

  async function runView(
    input: { target?: string; kind?: ViewResourceKind; detail?: "compact" | "expanded" },
    ctx: { cwd: string; signal?: AbortSignal },
  ): Promise<{ projection: Record<string, unknown>; target: ResourceTarget }> {
    throwIfAborted(ctx.signal);
    const target = resolveResourceTarget(input.target, { kind: input.kind });
    await ensureGh(ctx.signal);
    if (target.kind !== "current_checkout") await ensureHost(target.host, ctx.signal);

    const result = await run({
      argv: buildViewArgv(target),
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeout: DEFAULT_TIMEOUT_MS,
    });
    let decoded: unknown;
    try {
      decoded = JSON.parse(result.stdout);
    } catch {
      throw new GhExecutionError("malformed_json", describeFailure("malformed_json", result));
    }
    const projection = await budgetProjection(
      projectResource(decoded, target),
      input.detail === "expanded" ? EXPANDED_TOKEN_BUDGET : DEFAULT_TOKEN_BUDGET,
      tempOutput,
    );
    return { projection, target };
  }

  return { runView, ensureHost };
}

export function buildViewArgv(target: ResourceTarget): string[] {
  if (target.kind === "repository" || target.kind === "current_checkout") {
    return [
      "repo",
      "view",
      ...(target.kind === "repository" ? [cliRepositoryTarget(target)] : []),
      "--json",
      REPO_VIEW_FIELDS,
    ];
  }

  const repository = formatRepositoryTarget(target)!;
  const cliRepository = cliRepositoryTarget(target);
  switch (target.kind) {
    case "issue":
      return ["issue", "view", String(target.number), "--repo", cliRepository, "--json", ISSUE_VIEW_FIELDS];
    case "pull_request":
      return ["pr", "view", String(target.number), "--repo", cliRepository, "--json", PULL_REQUEST_VIEW_FIELDS];
    case "commit":
      return ["api", ...hostnameArgs(target), `repos/${repository}/commits/${encodeURIComponent(target.sha)}`];
    case "release":
      return ["release", "view", target.tag, "--repo", cliRepository, "--json", RELEASE_VIEW_FIELDS];
    case "workflow_run":
      return ["run", "view", String(target.runId), "--repo", cliRepository, "--json", RUN_VIEW_FIELDS];
    case "job":
      return ["run", "view", String(target.runId), "--job", String(target.jobId), "--repo", cliRepository, "--json", JOB_VIEW_FIELDS];
    case "file":
      return [
        "api",
        ...hostnameArgs(target),
        `repos/${repository}/contents/${target.path.split("/").map(encodeURIComponent).join("/")}`,
        "--method",
        "GET",
        "--field",
        `ref=${target.ref}`,
      ];
    case "tree":
      return [
        "api",
        ...hostnameArgs(target),
        `repos/${repository}/git/trees/${encodeURIComponent(target.ref)}${target.path ? `?path=${encodeURIComponent(target.path)}` : ""}`,
      ];
    case "compare":
      return ["api", ...hostnameArgs(target), `repos/${repository}/compare/${target.base}...${target.head}`];
    default:
      return assertNever(target);
  }
}

export function projectRepository(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") {
    throw new GhExecutionError("malformed_json", "gh repository JSON was not an object.");
  }
  const value = raw as Record<string, unknown>;
  return {
    kind: "repository",
    name: asString(value.name),
    nameWithOwner: asString(value.nameWithOwner),
    description: asString(value.description),
    url: asString(value.url),
    visibility: asString(value.visibility),
    isPrivate: Boolean(value.isPrivate),
    isFork: Boolean(value.isFork),
    isArchived: Boolean(value.isArchived),
    stars: asNumber(value.stargazerCount),
    forks: asNumber(value.forkCount),
    primaryLanguage: nestedName(value.primaryLanguage),
    defaultBranch: nestedName(value.defaultBranchRef),
    homepageUrl: asString(value.homepageUrl),
    license: nestedName(value.licenseInfo),
    topics: topicNames(value.repositoryTopics),
    createdAt: asString(value.createdAt),
    updatedAt: asString(value.updatedAt),
    owner: ownerLogin(value.owner),
  };
}

export function projectResource(raw: unknown, target: ResourceTarget): Record<string, unknown> {
  if (target.kind === "repository" || target.kind === "current_checkout") return projectRepository(raw);
  const targetProjection = { ...target };
  return {
    kind: target.kind,
    target: targetProjection,
    data: redactUnknown(raw),
  };
}

export function estimateProjectionTokens(text: string): number {
  return estimateTokens({
    role: "toolResult",
    timestamp: 0,
    toolCallId: "gh-token-budget",
    toolName: "gh_view",
    content: [{ type: "text", text }],
    isError: false,
  } as Parameters<typeof estimateTokens>[0]);
}

async function budgetProjection(
  projection: Record<string, unknown>,
  budget: number,
  tempOutput: TempOutput,
): Promise<Record<string, unknown>> {
  const text = JSON.stringify(projection);
  const tokenCount = estimateProjectionTokens(text);
  if (tokenCount <= budget) return projection;
  const { path } = await tempOutput.write(text);
  const keepName = estimateProjectionTokens(
    JSON.stringify({
      kind: projection.kind ?? "repository",
      nameWithOwner: projection.nameWithOwner ?? null,
      truncated: true,
      omittedCount: 0,
      tokenCount,
      tokenBudget: budget,
      fullPath: path,
    }),
  ) <= budget;
  const kept = new Set(keepName ? ["kind", "nameWithOwner"] : ["kind"]);
  return {
    kind: projection.kind ?? "repository",
    ...(keepName ? { nameWithOwner: projection.nameWithOwner ?? null } : {}),
    truncated: true,
    omittedCount: Object.keys(projection).filter((key) => !kept.has(key)).length,
    tokenCount,
    tokenBudget: budget,
    fullPath: path,
  };
}

function hostnameArgs(target: ResourceTarget): string[] {
  const host = formatHost(target);
  return host ? ["--hostname", host] : [];
}

function cliRepositoryTarget(target: ResourceTarget): string {
  const repository = formatRepositoryTarget(target);
  if (!repository) throw new Error("A current checkout has no explicit CLI repository target.");
  const host = formatHost(target);
  return host ? `${host}/${repository}` : repository;
}

function extractAuthenticatedHosts(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const hosts = (value as { hosts?: unknown }).hosts;
  if (Array.isArray(hosts)) return hosts.filter((host): host is string => typeof host === "string").map(normalizeHost);
  if (!hosts || typeof hosts !== "object") return [];
  return Object.keys(hosts).map(normalizeHost);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new GhExecutionError("aborted", describeFailure("aborted", emptyResult()));
  }
}

function emptyResult(): GhExecResult {
  return { stdout: "", stderr: "", code: 1, killed: false };
}

function parseVersion(stdout: string): string | undefined {
  return /gh version (\d+\.\d+\.\d+)/.exec(stdout)?.[1];
}

function compareSemver(left: string, right: string): number {
  const a = left.split(".").map((part) => Number(part));
  const b = right.split(".").map((part) => Number(part));
  for (let i = 0; i < 3; i += 1) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nestedName(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  return asString((value as { name?: unknown }).name);
}

function ownerLogin(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  return asString((value as { login?: unknown }).login);
}

function topicNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const name = nestedName(entry);
    return name ? [name] : [];
  });
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, redactUnknown(nested)]));
  }
  return value;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled GitHub resource target: ${JSON.stringify(value)}`);
}
