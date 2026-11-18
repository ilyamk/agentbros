import path from "node:path";
import { spawnSync } from "node:child_process";
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { runtimeStatus } from "../src/lib/runtime";
runScript(async () => {
  const args = parseArgs([
    {
      name: "expected",
      choices: ["primary", "fallback"],
      default: "primary",
      description: "Exact project runtime role to verify, including child processes",
    },
  ] as const);
  const status = runtimeStatus();
  const children = [process.execPath, "node"].map((executable) => {
    const child = spawnSync(
      executable,
      ["-p", "JSON.stringify({version:process.versions.node,executable:process.execPath})"],
      { encoding: "utf8", timeout: 5000, shell: false },
    );
    if (child.status !== 0)
      throw new CliErrorObject({ code: "VALIDATION", message: `Cannot verify child Node: ${executable}` });
    return { invoked: executable, ...(JSON.parse(child.stdout) as { version: string; executable: string }) };
  });
  const managerPath =
    process.env.npm_execpath && path.isAbsolute(process.env.npm_execpath) ? process.env.npm_execpath : "pnpm";
  const managerScript = /\.[cm]?js$/u.test(managerPath);
  const manager = spawnSync(
    managerScript ? process.execPath : managerPath,
    managerScript ? [managerPath, "--version"] : ["--version"],
    { encoding: "utf8", timeout: 10000, shell: false },
  );
  if (manager.status !== 0 || `pnpm@${manager.stdout.trim()}` !== status.packageManager)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Direct pnpm execution failed or its version differs; run npm install --global ${status.packageManager} --allow-scripts=pnpm.`,
    });
  if (status.role !== args.expected || children.some((child) => child.version !== status.actual))
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Runtime role or child Node differs from the selected project runtime",
      details: { ...status, children, expected: args.expected },
    });
  return { metadata: { ...status, children, directPnpm: manager.stdout.trim(), directPnpmExecutable: managerPath } };
});
