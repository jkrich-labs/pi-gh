// Live verification harness for the fix set. Uses the real gh binary.
import { spawn, spawnSync } from "node:child_process";
import { createPipeline } from "../extensions/gh/execute.ts";

/** Discovers a recent job URL so the harness stays valid as CI history rolls. */
function getJobUrl(): string {
  return discoverJobUrlSync() ?? "https://github.com/cli/cli/actions/runs/32650957437/job/97222365327";
}

function discoverJobUrlSync(): string | undefined {
  try {
    const runs = spawnSync("gh", ["run", "list", "--repo", "cli/cli", "--limit", "5", "--json", "databaseId,status"], { encoding: "utf8" });
    const listed = JSON.parse(runs.stdout) as Array<{ databaseId: number; status: string }>;
    for (const run of listed) {
      const jobs = spawnSync("gh", ["api", `repos/cli/cli/actions/runs/${run.databaseId}/jobs`, "--jq", ".jobs[0].id"], { encoding: "utf8" });
      const jobId = jobs.stdout.trim();
      if (/^\d+$/.test(jobId)) return `https://github.com/cli/cli/actions/runs/${run.databaseId}/job/${jobId}`;
    }
  } catch {
    // fall through to the static fallback
  }
  return undefined;
}

const executor = async (request) =>
  new Promise((resolve, reject) => {
    const child = spawn("gh", request.argv, {
      cwd: request.cwd,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timeout"));
    }, request.timeout ?? 30_000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1, killed: false });
    });
    child.on("error", reject);
  });

const pipeline = createPipeline({ executor });
const ctx = { cwd: "/home/johnr/dev/repos/pi-superbundle/pi-gh", signal: undefined };

const cases = [
  ["release view (isLatest fallback)", () =>
    pipeline.runView({ target: "https://github.com/cli/cli/releases/tag/v2.81.0" }, ctx),
  ],
  ["job view (completedAt fallback)", () =>
    pipeline.runView({ target: getJobUrl() }, ctx),
  ],
  ["search issues is:issue (classification fix)", () =>
    pipeline.runSearch({ kind: "issues", query: "is:issue", repo: "cli/cli", limit: 3 }, ctx),
  ],
  ["list runs conclusion=failure (filter fix)", () =>
    pipeline.runCi({ kind: "list_runs", repo: "cli/cli", conclusion: "failure", limit: 5 }, ctx),
  ],
  ["pr_checks merged PR deleted head branch (fallback)", () =>
    pipeline.runCi({ kind: "pr_checks", target: "https://github.com/cli/cli/pull/1" }, ctx),
  ],
  ["failed_logs on successful run (step hint)", () =>
    pipeline.runCi({ kind: "failed_logs", target: "https://github.com/cli/cli/actions/runs/32650957437" }, ctx).then(
      (r) => ({ ...r, projection: { step: r.projection.step, note: r.projection.note ?? null, availableSteps: r.projection.availableSteps ?? null } }),
    ),
  ],
  [
    "view file base64 decode", () =>
    pipeline.runView({ target: "https://github.com/octocat/Hello-World/blob/master/README" }, ctx).then(
      (r) => ({ ...r, projection: { kind: r.projection.kind, ref: r.projection.ref ?? null, content: typeof r.projection.content === "string" ? r.projection.content : "<not decoded>", contentBase64: typeof r.projection.contentBase64 === "string" ? r.projection.contentBase64.slice(0, 24) : null } }),
    ),
  ],
  ["view nonexistent file (hint)", () =>
    pipeline.runView({ target: "https://github.com/octocat/Hello-World/blob/master/nonexistent.md" }, ctx).then(
      () => ({ error: "NO THROW" }),
      (e) => ({ error: `${e.category}: ${e.message}` }),
    ),
  ],
  ["list runs workflow Triage (workflow filter fix)", () =>
    pipeline.runCi({ kind: "list_runs", repo: "cli/cli", workflow: "Triage Scheduled Tasks", limit: 3 }, ctx),
  ],
];

for (const [name, fn] of cases) {
  try {
    const out = await fn();
    console.log(`✔ ${name}`);
    console.log(JSON.stringify(out).slice(0, 600));
  } catch (e) {
    console.log(`✖ ${name}: ${e.category ?? "?"} ${e.message ?? e}`);
  }
  console.log("---");
}
