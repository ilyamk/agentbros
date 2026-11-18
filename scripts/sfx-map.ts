import path from "node:path";
import { z } from "zod";
import { CliErrorObject, emitProgress, parseArgs, requireProject, runScript } from "../src/lib/cli";
import { writeJsonAtomic } from "../src/lib/film/evidence";
import { earshot } from "../src/lib/audio/earshot";
import { earshotStatus, EARSHOT_CLAP_SHA, EARSHOT_SHA } from "../src/lib/audio/earshot-runtime";
import { assembleSfxMap, SFX_MAP_QUERIES, SFX_MAP_TOP } from "../src/lib/audio/sfx-map";
import { SOUND_KINDS, type SoundKind } from "../src/lib/audio/cut-decisions";
import { SfxMapSchema } from "../src/types/sfx-map";

const SPECS = [
  { name: "input", required: true, description: "Recording, reference or render with an audio stream; never modified" },
  {
    name: "output",
    required: true,
    description: "Map JSON: <reference>/sfx-map.json for a library reference, or a project pipeline file",
  },
  { name: "project", description: "Project, when the input or output lives in one" },
  { name: "start", type: "number", description: "Start in source seconds" },
  { name: "end", type: "number", description: "End in source seconds; at most 600 seconds after the start" },
  { name: "kinds", description: `Comma-separated families (default all: ${SOUND_KINDS.join(", ")})` },
  { name: "scope-root", description: "Trusted MCP workspace boundary" },
] as const;

const FindMetadataSchema = z
  .object({
    source: z.object({ file: z.string(), sha256: z.string(), durationSec: z.number() }).passthrough(),
    analysedRange: z.object({ startSec: z.number(), endSec: z.number() }),
    segments: z.array(
      z
        .object({
          start: z.number(),
          end: z.number(),
          z: z.number(),
          verdict: z.string(),
          peak_dbfs: z.number().nullable(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

void runScript(async () => {
  const args = parseArgs(SPECS);
  if (args.project) requireProject(args.project);
  const kinds = (args.kinds?.split(",").map((kind) => kind.trim()) ?? [...SOUND_KINDS]) as SoundKind[];
  const unknown = kinds.filter((kind) => !(SOUND_KINDS as readonly string[]).includes(kind));
  if (unknown.length)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `Unknown sound families: ${unknown.join(", ")}` });
  const status = earshotStatus(undefined, true);
  if (!status.available)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `sfx:map needs Earshot's semantic search: ${status.reason}. ${status.fix}`,
      details: { fix: status.fix, available: false },
    });
  const found: { kind: SoundKind; segments: z.infer<typeof FindMetadataSchema>["segments"] }[] = [];
  let source: z.infer<typeof FindMetadataSchema>["source"] | undefined;
  let range: z.infer<typeof FindMetadataSchema>["analysedRange"] | undefined;
  for (const kind of kinds) {
    emitProgress(`Earshot find: ${kind} ("${SFX_MAP_QUERIES[kind]}")`);
    const { metadata } = await earshot(
      {
        action: "find",
        input: args.input,
        query: SFX_MAP_QUERIES[kind],
        top: SFX_MAP_TOP,
        kind: "event",
        ...(args.start !== undefined ? { start: args.start } : {}),
        ...(args.end !== undefined ? { end: args.end } : {}),
      },
      { scopeRoot: args["scope-root"] },
    );
    const parsed = FindMetadataSchema.parse(metadata);
    if (source && parsed.source.sha256 !== source.sha256)
      throw new CliErrorObject({ code: "VALIDATION", message: "The input changed while it was being mapped" });
    source = parsed.source;
    range = parsed.analysedRange;
    found.push({ kind, segments: parsed.segments });
  }
  const map = SfxMapSchema.parse(
    assembleSfxMap({
      source: { file: source!.file, sha256: source!.sha256, durationSec: source!.durationSec },
      analysedRange: range!,
      modelRevision: EARSHOT_CLAP_SHA,
      packageSha: EARSHOT_SHA,
      found,
    }),
  );
  const output = writeJsonAtomic(path.resolve(args.output!), map);
  emitProgress(
    `${map.summary.events} candidate event(s), ${map.summary.perMinute}/min: ${Object.entries(map.summary.byKind)
      .map(([kind, row]) => `${kind} ${row.count}`)
      .join(", ")}`,
  );
  return { outputs: [output], metadata: { summary: map.summary, notice: map.notice } };
});
