import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { LocalResultReceiptSchema, LocalTextRequestSchema } from "../../types/local-capabilities";
import { atomicJson, boundedFile, digest, fileHash, localRoot, objectHash } from "../apple/runtime";
import { checkVoiceAudio, publishResult } from "../apple/tasks";
import { acquireLock } from "../campaigns/production/files";
import { assertPathWithin, CliErrorObject, emitProgress } from "../cli";
import { qualification } from "../local-capabilities";
import { pythonArgs, pythonEnvironment, pythonUv } from "../python";
import {
  PORTABLE_VOICE_BACKEND as backend,
  PORTABLE_VOICE_PROFILE as profile,
  PORTABLE_VOICE_WORKER as worker,
  PORTABLE_VOICE_MODELS as models,
  PORTABLE_VOICE_PREPARE,
  PORTABLE_VOICE_ID,
  PORTABLE_VOICE_LANGUAGES,
  portableLanguage,
  portableVoiceCache as voiceCache,
  portableVoiceModelsRoot as modelsRoot,
  portableVoiceIdentity,
} from "./portable-voice-runtime";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const Row = z
  .object({
    id: z.string(),
    durationSec: z.number().positive(),
    sampleRate: z.number().int().positive(),
    words: z.array(
      z.object({ text: z.string().min(1), start: z.number().nonnegative(), end: z.number().nonnegative() }),
    ),
    heard: z.string(),
    matched: z.boolean(),
  })
  .strict()
  .superRefine((row, ctx) => {
    if (
      row.matched !== row.words.length > 0 ||
      row.words.some(
        (word, index) =>
          word.end <= word.start || word.end > row.durationSec || (index > 0 && word.start < row.words[index - 1]!.end),
      )
    )
      ctx.addIssue({ code: "custom", message: "Readback timing is inconsistent with the audio clock" });
  });
type Row = z.infer<typeof Row>;
const CacheEntry = z.object({ row: Row, sha256: hash }).strict();
const prepareCommand = PORTABLE_VOICE_PREPARE.join(" ");

function invoke(action: "prepare" | "synthesise", work: string[] = []) {
  const args = pythonArgs(profile, [worker, action, modelsRoot(), ...work]);
  if (action === "synthesise") args.splice(1, 0, "--offline", "--no-sync");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      /^(PATH|HOME|USERPROFILE|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|LOCALAPPDATA|UV_CACHE_DIR|UV_PYTHON_INSTALL_DIR|HTTPS_PROXY|HTTP_PROXY|NO_PROXY|SSL_CERT_FILE)$/i.test(
        name,
      ),
    ),
  );
  if (action === "synthesise") for (const key of Object.keys(env)) if (/proxy/i.test(key)) delete env[key];
  const proc = spawnSync(pythonUv(), args, {
    env: pythonEnvironment(profile, env),
    timeout: 10 * 60_000,
    encoding: "utf8",
    maxBuffer: 24 * 1024 * 1024,
    windowsHide: true,
  });
  if (proc.status !== 0 || proc.error)
    throw new CliErrorObject({
      code: proc.error && (proc.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? "TIMEOUT" : "STAGE_INCOMPLETE",
      message: `Portable voice ${action} failed. ${action === "synthesise" ? `Prepare it via ${prepareCommand}. ` : ""}${proc.error?.message ?? proc.stderr?.trim().slice(-550) ?? ""}`,
    });
  return JSON.parse(proc.stdout) as unknown;
}

export function preparePortableVoice(dryRun: boolean) {
  const modelPins = models.map(({ name, sha256, bytes }) => ({ name, sha256, bytes }));
  if (!dryRun) {
    mkdirSync(voiceCache(), { recursive: true });
    const release = acquireLock(path.join(voiceCache(), "prepare.lock"));
    if (!release)
      throw new CliErrorObject({ code: "VALIDATION", message: "Portable voice preparation is already running" });
    try {
      emitProgress(
        `Preparing pinned portable voice models (${modelPins.reduce((sum, model) => sum + model.bytes, 0)} bytes of models if absent)`,
      );
      invoke("prepare");
    } finally {
      release();
    }
  }
  return { metadata: { dryRun, modelPins, apiCalls: 0 } };
}

type Options = {
  input: string;
  output: string;
  language?: string;
  voice?: string;
  dryRun: boolean;
  force: boolean;
  purpose: "draft" | "production";
  qualificationRoot?: string;
};

export function runPortableVoice(options: Options) {
  const input = realpathSync(path.resolve(options.input));
  const bytes = boundedFile(input);
  const sourceHash = digest(bytes);
  const request = LocalTextRequestSchema.parse(JSON.parse(bytes.toString("utf8")));
  const language = portableLanguage(options.language ?? request.sourceLanguage)!;
  const voice = options.voice ?? "supertonic:0";
  const match = PORTABLE_VOICE_ID.exec(voice);
  if (!PORTABLE_VOICE_LANGUAGES.includes(language) || !match)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Portable voice supports en and ru with voice IDs supertonic:0 through supertonic:9",
    });
  const units = request.units.filter((unit) => unit.text.trim());
  if (!units.length || units.some((unit) => unit.text.length > 1200))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Provide speech units of at most 1200 characters each",
    });
  const output = path.resolve(options.output);
  const receiptFile = output + ".receipt.json";
  if (!output.endsWith(".json")) throw new Error("Local result output must end in .json");
  const identity = portableVoiceIdentity(voice);
  const quality = qualification(
    "speech.synthesise",
    language,
    identity,
    options.qualificationRoot ?? localRoot(),
    Date.now(),
  );
  const requestHash = objectHash({ sourceHash, language, voice, purpose: options.purpose });
  const operationId = objectHash({ identity, requestHash });
  if (options.dryRun)
    return {
      metadata: {
        dryRun: true,
        language,
        voice,
        backend,
        operationId,
        units: units.length,
        prepare: prepareCommand,
        quality,
        apiCalls: 0,
      },
    };
  const base = path.dirname(output);
  if (options.purpose === "production" && quality !== "qualified")
    throw new CliErrorObject({
      code: "STAGE_INCOMPLETE",
      message: "Production needs a fresh local:verify quality qualification for this voice and language",
    });
  mkdirSync(base, { recursive: true });
  if (realpathSync(base) !== base) throw new Error("Voice output ancestors must not be aliases");
  if ([output, receiptFile].includes(input) || input.startsWith(output + ".assets" + path.sep))
    throw new Error("Voice output must not replace or contain its input");
  for (const file of [output, receiptFile, output + ".assets", output + ".lock"]) assertPathWithin(base, file);
  const release = acquireLock(output + ".lock");
  if (!release)
    throw new CliErrorObject({ code: "VALIDATION", message: "This voice result already has a running writer" });
  try {
    if (!options.force && (existsSync(output) || existsSync(receiptFile)))
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "Voice output already exists. Choose a new path or explicitly pass --force.",
      });
    const assets = path.join(output + ".assets", `${operationId}-${randomUUID()}`);
    const scratch = mkdtempSync(path.join(base, ".voice-"));
    try {
      const cacheHits = new Map<string, { row: Row; wav: string }>();
      const cacheKey = (text: string) =>
        path.join(voiceCache(), "takes", objectHash({ identity, language, voice, text }));
      const pending = units.filter((unit) => {
        const directory = cacheKey(unit.text);
        try {
          const cached = CacheEntry.parse(
            JSON.parse(boundedFile(path.join(directory, "readback.json")).toString("utf8")),
          );
          const wav = path.join(directory, "take.wav");
          if (fileHash(wav) !== cached.sha256) return true;
          cacheHits.set(unit.id, { row: { ...cached.row, id: unit.id }, wav });
          return false;
        } catch {
          return true;
        }
      });
      const rows = new Map<string, Row>();
      if (pending.length) {
        const requestFile = path.join(scratch, "request.json");
        writeFileSync(requestFile, JSON.stringify({ language, speaker: Number(match[1]), units: pending }), {
          flag: "wx",
        });
        const result = z.array(Row).parse(invoke("synthesise", [requestFile, scratch]));
        if (result.length !== pending.length || result.some((row, index) => row.id !== pending[index]!.id))
          throw new Error("Portable voice returned a different set of units");
        for (const row of result) rows.set(row.id, row);
      }
      mkdirSync(assets, { recursive: true });
      const binary: string[] = [];
      const result = units.map((unit) => {
        const hit = cacheHits.get(unit.id);
        const row = hit?.row ?? rows.get(unit.id)!;
        const file = path.join(assets, unit.id + ".wav");
        copyFileSync(hit?.wav ?? path.join(scratch, unit.id + ".wav"), file);
        const audioChecks = checkVoiceAudio(file);
        if (audioChecks.clippingRisk && options.purpose === "production") throw new Error("Production take clips");
        const report = path.join(assets, unit.id + ".readback.json");
        atomicJson(report, {
          expected: unit.text,
          heard: row.heard,
          matched: row.matched,
          method: "parakeet-v3-token-estimates",
        });
        binary.push(file, report);
        if (row.matched) {
          const words = path.join(assets, unit.id + ".words.json");
          atomicJson(words, { words: row.words, timing: "estimated", method: "parakeet-v3-token-estimates" });
          binary.push(words);
        }
        if (!hit) {
          const target = cacheKey(unit.text);
          if (!existsSync(target)) {
            mkdirSync(path.dirname(target), { recursive: true });
            const temporary = mkdtempSync(path.join(path.dirname(target), ".take-"));
            try {
              copyFileSync(file, path.join(temporary, "take.wav"));
              atomicJson(path.join(temporary, "readback.json"), { row, sha256: fileHash(file) });
              try {
                renameSync(temporary, target);
              } catch (error) {
                if (!existsSync(target)) throw error;
              }
            } finally {
              rmSync(temporary, { recursive: true, force: true });
            }
          }
        }
        return {
          id: unit.id,
          file,
          voice,
          language,
          durationSec: row.durationSec,
          sampleRate: row.sampleRate,
          readbackMatched: row.matched,
          audioChecks,
          sourceTextHash: digest(unit.text),
        };
      });
      if (fileHash(input) !== sourceHash) throw new Error("Voice source changed during processing");
      if (portableVoiceIdentity(voice) !== identity) throw new Error("Voice runtime changed during processing");
      const unmatched = result.filter((unit) => !unit.readbackMatched).map((unit) => unit.id);
      if (unmatched.length && options.purpose === "production")
        throw new CliErrorObject({
          code: "VALIDATION",
          message: `Production readback differs for ${unmatched.join(", ")}. Review the draft report and retake before publishing.`,
        });
      const warnings = [
        "Timings are recogniser estimates. Listen to and review each take.",
        ...unmatched.map((id) => `Readback differed for ${id}; no word timings were published for this take.`),
      ];
      const artifact =
        JSON.stringify({
          version: 1,
          task: "speech.synthesise",
          operationId,
          purpose: options.purpose,
          source: { file: input, sha256: sourceHash },
          result: { units: result, voice, language, reviewRequired: true },
        }) + "\n";
      const receipt = LocalResultReceiptSchema.parse({
        version: 1,
        task: "speech.synthesise",
        backend,
        operationId,
        createdAt: new Date().toISOString(),
        identity,
        systemModelsHashPinned: false,
        modelPins: models.map(({ name, sha256 }) => ({ name, sha256 })),
        requestHash,
        inputs: [{ file: input, sha256: sourceHash }],
        outputs: [
          { file: output, sha256: digest(artifact) },
          ...binary.map((file) => ({ file, sha256: fileHash(file) })),
        ],
        purpose: options.purpose,
        checks: ["source-unchanged", "pinned-portable-models", "word-clock", "output-hashes"],
        warnings,
      });
      atomicJson(path.join(assets, "receipt.json"), receipt);
      publishResult(output, artifact, receiptFile, receipt);
      return {
        outputs: [output, receiptFile, ...binary],
        metadata: {
          backend,
          cacheHits: cacheHits.size,
          rendered: pending.length,
          unmatched,
          receipt: receiptFile,
          apiCalls: 0,
          warnings,
        },
      };
    } catch (error) {
      rmSync(assets, { recursive: true, force: true });
      throw error;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  } finally {
    release();
  }
}
