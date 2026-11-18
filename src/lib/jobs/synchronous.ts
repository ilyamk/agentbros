import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  unlinkSync,
  realpathSync,
  lstatSync,
} from "node:fs";
import path from "node:path";
import { claimOperationWork } from "./work-lease";
import { OperationStore, BudgetError } from "./store";
import { paidInputIdentity } from "./identity";
import { CliErrorObject } from "../cli";
import type { OperationInput, GenerationJob } from "./types";

type CachedResponse = {
  bodyFile: string;
  bodyHash: string;
  status: number;
  contentType: string;
  providerRequestIdKnown: boolean;
  characterCost?: string;
};
const checksum = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function cached(job: GenerationJob, store: OperationStore, maxBytes?: number): Response | undefined {
  const result = job.result as CachedResponse | undefined;
  if (!result?.bodyFile) return undefined;
  const expectedDirectory = path.resolve(store.responseCacheDirectory);
  if (
    path.dirname(path.resolve(result.bodyFile)) !== expectedDirectory ||
    !/^[a-f0-9]{64}\.bin$/.test(path.basename(result.bodyFile))
  )
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Paid response cache path escapes its private directory",
    });
  if (!existsSync(result.bodyFile))
    throw new CliErrorObject({
      code: "STAGE_INCOMPLETE",
      message: "Paid response cache is missing; reconcile before submitting again",
    });
  if (
    lstatSync(result.bodyFile).isSymbolicLink() ||
    realpathSync(path.dirname(result.bodyFile)) !== realpathSync(expectedDirectory)
  )
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Paid response cache cannot use symlinks",
    });
  const stat = lstatSync(result.bodyFile);
  if (!stat.isFile() || stat.isSymbolicLink() || (maxBytes !== undefined && stat.size > maxBytes))
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Paid response cache exceeds its byte bound or is not a regular file",
    });
  const bytes = readFileSync(result.bodyFile);
  if (checksum(bytes) !== result.bodyHash)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Paid response cache checksum mismatch",
    });
  // The default cache lives outside public/ and is never bundled with video assets.
  return new Response(bytes, {
    status: result.status,
    headers: {
      "content-type": result.contentType,
      ...(result.providerRequestIdKnown && job.providerRequestId ? { "request-id": job.providerRequestId } : {}),
      ...(result.characterCost ? { "character-cost": result.characterCost } : {}),
    },
  });
}

/** Journal synchronous providers; retries replay bytes and never repeat paid POSTs. */
export async function synchronousPaidRequest(options: {
  store: OperationStore;
  operation: Omit<OperationInput, "inputHash">;
  identity: Record<string, unknown>;
  perform: () => Promise<Response>;
  maxResponseBytes?: number;
}): Promise<Response> {
  const { store, operation, identity, perform } = options;
  if (
    options.maxResponseBytes !== undefined &&
    (!Number.isSafeInteger(options.maxResponseBytes) ||
      options.maxResponseBytes < 1 ||
      options.maxResponseBytes > 512 * 1024 * 1024)
  )
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Invalid paid response byte bound" });
  const database = store.snapshot();
  const old = Object.hasOwn(database.jobs, operation.operationId) ? database.jobs[operation.operationId] : undefined;
  let job = store.reserveOperation({
    ...operation,
    quote: old?.quote ?? operation.quote,
    ...paidInputIdentity(identity, old),
  });
  const replay = cached(job, store, options.maxResponseBytes);
  if (replay) return replay;
  if (job.state !== "reserved")
    throw new CliErrorObject({
      code: "STAGE_INCOMPLETE",
      message: `Paid operation ${job.operationId} is ${job.state}; reconcile its outcome before another submit`,
    });
  const release = claimOperationWork(store, job.operationId);
  if (!release)
    throw new CliErrorObject({
      code: "STAGE_INCOMPLETE",
      message: "Paid operation is owned by another live local worker; resume after it completes",
    });
  try {
    job = store.transitionJob(job.operationId, "submitting", {
      expectedState: "reserved",
    });
    let response: Response;
    try {
      response = await perform();
    } catch (error) {
      store.transitionJob(job.operationId, "unknown", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new CliErrorObject({
        code: "STAGE_INCOMPLETE",
        message: "Paid request outcome is ambiguous; reservation retained and automatic POST retry blocked",
      });
    }
    const requestId =
      response.headers.get("request-id") ??
      response.headers.get("xi-request-id") ??
      response.headers.get("x-request-id");
    job = store.transitionJob(job.operationId, "queued", {
      providerRequestId: requestId ?? `local-correlation:${job.operationId}`,
    });
    let bytes: Uint8Array;
    try {
      if (options.maxResponseBytes === undefined) bytes = new Uint8Array(await response.arrayBuffer());
      else {
        const length = response.headers.get("content-length");
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > options.maxResponseBytes)) {
          void response.body?.cancel().catch(() => {});
          throw Error("Paid response exceeds byte bound");
        }
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0,
          reads = 0;
        try {
          if (reader)
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              size += next.value.byteLength;
              if (size > options.maxResponseBytes || ++reads > 131_072)
                throw Error("Paid response exceeds byte/chunk bound");
              chunks.push(next.value);
            }
          bytes = Buffer.concat(chunks, size);
        } finally {
          if (reader) {
            void reader.cancel().catch(() => {});
            reader.releaseLock();
          }
        }
      }
    } catch (error) {
      store.transitionJob(job.operationId, "unknown", {
        error: error instanceof Error ? error.message : String(error),
        note: "Response headers received but body lost",
      });
      throw new CliErrorObject({
        code: "STAGE_INCOMPLETE",
        message: "Paid response body lost; reconcile provider history before regeneration",
      });
    }
    const directory = store.responseCacheDirectory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink())
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Private response cache cannot be a symlink",
      });
    if (existsSync("public")) {
      const relative = path.relative(realpathSync("public"), realpathSync(directory));
      if (relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative)))
        throw new CliErrorObject({
          code: "VALIDATION",
          message: "Paid response cache must remain outside public assets",
        });
    }
    const bodyHash = checksum(bytes);
    const bodyFile = path.join(directory, `${bodyHash}.bin`);
    const temporary = `${bodyFile}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, bodyFile);
      const characterCost = response.headers.get("character-cost");
      const result = {
        bodyFile,
        bodyHash,
        status: response.status,
        contentType: response.headers.get("content-type") ?? "application/octet-stream",
        providerRequestIdKnown: requestId !== null,
        ...(/^\d{1,12}$/.test(characterCost ?? "") ? { characterCost } : {}),
      };
      job = store.transitionJob(job.operationId, "result-ready", { result });
      if (response.ok) {
        store.transitionJob(job.operationId, "downloading");
        store.transitionJob(job.operationId, "validated");
        job = store.transitionJob(job.operationId, "published");
      } else
        job = store.transitionJob(job.operationId, "failed", {
          error: `Provider HTTP ${response.status}; no billing refund assumed`,
        });
      return cached(job, store, options.maxResponseBytes)!;
    } catch (error) {
      // A successful remote request must never disappear from the journal merely
      // because local disk publication failed. A next run refuses to resubmit.
      const current = store.snapshot().jobs[job.operationId];
      if (current.state === "queued")
        store.transitionJob(job.operationId, "unknown", {
          note: "Response cache publication failed",
        });
      if (error instanceof BudgetError) throw error;
      throw new CliErrorObject({
        code: "STAGE_INCOMPLETE",
        message: "Paid response could not be durably published; reservation retained",
      });
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  } finally {
    release();
  }
}
