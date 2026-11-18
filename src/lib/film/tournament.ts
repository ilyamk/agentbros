import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject } from "../cli";
import { distribution } from "../reference/corpus";
import type { MotionPlan } from "../../types/creative";
import type { FilmMeasure } from "../../types/film";
import type { ReferenceCorpus, TechniqueFunction } from "../../types/reference";
import {
  ShotTournamentSchema,
  type CorpusDistance,
  type ShotTournament,
  type TournamentJudgement,
  type TournamentResults,
  type TournamentVariant,
} from "../../types/tournament";
import { agreedPairs, type PairJudgement } from "./creative-rubric";
import { writeJsonAtomic, type FilmEvidence } from "./evidence";
import { readFastSharp, readMotionSpread, STILL_CHANGED_SHARE } from "./readings";
import { round } from "./stats";
import { addMemory, loadMemory, markSeen } from "../memory";
import { projectPlaybook } from "../memory/capture";

/**
 * Shot tournaments: two or three variants of a hero shot, rendered, run through the sensors, placed against the reference
 * corpus for the shot's function, then judged blind in both orders. Everything here is pure; scripts/shot-tournament.ts
 * renders and measures. Rules: src/lib/film/AGENTS.md, method: docs/production-chain.md.
 */

export const TOURNAMENT_LABELS = ["A", "B", "C"] as const;
export const MIN_VARIANTS = 2;
export const MAX_VARIANTS = 3;
/** film:measure legs that judge a shot on its own, with no film around it. */
export const SHOT_LEGS = ["motion-spread", "fast-motion-sharp", "flash-risk"] as const;
/** A corpus band needs this many values to mean anything. */
export const MIN_BAND_VALUES = 2;
/** The agent name tournament observations carry in memory. */
export const TOURNAMENT_AGENT = "shot-tournament";

export const tournamentFile = (projectDir: string, shotId: string) =>
  path.join(projectDir, "pipeline", "tournament", `${shotId}.json`);
export const packetDir = (rootDir: string, projectId: string, shotId: string) =>
  path.join(rootDir, "out", projectId, "tournament", shotId);

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
export const hashFile = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

// --- Variants and labels ---

export type VariantSpec = { composition: string; propsFile?: string; technique?: string };

/** `Comp1,Comp2[,Comp3]`; a variant may name a props file: `Film:props-b.json`. */
export function parseVariants(value: string): VariantSpec[] {
  const variants = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const at = part.indexOf(":");
      return at < 0
        ? { composition: part }
        : { composition: part.slice(0, at).trim(), propsFile: part.slice(at + 1).trim() };
    });
  if (variants.length < MIN_VARIANTS || variants.length > MAX_VARIANTS)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `--variants takes ${MIN_VARIANTS} or ${MAX_VARIANTS} variants, comma-separated; got ${variants.length}.`,
    });
  const keys = variants.map((variant) => `${variant.composition}:${variant.propsFile ?? ""}`);
  if (new Set(keys).size !== keys.length)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--variants names the same variant twice." });
  if (variants.some((variant) => !variant.composition || variant.propsFile === ""))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "--variants: each is a composition id, optionally with :<props.json>.",
    });
  return variants;
}

/** `--techniques`: one generic name per variant, in the same order. */
export function withTechniques(variants: VariantSpec[], value: string | undefined): VariantSpec[] {
  if (value === undefined) return variants;
  const names = value.split(",").map((part) => part.trim());
  if (names.length !== variants.length || names.some((name) => !name))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `--techniques names one technique per variant (${variants.length}), comma-separated.`,
    });
  return variants.map((variant, index) => ({ ...variant, technique: names[index]! }));
}

export type VariantIdentity = { composition: string; propsSha256?: string; renderSha256: string };
const identityOf = (variant: VariantIdentity) =>
  `${variant.composition}|${variant.propsSha256 ?? ""}|${variant.renderSha256}`;

/** 16 hex of sha256 over the project, the shot and the sorted variant identities: the same inputs give the same seed. */
export function tournamentSeed(projectId: string, shotId: string, variants: readonly VariantIdentity[]): string {
  return sha256(JSON.stringify([projectId, shotId, variants.map(identityOf).sort()])).slice(0, 16);
}

/** Labels in seeded order: each variant's place is the rank of sha256(seed + identity). Returns the label of each input, in input order. */
export function assignLabels(seed: string, variants: readonly VariantIdentity[]): string[] {
  const order = variants
    .map((variant, index) => ({ index, key: sha256(`${seed}|${identityOf(variant)}`) }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const labels: string[] = [];
  order.forEach((row, rank) => (labels[row.index] = TOURNAMENT_LABELS[rank]!));
  return labels;
}

/** Both orders of every pair of labels, pairs in alphabetical order. */
export function requiredPackets(
  labels: readonly string[],
): { pairId: string; order: "ab" | "ba"; first: string; second: string }[] {
  const sorted = [...labels].sort();
  return sorted.flatMap((a, i) =>
    sorted.slice(i + 1).flatMap((b) => [
      { pairId: `${a}${b}`, order: "ab" as const, first: a, second: b },
      { pairId: `${a}${b}`, order: "ba" as const, first: b, second: a },
    ]),
  );
}

// --- The shot and what a render of it measures ---

type Shot = MotionPlan["shots"][number];

export function planShot(plan: MotionPlan, shotId: string): Shot {
  const shot = plan.shots.find((item) => item.id === shotId);
  if (!shot)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `The motion plan has no shot "${shotId}". Its shots: ${plan.shots.map((item) => item.id).join(", ")}.`,
    });
  return shot;
}

/** The shot's numbers from its own render's evidence: duration, when motion starts after the cut, energy, spread, sharp share. */
export function measureShot(evidence: FilmEvidence): Record<string, number> {
  const cuts = evidence.boundaries.map((row) => row.timeSec);
  const onset = evidence.motion.find((row) => row.changed > STILL_CHANGED_SHARE);
  const spread = readMotionSpread(evidence, cuts);
  const sharp = readFastSharp(evidence, cuts);
  const energy = evidence.motion.length
    ? evidence.motion.reduce((sum, row) => sum + row.energy, 0) / evidence.motion.length
    : undefined;
  return {
    durationSec: round(evidence.video.durationSec, 3),
    ...(onset ? { cutOffsetSec: round(onset.timeSec, 3) } : {}),
    ...(energy !== undefined ? { motionEnergy: round(energy, 3) } : {}),
    ...(spread ? { motionSpreadShare: spread.share } : {}),
    ...(sharp && sharp.fast ? { fastSharpShare: sharp.share } : {}),
  };
}

/** The shot's sensor rows: motion:check's verdict and film:measure's shot legs. Any fail excludes the variant. */
/** motion:check's result as the variant's sensor row: the failing counters (motion:check's names: textOffStage 3) with their counts, and how many findings an allow rule took out. */
export function motionCheckSensor(check: {
  failing: boolean;
  counters: Partial<Record<string, number | null>>;
  allowed?: { code: string; matched: number }[];
}): { ok: boolean; problems: number; message: string } {
  const codes = Object.entries(check.counters)
    .filter(([, value]) => (value ?? 0) > 0)
    .sort(([a, x], [b, y]) => (y ?? 0) - (x ?? 0) || a.localeCompare(b));
  const problems = codes.reduce((sum, [, value]) => sum + (value ?? 0), 0);
  const allowedCount = (check.allowed ?? []).reduce((sum, rule) => sum + rule.matched, 0);
  const allowed = allowedCount ? `; ${allowedCount} finding(s) allowed by --allow` : "";
  if (!check.failing) return { ok: true, problems, message: `motion:check passed${allowed}` };
  return {
    ok: false,
    problems,
    message: `motion:check failed: ${codes.map(([code, value]) => `${code} ${value}`).join(", ") || "see motion:check"}${allowed}`,
  };
}

export function shotSensors(
  motionCheck: { ok: boolean; problems: number; message: string },
  measure: Pick<FilmMeasure, "legs">,
): TournamentVariant["sensors"] {
  return [
    {
      id: "motion:check",
      status: motionCheck.ok ? "pass" : "fail",
      value: motionCheck.problems,
      message: motionCheck.message,
    },
    ...measure.legs
      .filter((leg) => (SHOT_LEGS as readonly string[]).includes(leg.id))
      .map((leg) => ({ id: leg.id, status: leg.status, value: leg.value, message: leg.message })),
  ];
}

// --- Distance to the corpus ---

const entriesOf = (corpus: ReferenceCorpus | undefined, fn: TechniqueFunction | undefined) =>
  corpus && fn ? (corpus.techniques.byFunction[fn] ?? []) : [];
const spanLength = (span: { startSec: number; endSec: number }) => Math.max(0, span.endSec - span.startSec);

/**
 * Which corpus band each measured feature is compared with. Duration and cut offset come from the function's techniques;
 * energy, spread and sharp share only from global corpus metrics of the same name and unit (film:measure's), never from
 * optical flow, which is another unit. A feature without a band is listed as unavailable.
 */
function bands(
  corpus: ReferenceCorpus | undefined,
  fn: TechniqueFunction | undefined,
): Record<string, { values?: number[]; metric?: string; from: string }> {
  const entries = entriesOf(corpus, fn);
  const durations = entries.flatMap((entry) =>
    entry.timing ? [entry.timing.durationSec] : entry.spans.map(spanLength),
  );
  const offsets = entries.flatMap((entry) =>
    entry.timing?.startOffsetFromCutSec !== undefined ? [entry.timing.startOffsetFromCutSec] : [],
  );
  return {
    durationSec: { values: durations, from: `${fn ?? "no function"} techniques: timing.durationSec or span length` },
    cutOffsetSec: { values: offsets, from: `${fn ?? "no function"} techniques: timing.startOffsetFromCutSec` },
    motionEnergy: { metric: "motionEnergy", from: "corpus metric motionEnergy" },
    motionSpreadShare: { metric: "motionSpreadShare", from: "corpus metric motionSpreadShare" },
    fastSharpShare: { metric: "fastSharpShare", from: "corpus metric fastSharpShare" },
  };
}

/** 0 inside p25-p75; outside, the gap to the nearer edge over the band's width, floored so a narrow band does not explode. */
export function bandDistance(value: number, band: { p25: number; p75: number }): number {
  if (value >= band.p25 && value <= band.p75) return 0;
  const width = Math.max(band.p75 - band.p25, 0.1 * Math.max(Math.abs(band.p25), Math.abs(band.p75)), 1e-3);
  const gap = value < band.p25 ? band.p25 - value : value - band.p75;
  return round(gap / width, 3);
}

/** Normalised distance of a variant's shot numbers to the corpus for the shot's function: the mean over features that have a band. */
export function corpusDistance(
  measured: Record<string, number>,
  corpus: ReferenceCorpus | undefined,
  fn: TechniqueFunction | undefined,
): CorpusDistance {
  const features: CorpusDistance["features"] = [];
  const unavailable: string[] = [];
  for (const [feature, source] of Object.entries(bands(corpus, fn))) {
    const value = measured[feature];
    const row = source.metric ? corpus?.metrics[source.metric] : distribution(source.values ?? []);
    if (value === undefined || !row || row.n < MIN_BAND_VALUES) {
      unavailable.push(feature);
      continue;
    }
    features.push({
      feature,
      value,
      band: { p25: row.p25, p75: row.p75, n: row.n, from: source.from },
      distance: bandDistance(value, row),
    });
  }
  const distance = features.length
    ? round(features.reduce((sum, row) => sum + row.distance, 0) / features.length, 3)
    : null;
  return { ...(fn ? { function: fn } : {}), distance, features, unavailable };
}

/** The reference technique of the same function whose first span is closest in length to the shot; ties by reference, then technique id. */
export function nearestTechnique(
  corpus: ReferenceCorpus | undefined,
  fn: TechniqueFunction | undefined,
  durationSec: number,
): ShotTournament["reference"] {
  const ranked = entriesOf(corpus, fn)
    .filter((entry) => entry.spans.length)
    .map((entry) => ({ entry, span: entry.spans[0]!, gap: Math.abs(spanLength(entry.spans[0]!) - durationSec) }))
    .sort(
      (a, b) =>
        a.gap - b.gap ||
        a.entry.refId.localeCompare(b.entry.refId) ||
        a.entry.techniqueId.localeCompare(b.entry.techniqueId),
    );
  const best = ranked[0];
  return best
    ? {
        refId: best.entry.refId,
        techniqueId: best.entry.techniqueId,
        name: best.entry.name,
        startSec: best.span.startSec,
        endSec: best.span.endSec,
      }
    : undefined;
}

// --- Preparing the record ---

export type MeasuredVariant = VariantSpec & {
  propsSha256?: string;
  render: string;
  renderSha256: string;
  sensors: TournamentVariant["sensors"];
  measured: Record<string, number>;
  strip?: string;
};

export type PrepareInput = {
  projectId: string;
  plan: MotionPlan;
  shotId: string;
  variants: MeasuredVariant[];
  corpus?: ReferenceCorpus;
  /** Packet files are written by the caller; this names where they go, relative to the root. */
  packetDir: string;
  at?: string;
};

/** Builds the tournament record: seeded labels, sensor exclusions, corpus distance, packets among the survivors in both orders. */
export function prepareTournament(input: PrepareInput): ShotTournament {
  const { plan, shotId, projectId } = input;
  const shot = planShot(plan, shotId);
  if (input.variants.length < MIN_VARIANTS || input.variants.length > MAX_VARIANTS)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `A tournament takes ${MIN_VARIANTS} or ${MAX_VARIANTS} variants.`,
    });
  const seed = tournamentSeed(projectId, shotId, input.variants);
  const labels = assignLabels(seed, input.variants);
  const durationSec = shot.durationFrames / plan.fps;
  const variants: TournamentVariant[] = input.variants
    .map((variant, index) => ({
      label: labels[index]!,
      composition: variant.composition,
      ...(variant.propsFile ? { propsFile: variant.propsFile } : {}),
      ...(variant.propsSha256 ? { propsSha256: variant.propsSha256 } : {}),
      ...(variant.technique ? { technique: variant.technique } : {}),
      render: variant.render,
      renderSha256: variant.renderSha256,
      sensors: variant.sensors,
      failed: variant.sensors.some((sensor) => sensor.status === "fail"),
      corpus: corpusDistance(variant.measured, input.corpus, shot.function),
      ...(variant.strip ? { strip: variant.strip } : {}),
      measured: variant.measured,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const survivors = variants.filter((variant) => !variant.failed).map((variant) => variant.label);
  const packets = requiredPackets(survivors).map((packet) => ({
    ...packet,
    file: path.join(input.packetDir, `packet-${packet.pairId}-${packet.order}.json`),
  }));
  const record: ShotTournament = {
    schemaVersion: 1,
    projectId,
    shotId,
    ...(shot.function ? { function: shot.function } : {}),
    ...(shot.weight ? { weight: shot.weight } : {}),
    frames: { start: shot.startFrame, end: shot.startFrame + shot.durationFrames - 1 },
    fps: plan.fps,
    seed,
    ...(nearestTechnique(input.corpus, shot.function, durationSec)
      ? { reference: nearestTechnique(input.corpus, shot.function, durationSec)! }
      : {}),
    variants,
    packets,
  };
  if (!survivors.length)
    record.undecided = `Every variant failed a sensor: ${variants.map((variant) => `${variant.label} (${failedSensors(variant).join(", ")})`).join("; ")}. Fix them or bring new variants.`;
  if (survivors.length === 1) record.decision = decide(record, [], input.at);
  return ShotTournamentSchema.parse(record);
}

const failedSensors = (variant: TournamentVariant) =>
  variant.sensors.filter((sensor) => sensor.status === "fail").map((sensor) => sensor.id);

/** What the critic opens: labels, strips and the reference, never a composition id. */
export function packetContent(record: ShotTournament, packet: ShotTournament["packets"][number]) {
  const side = (label: string) => {
    const variant = record.variants.find((item) => item.label === label)!;
    // The clip by its label, where prepare renames each render: a record's render path is never shown.
    return {
      label,
      clip: path.join(path.dirname(packet.file), `variant-${label}.mp4`),
      ...(variant.strip ? { strip: variant.strip } : {}),
    };
  };
  return {
    schemaVersion: 1,
    shotId: record.shotId,
    seed: record.seed,
    pairId: packet.pairId,
    order: packet.order,
    ...(record.function ? { function: record.function } : {}),
    ...(record.reference
      ? {
          reference: {
            name: record.reference.name,
            refId: record.reference.refId,
            spanSec: [record.reference.startSec, record.reference.endSec],
          },
        }
      : {}),
    first: side(packet.first),
    second: side(packet.second),
    ask: "Which of the two does this shot's job better, next to the reference row above each strip? Judge craft against the slop catalogue, not taste. Answer {pairId, order, winner (label or tie), reason}.",
  };
}

/** Writes each packet's JSON where the record says, relative to `rootDir`; returns the absolute paths. */
export function writePackets(record: ShotTournament, rootDir: string): string[] {
  return record.packets.map((packet) =>
    writeJsonAtomic(path.resolve(rootDir, packet.file), packetContent(record, packet)),
  );
}

// --- Judging ---

const describeNet = (net: Record<string, number>) =>
  Object.entries(net)
    .map(([label, value]) => `${label} ${value > 0 ? "+" : ""}${value}`)
    .join(", ");

function decide(
  record: ShotTournament,
  judgements: TournamentJudgement[],
  at = new Date().toISOString(),
): NonNullable<ShotTournament["decision"]> {
  const survivors = record.variants.filter((variant) => !variant.failed);
  const excluded = record.variants.filter((variant) => variant.failed).map((variant) => variant.label);
  const pairJudgements: PairJudgement[] = judgements.map((judgement) => {
    const packet = record.packets.find((item) => item.pairId === judgement.pairId && item.order === judgement.order)!;
    return { first: packet.first, second: packet.second, winner: judgement.winner };
  });
  const pairs = agreedPairs(pairJudgements);
  const net: Record<string, number> = Object.fromEntries(survivors.map((variant) => [variant.label, 0]));
  for (const pair of pairs.filter((outcome) => outcome.agreed)) {
    const loser = pair.winner === pair.a ? pair.b : pair.a;
    net[pair.winner!]! += 1;
    net[loser]! -= 1;
  }
  const distanceOf = (label: string) =>
    record.variants.find((variant) => variant.label === label)!.corpus.distance ?? Number.POSITIVE_INFINITY;
  const ranked = survivors
    .map((variant) => variant.label)
    .sort((a, b) => net[b]! - net[a]! || distanceOf(a) - distanceOf(b) || a.localeCompare(b));
  const winner = ranked[0]!;
  const tied = ranked.filter((label) => net[label] === net[winner]);
  const decidedBy =
    survivors.length === 1
      ? "sole-survivor"
      : tied.length === 1
        ? "pairwise"
        : tied.some((label) => label !== winner && distanceOf(label) !== distanceOf(winner))
          ? "corpus-distance"
          : "label";
  const variant = record.variants.find((item) => item.label === winner)!;
  const sensorLine = (item: TournamentVariant) =>
    `${item.label}: ${item.sensors.map((sensor) => `${sensor.id} ${sensor.status}${sensor.value === null ? "" : ` ${sensor.value}`}`).join(", ")}`;
  const distanceLine = record.variants.map((item) => `${item.label} ${item.corpus.distance ?? "n/a"}`).join(", ");
  const pairLine = pairs
    .map(
      (pair) =>
        `${pair.a}${pair.b} ${pair.agreed ? `${pair.winner} in both orders` : `split (${pair.ab ?? "?"} / ${pair.ba ?? "?"})`}`,
    )
    .join("; ");
  const rationale = [
    `${winner} wins shot ${record.shotId}${record.function ? ` (${record.function})` : ""}, decided by ${decidedBy}.`,
    survivors.length > 1
      ? `Net agreed wins: ${describeNet(net)}. Pairs: ${pairLine || "none"}.`
      : `Only ${winner} passed every sensor.`,
    excluded.length
      ? `Excluded by sensors: ${record.variants
          .filter((item) => item.failed)
          .map((item) => `${item.label} (${failedSensors(item).join(", ")})`)
          .join("; ")}.`
      : "No variant failed a sensor.",
    `Corpus distance${record.function ? ` to ${record.function}` : ""}: ${distanceLine}${variant.corpus.unavailable.length ? `; without a band: ${variant.corpus.unavailable.join(", ")}` : ""}.`,
    `Sensors: ${record.variants.map(sensorLine).join("; ")}.`,
  ].join(" ");
  return {
    winner,
    composition: variant.composition,
    ...(variant.propsSha256 ? { propsSha256: variant.propsSha256 } : {}),
    net,
    excluded,
    decidedBy,
    rationale,
    at,
  };
}

/** Takes the critic's judgements: refuses another preparation's results, a packet left unjudged, or one judged twice. */
export function judgeTournament(record: ShotTournament, results: TournamentResults, at?: string): ShotTournament {
  if (results.shotId !== record.shotId)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `The results are for shot ${results.shotId}, the record for ${record.shotId}.`,
    });
  if (results.seed !== record.seed)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `The results name seed ${results.seed}; this preparation is ${record.seed}. Judge the current packets.`,
    });
  if (record.undecided && !record.packets.length)
    throw new CliErrorObject({ code: "VALIDATION", message: record.undecided });
  const key = (row: { pairId: string; order: string }) => `${row.pairId}-${row.order}`;
  const wanted = new Set(record.packets.map(key));
  const seen = new Set<string>();
  for (const judgement of results.judgements) {
    if (!wanted.has(key(judgement)))
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `No packet ${key(judgement)} in this tournament: ${[...wanted].join(", ")}.`,
      });
    if (seen.has(key(judgement)))
      throw new CliErrorObject({ code: "INVALID_INPUT", message: `Packet ${key(judgement)} is judged twice.` });
    seen.add(key(judgement));
    const packet = record.packets.find((item) => key(item) === key(judgement))!;
    if (judgement.winner !== "tie" && judgement.winner !== packet.first && judgement.winner !== packet.second)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `Packet ${key(judgement)} compares ${packet.first} and ${packet.second}; the winner is ${judgement.winner}.`,
      });
  }
  const missing = [...wanted].filter((item) => !seen.has(item));
  if (missing.length)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `Every packet is judged, in both orders; missing: ${missing.join(", ")}.`,
    });
  const judgements = [...results.judgements].sort((a, b) => key(a).localeCompare(key(b)));
  const { decision: _old, undecided: _note, ...rest } = record;
  return ShotTournamentSchema.parse({ ...rest, judgements, decision: decide(record, judgements, at) });
}

// --- Status and the build's done check ---

export function readTournament(projectDir: string, shotId: string): ShotTournament | undefined {
  const file = tournamentFile(projectDir, shotId);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = ShotTournamentSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export type TournamentStatus = {
  shotId: string;
  function?: string;
  state: "decided" | "undecided" | "not-prepared" | "invalid";
  winner?: string;
  composition?: string;
  note?: string;
};

/** Per hero shot: decided, waiting for judgements, or not prepared. */
export function tournamentStatus(projectDir: string, plan: MotionPlan): TournamentStatus[] {
  return plan.shots
    .filter((shot) => shot.weight === "hero")
    .map((shot) => {
      const base = { shotId: shot.id, ...(shot.function ? { function: shot.function } : {}) };
      if (!existsSync(tournamentFile(projectDir, shot.id))) return { ...base, state: "not-prepared" as const };
      const record = readTournament(projectDir, shot.id);
      if (!record)
        return {
          ...base,
          state: "invalid" as const,
          note: `${path.basename(tournamentFile(projectDir, shot.id))} does not match its schema`,
        };
      if (record.decision)
        return {
          ...base,
          state: "decided" as const,
          winner: record.decision.winner,
          composition: record.decision.composition,
        };
      return {
        ...base,
        state: "undecided" as const,
        note:
          record.undecided ??
          `dispatch a fresh creative-critic with the ${record.packets.length} packets in ${path.dirname(record.packets[0]?.file ?? `out/${record.projectId}/tournament/${shot.id}/`)}; it writes results naming seed ${record.seed}; then run shot:tournament --action judge. The maker never writes them`,
      };
    });
}

/** What the build mounts for a shot: build.json's `shots` entry, else the film's composition. */
export type BuildRecordLike = { composition: string; shots?: Record<string, { composition: string; props?: string }> };

/**
 * The build step's `tournament-decided`: each hero shot's tournament is decided, and its winner is what the build mounts
 * (same composition; same props by hash, read from disk now). No hero shot, no problem.
 */
export function heroTournamentProblems(
  projectDir: string,
  rootDir: string,
  plan: MotionPlan,
  build: BuildRecordLike,
): string[] {
  const statuses = tournamentStatus(projectDir, plan);
  return statuses.flatMap((status) => {
    if (status.state === "not-prepared")
      return [`hero shot ${status.shotId} has no tournament: run shot:tournament --action prepare with 2-3 variants`];
    if (status.state === "invalid") return [`hero shot ${status.shotId}: ${status.note}`];
    if (status.state === "undecided") return [`hero shot ${status.shotId} is not decided: ${status.note}`];
    const record = readTournament(projectDir, status.shotId)!;
    const decision = record.decision!;
    const used = build.shots?.[status.shotId] ?? { composition: build.composition };
    if (used.composition !== decision.composition)
      return [
        `hero shot ${status.shotId}: the build mounts ${used.composition}, the tournament chose ${decision.winner} (${decision.composition}); build the winner or name it in build.json shots`,
      ];
    if (decision.propsSha256) {
      if (!used.props)
        return [
          `hero shot ${status.shotId}: the winner ran with a props file; name it in build.json shots.${status.shotId}.props`,
        ];
      const file = path.resolve(rootDir, used.props);
      if (!existsSync(file)) return [`hero shot ${status.shotId}: props ${used.props} is not on disk`];
      if (hashFile(file) !== decision.propsSha256)
        return [
          `hero shot ${status.shotId}: props ${used.props} differ from the winner's: run the tournament again or restore them`,
        ];
    }
    return [];
  });
}

// --- The decision as a memory observation ---

/**
 * One line with no project or composition name: the shot's function and the winning technique (`--techniques`), so the
 * same win in another film is the same line. Undefined without technique names: a planned block list cannot say who won.
 */
export function decisionSummary(record: ShotTournament): string | undefined {
  const winner = record.variants.find((variant) => variant.label === record.decision?.winner);
  if (!winner?.technique) return undefined;
  return `Shot tournament: a ${record.function ?? "unclassified"} hero shot was won by ${winner.technique}`.slice(
    0,
    160,
  );
}

const technique = (record: ShotTournament, label: string) => {
  const name = record.variants.find((variant) => variant.label === label)?.technique;
  return name ? `, ${name}` : "";
};

export function decisionBody(record: ShotTournament): string {
  const decision = record.decision;
  if (!decision) return "";
  return [
    `Project ${record.projectId}, shot ${record.shotId}, frames ${record.frames.start}-${record.frames.end}.`,
    `Winner ${decision.winner} (${decision.composition}${technique(record, decision.winner)}); losers ${record.variants
      .filter((variant) => variant.label !== decision.winner)
      .map((variant) => `${variant.label} (${variant.composition}${technique(record, variant.label)})`)
      .join(", ")}.`,
    ...record.variants.map(
      (variant) =>
        `${variant.label}: corpus distance ${variant.corpus.distance ?? "n/a"}; ${Object.entries(variant.measured)
          .map(([key, value]) => `${key} ${value}`)
          .join(", ")}; ${variant.sensors.map((sensor) => `${sensor.id} ${sensor.status}`).join(", ")}.`,
    ),
    record.reference
      ? `Nearest reference technique: ${record.reference.refId}/${record.reference.techniqueId} "${record.reference.name}" ${record.reference.startSec}-${record.reference.endSec} s.`
      : "No reference technique of this function in the corpus.",
    decision.rationale,
  ].join("\n");
}

/**
 * Records the decision as an observation scoped to the playbook and the build step, with no project in its scope. The same
 * win in a later film (an active shot-tournament observation with the same line) counts as a sighting, which
 * `memory --consolidate` turns into a suggestion; judging the same tournament again counts nothing. Best-effort: a warning
 * instead of a throw.
 */
export function noteTournamentDecision(
  record: ShotTournament,
  root?: string,
): { id?: string; seen?: boolean; warning?: string } {
  if (!record.decision) return {};
  const summary = decisionSummary(record);
  if (!summary)
    return {
      warning:
        "memory: the tournament decision was not recorded: name each variant's technique with --techniques at prepare",
    };
  const evidence = `public/projects/${record.projectId}/pipeline/tournament/${record.shotId}.json`;
  try {
    const same = loadMemory(root).entries.find(
      (entry) =>
        entry.type === "observation" &&
        entry.status === "active" &&
        entry.source.kind === "agent" &&
        entry.source.agent === TOURNAMENT_AGENT &&
        entry.summary === summary,
    );
    if (same) {
      if (same.source.kind === "agent" && (same.source.evidence === evidence || same.body.includes(evidence)))
        return { id: same.id, seen: false };
      return { id: markSeen(same.id, root, `${evidence}: ${record.decision.rationale}`.slice(0, 300)).id, seen: true };
    }
    const playbook = projectPlaybook(record.projectId, root);
    const entry = addMemory(
      {
        type: "observation",
        summary,
        body: decisionBody(record),
        scope: { steps: ["build"], ...(playbook ? { playbooks: [playbook] } : {}) },
        source: { kind: "agent", agent: TOURNAMENT_AGENT, evidence },
      },
      root,
    );
    return { id: entry.id };
  } catch (error) {
    return {
      warning: `memory: the tournament decision was not recorded: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
