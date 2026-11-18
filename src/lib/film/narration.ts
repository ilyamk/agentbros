/**
 * The narration step's takes: where each beat's take, receipt and word timings are, measured once by narration:check
 * into pipeline/narration.json, and checked from that file (hashes, no ffprobe) by the step's done check.
 * Method: docs/production-chain/narration.md.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { editSceneCaptions } from "../audio/edit-captions";
import type { WordAlignment } from "../elevenlabs/tts";
import {
  NarrationDirectionSchema,
  NarrationSchema,
  type Narration,
  type NarrationDirection,
} from "../../types/narration";
import { ScriptSchema, type Script } from "../../types/pipeline";
import { compileSpeechCues, validateDirectedText } from "../elevenlabs/direction";

/** Models whose ElevenLabs takes come back timestamped, with a take receipt and a word sidecar (generate-voiceover.ts). */
export const TIMESTAMPED_MODELS = ["eleven_v4", "eleven_flash_v2_5"] as const;

const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const rel = (root: string, file: string) => path.relative(root, path.resolve(root, file)).split(path.sep).join("/");

/** Beats that are spoken: a script beat with text. */
export const spokenBeats = (script: Script) => script.beats.filter((beat) => beat.text.trim());

export function directedBeatText(text: string, direction: NarrationDirection["beats"][number]) {
  const result =
    direction.cues || direction.pronunciations
      ? compileSpeechCues(text, direction.cues ?? [], direction.pronunciations)
      : direction.directedText;
  if (/<\/?(?:break|phoneme|speak|prosody|emphasis)\b/i.test(result)) throw Error("Use audio tags rather than SSML");
  validateDirectedText(text, result, direction.pronunciations);
  return result;
}

/** Problems with a direction before any take exists: one directed beat per spoken beat, a route that leaves receipts. */
export function directionProblems(direction: NarrationDirection, script: Script): string[] {
  const problems: string[] = [];
  const directed = new Map(direction.beats.map((beat) => [beat.beatId, beat]));
  if (directed.size !== direction.beats.length) problems.push("Each spoken beat must have one direction");
  for (const beat of spokenBeats(script)) {
    const row = directed.get(beat.id);
    if (!row) {
      problems.push(`beat ${beat.id} has no directed text`);
      continue;
    }
    try {
      const text = directedBeatText(beat.text, row);
      if (!text.trim()) problems.push(`beat ${beat.id} has no directed text`);
    } catch (error) {
      problems.push(`beat ${beat.id}: ${(error as Error).message}`);
    }
  }
  for (const id of directed.keys())
    if (!script.beats.some((beat) => beat.id === id)) problems.push(`directed beat ${id} is not in the script`);
  if (direction.route === "elevenlabs") {
    if (!direction.voiceRef && !(TIMESTAMPED_MODELS as readonly string[]).includes(direction.modelId))
      problems.push(
        `the ElevenLabs route needs takes with receipts and word timings: pin a voiceRef or use ${TIMESTAMPED_MODELS.join(" or ")}`,
      );
    if (direction.maxCostUsd === undefined)
      problems.push("the ElevenLabs route needs maxCostUsd, the bound the user's approval authorises");
  }
  return problems;
}

/** A beat's take file: take 1 keeps the plain name; a retake sits beside it (generate:voiceover --take). */
export const takeFileName = (beatId: string, take = 1) => `${beatId}${take > 1 ? `.take-${take}` : ""}.mp3`;

type Take = { beatId: string; file: string; receipt: string; words: string };

const LocalResultSchema = z.object({
  task: z.literal("speech.synthesise"),
  result: z.object({ units: z.array(z.object({ id: z.string(), file: z.string() })) }),
});

/**
 * Each spoken beat's take. ElevenLabs and existing takes: voiceover/<beat>.mp3, its `.mp3.take.json` and `.words.json`.
 * Local takes: the voiceover:local result's units, its `.receipt.json`, and a speech:local transcript beside each take
 * (`<take>.transcript.json`) or a `.words.json`.
 */
export function locateTakes(
  root: string,
  dir: string,
  script: Script,
  route: NarrationDirection["route"],
  localResult?: string,
  takeNumber = 1,
): { takes: Take[]; problems: string[] } {
  const problems: string[] = [];
  const takes: Take[] = [];
  let local: Map<string, string> | undefined;
  if (route === "local") {
    const resultFile = localResult ?? path.join(dir, "pipeline/narration-local.json");
    if (!existsSync(path.resolve(root, resultFile)))
      return {
        takes,
        problems: [`${rel(root, resultFile)} is missing: run voiceover:local with --output ${rel(root, resultFile)}`],
      };
    const parsed = LocalResultSchema.safeParse(JSON.parse(readFileSync(path.resolve(root, resultFile), "utf8")));
    if (!parsed.success) return { takes, problems: [`${rel(root, resultFile)} is not a speech.synthesise result`] };
    local = new Map(parsed.data.result.units.map((unit) => [unit.id, rel(root, unit.file)]));
    const receipt = `${rel(root, resultFile)}.receipt.json`;
    for (const beat of spokenBeats(script)) {
      const file = local.get(beat.id);
      if (!file) {
        problems.push(`beat ${beat.id} has no local take in ${rel(root, resultFile)}`);
        continue;
      }
      const base = file.replace(/\.[^./]+$/, "");
      const words = [`${base}.words.json`, `${base}.transcript.json`, `${file}.transcript.json`].find((candidate) =>
        existsSync(path.resolve(root, candidate)),
      );
      takes.push({ beatId: beat.id, file, receipt, words: words ?? `${base}.transcript.json` });
    }
    return { takes, problems };
  }
  for (const beat of spokenBeats(script)) {
    const file = rel(root, path.join(dir, "voiceover", takeFileName(beat.id, takeNumber)));
    takes.push({
      beatId: beat.id,
      file,
      receipt: `${file}.take.json`,
      words: file.replace(/\.mp3$/, ".words.json"),
    });
  }
  return { takes, problems };
}

/** Raw words from an ElevenLabs sidecar ({words:[{text,start,end}]}) or a speech:local transcript ({words:[{text,startSec,endSec,kind}]}). */
export function readWords(file: string): WordAlignment[] {
  const data = JSON.parse(readFileSync(file, "utf8")) as { words?: Record<string, unknown>[] };
  if (!Array.isArray(data.words)) throw new Error(`${file} has no words`);
  return data.words
    .filter((word) => word["kind"] === undefined || word["kind"] === "word")
    .map((word) => ({
      text: String(word["text"]),
      start: Number(word["start"] ?? word["startSec"]),
      end: Number(word["end"] ?? word["endSec"]),
      loss: 0,
    }))
    .filter((word) => word.text.trim() && Number.isFinite(word.start) && Number.isFinite(word.end));
}

/** The text an ElevenLabs take receipt says it voiced, if it records one. */
function receiptText(file: string): string | undefined {
  try {
    const receipt = JSON.parse(readFileSync(file, "utf8")) as { request?: { text?: unknown } };
    return typeof receipt.request?.text === "string" ? receipt.request.text : undefined;
  } catch {
    return undefined;
  }
}

export type MeasureOptions = {
  root: string;
  projectId: string;
  localResult?: string;
  /** Seconds of audio in a take; ffprobe in the CLI, injected in tests. */
  measure: (file: string) => number;
  write?: boolean;
};

/**
 * narration:check's work: every spoken beat's take, receipt and words exist; durations measured; caption words edited
 * (emphasis from the direction) into voiceover/<beat>.words.edited.json; the result in pipeline/narration.json.
 */
export function measureNarration(options: MeasureOptions): { narration?: Narration; problems: string[] } {
  const { root, projectId } = options;
  const dir = path.join("public/projects", projectId);
  const directionFile = path.join(dir, "pipeline/narrator-direction.json");
  const scriptFile = path.join(dir, "pipeline/script.json");
  for (const file of [directionFile, scriptFile])
    if (!existsSync(path.resolve(root, file))) return { problems: [`${file} is missing`] };
  const direction = NarrationDirectionSchema.parse(JSON.parse(readFileSync(path.resolve(root, directionFile), "utf8")));
  const script = ScriptSchema.parse(JSON.parse(readFileSync(path.resolve(root, scriptFile), "utf8")));
  const problems = directionProblems(direction, script);
  if (problems.length) return { problems };
  const { takes, problems: missing } = locateTakes(
    root,
    dir,
    script,
    direction.route,
    options.localResult,
    direction.take,
  );
  const scriptText = new Map(script.beats.map((beat) => [beat.id, beat.text]));
  const directedText = new Map(
    direction.beats.map((beat) => [beat.beatId, directedBeatText(scriptText.get(beat.beatId)!, beat)]),
  );
  problems.push(...missing);
  const emphasis = new Map(direction.beats.map((beat) => [beat.beatId, beat.emphasisWords]));
  const beats: Narration["beats"] = [];
  let at = 0;
  for (const take of takes) {
    const absent = [take.file, take.receipt, take.words].filter((file) => !existsSync(path.resolve(root, file)));
    if (absent.length) {
      problems.push(`beat ${take.beatId}: ${absent.join(", ")} missing`);
      continue;
    }
    if (direction.route !== "local") {
      // An ElevenLabs receipt names the text it voiced: a take made from an earlier direction is not this direction's.
      const voiced = receiptText(path.resolve(root, take.receipt));
      const wanted = directedText.get(take.beatId);
      if (voiced !== undefined && wanted !== undefined && voiced !== wanted) {
        problems.push(
          `beat ${take.beatId}: ${take.file} voices another direction's text: raise the direction's take to ${direction.take + 1} and generate with --take ${direction.take + 1}`,
        );
        continue;
      }
    }
    const durationSec = options.measure(path.resolve(root, take.file));
    if (!(durationSec > 0)) {
      problems.push(`beat ${take.beatId}: ${take.file} has no measurable audio`);
      continue;
    }
    let raw: WordAlignment[];
    try {
      raw = readWords(path.resolve(root, take.words));
    } catch (error) {
      problems.push(`beat ${take.beatId}: ${String(error instanceof Error ? error.message : error)}`);
      continue;
    }
    if (!raw.length) problems.push(`beat ${take.beatId}: ${take.words} holds no words`);
    if (raw.some((word) => word.end > durationSec + 0.25))
      problems.push(`beat ${take.beatId}: word timings run past the take's ${durationSec.toFixed(2)} s`);
    const edited = editSceneCaptions(raw, { language: script.language, emphasisTerms: emphasis.get(take.beatId) });
    const captions = rel(root, path.join(dir, "voiceover", `${take.beatId}.words.edited.json`));
    if (options.write !== false) {
      mkdirSync(path.dirname(path.resolve(root, captions)), { recursive: true });
      writeFileSync(
        path.resolve(root, captions),
        `${JSON.stringify({ sceneId: take.beatId, words: edited.words, droppedFillers: edited.droppedFillers }, null, 2)}\n`,
      );
    }
    beats.push({
      beatId: take.beatId,
      file: take.file,
      sha256: sha(path.resolve(root, take.file)),
      durationSec: Number(durationSec.toFixed(3)),
      receipt: take.receipt,
      words: take.words,
      captions,
      wordCount: edited.words.length,
      emphasisCount: edited.words.filter((word) => word.emphasis).length,
      startSec: Number(at.toFixed(3)),
    });
    at += durationSec;
  }
  if (problems.length) return { problems };
  const narration = NarrationSchema.parse({
    schemaVersion: 1,
    route: direction.route,
    take: direction.take,
    direction: { file: rel(root, directionFile), sha256: sha(path.resolve(root, directionFile)) },
    language: script.language,
    beats,
    totalSec: Number(at.toFixed(3)),
  });
  if (options.write !== false)
    writeFileSync(path.resolve(root, dir, "pipeline/narration.json"), `${JSON.stringify(narration, null, 2)}\n`);
  return { narration, problems };
}

/**
 * The done check's view of pipeline/narration.json, without ffprobe: it was measured from the current direction, and
 * every take, receipt, word file and caption file it names is on disk with the take's recorded hash.
 */
export function narrationFileProblems(root: string, narration: Narration, script: Script): string[] {
  const problems: string[] = [];
  const direction = path.resolve(root, narration.direction.file);
  if (!existsSync(direction) || sha(direction) !== narration.direction.sha256)
    problems.push("narration.json was measured from another direction: run narration:check again");
  const measured = new Set(narration.beats.map((beat) => beat.beatId));
  for (const beat of spokenBeats(script))
    if (!measured.has(beat.id)) problems.push(`beat ${beat.id} has no measured take: run narration:check again`);
  for (const beat of narration.beats) {
    const file = path.resolve(root, beat.file);
    if (!existsSync(file)) problems.push(`beat ${beat.beatId}: ${beat.file} is missing`);
    else if (sha(file) !== beat.sha256)
      problems.push(`beat ${beat.beatId}: ${beat.file} changed since narration:check`);
    for (const other of [beat.receipt, beat.words, beat.captions])
      if (!existsSync(path.resolve(root, other))) problems.push(`beat ${beat.beatId}: ${other} is missing`);
  }
  return problems;
}
