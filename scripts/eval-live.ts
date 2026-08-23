import { readFile } from "node:fs/promises";

const resultPath = process.env.PI_GH_LIVE_EVAL_RESULT;
const provider = process.argv.find((arg) => arg.startsWith("--provider="))?.slice("--provider=".length);
const model = process.argv.find((arg) => arg.startsWith("--model="))?.slice("--model=".length);
if (!resultPath) {
  console.error("Credential-gated live evaluation needs PI_GH_LIVE_EVAL_RESULT pointing to the capture result JSON.");
  console.error(`requested provider=${provider ?? "unset"} model=${model ?? "unset"}`);
  process.exit(2);
}
const result = JSON.parse(await readFile(resultPath, "utf8")) as Record<string, unknown>;
console.log(JSON.stringify({ provider, model, ...result }, null, 2));
const total = Number(result.total ?? 0);
const exact = Number(result.exactOperationAndTarget ?? 0);
const valid = Number(result.schemaValid ?? 0);
const unsafe = Number(result.unsafeWriteMisroutes ?? 0);
if (total <= 0 || exact / total < 0.95 || valid !== total || unsafe !== 0) process.exitCode = 1;
