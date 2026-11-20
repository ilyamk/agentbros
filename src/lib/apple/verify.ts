import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { LocalQualificationSchema, LocalTaskSchema, type LocalTask } from "../../types/local-capabilities";
import {
  AppleTextResultSchema,
  AppleTranslationResultSchema,
  AppleAudioResultSchema,
  AppleVisionResultSchema,
  AppleAssistanceResultSchema,
} from "../../types/apple-results";
import { TranscriptSchema } from "../../types/transcript";
import { atomicJson, boundedFile, fileHash, localRoot, objectHash } from "./runtime";
import { appleSpeechWords, ensureApple, runAppleTask } from "./tasks";
import { runPortableVoice } from "../speech/portable-voice";
import { portableLanguage, portableVoiceIdentity } from "../speech/portable-voice-runtime";
const pin = z.object({ file: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const LocalBenchmarkSchema = z
  .object({
    version: z.literal(1),
    task: LocalTaskSchema,
    language: z.string().min(2),
    voice: z.string().optional(),
    assistTask: z.enum(["summarise", "tags", "chapters", "shot-notes"]).optional(),
    licence: z.string().min(1),
    cases: z
      .array(z.object({ input: pin, baseline: pin, reference: pin }).strict())
      .min(3)
      .max(100),
  })
  .strict();
export function qualityReference(task: LocalTask, input: unknown): unknown {
  switch (task) {
    case "text.analyse": {
      const value = AppleTextResultSchema.parse(input);
      if (!value.items.length) throw new Error("Quality reference needs labelled text spans");
      return value;
    }
    case "text.translate": {
      const value = z
        .object({
          version: z.literal(1),
          kind: z.enum(["text", "scenes", "captions"]),
          sourceLanguage: z.string(),
          targetLanguage: z.string(),
          protectedTerms: z.array(z.string()),
          units: z
            .array(
              z
                .object({
                  id: z.string(),
                  text: z.string().min(1),
                  startMs: z.number().optional(),
                  endMs: z.number().optional(),
                })
                .strict(),
            )
            .min(1),
          timing: z.literal("source-cue-only"),
          wordTiming: z.null(),
          reviewRequired: z.literal(true),
        })
        .strict()
        .parse(input);
      return value;
    }
    case "audio.events": {
      const value = AppleAudioResultSchema.parse(input);
      if (!value.events.length || !value.labels.length)
        throw new Error("Quality reference needs labelled events and taxonomy");
      return value;
    }
    case "speech.synthesise": {
      const unit = z
        .object({
          id: z.string(),
          file: z.string(),
          voice: z.string(),
          language: z.string(),
          durationSec: z.number().positive(),
          sampleRate: z.number().positive(),
          sourceTextHash: z.string().regex(/^[a-f0-9]{64}$/),
          readbackMatched: z.boolean().optional(),
          audioChecks: z
            .object({ peakDb: z.number().finite(), rmsDb: z.number().finite(), clippingRisk: z.literal(false) })
            .strict(),
        })
        .strict();
      const value = z
        .object({
          units: z.array(unit).min(1),
          voice: z.string(),
          language: z.string(),
          reviewRequired: z.literal(true),
        })
        .strict()
        .parse(input);
      return { ...value, units: value.units.map(({ file: _file, readbackMatched: _readback, ...rest }) => rest) };
    }
    case "text.assist":
    case "image.describe": {
      const value = AppleAssistanceResultSchema.parse(input);
      if (value.items.some((row) => !row.text.trim() && !row.tags.length))
        throw new Error("Quality reference needs substantive source-bound content");
      return value;
    }
    default: {
      if (!task.startsWith("vision.")) throw new Error("Unsupported qualification reference");
      const value = AppleVisionResultSchema.parse(input);
      const field = task.slice(7);
      const key = field === "pose" ? "poses" : field === "tracking" ? "tracks" : field;
      if (
        !value.frames.some((frame) => {
          const content = (frame as Record<string, unknown>)[key];
          return Array.isArray(content) ? content.length > 0 : !!content;
        })
      )
        throw new Error("Vision quality reference needs positive labelled observations for this task");
      return value;
    }
  }
}
export function referenceDistance(actual: unknown, reference: unknown): number {
  if (typeof reference === "number")
    return typeof actual === "number" && Number.isFinite(actual) ? Math.abs(actual - reference) : 1;
  if (reference === null || typeof reference !== "object") return actual === reference ? 0 : 1;
  if (Array.isArray(reference)) {
    if (!Array.isArray(actual)) return Math.max(1, reference.length);
    return (
      Math.abs(actual.length - reference.length) +
      reference.reduce((sum, value, i) => sum + referenceDistance(actual[i], value), 0)
    );
  }
  const row = actual && typeof actual === "object" ? (actual as Record<string, unknown>) : {};
  return Object.entries(reference).reduce((sum, [key, value]) => sum + referenceDistance(row[key], value), 0);
}
const normalise = (text: string) => text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
export function speechMetrics(
  actual: { words: { text: string; startSec: number }[] },
  reference: { words: { text: string; startSec: number }[] },
) {
  if (actual.words.length > 1000 || reference.words.length > 1000 || !reference.words.length)
    throw new Error("Speech qualification cases need 1..1000 reference words and at most 1000 candidate words");
  const a = actual.words,
    r = reference.words;
  const rows = Array.from({ length: r.length + 1 }, (_, i) =>
    Array.from({ length: a.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= r.length; i++)
    for (let j = 1; j <= a.length; j++)
      rows[i]![j] = Math.min(
        rows[i - 1]![j]! + 1,
        rows[i]![j - 1]! + 1,
        rows[i - 1]![j - 1]! + (normalise(r[i - 1]!.text) === normalise(a[j - 1]!.text) ? 0 : 1),
      );
  const errors: number[] = [];
  let i = r.length,
    j = a.length;
  while (i && j) {
    const equal = normalise(r[i - 1]!.text) === normalise(a[j - 1]!.text);
    if (rows[i]![j] === rows[i - 1]![j - 1]! + (equal ? 0 : 1)) {
      if (equal) errors.push(Math.abs(r[i - 1]!.startSec - a[j - 1]!.startSec));
      i--;
      j--;
    } else if (rows[i]![j] === rows[i - 1]![j]! + 1) i--;
    else j--;
  }
  errors.sort((a, b) => a - b);
  return {
    wer: rows[r.length]![a.length]! / r.length,
    startP95Sec: errors.length
      ? errors[Math.min(errors.length - 1, Math.floor(errors.length * 0.95))]!
      : Number.MAX_SAFE_INTEGER,
  };
}
function pinned(input: z.infer<typeof pin>) {
  if (fileHash(input.file, 32 * 1024 ** 3) !== input.sha256) throw new Error("Benchmark fixture changed");
  return input.file;
}
export async function verifyLocal(options: {
  task: LocalTask;
  language?: string;
  targetLanguage?: string;
  voice?: string;
  assistTask?: "summarise" | "tags" | "chapters" | "shot-notes";
  input?: string;
  benchmark?: string;
  suite: "smoke" | "quality";
  root?: string;
}) {
  if (options.suite === "quality" && options.task === "speech.synthesise" && !options.voice)
    throw new Error("Voice quality qualification needs an explicit installed --voice");
  const portable = options.task === "speech.synthesise" && options.voice?.startsWith("supertonic:");
  if (portable) options = { ...options, language: portableLanguage(options.language) };
  const root = options.root ?? localRoot(),
    status = portable
      ? { identity: portableVoiceIdentity(options.voice!) }
      : await ensureApple(options.task, options.language, { ...options, purpose: "draft" });
  const directory = path.join(
    root,
    "verification",
    "runs",
    String(Date.now()) + "-" + objectHash(options).slice(0, 12),
  );
  mkdirSync(directory, { recursive: true });
  let passed = true;
  const metrics: Record<string, number> = {};
  const evidence: unknown[] = [];
  const run = async (input: string, index: number) => {
    if (options.task === "speech.transcribe") {
      if (!options.language) throw new Error("Speech verification needs --language");
      return await appleSpeechWords(input, options.language, root);
    }
    const output = path.join(directory, `result-${index}.json`);
    if (portable)
      runPortableVoice({
        ...options,
        input,
        output,
        purpose: "draft",
        qualificationRoot: root,
        dryRun: false,
        force: false,
      });
    else await runAppleTask({ ...options, input, output, purpose: "draft" });
    return (JSON.parse(boundedFile(output).toString()) as { result: unknown }).result;
  };
  if (options.suite === "smoke") {
    if (!options.input) throw new Error("Smoke verification requires --input in the task command format");
    const result = await run(options.input, 0);
    evidence.push({ input: { file: path.resolve(options.input), sha256: fileHash(options.input) }, result });
    metrics.structuralChecks = 1;
  } else {
    if (!options.benchmark)
      throw new Error(
        "Quality verification needs --benchmark with at least three pinned, labelled cases and baseline results; a smoke test cannot qualify production",
      );
    const benchmark = LocalBenchmarkSchema.parse(JSON.parse(boundedFile(options.benchmark).toString()));
    if (
      benchmark.task !== options.task ||
      benchmark.language !== options.language ||
      benchmark.voice !== options.voice ||
      (benchmark.assistTask ?? "summarise") !== (options.assistTask ?? "summarise")
    )
      throw new Error("Benchmark task/language/voice does not match the request");
    for (const [index, item] of benchmark.cases.entries()) {
      const input = pinned(item.input),
        baseline = JSON.parse(boundedFile(pinned(item.baseline)).toString()) as unknown,
        reference = JSON.parse(boundedFile(pinned(item.reference)).toString()) as unknown;
      if (options.task === "speech.transcribe") {
        TranscriptSchema.parse(reference);
        TranscriptSchema.parse(baseline);
      } else {
        qualityReference(options.task, reference);
        qualityReference(options.task, (baseline as { result?: unknown })?.result ?? baseline);
      }
      const candidate = await run(input, index);
      if (options.task === "speech.transcribe") {
        const expected = TranscriptSchema.parse(reference),
          previous = TranscriptSchema.parse(baseline);
        const actual = z
          .object({ words: TranscriptSchema.shape.words, timing: z.enum(["native", "estimated"]) })
          .parse({
            ...(candidate as object),
            words: (candidate as { words: object[] }).words.map((word, i) => ({
              id: `w${i}`,
              kind: "word",
              speaker: null,
              channel: null,
              ...word,
            })),
          });
        const current = speechMetrics(actual, expected),
          prior = speechMetrics(previous, expected);
        const ok = actual.timing === "native" && current.wer <= prior.wer && current.startP95Sec <= prior.startP95Sec;
        passed &&= ok;
        metrics[`case${index}.wer`] = current.wer;
        metrics[`case${index}.startP95Sec`] = current.startP95Sec;
        evidence.push({ input: item.input, current, baseline: prior, passed: ok });
      } else {
        const expected = qualityReference(options.task, reference),
          actual = qualityReference(options.task, candidate),
          previous = qualityReference(options.task, (baseline as { result?: unknown })?.result ?? baseline);
        const current = referenceDistance(actual, expected),
          prior = referenceDistance(previous, expected);
        const matches =
          !portable ||
          (candidate as { units: { readbackMatched: boolean }[] }).units.every((unit) => unit.readbackMatched);
        const ok = matches && current === 0 && current <= prior;
        passed &&= ok;
        metrics[`case${index}.referenceDistance`] = current;
        evidence.push({ input: item.input, current, baseline: prior, passed: ok });
      }
      pinned(item.input);
      pinned(item.baseline);
      pinned(item.reference);
    }
    evidence.push({ benchmarkHash: fileHash(options.benchmark), licence: benchmark.licence });
  }
  const evidenceFile = path.join(directory, "evidence.json");
  atomicJson(evidenceFile, { version: 1, suite: options.suite, task: options.task, evidence, metrics, passed });
  const now = Date.now();
  const qualification = LocalQualificationSchema.parse({
    version: 1,
    task: options.task,
    language: options.language ?? "",
    identity: status.identity,
    checkedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 7 * 86400000).toISOString(),
    suite: options.suite,
    passed,
    metrics,
    evidenceHash: fileHash(evidenceFile),
    evidenceFile: path.relative(root, evidenceFile).split(path.sep).join("/"),
  });
  const file = path.join(
    root,
    "verification",
    objectHash({ task: options.task, language: options.language ?? "", identity: status.identity }) + ".json",
  );
  // A smoke run cannot downgrade or extend an existing, unexpired quality qualification.
  let retain = false;
  if (options.suite === "smoke" && existsSync(file)) {
    try {
      const old = LocalQualificationSchema.parse(JSON.parse(boundedFile(file).toString()));
      retain = old.suite === "quality" && old.passed && Date.parse(old.expiresAt) > now;
    } catch {
      /* Replace invalid evidence. */
    }
  }
  if (!retain) atomicJson(file, qualification);
  return {
    outputs: [file, evidenceFile],
    metadata: {
      passed,
      suite: options.suite,
      qualification,
      limitations:
        "Benchmark conformance does not replace existing human audio, translation or final-delivery approvals.",
    },
  };
}
