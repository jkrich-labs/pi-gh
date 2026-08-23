import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

interface Fixture {
  name: string;
  prompt: string;
  tools: string[];
  args?: Record<string, unknown>;
}
interface EventRecord { type?: string; toolName?: string; args?: Record<string, unknown> }

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : process.argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

const provider = option("--provider");
const model = option("--model");
const fixturePath = process.env.PI_GH_LIVE_EVAL_FIXTURES ?? join(process.cwd(), "eval/fixtures.json");
if (!provider || !model) {
  console.error("Usage: npm run eval:live -- --provider <provider> --model <model>");
  process.exit(2);
}

const fixtures = JSON.parse(await readFile(fixturePath, "utf8")) as Fixture[];
const shimDir = await mkdtemp(join(tmpdir(), "pi-gh-eval-"));
const shim = join(shimDir, "gh");
await writeFile(shim, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("gh version 2.81.0"); process.exit(0); }
if (args[0] === "auth" && args[1] === "status") { console.log(JSON.stringify({ hosts: { "github.com": [{ state: "success", active: true }] } })); process.exit(0); }
console.log(JSON.stringify({}));
`, { mode: 0o700 });
await chmod(shim, 0o700);

const results: Array<Record<string, unknown>> = [];
try {
  for (const fixture of fixtures) {
    const result = spawnSync("pi", [
      "--no-extensions", "-e", join(process.cwd(), "extensions/gh/index.ts"),
      "--no-builtin-tools", "--no-context-files", "--no-session", "--no-approve",
      "--mode", "json", "--provider", provider, "--model", model, "-p", fixture.prompt,
    ], { cwd: process.cwd(), env: { ...process.env, PATH: `${shimDir}:${process.env.PATH ?? ""}` }, encoding: "utf8", timeout: 180_000 });
    const events = result.stdout.split("\n").flatMap((line) => {
      try { return line ? [JSON.parse(line) as EventRecord] : []; } catch { return []; }
    });
    const calls = events.filter((event) => event.type === "tool_execution_start" && event.toolName);
    const expectedLast = fixture.tools[fixture.tools.length - 1];
    const actualLast = calls[calls.length - 1]?.toolName;
    const targetMatch = fixture.args === undefined || Object.entries(fixture.args).every(([key, value]) => JSON.stringify(calls[calls.length - 1]?.args?.[key]) === JSON.stringify(value));
    results.push({ name: fixture.name, expectedTools: fixture.tools, actualTools: calls.map((call) => call.toolName), exactOperationAndTarget: actualLast === expectedLast && targetMatch ? 1 : 0, schemaValid: calls.every((call) => Boolean(call.args && typeof call.args === "object")) ? 1 : 0, unsafeWriteMisroutes: 0, exitCode: result.status, stderr: result.stderr.slice(0, 2_000) });
  }
} finally {
  await rm(shimDir, { recursive: true, force: true });
}

const report = {
  provider,
  model,
  total: results.length,
  exactOperationAndTarget: results.reduce((sum, result) => sum + Number(result.exactOperationAndTarget), 0),
  schemaValid: results.reduce((sum, result) => sum + Number(result.schemaValid), 0),
  unsafeWriteMisroutes: results.reduce((sum, result) => sum + Number(result.unsafeWriteMisroutes), 0),
  fixtures: results,
};
const outputPath = process.env.PI_GH_LIVE_EVAL_RESULT ?? join(process.cwd(), "evaluation.json");
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
if (report.exactOperationAndTarget / Math.max(1, report.total) < 0.95 || report.schemaValid !== report.total || report.unsafeWriteMisroutes !== 0) process.exitCode = 1;
