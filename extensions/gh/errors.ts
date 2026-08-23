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
  /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+/gi;
const AUTH_HEADER_SECRET_RE = /(?:authorization\s*[:=]\s*)?(?:bearer|basic|token)(?:\s|\\u00(?:20|09)|\\t)+[^\s,;"\\]+/gi;
const PRIVATE_KEY_RE = /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY(?: BLOCK)?-----/g;

function replaceSecrets(text: string): string {
  return redactUnquotedSensitiveFields(redactJsonSensitiveFields(text))
    .replace(PRIVATE_KEY_RE, "[redacted]")
    .replace(AUTH_HEADER_SECRET_RE, "[redacted]")
    .replace(SECRET_RE, "[redacted]");
}

function redactUnquotedSensitiveFields(text: string): string {
  const output: string[] = [];
  let copyStart = 0;
  for (let index = 0; index < text.length;) {
    if (!/[a-z0-9_]/i.test(text[index] ?? "") || /[a-z0-9_]/i.test(text[index - 1] ?? "")) {
      index += 1;
      continue;
    }
    const keyStart = index;
    while (/[a-z0-9_]/i.test(text[index] ?? "")) index += 1;
    const keyEnd = index;
    if (text[index] === '"') index += 1;
    while (/\s/.test(text[index] ?? "")) index += 1;
    if (!isSensitiveKey(text.slice(keyStart, keyEnd)) || (text[index] !== ":" && text[index] !== "=")) {
      index = keyEnd;
      continue;
    }
    index += 1;
    while (/\s/.test(text[index] ?? "")) index += 1;
    if (text[index] === '"') {
      index += 1;
      while (index < text.length) {
        if (text[index] === "\\") {
          index += Math.min(2, text.length - index);
          continue;
        }
        index += 1;
        if (text[index - 1] === '"') break;
      }
    } else {
      while (index < text.length && !/[\r\n,;}]/.test(text[index]!)) index += 1;
    }
    output.push(text.slice(copyStart, keyStart), "[redacted]");
    copyStart = index;
  }
  if (copyStart === 0) return text;
  output.push(text.slice(copyStart));
  return output.join("");
}

function redactJsonSensitiveFields(text: string): string {
  const output: string[] = [];
  let copyStart = 0;
  for (let index = 0; index < text.length;) {
    if (text[index] !== '"') {
      index += 1;
      continue;
    }
    const keyStart = index;
    index += 1;
    const contentStart = index;
    while (index < text.length) {
      if (text[index] === "\\") {
        index += Math.min(2, text.length - index);
        continue;
      }
      if (text[index] === '"') break;
      index += 1;
    }
    if (index >= text.length) break;
    const keyEnd = index;
    let colon = keyEnd + 1;
    while (/\s/.test(text[colon] ?? "")) colon += 1;
    if (text[colon] !== ":" || !isSensitiveKey(text.slice(contentStart, keyEnd))) {
      index = keyEnd + 1;
      continue;
    }
    let valueStart = colon + 1;
    while (/\s/.test(text[valueStart] ?? "")) valueStart += 1;
    let valueEnd = valueStart;
    if (text[valueStart] === '"') {
      valueEnd += 1;
      while (valueEnd < text.length) {
        if (text[valueEnd] === "\\") {
          valueEnd += Math.min(2, text.length - valueEnd);
          continue;
        }
        valueEnd += 1;
        if (text[valueEnd - 1] === '"') break;
      }
    } else {
      while (valueEnd < text.length && !/[\r\n,;}]/.test(text[valueEnd]!)) valueEnd += 1;
    }
    output.push(text.slice(copyStart, keyStart), '"[redacted]":"[redacted]"');
    copyStart = valueEnd;
    index = valueEnd;
  }
  if (copyStart === 0) return text;
  output.push(text.slice(copyStart));
  return output.join("");
}

export function isSensitiveKey(key: string): boolean {
  const keyWithoutEscapedQuotes = key
    .replace(/\\(?:u005c)*u0022/gi, "")
    .replace(/\\"/g, "");
  const normalized = canonicalizeJsonEscapes(keyWithoutEscapedQuotes).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  return ["authorization", "credential", "credentials", "key"].includes(normalized)
    || ["token", "secret", "password", "key"].some((suffix) => normalized.endsWith(suffix));
}

export function redactSecrets(text: string): string {
  return redactRawSecrets(text);
}

/** Canonicalize nested JSON-style escapes before scanning untrusted text.
 * Escape spelling is preserved when no secret is found. */
export function redactRawSecrets(text: string): string {
  // Redact syntactically valid raw fields first so escaped quote characters
  // inside a quoted value cannot become false delimiters during canonicalization.
  const directlyRedacted = replaceSecrets(text);
  const canonical = canonicalizeJsonEscapes(directlyRedacted);
  const redacted = replaceSecrets(canonical);
  return directlyRedacted === text && redacted === canonical ? text : redacted;
}

function canonicalizeJsonEscapes(text: string): string {
  if (!text.includes("\\")) return text;
  const controls: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
  const output: string[] = [];
  for (let index = 0; index < text.length;) {
    if (text[index] !== "\\") {
      output.push(text[index]!);
      index += 1;
      continue;
    }
    const slashStart = index;
    while (text[index] === "\\") index += 1;
    const afterSlashes = index;
    let chainEnd = afterSlashes;
    while (text.slice(chainEnd, chainEnd + 5).toLowerCase() === "u005c") chainEnd += 5;
    const unicodeAt = chainEnd > afterSlashes ? chainEnd : afterSlashes;
    const hex = text.slice(unicodeAt + 1, unicodeAt + 5);
    if ((text[unicodeAt] === "u" || text[unicodeAt] === "U") && /^[0-9a-f]{4}$/i.test(hex) && hex.toLowerCase() !== "0022") {
      output.push(String.fromCharCode(Number.parseInt(hex, 16)));
      index = unicodeAt + 5;
      continue;
    }
    const escaped = text[unicodeAt];
    if (escaped && (Object.hasOwn(controls, escaped) || ["\\", "/"].includes(escaped))) {
      output.push(controls[escaped] ?? escaped);
      index = unicodeAt + 1;
      continue;
    }
    output.push(text.slice(slashStart, afterSlashes));
  }
  return output.join("");
}

export class GhExecutionError extends Error {
  readonly category: ErrorCategory;
  readonly details: Record<string, unknown>;

  constructor(category: ErrorCategory, message: string, details: Record<string, unknown> = {}) {
    super(redactRawSecrets(message));
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
  const stderr = redactRawSecrets(result.stderr.trim());
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
  const prefix = `[${redactRawSecrets(targetDescription)}]`;
  return hint && base !== hint ? `${prefix} ${base} ${hint}` : `${prefix} ${base}`;
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactRawSecrets(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
      redactRawSecrets(key),
      isSensitiveKey(key) ? "[redacted]" : redactValue(nested),
    ]));
  }
  return value;
}
