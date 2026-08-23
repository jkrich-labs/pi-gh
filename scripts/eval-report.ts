import { readFile } from "node:fs/promises";

interface Evaluation {
  total: number;
  exactOperationAndTarget: number;
  schemaValid: number;
  unsafeWriteMisroutes: number;
  initialTokens?: number;
  resultTokens?: number;
}

const file = process.argv[2];
if (!file) {
  console.error("usage: npm run eval:report -- path/to/evaluation.json");
  process.exit(2);
}
const report = JSON.parse(await readFile(file, "utf8")) as Evaluation;
const total = Math.max(1, report.total);
const output = {
  ...report,
  exactAccuracy: report.exactOperationAndTarget / total,
  schemaValidity: report.schemaValid / total,
  releaseGate: report.exactOperationAndTarget / total >= 0.95 && report.schemaValid === report.total && report.unsafeWriteMisroutes === 0,
};
console.log(JSON.stringify(output, null, 2));
if (!output.releaseGate) process.exitCode = 1;
