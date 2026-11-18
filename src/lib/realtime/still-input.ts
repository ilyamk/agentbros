import path from "node:path";
import { constants, openSync, closeSync, lstatSync, fstatSync, readSync, type Stats } from "node:fs";
import { z } from "zod";
import { AssetRegistrySchema, type AssetRecord } from "../../types/assets";
import { readWorkflowEvidence } from "../workflows/local-evidence";
import { assertStaticImageBytes } from "../review-ui/split-original";
import { digest } from "../jobs/model-artifacts";
import { RealtimeDeriveInputSchema } from "./editor";
import { RealtimeSessionRequestSchema, planRealtimeSession } from "./session";
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,100}$/),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const controls = z
  .object({
    ...RealtimeDeriveInputSchema.shape,
    prompt: z.string().min(1).max(4096),
    seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export const RealtimeStillDraftSchema = z
  .object({
    assetId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    assetSha256: hash,
    registrySha256: hash,
    revisionId: id,
    sessionId: id,
    input: controls,
    highUsd: z.number().positive().finite(),
    limits: RealtimeSessionRequestSchema.shape.limits,
  })
  .strict();
export type RealtimeStillDraft = z.input<typeof RealtimeStillDraftSchema>;
const CAP = 2 * 1024 * 1024;
const same = (a: Stats, b: Stats) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
function project(root: string, projectId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(projectId)) throw Error("Invalid still project");
  let current = path.resolve(root);
  for (const part of [".", "public", "projects", projectId]) {
    current = part === "." ? current : path.join(current, part);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Still project ancestor alias/non-directory");
  }
  return current;
}
function eligible(a: AssetRecord, projectId: string) {
  return (
    a.kind === "image" &&
    a.files.bytes <= CAP &&
    a.media.hasAudio === false &&
    a.media.width! <= 4096 &&
    a.media.height! <= 4096 &&
    ((a.files.mime === "image/png" &&
      a.media.codec === "png" &&
      a.files.original === `projects/${projectId}/assets/imported/${a.hash}.png`) ||
      (a.files.mime === "image/jpeg" &&
        a.media.codec === "mjpeg" &&
        ["jpg", "jpeg"].some((ext) => a.files.original === `projects/${projectId}/assets/imported/${a.hash}.${ext}`)))
  );
}
function registry(root: string, projectId: string) {
  const scope = project(root, projectId),
    file = path.join(scope, "pipeline/asset-registry.json"),
    captured = readWorkflowEvidence(file, scope, 4 * 1024 * 1024),
    parsed = AssetRegistrySchema.parse(JSON.parse(captured.text));
  return { scope, file, captured, parsed };
}
/** Registry metadata only: no original decode, import, provider, or byte preview. */
export function listRealtimeStills(root: string, projectId: string) {
  const r = registry(root, projectId),
    candidates = r.parsed.assets.filter((a) => eligible(a, projectId));
  if (candidates.length > 128) throw Error("Still source list exceeds128 candidates");
  if (readWorkflowEvidence(r.file, r.scope, 4 * 1024 * 1024).sha256 !== r.captured.sha256)
    throw Error("Still registry changed during listing");
  return {
    registrySha256: r.captured.sha256,
    sources: candidates.map((a) => ({
      assetId: a.id,
      assetSha256: a.hash,
      mime: a.files.mime,
      bytes: a.files.bytes,
      width: a.media.width,
      height: a.media.height,
    })),
    metadataOnly: true,
    offline: true,
  };
}
/** One captured binary FD stays open until explicit pre-add recheck, then caller closes. */
export function prepareRealtimeStill(root: string, projectId: string, raw: unknown) {
  if (Buffer.byteLength(JSON.stringify(raw)) > 16384) throw Error("Still draft selector exceeds16KiB");
  const input = RealtimeStillDraftSchema.parse(raw),
    r = registry(root, projectId);
  if (r.captured.sha256 !== input.registrySha256) throw Error("Still registry checksum changed");
  const asset = r.parsed.assets.find((a) => a.id === input.assetId);
  if (
    !asset ||
    !eligible(asset, projectId) ||
    asset.hash !== input.assetSha256 ||
    asset.id !== `sha256:${input.assetSha256}`
  )
    throw Error("Still requires matching registered static PNG/JPEG original");
  const configFile = path.join(r.scope, "project.json"),
    config = readWorkflowEvidence(configFile, r.scope, 8 * 1024 * 1024),
    value = JSON.parse(config.text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Still project config must be an object");
  const file = path.resolve(root, "public", asset.files.original),
    parents: { file: string; stat: Stats }[] = [];
  let directory = path.resolve(root);
  const relative = path.relative(directory, file);
  if (relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw Error("Still source outside workspace");
  for (const part of [".", ...relative.split(path.sep).slice(0, -1)]) {
    directory = part === "." ? directory : path.join(directory, part);
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Still original parent alias/non-directory");
    parents.push({ file: directory, stat });
  }
  const initial = lstatSync(file);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size < 1 || initial.size > CAP)
    throw Error("Still source must be regular/non-alias within2MiB");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      closeSync(fd);
    }
  };
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !same(initial, stat)) throw Error("Still source changed before capture");
    const bytes = Buffer.alloc(stat.size);
    let at = 0;
    while (at < bytes.length) {
      const n = readSync(fd, bytes, at, bytes.length - at, at);
      if (!n) throw Error("Still source shrank during capture");
      at += n;
    }
    const recheck = () => {
      if (closed) throw Error("Still source capture closed");
      if (readSync(fd, Buffer.alloc(1), 0, 1, stat.size) || !same(stat, fstatSync(fd)) || !same(stat, lstatSync(file)))
        throw Error("Still source changed during capture");
      for (const p of parents) {
        const current = lstatSync(p.file);
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          current.dev !== p.stat.dev ||
          current.ino !== p.stat.ino
        )
          throw Error("Still parent changed during capture");
      }
      if (
        readWorkflowEvidence(r.file, r.scope, 4 * 1024 * 1024).sha256 !== r.captured.sha256 ||
        readWorkflowEvidence(configFile, r.scope, 8 * 1024 * 1024).sha256 !== config.sha256
      )
        throw Error("Still registry/project changed during capture");
    };
    if (bytes.length !== asset.files.bytes || digest(bytes) !== asset.hash)
      throw Error("Still original checksum/size differs from registry");
    assertStaticImageBytes(file, bytes);
    if (
      asset.files.mime === "image/png" &&
      (bytes.readUInt32BE(16) !== asset.media.width || bytes.readUInt32BE(20) !== asset.media.height)
    )
      throw Error("Still PNG dimensions differ from registry");
    const request = RealtimeSessionRequestSchema.parse({
      version: 1,
      projectId,
      revisionId: input.revisionId,
      sessionId: input.sessionId,
      operation: {
        family: "flux-2",
        variant: "klein",
        operation: "realtime",
        transport: "realtime",
        input: { ...input.input, image_url: `data:${asset.files.mime};base64,${bytes.toString("base64")}` },
      },
      quote: {
        currency: "USD",
        lowUsd: 0,
        expectedUsd: input.highUsd,
        highUsd: input.highUsd,
        bounded: true,
        confidence: "user-bound",
        providerEnforced: false,
        source: "Explicit new still-draft upper planning bound; no provider billing",
        asOf: new Date().toISOString(),
      },
      limits: input.limits,
    });
    const planned = planRealtimeSession(request);
    if (Buffer.byteLength(JSON.stringify(request)) > 6 * 1024 * 1024) throw Error("Still request exceeds6MiB");
    recheck();
    return {
      request: planned.request,
      recheck,
      close,
      sourceInput: {
        assetId: asset.id,
        assetSha256: asset.hash,
        registrySha256: r.captured.sha256,
        projectSha256: config.sha256,
        mime: asset.files.mime,
        bytes: bytes.length,
        width: asset.media.width,
        height: asset.media.height,
        inputHash: planned.inputHash,
        offline: true,
        physicalDecodeVerified: false,
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}
