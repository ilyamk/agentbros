import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  linkSync,
  unlinkSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { assertPathWithin, CliErrorObject } from "../cli";
import { pipelineDir, projectDir } from "../pipeline/paths";
import { artifactExtension, extractArtifacts, type ResultSchema } from "../providers/fal-results";
import type { GenerationJob } from "./types";
export const digest = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
/** Immutable receipts are the artifact registry: independent operations cannot overwrite each other. */
export function immutableWrite(file: string, content: Buffer | string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  if (existsSync(file)) {
    if (digest(readFileSync(file)) !== digest(content)) throw new Error("Immutable artifact conflict");
    return;
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    const fd = openSync(temporary, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || digest(readFileSync(file)) !== digest(content))
        throw error;
    }
    const dir = openSync(path.dirname(file), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
/** Preview hosts evidenced in recorded docs/catalogue fixtures. The orchestrator adds the result host observed in the live test. */
export const HIGGSFIELD_RESULT_HOSTS: readonly string[] = [
  "cdn.higgsfield.ai",
  "static-public-media.higgsfield.ai",
  "d28lhcrx5qdowv.cloudfront.net",
  // Generation results observed in the authorised live test, 2026-11-15 (Soul 2 image).
  "d3u0tzju9qaucj.cloudfront.net",
];
export function trustedArtifactUrl(value: string, provider = "fal"): URL {
  const url = new URL(value);
  if (provider === "higgsfield") {
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      !HIGGSFIELD_RESULT_HOSTS.includes(url.hostname)
    )
      throw new Error("Untrusted Higgsfield artifact URL");
    return url;
  }
  if (!["fal", "fal.ai"].includes(provider)) throw new Error("Unknown artifact provider");
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
    throw new Error("Untrusted artifact URL");
  return url;
}
/** Safetensors only: never load pickle/checkpoint Python code. */
export function validateSafeTensors(data: Buffer): void {
  if (data.length < 10) throw new Error("Invalid safetensors file");
  const size = data.readBigUInt64LE(0);
  if (size < 2n || size > 16n * 1024n * 1024n || size > BigInt(data.length - 8))
    throw new Error("Invalid safetensors header length");
  const header: unknown = JSON.parse(data.subarray(8, 8 + Number(size)).toString("utf8"));
  if (!header || typeof header !== "object" || Array.isArray(header)) throw new Error("Invalid safetensors header");
  const spans: [number, number][] = [];
  let tensors = 0;
  const bytesPerType: Record<string, number> = {
    BOOL: 1,
    U8: 1,
    I8: 1,
    U16: 2,
    I16: 2,
    U32: 4,
    I32: 4,
    U64: 8,
    I64: 8,
    F16: 2,
    BF16: 2,
    F32: 4,
    F64: 8,
    F8_E4M3: 1,
    F8_E5M2: 1,
    F8_E4M3FN: 1,
    F8_E8M0: 1,
  };
  for (const [key, value] of Object.entries(header)) {
    if (key === "__metadata__") {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.values(value).some((v) => typeof v !== "string")
      )
        throw new Error("Invalid safetensors metadata");
      continue;
    }
    const tensor = value as { dtype?: string; shape?: number[]; data_offsets?: number[] };
    if (
      !tensor ||
      !bytesPerType[tensor.dtype!] ||
      !Array.isArray(tensor.shape) ||
      !tensor.shape.every((n) => Number.isSafeInteger(n) && n >= 0) ||
      !Array.isArray(tensor.data_offsets) ||
      tensor.data_offsets.length !== 2
    )
      throw new Error("Invalid safetensors tensor");
    const [start, end] = tensor.data_offsets;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start! < 0 ||
      end! < start! ||
      end! > data.length - 8 - Number(size) ||
      tensor.shape.reduce((a, b) => a * b, 1) * bytesPerType[tensor.dtype!]! !== end! - start!
    )
      throw new Error("Invalid safetensors data offsets");
    spans.push([start!, end!]);
    tensors++;
  }
  spans.sort((a, b) => a[0] - b[0]);
  if (
    !tensors ||
    spans.some((span, i) => span[0] !== (i === 0 ? 0 : spans[i - 1]![1])) ||
    spans.at(-1)![1] !== data.length - 8 - Number(size)
  )
    throw new Error("Safetensors payload contains gaps or overlaps");
}
export async function downloadModelArtifact(
  url: string,
  kind: "safetensors" | "config",
  request: typeof fetch,
): Promise<Buffer> {
  trustedArtifactUrl(url);
  const response = await request(url, { redirect: "error", signal: AbortSignal.timeout(60000) });
  if (!response.ok || !response.body) throw new Error(`Artifact download failed: HTTP ${response.status}`);
  const limit = kind === "config" ? 10 * 1024 * 1024 : 512 * 1024 * 1024;
  const mime = response.headers.get("content-type")?.split(";")[0]?.trim();
  if (
    mime &&
    !(
      kind === "config"
        ? ["application/json", "text/plain", "application/octet-stream"]
        : ["application/octet-stream", "application/x-safetensors"]
    ).includes(mime)
  )
    throw new Error("Invalid artifact content type");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.length;
      if (total > limit) throw new Error("Artifact exceeds size limit");
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  }
  const data = Buffer.concat(chunks);
  if (!data.length) throw new Error("Empty artifact");
  if (kind === "safetensors") validateSafeTensors(data);
  else {
    const json: unknown = JSON.parse(data.toString("utf8"));
    if (!json || typeof json !== "object" || Array.isArray(json) || !Object.keys(json).length)
      throw new Error("Invalid training config");
  }
  return data;
}
export async function publishNonMediaResult(
  projectId: string,
  kind: "training" | "voice",
  result: Record<string, unknown>,
  job: GenerationJob,
  request: typeof fetch,
  resultSchema?: ResultSchema,
): Promise<Record<string, unknown>> {
  const artifacts: {
    kind: string;
    path: string;
    sha256: string;
    bytes: number;
    sourceUrl?: string;
    contentType: string;
  }[] = [];
  let voiceId: string | undefined;
  let customReferenceId: string | undefined;
  if (kind === "voice") {
    if (typeof result.voice_id !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(result.voice_id))
      throw new Error("Invalid Kling voice ID");
    voiceId = result.voice_id;
  } else if (job.provider === "higgsfield" && job.endpoint === "v1/custom-references") {
    if (
      result.status !== "completed" ||
      typeof result.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,200}$/.test(result.id) ||
      result.id !== job.providerRequestId
    )
      throw new Error("Invalid or incomplete Soul ID custom reference");
    customReferenceId = result.id;
  } else {
    const files = resultSchema ? extractArtifacts(resultSchema, result).files : undefined;
    if (files && !files.some((file) => file.kind === "weights")) throw new Error("Training result contains no weights");
    if (files?.some((file) => file.kind === "weights" && artifactExtension(file) !== ".safetensors"))
      throw new Error("Training weights must be safetensors");
    const sources = files
      ? files
          .filter(
            (file) =>
              file.kind === "weights" ||
              (file.kind === "file" &&
                (artifactExtension(file) === ".json" ||
                  file.contentType?.split(";")[0]?.trim().toLowerCase() === "application/json" ||
                  /(?:^|\/)config(?:_files?|s)?(?:\/|$)/i.test(file.path))),
          )
          .map((file) => ({
            field: file.path,
            artifactKind: file.kind === "weights" ? ("safetensors" as const) : ("config" as const),
            value: { url: file.url, file_size: file.fileSize },
          }))
      : (
          [
            ["diffusers_lora_file", "safetensors"],
            ["config_file", "config"],
          ] as const
        ).map(([field, artifactKind]) => ({
          field,
          artifactKind,
          value: result[field] as { url?: unknown; file_size?: unknown } | undefined,
        }));
    for (const { field, artifactKind, value } of sources) {
      if (!value || typeof value.url !== "string") throw new Error(`Missing ${field}`);
      const bytes = await downloadModelArtifact(value.url, artifactKind, request);
      if (typeof value.file_size === "number" && value.file_size !== bytes.length)
        throw new Error("Artifact file size mismatch");
      const sha256 = digest(bytes);
      const file = path.resolve(
        projectDir(projectId),
        "assets/models",
        `${sha256}.${artifactKind === "config" ? "json" : "safetensors"}`,
      );
      assertPathWithin(path.resolve(projectDir(projectId)), file);
      immutableWrite(file, bytes);
      artifacts.push({
        kind: artifactKind,
        path: path.relative(process.cwd(), file),
        sha256,
        bytes: bytes.length,
        sourceUrl: `${trustedArtifactUrl(value.url).origin}${trustedArtifactUrl(value.url).pathname}`,
        contentType: artifactKind === "config" ? "application/json" : "application/x-safetensors",
      });
    }
  }
  const manifest = {
    version: 1,
    kind,
    ...(customReferenceId ? { customReferenceId } : {}),
    ...(voiceId ? { voiceId } : {}),
    artifacts,
    provenance: {
      provider: job.provider,
      endpoint: job.endpoint,
      operationId: job.operationId,
      providerRequestId: job.providerRequestId,
      inputHash: job.inputHash,
      createdAt: job.createdAt,
      billing: "unreconciled",
      rights: "provider-terms-and-training-input-rights-required",
    },
  };
  const file = path.resolve(pipelineDir(projectId), "model-artifacts", `${digest(job.operationId)}.json`);
  assertPathWithin(path.resolve(projectDir(projectId)), file);
  const bytes = JSON.stringify(manifest, null, 2);
  immutableWrite(file, bytes);
  return {
    outputs: [path.relative(process.cwd(), file)],
    hashes: [digest(bytes)],
    artifacts,
    ...(customReferenceId ? { customReferenceId } : {}),
    ...(voiceId ? { voiceId } : {}),
  };
}

/** Verify every published file before a resume can skip the provider operation. */
export function verifyFalPublication(
  value: unknown,
  options: { projectId: string; scopeRoot?: string; operationId?: string },
): void {
  const published = z
    .object({
      outputs: z.array(z.string()).min(1),
      hashes: z.array(z.string()),
      artifacts: z.array(z.object({ path: z.string(), sha256: z.string() })).optional(),
    })
    .parse(value);
  const verify = (file: string, hash: string | undefined, artifact: boolean) => {
    if (options.scopeRoot) assertPathWithin(options.scopeRoot, file);
    if (artifact) assertPathWithin(path.resolve(projectDir(options.projectId)), file);
    if (!existsSync(file) || digest(readFileSync(file)) !== hash)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: `Published ${artifact ? "model artifact" : "output"} is missing or changed for ${options.operationId ?? "operation"}; it will not be resubmitted.`,
      });
  };
  if (published.outputs.length !== published.hashes.length)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Published output hashes are incomplete; it will not be resubmitted.",
    });
  published.outputs.forEach((file, index) => verify(file, published.hashes[index], false));
  published.artifacts?.forEach((artifact) => verify(artifact.path, artifact.sha256, true));
}
