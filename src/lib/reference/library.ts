import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";
import { CliErrorObject } from "../cli";
import { probeVideo } from "../vision/media";
import { croppedMedia, detectCrop } from "./crop";
import {
  JUDGED_REFERENCE_LAYERS,
  MEASURED_REFERENCE_LAYERS,
  REFERENCE_LAYERS,
  ReferenceIdSchema,
  ReferenceCropSchema,
  ReferenceSourceSchema,
  type ReferenceAudio,
  type ReferenceBlueprint,
  type ReferenceCrop,
  type ReferenceEdit,
  type ReferenceLayerFile,
  type ReferenceShots,
  type ReferenceSource,
  type ReferenceSpeechText,
} from "../../types/reference";
import { blueprintLeaks } from "./blueprint-content";
import { readFullSpeechText, writeSpeechText } from "./speech-text";
import { MAX_QUOTE_WORDS, referenceVerbatim, type VerbatimFinding } from "./verbatim";
import { phaseSlips } from "./sync";

export const DEFAULT_LIBRARY_ROOT = "design-reference/library";

export function referenceDirectory(root: string, id: string): string {
  if (!ReferenceIdSchema.safeParse(id).success)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `Reference id must be lower-case letters, digits and hyphens: ${id}`,
    });
  return path.resolve(root, id);
}

export function writeLayer<File extends ReferenceLayerFile>(
  directory: string,
  file: File,
  value: z.input<(typeof REFERENCE_LAYERS)[File]>,
): string {
  const parsed = REFERENCE_LAYERS[file].parse(value);
  // The film's words go to the git-ignored local file; the tracked layer keeps their structure.
  if (file === "speech-text.json") return writeSpeechText(directory, parsed as ReferenceSpeechText);
  mkdirSync(directory, { recursive: true });
  const target = path.join(directory, file);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(parsed, null, 2)}\n`);
  renameSync(temporary, target);
  return target;
}

export function readLayer<File extends ReferenceLayerFile>(
  directory: string,
  file: File,
): z.output<(typeof REFERENCE_LAYERS)[File]> | undefined {
  const target = path.join(directory, file);
  if (!existsSync(target)) return undefined;
  return REFERENCE_LAYERS[file].parse(JSON.parse(readFileSync(target, "utf8"))) as z.output<
    (typeof REFERENCE_LAYERS)[File]
  >;
}

export function readSource(directory: string): { source: ReferenceSource; media: string } {
  const target = path.join(directory, "source.json");
  if (!existsSync(target))
    throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `No reference at ${directory}. Run ref:add first.` });
  const source = ReferenceSourceSchema.parse(JSON.parse(readFileSync(target, "utf8")));
  const media = path.resolve(directory, source.mediaPath);
  if (!existsSync(media))
    throw new CliErrorObject({
      code: "FILE_NOT_FOUND",
      message: `Reference media is missing: ${media}. Its media/ directory is git-ignored; run ref:add again.`,
    });
  return { source, media };
}

/** Git-ignored cache of a crop detected for a record from before crops existed, keyed by the media's hash. */
export const DETECTED_CROP_CACHE = "media/detected-crop.json";

function detectedCrop(directory: string, source: ReferenceSource, media: string): ReferenceCrop | null {
  const cache = path.join(directory, DETECTED_CROP_CACHE);
  try {
    const cached = JSON.parse(readFileSync(cache, "utf8")) as { sha256?: string; crop?: unknown };
    if (cached.sha256 === source.sha256) return ReferenceCropSchema.nullable().parse(cached.crop ?? null);
  } catch {
    // no cache yet, or an unreadable one: detect again
  }
  const crop = detectCrop(media, probeVideo(media)) ?? null;
  mkdirSync(path.dirname(cache), { recursive: true });
  writeFileSync(cache, `${JSON.stringify({ sha256: source.sha256, crop }, null, 2)}\n`);
  return crop;
}

/**
 * The media that picture layers read: the cropped copy when the record holds a crop. A record from before crops
 * existed is checked and the result cached under the git-ignored media/; only `persist` (ref:analyze) writes it into
 * source.json. Audio layers keep reading the source.
 */
export function readAnalysisMedia(
  directory: string,
  options: { persist?: boolean } = {},
): { source: ReferenceSource; media: string; analysisMedia: string } {
  let { source, media } = readSource(directory);
  if (source.crop === undefined) {
    source = { ...source, crop: detectedCrop(directory, source, media) };
    if (options.persist) writeLayer(directory, "source.json", source);
  }
  return { source, media, analysisMedia: source.crop ? croppedMedia(media, source.crop) : media };
}

function readFilmDuration(directory: string): number | undefined {
  try {
    return ReferenceSourceSchema.parse(JSON.parse(readFileSync(path.join(directory, "source.json"), "utf8"))).probe
      .durationSec;
  } catch {
    return undefined;
  }
}

const SLOT_COVERAGE_TOLERANCE_SEC = 0.1;

/** A blueprint's slots must fill the film end to end, or an adaptation has unplanned holes. */
export function blueprintCoverageIssues(
  blueprint: ReferenceBlueprint,
  filmDurationSec = blueprint.durationSec,
): string[] {
  const issues: string[] = [];
  const within = (difference: number) => Math.abs(difference) <= SLOT_COVERAGE_TOLERANCE_SEC + 1e-9;
  const seconds = (value: number) => value.toFixed(3);
  if (!within(blueprint.durationSec - filmDurationSec))
    issues.push(
      `durationSec: ${seconds(blueprint.durationSec)} s differs from the film's ${seconds(filmDurationSec)} s`,
    );
  const slots = [...blueprint.slots].sort((a, b) => a.startSec - b.startSec);
  if (!within(slots[0]!.startSec))
    issues.push(`slots: first slot ${slots[0]!.id} starts at ${seconds(slots[0]!.startSec)} s, not 0`);
  for (const [index, slot] of slots.slice(1).entries()) {
    const previous = slots[index]!;
    const gap = slot.startSec - (previous.startSec + previous.durationSec);
    if (!within(gap))
      issues.push(
        `slots: ${gap > 0 ? "gap" : "overlap"} of ${seconds(Math.abs(gap))} s between ${previous.id} and ${slot.id}`,
      );
  }
  const last = slots.at(-1)!;
  const end = last.startSec + last.durationSec;
  if (!within(end - filmDurationSec))
    issues.push(`slots: last slot ${last.id} ends at ${seconds(end)} s, the film at ${seconds(filmDurationSec)} s`);
  return issues;
}

export function validateReference(directory: string) {
  if (!existsSync(directory))
    throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `No reference at ${directory}` });
  const valid: string[] = [];
  const invalid: { file: string; issues: string[] }[] = [];
  const unavailable: { file: string; reason?: string; fix?: string }[] = [];
  for (const file of Object.keys(REFERENCE_LAYERS) as ReferenceLayerFile[]) {
    const target = path.join(directory, file);
    if (!existsSync(target)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(target, "utf8"));
    } catch (error) {
      invalid.push({ file, issues: [`Not JSON: ${error instanceof Error ? error.message : String(error)}`] });
      continue;
    }
    const result = REFERENCE_LAYERS[file].safeParse(raw);
    if (!result.success) {
      invalid.push({
        file,
        issues: result.error.issues.slice(0, 20).map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      });
      continue;
    }
    if (file === "blueprint.json") {
      const filmDuration = readFilmDuration(directory);
      const issues = blueprintCoverageIssues(result.data as ReferenceBlueprint, filmDuration);
      if (issues.length > 0) {
        invalid.push({ file, issues });
        continue;
      }
    }
    valid.push(file);
    const data = result.data as {
      status?: { available: boolean; unavailableReason?: string; fix?: string };
      speech?: { available: boolean; unavailableReason?: string; fix?: string };
      screenText?: { available: boolean; unavailableReason?: string; fix?: string };
    };
    for (const status of [data.status, data.speech, data.screenText])
      if (status && !status.available) unavailable.push({ file, reason: status.unavailableReason, fix: status.fix });
  }
  const missing = (files: ReferenceLayerFile[]) => files.filter((file) => !existsSync(path.join(directory, file)));
  const read = <File extends ReferenceLayerFile>(file: File) =>
    valid.includes(file) ? readLayer(directory, file) : undefined;
  const blueprint = read("blueprint.json");
  // The leak check needs the film's words: the local full file (or a layer not yet redacted). A clone without them skips it.
  const film = valid.includes("speech-text.json") ? readFullSpeechText(directory) : undefined;
  const leaks = blueprint && film ? blueprintLeaks(blueprint, film, read("techniques.json")) : [];
  const audio = read("audio.json");
  // Phase slips come from audio.json, so a sync.json written before the check still gets them.
  const slips = audio
    ? phaseSlips(
        audio.tempo?.beatsSec ?? [],
        audio.onsetsSec,
        audio.sections,
        read("source.json")?.probe.durationSec ?? audio.tempo?.beatsSec.at(-1) ?? 0,
      )
    : (read("sync.json")?.warnings ?? []);
  const warnings = [
    ...correctionWarnings(read("shots.json"), read("edit.json")),
    ...tempoWarnings(directory, audio),
    ...slips.map((warning) => `audio.json: ${warning}`),
  ];
  // Reported, never failing: OCR'd interface words and capitalised labels make the name test too noisy to block on.
  const names = leaks.filter((leak) => leak.kind === "name");
  const words = leaks.filter((leak) => leak.kind === "word");
  if (names.length)
    warnings.push(
      `blueprint.json keeps name-like words from the film (capitalised there, never lower case): ${names.map((leak) => `"${leak.word}" in ${leak.where.slice(0, 3).join(", ")}`).join("; ")}. Rewrite them unless they are ordinary words.`,
    );
  if (words.length)
    warnings.push(
      `blueprint.json shares everyday words with the film's speech or screen text; rewrite any that carry its content: ${words.map((leak) => leak.word).join(", ")}`,
    );
  if (blueprint && !film && valid.includes("speech-text.json"))
    warnings.push(
      "blueprint leak check skipped: this machine has no verbatim text for the film (media/speech-text.full.json). Run ref:analyze --layers speech-text with the media, or check the blueprint by eye for the film's words.",
    );
  const verbatim = referenceVerbatim(directory, film);
  warnings.push(...verbatimWarnings(verbatim));
  return {
    valid,
    invalid,
    unavailable,
    missingMeasured: missing(MEASURED_REFERENCE_LAYERS),
    missingJudged: missing(JUDGED_REFERENCE_LAYERS),
    blueprintLeaks: leaks,
    verbatim,
    filmTextLocal: !!film,
    warnings,
  };
}

/** One warning per file: the film's words in speech-text.json, quotations over the limit, unquoted copies. ref:contribute fails on the same findings. */
export function verbatimWarnings(findings: VerbatimFinding[]): string[] {
  const byFile = new Map<string, VerbatimFinding[]>();
  for (const finding of findings) byFile.set(finding.file, [...(byFile.get(finding.file) ?? []), finding]);
  return [...byFile].map(([file, rows]) =>
    rows[0]!.kind === "speech-text"
      ? `${file} holds the film's words (${rows[0]!.words} entries); run pnpm ref:redact --id <id> to move them to the local media/speech-text.full.json.`
      : `${file} quotes the film beyond ${MAX_QUOTE_WORDS} words in ${rows.length} place${rows.length === 1 ? "" : "s"} (${rows
          .slice(0, 3)
          .map(
            (row) => `${row.where}: ${row.kind === "quote" ? "quoted" : "copied"} ${row.words} words, "${row.excerpt}"`,
          )
          .join("; ")}). Describe the copy instead (role, word count, case, size, timing); ref:contribute refuses it.`,
  );
}

/** Corrections that do nothing or name the wrong shot: a split without a time or outside its named shot, a move outside the film. */
export function correctionWarnings(shots: ReferenceShots | undefined, edit: ReferenceEdit | undefined): string[] {
  if (!shots || !edit) return [];
  const byId = new Map(shots.shots.map((shot) => [shot.id, shot]));
  const end = shots.shots.at(-1)?.endSec ?? 0;
  const warnings: string[] = [];
  edit.corrections.forEach(({ value }, index) => {
    const where = `edit.json corrections[${index}] (${value.kind})`;
    const unknown = value.shotIds.filter((id) => !byId.has(id));
    if (unknown.length) warnings.push(`${where}: no shot ${unknown.join(", ")} in shots.json; it is ignored.`);
    if (value.kind === "split") {
      if (value.timeSec === undefined) warnings.push(`${where}: a split without timeSec adds no cut.`);
      else if (
        !unknown.length &&
        !value.shotIds.some(
          (id) => value.timeSec! >= byId.get(id)!.startSec - 1e-3 && value.timeSec! <= byId.get(id)!.endSec + 1e-3,
        )
      )
        warnings.push(
          `${where}: timeSec ${value.timeSec} lies outside ${value.shotIds.join(", ")}; the cut is still added, check the shot named.`,
        );
    }
    if (value.kind === "move" && (value.toSec === undefined || value.toSec <= 0 || value.toSec >= end))
      warnings.push(`${where}: toSec ${value.toSec} is outside the film; it is ignored.`);
  });
  return warnings;
}

/** The two tempo readings disagree beyond a simple ratio (2:1, 3:2): one of them is probably wrong. */
export function tempoWarnings(directory: string, audio: ReferenceAudio | undefined): string[] {
  const map = path.join(directory, "audiomap.json");
  const bpm = audio?.tempo?.bpm;
  if (!bpm || !existsSync(map)) return [];
  let other: number | undefined;
  try {
    other = (JSON.parse(readFileSync(map, "utf8")) as { tempo?: { bpm?: number } }).tempo?.bpm;
  } catch {
    return [];
  }
  if (!other || !Number.isFinite(other)) return [];
  return tempoDisagrees(bpm, other)
    ? [
        `audio.json tempo ${bpm} BPM and audiomap.json ${other} BPM differ by more than 10% and by no 2:1 or 3:2 ratio: trust neither grid without looking at the waveform.`,
      ]
    : [];
}

export function tempoDisagrees(first: number, second: number, tolerance = 0.1): boolean {
  const ratio = Math.max(first, second) / Math.min(first, second);
  return ![1, 2, 1.5, 3, 4].some((simple) => Math.abs(ratio / simple - 1) <= tolerance);
}
