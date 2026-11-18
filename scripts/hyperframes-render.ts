import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { CliErrorObject, emitProgress, ensureFfprobe, parseArgs, runScript } from "../src/lib/cli";
import {
  QUALITY_CHOICES,
  TESTED_VERSION,
  TOOL_LICENCE,
  TOOL_SOURCE,
  buildEnv,
  buildRenderArgs,
  buildSidecar,
  findBrowser,
  findTool,
  installSteps,
  isNoise,
  projectWarnings,
  validateAttribution,
  validateProject,
} from "../src/lib/hyperframes/render";
import { probeVideo } from "../src/lib/vision/media";

const SPECS = [
  { name: "project-dir", required: true, description: "Hyperframes project directory" },
  { name: "output", required: true, description: "Output .mp4 path" },
  { name: "composition", description: "Composition file inside the project; default index.html" },
  { name: "block", description: "Registry block or component ID, recorded as provenance" },
  { name: "licence", description: "SPDX licence of that item, read from its source (required with --block)" },
  { name: "source", description: "Pinned URL of that item (required with --block)" },
  { name: "fps", type: "number", default: 30, description: "Frames per second" },
  { name: "quality", choices: QUALITY_CHOICES, default: "looks", description: "Hyperframes quality preset" },
  { name: "workers", type: "number", description: "Render workers; default chosen by the tool" },
  { name: "executable", description: "Absolute path to the hyperframes executable" },
  { name: "browser", description: "Absolute path to Chromium; default the Remotion browser in node_modules" },
  { name: "timeout-sec", type: "number", default: 1800, description: "Stop the render after this many seconds" },
  {
    name: "strict",
    type: "boolean",
    default: true,
    description: "Fail on lint errors; --no-strict only for a vendored shader bundle the linter misreads",
  },
  { name: "force", type: "boolean", description: "Replace an existing output" },
  { name: "dry-run", type: "boolean", description: "Validate and print the argument list without rendering" },
] as const;

function run(tool: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number) {
  return new Promise<{ code: number | null; tail: string[]; timedOut: boolean }>((resolve, reject) => {
    const child = spawn(tool, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const tail: string[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on("line", (line) => {
        if (isNoise(line)) return;
        console.error(line);
        tail.push(line);
        if (tail.length > 30) tail.shift();
      });
    }
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, tail, timedOut });
    });
  });
}

void runScript(async () => {
  const args = parseArgs(SPECS);
  const projectDir = path.resolve(args["project-dir"]!);
  const output = path.resolve(args.output!);
  const attribution = { block: args.block, licence: args.licence, source: args.source };
  if (path.extname(output) !== ".mp4")
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--output must end in .mp4" });
  validateAttribution(attribution);
  validateProject(projectDir, args.composition);
  if (existsSync(output) && !args.force && !args["dry-run"])
    throw new CliErrorObject({ code: "FILE_EXISTS", message: `Output exists: ${output}. Pass --force to replace it.` });
  const renderArgs = buildRenderArgs({
    projectDir,
    output,
    composition: args.composition,
    fps: args.fps!,
    quality: args.quality!,
    workers: args.workers,
    strict: args.strict,
  });
  const warnings = projectWarnings(projectDir, args.composition);
  if (!args.strict)
    warnings.push(
      "Lint strictness is off: an undeclared font family is no longer refused. Check the glyphs in the frames.",
    );

  const tool = findTool({ executable: args.executable, env: process.env });
  const browser = findBrowser({ browser: args.browser, env: process.env });
  const env = buildEnv(process.env, { browser });
  const toolDetails = { path: tool, licence: TOOL_LICENCE, source: TOOL_SOURCE, testedVersion: TESTED_VERSION };
  if (args["dry-run"])
    return {
      outputs: [],
      metadata: { state: "validated", tool: toolDetails, browser, args: renderArgs, warnings, attribution },
    };

  mkdirSync(path.dirname(output), { recursive: true });
  mkdirSync(env.HOME!, { recursive: true });
  const versionRun = spawnSync(tool, ["--version"], {
    cwd: projectDir,
    env,
    encoding: "utf8",
    shell: false,
    timeout: 60000,
  });
  const version = /\d+\.\d+\.\d+/.exec(versionRun.stdout ?? "")?.[0];
  if (versionRun.status !== 0 || !version)
    throw new CliErrorObject({
      code: "FILE_NOT_FOUND",
      message: `unavailable: ${tool} did not report a version`,
      details: { state: "unavailable", install: installSteps() },
    });
  if (version !== TESTED_VERSION)
    warnings.push(`Hyperframes ${version} differs from the tested ${TESTED_VERSION}; review the frames closely.`);
  ensureFfprobe();
  if (existsSync(output)) rmSync(output);

  const startedAt = Date.now();
  // cwd is the project, never the repository: the CLI reads a .env from its working directory.
  const result = await run(tool, renderArgs, projectDir, env, args["timeout-sec"]! * 1000);
  const renderSeconds = (Date.now() - startedAt) / 1000;
  if (result.timedOut)
    throw new CliErrorObject({ code: "TIMEOUT", message: `Render stopped after ${args["timeout-sec"]} seconds` });
  if (result.code !== 0 || !existsSync(output)) {
    throw new CliErrorObject({
      code: result.code === 2 ? "INVALID_INPUT" : "INTERNAL",
      message: `Hyperframes render failed with exit code ${result.code}`,
      details: { exitCode: result.code, args: renderArgs, tail: result.tail },
    });
  }

  const video = probeVideo(output);
  const sidecarPath = `${output}.provenance.json`;
  const sidecar = buildSidecar({
    ...attribution,
    version,
    originalFilename: path.basename(output),
    checkedAt: new Date(startedAt).toISOString(),
  });
  writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
  emitProgress(`Rendered ${video.durationSec}s in ${renderSeconds.toFixed(1)}s`);
  return {
    outputs: [output, sidecarPath],
    metadata: {
      state: "rendered",
      tool: { ...toolDetails, version },
      browser,
      block: args.block ?? null,
      licence: args.licence ?? null,
      source: args.source ?? null,
      video,
      renderSeconds,
      secondsPerVideoSecond: renderSeconds / video.durationSec,
      args: renderArgs,
      warnings,
      sidecar: sidecarPath,
      providerSpendUsd: 0,
    },
  };
});
