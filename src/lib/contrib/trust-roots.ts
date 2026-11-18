import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { parseYaml } from "./yaml";

export type AutomationJob = { environment?: unknown; permissions?: Record<string, string>; steps?: { run?: string }[] };
export function privileged(job: AutomationJob): boolean {
  return Boolean(job.environment) || Object.values(job.permissions ?? {}).includes("write");
}

/** Include relative imports, re-exports and literal module paths used by dynamic loaders. */
export function automationModules(root: string): string[] {
  const scripts = (
    JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> }
  ).scripts;
  const pending: string[] = [],
    seen = new Set<string>(),
    aliases = new Set<string>();
  const commands = (text: string) => {
    for (const match of text.matchAll(/\bpnpm\s+(?:run\s+)?([\w:-]+)/g)) {
      const alias = match[1]!;
      if (scripts[alias] && !aliases.has(alias)) {
        aliases.add(alias);
        commands(scripts[alias]!);
      }
    }
    for (const match of text.matchAll(/\bscripts\/[\w./-]+\.(?:[cm]?[jt]sx?)/g)) pending.push(match[0]);
  };
  for (const name of readdirSync(path.join(root, ".github/workflows")).filter((name) => /\.ya?ml$/.test(name))) {
    const workflow = parseYaml(readFileSync(path.join(root, ".github/workflows", name), "utf8")) as {
      jobs: Record<string, AutomationJob>;
    };
    for (const job of Object.values(workflow.jobs))
      if (privileged(job)) for (const step of job.steps ?? []) if (step.run) commands(step.run);
  }
  while (pending.length) {
    const name = pending.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    if (!/\.[cm]?[jt]sx?$/.test(name)) continue;
    const source = readFileSync(path.join(root, name), "utf8");
    for (const match of source.matchAll(/["'`]((?:\.\.?\/)[^"'`\n]+)["'`]/g)) {
      const target = path.resolve(root, path.dirname(name), match[1]!);
      const candidates = [
        target,
        ...[".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"].map(
          (ext) => target.replace(/\.js$/, "") + ext,
        ),
        path.join(target, "index.ts"),
        path.join(target, "index.tsx"),
        path.join(target, "index.js"),
      ];
      // Only code and JSON modules are trust roots; a relative string naming a report (out/qa/*.md) is data.
      const resolved = candidates.find(
        (file) => /\.(?:[cm]?[jt]sx?|json)$/.test(file) && existsSync(file) && statSync(file).isFile(),
      );
      if (resolved) pending.push(path.relative(root, resolved).split(path.sep).join("/"));
    }
    if (/spawn|runCommand|runGenerator/.test(source))
      for (const match of source.matchAll(/\[\s*["']([\w:-]+)["']/g))
        if (scripts[match[1]!]) commands(`pnpm ${match[1]}`);
    for (const match of source.matchAll(/["']pnpm["']\s*,\s*["']([\w:-]+)["']/g)) commands(`pnpm ${match[1]}`);
  }
  return [...seen].sort();
}
