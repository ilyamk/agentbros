import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { boundedEvidenceHash, boundedEvidenceJson } from "./bounded-evidence";
import { assertPathWithin, requireProject } from "../cli";
import { stableHash } from "../longform/plans";
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  MAX_RAW = 16 * 1024 * 1024,
  MAX_RECEIPT = 1024 * 1024;
export const RejectedBindingSchema = z
  .object({
    manifestFile: z.string().min(1),
    manifestSha256: hash,
    corpusKey: hash,
    entryId: z.string().min(1).max(128),
    originalSha256: hash,
    inputSha256: hash,
  })
  .strict();
export const RejectedObserverOptionsSchema = z
  .object({ method: z.literal("quarantined-worker-output-v1"), binding: RejectedBindingSchema })
  .strict();
export type RejectedObserverOptions = z.infer<typeof RejectedObserverOptionsSchema>;
type Binding = z.infer<typeof RejectedBindingSchema>;
const PayloadSchema = z
  .object({
    operation: z.literal("asr"),
    sourceFile: z.string(),
    sourceHash: hash,
    durationSec: z.number().finite().positive().max(7200),
  })
  .strict();
const moduleFile = fileURLToPath(import.meta.url);
function noLinks(file: string) {
  for (let p = path.resolve(file); ; p = path.dirname(p)) {
    if (existsSync(p) && lstatSync(p).isSymbolicLink())
      throw new Error("Rejected observation cannot traverse symlinks");
    if (path.dirname(p) === p) break;
  }
}
function json(file: string, maximum = MAX_RECEIPT) {
  noLinks(file);
  return boundedEvidenceJson(file, maximum);
}
function capturedHash(file: string, maximum = 32 * 1024 ** 3) {
  noLinks(file);
  return boundedEvidenceHash(file, maximum);
}
/** A reviewed receipt binds data only; no path in it is ever executed. */
function verifyBinding(binding: Binding, payload: z.infer<typeof PayloadSchema>) {
  if (!path.isAbsolute(binding.manifestFile) || !path.isAbsolute(payload.sourceFile))
    throw new Error("Rejected observation needs absolute manifest/source paths");
  const captured = json(binding.manifestFile);
  if (captured.hash !== binding.manifestSha256) throw new Error("Rejected observation manifest checksum changed");
  const manifest = z
    .object({
      version: z.literal(1),
      key: hash,
      entries: z
        .array(
          z
            .object({
              id: z.string(),
              original: z.object({ sha256: hash }).passthrough(),
              input: z.object({ path: z.string(), sha256: hash }).passthrough(),
            })
            .passthrough(),
        )
        .max(64),
    })
    .passthrough()
    .parse(captured.value);
  const matches = manifest.entries.filter((e) => e.id === binding.entryId);
  if (manifest.key !== binding.corpusKey || matches.length !== 1)
    throw new Error("Rejected observation corpus entry binding changed");
  const entry = matches[0]!,
    root = path.dirname(path.resolve(binding.manifestFile)),
    source = path.resolve(root, entry.input.path);
  assertPathWithin(root, source);
  if (
    path.isAbsolute(entry.input.path) ||
    source !== path.resolve(payload.sourceFile) ||
    entry.input.sha256 !== binding.inputSha256 ||
    payload.sourceHash !== binding.inputSha256 ||
    entry.original.sha256 !== binding.originalSha256 ||
    capturedHash(source) !== binding.inputSha256
  )
    throw new Error("Rejected observation source/manifest binding changed");
  return captured;
}
function verifyRequestLineage(
  value: unknown,
  workerKey: string,
  payload: z.infer<typeof PayloadSchema>,
  identityHash: string,
  identity: Record<string, unknown>,
) {
  const wire = z
    .object({
      version: z.literal(1),
      key: z.literal(workerKey),
      offline: z.literal(true),
      config: z
        .object({
          engine: z.literal("whisper.cpp"),
          model: z.string(),
          revision: z.string(),
          language: z.string(),
          threads: z.number().int(),
          wordTimingMethod: z.literal("native-word-segments-v1").optional(),
          dimensions: z.number().int().optional(),
        })
        .passthrough(),
      payload: PayloadSchema,
    })
    .strict()
    .parse(value);
  if (
    stableHash(identity) !== identityHash ||
    stableHash({ version: 1, identity: identityHash, payload }) !== workerKey ||
    JSON.stringify(wire.payload) !== JSON.stringify(payload)
  )
    throw new Error("Rejected request/worker identity changed");
  for (const field of ["engine", "model", "revision", "language", "threads", "wordTimingMethod", "dimensions"] as const)
    if (identity[field] !== wire.config[field]) throw new Error("Rejected request config identity changed");
  return wire;
}
export const RejectedObservationReceiptSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("rejected-asr-observation"),
    method: z.literal("quarantined-worker-output-v1"),
    projectId: z.string(),
    accepted: z.literal(false),
    approved: z.literal(false),
    reviewRequired: z.literal(true),
    commercialAllowed: z.literal("unknown"),
    timingUse: z.literal("forbidden"),
    rawKind: z.literal("normalized-worker-envelope-not-full-engine-json"),
    binding: RejectedBindingSchema,
    payload: PayloadSchema,
    workerKey: hash,
    identityHash: hash,
    identity: z.record(z.string(), z.unknown()),
    request: z
      .object({ file: z.literal("request.json"), sha256: hash, bytes: z.number().int().positive().max(MAX_RECEIPT) })
      .strict(),
    observerSha256: hash,
    runnerSha256: hash,
    refusal: z.enum([
      "Native word rows overlap, reverse or exceed original clock",
      "Invalid unavailable native evidence clock",
      "ASR spans overlap or exceed original source clock",
    ]),
    raw: z
      .object({ file: z.literal("raw.json"), sha256: hash, bytes: z.number().int().positive().max(MAX_RAW) })
      .strict(),
  })
  .strict();
export type RejectedObservationDescriptor =
  { state: "quarantined"; file: string; sha256: string; rawSha256: string } | { state: "unavailable"; reason: string };
const descriptors = new WeakMap<object, RejectedObservationDescriptor>();
export function rejectedObservationFor(error: unknown) {
  return error && typeof error === "object" ? descriptors.get(error) : undefined;
}
export function noteRejectedObservationUnavailable(error: Error, reason: string) {
  descriptors.set(error, { state: "unavailable", reason });
}
export function rejectedObservationCodePins(runnerFile: string) {
  return { observerSha256: capturedHash(moduleFile, MAX_RECEIPT), runnerSha256: capturedHash(runnerFile, MAX_RECEIPT) };
}
export function eligibleRejectedClock(message: string) {
  return RejectedObservationReceiptSchema.shape.refusal.safeParse(message).success;
}
export function validateRejectedObserverOptions(options: RejectedObserverOptions, payload: unknown) {
  const parsed = RejectedObserverOptionsSchema.parse(options);
  verifyBinding(parsed.binding, PayloadSchema.parse(payload));
  return parsed;
}
/** Called only after fresh valid-envelope clock rejection and source/runtime rechecks. */
export function retainRejectedObservation(request: {
  projectId: string;
  options: RejectedObserverOptions;
  payload: unknown;
  workerKey: string;
  identityHash: string;
  identity: Record<string, unknown>;
  serializedRequest: string;
  stdout: Buffer;
  error: Error;
  runnerFile: string;
  codePins: { observerSha256: string; runnerSha256: string };
}) {
  requireProject(request.projectId);
  const payload = PayloadSchema.parse(request.payload),
    options = validateRejectedObserverOptions(request.options, payload);
  if (!request.stdout.length || request.stdout.length > MAX_RAW || !eligibleRejectedClock(request.error.message))
    throw new Error("Rejected observation is not eligible");
  if (Buffer.byteLength(request.serializedRequest) > MAX_RECEIPT)
    throw new Error("Rejected request exceeds byte limit");
  verifyRequestLineage(
    JSON.parse(request.serializedRequest),
    request.workerKey,
    payload,
    request.identityHash,
    request.identity,
  );
  const currentPins = rejectedObservationCodePins(request.runnerFile);
  if (
    currentPins.observerSha256 !== request.codePins.observerSha256 ||
    currentPins.runnerSha256 !== request.codePins.runnerSha256
  )
    throw new Error("Observer/runner source changed during rejected inference");
  const reply = z
    .object({ version: z.literal(1), key: z.literal(request.workerKey), offline: z.literal(true), output: z.unknown() })
    .strict()
    .parse(JSON.parse(request.stdout.toString("utf8")));
  const root = path.resolve("public/projects", request.projectId, "pipeline/rejected-analysis");
  noLinks(root);
  mkdirSync(root, { recursive: true });
  const receipt = RejectedObservationReceiptSchema.parse({
    version: 1,
    kind: "rejected-asr-observation",
    method: options.method,
    projectId: request.projectId,
    accepted: false,
    approved: false,
    reviewRequired: true,
    commercialAllowed: "unknown",
    timingUse: "forbidden",
    rawKind: "normalized-worker-envelope-not-full-engine-json",
    binding: options.binding,
    payload,
    workerKey: reply.key,
    identityHash: request.identityHash,
    identity: request.identity,
    request: {
      file: "request.json",
      sha256: sha(request.serializedRequest),
      bytes: Buffer.byteLength(request.serializedRequest),
    },
    observerSha256: request.codePins.observerSha256,
    runnerSha256: request.codePins.runnerSha256,
    refusal: request.error.message,
    raw: { file: "raw.json", sha256: sha(request.stdout), bytes: request.stdout.length },
  });
  const bytes = JSON.stringify(receipt) + "\n";
  if (Buffer.byteLength(bytes) > MAX_RECEIPT) throw new Error("Rejected observation receipt exceeds byte limit");
  const receiptSha = sha(bytes),
    destination = path.join(root, receiptSha),
    file = path.join(destination, "receipt.json");
  noLinks(destination);
  if (existsSync(destination)) {
    readRejectedObservation(request.projectId, file, receiptSha, options.binding);
  } else {
    const stage = mkdtempSync(path.join(root, ".preparing-"));
    try {
      writeFileSync(path.join(stage, "request.json"), request.serializedRequest, { flag: "wx", mode: 0o600 });
      writeFileSync(path.join(stage, "raw.json"), request.stdout, { flag: "wx", mode: 0o600 });
      writeFileSync(path.join(stage, "receipt.json"), bytes, { flag: "wx", mode: 0o600 });
      validateRejectedObserverOptions(options, payload);
      renameSync(stage, destination);
    } finally {
      if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
    }
  }
  readRejectedObservation(request.projectId, file, receiptSha, options.binding);
  const descriptor: RejectedObservationDescriptor = {
    state: "quarantined",
    file,
    sha256: receiptSha,
    rawSha256: receipt.raw.sha256,
  };
  descriptors.set(request.error, descriptor);
  return descriptor;
}
/** Immutable readback is explicitly quarantined; it cannot produce an accepted source index/word proposal. */
export function readRejectedObservation(
  projectId: string,
  file: string,
  expectedSha256: string,
  bindingInput: Binding,
) {
  requireProject(projectId);
  hash.parse(expectedSha256);
  const binding = RejectedBindingSchema.parse(bindingInput),
    root = path.resolve("public/projects", projectId, "pipeline/rejected-analysis");
  assertPathWithin(root, path.resolve(file));
  const captured = json(file);
  if (captured.hash !== expectedSha256) throw new Error("Rejected observation receipt checksum changed");
  const receipt = RejectedObservationReceiptSchema.parse(captured.value);
  if (
    receipt.projectId !== projectId ||
    JSON.stringify(receipt.binding) !== JSON.stringify(binding) ||
    path.basename(path.dirname(file)) !== expectedSha256 ||
    path.basename(file) !== "receipt.json"
  )
    throw new Error("Rejected observation identity/binding changed");
  verifyBinding(binding, receipt.payload);
  if (
    stableHash(receipt.identity) !== receipt.identityHash ||
    stableHash({ version: 1, identity: receipt.identityHash, payload: receipt.payload }) !== receipt.workerKey
  )
    throw new Error("Rejected worker identity/key changed");
  const requestFile = path.join(path.dirname(file), receipt.request.file),
    request = json(requestFile);
  const wire = verifyRequestLineage(
    request.value,
    receipt.workerKey,
    receipt.payload,
    receipt.identityHash,
    receipt.identity,
  );
  if (
    request.hash !== receipt.request.sha256 ||
    lstatSync(requestFile).size !== receipt.request.bytes ||
    JSON.stringify(wire.payload) !== JSON.stringify(receipt.payload)
  )
    throw new Error("Rejected request receipt changed");
  const rawFile = path.join(path.dirname(file), receipt.raw.file),
    raw = json(rawFile, MAX_RAW);
  if (raw.hash !== receipt.raw.sha256 || lstatSync(rawFile).size !== receipt.raw.bytes)
    throw new Error("Rejected observation raw checksum changed");
  const envelope = z
    .object({ version: z.literal(1), key: z.literal(receipt.workerKey), offline: z.literal(true), output: z.unknown() })
    .strict()
    .parse(raw.value);
  const output = z
    .object({ segments: z.array(z.object({ text: z.string().max(10000) }).passthrough()).max(20000) })
    .passthrough()
    .parse(envelope.output);
  const lexicalHypothesis = output.segments.map((s) => s.text).join(" ");
  if (Buffer.byteLength(lexicalHypothesis) > MAX_RAW)
    throw new Error("Rejected lexical observation exceeds byte limit");
  return {
    receipt,
    receiptSha256: captured.hash,
    untrustedEnvelope: envelope,
    lexicalHypothesis,
    timingUse: "forbidden" as const,
    accepted: false as const,
    approved: false as const,
  };
}
