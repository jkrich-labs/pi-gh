import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyGhFailure, describeFailure, GhExecutionError, isMissingCli, redactSecrets } from "./errors.ts";
import type { CiKind, IssueKind, PullRequestKind, SearchKind } from "./registry.ts";
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
export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 50;
export const MAX_SEARCH_PAGE = 10;
export const DEFAULT_PR_FILES_LIMIT = 30;
export const DEFAULT_WORKFLOW_RUN_LIMIT = 20;
export const MAX_LOG_LINES = 10_000;
export const MAX_LOG_BYTES = 1_000_000;
export const REPO_VIEW_FIELDS =
  "name,nameWithOwner,description,url,visibility,isPrivate,isFork,isArchived,stargazerCount,forkCount,primaryLanguage,defaultBranchRef,updatedAt,createdAt,homepageUrl,licenseInfo,repositoryTopics,owner";

const ISSUE_VIEW_FIELDS = "number,title,state,author,assignees,labels,createdAt,updatedAt,url";
const PULL_REQUEST_VIEW_FIELDS = "number,title,state,isDraft,author,assignees,labels,baseRefName,headRefName,mergeStateStatus,createdAt,updatedAt,url";
const RELEASE_VIEW_FIELDS = "name,tagName,isDraft,isPrerelease,isLatest,publishedAt,createdAt,url,author";
const RUN_VIEW_FIELDS = "databaseId,workflowName,displayTitle,status,conclusion,event,headBranch,headSha,createdAt,updatedAt,url";
const JOB_VIEW_FIELDS = "databaseId,name,status,conclusion,startedAt,completedAt,url,steps";

export type ContentKind = "read_file" | "list_directory" | "pr_files" | "pr_diff";

export interface SearchRequestInput {
  kind: SearchKind;
  query: string;
  repo?: string;
  limit?: number;
  page?: number;
  detail?: "compact" | "expanded";
}

export interface ContentRequestInput {
  kind: ContentKind;
  repo?: string;
  path?: string;
  ref?: string;
  target?: string;
  limit?: number;
  page?: number;
  detail?: "compact" | "expanded";
}

export interface CiRequestInput {
  kind: CiKind;
  repo?: string;
  workflow?: string;
  branch?: string;
  status?: string;
  conclusion?: string;
  target?: string;
  attempt?: number;
  step?: string;
  maxLines?: number;
  maxBytes?: number;
  limit?: number;
  page?: number;
  detail?: "compact" | "expanded";
}

export interface IssueRequestInput {
  kind: IssueKind;
  repo?: string;
  target?: string;
  title?: string;
  body?: string;
  assignees?: string[];
  labels?: string[];
  milestone?: string;
}

export interface PullRequestRequestInput {
  kind: PullRequestKind;
  repo?: string;
  target?: string;
  title?: string;
  body?: string;
  head?: string;
  base?: string;
  draft?: boolean;
  reviewers?: string[];
  assignees?: string[];
  labels?: string[];
  event?: "approve" | "request_changes" | "comment";
  method?: "merge" | "squash" | "rebase";
  deleteBranch?: boolean;
}

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

export function createPipeline(deps: { executor: GhExecutor; tempOutput?: TempOutput; confirm?: (title: string, message: string) => Promise<boolean> }) {
  const tempOutput = deps.tempOutput ?? createSecureTempOutput();
  const confirm = deps.confirm;
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

  async function runSearch(
    input: SearchRequestInput,
    ctx: { cwd: string; signal?: AbortSignal },
  ): Promise<{ projection: Record<string, unknown>; target?: ResourceTarget }> {
    throwIfAborted(ctx.signal);
    const target = input.repo ? resolveRepositoryTarget(input.repo) : undefined;
    const limit = clamp(input.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
    const page = clamp(input.page, 1, 1, MAX_SEARCH_PAGE);
    if (!input.query.trim()) throw new GhExecutionError("validation", "Search query must not be empty.");
    await ensureGh(ctx.signal);
    if (target) await ensureHost(target.host, ctx.signal);
    const result = await run({
      argv: buildSearchArgv(input.kind, input.query, target, limit, page),
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeout: DEFAULT_TIMEOUT_MS,
    });
    const decoded = decodeJson(result);
    const projection = projectSearch(decoded, input.kind, input.query, page, limit, input.detail === "expanded");
    return {
      projection: await budgetProjection(
        projection,
        input.detail === "expanded" ? EXPANDED_TOKEN_BUDGET : DEFAULT_TOKEN_BUDGET,
        tempOutput,
        ["searchKind", "query", "page", "limit", "totalCount", "resultCount"],
      ),
      target,
    };
  }

  async function runContent(
    input: ContentRequestInput,
    ctx: { cwd: string; signal?: AbortSignal },
  ): Promise<{ projection: Record<string, unknown>; target: ResourceTarget }> {
    throwIfAborted(ctx.signal);
    let target: ResourceTarget;
    if (input.kind === "pr_files" || input.kind === "pr_diff") {
      if (!input.target) throw new GhExecutionError("validation", "A pull-request target is required.");
      target = resolveResourceTarget(input.target, { kind: "pull_request" });
    } else {
      if (!input.repo) throw new GhExecutionError("validation", "A repository target is required.");
      target = resolveRepositoryTarget(input.repo);
      validateRepositoryPath(input.path ?? "", input.kind === "read_file");
    }
    await ensureGh(ctx.signal);
    if (target.kind === "current_checkout") {
      throw new GhExecutionError("validation", "An explicit GitHub resource target is required.");
    }
    await ensureHost(target.host, ctx.signal);
    const limit = clamp(
      input.limit,
      input.kind === "pr_files" ? DEFAULT_PR_FILES_LIMIT : input.kind === "list_directory" ? MAX_SEARCH_LIMIT : DEFAULT_SEARCH_LIMIT,
      1,
      MAX_SEARCH_LIMIT,
    );
    const page = clamp(input.page, 1, 1, MAX_SEARCH_PAGE);
    const result = await run({
      argv: buildContentArgv(input, target, limit, page),
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeout: DEFAULT_TIMEOUT_MS,
    });
    const projection =
      input.kind === "pr_diff"
        ? projectPullRequestDiff(result.stdout, target)
        : input.kind === "read_file"
          ? projectFile(decodeJson(result), target, input.path!, input.ref)
          : input.kind === "list_directory"
            ? projectDirectory(decodeJson(result), target, input.path ?? "", input.ref, limit)
            : projectPullRequestFiles(decodeJson(result), target, page, limit);
    return {
      projection: await budgetProjection(
        projection,
        input.detail === "expanded" ? EXPANDED_TOKEN_BUDGET : DEFAULT_TOKEN_BUDGET,
        tempOutput,
        contentSummaryKeys(input.kind),
      ),
      target,
    };
  }

  async function runCi(
    input: CiRequestInput,
    ctx: { cwd: string; signal?: AbortSignal },
  ): Promise<{ projection: Record<string, unknown>; target?: ResourceTarget }> {
    throwIfAborted(ctx.signal);
    let target: ResourceTarget | undefined;
    if (input.kind === "list_runs") {
      if (!input.repo) throw new GhExecutionError("validation", "A repository target is required.");
      target = resolveRepositoryTarget(input.repo);
    } else if (input.kind === "view_run") {
      if (!input.target) throw new GhExecutionError("validation", "A workflow-run target is required.");
      target = resolveResourceTarget(input.target, { kind: "workflow_run" });
    } else if (input.kind === "view_job") {
      if (!input.target) throw new GhExecutionError("validation", "A job target is required.");
      target = resolveResourceTarget(input.target, { kind: "job" });
    } else if (input.kind === "pr_checks") {
      if (!input.target) throw new GhExecutionError("validation", "A pull-request target is required.");
      target = resolveResourceTarget(input.target, { kind: "pull_request" });
    } else {
      if (!input.target) throw new GhExecutionError("validation", "A workflow-run or job target is required.");
      target = resolveResourceTarget(input.target);
      if (target.kind !== "workflow_run" && target.kind !== "job") {
        throw new GhExecutionError("validation", "Failed logs require a workflow-run or job target.");
      }
    }
    if (target.kind === "current_checkout") throw new GhExecutionError("validation", "An explicit GitHub resource target is required.");
    await ensureGh(ctx.signal);
    await ensureHost(target.host, ctx.signal);
    const limit = clamp(input.limit, DEFAULT_WORKFLOW_RUN_LIMIT, 1, MAX_SEARCH_LIMIT);
    const page = clamp(input.page, 1, 1, MAX_SEARCH_PAGE);
    const result = await run({
      argv: buildCiArgv(input, target, limit, page),
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeout: DEFAULT_TIMEOUT_MS,
    });
    let projection: Record<string, unknown>;
    if (input.kind === "failed_logs") {
      projection = projectFailedLogs(result.stdout, target, input.step, clamp(input.maxLines, 500, 1, MAX_LOG_LINES), clamp(input.maxBytes, 100_000, 1, MAX_LOG_BYTES));
    } else {
      const decoded = decodeJson(result);
      projection = projectCi(decoded, input.kind, target, page, limit);
    }
    return {
      projection: await budgetProjection(
        projection,
        input.detail === "expanded" ? EXPANDED_TOKEN_BUDGET : DEFAULT_TOKEN_BUDGET,
        tempOutput,
        ciSummaryKeys(input.kind),
      ),
      target,
    };
  }

  async function runIssueWrite(
    input: IssueRequestInput,
    ctx: { cwd: string; signal?: AbortSignal; hasUI: boolean; confirm?: (title: string, message: string) => Promise<boolean> },
  ): Promise<{ projection: Record<string, unknown>; target: ResourceTarget }> {
    throwIfAborted(ctx.signal);
    const target = input.kind === "create_issue"
      ? resolveRepositoryTarget(input.repo ?? "")
      : resolveIssueTarget(input.target ?? "");
    await ensureGh(ctx.signal);
    await ensureHost(target.host, ctx.signal);
    const issueTarget = input.kind === "create_issue" ? undefined : target;
    const effect = issueEffect(input.kind, target);
    if (input.kind === "close_issue") {
      const ask = ctx.confirm ?? confirm;
      if (!ctx.hasUI || !ask) {
        throw new GhExecutionError("validation", "Guarded GitHub writes require confirmation UI.");
      }
      const approved = await ask("Confirm GitHub write", effect);
      if (!approved) {
        return { projection: { kind: "cancelled", cancelled: true, target, effect }, target };
      }
    }
    const result = await run({
      argv: buildIssueArgv(input, target),
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeout: DEFAULT_TIMEOUT_MS,
    });
    const projection = {
      kind: issueMutationResultKind(input.kind),
      target: issueTarget ?? target,
      output: result.stdout.trim(),
    };
    return { projection, target };
  }

  async function runPullRequestWrite(
    input: PullRequestRequestInput,
    ctx: { cwd: string; signal?: AbortSignal; hasUI: boolean; confirm?: (title: string, message: string) => Promise<boolean> },
  ): Promise<{ projection: Record<string, unknown>; target: ResourceTarget }> {
    throwIfAborted(ctx.signal);
    const target = input.kind === "create_pull_request"
      ? resolveRepositoryTarget(input.repo ?? "")
      : resolvePullRequestTarget(input.target ?? "");
    await ensureGh(ctx.signal);
    await ensureHost(target.host, ctx.signal);
    const guarded = input.kind === "close_pull_request" || input.kind === "merge_pull_request" || input.kind === "update_pull_request_branch" || (input.kind === "review_pull_request" && input.event !== "comment");
    if (guarded) {
      const ask = ctx.confirm ?? confirm;
      if (!ctx.hasUI || !ask) throw new GhExecutionError("validation", "Guarded GitHub writes require confirmation UI.");
      const approved = await ask("Confirm GitHub write", pullRequestEffect(input, target));
      if (!approved) return { projection: { kind: "cancelled", cancelled: true, target, effect: pullRequestEffect(input, target) }, target };
    }
    const result = await run({ argv: buildPullRequestArgv(input, target), cwd: ctx.cwd, signal: ctx.signal, timeout: DEFAULT_TIMEOUT_MS });
    return {
      projection: { kind: pullRequestMutationResultKind(input), target, output: result.stdout.trim() },
      target,
    };
  }

  return { runView, runSearch, runContent, runCi, runIssueWrite, runPullRequestWrite, ensureHost };
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

function resolveRepositoryTarget(raw: string): Extract<ResourceTarget, { kind: "repository" }> {
  const target = resolveResourceTarget(raw, { kind: "repository" });
  if (target.kind !== "repository") {
    throw new GhExecutionError("validation", "An explicit repository target is required.");
  }
  return target;
}

function buildSearchArgv(
  kind: SearchKind,
  query: string,
  target: Extract<ResourceTarget, { kind: "repository" }> | undefined,
  limit: number,
  page: number,
): string[] {
  const endpoint = kind === "repositories" ? "search/repositories" : kind === "code" ? "search/code" : kind === "commits" ? "search/commits" : "search/issues";
  const qualifier = kind === "issues" ? "is:issue" : kind === "pull_requests" ? "is:pr" : undefined;
  const scoped = [query, qualifier, target ? `repo:${target.owner}/${target.name}` : undefined]
    .filter((part): part is string => Boolean(part))
    .join(" ");
  return [
    "api",
    ...hostnameArgs(target),
    endpoint,
    "--method",
    "GET",
    "--field",
    `q=${scoped}`,
    "--field",
    `per_page=${limit}`,
    "--field",
    `page=${page}`,
  ];
}

function buildContentArgv(input: ContentRequestInput, target: ResourceTarget, limit: number, page: number): string[] {
  const repository = formatRepositoryTarget(target)!;
  const cliRepository = cliRepositoryTarget(target);
  switch (input.kind) {
    case "read_file":
    case "list_directory":
      return [
        "api",
        ...hostnameArgs(target),
        `repos/${repository}/contents${input.path ? `/${encodeRepositoryPath(input.path)}` : ""}`,
        "--method",
        "GET",
        ...(input.ref ? ["--field", `ref=${input.ref}`] : []),
      ];
    case "pr_files":
      return [
        "api",
        ...hostnameArgs(target),
        `repos/${repository}/pulls/${targetNumber(target)}/files`,
        "--method",
        "GET",
        "--field",
        `per_page=${limit}`,
        "--field",
        `page=${page}`,
      ];
    case "pr_diff":
      return ["pr", "diff", String(targetNumber(target)), "--repo", cliRepository];
    default:
      return assertNever(input.kind);
  }
}

function projectSearch(
  raw: unknown,
  kind: SearchKind,
  query: string,
  page: number,
  limit: number,
  expanded: boolean,
): Record<string, unknown> {
  if (!raw || typeof raw !== "object") throw new GhExecutionError("malformed_json", "GitHub search JSON was not an object.");
  const value = raw as Record<string, unknown>;
  const rawItems = Array.isArray(value.items) ? value.items : [];
  const results = rawItems.slice(0, limit).map((item) => compactSearchItem(item, expanded));
  return {
    kind: "search",
    searchKind: kind,
    query: redactSecrets(query),
    page,
    limit,
    totalCount: asNumber(value.total_count),
    incompleteResults: Boolean(value.incomplete_results),
    resultCount: results.length,
    results,
  };
}

function compactSearchItem(raw: unknown, expanded: boolean): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return { value: raw };
  const value = raw as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of ["id", "number", "name", "full_name", "path", "sha", "title", "state", "url", "html_url", "score", "language", "private", "default_branch"]) {
    if (value[key] !== undefined) result[key] = redactUnknown(value[key]);
  }
  if (value.repository && typeof value.repository === "object") {
    const repository = value.repository as Record<string, unknown>;
    result.repository = repository.full_name ?? repository.nameWithOwner ?? repository.name ?? null;
  }
  if (value.owner && typeof value.owner === "object") {
    result.owner = (value.owner as Record<string, unknown>).login ?? (value.owner as Record<string, unknown>).name ?? null;
  }
  if (value.commit && typeof value.commit === "object") {
    const commit = value.commit as Record<string, unknown>;
    result.commit = { message: commit.message ?? null, author: commit.author ?? null };
  }
  if (expanded) {
    for (const key of ["description", "body", "created_at", "updated_at", "author", "user", "labels"]) {
      if (value[key] !== undefined) result[key] = redactUnknown(value[key]);
    }
  }
  return result;
}

function projectFile(raw: unknown, target: ResourceTarget, path: string, ref: string | undefined): Record<string, unknown> {
  const base = { kind: "file", target, path, ref: ref ?? null };
  if (typeof raw === "string") return { ...base, binary: false, encoding: "utf-8", byteCount: Buffer.byteLength(raw), content: raw };
  if (!raw || typeof raw !== "object") throw new GhExecutionError("malformed_json", "GitHub file JSON was not an object.");
  const value = raw as Record<string, unknown>;
  const encoding = typeof value.encoding === "string" ? value.encoding : undefined;
  const content = typeof value.content === "string" ? value.content.replace(/\s/g, "") : undefined;
  if (encoding === "base64" && content !== undefined) {
    const bytes = Buffer.from(content, "base64");
    const decoded = decodeUtf8(bytes);
    if (decoded !== undefined && !decoded.includes("\u0000")) {
      return { ...base, binary: false, encoding: "utf-8", byteCount: bytes.length, content: decoded };
    }
    return { ...base, binary: true, encoding: "base64", byteCount: bytes.length, contentBase64: content };
  }
  return {
    ...base,
    binary: false,
    encoding: encoding ?? "utf-8",
    byteCount: typeof value.size === "number" ? value.size : 0,
    content: typeof value.content === "string" ? value.content : null,
  };
}

function projectDirectory(raw: unknown, target: ResourceTarget, path: string, ref: string | undefined, limit: number): Record<string, unknown> {
  if (!Array.isArray(raw)) throw new GhExecutionError("malformed_json", "GitHub directory JSON was not an array.");
  const entries = raw.slice(0, limit).map((entry) => compactDirectoryEntry(entry));
  return { kind: "directory", target, path, ref: ref ?? null, entryCount: entries.length, entries };
}

function compactDirectoryEntry(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return { value: raw };
  const value = raw as Record<string, unknown>;
  return Object.fromEntries(
    ["name", "path", "type", "size", "sha", "url", "html_url"]
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, redactUnknown(value[key])]),
  );
}

function projectPullRequestFiles(raw: unknown, target: ResourceTarget, page: number, limit: number): Record<string, unknown> {
  let source: unknown[] | undefined;
  if (Array.isArray(raw)) source = raw;
  else if (raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).files)) {
    source = (raw as Record<string, unknown>).files as unknown[];
  }
  if (!source) throw new GhExecutionError("malformed_json", "GitHub pull-request files JSON was not an array.");
  const files = source.slice(0, limit).map((entry) => compactFileChange(entry));
  return { kind: "pull_request_files", target, page, limit, fileCount: files.length, files };
}

function compactFileChange(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return { value: raw };
  const value = raw as Record<string, unknown>;
  return Object.fromEntries(
    ["filename", "status", "additions", "deletions", "changes", "sha", "blob_url", "raw_url", "contents_url", "previous_filename", "patch"]
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, redactUnknown(value[key])]),
  );
}

function projectPullRequestDiff(raw: string, target: ResourceTarget): Record<string, unknown> {
  return {
    kind: "pull_request_diff",
    target,
    fileCount: (raw.match(/^diff --git /gm) ?? []).length,
    lineCount: raw === "" ? 0 : raw.split("\n").length,
    byteCount: Buffer.byteLength(raw),
    diff: redactSecrets(raw),
  };
}

function contentSummaryKeys(kind: ContentKind): readonly string[] {
  switch (kind) {
    case "read_file":
      return ["path", "ref", "byteCount", "binary"];
    case "list_directory":
      return ["path", "ref", "entryCount"];
    case "pr_files":
      return ["target", "page", "limit", "fileCount"];
    case "pr_diff":
      return ["target", "fileCount", "lineCount", "byteCount"];
    default:
      return [];
  }
}

function validateRepositoryPath(path: string, required: boolean): void {
  if (!required && path === "") return;
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\u0000")) {
    throw new GhExecutionError("validation", "Repository paths must be relative and must not contain backslashes or null bytes.");
  }
  if (path.split("/").some((part) => part === ".." || part === "." || part === "")) {
    throw new GhExecutionError("validation", "Repository paths must not contain traversal segments.");
  }
}

function encodeRepositoryPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function targetNumber(target: ResourceTarget): number {
  if (target.kind !== "pull_request") throw new GhExecutionError("validation", "A pull-request target is required.");
  return target.number;
}

function decodeJson(result: GhExecResult): unknown {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new GhExecutionError("malformed_json", describeFailure("malformed_json", result));
  }
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function clamp(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const numeric = Number.isFinite(value) ? Math.trunc(value!) : fallback;
  return Math.max(minimum, Math.min(maximum, numeric));
}

function buildCiArgv(input: CiRequestInput, target: ResourceTarget, limit: number, page: number): string[] {
  const repository = formatRepositoryTarget(target)!;
  const cliRepository = cliRepositoryTarget(target);
  switch (input.kind) {
    case "list_runs":
      return [
        "api",
        ...hostnameArgs(target),
        `repos/${repository}/actions/runs`,
        "--method",
        "GET",
        ...(input.workflow ? ["--field", `workflow_id=${input.workflow}`] : []),
        ...(input.branch ? ["--field", `branch=${input.branch}`] : []),
        ...(input.status ? ["--field", `status=${input.status}`] : []),
        ...(input.conclusion ? ["--field", `conclusion=${input.conclusion}`] : []),
        "--field",
        `per_page=${limit}`,
        "--field",
        `page=${page}`,
      ];
    case "view_run":
      return ["run", "view", String(targetNumberForKind(target, "workflow_run")), "--repo", cliRepository, ...(input.attempt ? ["--attempt", String(input.attempt)] : []), "--json", RUN_VIEW_FIELDS];
    case "view_job":
      return ["run", "view", String(targetNumberForKind(target, "job_run")), "--job", String(targetJobId(target)), "--repo", cliRepository, "--json", JOB_VIEW_FIELDS];
    case "pr_checks":
      return ["pr", "checks", String(targetNumberForKind(target, "pull_request")), "--repo", cliRepository, "--json", "name,state,bucket,link,workflow" ];
    case "failed_logs":
      return ["run", "view", String(targetRunId(target)), ...(target.kind === "job" ? ["--job", String(target.jobId)] : []), "--repo", cliRepository, "--log-failed"];
    default:
      return assertNever(input.kind);
  }
}

function projectCi(raw: unknown, kind: Exclude<CiKind, "failed_logs">, target: ResourceTarget, page: number, limit: number): Record<string, unknown> {
  if (kind === "list_runs") {
    if (!raw || typeof raw !== "object") throw new GhExecutionError("malformed_json", "GitHub workflow-runs JSON was not an object.");
    const value = raw as Record<string, unknown>;
    const runs = Array.isArray(value.workflow_runs) ? value.workflow_runs.slice(0, limit).map(compactWorkflowRun) : [];
    return { kind: "workflow_runs", target, page, limit, totalCount: asNumber(value.total_count), runCount: runs.length, runs };
  }
  if (kind === "pr_checks") {
    if (!Array.isArray(raw)) throw new GhExecutionError("malformed_json", "GitHub checks JSON was not an array.");
    const checks = raw.map((entry) => redactUnknown(entry));
    return { kind: "pull_request_checks", target, checkCount: checks.length, checks };
  }
  if (!raw || typeof raw !== "object") throw new GhExecutionError("malformed_json", "GitHub CI JSON was not an object.");
  return { kind: kind === "view_job" ? "job" : "workflow_run", target, ...redactUnknown(raw) as Record<string, unknown> };
}

function compactWorkflowRun(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return { value: raw };
  const value = raw as Record<string, unknown>;
  const keys = ["databaseId", "id", "name", "workflowName", "displayTitle", "status", "conclusion", "event", "headBranch", "headSha", "attempt", "createdAt", "updatedAt", "url", "html_url"];
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, redactUnknown(value[key])]));
}

function projectFailedLogs(raw: string, target: ResourceTarget, requestedStep: string | undefined, maxLines: number, maxBytes: number): Record<string, unknown> {
  const lines = raw.split(/\r?\n/).filter((line, index, all) => !(index === all.length - 1 && line === ""));
  const sections: Array<{ name: string; lines: string[] }> = [];
  let current: { name: string; lines: string[] } | undefined;
  for (const line of lines) {
    const heading = /^(.*?)\s*\/\s*(.*?)\s*$/.exec(line);
    if (heading) {
      current = { name: heading[2]!.trim(), lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  let selected: string[];
  let step: string;
  let partial = false;
  if (requestedStep) {
    const match = sections.find((section) => section.name.toLowerCase().includes(requestedStep.toLowerCase()));
    if (!match) return { kind: "failed_logs", target, step: "UNKNOWN STEP", log: "", lineCount: 0, byteCount: 0, partial: true };
    selected = match.lines;
    step = match.name;
  } else {
    selected = lines;
    step = sections[0]?.name ?? "FAILED STEPS";
  }
  if (selected.length > maxLines) {
    selected = selected.slice(0, maxLines);
    partial = true;
  }
  const bounded: string[] = [];
  let bytes = 0;
  for (const line of selected) {
    const lineBytes = Buffer.byteLength(line + (bounded.length > 0 ? "\n" : ""));
    if (bytes + lineBytes > maxBytes) {
      partial = true;
      break;
    }
    bounded.push(line);
    bytes += lineBytes;
  }
  const log = bounded.join("\n");
  if (bounded.length < selected.length) partial = true;
  return { kind: "failed_logs", target, step, log, lineCount: bounded.length, byteCount: Buffer.byteLength(log), partial };
}

function ciSummaryKeys(kind: CiKind): readonly string[] {
  switch (kind) {
    case "list_runs":
      return ["target", "page", "limit", "totalCount", "runCount"];
    case "pr_checks":
      return ["target", "checkCount"];
    case "failed_logs":
      return ["target", "step", "lineCount", "byteCount", "partial"];
    case "view_run":
    case "view_job":
      return ["target", "status", "conclusion", "databaseId", "attempt"];
    default:
      return [];
  }
}

function targetNumberForKind(target: ResourceTarget, kind: "workflow_run" | "job_run" | "pull_request"): number {
  if (kind === "workflow_run" && target.kind === "workflow_run") return target.runId;
  if (kind === "job_run" && target.kind === "job") return target.runId;
  if (kind === "pull_request" && target.kind === "pull_request") return target.number;
  throw new GhExecutionError("validation", "The resource target kind does not match the CI operation.");
}

function targetJobId(target: ResourceTarget): number {
  if (target.kind !== "job") throw new GhExecutionError("validation", "A job target is required.");
  return target.jobId;
}

function targetRunId(target: ResourceTarget): number {
  if (target.kind === "job" || target.kind === "workflow_run") return target.kind === "job" ? target.runId : target.runId;
  throw new GhExecutionError("validation", "A workflow-run or job target is required.");
}

function resolveIssueTarget(raw: string): Extract<ResourceTarget, { kind: "issue" }> {
  const target = resolveResourceTarget(raw, { kind: "issue" });
  if (target.kind !== "issue") throw new GhExecutionError("validation", "An issue target is required.");
  return target;
}

function issueMutationResultKind(kind: IssueKind): string {
  switch (kind) {
    case "create_issue": return "issue_created";
    case "comment_issue": return "issue_commented";
    case "edit_issue": return "issue_edited";
    case "close_issue": return "issue_closed";
    case "reopen_issue": return "issue_reopened";
    default: return assertNever(kind);
  }
}

function issueEffect(kind: IssueKind, target: ResourceTarget): string {
  const repository = formatRepositoryTarget(target) ?? "repository";
  if (kind === "create_issue") return `Create issue in ${repository}`;
  if (kind === "close_issue") return `Close issue ${repository}#${targetIssueNumber(target)}`;
  return `${kind.replace("_issue", "")} issue ${repository}#${targetIssueNumber(target)}`;
}

function targetIssueNumber(target: ResourceTarget): number {
  if (target.kind !== "issue") throw new GhExecutionError("validation", "An issue target is required.");
  return target.number;
}

function buildIssueArgv(input: IssueRequestInput, target: ResourceTarget): string[] {
  const repository = cliRepositoryTarget(target);
  if (input.kind === "create_issue") {
    return [
      "issue",
      "create",
      "--repo",
      repository,
      "--title",
      input.title ?? "",
      ...(input.body !== undefined ? ["--body", input.body] : []),
      ...repeatFlags("--assignee", input.assignees),
      ...repeatFlags("--label", input.labels),
      ...(input.milestone ? ["--milestone", input.milestone] : []),
    ];
  }
  const number = targetIssueNumber(target);
  if (input.kind === "comment_issue") {
    return ["issue", "comment", String(number), "--repo", repository, "--body", input.body ?? ""];
  }
  if (input.kind === "edit_issue") {
    return [
      "issue",
      "edit",
      String(number),
      "--repo",
      repository,
      ...(input.title !== undefined ? ["--title", input.title] : []),
      ...(input.body !== undefined ? ["--body", input.body] : []),
      ...repeatFlags("--add-assignee", input.assignees),
      ...repeatFlags("--add-label", input.labels),
      ...(input.milestone ? ["--milestone", input.milestone] : []),
    ];
  }
  return ["issue", input.kind === "close_issue" ? "close" : "reopen", String(number), "--repo", repository];
}

function repeatFlags(flag: string, values: string[] | undefined): string[] {
  return (values ?? []).flatMap((value) => [flag, value]);
}

function resolvePullRequestTarget(raw: string): Extract<ResourceTarget, { kind: "pull_request" }> {
  const target = resolveResourceTarget(raw, { kind: "pull_request" });
  if (target.kind !== "pull_request") throw new GhExecutionError("validation", "A pull-request target is required.");
  return target;
}

function pullRequestMutationResultKind(input: PullRequestRequestInput): string {
  switch (input.kind) {
    case "create_pull_request": return "pull_request_created";
    case "comment_pull_request": return "pull_request_commented";
    case "edit_pull_request": return "pull_request_edited";
    case "review_pull_request": return "pull_request_reviewed";
    case "close_pull_request": return "pull_request_closed";
    case "reopen_pull_request": return "pull_request_reopened";
    case "merge_pull_request": return "pull_request_merged";
    case "update_pull_request_branch": return "pull_request_branch_updated";
    default: return assertNever(input.kind);
  }
}

function pullRequestEffect(input: PullRequestRequestInput, target: ResourceTarget): string {
  const repository = formatRepositoryTarget(target) ?? "repository";
  const number = target.kind === "pull_request" ? `#${target.number}` : "";
  if (input.kind === "create_pull_request") return `Create pull request in ${repository}`;
  if (input.kind === "merge_pull_request") return `Merge pull request ${repository}${number} using ${input.method ?? "merge"}`;
  if (input.kind === "close_pull_request") return `Close pull request ${repository}${number}`;
  if (input.kind === "update_pull_request_branch") return `Update pull request branch ${repository}${number}`;
  if (input.kind === "review_pull_request") return `Submit ${input.event ?? "comment"} review for ${repository}${number}`;
  return `${input.kind.replace("_pull_request", "")} pull request ${repository}${number}`;
}

function buildPullRequestArgv(input: PullRequestRequestInput, target: ResourceTarget): string[] {
  const repository = cliRepositoryTarget(target);
  if (input.kind === "create_pull_request") {
    return [
      "pr", "create", "--repo", repository, "--title", input.title ?? "", ...(input.body !== undefined ? ["--body", input.body] : []),
      "--head", input.head ?? "", ...(input.base ? ["--base", input.base] : []), ...(input.draft ? ["--draft"] : []),
      ...repeatFlags("--reviewer", input.reviewers), ...repeatFlags("--assignee", input.assignees), ...repeatFlags("--label", input.labels),
    ];
  }
  const number = targetPullRequestNumber(target);
  if (input.kind === "comment_pull_request") return ["pr", "comment", String(number), "--repo", repository, "--body", input.body ?? ""];
  if (input.kind === "edit_pull_request") return [
    "pr", "edit", String(number), "--repo", repository,
    ...(input.title !== undefined ? ["--title", input.title] : []), ...(input.body !== undefined ? ["--body", input.body] : []),
    ...(input.base ? ["--base", input.base] : []), ...(input.draft === true ? ["--draft"] : input.draft === false ? ["--ready"] : []),
    ...repeatFlags("--add-reviewer", input.reviewers), ...repeatFlags("--add-assignee", input.assignees), ...repeatFlags("--add-label", input.labels),
  ];
  if (input.kind === "review_pull_request") return ["pr", "review", String(number), "--repo", repository, `--${input.event === "request_changes" ? "request-changes" : input.event ?? "comment"}`, ...(input.body !== undefined ? ["--body", input.body] : [])];
  if (input.kind === "merge_pull_request") return ["pr", "merge", String(number), "--repo", repository, `--${input.method ?? "merge"}`, ...(input.deleteBranch ? ["--delete-branch"] : [])];
  if (input.kind === "close_pull_request") return ["pr", "close", String(number), "--repo", repository];
  if (input.kind === "reopen_pull_request") return ["pr", "reopen", String(number), "--repo", repository];
  return ["pr", "update-branch", String(number), "--repo", repository];
}

function targetPullRequestNumber(target: ResourceTarget): number {
  if (target.kind !== "pull_request") throw new GhExecutionError("validation", "A pull-request target is required.");
  return target.number;
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
  summaryKeys: readonly string[] = [],
): Promise<Record<string, unknown>> {
  const text = JSON.stringify(projection);
  const tokenCount = estimateProjectionTokens(text);
  if (tokenCount <= budget) return projection;
  const { path } = await tempOutput.write(text);
  if (summaryKeys.length === 0) {
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
  const kept = new Set(["kind", ...summaryKeys.filter((key) => key in projection)]);
  return {
    kind: projection.kind ?? "content",
    ...Object.fromEntries(summaryKeys.filter((key) => key in projection).map((key) => [key, projection[key]])),
    truncated: true,
    omittedCount: Object.keys(projection).filter((key) => !kept.has(key)).length,
    tokenCount,
    tokenBudget: budget,
    fullPath: path,
  };
}

function hostnameArgs(target: ResourceTarget | undefined): string[] {
  if (!target) return [];
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
