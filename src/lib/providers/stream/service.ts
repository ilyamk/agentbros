import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  unlinkSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { OperationStore } from "../../jobs/store";
import { claimOperationWork } from "../../jobs/work-lease";
import { generationInputHash } from "../../jobs/runner";
import { resolveOperationIdentity } from "../../jobs/identity";
import type { GenerationJob, PriceQuote } from "../../jobs/types";
import { quote } from "../../pricing";
import { resolveImportedReferences } from "../../assets/provider-references";
import { importAsset, hashFile } from "../../assets/registry";
import { inspectAsset } from "../../assets/inspect";
import { CliErrorObject, assertPathWithin, requireProject, requireEnv, ensureFfmpeg } from "../../cli";
import { buildFalOperation, validateFalOperationResult } from "../fal-operations";
import { FalOperationRequestSchema, type FalOperationRequest } from "../../../types/generation";
import {
  createFalHttpStreamTransport,
  consumeFalHttpStream,
  streamLimits,
  type FalHttpStreamTransport,
  type StreamLimits,
} from "./http";
export const MAX_STREAM_INPUT_BYTES = 4 * 1024 * 1024;
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export interface FalHttpStreamOptions {
  request: FalOperationRequest;
  projectId?: string;
  output: string;
  operationId?: string;
  maxCostUsd?: number;
  dryRun?: boolean;
  force?: boolean;
  assetId?: string;
  stage?: string;
  referenceAssetIds?: string[];
  transport?: FalHttpStreamTransport;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  limits?: Partial<StreamLimits>;
}
type Checkpoint = {
  version: 1;
  operationId: string;
  endpoint: string;
  inputHash: string;
  bytes: number;
  events: number;
  complete: boolean;
  contentType?: string;
  providerRequestIdKnown: boolean;
  bodyHash?: string;
  lastEvent?: Record<string, unknown>;
  result?: Record<string, unknown>;
};
function atomic(file: string, bytes: Uint8Array | string) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}
function privateDirectory(store: OperationStore, operationId: string) {
  const root = path.resolve(store.responseCacheDirectory, "streams");
  assertPathWithin(path.resolve(".cache"), root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== root)
    throw new CliErrorObject({ code: "VALIDATION", message: "Stream private cache must not contain symlinks." });
  const relative = path.relative(path.resolve("public"), root);
  if (!relative.startsWith(".." + path.sep))
    throw new CliErrorObject({ code: "VALIDATION", message: "Stream spool cannot be public." });
  const directory = path.join(root, hash(operationId));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink())
    throw new CliErrorObject({ code: "VALIDATION", message: "Stream spool cannot be a symlink." });
  return directory;
}
function boundedFile(file: string, maxBytes: number) {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Stream cached file is not regular or exceeds current byte limits.",
    });
  return info;
}
async function verifyRetainedStream(job: GenerationJob, directory: string, limits: StreamLimits) {
  const checkpointFile = path.join(directory, "checkpoint.json"),
    bodyFile = path.join(directory, "body.bin");
  assertPathWithin(directory, checkpointFile);
  assertPathWithin(directory, bodyFile);
  boundedFile(checkpointFile, limits.totalBytes + limits.eventBytes + 65536);
  boundedFile(bodyFile, limits.totalBytes);
  const checkpoint = JSON.parse(readFileSync(checkpointFile, "utf8")) as Checkpoint;
  if (
    !checkpoint.complete ||
    checkpoint.operationId !== job.operationId ||
    checkpoint.endpoint !== job.endpoint ||
    checkpoint.inputHash !== job.inputHash ||
    checkpoint.bodyHash !== hashFile(bodyFile)
  )
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Retained stream proof does not match complete immutable spool.",
    });
  const controller = new AbortController(),
    raw = readFileSync(bodyFile);
  const replay = await consumeFalHttpStream(
    new Response(raw, { headers: { "content-type": checkpoint.contentType ?? "" } }),
    { limits, controller, signal: controller.signal, onChunk() {}, onEvent() {} },
  );
  const reconstructed = replay.binary
    ? { streamBinary: { file: bodyFile, sha256: checkpoint.bodyHash, contentType: replay.contentType } }
    : validateFalOperationResult(job.endpoint, replay.lastEvent);
  if (!replay.binary && (Object.hasOwn(reconstructed, "streamProof") || Object.hasOwn(reconstructed, "streamBinary")))
    throw new Error("Reserved internal field in retained stream");
  const expected = {
    ...reconstructed,
    streamProof: { bodySha256: checkpoint.bodyHash, complete: true, providerRequestIdKnown: !!job.providerRequestId },
  };
  const { published: _published, ...retained } = job.result ?? {};
  if (
    !checkpoint.result ||
    generationInputHash(expected) !== generationInputHash(retained) ||
    generationInputHash(expected) !== generationInputHash(checkpoint.result)
  )
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Retained stream result differs from original spool evidence.",
    });
}
function boundedQuote(endpoint: string, maxCostUsd?: number): PriceQuote | null {
  if (maxCostUsd !== undefined && (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Stream --max-cost-usd must be positive and finite." });
  const estimate = quote({ model: endpoint, units: 1 });
  if (estimate.bounded && estimate.highUsd !== null && estimate.lowUsd !== null && estimate.expectedUsd !== null) {
    if (maxCostUsd !== undefined && estimate.highUsd > maxCostUsd)
      throw new CliErrorObject({ code: "VALIDATION", message: "Stream quote exceeds explicit planning bound." });
    return {
      ...estimate,
      highUsd: estimate.highUsd,
      lowUsd: estimate.lowUsd,
      expectedUsd: estimate.expectedUsd,
      bounded: true,
      confidence: estimate.confidence === "unknown" ? "conservative-bound" : estimate.confidence,
      notes: estimate.notes ? [estimate.notes] : [],
    };
  }
  return maxCostUsd === undefined
    ? null
    : {
        currency: "USD",
        lowUsd: 0,
        expectedUsd: maxCostUsd,
        highUsd: maxCostUsd,
        bounded: true,
        source: "Explicit stream planning bound; provider billing is not capped",
        asOf: new Date().toISOString(),
        confidence: "user-bound",
        providerEnforced: false,
        model: endpoint,
      };
}
function mediaSources(result: Record<string, unknown>): string[] {
  const rows = result.images ?? [result.image ?? result.output];
  const found = Array.isArray(rows)
    ? rows.flatMap((row) => (row && typeof row === "object" && typeof row.url === "string" ? [row.url as string] : []))
    : [];
  const fallback = result.image_url ?? result.url;
  const sources = found.length ? found : typeof fallback === "string" ? [fallback] : [];
  if (!sources.length || sources.length > 16)
    throw new CliErrorObject({
      code: "VALIDATION",
      message:
        "Final stream event must contain 1–16 image sources; a preview/progress record is not a final media result.",
    });
  return sources;
}
function trustedUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !(
      url.hostname === "fal.media" ||
      url.hostname.endsWith(".fal.media") ||
      url.hostname.endsWith(".fal.ai") ||
      url.hostname === "storage.googleapis.com"
    )
  )
    throw new CliErrorObject({ code: "VALIDATION", message: "Stream media must use a trusted fal HTTPS host." });
  return url;
}
function inlineImage(value: string, maxBytes: number) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0 || match[2].length > Math.ceil(maxBytes / 3) * 4)
    throw new CliErrorObject({ code: "VALIDATION", message: "Invalid or oversized inline image." });
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > maxBytes || bytes.toString("base64") !== match[2])
    throw new CliErrorObject({ code: "VALIDATION", message: "Inline image is not canonical bounded base64." });
  return bytes;
}
async function readBounded(response: Response, max: number, signal: AbortSignal): Promise<Buffer> {
  if (!response.ok || !response.body)
    throw new CliErrorObject({ code: "NETWORK", message: `Stream media download HTTP ${response.status}.` });
  if (signal.aborted) throw new CliErrorObject({ code: "INVALID_INPUT", message: "Stream media download cancelled." });
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const next = await reader.read();
      if (signal.aborted) throw new Error("Stream media download cancelled");
      if (next.done) break;
      size += next.value.length;
      if (size > max) throw new CliErrorObject({ code: "VALIDATION", message: "Stream media download exceeds bound." });
      chunks.push(next.value);
    }
    if (!size) throw new Error("Empty stream image");
    return Buffer.concat(chunks);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
async function publish(
  options: FalHttpStreamOptions,
  store: OperationStore,
  job: GenerationJob,
  directory: string,
  maxBytes: number,
) {
  if (job.state === "published" || job.state === "validated") {
    const published = job.result?.published as { outputs: string[]; hashes: string[] };
    if (!published?.outputs?.length || published.outputs.length !== published.hashes?.length)
      throw new Error("Invalid published stream manifest");
    for (const [index, file] of published.outputs.entries()) {
      assertPathWithin(path.resolve("public/projects", store.projectId), path.resolve(file));
      if (!existsSync(file) || (boundedFile(file, maxBytes), hashFile(file)) !== published.hashes[index])
        throw new CliErrorObject({
          code: "VALIDATION",
          message: "Published stream output missing or changed; never reconnect.",
        });
    }
    return job.state === "validated" ? store.transitionJob(job.operationId, "published") : job;
  }
  if (!job.result) throw new Error("Missing retained stream result");
  if (job.state === "result-ready" || job.state === "failed") job = store.transitionJob(job.operationId, "downloading");
  const retained = job.result!;
  const binary = retained.streamBinary as { file: string; sha256: string; contentType: string } | undefined;
  const sources = binary ? ["binary-cache"] : mediaSources(retained);
  const parsed = path.parse(path.resolve(options.output));
  const outputs: string[] = [],
    hashes: string[] = [],
    assetIds: string[] = [];
  let total = 0;
  const indexFile = path.join(directory, "media-index.json");
  assertPathWithin(directory, indexFile);
  const cachedIndex: Record<string, { sourceHash: string; sha256: string }> = existsSync(indexFile)
    ? JSON.parse(readFileSync(indexFile, "utf8"))
    : {};
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(60000)])
    : AbortSignal.timeout(60000);
  try {
    for (const [index, source] of sources.entries()) {
      const cache = path.join(directory, `media-${index}.bin`);
      assertPathWithin(directory, cache);
      let bytes: Buffer;
      if (binary) {
        assertPathWithin(directory, binary.file);
        if (
          path.resolve(binary.file) !== path.join(directory, "body.bin") ||
          (boundedFile(binary.file, maxBytes), hashFile(binary.file)) !== binary.sha256
        )
          throw new Error("Stream binary cache changed");
        bytes = readFileSync(binary.file);
      } else if (source.startsWith("data:")) bytes = inlineImage(source, maxBytes - total);
      else {
        trustedUrl(source);
        const cached = cachedIndex[String(index)];
        if (existsSync(cache) && cached?.sourceHash === hash(source)) {
          if ((boundedFile(cache, maxBytes - total), hashFile(cache)) !== cached.sha256)
            throw new CliErrorObject({ code: "VALIDATION", message: "Stream media cache checksum changed." });
          bytes = readFileSync(cache);
        } else
          bytes = await readBounded(
            await (options.fetch ?? fetch)(source, { redirect: "error", signal }),
            maxBytes - total,
            signal,
          );
      }
      total += bytes.length;
      if (total > maxBytes) throw new Error("Aggregate stream media exceeds bound");
      atomic(cache, bytes);
      const inspected = inspectAsset(cache);
      if (inspected.kind !== "image")
        throw new CliErrorObject({ code: "VALIDATION", message: "Stream result bytes are not an inspected image." });
      const expectedExtension = (
        { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" } as Record<string, string>
      )[inspected.mime];
      if (
        !expectedExtension ||
        ![expectedExtension, ...(expectedExtension === ".jpg" ? [".jpeg"] : [])].includes(parsed.ext.toLowerCase())
      )
        throw new CliErrorObject({
          code: "VALIDATION",
          message: "Output extension must match inspected stream image bytes.",
        });
      const claimedMime =
        binary?.contentType ?? (source.startsWith("data:") ? source.slice(5, source.indexOf(";")) : undefined);
      if (claimedMime && inspected.mime !== claimedMime)
        throw new CliErrorObject({ code: "VALIDATION", message: "Stream binary MIME does not match inspected bytes." });
      const width = inspected.media.width ?? 0,
        height = inspected.media.height ?? 0;
      if (!width || !height || width > 16384 || height > 16384 || width * height > 64000000)
        throw new CliErrorObject({
          code: "VALIDATION",
          message: "Stream image dimensions exceed local decode safety limits.",
        });
      ensureFfmpeg();
      const decoded = spawnSync(
        "ffmpeg",
        ["-v", "error", "-xerror", "-err_detect", "explode", "-i", cache, "-frames:v", "1", "-f", "null", "-"],
        { encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 },
      );
      if (decoded.status !== 0 || decoded.error)
        throw new CliErrorObject({ code: "VALIDATION", message: "Stream image failed a full local decode." });
      cachedIndex[String(index)] = { sourceHash: hash(source), sha256: hash(bytes) };
      atomic(indexFile, JSON.stringify(cachedIndex));
      const target =
        index === 0 ? path.resolve(options.output) : path.join(parsed.dir, `${parsed.name}-${index + 1}${parsed.ext}`);
      assertPathWithin(path.resolve("public/projects", store.projectId), target);
      if (existsSync(target) && !options.force && hashFile(target) !== hash(bytes))
        throw new CliErrorObject({
          code: "FILE_EXISTS",
          message: "Stream target exists with different bytes; explicit force required.",
        });
      const imported = importAsset({
        projectId: store.projectId,
        sourceFile: cache,
        provenance: {
          origin: "provider",
          tool: "fal.ai HTTP stream",
          model: job.endpoint,
          generationJobId: job.operationId,
          referenceAssetIds: job.publication?.referenceAssetIds ?? [],
          billing: { status: "unknown" },
          prompt: typeof options.request.input.prompt === "string" ? options.request.input.prompt : undefined,
        },
      });
      mkdirSync(path.dirname(target), { recursive: true });
      atomic(target, bytes);
      outputs.push(path.relative(process.cwd(), target));
      hashes.push(hashFile(target));
      assetIds.push(imported.asset.id);
    }
    job = store.transitionJob(job.operationId, "validated", {
      result: { ...job.result, published: { outputs, hashes, assetIds } },
    });
    return store.transitionJob(job.operationId, "published");
  } catch (error) {
    store.transitionJob(job.operationId, "failed", {
      error:
        error instanceof CliErrorObject
          ? error.message
          : "Stream media validation/publication failed; retained result can be retried without reconnect.",
    });
    throw error;
  }
}
/** No remote reconnect exists: an interrupted charged stream remains unknown until external reconciliation. */
export async function executeFalHttpStream(
  options: FalHttpStreamOptions,
): Promise<{ outputs: string[]; metadata: Record<string, unknown> }> {
  const limits = streamLimits(options.limits);
  const references = resolveImportedReferences(FalOperationRequestSchema.parse(options.request), options.projectId);
  const plan = buildFalOperation(references.request);
  if (plan.transport !== "stream")
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "HTTP stream service requires an exact stream operation.",
    });
  if (Buffer.byteLength(JSON.stringify(plan.input), "utf8") > MAX_STREAM_INPUT_BYTES)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Expanded stream input exceeds 4 MiB byte limit." });
  const { inputHash, canonicalInput, operationId, existing } = resolveOperationIdentity({
    input: plan.input,
    projectId: options.projectId,
    operationId: options.operationId,
    endpoint: plan.endpoint,
    provider: "fal-stream",
    assetId: options.assetId ?? path.resolve(options.output),
    id: (value) => `fal-stream:${hash(`${plan.endpoint}:${value}:${path.resolve(options.output)}`).slice(0, 40)}`,
  });
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(operationId))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Invalid stream operation ID." });
  const estimated = existing?.quote ?? boundedQuote(plan.endpoint, options.maxCostUsd);
  const publication = {
    output: path.resolve(options.output),
    kind: "image" as const,
    model: plan.endpoint,
    referenceAssetIds: [...new Set([...(options.referenceAssetIds ?? []), ...references.referenceAssetIds])].sort(),
  };
  if (options.dryRun !== false)
    return {
      outputs: [],
      metadata: {
        dryRun: true,
        operationId,
        plan,
        quote: estimated,
        executable: estimated !== null,
        transport: "stream",
        limits,
        maxInputBytes: MAX_STREAM_INPUT_BYTES,
        verification: { schema: true, localAdapter: true, live: false },
      },
    };
  if (options.signal?.aborted)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Stream cancelled before submission." });
  if (!options.projectId)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Charged stream requires project budget ownership." });
  requireProject(options.projectId);
  assertPathWithin(path.resolve("public/projects", options.projectId), publication.output);
  const store = new OperationStore(options.projectId);
  if (!existsSync(store.file))
    throw new CliErrorObject({
      code: "STAGE_INCOMPLETE",
      message: "Configure the durable project budget before streaming.",
    });
  if (!existing && !estimated)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Unknown stream price requires explicit authorised max-cost-usd planning bound.",
    });
  if (!existing && existsSync(publication.output) && !options.force)
    throw new CliErrorObject({ code: "FILE_EXISTS", message: "Stream output exists; explicit force required." });
  let job = store.reserveOperation({
    operationId,
    provider: "fal-stream",
    endpoint: plan.endpoint,
    inputHash,
    canonicalInput,
    assetId: options.assetId ?? publication.output,
    stage: options.stage ?? "assets",
    quote: existing?.quote ?? estimated!,
    publication,
  });
  const summary = () => ({
    outputs: job.state === "published" ? (job.result?.published as { outputs: string[] }).outputs : [],
    metadata: {
      operationId,
      state: job.state,
      providerRequestId: job.providerRequestId ?? null,
      billing: job.receipt ?? null,
      quote: job.quote,
      budget: store.summary(),
      verification: { schema: true, localAdapter: true, live: false },
      nextAction:
        job.state === "unknown"
          ? "reconcile-stream-no-reconnect"
          : job.state === "published"
            ? "reconcile-billing"
            : "resume-local-publication",
    },
  });
  const release = claimOperationWork(store, operationId);
  if (!release) {
    job = store.snapshot().jobs[operationId];
    return summary();
  }
  try {
    job = store.snapshot().jobs[operationId];
    const directory = privateDirectory(store, operationId);
    const checkpointFile = path.join(directory, "checkpoint.json");
    const bodyFile = path.join(directory, "body.bin");
    assertPathWithin(directory, checkpointFile);
    assertPathWithin(directory, bodyFile);
    if (
      ["result-ready", "downloading", "validated", "published"].includes(job.state) ||
      (job.state === "failed" && job.result)
    ) {
      await verifyRetainedStream(job, directory, limits);
      job = await publish(options, store, job, directory, limits.totalBytes);
      return summary();
    }
    if (job.state !== "reserved") {
      if (["submitting", "queued", "running"].includes(job.state))
        job = store.transitionJob(operationId, "unknown", {
          error: "Restarted incomplete charged stream; no remote replay permitted.",
        });
      if (existsSync(checkpointFile)) {
        boundedFile(checkpointFile, limits.totalBytes + limits.eventBytes + 65536);
        const checkpoint = JSON.parse(readFileSync(checkpointFile, "utf8")) as Checkpoint;
        if (checkpoint.complete) boundedFile(bodyFile, limits.totalBytes);
        if (
          checkpoint.complete &&
          checkpoint.operationId === operationId &&
          checkpoint.endpoint === plan.endpoint &&
          checkpoint.inputHash === inputHash &&
          checkpoint.bodyHash === hashFile(bodyFile) &&
          checkpoint.result
        ) {
          const controller = new AbortController();
          const raw = readFileSync(bodyFile);
          if (raw.length > limits.totalBytes) throw new Error("Cached stream exceeds current limits");
          const replay = await consumeFalHttpStream(
            new Response(raw, { headers: { "content-type": checkpoint.contentType ?? "" } }),
            { limits, controller, signal: controller.signal, onChunk() {}, onEvent() {} },
          );
          const reconstructed = replay.binary
            ? { streamBinary: { file: bodyFile, sha256: checkpoint.bodyHash, contentType: replay.contentType } }
            : validateFalOperationResult(plan.endpoint, replay.lastEvent);
          if (
            !replay.binary &&
            (Object.hasOwn(reconstructed, "streamProof") || Object.hasOwn(reconstructed, "streamBinary"))
          )
            throw new Error("Reserved internal field in stream replay");
          const result = {
            ...reconstructed,
            streamProof: {
              bodySha256: checkpoint.bodyHash,
              complete: true,
              providerRequestIdKnown: !!job.providerRequestId,
            },
          };
          if (generationInputHash(result) !== generationInputHash(checkpoint.result))
            throw new CliErrorObject({
              code: "VALIDATION",
              message: "Completed stream checkpoint does not match immutable raw bytes.",
            });
          job = store.transitionJob(operationId, "result-ready", { result });
          job = await publish(options, store, job, directory, limits.totalBytes);
        }
      }
      return summary();
    }
    const transport =
      options.transport ?? createFalHttpStreamTransport({ credentials: requireEnv("FAL_KEY"), fetch: options.fetch });
    const abort = new AbortController();
    const signal = AbortSignal.any([
      abort.signal,
      AbortSignal.timeout(limits.timeoutMs),
      ...(options.signal ? [options.signal] : []),
    ]);
    let fd: number | undefined;
    let checkpoint: Checkpoint = {
      version: 1,
      operationId,
      endpoint: plan.endpoint,
      inputHash,
      bytes: 0,
      events: 0,
      complete: false,
      providerRequestIdKnown: false,
    };
    // Allocate private resources before charged intent; never append to a previous attempt's bytes.
    try {
      // A reserved job has never committed send intent; abandoned local preparation is safe to replace under its lease.
      for (const file of [bodyFile, checkpointFile])
        if (existsSync(file)) {
          boundedFile(file, limits.totalBytes + limits.eventBytes + 65536);
          unlinkSync(file);
        }
      fd = openSync(bodyFile, "wx", 0o600);
      atomic(checkpointFile, JSON.stringify(checkpoint));
      if (signal.aborted)
        throw new CliErrorObject({ code: "INVALID_INPUT", message: "Stream cancelled before charged intent." });
      job = store.transitionJob(operationId, "submitting", { expectedState: "reserved" });
      const response = await transport.connect(plan.endpoint, plan.input, signal);
      const requestId = response.headers.get("x-fal-request-id") || null;
      if (requestId && !/^[a-zA-Z0-9_-]{1,200}$/.test(requestId)) throw new Error("Invalid stream request ID");
      checkpoint.providerRequestIdKnown = requestId !== null;
      if (requestId)
        job = store.transitionJob(operationId, "running", {
          providerRequestId: requestId,
          note: "Actual stream response ownership recorded",
        });
      atomic(checkpointFile, JSON.stringify(checkpoint));
      const read = await consumeFalHttpStream(response, {
        limits,
        controller: abort,
        signal,
        onChunk(chunk) {
          let offset = 0;
          while (offset < chunk.length) offset += writeSync(fd!, chunk, offset, chunk.length - offset);
          fsyncSync(fd!);
          checkpoint.bytes += chunk.length;
        },
        onEvent(event, count) {
          checkpoint.events = count;
          checkpoint.lastEvent = event;
          atomic(checkpointFile, JSON.stringify(checkpoint));
        },
      });
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      const rawResult = read.binary
        ? { streamBinary: { file: bodyFile, sha256: hashFile(bodyFile), contentType: read.contentType } }
        : validateFalOperationResult(plan.endpoint, read.lastEvent);
      if (!read.binary) {
        if (Object.hasOwn(rawResult, "streamBinary") || Object.hasOwn(rawResult, "streamProof"))
          throw new Error("Reserved internal field in stream event");
        mediaSources(rawResult);
      }
      const result = {
        ...rawResult,
        streamProof: { bodySha256: hashFile(bodyFile), complete: true, providerRequestIdKnown: requestId !== null },
      };
      checkpoint = { ...checkpoint, ...read, complete: true, bodyHash: hashFile(bodyFile), result };
      atomic(checkpointFile, JSON.stringify(checkpoint));
      job = store.transitionJob(operationId, "result-ready", { result });
    } catch (error) {
      abort.abort();
      const current = store.snapshot().jobs[operationId];
      if (current.state === "reserved") throw error;
      if (["submitting", "queued", "running"].includes(current.state))
        job = store.transitionJob(operationId, "unknown", {
          error:
            error instanceof CliErrorObject
              ? error.message
              : "Charged stream interrupted or invalid; reservation retained, automatic reconnect blocked.",
        });
      else job = current;
      throw new CliErrorObject({
        code: "STAGE_INCOMPLETE",
        message: "Stream outcome retained as unresolved; reconcile before another paid connect.",
        details: { operationId, state: job.state },
      });
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    job = await publish(options, store, job, directory, limits.totalBytes);
    return summary();
  } finally {
    release();
  }
}
