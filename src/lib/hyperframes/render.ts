import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { cacheRoot } from "../cache-dir";
import path from "node:path";
import { CliErrorObject } from "../cli";
import { AssetProvenanceSchema, AssetRightsSchema } from "../../types/assets";

/** The exact release the trial rendered with; other versions run but are flagged. */
export const TESTED_VERSION = "0.9.7";
export const TESTED_COMMIT = "8c799ebd1b673dc2a61a06b0ba4e283c1b42b2f4";
export const TOOL_LICENCE = "Apache-2.0";
export const TOOL_SOURCE = `https://github.com/heygen-com/hyperframes/tree/${TESTED_COMMIT}`;
export const QUALITY_CHOICES = ["draft", "looks", "delivery", "standard", "high"] as const;

export const toolRoot = (home = homedir()) => path.join(cacheRoot(home), "hyperframes");

export const installSteps = (home = homedir()) => [
  `npm install --prefix ${path.join(toolRoot(home), "tool")} --ignore-scripts --save-exact hyperframes@${TESTED_VERSION}`,
];

const unavailable = (what: string, install: string[]) =>
  new CliErrorObject({
    code: "FILE_NOT_FOUND",
    message: `unavailable: ${what}. Nothing was installed; run the listed steps yourself.`,
    details: { state: "unavailable", install },
  });

function onPath(name: string, searchPath: string | undefined): string | undefined {
  for (const directory of (searchPath ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Explicit flag, then environment, then the pinned install, then PATH. Never installs. */
export function findTool(options: { executable?: string; env: NodeJS.ProcessEnv; home?: string }): string {
  const explicit = options.executable ?? options.env.HYPERFRAMES_BIN;
  if (explicit) {
    if (!existsSync(explicit))
      throw unavailable(`Hyperframes executable not found at ${explicit}`, installSteps(options.home));
    return explicit;
  }
  const pinned = path.join(toolRoot(options.home), "tool", "node_modules", ".bin", "hyperframes");
  if (existsSync(pinned)) return pinned;
  const found = onPath("hyperframes", options.env.PATH);
  if (found) return found;
  throw unavailable("Hyperframes CLI not found", installSteps(options.home));
}

/** A resolved path stops the CLI downloading its own Chrome during a render. */
export function findBrowser(options: { browser?: string; env: NodeJS.ProcessEnv; root?: string }): string {
  const install = ["pnpm exec remotion browser ensure"];
  const explicit = options.browser ?? options.env.HYPERFRAMES_BROWSER_PATH;
  if (explicit) {
    if (!existsSync(explicit)) throw unavailable(`browser not found at ${explicit}`, install);
    return explicit;
  }
  const base = path.join(options.root ?? process.cwd(), "node_modules", ".remotion", "chrome-headless-shell");
  if (existsSync(base)) {
    for (const platform of readdirSync(base, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
      const directory = path.join(base, platform.name);
      for (const build of readdirSync(directory)) {
        const candidate = path.join(directory, build, "chrome-headless-shell");
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  throw unavailable("no installed Chromium for rendering", install);
}

/** The repository .env never reaches the tool, which reads several provider keys. */
export function buildEnv(base: NodeJS.ProcessEnv, options: { browser: string; home?: string }): NodeJS.ProcessEnv {
  const allowed = Object.fromEntries(
    ["PATH", "TMPDIR", "LANG"].filter((key) => base[key] !== undefined).map((key) => [key, base[key]]),
  );
  return {
    ...allowed,
    HOME: path.join(toolRoot(options.home), "home"),
    HYPERFRAMES_BROWSER_PATH: options.browser,
    HYPERFRAMES_NO_UPDATE_CHECK: "1",
    HYPERFRAMES_NO_AUTO_INSTALL: "1",
    HYPERFRAMES_NO_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
    HYPERFRAMES_SKIP_SKILLS: "1",
    HYPERFRAMES_NO_OPTIONAL_INSTALL: "1",
    HYPERFRAMES_AGENT: "1",
  };
}

export type RenderRequest = {
  projectDir: string;
  output: string;
  composition?: string;
  fps: number;
  quality: string;
  workers?: number;
  strict?: boolean;
};

/**
 * Lint strictness rejects an undeclared font family, not a declared one that fails to load or
 * lacks Cyrillic. The linter also scans vendored files and rejects Hyperframes' own shader
 * bundle, hence the opt-out.
 */
export function buildRenderArgs(request: RenderRequest): string[] {
  return [
    "render",
    request.projectDir,
    "--output",
    request.output,
    "--fps",
    String(request.fps),
    "--quality",
    request.quality,
    ...(request.strict === false ? [] : ["--strict"]),
    "--no-best-effort",
    ...(request.composition ? ["--composition", request.composition] : []),
    ...(request.workers !== undefined ? ["--workers", String(request.workers)] : []),
  ];
}

export function validateProject(projectDir: string, composition?: string): void {
  const entry = path.resolve(projectDir, composition ?? "index.html");
  if (!existsSync(entry))
    throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `Composition not found: ${entry}` });
  if (path.relative(path.resolve(projectDir), entry).startsWith(".."))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--composition must stay inside --project-dir" });
}

/** Render reproducibility depends on these; they are reported, not refused. */
export function projectWarnings(projectDir: string, composition?: string): string[] {
  const warnings: string[] = [];
  const config = path.join(projectDir, "hyperframes.json");
  if (existsSync(config)) {
    const registry = (JSON.parse(readFileSync(config, "utf8")) as { registry?: string }).registry ?? "";
    if (/\/main\/registry\/?$/.test(registry))
      warnings.push("hyperframes.json follows the registry's main branch; pin it to a commit so `add` is repeatable.");
  }
  const html = readFileSync(path.resolve(projectDir, composition ?? "index.html"), "utf8");
  const remote = [...html.matchAll(/(?:src|href)=["'](https?:\/\/[^"']+)/g)].map((match) => match[1]!);
  if (remote.length)
    warnings.push(
      `Composition loads ${remote.length} remote resource(s) at render time; vendor them for an offline, repeatable render: ${remote.join(", ")}`,
    );
  return warnings;
}

export type Attribution = { block?: string; licence?: string; source?: string };

export function validateAttribution({ block, licence, source }: Attribution): void {
  if (block && (!licence || !source))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "--block requires --licence and --source: licences differ per registry item, so none is assumed.",
    });
}

/** The shape `asset:import --metadata` accepts; both parts are checked against the asset schemas. */
export function buildSidecar(options: Attribution & { version: string; originalFilename: string; checkedAt: string }) {
  const { block, licence, source, version } = options;
  const parts = [`Rendered with Hyperframes ${version} (${TOOL_LICENCE}, HeyGen, Inc.)`];
  if (block) parts.push(`block ${block} (${licence})`);
  return {
    provenance: AssetProvenanceSchema.parse({
      origin: "manual",
      originalFilename: options.originalFilename,
      tool: `hyperframes@${version}`,
      model: block ?? "composition",
      billing: { status: "reported", apiUsd: 0, source: "local render, no provider call" },
    }),
    rights: AssetRightsSchema.parse({
      licence: licence ?? "unknown",
      commercialAllowed: "unknown",
      attributionRequired: block ? true : "unknown",
      attribution: parts.join("; "),
      sourceUrl: source ?? TOOL_SOURCE,
      checkedAsOf: options.checkedAt,
    }),
  };
}

export function isNoise(line: string): boolean {
  return !line.trim() || line.startsWith("@hf-") || line.includes("[Render:trace]") || line.includes("█");
}
