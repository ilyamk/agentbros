import { spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  unlinkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AppleWordsSchema,
  LocalResultReceiptSchema,
  LocalTextRequestSchema,
  type LocalTask,
  type LocalPolicy,
  type LocalResultReceipt,
} from "../../types/local-capabilities";
import {
  AppleAssistanceResultSchema,
  AppleAudioResultSchema,
  AppleTextResultSchema,
  AppleTranslationResultSchema,
  AppleTtsResultSchema,
  AppleVisionResultSchema,
} from "../../types/apple-results";
import {
  inspectCapabilities,
  LOCAL_CAPABILITIES,
  readLocalPolicy,
  resolveLocalTask,
  languageEquivalent,
} from "../local-capabilities";
import { CliErrorObject } from "../cli";
import { receiptForLocalAsset } from "./provenance";
import { subtitleText } from "../captions/delivery";
import { inspectAsset } from "../assets/inspect";
import {
  atomicJson,
  boundedFile,
  digest,
  fileHash,
  invokeNative,
  localRoot,
  NativeUnavailable,
  objectHash,
  prepareApple,
  probeNative,
} from "./runtime";

export async function ensureApple(
  task: LocalTask,
  language?: string,
  options: {
    targetLanguage?: string;
    voice?: string;
    root?: string;
    policy?: LocalPolicy;
    purpose?: "draft" | "production";
    assistTask?: "summarise" | "tags" | "chapters" | "shot-notes";
  } = {},
) {
  const request = {
    task,
    language,
    assistTask: options.assistTask,
    operations: (options as { operations?: ("language" | "sentences" | "tokens" | "entities" | "lemmas")[] })
      .operations,
    targetLanguage: options.targetLanguage,
    voice: options.voice,
    purpose: options.purpose ?? ("draft" as const),
  };
  const policy = options.policy ?? readLocalPolicy(options.root);
  let status = (await inspectCapabilities([request], { root: options.root, refresh: true }))[0]!;
  if (status.state === "needs_prepare" || status.state === "needs_download") {
    const domain = LOCAL_CAPABILITIES.find((d) => d.task === task)?.domain;
    if (domain) {
      await prepareApple(domain, { root: options.root, language, downloads: policy.downloads });
      status = (await inspectCapabilities([request], { root: options.root, refresh: true }))[0]!;
    }
  }
  if (status.state !== "ready")
    throw new NativeUnavailable({
      state: status.state,
      code: "CAPABILITY_UNAVAILABLE",
      message: status.reason,
      ...(status.userAction ? { userAction: status.userAction } : {}),
    });
  return status;
}
export async function appleSpeechWords(file: string, language: string, root?: string) {
  await ensureApple("speech.transcribe", language, { root });
  const raw = AppleWordsSchema.parse(
    await invokeNative("speech", "run", { file: path.resolve(file), language }, { root }),
  );
  const duration = inspectAsset(file).media.durationSec;
  if (
    !duration ||
    raw.words.some((w) => w.endSec > duration + 0.05) ||
    raw.words.some((w, i) => i > 0 && w.startSec < raw.words[i - 1]!.startSec)
  )
    throw new Error("Apple speech returned invalid source-clock word times");
  return raw;
}
const features = z
  .array(z.enum(["faces", "people", "pose", "saliency", "quality", "flow", "tracking"]))
  .min(1)
  .max(7);
export type AppleTaskOptions = {
  task: LocalTask;
  input: string;
  output: string;
  language?: string;
  targetLanguage?: string;
  voice?: string;
  features?: string[];
  operations?: string[];
  assistTask?: "summarise" | "tags" | "chapters" | "shot-notes";
  purpose?: "draft" | "production";
  root?: string;
  dryRun?: boolean;
  force?: boolean;
  policy?: LocalPolicy;
};
function ffmpeg(args: string[]) {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", ...args], {
    encoding: "utf8",
    timeout: 600000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0)
    throw new CliErrorObject({
      code: result.error && "code" in result.error && result.error.code === "ENOENT" ? "FFMPEG_MISSING" : "VALIDATION",
      message: result.error?.message ?? result.stderr.slice(-1000),
    });
}
export function installedVoice(language: string | undefined, voices: { id: string; language: string }[]) {
  const rank = (id: string) => (id.includes(".voice.compact.") ? 0 : id.includes(".voice.super-compact.") ? 1 : 2);
  return voices
    .filter((v) => !language || languageEquivalent(language, v.language))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id))[0]?.id;
}
export function checkVoiceAudio(file: string) {
  const check = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-nostdin", "-i", file, "-af", "astats=metadata=1:reset=0", "-f", "null", "-"],
    { encoding: "utf8", timeout: 600000, maxBuffer: 1024 * 1024 },
  );
  if (check.status !== 0) throw new Error("Cannot measure synthesised audio");
  const field = (name: string) =>
    Number([...check.stderr.matchAll(new RegExp(name + ": ([^\\s]+)", "gu"))].at(-1)?.[1]);
  const peakDb = field("Peak level dB"),
    rmsDb = field("RMS level dB");
  if (!Number.isFinite(peakDb) || !Number.isFinite(rmsDb) || rmsDb < -80)
    throw new Error("Synthesised audio is silent or has invalid levels");
  return { peakDb, rmsDb, clippingRisk: peakDb >= 0 };
}
function assertNewOutput(file: string, force = false) {
  if (existsSync(file) && !force) throw new CliErrorObject({ code: "FILE_EXISTS", message: `Output exists: ${file}` });
  let parent = path.dirname(file);
  while (!existsSync(parent)) parent = path.dirname(parent);
  if (realpathSync(parent) !== parent) throw new Error("Output ancestors must not be aliases");
}
function sameIds(before: readonly { id: string }[], after: readonly { id: string }[]) {
  if (before.length !== after.length || after.some((u, i) => u.id !== before[i]?.id))
    throw new Error("Native output changed, duplicated or invented source IDs");
}
function canonicalDestination(file: string): string {
  return existsSync(file)
    ? realpathSync(file)
    : path.join(canonicalDestination(path.dirname(file)), path.basename(file));
}
export async function runAppleTask(options: AppleTaskOptions) {
  const requestedInput = path.resolve(options.input),
    sourceHash = fileHash(requestedInput, 32 * 1024 ** 3);
  const input = realpathSync(requestedInput),
    output = path.resolve(options.output),
    receiptFile = output + ".receipt.json";
  const canonicalOutput = canonicalDestination(output),
    canonicalReceipt = canonicalDestination(receiptFile);
  if ([canonicalOutput, canonicalReceipt].includes(input) || input.startsWith(canonicalOutput + ".assets" + path.sep))
    throw new Error("Outputs must not replace or contain the immutable input");
  if (["text.translate", "speech.synthesise", "text.assist"].includes(options.task)) {
    const sourceRequest = LocalTextRequestSchema.parse(JSON.parse(boundedFile(input).toString()));
    options = {
      ...options,
      language: options.language ?? sourceRequest.sourceLanguage,
      targetLanguage: options.targetLanguage ?? sourceRequest.targetLanguage,
    };
  }
  if (!output.endsWith(".json"))
    throw new Error("Local result output must end in .json so its asset provenance can be resolved");
  const descriptor = LOCAL_CAPABILITIES.find((c) => c.task === options.task);
  if (!descriptor?.domain) throw new Error("This command needs a dedicated Apple task");
  if (options.dryRun)
    return {
      outputs: [],
      metadata: {
        dryRun: true,
        task: options.task,
        ...(await resolveLocalTask(
          {
            task: options.task,
            language: options.language,
            targetLanguage: options.targetLanguage,
            voice: options.voice,
            assistTask: options.assistTask,
            operations: options.operations as
              ("language" | "sentences" | "tokens" | "entities" | "lemmas")[] | undefined,
            purpose: options.purpose,
          },
          { root: options.root },
        )),
      },
    };
  const purpose = options.purpose ?? "draft";
  if (options.task === "speech.synthesise" && !options.voice) {
    await ensureApple(options.task, options.language, { ...options, purpose: "draft" });
    const inventory = await probeNative("tts", {}, options.root);
    const voice = installedVoice(options.language, inventory.probe.voices ?? []);
    if (!voice) throw new Error("No installed voice matches the requested language");
    options = { ...options, voice };
  }
  const status = await ensureApple(options.task, options.language, { ...options, purpose });
  const identity = status.identity!,
    requestHash = objectHash({
      task: options.task,
      sourceHash,
      language: options.language,
      targetLanguage: options.targetLanguage,
      voice: options.voice,
      features: options.features,
      operations: options.operations,
      assistTask: options.assistTask,
      purpose,
    });
  const operationId = objectHash({ requestHash, identity });
  if (!options.force && existsSync(output) && existsSync(receiptFile)) {
    const old = LocalResultReceiptSchema.parse(JSON.parse(boundedFile(receiptFile).toString()));
    if (
      old.operationId === operationId &&
      old.outputs.every((pin) => existsSync(pin.file) && fileHash(pin.file) === pin.sha256)
    )
      return {
        outputs: [output, receiptFile, ...old.outputs.filter((pin) => pin.file !== output).map((pin) => pin.file)],
        metadata: {
          task: options.task,
          operationId,
          purpose,
          apiCalls: 0,
          receipt: receiptFile,
          warnings: old.warnings,
          cacheHit: true,
        },
      };
  }
  assertNewOutput(output, options.force);
  assertNewOutput(receiptFile, options.force);

  mkdirSync(path.dirname(output), { recursive: true });
  const lock = output + ".lock";
  let lockFd: number;
  try {
    lockFd = openSync(lock, "wx", 0o600);
    writeFileSync(lockFd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  } catch {
    throw new CliErrorObject({
      code: "TIMEOUT",
      message: "Result is locked by another operation; retry after it finishes",
    });
  }
  let work: string | undefined;
  const binaryOutputs: string[] = [];
  const assets = `${output}.assets/${operationId}-${randomUUID()}`;
  const warnings = ["System-managed Apple model weights are not individually hash-pinned."];
  let result: unknown;
  try {
    work = mkdtempSync(path.join(tmpdir(), "avc-apple-"));
    assertNewOutput(path.join(assets, "placeholder"));
    assertNewOutput(output, options.force);
    assertNewOutput(receiptFile, options.force);
    if (options.task === "text.analyse") {
      const text = boundedFile(input).toString("utf8");
      if (text.length > 200000) throw new Error("Text exceeds 200,000 UTF-16 units");
      const operations = z
        .array(z.enum(["language", "sentences", "tokens", "entities", "lemmas"]))
        .parse(options.operations ?? ["language", "sentences", "tokens", "entities", "lemmas"]);
      const raw = AppleTextResultSchema.parse(
        await invokeNative("text", "run", { text, language: options.language, operations }, { root: options.root }),
      );
      if (
        raw.items.some(
          (r) =>
            r.startUtf16 + r.lengthUtf16 > text.length ||
            text.slice(r.startUtf16, r.startUtf16 + r.lengthUtf16) !== r.text,
        )
      )
        throw new Error("Text result has invalid UTF-16 source spans");
      result = raw;
    } else if (options.task === "text.translate") {
      const request = LocalTextRequestSchema.parse(JSON.parse(boundedFile(input).toString()));
      const language = options.language ?? request.sourceLanguage,
        targetLanguage = options.targetLanguage ?? request.targetLanguage;
      if (!targetLanguage) throw new Error("Translation target language required");
      await ensureApple("text.translate", language, { ...options, targetLanguage, purpose });
      const translated: { id: string; text: string }[] = [];
      for (const unit of request.units) {
        const raw = AppleTranslationResultSchema.parse(
          await invokeNative("translation", "run", { language, targetLanguage, units: [unit] }, { root: options.root }),
        );
        sameIds([unit], raw.units);
        translated.push(...raw.units);
        for (const term of request.protectedTerms)
          if (unit.text.includes(term) && !raw.units[0]!.text.includes(term))
            throw new Error(`Protected term changed: ${term}`);
        const numbers = unit.text.match(/\d+(?:[.,]\d+)*/gu) ?? [];
        if (numbers.some((n) => !raw.units[0]!.text.includes(n)))
          throw new Error(`Translation changed a number in ${unit.id}`);
      }
      result = {
        ...request,
        sourceLanguage: language,
        targetLanguage,
        units: translated.map((unit, i) => ({ ...request.units[i], ...unit })),
        timing: "source-cue-only",
        wordTiming: null,
        reviewRequired: true,
      };
      if (request.kind === "captions") {
        if (request.units.some((u) => u.startMs === undefined || u.endMs === undefined))
          throw new Error("Caption translation requires original cue intervals");
        mkdirSync(assets, { recursive: true });
        const cues = translated.map((unit, i) => ({
          id: unit.id,
          lines: [unit.text],
          text: unit.text,
          startMs: request.units[i]!.startMs!,
          endMs: request.units[i]!.endMs!,
          wordIds: [] as string[],
        }));
        for (const format of ["srt", "vtt"] as const) {
          const file = path.join(assets, `translated.${format}`);
          writeFileSync(file, subtitleText(cues, format), { flag: "wx" });
          binaryOutputs.push(file);
        }
      }
      warnings.push(
        "Translated cues retain source intervals only; new speech requires fresh alignment and localisation review.",
      );
    } else if (options.task === "speech.synthesise") {
      const request = LocalTextRequestSchema.parse(JSON.parse(boundedFile(input).toString()));
      const language = options.language ?? request.sourceLanguage;
      const probe = await probeNative("tts", {}, options.root);
      const voice = options.voice ?? installedVoice(language, probe.probe.voices ?? []);
      if (!voice) throw new Error("No installed voice matches the requested language");
      await ensureApple("speech.synthesise", language, { ...options, voice, purpose });
      mkdirSync(assets, { recursive: true });
      const units: Record<string, unknown>[] = [];
      for (const unit of request.units) {
        if (!unit.text.trim()) continue;
        const wav = path.join(work, unit.id + ".caf"),
          mp3 = path.join(work, unit.id + ".mp3"),
          destination = path.join(assets, unit.id + ".mp3");
        assertNewOutput(destination, options.force);
        const native = AppleTtsResultSchema.parse(
          await invokeNative("tts", "run", { text: unit.text, voice, output: wav }, { root: options.root }),
        );
        ffmpeg(["-i", wav, "-c:a", "libmp3lame", "-b:a", "192k", mp3]);
        const measured = inspectAsset(mp3);
        if (!measured.media.hasAudio || !measured.media.durationSec || measured.media.durationSec <= 0)
          throw new Error("Synthesised audio failed decoding/duration checks");
        const audioChecks = checkVoiceAudio(mp3);
        if (audioChecks.clippingRisk && purpose === "production")
          throw new Error("Synthesised production audio has clipping risk");
        if (audioChecks.clippingRisk)
          warnings.push(`Clipping risk in ${unit.id}; repair and recheck the mix before production.`);
        copyFileSync(mp3, destination);
        binaryOutputs.push(destination);
        units.push({ id: unit.id, file: destination, ...native, audioChecks, sourceTextHash: digest(unit.text) });
      }
      if (!units.length) throw new Error("No nonempty speech units");
      result = { units, voice, language, reviewRequired: true };
      warnings.push("The user judges voice and performance; this command makes no listening judgement.");
    } else if (options.task === "audio.events") {
      const media = inspectAsset(input);
      if (!media.media.hasAudio || !media.media.durationSec || media.media.durationSec > 7200)
        throw new Error("Audio events need an audio stream of at most two hours");
      const wav = path.join(work, "audio.wav");
      ffmpeg(["-i", input, "-vn", "-af", "aresample=async=1:first_pts=0", "-c:a", "pcm_s16le", wav]);
      const raw = AppleAudioResultSchema.parse(
        await invokeNative("audio", "run", { file: wav }, { root: options.root }),
      );
      if (raw.events.some((e) => e.endSec > media.media.durationSec! + raw.windowSec || !raw.labels.includes(e.label)))
        throw new Error("Audio event clock or taxonomy mismatch");
      result = raw;
    } else if (options.task.startsWith("vision.")) {
      const chosen = features.parse(options.features ?? [options.task.slice(7)]);
      for (const feature of chosen) await ensureApple(`vision.${feature}` as LocalTask, undefined, options);
      const media = inspectAsset(input),
        frames: { id: string; file: string; flowOutput?: string }[] = [];
      if (media.kind === "image") frames.push({ id: "frame-0", file: input });
      else {
        if (!media.media.width || !media.media.durationSec || media.media.durationSec > 7200)
          throw new Error("Video input of at most two hours required");
        ffmpeg([
          "-i",
          input,
          "-vf",
          "fps=1,scale=1280:1280:force_original_aspect_ratio=decrease",
          "-frames:v",
          "32",
          path.join(work, "frame-%03d.png"),
        ]);
        for (let i = 1; i <= 32; i++) {
          const file = path.join(work, `frame-${String(i).padStart(3, "0")}.png`);
          if (existsSync(file)) frames.push({ id: `sample-${i - 1}`, file });
        }
        warnings.push(
          "Sampled video observations are advisory; use supplied decoded-frame requests for exact crop tracking.",
        );
      }
      if (chosen.includes("flow") && frames.length < 2) throw new Error("Optical flow needs at least two frames");
      if (chosen.includes("flow")) {
        mkdirSync(assets, { recursive: true });
        for (const frame of frames.slice(1)) {
          frame.flowOutput = path.join(assets, frame.id + ".f32");
          assertNewOutput(frame.flowOutput, false);
        }
      }
      const raw = AppleVisionResultSchema.parse(
        await invokeNative("vision", "run", { frames, features: chosen }, { root: options.root }),
      );
      sameIds(frames, raw.frames);
      for (const frame of raw.frames)
        if (frame.flow) {
          const planned = frames.find((f) => f.id === frame.id)?.flowOutput;
          if (frame.flow.file !== planned) throw new Error("Unexpected flow output");
          const bytes = boundedFile(frame.flow.file, 32 * 1024 * 1024);
          if (bytes.length !== frame.flow.width * frame.flow.height * 8)
            throw new Error("Flow dimensions/bytes disagree");
          for (let n = 0; n < bytes.length; n += 4)
            if (!Number.isFinite(bytes.readFloatLE(n))) throw new Error("Nonfinite flow");
          binaryOutputs.push(frame.flow.file);
        }
      result = raw;
    } else if (options.task === "text.assist" || options.task === "image.describe") {
      const rows: z.infer<typeof AppleAssistanceResultSchema>["items"] = [];
      if (options.task === "image.describe") {
        const media = inspectAsset(input);
        if (media.kind !== "image" || (media.media.width ?? 0) * (media.media.height ?? 0) > 4000000)
          throw new Error("A bounded image is required");
        const raw = AppleAssistanceResultSchema.parse(
          await invokeNative(
            "foundation",
            "run",
            { file: input, language: options.language, task: "describe" },
            { root: options.root },
          ),
        );
        sameIds(
          [{ id: "image" }],
          raw.items.map((u) => ({ id: u.sourceId })),
        );
        rows.push(...raw.items);
      } else {
        const request = LocalTextRequestSchema.parse(JSON.parse(boundedFile(input).toString()));
        for (const unit of request.units) {
          // One bounded source unit per generation preserves IDs and prevents hidden truncation.
          const raw = AppleAssistanceResultSchema.parse(
            await invokeNative(
              "foundation",
              "run",
              {
                text: JSON.stringify({ sourceId: unit.id, text: unit.text }),
                language: options.language ?? request.sourceLanguage,
                task: options.assistTask ?? "summarise",
              },
              { root: options.root },
            ),
          );
          sameIds(
            [unit],
            raw.items.map((u) => ({ id: u.sourceId })),
          );
          rows.push(...raw.items);
        }
      }
      result = { items: rows, advisory: true, reviewRequired: true };
    } else throw new Error("Use the dedicated speech:local command for transcription");
    if (fileHash(input, 32 * 1024 ** 3) !== sourceHash) throw new Error("Source changed during native processing");
    const after = await inspectCapabilities(
      [
        {
          task: options.task,
          language: options.language,
          voice: options.voice,
          assistTask: options.assistTask,
          operations: options.operations as ("language" | "sentences" | "tokens" | "entities" | "lemmas")[] | undefined,
          targetLanguage: options.targetLanguage,
          purpose,
        },
      ],
      { root: options.root, refresh: true },
    );
    if (after[0]?.identity !== identity) throw new Error("Native runtime identity changed during processing");
    const artifact = {
      version: 1,
      task: options.task,
      operationId,
      purpose,
      source: { file: input, sha256: sourceHash },
      result,
    };
    const bytes = JSON.stringify(artifact) + "\n";
    if (Buffer.byteLength(bytes) > 16 * 1024 * 1024) throw new Error("Result exceeds 16 MiB");
    const receipt: LocalResultReceipt = LocalResultReceiptSchema.parse({
      version: 1,
      task: options.task,
      backend: status.backend,
      operationId,
      createdAt: new Date().toISOString(),
      identity,
      systemModelsHashPinned: false,
      requestHash,
      inputs: [{ file: input, sha256: sourceHash }],
      outputs: [
        { file: output, sha256: digest(bytes) },
        ...binaryOutputs.map((file) => ({ file, sha256: fileHash(file) })),
      ],
      purpose,
      checks: ["strict-native-result", "source-unchanged", "runtime-unchanged", "output-hashes"],
      warnings,
    });
    if (binaryOutputs.length) atomicJson(path.join(assets, "receipt.json"), receipt);
    publishResult(output, bytes, receiptFile, receipt);

    return {
      outputs: [output, receiptFile, ...binaryOutputs],
      metadata: { task: options.task, operationId, purpose, apiCalls: 0, receipt: receiptFile, warnings },
    };
  } catch (error) {
    rmSync(assets, { recursive: true, force: true });
    throw error;
  } finally {
    if (work) rmSync(work, { recursive: true, force: true });
    closeSync(lockFd);
    unlinkSync(lock);
  }
}
export function assertNoDraftLocalAssets(files: readonly string[]) {
  for (const file of files) {
    const receiptFile = receiptForLocalAsset(file);
    if (!receiptFile) continue;
    if (!existsSync(receiptFile)) throw new Error("Local generated asset has no provenance receipt");
    const receipt = LocalResultReceiptSchema.parse(JSON.parse(boundedFile(receiptFile).toString()));
    if (receipt.purpose === "draft")
      throw new Error("Draft local assets are preview-only and cannot be delivered as production-ready");
    const pin = receipt.outputs.find((o) => path.resolve(o.file) === path.resolve(file));
    if (!pin || fileHash(file) !== pin.sha256) throw new Error("Local asset provenance changed");
  }
}

export function publishResult(output: string, bytes: string, receiptFile: string, receipt: LocalResultReceipt) {
  const nonce = randomUUID();
  const rows = [
    { file: output, text: bytes },
    { file: receiptFile, text: JSON.stringify(receipt) + "\n" },
  ].map((row) => ({
    ...row,
    temporary: `${row.file}.${nonce}.tmp`,
    backup: `${row.file}.${nonce}.backup`,
    existed: existsSync(row.file),
    published: false,
  }));
  try {
    for (const row of rows) {
      mkdirSync(path.dirname(row.file), { recursive: true });
      writeFileSync(row.temporary, row.text, { flag: "wx", mode: 0o600 });
    }
    for (const row of rows) {
      if (row.existed) renameSync(row.file, row.backup);
      renameSync(row.temporary, row.file);
      row.published = true;
    }
  } catch (error) {
    for (const row of rows.slice().reverse()) {
      if (row.published) rmSync(row.file, { force: true });
      if (existsSync(row.backup)) renameSync(row.backup, row.file);
    }
    throw error;
  } finally {
    for (const row of rows) {
      rmSync(row.temporary, { force: true });
      rmSync(row.backup, { force: true });
    }
  }
}
