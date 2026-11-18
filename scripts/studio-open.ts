/**
 * Open a project in Remotion Studio, in its current state (RFC 0004 §17, D21 as amended 2026-11-18): a bespoke film
 * opens build.json's composition; a project.json project opens its format's composition with exactly the props
 * `pnpm render` would pass. A running Studio of the same target is reused and its props file rewritten, so it updates
 * live. Studio runs detached under the loopback preload (127.0.0.1 only). `--status` reports, `--stop` stops it.
 */
import { CliErrorObject, emitProgress, parseArgs, runScript, validateProjectId } from "../src/lib/cli";
import { processAttribution } from "../src/lib/cli/channel";
import { openStudio, STUDIO_READY_TIMEOUT_MS, stopProjectStudios, studioStatus } from "../src/lib/console/studio";
import type { VideoFormat } from "../src/types/video";

void runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Project ID under public/projects" },
    {
      name: "format",
      choices: ["vertical", "square", "landscape"],
      description: "A project.json project's format (default: its first configured one); not for a bespoke film",
    },
    { name: "status", type: "boolean", description: "Report whether Studio can open the project and the running one" },
    { name: "stop", type: "boolean", description: "Stop the project's Studio (every format)" },
    {
      name: "timeout-ms",
      type: "number",
      default: STUDIO_READY_TIMEOUT_MS,
      description: "How long to wait for a new Studio to serve the page (bundling is slow)",
    },
  ] as const);
  const project = args.project!;
  validateProjectId(project);
  const rootDir = process.cwd();
  if (args.status && args.stop)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--status and --stop are exclusive." });
  if (args.status) {
    const { ok: _ok, ...status } = studioStatus(rootDir, project);
    return { outputs: [], metadata: { project, ...status } };
  }
  if (args.stop) {
    const stopped = await stopProjectStudios(rootDir, project);
    return { outputs: [], metadata: { project, stopped } };
  }
  const timeoutMs = Number(args["timeout-ms"]);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--timeout-ms must be between 1000 and 600000." });
  const opened = await openStudio({
    rootDir,
    project,
    format: args.format as VideoFormat | undefined,
    // Started for the user from the console (a verified grant): the console stops it when it shuts down.
    owner: processAttribution().verified ? "console" : "cli",
    timeoutMs,
    log: emitProgress,
  });
  return {
    outputs: opened.propsFile ? [opened.propsFile] : [],
    metadata: {
      project,
      url: opened.url,
      reused: opened.reused,
      target: opened.target,
      pid: opened.state.pid,
      port: opened.state.port,
      startedAt: opened.state.startedAt,
      ...(opened.propsChanged !== undefined ? { propsChanged: opened.propsChanged } : {}),
    },
  };
});
