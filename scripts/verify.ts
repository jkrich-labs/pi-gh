import { spawnSync } from "node:child_process";

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("npm", ["run", "typecheck"]);
run("npm", ["test"]);
run("npm", ["pack", "--dry-run"]);
console.log("verify: typecheck, offline tests, and package contents passed");
