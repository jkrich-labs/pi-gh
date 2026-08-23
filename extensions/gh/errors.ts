export type ErrorCategory =
  | "missing_cli"
  | "unsupported_version"
  | "auth"
  | "permission"
  | "not_found"
  | "timeout"
  | "aborted"
  | "malformed_json"
  | "validation"
  | "rate_limit"
  | "conflict"
  | "cancelled"
  | "unsupported";

const SECRET_RE =
  /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|(?:token|access_token|authorization)=[^\s]+/gi;

export function redactSecrets(text: string): string {
  return text.replace(SECRET_RE, "[redacted]");
}

export class GhExecutionError extends Error {
  readonly category: ErrorCategory;
  readonly details: Record<string, unknown>;

  constructor(category: ErrorCategory, message: string, details: Record<string, unknown> = {}) {
    super(redactSecrets(message));
    this.name = "GhExecutionError";
    this.category = category;
    this.details = redactValue(details) as Record<string, unknown>;
  }
}

export function isMissingCli(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  return code === "ENOENT" || /ENOENT|not found|cannot find/i.test(message);
}

export function classifyGhFailure(
  result: { stdout: string; stderr: string; code: number; killed: boolean },
  signal?: AbortSignal,
): ErrorCategory | undefined {
  if (signal?.aborted) return "aborted";
  if (result.killed) return "timeout";
  const text = `${result.stderr}\n${result.stdout}`;
  if (result.code === 4 || /auth login|authentication required|not logged in|not authenticated|login required|bad credentials|HTTP 401/i.test(text)) {
    return "auth";
  }
  if (/could not resolve to a repository|HTTP 404|\bnot found\b/i.test(text)) return "not_found";
  if (/resource not accessible|permission denied|HTTP 403|forbidden/i.test(text)) return "permission";
  if (/rate limit|HTTP 429/i.test(text)) return "rate_limit";
  if (/already exists|HTTP 409|conflict/i.test(text)) return "conflict";
  if (result.code !== 0) return undefined;
  return undefined;
}

export function describeFailure(
  category: ErrorCategory,
  result: { stdout: string; stderr: string; code: number },
): string {
  const stderr = redactSecrets(result.stderr.trim());
  switch (category) {
    case "auth":
      return stderr || "GitHub authentication is required. Run gh auth login.";
    case "permission":
      return stderr || "GitHub denied permission for this resource target.";
    case "not_found":
      return stderr || "GitHub resource target was not found.";
    case "timeout":
      return "GitHub CLI timed out.";
    case "aborted":
      return "GitHub CLI call was aborted.";
    case "missing_cli":
      return "gh is not installed or not on PATH. Install GitHub CLI 2.81.0 or newer.";
    case "unsupported_version":
      return stderr || "gh is too old. Install GitHub CLI 2.81.0 or newer.";
    case "malformed_json":
      return "gh returned output that is not valid JSON.";
    default:
      return stderr || `GitHub CLI failed with exit ${result.code}.`;
  }
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, redactValue(nested)]));
  }
  return value;
}
