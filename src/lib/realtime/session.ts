import { z } from "zod";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  readdirSync,
  lstatSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  constants,
  mkdirSync,
  writeFileSync,
  linkSync,
  unlinkSync,
  fsyncSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import type WebSocket from "ws";
import { buildFalOperation } from "../providers/fal-operations";
import {
  falRealtimeUrl,
  openRealtimeSocket,
  encodeRealtimeInput,
  decodeRealtimeResult,
} from "../providers/fal-realtime";
import { FalOperationRequestSchema } from "../../types/generation";
import { OperationStore } from "../jobs/store";
import { PriceQuoteSchema } from "../jobs/types";
import { claimOperationWork } from "../jobs/work-lease";
import { digest } from "../jobs/model-artifacts";
import { generationInputHash } from "../jobs/runner";
import { paidInputIdentity } from "../jobs/identity";
import { assertPathWithin, validateProjectId } from "../cli";
import { inspectAsset } from "../assets/inspect";
import { importAsset } from "../assets/registry";
/** Bound both stat and actual FD reads: a changing local file cannot grow an allocation. */
function boundedRegularFile(file: string, maximum: number, missingAllowed = false) {
  if (missingAllowed && !existsSync(file)) return;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum)
    throw new Error("Realtime cached file must be regular and within byte bound");
}
function readBoundedFile(file: string, maximum: number): Buffer {
  boundedRegularFile(file, maximum);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) throw new Error("Realtime cached file exceeds byte bound");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) throw new Error("Realtime cached file changed during read");
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null)) throw new Error("Realtime cached file grew during read");
    return bytes;
  } finally {
    closeSync(fd);
  }
}
function boundedImmutableWrite(file: string, content: Buffer | string) {
  const maximum = Buffer.byteLength(content);
  const verify = () => {
    if (digest(readBoundedFile(file, maximum)) !== digest(content)) throw new Error("Immutable artifact conflict");
  };
  mkdirSync(path.dirname(file), {
    recursive: true,
  });
  if (existsSync(file)) {
    verify();
    return;
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, {
      flag: "wx",
      mode: 0o600,
    });
    const fd = openSync(temporary, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      verify();
    }
    const directory = openSync(path.dirname(file), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
const manifestSchema = z
  .object({
    version: z.literal(1),
    projectId: z.string(),
    sessionId: z.string(),
    revisionId: z.string(),
    operationId: z.string(),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    endpoint: z.literal("fal-ai/flux-2/klein/realtime"),
    frames: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            path: z.string(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            width: z.number().int().positive().max(4096),
            height: z.number().int().positive().max(4096),
            contentType: z.enum(["image/png", "image/jpeg", "image/webp"]),
            assetId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .min(1)
      .max(2),
    provenance: z
      .object({
        providerAck: z.literal(false),
        association: z.string(),
        billing: z.string(),
        rights: z.string(),
      })
      .strict(),
    closeRequested: z.literal(true),
  })
  .strict();
const limits = z
  .object({
    maxFrames: z.number().int().min(1).max(2),
    maxInputBytes: z
      .number()
      .int()
      .positive()
      .max(4 * 1024 * 1024),
    maxResponseBytes: z
      .number()
      .int()
      .positive()
      .max(16 * 1024 * 1024),
    maxControls: z.number().int().min(1).max(64),
    timeoutMs: z.number().int().min(50).max(100000),
  })
  .strict();
export const RealtimeSessionRequestSchema = z
  .object({
    version: z.literal(1),
    projectId: z.string(),
    sessionId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,150}$/),
    revisionId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,100}$/),
    operation: FalOperationRequestSchema,
    quote: PriceQuoteSchema,
    limits,
  })
  .strict();
export type RealtimeSessionRequest = z.input<typeof RealtimeSessionRequestSchema>;
export function planRealtimeSession(input: RealtimeSessionRequest) {
  const request = RealtimeSessionRequestSchema.parse(input);
  validateProjectId(request.projectId);
  const plan = buildFalOperation(request.operation);
  if (plan.transport !== "realtime" || plan.endpoint !== "fal-ai/flux-2/klein/realtime")
    throw new Error("Only verified FLUX.2 klein realtime is supported");
  const image = String(plan.input.image_url);
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image))
    throw new Error("Realtime requires an inline image data URI; no uploads/CDN references");
  const wire = encodeRealtimeInput(plan.input);
  if (wire.byteLength > request.limits.maxInputBytes) throw new Error("Input exceeds bounded message size");
  const expectedFrames = plan.input.enable_interpolation ? 2 : 1;
  if (expectedFrames > request.limits.maxFrames) throw new Error("Frame bound cannot accommodate interpolation");
  if (request.quote.highUsd <= 0)
    throw new Error("Realtime must reserve a positive whole-session bound; no free inference assumption");
  if (!Number.isSafeInteger(plan.input.seed) || Number(plan.input.seed) < 0)
    throw new Error("Concrete nonnegative seed required for result association");
  const intent = {
    version: 1,
    sessionId: request.sessionId,
    revisionId: request.revisionId,
    endpoint: plan.endpoint,
    input: plan.input,
    quote: request.quote,
    limits: request.limits,
  };
  return {
    request,
    plan,
    wire,
    expectedFrames,
    inputHash: generationInputHash(intent),
    operationId: `realtime:${request.sessionId}`,
    intent,
  };
}
const resultSchema = z
  .object({
    seed: z.number().int(),
    images: z
      .array(
        z
          .object({
            content: z.instanceof(Uint8Array),
            width: z.number().int().positive().max(4096),
            height: z.number().int().positive().max(4096),
            content_type: z.enum(["image/jpeg", "image/png", "image/webp"]).default("image/jpeg"),
          })
          .strict(),
      )
      .min(1)
      .max(2),
  })
  .strict();
export type RealtimeDependencies = {
  rootDir?: string;
  store?: OperationStore;
  tokenProvider: (endpoint: string) => Promise<string>;
  socketFactory?: (url: string, maxPayload: number) => WebSocket;
  signal?: AbortSignal;
  afterIntent?: () => void;
  afterSend?: () => void;
};
/** Local journal events never imply provider ACK. Session and revision IDs are never sent as fake protocol fields. */
export async function runRealtimeSession(input: RealtimeSessionRequest, deps: RealtimeDependencies) {
  const planned = planRealtimeSession(input),
    { request, plan, operationId } = planned,
    root = path.resolve(deps.rootDir ?? process.cwd()),
    project = path.join(root, "public/projects", request.projectId);
  assertPathWithin(path.join(root, "public/projects"), project);
  if (!existsSync(path.join(project, "project.json"))) throw new Error("Project missing");
  const store =
    deps.store ??
    new OperationStore(request.projectId, {
      directory: path.join(project, "pipeline"),
    });
  assertPathWithin(project, store.file);
  if (store.projectId !== request.projectId) throw new Error("Financial store must match session project");
  const financialIdentity = paidInputIdentity(
    planned.intent,
    existsSync(store.file) ? store.snapshot().jobs[operationId] : undefined,
  );
  const { inputHash } = financialIdentity;
  const journal = path.join(root, ".cache/realtime", request.projectId, digest(request.sessionId));
  assertPathWithin(root, journal);
  for (const file of [
    path.join(root, ".cache"),
    path.join(root, ".cache/realtime"),
    path.join(root, ".cache/realtime", request.projectId),
    journal,
  ])
    if (existsSync(file) && lstatSync(file).isSymbolicLink())
      throw new Error("Private realtime journal cannot use symlink directories");
  const event = (kind: string, detail: Record<string, unknown> = {}) => {
    const count = existsSync(journal) ? readdirSync(journal).filter((n) => /^\d+-/.test(n)).length : 0;
    const file = path.join(journal, `${String(count).padStart(4, "0")}-${kind}.json`);
    assertPathWithin(root, file);
    boundedImmutableWrite(
      file,
      JSON.stringify({
        version: 1,
        kind,
        at: new Date().toISOString(),
        sessionId: request.sessionId,
        revisionId: request.revisionId,
        ...detail,
      }),
    );
  };
  const cache = path.join(journal, "result.msgpack"),
    manifestFile = path.join(project, "pipeline/realtime", `${digest(request.sessionId)}.json`);
  assertPathWithin(root, cache);
  assertPathWithin(project, manifestFile);
  boundedRegularFile(cache, request.limits.maxResponseBytes, true);
  const pending = (state: string, message: string) => ({
    outputs: [],
    metadata: {
      sessionId: request.sessionId,
      revisionId: request.revisionId,
      operationId,
      state,
      message,
      nextAction: "inspect-local-checkpoints-and-provider-billing; never replay automatically",
    },
  });
  const release = claimOperationWork(store, operationId);
  if (!release)
    return {
      outputs: [],
      metadata: {
        sessionId: request.sessionId,
        state: "worker-owned",
        nextAction: "wait-for-local-owner",
      },
    };
  try {
    let job = store.reserveOperation({
      operationId,
      provider: "fal-realtime",
      endpoint: plan.endpoint,
      ...financialIdentity,
      assetId: `session:${request.sessionId}`,
      quote: request.quote,
      repair: false,
    });
    if (job.state === "published") {
      const manifestBytes = readBoundedFile(manifestFile, 65536);
      if (!job.result?.captureManifestHash || digest(manifestBytes) !== job.result.captureManifestHash)
        throw new Error("Published capture manifest changed");
      const manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
      if (
        manifest.projectId !== request.projectId ||
        manifest.sessionId !== request.sessionId ||
        manifest.revisionId !== request.revisionId ||
        manifest.operationId !== operationId ||
        manifest.inputHash !== inputHash ||
        manifest.frames.length !== planned.expectedFrames
      )
        throw new Error("Published capture intent mismatch");
      for (const [index, frame] of manifest.frames.entries()) {
        const extension = {
          "image/png": "png",
          "image/jpeg": "jpg",
          "image/webp": "webp",
        }[frame.contentType];
        if (
          frame.index !== index ||
          frame.assetId !== `sha256:${frame.sha256}` ||
          frame.path !== `public/projects/${request.projectId}/assets/imported/${frame.sha256}.${extension}`
        )
          throw new Error("Published capture frame path/identity mismatch");
        const file = path.resolve(root, frame.path);
        assertPathWithin(project, file);
        if (digest(readBoundedFile(file, request.limits.maxResponseBytes)) !== frame.sha256)
          throw new Error("Published frame changed");
      }
      return {
        outputs: [manifestFile, ...manifest.frames.map((f: { path: string }) => path.resolve(root, f.path))],
        metadata: {
          state: "published",
          sessionId: request.sessionId,
          billing: "unreconciled-unless-provider-receipt",
          resumed: true,
        },
      };
    }
    // Cached result is durable recovery evidence. It is never a permission to reconnect or re-send.
    if (!existsSync(cache)) {
      if (job.state !== "reserved") {
        if (["submitting", "running", "queued"].includes(job.state))
          store.transitionJob(operationId, "unknown", {
            error: "Worker interrupted without recoverable result; provider has no replay/ACK contract",
          });
        return pending(
          store.snapshot().jobs[operationId]!.state,
          "No provider session recovery protocol; a new explicit session needs separate budget",
        );
      }
      if (deps.signal?.aborted) {
        store.transitionJob(operationId, "cancelled");
        store.releaseReservation(operationId, {
          confirmationId: `local:${request.sessionId}`,
          reason: "not-submitted",
          source: "Cancelled before auth/connect intent",
        });
        return pending("cancelled", "Cancelled locally before provider contact");
      }
      const sourceMime = String(plan.input.image_url).slice(5, String(plan.input.image_url).indexOf(";"));
      const sourceBytes = Buffer.from(String(plan.input.image_url).split(",")[1]!, "base64");
      const sourceFile = path.join(
        journal,
        `input-${digest(sourceBytes)}.${sourceMime === "image/jpeg" ? "jpg" : sourceMime === "image/png" ? "png" : "webp"}`,
      );
      boundedImmutableWrite(sourceFile, sourceBytes);
      const sourceMedia = inspectAsset(sourceFile);
      if (
        sourceMedia.kind !== "image" ||
        sourceMedia.mime !== sourceMime ||
        (sourceMedia.media.width ?? Infinity) > 4096 ||
        (sourceMedia.media.height ?? Infinity) > 4096
      )
        throw new Error("Invalid actual realtime input image");
      const inputDecode = spawnSync(
        "ffmpeg",
        ["-v", "error", "-xerror", "-i", sourceFile, "-frames:v", "1", "-f", "null", "-"],
        {
          encoding: "utf8",
          timeout: 30000,
        },
      );
      if (inputDecode.status !== 0 || inputDecode.error) throw new Error("Realtime input decode failed");
      boundedImmutableWrite(path.join(journal, "intent.json"), JSON.stringify(planned.intent));
      event("connect-intent", {
        inputHash,
      });
      store.transitionJob(operationId, "submitting");
      deps.afterIntent?.();
      try {
        let token: string;
        try {
          token = await deps.tokenProvider(plan.endpoint);
        } catch {
          throw new Error("Token acquisition failed; sensitive provider details omitted");
        }
        if (deps.signal?.aborted) throw new Error("Cancelled after connect intent; billing unknown");
        const url = falRealtimeUrl(plan.endpoint, token),
          socket = (deps.socketFactory ?? openRealtimeSocket)(url, request.limits.maxResponseBytes);
        const captured = await new Promise<Buffer>((resolve, reject) => {
          let settled = false,
            controls = 0,
            sent = false,
            received = false;
          const timer = setTimeout(
            () => finish(new Error("Session deadline exceeded; provider completion unknown")),
            request.limits.timeoutMs,
          );
          const abort = () => finish(new Error("Cancelled session; socket close is not a refund"));
          function finish(error?: Error, data?: Buffer) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            deps.signal?.removeEventListener("abort", abort);
            socket.close(1000, "local bounded session complete");
            const closing = setTimeout(() => socket.terminate(), 100);
            closing.unref();
            socket.once("close", () => clearTimeout(closing));
            if (error) reject(error);
            else resolve(data!);
          }
          deps.signal?.addEventListener("abort", abort, {
            once: true,
          });
          socket.on("open", () => {
            if (settled) return;
            try {
              if (socket.bufferedAmount > request.limits.maxInputBytes)
                throw new Error("Socket backpressure exceeds bound");
              event("send-intent", {
                inputHash,
                bytes: planned.wire.byteLength,
              });
              sent = true;
              socket.send(
                planned.wire,
                {
                  binary: true,
                },
                (error) => {
                  if (settled) return;
                  if (error) {
                    finish(new Error("Socket write failed; delivery unknown"));
                    return;
                  }
                  event("wire-written", {
                    providerAck: false,
                  });
                  try {
                    deps.afterSend?.();
                  } catch (error) {
                    finish(error as Error);
                  }
                },
              );
            } catch (error) {
              finish(error as Error);
            }
          });
          socket.on("message", (data, isBinary) => {
            if (settled) return;
            try {
              const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
              if (bytes.byteLength > request.limits.maxResponseBytes) throw new Error("Response exceeds bounded bytes");
              const decoded = decodeRealtimeResult(data, isBinary) as Record<string, unknown>;
              if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
                throw new Error("Invalid protocol response");
              if (decoded.type === "x-fal-message" || (decoded.type === "x-fal-error" && decoded.error === "TIMEOUT")) {
                if (++controls > request.limits.maxControls) throw new Error("Control message limit exceeded");
                event("control", {
                  type: String(decoded.type),
                  providerAck: false,
                });
                return;
              }
              if (decoded.type === "x-fal-error" || decoded.status === "error")
                throw new Error("Provider rejected realtime input; response body omitted");
              if (!sent || received) throw new Error("Unsolicited/duplicate result cannot be associated");
              received = true;
              const result = resultSchema.parse(decoded);
              if (result.seed !== plan.input.seed || result.images.length !== planned.expectedFrames)
                throw new Error("Result seed/frame count cannot be associated with input revision");
              event("result-observed", {
                providerAck: false,
                bytes: bytes.length,
              });
              finish(undefined, Buffer.from(encodeRealtimeInput(result as unknown as Record<string, unknown>)));
            } catch (error) {
              finish(error as Error);
            }
          });
          socket.on("error", () => finish(new Error("WebSocket transport error; delivery unknown")));
          socket.on("close", () => {
            if (!settled) finish(new Error("Provider closed before complete result; delivery unknown"));
          });
          if (deps.signal?.aborted) abort();
        });
        boundedImmutableWrite(cache, captured);
        event("result-checkpoint", {
          sha256: digest(captured),
        });
      } catch (error) {
        const current = store.snapshot().jobs[operationId]!;
        if (["submitting", "running", "queued"].includes(current.state))
          store.transitionJob(operationId, deps.signal?.aborted ? "cancelled" : "unknown", {
            error: error instanceof Error ? error.message : "Realtime error",
          });
        event("interrupted", {
          reason: error instanceof Error ? error.message : "Realtime error",
        });
        return pending(
          store.snapshot().jobs[operationId]!.state,
          "Connection stopped; commitment retained and no replay attempted",
        );
      }
    }
    const data = readBoundedFile(cache, request.limits.maxResponseBytes);
    if (data.byteLength > request.limits.maxResponseBytes) throw new Error("Cached response too large");
    const result = resultSchema.parse(decodeRealtimeResult(data, true));
    if (result.seed !== plan.input.seed || result.images.length !== planned.expectedFrames)
      throw new Error("Cached result identity mismatch");
    job = store.snapshot().jobs[operationId]!;
    if (job.result?.privateResultHash && job.result.privateResultHash !== digest(data))
      throw new Error("Durable result checkpoint changed");
    if (["submitting", "unknown", "running", "queued"].includes(job.state))
      job = store.transitionJob(operationId, "result-ready", {
        result: {
          privateResultHash: digest(data),
          sessionId: request.sessionId,
          revisionId: request.revisionId,
          providerAck: false,
        },
      });
    if (!["result-ready", "downloading", "validated", "failed"].includes(job.state))
      return pending(job.state, "Cached result exists but lifecycle requires explicit review");
    if (job.state !== "validated" && job.state !== "downloading") store.transitionJob(operationId, "downloading");
    const frames = [];
    for (const [index, image] of result.images.entries()) {
      const bytes = Buffer.from(image.content);
      if (!bytes.length || bytes.length > request.limits.maxResponseBytes) throw new Error("Frame bytes out of bounds");
      const ext = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
      }[image.content_type];
      const file = path.join(journal, `${digest(bytes)}.${ext}`);
      boundedImmutableWrite(file, bytes);
      const media = inspectAsset(file);
      if (
        media.kind !== "image" ||
        media.mime !== image.content_type ||
        media.media.width !== image.width ||
        media.media.height !== image.height
      )
        throw new Error("Actual image format/dimensions differ from response");
      const decoded = spawnSync("ffmpeg", ["-v", "error", "-xerror", "-i", file, "-frames:v", "1", "-f", "null", "-"], {
        encoding: "utf8",
        timeout: 30000,
      });
      if (decoded.status !== 0 || decoded.error) throw new Error("Actual frame decode failed");
      const imported = importAsset({
        projectId: request.projectId,
        rootDir: root,
        sourceFile: file,
        provenance: {
          origin: "provider",
          tool: "fal.ai realtime MessagePack",
          model: plan.endpoint,
          generationJobId: operationId,
          referenceAssetIds: [],
          billing: {
            status: "unknown",
          },
        },
      });
      frames.push({
        index,
        path: `public/${imported.asset.files.original}`,
        sha256: imported.asset.hash,
        width: image.width,
        height: image.height,
        contentType: image.content_type,
        assetId: imported.asset.id,
      });
    }
    const manifest = {
      version: 1,
      projectId: request.projectId,
      sessionId: request.sessionId,
      revisionId: request.revisionId,
      operationId,
      inputHash,
      endpoint: plan.endpoint,
      frames,
      provenance: {
        providerAck: false,
        association: "one local input revision + concrete seed; no provider correlation ID",
        billing: "unreconciled reservation retained",
        rights: "provider terms and input rights require review",
      },
      closeRequested: true,
    };
    assertPathWithin(project, manifestFile);
    boundedImmutableWrite(manifestFile, JSON.stringify(manifest, null, 2));
    if (store.snapshot().jobs[operationId]!.state === "downloading")
      store.transitionJob(operationId, "validated", {
        result: {
          ...store.snapshot().jobs[operationId]!.result,
          captureManifestHash: digest(readBoundedFile(manifestFile, 65536)),
        },
      });
    store.transitionJob(operationId, "published");
    event("published", {
      manifestHash: digest(readBoundedFile(manifestFile, 65536)),
    });
    return {
      outputs: [manifestFile, ...frames.map((frame) => path.resolve(root, frame.path))],
      metadata: {
        state: "published",
        sessionId: request.sessionId,
        revisionId: request.revisionId,
        operationId,
        providerAck: false,
        reservedUsd: store.summary().reservedUsd,
      },
    };
  } catch (error) {
    const job = existsSync(store.file) ? store.snapshot().jobs[operationId] : undefined;
    if (job?.state === "reserved") {
      store.transitionJob(operationId, "cancelled");
      store.releaseReservation(operationId, {
        confirmationId: `local-validation:${request.sessionId}`,
        reason: "not-submitted",
        source: "Input validation failed before auth/connect intent",
      });
    }
    if (job && ["result-ready", "downloading", "validated"].includes(job.state))
      store.transitionJob(operationId, "failed", {
        error: error instanceof Error ? error.message : "Publication failed",
      });
    throw error;
  } finally {
    release();
  }
}
