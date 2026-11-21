import { emitProgress, emitResult, ensureFfmpeg, ensureFfprobe, parseArgs, runScript } from "../src/lib/cli";
import { noteSensorFail, projectFromPaths } from "../src/lib/memory/capture";
import { parseAllow } from "../src/lib/sensors/findings";
import { runMotionCheck } from "../src/lib/sensors/motion-check";
import { SAFE_ZONE_PROFILES, safeZoneOf } from "../src/lib/sensors/text-checks";
import { DEFAULT_ENTRY, GL_CHOICES } from "../src/lib/vision/composition";

const SPECS = [
  { name: "entry", default: DEFAULT_ENTRY, description: "Remotion entry point" },
  { name: "composition", required: true, description: "Composition ID" },
  { name: "props", description: "JSON file with input props" },
  { name: "public-dir", default: "public", description: "Public directory served to the composition" },
  {
    name: "frames",
    description:
      'A range "a-b" or "a-b:step", or a sample step N (every Nth frame plus the first and last). Default 5. A consecutive range without --render is also checked for flashes',
  },
  {
    name: "safe-zone",
    choices: [...SAFE_ZONE_PROFILES, "none"],
    default: "none",
    description: "Safe-zone profile to hold text inside",
  },
  {
    name: "allow",
    description:
      'Intended exceptions, inline JSON or a file: [{"code":"FADED_FINAL","reason":"...","frames":"80-89","text":"...","element":"..."}]. text matches a substring; element matches an id, data-element or data-region',
  },
  { name: "loop-frames", type: "number", description: "Loop length N: frame 0 and frame N must be pixel-identical" },
  {
    name: "render",
    description:
      "Encoded file to check against the composition; its every frame is also checked for flashes (FLASH_RISK, WCAG 2.3.1)",
  },
  { name: "codec", description: "Expected codec of --render. Default: the composition's, or h264" },
  { name: "gl", choices: GL_CHOICES, default: "angle", description: "Chromium GL backend" },
  {
    name: "project",
    description:
      "Project ID: a failure is recorded in memory/metrics.jsonl. Default: inferred from --props, --entry or --render",
  },
] as const;

void runScript(async () => {
  const startedAt = Date.now();
  const args = parseArgs(SPECS);
  ensureFfmpeg();
  if (args.render) ensureFfprobe();
  const { failing, table, metadata } = await runMotionCheck({
    source: {
      entry: args.entry!,
      composition: args.composition!,
      publicDir: args["public-dir"]!,
      gl: args.gl!,
      propsFile: args.props,
    },
    frames: args.frames,
    safeZone: safeZoneOf(args["safe-zone"]),
    allow: parseAllow(args.allow),
    loopFrames: args["loop-frames"],
    render: args.render,
    codec: args.codec,
  });
  emitProgress(`\n${table}`);
  for (const finding of metadata.readability.findings.slice(0, 8))
    emitProgress(
      `Readability warning ${finding.code} at frame ${finding.frame}: ${finding.text} (${finding.measured}, minimum ${finding.minimum})`,
    );
  if (!failing) return { outputs: [], metadata };
  const problems = Object.values(metadata.counters).reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const findings = metadata.findings.length + metadata.findingsOmitted;
  const project = args.project ?? projectFromPaths([args.props, args.entry, args.render]);
  const counters = Object.entries(metadata.counters)
    .filter(([, value]) => (value ?? 0) > 0)
    .map(([code, value]) => `${code} ${value}`);
  const memoryWarning = project ? noteSensorFail(project, "motion:check", counters) : undefined;
  if (memoryWarning) emitProgress(memoryWarning);
  return emitResult({
    ok: false,
    error: "VALIDATION",
    message: `motion:check counted ${problems} problem(s) across ${findings} finding(s). Read metadata.findings[].fix and fix the worst first.`,
    metadata: { ...metadata, ...(memoryWarning ? { memoryWarning } : {}) },
    elapsedMs: Date.now() - startedAt,
  });
});
