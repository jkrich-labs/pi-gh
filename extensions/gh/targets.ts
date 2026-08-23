import { GhExecutionError } from "./errors.ts";

export type ResourceTarget =
  | { kind: "repository"; host: "github.com"; owner: string; name: string }
  | { kind: "current_checkout" };

export function resolveResourceTarget(raw: string | undefined): ResourceTarget {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "" || trimmed === ".") return { kind: "current_checkout" };

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
    return fromHostPath(url.hostname, url.pathname);
  }

  const parts = trimmed.replace(/\.git$/i, "").split("/").filter(Boolean);
  if (parts.length === 2) {
    return repository(parts[0]!, parts[1]!);
  }
  if (parts.length === 3 && isGithubHost(parts[0]!)) {
    return repository(parts[1]!, parts[2]!);
  }
  throw new GhExecutionError("unsupported", `Unsupported resource target: ${trimmed}`);
}

export function formatRepositoryTarget(target: ResourceTarget): string | undefined {
  if (target.kind === "current_checkout") return undefined;
  return `${target.owner}/${target.name}`;
}

function fromHostPath(host: string, pathname: string): ResourceTarget {
  if (!isGithubHost(host)) {
    throw new GhExecutionError("unsupported", `Unsupported GitHub host: ${host}`);
  }
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 2) {
    return repository(parts[0]!, stripGit(parts[1]!));
  }
  throw new GhExecutionError("unsupported", `Unsupported GitHub URL path: ${pathname}`);
}

function isGithubHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "github.com" || normalized === "www.github.com";
}

function stripGit(name: string): string {
  return name.replace(/\.git$/i, "");
}

function repository(owner: string, name: string): ResourceTarget {
  if (!owner || !name) {
    throw new GhExecutionError("validation", "Repository resource target needs an owner and name.");
  }
  return { kind: "repository", host: "github.com", owner, name };
}
