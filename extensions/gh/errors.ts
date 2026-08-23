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
  | "not_mergeable"
  | "required_checks"
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

/** Error-message context applied before stderr takes over (see describeFailureWithContext). */
export function classifyGhFailure(
  result: { stdout: string; stderr: string; code: number; killed: boolean },
  signal?: AbortSignal,
): ErrorCategory | undefined {
  if (signal?.aborted) return "aborted";
  if (result.killed) return "timeout";
  // Exit 0 means gh succeeded; treating a successful response body as a failure
  // produced the impossible "failed with exit 0" error (report issue).
  if (result.code === 0) return undefined;
  const text = `${result.stderr}\n${result.stdout}`;
  if (result.code === 4 || /auth login|authentication required|not logged in|not authenticated|login required|bad credentials|HTTP 401/i.test(text)) {
    return "auth";
  }
  // Matches both REST refs ("Could not resolve to a repository") and GraphQL
  // refs ("Could not resolve to an issue or a pull request").
  if (/could not resolve to an?|HTTP 404|\bnot found\b/i.test(text)) return "not_found";
  if (/no checks reported/i.test(text)) return "not_found";
  if (/resource not accessible|permission denied|HTTP 403|forbidden/i.test(text)) return "permission";
  if (/rate limit|HTTP 429/i.test(text)) return "rate_limit";
  if (/already exists|HTTP 409|conflict/i.test(text)) return "conflict";
  if (/not mergeable|mergeability/i.test(text)) return "not_mergeable";
  if (/required (?:status )?checks|checks have not passed|status checks have not passed/i.test(text)) return "required_checks";
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

/** Like describeFailure, but prepends the target description so failures name the resource they hit. */
export function describeFailureWithContext(
  category: ErrorCategory,
  result: { stdout: string; stderr: string; code: number },
  targetDescription: string,
  hint?: string,
): string {
  const base = describeFailure(category, result);
  const prefix = `[${redactSecrets(targetDescription)}]`;
  return hint && base !== hint ? `${prefix} ${base} ${hint}` : `${prefix} ${base}`;
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, redactValue(nested)]));
  }
  return value;
}
