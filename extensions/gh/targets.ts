import { GhExecutionError } from "./errors.ts";

export type ViewResourceKind =
  | "repository"
  | "issue"
  | "pull_request"
  | "commit"
  | "release"
  | "workflow_run"
  | "job"
  | "file"
  | "tree"
  | "compare";

export type ResourceTarget =
  | { kind: "repository"; host: string; owner: string; name: string }
  | { kind: "current_checkout" }
  | { kind: "issue"; host: string; owner: string; name: string; number: number }
  | { kind: "pull_request"; host: string; owner: string; name: string; number: number }
  | { kind: "commit"; host: string; owner: string; name: string; sha: string }
  | { kind: "release"; host: string; owner: string; name: string; tag: string }
  | { kind: "workflow_run"; host: string; owner: string; name: string; runId: number }
  | { kind: "job"; host: string; owner: string; name: string; runId: number; jobId: number }
  | { kind: "file"; host: string; owner: string; name: string; ref: string; path: string }
  | { kind: "tree"; host: string; owner: string; name: string; ref: string; path?: string }
  | { kind: "compare"; host: string; owner: string; name: string; base: string; head: string };

export interface ResolveTargetOptions {
  kind?: ViewResourceKind;
}

export function resolveResourceTarget(raw: string | undefined, options: ResolveTargetOptions = {}): ResourceTarget {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "" || trimmed === ".") {
    if (options.kind && options.kind !== "repository") {
      throw new GhExecutionError("validation", "The current checkout can only be viewed as a repository.");
    }
    return { kind: "current_checkout" };
  }

  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new GhExecutionError("validation", "Invalid resource target URL.");
    }
    if (url.username || url.password) {
      throw new GhExecutionError("validation", "Resource target URLs must not include credentials.");
    }
    if (url.port) {
      throw new GhExecutionError("unsupported", "GitHub resource URLs must not include a port.");
    }
    const target = fromHostPath(normalizeHost(url.hostname), url.pathname);
    assertKind(target, options.kind);
    return target;
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    throw new GhExecutionError("unsupported", `Unsupported resource target: ${trimmed}`);
  }

  const identifier = parseIdentifier(trimmed, options.kind);
  if (identifier) return identifier;

  const parts = trimmed.replace(/\.git$/i, "").split("/").filter(Boolean);
  if (parts.length === 2) {
    const target = repository("github.com", parts[0]!, parts[1]!);
    assertKind(target, options.kind);
    return target;
  }
  if (parts.length === 3) {
    const target = repository(normalizeHost(parts[0]!), parts[1]!, parts[2]!);
    assertKind(target, options.kind);
    return target;
  }
  throw new GhExecutionError("unsupported", `Unsupported resource target: ${trimmed}`);
}

export function formatRepositoryTarget(target: ResourceTarget): string | undefined {
  if (target.kind === "current_checkout") return undefined;
  return `${target.owner}/${target.name}`;
}

export function formatHost(target: ResourceTarget): string | undefined {
  if (target.kind === "current_checkout") return undefined;
  return target.host === "github.com" ? undefined : target.host;
}

export function normalizeHost(host: string): string {
  const normalized = host.trim().toLowerCase().replace(/\.$/, "");
  if (normalized === "www.github.com") return "github.com";
  return normalized;
}

export function isGithubHost(host: string): boolean {
  return normalizeHost(host) === "github.com";
}

function fromHostPath(host: string, pathname: string): ResourceTarget {
  const parts = pathname
    .split("/")
    .filter(Boolean)
    .map(decodePathPart);
  if (parts.length < 2) {
    throw new GhExecutionError("unsupported", `Unsupported GitHub URL path: ${pathname}`);
  }

  const owner = parts[0]!;
  const name = stripGit(parts[1]!);
  if (parts.length === 2) return repository(host, owner, name);

  const action = parts[2]!;
  switch (action) {
    case "issues":
      return issueTarget(host, owner, name, parts[3], parts.length);
    case "pull":
    case "pulls":
      return pullRequestTarget(host, owner, name, parts[3], parts.length);
    case "commit":
    case "commits":
      return commitTarget(host, owner, name, parts[3], parts.length);
    case "releases":
      if (parts[3] === "tag") return releaseTarget(host, owner, name, parts[4], parts.length, 5);
      if (parts[3] === "latest") return releaseTarget(host, owner, name, "latest", parts.length, 4);
      throw unsupportedPath(pathname);
    case "actions":
      if (parts[3] !== "runs") throw unsupportedPath(pathname);
      return workflowTarget(host, owner, name, parts.slice(4), pathname);
    case "blob":
      return contentTarget(host, owner, name, parts.slice(3), "file", pathname);
    case "tree":
      return contentTarget(host, owner, name, parts.slice(3), "tree", pathname);
    case "compare":
      return compareTarget(host, owner, name, parts[3], pathname);
    default:
      throw unsupportedPath(pathname);
  }
}

function parseIdentifier(raw: string, kindHint?: ViewResourceKind): ResourceTarget | undefined {
  const hash = /^(.*)#(\d+)$/.exec(raw);
  if (hash) {
    if (kindHint !== "issue" && kindHint !== "pull_request") {
      throw new GhExecutionError(
        "validation",
        "An owner/repo#number target is ambiguous; set kind to issue or pull_request.",
      );
    }
    const repo = parseRepositoryIdentifier(hash[1]!);
    return kindHint === "issue"
      ? issueTarget(repo.host, repo.owner, repo.name, hash[2], 4)
      : pullRequestTarget(repo.host, repo.owner, repo.name, hash[2], 4);
  }

  const at = /^(.*)@([^@/]+)$/.exec(raw);
  if (at && (kindHint === "commit" || kindHint === "release")) {
    const repo = parseRepositoryIdentifier(at[1]!);
    return kindHint === "commit"
      ? commitTarget(repo.host, repo.owner, repo.name, at[2], 4)
      : releaseTarget(repo.host, repo.owner, repo.name, at[2], 4, 4);
  }

  return undefined;
}

function parseRepositoryIdentifier(raw: string): { host: string; owner: string; name: string } {
  const parts = raw.replace(/\.git$/i, "").split("/").filter(Boolean);
  if (parts.length === 2) return { host: "github.com", owner: parts[0]!, name: parts[1]! };
  if (parts.length === 3) {
    return { host: normalizeHost(parts[0]!), owner: parts[1]!, name: parts[2]! };
  }
  throw new GhExecutionError("validation", `Invalid repository identifier: ${raw}`);
}

function repository(host: string, owner: string, name: string): ResourceTarget {
  if (!owner || !name || owner.includes("#") || name.includes("#")) {
    throw new GhExecutionError("validation", "Repository resource target needs an owner and name.");
  }
  return { kind: "repository", host: normalizeHost(host), owner, name };
}

function issueTarget(host: string, owner: string, name: string, rawNumber: string | undefined, length: number): ResourceTarget {
  return { kind: "issue", ...repoFields(host, owner, name), number: resourceNumber(rawNumber, length, 4) };
}

function pullRequestTarget(
  host: string,
  owner: string,
  name: string,
  rawNumber: string | undefined,
  length: number,
): ResourceTarget {
  return { kind: "pull_request", ...repoFields(host, owner, name), number: resourceNumber(rawNumber, length, 4) };
}

function commitTarget(host: string, owner: string, name: string, sha: string | undefined, length: number): ResourceTarget {
  if (!sha || length !== 4 || sha.includes("/")) throw new GhExecutionError("unsupported", "Invalid commit URL target.");
  return { kind: "commit", ...repoFields(host, owner, name), sha };
}

function releaseTarget(
  host: string,
  owner: string,
  name: string,
  tag: string | undefined,
  length: number,
  expectedLength: number,
): ResourceTarget {
  if (!tag || length !== expectedLength || tag.includes("/")) {
    throw new GhExecutionError("unsupported", "Invalid release URL target.");
  }
  return { kind: "release", ...repoFields(host, owner, name), tag };
}

function workflowTarget(
  host: string,
  owner: string,
  name: string,
  parts: string[],
  pathname: string,
): ResourceTarget {
  if (parts.length === 1) {
    return { kind: "workflow_run", ...repoFields(host, owner, name), runId: positiveNumber(parts[0], pathname) };
  }
  if ((parts[1] === "job" || parts[1] === "jobs") && parts.length === 3) {
    return {
      kind: "job",
      ...repoFields(host, owner, name),
      runId: positiveNumber(parts[0], pathname),
      jobId: positiveNumber(parts[2], pathname),
    };
  }
  throw unsupportedPath(pathname);
}

function contentTarget(
  host: string,
  owner: string,
  name: string,
  parts: string[],
  kind: "file" | "tree",
  pathname: string,
): ResourceTarget {
  if (parts.length < 1) throw unsupportedPath(pathname);
  const ref = parts[0]!;
  const path = parts.slice(1).join("/");
  if (kind === "file" && !path) throw unsupportedPath(pathname);
  return kind === "file"
    ? { kind, ...repoFields(host, owner, name), ref, path }
    : { kind, ...repoFields(host, owner, name), ref, ...(path ? { path } : {}) };
}

function compareTarget(host: string, owner: string, name: string, expression: string | undefined, pathname: string): ResourceTarget {
  if (!expression) throw unsupportedPath(pathname);
  const separator = expression.indexOf("...");
  if (separator <= 0 || separator === expression.length - 3) throw unsupportedPath(pathname);
  return {
    kind: "compare",
    ...repoFields(host, owner, name),
    base: expression.slice(0, separator),
    head: expression.slice(separator + 3),
  };
}

function repoFields(host: string, owner: string, name: string): { host: string; owner: string; name: string } {
  const repo = repository(host, owner, name);
  if (repo.kind !== "repository") throw new Error("repository target narrowing failed");
  return { host: repo.host, owner: repo.owner, name: repo.name };
}

function resourceNumber(raw: string | undefined, length: number, expectedLength: number): number {
  if (!raw || length !== expectedLength || !/^\d+$/.test(raw)) {
    throw new GhExecutionError("unsupported", "Invalid numbered GitHub resource URL target.");
  }
  return positiveNumber(raw, raw);
}

function positiveNumber(raw: string | undefined, context: string): number {
  if (!raw || !/^\d+$/.test(raw)) throw new GhExecutionError("unsupported", `Invalid numeric GitHub target: ${context}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GhExecutionError("validation", `GitHub target number must be a positive integer: ${context}`);
  }
  return value;
}

function assertKind(target: ResourceTarget, kind: ViewResourceKind | undefined): void {
  if (!kind) return;
  const actual = target.kind === "current_checkout" ? "repository" : target.kind;
  if (actual !== kind) {
    throw new GhExecutionError("validation", `Target kind ${actual} does not match requested kind ${kind}.`);
  }
}

function decodePathPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new GhExecutionError("validation", "Resource target URL contains invalid encoding.");
  }
}

function stripGit(name: string): string {
  return name.replace(/\.git$/i, "");
}

function unsupportedPath(pathname: string): GhExecutionError {
  return new GhExecutionError("unsupported", `Unsupported GitHub URL path: ${pathname}`);
}
