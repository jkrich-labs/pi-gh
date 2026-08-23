import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyGhFailure, describeFailure, describeFailureWithContext, GhExecutionError, isMissingCli, redactSecrets } from "./errors.ts";
import type { ActionReleaseKind, ApiKind, CiKind, IssueKind, PullRequestKind, SearchKind } from "./registry.ts";
import {
  formatHost,
  formatRepositoryTarget,
  isGithubHost,
  normalizeHost,
  resolveResourceTarget,
  type ResourceTarget,
  type ViewResourceKind,
} from "./targets.ts";

export const MIN_GH_VERSION = "2.81.0";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_TOKEN_BUDGET = 2_000;
export const EXPANDED_TOKEN_BUDGET = 8_000;
export const DEFAULT_RESULT_LIMIT = 10;
export const DEFAULT_SEARCH_LIMIT = DEFAULT_RESULT_LIMIT;
export const MAX_SEARCH_LIMIT = 50;
export const MAX_SEARCH_PAGE = 10;
export const MAX_RESULT_PAGE = MAX_SEARCH_PAGE;
export const DEFAULT_PR_FILES_LIMIT = DEFAULT_RESULT_LIMIT;
export const DEFAULT_WORKFLOW_RUN_LIMIT = DEFAULT_RESULT_LIMIT;
export const MAX_LOG_LINES = 10_000;
export const MAX_LOG_BYTES = 1_000_000;
export const MAX_API_RESPONSE_BYTES = 1_000_000;
export const MAX_API_QUERY_ENTRIES = 50;
export const MAX_API_QUERY_KEY_BYTES = 100;
export const MAX_API_QUERY_VALUE_BYTES = 2_000;
export const MAX_API_QUERY_BYTES = 16_000;
export const REPO_VIEW_FIELDS =
  "name,nameWithOwner,description,url,visibility,isPrivate,isFork,isArchived,stargazerCount,forkCount,primaryLanguage,defaultBranchRef,updatedAt,createdAt,homepageUrl,licenseInfo,repositoryTopics,owner";

const ISSUE_VIEW_FIELDS = "number,title,state,author,assignees,labels,createdAt,updatedAt,url";
const PULL_REQUEST_VIEW_FIELDS = "number,title,state,isDraft,author,assignees,labels,baseRefName,headRefName,mergeStateStatus,createdAt,updatedAt,url";
const RELEASE_VIEW_FIELDS = "name,tagName,isDraft,isPrerelease,publishedAt,createdAt,url,author";
const RELEASE_VIEW_FIELDS_EXTRA = ["isLatest"];
const RUN_VIEW_FIELDS = "databaseId,workflowName,displayTitle,status,conclusion,event,headBranch,headSha,createdAt,updatedAt,url";
const RUN_VIEW_FIELDS_EXTRA = ["workflowDatabaseId"];
const JOB_VIEW_FIELDS = "databaseId,name,status,conclusion,startedAt,updatedAt,url";
const JOB_VIEW_FIELDS_EXTRA = ["completedAt", "steps"];

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

export interface ResolvedPullRequest {
  kind: "PullRequest";
  number: number;
  headRefName: string | null;
  headRefOid?: string;
  state?: string;
}

export interface ActionReleaseRequestInput {
  kind: ActionReleaseKind;
  repo?: string;
  workflow?: string;
  ref?: string;
  inputs?: Record<string, string>;
  target?: string;
  tag?: string;
  title?: string;
  notes?: string;
  draft?: boolean;
  prerelease?: boolean;
  path?: string;
  label?: string;
  asset?: string;
}

export interface ApiGetRequestInput {
  kind: ApiKind;
  endpoint: string;
  host?: string;
  query?: Record<string, string>;
  page?: number;
  perPage?: number;
  cache?: string;
  jq?: string;
  detail?: "compact" | "expanded";
}

export interface GhExecRequest {
  argv: string[];
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
  stdin?: string;
  maxOutputBytes?: number;
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

  async function run(request: GhExecRequest, targetDescription?: string, hint?: string): Promise<GhExecResult> {
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
    if (request.maxOutputBytes !== undefined && Buffer.byteLength(result.stdout, "utf8") > request.maxOutputBytes) {
      throw new GhExecutionError("validation", "GitHub CLI output exceeded the bounded response limit.", {
        byteCount: Buffer.byteLength(result.stdout, "utf8"),
        maxOutputBytes: request.maxOutputBytes,
      });
    }
    const diagnostic = boundedDiagnostics(result);
    const category = classifyGhFailure(diagnostic, request.signal);
    if (category) {
      const describe = targetDescription ? describeFailureWithContext : describeFailure;
      throw new GhExecutionError(category, describe(category, diagnostic, targetDescription ?? "", hint), {
        stderr: diagnostic.stderr,
        code: diagnostic.code,
        target: targetDescription ? redactSecrets(targetDescription) : undefined,
      });
    }
    if (result.code !== 0) {
      const describe = targetDescription ? describeFailureWithContext : describeFailure;
      throw new GhExecutionError("unsupported", describe("unsupported", diagnostic, targetDescription ?? "", hint), {
        stderr: diagnostic.stderr,
        code: diagnostic.code,
        target: targetDescription ? redactSecrets(targetDescription) : undefined,
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

    let argv = buildViewArgv(target);
    /* First attempt is wrapped so gh 2.81.0's `Unknown JSON field` failure can
     * drive field removal instead of surfacing as a hard error. */
    let raw: GhExecResult;
    try {
      raw = await run({ argv, cwd: ctx.cwd, signal: ctx.signal, timeout: DEFAULT_TIMEOUT_MS }, describeTarget(target), viewFallbackHint(target));
    } catch (error) {
      if (error instanceof GhExecutionError && error.category === "unsupported" && parseUnknownJsonField(String(error.details.stderr ?? ""))) {
        raw = { stdout: "", stderr: String(error.details.stderr), code: 1, killed: false };
      } else {
        throw error;
      }
    }
    let result = raw;
    let fieldList = jsonFieldList(argv);
    while (fieldList.length > 0) {
      const unknown = parseUnknownJsonField(result.stderr);
      if (!unknown) break;
      fieldList = fieldList.filter((field) => field !== unknown);
      const index = argv.indexOf("--json");
      argv = [...argv];
      argv[index + 1] = fieldList.join(",");
      result = await run({ argv, cwd: ctx.cwd, signal: ctx.signal, timeout: DEFAULT_TIMEOUT_MS }, describeTarget(target), viewFallbackHint(target));
    }
    /* Richer fields newer gh versions expose (isLatest, completedAt, ...) are
     * retried once and dropped silently on 2.81.0-like versions. */
    const extras = viewExtras(target.kind === "current_checkout" ? "repository" : target.kind);
    if (extras.length > 0) {
      const index = argv.indexOf("--json");
      try {
        const enhanced = await run({
          argv: [...argv.slice(0, index + 1), [...jsonFieldList(argv), ...extras].join(",")],
          cwd: ctx.cwd,
          signal: ctx.signal,
          timeout: DEFAULT_TIMEOUT_MS,
        }, describeTarget(target), viewFallbackHint(target));
        if (!parseUnknownJsonField(enhanced.stderr)) result = enhanced;
      } catch {
        /* Older gh can't render the extras; the base view already succeeded. */
      }
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(result.stdout);
    } catch {
      throw new GhExecutionError("malformed_json", describeFailure("malformed_json", result));
    }
    const projection = await budgetProjection(
      target.kind === "file"
        ? projectFile(decoded, target, target.path, target.ref)
        : projectResource(decoded, target),
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
    const page = clamp(input.page, 1, 1, MAX_RESULT_PAGE);
    if (!input.query.trim()) throw new GhExecutionError("validation", "Search query must not be empty.");
    await ensureGh(ctx.signal);
    if (target) await ensureHost(target.host, ctx.signal);
    const result = await run({
      argv: buildSearchArgv(input.kind, input.query, target, limit, page),
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeout: DEFAULT_TIMEOUT_MS,
    }, target ? describeTarget(target) : "github.com search");
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
    const page = clamp(input.page, 1, 1, MAX_RESULT_PAGE);
    const result = await run({
      argv: buildContentArgv(input, target, limit, page),
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeout: DEFAULT_TIMEOUT_MS,
    }, describeTarget(target), readFileNotFoundHint(input, target));
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
    const page = clamp(input.page, 1, 1, MAX_RESULT_PAGE);
    const { result, checksContext } = await runChecks(
      input,
      target,
      limit,
      page,
      ctx,
      async (argv: string[]) =>
        run({ argv, cwd: ctx.cwd, signal: ctx.signal, timeout: DEFAULT_TIMEOUT_MS }, describeTarget(target), ciRunHint(input, target)),
      deps.executor,
    );
    let projection: Record<string, unknown>;
    if (input.kind === "failed_logs") {
      projection = projectFailedLogs(result.stdout, target, input.step, clamp(input.maxLines, 500, 1, MAX_LOG_LINES), clamp(input.maxBytes, 100_000, 1, MAX_LOG_BYTES));
    } else {
      const decoded = decodeJson(result);
      projection = projectCi(decoded, input.kind, target, page, limit, checksContext);
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
    }, describeTarget(target));
    const projection = {
      kind: issueMutationResultKind(input.kind),
      target: issueTarget ?? target,
      ...(input.kind === "create_issue" ? { url: parseCreatedResourceUrl(result.stdout, target, "issues") } : {}),
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
    const result = await run({ argv: buildPullRequestArgv(input, target), cwd: ctx.cwd, signal: ctx.signal, timeout: DEFAULT_TIMEOUT_MS }, describeTarget(target));
    const extra = await pullRequestWriteDetails(input, target, ctx, deps.executor);
    return {
      projection: {
        kind: pullRequestMutationResultKind(input),
        target,
        ...extra,
        ...(input.kind === "create_pull_request" ? { url: parseCreatedResourceUrl(result.stdout, target, "pull") } : {}),
        output: result.stdout.trim(),
      },
      target,
    };
  }

  async function runApiGet(
    input: ApiGetRequestInput,
    ctx: { cwd: string; signal?: AbortSignal },
  ): Promise<{ projection: Record<string, unknown>; target: ApiTarget }> {
    throwIfAborted(ctx.signal);
    const host = normalizeHost(input.host ?? "github.com");
    const endpoint = normalizeApiEndpoint(input.endpoint);
    validateJq(input.jq);
    validateApiCache(input.cache);
    const page = clamp(input.page, 1, 1, MAX_RESULT_PAGE);
    const perPage = clamp(input.perPage, 50, 1, 50);
    await ensureGh(ctx.signal);
    await ensureHost(host, ctx.signal);
    validateApiQuery(input.query);
    const safeEndpoint = redactSecrets(endpoint);
    const safeTarget: ApiTarget = { kind: "api", host, endpoint: safeEndpoint };
    const result = await run({ argv: buildApiGetArgv(input, host, endpoint, page, perPage), cwd: ctx.cwd, signal: ctx.signal, timeout: DEFAULT_TIMEOUT_MS }, `${host} ${redactSecrets(endpoint)}`);
    const outputBytes = Buffer.byteLength(result.stdout, "utf8");
    if (outputBytes > MAX_API_RESPONSE_BYTES) {
      const { path } = await tempOutput.write(result.stdout);
      const oversized = { kind: "api_get", target: safeTarget, endpoint: safeEndpoint, host, page, perPage, truncated: true, byteCount: outputBytes, tokenBudget: input.detail === "expanded" ? EXPANDED_TOKEN_BUDGET : DEFAULT_TOKEN_BUDGET, fullPath: path };
      const projection = await budgetProjection(oversized, input.detail === "expanded" ? EXPANDED_TOKEN_BUDGET : DEFAULT_TOKEN_BUDGET, tempOutput);
      return { projection, target: safeTarget };
    }
    let data: unknown;
    if (input.jq) {
      data = result.stdout.trim();
    } else {
      try {
        data = JSON.parse(result.stdout);
      } catch {
        throw new GhExecutionError("malformed_json", "GitHub API returned malformed JSON.");
      }
    }
    const projection = await budgetProjection({ kind: "api_get", target: safeTarget, endpoint: safeEndpoint, host, page, perPage, data: projectApiData(data) }, input.detail === "expanded" ? EXPANDED_TOKEN_BUDGET : DEFAULT_TOKEN_BUDGET, tempOutput);
    return { projection, target: safeTarget };
  }

  async function runActionReleaseWrite(
    input: ActionReleaseRequestInput,
    ctx: { cwd: string; signal?: AbortSignal; hasUI: boolean; confirm?: (title: string, message: string) => Promise<boolean> },
  ): Promise<{ projection: Record<string, unknown>; target: ResourceTarget }> {
    throwIfAborted(ctx.signal);
    const target = input.kind === "dispatch_workflow" || input.kind === "create_release"
      ? resolveRepositoryTarget(input.repo ?? "")
      : input.kind === "cancel_workflow_run" || input.kind === "rerun_workflow_run"
        ? resolveResourceTarget(input.target ?? "", { kind: "workflow_run" })
        : resolveReleaseTarget(input.target ?? "");
    if (target.kind === "current_checkout") throw new GhExecutionError("validation", "An explicit GitHub resource target is required.");
    if (input.kind === "upload_release_asset") validateAssetPath(input.path ?? "");
    await ensureGh(ctx.signal);
    await ensureHost(target.host, ctx.signal);
    const guarded = input.kind !== "edit_release" && input.kind !== "upload_release_asset";
    if (guarded) {
      const ask = ctx.confirm ?? confirm;
      if (!ctx.hasUI || !ask) throw new GhExecutionError("validation", "Guarded GitHub writes require confirmation UI.");
      const approved = await ask("Confirm GitHub write", actionReleaseEffect(input, target));
      if (!approved) return { projection: { kind: "cancelled", cancelled: true, target, effect: actionReleaseEffect(input, target) }, target };
    }
    const result = await run({ argv: buildActionReleaseArgv(input, target), cwd: ctx.cwd, signal: ctx.signal, timeout: DEFAULT_TIMEOUT_MS }, describeTarget(target));
    return { projection: { kind: actionReleaseResultKind(input.kind), target, output: result.stdout.trim() }, target };
  }

  return { runView, runSearch, runContent, runCi, runIssueWrite, runPullRequestWrite, runActionReleaseWrite, runApiGet, ensureHost };
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
    .filter((part, index, all): part is string => Boolean(part) && all.indexOf(part) === index)
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
        ...(input.ref ? ["--raw-field", `ref=${input.ref}`] : []),
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
  /* Base64 content is fully decoded, mirroring gh_read_file: the contents
   * endpoint always wraps text files in base64 (report issue). */
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
  let listing: unknown[];
  let treeShape = false;
  if (Array.isArray(raw)) {
    listing = raw;
  } else if (raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).tree)) {
    /* The Git trees endpoint returns { sha, url, tree: [...] } and ignores the
     * ?path parameter (each entry carries its full path). Filter locally so a
     * &#96;tree/docs&#96; view actually shows the docs directory (report issue 7). */
    listing = (raw as Record<string, unknown>).tree as unknown[];
    treeShape = true;
    if (path) {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      listing = listing.filter((entry) =>
        entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).path === "string"
          ? ((entry as Record<string, unknown>).path as string).startsWith(prefix)
          : false,
      );
    }
  } else {
    throw new GhExecutionError("malformed_json", "GitHub directory JSON was not an array.");
  }
  const entries = listing.slice(0, limit).map((entry) => compactDirectoryEntry(entry));
  const meta: Record<string, unknown> = { kind: "directory", target, path, ref: ref ?? null, entryCount: entries.length, totalEntryCount: listing.length, entries };
  if (treeShape) {
    meta.pathFiltered = Boolean(path);
    meta.note = path
      ? "The trees endpoint ignores ?path; entries were filtered to the requested directory locally."
      : undefined;
  }
  return meta;
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

interface ChecksContext {
  source: "head-branch" | "head-commit";
  headRefName?: string;
  headRefOid?: string;
  fallbackNote?: string;
}

function waitableCiArgv(input: CiRequestInput, target: ResourceTarget, limit: number, page: number): string[] {
  const repository = formatRepositoryTarget(target)!;
  const cliRepository = cliRepositoryTarget(target);
  switch (input.kind) {
    case "list_runs": {
      /* REST /actions/runs has no conclusion parameter and cannot filter by
       * workflow, so any filtered listing uses `gh run list`, which filters
       * server-side. */
      if (input.workflow || input.branch || input.status || input.conclusion) {
        return [
          "run", "list", "--repo", cliRepository, "--limit", String(limit),
          "--json", `${RUN_VIEW_FIELDS},workflowDatabaseId`,
          ...(input.workflow ? ["--workflow", input.workflow] : []),
          ...(input.branch ? ["--branch", input.branch] : []),
          ...(input.status ? ["--status", input.status] : []),
          ...(!input.status && input.conclusion ? ["--status", input.conclusion] : []),
        ];
      }
      return [
        "api",
        ...hostnameArgs(target),
        `repos/${repository}/actions/runs`,
        "--method",
        "GET",
        "--field",
        `per_page=${limit}`,
        "--field",
        `page=${page}`,
      ];
    }
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

function projectCi(
  raw: unknown,
  kind: Exclude<CiKind, "failed_logs">,
  target: ResourceTarget,
  page: number,
  limit: number,
  checksContext?: ChecksContext,
): Record<string, unknown> {
  if (kind === "list_runs") {
    if (Array.isArray(raw)) {
      /* Filtered listings come from `gh run list`, which returns a bounded
       * array without the REST total_count envelope. */
      const runs = raw.slice(0, limit).map(compactWorkflowRun);
      return { kind: "workflow_runs", target, page, limit, totalCount: null, filtered: true, runCount: runs.length, runs };
    }
    if (!raw || typeof raw !== "object") throw new GhExecutionError("malformed_json", "GitHub workflow-runs JSON was not an object.");
    const value = raw as Record<string, unknown>;
    const runs = Array.isArray(value.workflow_runs) ? value.workflow_runs.slice(0, limit).map(compactWorkflowRun) : [];
    return { kind: "workflow_runs", target, page, limit, totalCount: asNumber(value.total_count), filtered: false, runCount: runs.length, runs };
  }
  if (kind === "pr_checks") {
    if (!checksContext) throw new GhExecutionError("malformed_json", "GitHub checks context was not captured.");
    if (!Array.isArray(raw)) throw new GhExecutionError("malformed_json", "GitHub checks JSON was not an array.");
    const checks = raw.map((entry) => redactUnknown(entry) as Record<string, unknown>);
    const buckets = new Map<string, number>();
    for (const check of checks) {
      const bucket = typeof check.bucket === "string" ? check.bucket : "other";
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    }
    const failures = checks.filter((check) => [String(check.state), String(check.bucket)].some((value) => /failure|fail/i.test(value)));
    const pending = checks.filter((check) => [String(check.state), String(check.bucket)].some((value) => /pending|in_progress/i.test(value)));
    const summary = {
      kind: "pull_request_checks",
      target,
      ...checksContext,
      checkCount: checks.length,
      failedCount: failures.length,
      pendingCount: pending.length,
      buckets: Object.fromEntries(buckets),
      checks,
    };
    if (checks.length === 0) {
      return {
        ...summary,
        empty: true,
        note: "No checks are reported for this pull request. Its head branch may be deleted (merged/squashed PRs) or CI never ran on it.",
      };
    }
    return summary;
  }
  if (!raw || typeof raw !== "object") throw new GhExecutionError("malformed_json", "GitHub CI JSON was not an object.");
  return { kind: kind === "view_job" ? "job" : "workflow_run", target, ...redactUnknown(raw) as Record<string, unknown> };
}

function compactWorkflowRun(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return { value: raw };
  const value = raw as Record<string, unknown>;
  const keys = ["databaseId", "id", "name", "workflowName", "workflowDatabaseId", "displayTitle", "status", "conclusion", "event", "headBranch", "headSha", "attempt", "createdAt", "updatedAt", "url", "html_url"];
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
  const availableSteps = sections.map((section) => section.name);
  if (sections.length === 0) {
    if (raw.trim() === "") {
      return {
        kind: "failed_logs",
        target,
        step: null,
        note: "The --log-failed output is empty: the run has no failed steps (it may have succeeded), or its logs have expired.",
        log: "",
        lineCount: 0,
        byteCount: 0,
        partial: false,
      };
    }
    return {
      kind: "failed_logs",
      target,
      step: null,
      note: "The --log-failed output had no recognizable step sections.",
      availableSteps,
      rawPreview: redactSecrets(raw.slice(0, 2_000)),
      log: "",
      lineCount: 0,
      byteCount: 0,
      partial: false,
    };
  }
  let selected: string[];
  let step: string;
  let partial = false;
  if (requestedStep) {
    const match = sections.find((section) => section.name.toLowerCase().includes(requestedStep.toLowerCase()));
    if (!match) {
      return {
        kind: "failed_logs",
        target,
        step: null,
        requestedStep,
        note: `No failed step named "${requestedStep}" in this run.`,
        availableSteps,
        log: "",
        lineCount: 0,
        byteCount: 0,
        partial: false,
      };
    }
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
  return { kind: "failed_logs", target, step, availableSteps, log, lineCount: bounded.length, byteCount: Buffer.byteLength(log), partial };
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
      "pr", "create", "--repo", repository, "--title", input.title ?? "", "--body", input.body ?? "",
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
  if (input.kind === "review_pull_request") {
    const event = input.event === "request_changes" ? "request-changes" : input.event ?? "comment";
    const body = input.body ?? "";
    if (event === "comment" && body.trim() === "") {
      throw new GhExecutionError("validation", "A comment review requires a non-empty body. Use event approve or request_changes for a body-less review.");
    }
    return ["pr", "review", String(number), "--repo", repository, `--${event}`, "--body", body];
  }
  if (input.kind === "merge_pull_request") return ["pr", "merge", String(number), "--repo", repository, `--${input.method ?? "merge"}`, ...(input.deleteBranch ? ["--delete-branch"] : [])];
  if (input.kind === "close_pull_request") return ["pr", "close", String(number), "--repo", repository];
  if (input.kind === "reopen_pull_request") return ["pr", "reopen", String(number), "--repo", repository];
  return ["pr", "update-branch", String(number), "--repo", repository];
}

function targetPullRequestNumber(target: ResourceTarget): number {
  if (target.kind !== "pull_request") throw new GhExecutionError("validation", "A pull-request target is required.");
  return target.number;
}

type ApiTarget = { kind: "api"; host: string; endpoint: string };

function normalizeApiEndpoint(raw: string): string {
  const trimmed = raw.trim();
  const endpoint = trimmed.replace(/^\/+/, "");
  if (Buffer.byteLength(endpoint, "utf8") > 512) throw new GhExecutionError("validation", "API GET endpoints must be at most 512 bytes.");
  if (!endpoint || endpoint.startsWith("-") || trimmed.startsWith("//") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(endpoint) || /^\/*https?:\/\//i.test(trimmed) || /^https?:\/\//i.test(endpoint) || endpoint.toLowerCase().startsWith("graphql") || endpoint.split("/").some((part) => part === "" || part === "." || part === "..") || /(?:^|\/)(?:archive|zipball|tarball|downloads?|raw)(?:\/|$)/i.test(endpoint) || /(?:^|\/)actions\/(?:artifacts(?:\/|$)|runs\/[^/]+\/logs(?:\/|$)|jobs\/[^/]+\/logs(?:\/|$))/i.test(endpoint) || endpoint.includes(":") || endpoint.includes("%") || endpoint.includes("{") || endpoint.includes("}") || endpoint.includes("?") || endpoint.includes("#") || endpoint.includes("@") || endpoint.includes("\\") || endpoint.includes("\u0000")) {
    throw new GhExecutionError("validation", "API GET endpoints must be relative REST paths without placeholders, queries, fragments, file expansion, or traversal.");
  }
  return endpoint;
}

function validateJq(jq: string | undefined): void {
  if (jq === undefined) return;
  const expression = jq.trim();
  if (expression.includes("(") || expression.includes(")") || expression.includes(";") || expression.includes(",")) {
    throw new GhExecutionError("validation", "API GET jq projections may only use field access, array access, and slice operators (`.a`, `.a[0]`, `.a[:3]`, `[]`, `.[]`).");
  }
  const path = /^(?:\.[A-Za-z_][A-Za-z0-9_]*|\[[0-9]*:[0-9]*\]|\[[0-9]+\]|\[\])+$/;
  if (expression !== "." && (!expression || expression.split("|").some((part) => !path.test(part.trim())))) {
    throw new GhExecutionError("validation", "API GET jq projections are limited to data paths, array indexes, and slices (`.a`, `.a[0]`, `.a[:3]`, `[]`).");
  }
}

function validateApiCache(cache: string | undefined): void {
  if (cache !== undefined && !/^\d+[smh]$/.test(cache)) {
    throw new GhExecutionError("validation", "API GET cache duration must use seconds, minutes, or hours.");
  }
}

function validateApiQuery(query: Record<string, string> | undefined): void {
  const entries = Object.entries(query ?? {});
  if (entries.length > MAX_API_QUERY_ENTRIES) throw new GhExecutionError("validation", "API GET query parameters exceed the entry limit.");
  let totalBytes = 0;
  for (const [key, value] of entries) {
    const keyBytes = Buffer.byteLength(key, "utf8");
    const valueBytes = Buffer.byteLength(value, "utf8");
    totalBytes += keyBytes + valueBytes;
    if (keyBytes > MAX_API_QUERY_KEY_BYTES || valueBytes > MAX_API_QUERY_VALUE_BYTES || totalBytes > MAX_API_QUERY_BYTES || !/^[A-Za-z][A-Za-z0-9_]*$/.test(key) || key === "page" || key === "per_page" || key.includes("@") || key.includes("\u0000") || value.includes("\u0000")) {
      throw new GhExecutionError("validation", "API GET query parameters exceed safety limits or contain forbidden syntax.");
    }
    if (value.includes("@")) {
      throw new GhExecutionError("validation", `Query value for "${key}" must not contain "@" (credential-leak guard). Strip emails or use a search qualifier instead.`);
    }
  }
}

function buildApiGetArgv(input: ApiGetRequestInput, host: string, endpoint: string, page: number, perPage: number): string[] {
  return [
    "api", "--hostname", host, endpoint, "--method", "GET",
    ...Object.entries(input.query ?? {}).flatMap(([key, value]) => ["--raw-field", `${key}=${value}`]),
    "--raw-field", `page=${page}`, "--raw-field", `per_page=${perPage}`,
    ...(input.cache ? ["--cache", input.cache] : []), ...(input.jq ? ["--jq", input.jq] : []),
  ];
}

function projectApiData(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(projectApiData);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, nested]) => [redactSecrets(key), projectApiData(nested)]));
  return value;
}

function resolveReleaseTarget(raw: string): Extract<ResourceTarget, { kind: "release" }> {
  const target = resolveResourceTarget(raw, { kind: "release" });
  if (target.kind !== "release") throw new GhExecutionError("validation", "A release target is required.");
  return target;
}

function actionReleaseResultKind(kind: ActionReleaseKind): string {
  const names: Record<ActionReleaseKind, string> = {
    dispatch_workflow: "workflow_dispatched",
    cancel_workflow_run: "workflow_run_cancelled",
    rerun_workflow_run: "workflow_run_rerun",
    create_release: "release_created",
    edit_release: "release_edited",
    upload_release_asset: "release_asset_uploaded",
    delete_release: "release_deleted",
    delete_release_asset: "release_asset_deleted",
  };
  return names[kind];
}

function actionReleaseEffect(input: ActionReleaseRequestInput, target: ResourceTarget): string {
  const repository = formatRepositoryTarget(target) ?? "repository";
  if (input.kind === "dispatch_workflow") return `Dispatch workflow ${input.workflow ?? ""} on ${repository}`;
  if (input.kind === "cancel_workflow_run") return `Cancel workflow run ${repository}#${targetRunId(target)}`;
  if (input.kind === "rerun_workflow_run") return `Rerun workflow run ${repository}#${targetRunId(target)}`;
  const tag = target.kind === "release" ? target.tag : input.tag ?? "";
  if (input.kind === "create_release") return `Publish release ${repository}@${input.tag ?? ""}`;
  if (input.kind === "delete_release") return `Delete release ${repository}@${tag}`;
  if (input.kind === "delete_release_asset") return `Delete release asset ${repository}@${tag}/${input.asset ?? ""}`;
  return `${input.kind.replace(/_/g, " ")} ${repository}@${tag}`;
}

function buildActionReleaseArgv(input: ActionReleaseRequestInput, target: ResourceTarget): string[] {
  const repository = cliRepositoryTarget(target);
  if (input.kind === "dispatch_workflow") return ["workflow", "run", input.workflow ?? "", "--repo", repository, ...(input.ref ? ["--ref", input.ref] : []), ...Object.entries(input.inputs ?? {}).flatMap(([key, value]) => ["-f", `${key}=${value}`])];
  if (input.kind === "cancel_workflow_run") return ["run", "cancel", String(targetRunId(target)), "--repo", repository];
  if (input.kind === "rerun_workflow_run") return ["run", "rerun", String(targetRunId(target)), "--repo", repository];
  const tag = target.kind === "release" ? target.tag : input.tag ?? "";
  if (input.kind === "create_release") return ["release", "create", input.tag ?? "", "--repo", repository, ...(input.title ? ["--title", input.title] : []), ...(input.notes ? ["--notes", input.notes] : []), ...(input.draft ? ["--draft"] : []), ...(input.prerelease ? ["--prerelease"] : [])];
  if (input.kind === "edit_release") return ["release", "edit", tag, "--repo", repository, ...(input.title ? ["--title", input.title] : []), ...(input.notes ? ["--notes", input.notes] : []), ...(input.draft === true ? ["--draft"] : input.draft === false ? ["--draft=false"] : []), ...(input.prerelease === true ? ["--prerelease"] : input.prerelease === false ? ["--prerelease=false"] : [])];
  if (input.kind === "upload_release_asset") return ["release", "upload", tag, `${input.path ?? ""}${input.label ? `#${input.label}` : ""}`, "--repo", repository];
  if (input.kind === "delete_release") return ["release", "delete", tag, "--repo", repository, "--yes"];
  return ["release", "delete-asset", input.asset ?? "", "--repo", repository, "--yes"];
}

function validateAssetPath(path: string): void {
  if (!path || path.includes("\\") || path.includes("\u0000") || path.split("/").some((part) => part === "..")) {
    throw new GhExecutionError("validation", "Release asset paths must be non-empty and must not contain traversal segments.");
  }
}

/** Describes any non-checkout target so entity errors carry context. */
export function describeTarget(target: ResourceTarget): string {
  if (target.kind === "current_checkout") return "current checkout";
  const repository = formatRepositoryTarget(target);
  if (target.kind === "repository") return repository ?? "repository";
  switch (target.kind) {
    case "issue":
    case "pull_request": {
      const kindName = target.kind === "pull_request" ? "pull request" : "issue";
      return `${repository} ${kindName} #${target.number}`;
    }
    case "commit":
      return `${repository} commit ${target.sha.slice(0, 7)}`;
    case "release":
      return `${repository} release ${target.tag}`;
    case "workflow_run":
      return `${repository} workflow run ${target.runId}`;
    case "job":
      return `${repository} job ${target.jobId} (run ${target.runId})`;
    case "file":
      return `${repository} file ${target.path}@${target.ref}`;
    case "tree":
      return `${repository} tree ${target.path ?? "/"}@${target.ref}`;
    case "compare":
      return `${repository} compare ${target.base}...${target.head}`;
    default:
      return assertNever(target);
  }
}

function viewFallbackHint(target: ResourceTarget): string | undefined {
  if (target.kind === "file") return `Try gh_read_file with ref=${target.ref} or check the path.`;
  if (target.kind === "workflow_run") return "Check the run id; older runs and deleted runs return 404.";
  if (target.kind === "job") return "Check the run id and job id; reconstructed logs expire after 400 days.";
  return undefined;
}

/** Fields newer gh versions expose that 2.81.0 lacks. */
function viewExtras(kind: ViewResourceKind): string[] {
  switch (kind) {
    case "release":
      return RELEASE_VIEW_FIELDS_EXTRA;
    case "workflow_run":
      return RUN_VIEW_FIELDS_EXTRA;
    case "job":
      return JOB_VIEW_FIELDS_EXTRA;
    default:
      return [];
  }
}

function failedLogsHint(input: CiRequestInput, target: ResourceTarget): string | undefined {
  if (input.kind !== "failed_logs") return undefined;
  return "No sections in --log-failed output usually means the run had no failing steps, or the logs have expired.";
}

function readFileNotFoundHint(input: ContentRequestInput, target: ResourceTarget): string | undefined {
  if (input.kind !== "read_file") return undefined;
  return "The contents endpoint defaults to the repository default branch; pass `ref` if the file lives on a different branch.";
}

function ciRunHint(input: CiRequestInput, target: ResourceTarget): string | undefined {
  if (input.kind === "pr_checks") {
    return "This tool checks the PR's head branch by default; if no checks are reported, re-check the PR ref (gh_view) or verify the head commit.";
  }
  return undefined;
}

function jsonFieldList(argv: string[]): string[] {
  const index = argv.indexOf("--json");
  if (index === -1) return [];
  return (argv[index + 1] ?? "").split(",").map((field) => field.trim()).filter(Boolean);
}

function parseUnknownJsonField(stderr: string): string | undefined {
  const match = /Unknown JSON field: "([^"]+)"/i.exec(stderr);
  return match?.[1];
}

/** Parses the URL a created issue/PR prints ("https://github.com/owner/repo/issues/123"). */
function parseCreatedResourceUrl(stdout: string, target: ResourceTarget, kind: "issues" | "pull"): string | undefined {
  const host = target.kind === "current_checkout" ? undefined : target.host;
  const repository = formatRepositoryTarget(target);
  if (!repository) return undefined;
  const hostPattern = host && !isGithubHost(host) ? `(?:https?://)?${escapeRegex(host)}/` : "https://github.com/";
  const match = new RegExp(`${hostPattern}${escapeRegex(repository)}/${kind}/(\\d+)`).exec(stdout.trim());
  return match?.[0];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Resolves a PR via GraphQL (owner/repo#number) so deleted head branches degrade gracefully. */
async function resolveNumberedPullRequest(
  target: Extract<ResourceTarget, { kind: "pull_request" }>,
  signal: AbortSignal | undefined,
  execute: GhExecutor,
): Promise<ResolvedPullRequest | undefined> {
  const query = `query { repository(owner: ${JSON.stringify(target.owner)}, name: ${JSON.stringify(target.name)}) { pullRequest(number: ${target.number}) { number headRefName headRefOid state } } }`;
  const request: GhExecRequest = {
    argv: ["api", "graphql", ...hostnameArgs(target), "--field", `query=${query}`],
    signal,
    timeout: DEFAULT_TIMEOUT_MS,
  };
  const raw = await execute(request);
  const result = { ...raw, stdout: boundedDiagnostics(raw).stdout, stderr: boundedDiagnostics(raw).stderr };
  const category = classifyGhFailure(result, signal);
  if (category) {
    throw new GhExecutionError(category, describeFailureWithContext(category, result, describeTarget(target), "No checks on the head branch (deleted after merge?); resolving the head commit."));
  }
  if (result.code !== 0) {
    throw new GhExecutionError("unsupported", describeFailureWithContext("unsupported", result, describeTarget(target), "No checks on the head branch (deleted after merge?); resolving the head commit."));
  }
  try {
    const decoded = JSON.parse(result.stdout) as {
      data?: { repository?: { pullRequest?: { number?: number; headRefName?: string | null; headRefOid?: string; state?: string } | null } };
    };
    const entry = decoded.data?.repository?.pullRequest;
    if (!entry || entry.number === undefined) return undefined;
    return {
      kind: "PullRequest",
      number: entry.number,
      headRefName: entry.headRefName ?? null,
      headRefOid: entry.headRefOid,
      state: entry.state,
    };
  } catch {
    return undefined;
  }
}

/** Additional verified state echoed after a pull-request write. */
async function pullRequestWriteDetails(
  input: PullRequestRequestInput,
  target: ResourceTarget,
  ctx: { cwd: string; signal?: AbortSignal },
  execute: GhExecutor,
): Promise<Record<string, unknown>> {
  const requested = { method: input.method ?? "merge", deleteBranch: Boolean(input.deleteBranch), event: input.event ?? null } as Record<string, unknown>;
  if (target.kind !== "pull_request") {
    return input.kind === "create_pull_request"
      ? { requested: { ...requested, head: input.head ?? null, base: input.base ?? null, draft: Boolean(input.draft) } }
      : {};
  }
  const base: Record<string, unknown> = { requested };
  if (input.kind === "merge_pull_request") {
    try {
      const resolved = await resolveNumberedPullRequest(target, ctx.signal, execute);
      if (resolved?.state === "MERGED") {
        const prResult = await execute({
          argv: ["pr", "view", String(target.number), "--repo", cliRepositoryTarget(target), "--json", "state,mergedAt,mergeCommit"],
          cwd: ctx.cwd,
          signal: ctx.signal,
          timeout: DEFAULT_TIMEOUT_MS,
        });
        if (prResult.code === 0) {
          const decoded = JSON.parse(prResult.stdout) as { state?: unknown; mergedAt?: unknown; mergeCommit?: unknown };
          base.merged = { state: decoded.state ?? null, mergedAt: decoded.mergedAt ?? null, mergeCommit: decoded.mergeCommit ?? null };
        } else {
          base.merged = null;
        }
      } else {
        base.merged = null;
      }
    } catch {
      base.merged = null;
    }
  }
  return base;
}

/** Runs CI reads with pr_checks fallback to the head commit's check-runs. */
async function runChecks(
  input: CiRequestInput,
  target: ResourceTarget,
  limit: number,
  page: number,
  ctx: { cwd: string; signal?: AbortSignal },
  lower: (argv: string[]) => Promise<GhExecResult>,
  execute: GhExecutor,
): Promise<{ result: GhExecResult; checksContext?: ChecksContext }> {
  const executing = async (argv: string[]) => lower(argv);
  if (input.kind === "pr_checks" && target.kind === "pull_request") {
    /* First attempt runs outside the error classifier so the "no checks"
     * signal can drive the head-commit fallback instead of throwing. */
    const argv = waitableCiArgv(input, target, limit, page);
    const rawFirst = await execute({ argv, signal: ctx.signal, timeout: DEFAULT_TIMEOUT_MS });
    const first = {
      ...rawFirst,
      stdout: boundedDiagnostics(rawFirst).stdout,
      stderr: boundedDiagnostics(rawFirst).stderr,
    };
    const noChecks = /no checks reported/i.test(first.stderr) || (first.code !== 0 && first.stdout === "");
    if (!noChecks) {
      const category = classifyGhFailure(first, ctx.signal);
      if (category || first.code !== 0) {
        throw new GhExecutionError(
          category ?? "unsupported",
          describeFailureWithContext(category ?? "unsupported", first, describeTarget(target), ciRunHint(input, target)),
        );
      }
    }
    if (noChecks) {
      let resolved: ResolvedPullRequest | undefined;
      try {
        resolved = await resolveNumberedPullRequest(target, ctx.signal, execute);
      } catch {
        resolved = undefined;
      }
      if (resolved?.headRefOid) {
        const fallbackArgv = [
          "api",
          ...hostnameArgs(target),
          `repos/${formatRepositoryTarget(target)!}/commits/${encodeURIComponent(resolved.headRefOid)}/check-runs`,
          "--method",
          "GET",
          "--field",
          `per_page=${limit}`,
        ];
        const fallback = await executing(fallbackArgv);
        const decoded = decodeJson(fallback);
        if (decoded && typeof decoded === "object") {
          const runs = (decoded as { check_runs?: unknown[] }).check_runs;
          if (Array.isArray(runs)) {
            const normalized = runs.map((run) =>
              run && typeof run === "object"
                ? {
                    name: (run as Record<string, unknown>).name,
                    state: String((run as Record<string, unknown>).conclusion ?? (run as Record<string, unknown>).status ?? "UNKNOWN").toUpperCase(),
                    bucket: (run as Record<string, unknown>).conclusion ?? null,
                    link: (run as Record<string, unknown>).html_url ?? (run as Record<string, unknown>).details_url ?? null,
                    workflow: (run as Record<string, unknown>).app && typeof (run as Record<string, unknown>).app === "object"
                      ? ((run as Record<string, unknown>).app as Record<string, unknown>).name ?? null
                      : null,
                  }
                : null,
            ).filter((run) => Boolean(run));
            return {
              result: { ...fallback, stdout: JSON.stringify(normalized) },
              checksContext: {
                source: "head-commit",
                headRefName: resolved.headRefName ?? undefined,
                headRefOid: resolved.headRefOid,
                fallbackNote: "No checks on the head branch (deleted after merge?); these are the head commit's check-runs.",
              },
            };
          }
        }
      }
    }
    return { result: first, checksContext: { source: "head-branch" } };
  }
  if (input.kind === "list_runs") {
    return { result: await executing(waitableCiArgv(input, target, limit, page)) };
  }
  return { result: await executing(waitableCiArgv(input, target, limit, page)) };
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
  if (target.kind === "tree") {
    const filtered = filterTreeToPath(raw, target.path);
    return {
      kind: target.kind,
      target: targetProjection,
      ...(target.path ? { note: "The trees endpoint ignores ?path; entries below were filtered locally." } : {}),
      data: redactUnknown(filtered),
    };
  }
  return {
    kind: target.kind,
    target: targetProjection,
    data: redactUnknown(raw),
  };
}

/** Filters a Git-trees response ({ tree: [...] }) to a directory prefix. */
function filterTreeToPath(raw: unknown, path: string | undefined): unknown {
  if (!path || !raw || typeof raw !== "object") return raw;
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.tree)) return raw;
  const prefix = path.endsWith("/") ? path : `${path}/`;
  return {
    ...value,
    tree: value.tree.filter((entry) =>
      entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).path === "string"
        ? ((entry as Record<string, unknown>).path as string).startsWith(prefix)
        : false,
    ),
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
  if (!hosts || typeof hosts !== "object" || Array.isArray(hosts)) return [];
  return Object.entries(hosts)
    .filter(([, accounts]) => authenticatedAccountState(accounts))
    .map(([host]) => normalizeHost(host));
}

function authenticatedAccountState(accounts: unknown): boolean {
  if (!Array.isArray(accounts) || accounts.length === 0) return false;
  const records = accounts.filter((account): account is Record<string, unknown> => Boolean(account) && typeof account === "object");
  const active = records.filter((account) => account.active === true);
  return active.length > 0 && active.every((account) => account.state === "success");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new GhExecutionError("aborted", describeFailure("aborted", emptyResult()));
  }
}

function boundedDiagnostics(result: GhExecResult): GhExecResult {
  const bound = (value: string) => {
    const bytes = Buffer.from(value, "utf8");
    if (bytes.length <= MAX_API_RESPONSE_BYTES) return value;
    const suffix = Buffer.from("…[truncated]", "utf8");
    const limit = Math.max(0, MAX_API_RESPONSE_BYTES - suffix.length);
    let prefix = bytes.subarray(0, limit).toString("utf8");
    while (Buffer.byteLength(prefix, "utf8") > limit) prefix = prefix.slice(0, -1);
    return prefix + suffix.toString("utf8");
  };
  return { ...result, stdout: bound(result.stdout), stderr: bound(result.stderr) };
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
