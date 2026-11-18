/** A hero shot's tournament: render 2-3 variants, filter them by the sensors, place them against the corpus, write blind pair packets; then judge and report. */
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  CliErrorObject,
  emitProgress,
  emitResult,
  ensureFfmpeg,
  ensureFfprobe,
  parseArgs,
  requireProject,
  runScript,
} from "../src/lib/cli";
import { gatherEvidence, writeJsonAtomic } from "../src/lib/film/evidence";
import { projectPipeline, readJsonFile } from "../src/lib/film/inputs";
import { measureFilm } from "../src/lib/film/measure";
import {
  assignLabels,
  hashFile,
  motionCheckSensor,
  judgeTournament,
  measureShot,
  nearestTechnique,
  noteTournamentDecision,
  packetDir,
  parseVariants,
  planShot,
  prepareTournament,
  readTournament,
  shotSensors,
  tournamentFile,
  tournamentSeed,
  tournamentStatus,
  withTechniques,
  writePackets,
  type MeasuredVariant,
} from "../src/lib/film/tournament";
import { CORPUS_FILE } from "../src/lib/reference/corpus";
import { DEFAULT_LIBRARY_ROOT } from "../src/lib/reference/library";
import { parseAllow } from "../src/lib/sensors/findings";
import { runMotionCheck } from "../src/lib/sensors/motion-check";
import { DEFAULT_ENTRY, GL_CHOICES, renderClip, type CompositionSource } from "../src/lib/vision/composition";
import { buildStrip } from "../src/lib/vision/sheets";
import { SAFE_ZONE_PROFILES, safeZoneOf } from "../src/lib/sensors/text-checks";
import { probeVideo, writeImage } from "../src/lib/vision/media";
import { buildVersusStrip, resolveVersusMedia } from "../src/lib/vision/versus";
import { MotionPlanSchema } from "../src/types/creative";
import { FilmTargetsSchema } from "../src/types/film";
import { ReferenceCorpusSchema } from "../src/types/reference";
import { TournamentResultsSchema } from "../src/types/tournament";

const SPECS = [
  {
    name: "action",
    required: true,
    choices: ["prepare", "judge", "status"],
    description:
      "prepare: render, sense and pack the variants; judge: take a critic's results; status: each hero shot, decided or not",
  },
  { name: "project", required: true, description: "Project ID" },
  { name: "shot", description: "Shot id in pipeline/motion-plan.json (prepare, judge)" },
  {
    name: "variants",
    description: "prepare: 2-3 composition ids, comma-separated; a variant with its own props is Comp:props.json",
  },
  {
    name: "techniques",
    description:
      "prepare: a generic technique name per variant, in order (mask-reveal,scale-punch): the memory observation's words, never shown to the critic",
  },
  {
    name: "range",
    choices: ["auto", "shot", "whole"],
    default: "auto",
    description:
      "prepare: the shot's frames of each variant (a film-length composition) or the whole composition (a shot-length one); auto takes the shot's frames when the composition has them",
  },
  {
    name: "allow",
    description:
      'prepare: intended motion:check exceptions for every variant, as motion:check --allow takes them (inline JSON or a file): [{"code":"TEXT_OFF_STAGE","reason":"...","frames":"0-5","text":"...","element":"..."}]',
  },
  {
    name: "results",
    description: "judge: JSON {schemaVersion, shotId, seed, judgements:[{pairId, order, winner, reason}]}",
  },
  { name: "corpus", description: `prepare: the reference corpus; default <library>/${CORPUS_FILE}` },
  {
    name: "library",
    default: DEFAULT_LIBRARY_ROOT,
    description: "Reference library root, for the corpus and the reference strips",
  },
  { name: "entry", default: DEFAULT_ENTRY, description: "Remotion entry point" },
  { name: "public-dir", default: "public", description: "Public directory served to the compositions" },
  { name: "gl", choices: GL_CHOICES, default: "angle", description: "Chromium GL backend" },
] as const;

const relative = (file: string) => path.relative(process.cwd(), path.resolve(file)) || ".";
const BriefLooseSchema = z.object({ format: z.string().optional() }).loose();

/** Renders the shot's frames, or the whole composition when it is shot-length (`auto` decides by trying the shot's frames). */
async function renderVariant(
  source: CompositionSource,
  output: string,
  mode: "auto" | "shot" | "whole",
  shotRange: [number, number],
) {
  if (mode !== "whole") {
    try {
      const done = await renderClip(source, { output, range: shotRange, codec: "h264" });
      return { range: shotRange, durationInFrames: done.durationInFrames };
    } catch (error) {
      if (mode === "shot" || !(error instanceof CliErrorObject && /outside/.test(error.message))) throw error;
      emitProgress(`${source.composition} is shorter than the shot's frames: rendering all of it.`);
    }
  }
  const done = await renderClip(source, { output, codec: "h264" });
  return { range: undefined, durationInFrames: done.durationInFrames };
}

void runScript(async () => {
  const startedAt = Date.now();
  const args = parseArgs(SPECS);
  const projectId = args.project!;
  requireProject(projectId);
  const projectDir = path.join("public/projects", projectId);
  const plan = readJsonFile(projectPipeline(projectId, "motion-plan.json"), MotionPlanSchema, "Motion plan");

  if (args.action === "status") {
    const rows = tournamentStatus(projectDir, plan);
    for (const row of rows)
      emitProgress(
        `${row.state.padEnd(12)} ${row.shotId}${row.function ? ` (${row.function})` : ""}${row.winner ? `: ${row.winner} ${row.composition}` : row.note ? `: ${row.note}` : ""}`,
      );
    return {
      metadata: {
        projectId,
        heroShots: rows.length,
        decided: rows.filter((row) => row.state === "decided").length,
        shots: rows,
      },
    };
  }

  if (!args.shot) throw new CliErrorObject({ code: "INVALID_INPUT", message: `--action ${args.action} needs --shot.` });
  const record = tournamentFile(projectDir, args.shot);

  if (args.action === "judge") {
    if (!args.results) throw new CliErrorObject({ code: "INVALID_INPUT", message: "--action judge needs --results." });
    const prepared = readTournament(projectDir, args.shot);
    if (!prepared)
      throw new CliErrorObject({
        code: "STAGE_INCOMPLETE",
        message: `No valid tournament for shot ${args.shot}: run --action prepare first.`,
      });
    const judged = judgeTournament(prepared, readJsonFile(args.results, TournamentResultsSchema, "Tournament results"));
    writeJsonAtomic(record, judged);
    const memory = noteTournamentDecision(judged);
    if (memory.warning) emitProgress(memory.warning);
    emitProgress(judged.decision!.rationale);
    return {
      outputs: [path.resolve(record)],
      metadata: {
        projectId,
        shotId: args.shot,
        decision: judged.decision,
        ...(memory.id ? { memory: { id: memory.id, seen: memory.seen ?? false } } : {}),
        ...(memory.warning ? { memoryWarning: memory.warning } : {}),
      },
    };
  }

  // prepare
  ensureFfmpeg();
  ensureFfprobe();
  if (!args.variants)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--action prepare needs --variants." });
  const allow = parseAllow(args.allow);
  const specs = withTechniques(parseVariants(args.variants), args.techniques);
  const shot = planShot(plan, args.shot);
  if (shot.weight !== "hero")
    emitProgress(
      `Shot ${shot.id} is not marked weight "hero": the build's done check only asks hero shots for a tournament.`,
    );
  const shotRange: [number, number] = [shot.startFrame, shot.startFrame + shot.durationFrames - 1];
  const lastShot = plan.shots.at(-1)?.id === shot.id;
  const brief = readJsonFile(projectPipeline(projectId, "brief.json"), BriefLooseSchema, "Brief");
  // The build's motion:check holds text in the brief's format; a variant judged without it could win and then fail the build.
  const safeZone =
    brief.format && (SAFE_ZONE_PROFILES as readonly string[]).includes(brief.format)
      ? safeZoneOf(brief.format as (typeof SAFE_ZONE_PROFILES)[number])
      : undefined;
  const corpusPath = args.corpus ?? path.join(args.library!, CORPUS_FILE);
  const corpus = existsSync(corpusPath)
    ? readJsonFile(corpusPath, ReferenceCorpusSchema, "Reference corpus")
    : undefined;
  if (!corpus)
    emitProgress(`No corpus at ${corpusPath}: corpus distance and the reference strip are left out. Run ref:corpus.`);
  const targetsPath = projectPipeline(projectId, "film-targets.json");
  const targets = existsSync(targetsPath) ? readJsonFile(targetsPath, FilmTargetsSchema, "Targets") : undefined;
  const out = packetDir(".", projectId, args.shot);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const measured: (MeasuredVariant & { temp: string })[] = [];
  for (const [index, spec] of specs.entries()) {
    const source = {
      entry: args.entry!,
      composition: spec.composition,
      publicDir: args["public-dir"]!,
      gl: args.gl!,
      propsFile: spec.propsFile,
    };
    const temp = path.join(out, `render-${index}.mp4`);
    emitProgress(`Variant ${index + 1}/${specs.length}: rendering`);
    const rendered = await renderVariant(source, temp, args.range as "auto" | "shot" | "whole", shotRange);
    emitProgress(`Variant ${index + 1}/${specs.length}: motion:check`);
    // A shot-length composition's last frame is the shot's exit, not the film's end: the final-frame checks apply only to the last shot.
    const lastChecked = rendered.range ? rendered.range[1] : rendered.durationInFrames - (lastShot ? 1 : 2);
    const firstChecked = rendered.range ? rendered.range[0] : 0;
    const check = await runMotionCheck({
      source,
      frames: `${firstChecked}-${Math.max(firstChecked, lastChecked)}:3`,
      allow,
      ...(safeZone ? { safeZone } : {}),
    });
    const evidence = gatherEvidence(temp);
    const legs = measureFilm({ evidence, ...(targets ? { targets } : {}) });
    measured.push({
      ...spec,
      ...(spec.propsFile ? { propsSha256: hashFile(spec.propsFile) } : {}),
      render: temp,
      renderSha256: evidence.sha256,
      sensors: shotSensors(
        motionCheckSensor({
          failing: check.failing,
          counters: check.metadata.counters,
          allowed: check.metadata.allowed,
        }),
        legs,
      ),
      measured: measureShot(evidence),
      temp,
    });
  }

  // Files take their blind label once every render is hashed: the seed comes from the renders.
  const seed = tournamentSeed(projectId, args.shot, measured);
  const labels = assignLabels(seed, measured);
  const durationSec = shot.durationFrames / plan.fps;
  const reference = nearestTechnique(corpus, shot.function, durationSec);
  let referenceMedia: string | undefined;
  if (reference) {
    try {
      referenceMedia = resolveVersusMedia(path.join(args.library!, reference.refId)).media;
    } catch (error) {
      emitProgress(`No reference strip: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const [index, variant] of measured.entries()) {
    const render = path.join(out, `variant-${labels[index]}.mp4`);
    renameSync(variant.temp, render);
    variant.render = relative(render);
    // Every packet shows something: the strip against the reference, or the variant's own strip when there is none.
    const strip = path.join(out, `strip-${labels[index]}.jpg`);
    const info = probeVideo(render);
    const { image } =
      referenceMedia && reference
        ? buildVersusStrip(render, info, referenceMedia, {
            referenceRange: { startSec: reference.startSec, endSec: reference.endSec },
          })
        : buildStrip(render, info, { step: Math.max(1, Math.round(info.fps / 6)) });
    writeImage(image, strip);
    variant.strip = relative(strip);
  }
  const prepared = prepareTournament({
    projectId,
    plan,
    shotId: args.shot,
    variants: measured.map(({ temp: _temp, ...variant }) => variant),
    ...(corpus ? { corpus } : {}),
    packetDir: relative(out),
  });
  if (prepared.reference && referenceMedia) prepared.reference.media = relative(referenceMedia);
  writeJsonAtomic(record, prepared);
  const packets = writePackets(prepared, ".");
  for (const variant of prepared.variants)
    emitProgress(
      `${variant.label}: ${variant.failed ? "excluded" : "in"}; corpus distance ${variant.corpus.distance ?? "n/a"}; ${variant.sensors.map((sensor) => `${sensor.id} ${sensor.status}`).join(", ")}`,
    );
  const metadata = {
    projectId,
    shotId: args.shot,
    seed: prepared.seed,
    durationSec,
    record: path.resolve(record),
    packets,
    survivors: prepared.variants.filter((variant) => !variant.failed).map((variant) => variant.label),
    ...(prepared.decision ? { decision: prepared.decision } : {}),
    ...(prepared.undecided ? { undecided: prepared.undecided } : {}),
  };
  if (prepared.undecided)
    return emitResult({
      ok: false,
      error: "VALIDATION",
      message: prepared.undecided,
      metadata,
      elapsedMs: Date.now() - startedAt,
    });
  if (prepared.decision) {
    const memory = noteTournamentDecision(prepared);
    if (memory.warning) emitProgress(memory.warning);
  }
  return { outputs: [path.resolve(record), ...packets], metadata };
});
