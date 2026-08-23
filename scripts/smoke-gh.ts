import { spawnSync } from "node:child_process";

function exec(args: string[]) {
  const result = spawnSync("gh", args, { encoding: "utf8", shell: false });
  if (result.error) throw new Error(`gh is unavailable: ${result.error.message}`);
  if (result.status !== 0) throw new Error(result.stderr.trim() || `gh ${args.join(" ")} failed`);
  return result.stdout;
}

const version = exec(["--version"]).split("\n")[0] ?? "unknown";
const auth = JSON.parse(exec(["auth", "status", "--json", "hosts"])) as { hosts?: unknown };
const hosts = auth.hosts && typeof auth.hosts === "object"
  ? Array.isArray(auth.hosts) ? auth.hosts.filter((host): host is string => typeof host === "string") : Object.keys(auth.hosts)
  : [];
console.log(JSON.stringify({ version, authenticatedHosts: hosts }, null, 2));
