import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CliErrorObject } from "../cli";
import { request, readResponse, responseUrl, publicUrl } from "../media-fetch/http";
import { MediaFetchError } from "../media-fetch/errors";
import {
  immutablePreparationJson,
  preparationDigest,
  preparationProject,
  projectMediaFile,
} from "../model-preparation/storage";
import { assertPathWithin } from "../cli";
import { hashFile, importAsset, readAssetRegistry } from "./registry";
import { inspectAsset } from "./inspect";
import {
  RemoteMediaBindingSchema,
  RemoteMediaReceiptSchema,
  RemoteMediaUrlSchema,
  type RemoteMediaBinding,
} from "../../types/remote-media";
import { mediaKindForKey } from "../providers/higgsfield/media-fields";

export type RemoteMediaIo = { request?: typeof request };
const invalid = (message: string): never => {
  throw new CliErrorObject({ code: "VALIDATION", message });
};
const remoteError = (error: unknown): never => {
  if (error instanceof MediaFetchError)
    throw new CliErrorObject({
      code: error.code === "TIMEOUT" ? "TIMEOUT" : error.code === "NETWORK" ? "NETWORK" : "VALIDATION",
      message: `${error.message} ${error.action}`,
    });
  throw error;
};
const safe = (value: string) => {
  RemoteMediaUrlSchema.parse(value);
  try {
    return publicUrl(value).href;
  } catch (error) {
    return remoteError(error);
  }
};
const decode = (value: string) =>
  value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (original, code: string) => {
      const point = code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code);
      return point <= 0x10ffff ? String.fromCodePoint(point) : original;
    });

/** Static public metadata only: never executes scripts, forwards cookies or guesses a private API. */
export function pageMediaCandidates(html: string, base: string, kind: "image" | "video" | "audio" = "video"): string[] {
  const values: string[] = [];
  for (const block of html.matchAll(new RegExp(`<${kind}\\b[^>]*>([\\s\\S]*?)<\\/${kind}>`, "gi"))) {
    for (const source of block[1].matchAll(/<source\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/gi)) values.push(decode(source[2]));
  }
  for (const tag of html.match(/<(?:meta|source|video|audio)\b[^>]*>/gi) ?? []) {
    const attributes = Object.fromEntries(
      [...tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)].map((match) => [match[1].toLowerCase(), decode(match[3])]),
    );
    const name = attributes.property ?? attributes.name ?? "";
    if (
      new RegExp(`^(?:og:${kind}(?::(?:url|secure_url))?|twitter:player:stream)$`, "i").test(name) &&
      attributes.content
    )
      values.push(attributes.content);
    if (
      attributes.src &&
      (new RegExp(`^<${kind}\\b`, "i").test(tag) ||
        (/^<source\b/i.test(tag) && attributes.type?.startsWith(`${kind}/`)))
    )
      values.push(attributes.src);
  }
  for (const script of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === "object") {
          const row = value as Record<string, unknown>;
          if (String(row["@type"]).toLowerCase() === `${kind}object` && typeof row.contentUrl === "string")
            values.push(row.contentUrl);
          Object.values(row)
            .filter((item) => item && typeof item === "object")
            .forEach(visit);
        }
      };
      visit(JSON.parse(script[1]));
    } catch {
      /* Invalid page metadata supplies no candidates. */
    }
  }
  return [
    ...new Set(
      values.flatMap((value) => {
        try {
          return [safe(new URL(value, base).href)];
        } catch {
          return [];
        }
      }),
    ),
  ];
}
export async function resolveRemoteMedia(
  url: string,
  kind: "image" | "video" | "audio" = "video",
  io: RemoteMediaIo = {},
) {
  const source = safe(url),
    response = await (io.request ?? request)(source, { timeoutMs: 30_000 }).catch(remoteError);
  if (response.statusCode !== 200) {
    response.destroy();
    invalid(
      `Source returned HTTP ${response.statusCode}; supply a public original or use media:fetch for a supported post.`,
    );
  }
  const final = safe(responseUrl(response) ?? source),
    contentType = String(response.headers["content-type"] ?? "")
      .split(";")[0]
      .toLowerCase();
  if (/^(?:image|video|audio)\//.test(contentType) || contentType === "application/octet-stream") {
    response.destroy();
    return { sourceUrl: source, candidates: [final], direct: true, contentType };
  }
  if (!/^(?:text\/html|application\/xhtml\+xml)$/.test(contentType)) {
    response.destroy();
    invalid("Source is neither a direct media response nor a supported public HTML page.");
  }
  const html = (await readResponse(response, 2 * 1024 * 1024).catch(remoteError)).toString("utf8");
  return {
    sourceUrl: source,
    candidates: pageMediaCandidates(html, final, kind),
    direct: false,
    contentType,
    nextAction:
      "Select an exposed original with --media-url when ambiguous. For a dynamic/private Motion Library card, obtain its permitted original URL/export; supported social posts use media:fetch. No private catalogue endpoint is inferred.",
  };
}
function receiptFile(projectId: string, id: string, rootDir: string) {
  RemoteMediaBindingSchema.shape.id.parse(id);
  const project = preparationProject(projectId, rootDir),
    file = path.join(project, "pipeline/remote-media", `${id}.json`);
  assertPathWithin(project, file);
  return file;
}
export function readRemoteMedia(projectId: string, raw: RemoteMediaBinding, rootDir = process.cwd()) {
  const binding = RemoteMediaBindingSchema.parse(raw);
  const receipt = RemoteMediaReceiptSchema.parse(
    JSON.parse(readFileSync(receiptFile(projectId, binding.id, rootDir), "utf8")),
  );
  if (receipt.id !== binding.id || receipt.projectId !== projectId || preparationDigest(receipt) !== binding.sha256)
    invalid("Remote media receipt identity changed.");
  safe(receipt.mediaUrl);
  const asset = readAssetRegistry(projectId, rootDir).assets.find((row) => row.id === receipt.assetId);
  if (
    !asset ||
    asset.hash !== receipt.sha256 ||
    asset.files.bytes !== receipt.bytes ||
    asset.kind !== receipt.kind ||
    asset.files.mime !== receipt.contentType ||
    preparationDigest(asset.media) !== preparationDigest(receipt.media) ||
    hashFile(projectMediaFile(projectId, asset.files.original, rootDir)) !== receipt.sha256
  )
    invalid("Remote media original, measurements or registry identity changed.");
  return { receipt, binding, asset: asset! };
}
export async function acquireRemoteMedia(
  options: {
    projectId: string;
    id: string;
    url: string;
    mediaUrl?: string;
    kind?: "image" | "video" | "audio";
    expiresAt?: string;
    maxBytes?: number;
    rootDir?: string;
  },
  io: RemoteMediaIo = {},
) {
  const rootDir = options.rootDir ?? process.cwd(),
    file = receiptFile(options.projectId, options.id, rootDir);
  if (existsSync(file)) {
    const receipt = RemoteMediaReceiptSchema.parse(JSON.parse(readFileSync(file, "utf8"))),
      binding = { id: options.id, sha256: preparationDigest(receipt) };
    const current = readRemoteMedia(options.projectId, binding, rootDir);
    if (
      safe(options.url) !== receipt.sourceUrl ||
      (options.mediaUrl && safe(options.mediaUrl) !== receipt.mediaUrl) ||
      (options.kind && options.kind !== receipt.kind) ||
      (options.expiresAt && options.expiresAt !== receipt.expiresAt)
    )
      throw new CliErrorObject({
        code: "FILE_EXISTS",
        message: "Remote receipt is immutable; use a new id for a changed source.",
      });
    return { ...current, file, reused: true };
  }
  const maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 512 * 1024 * 1024)
    invalid("max-bytes must be positive and at most 512 MiB.");
  const resolved = options.mediaUrl
    ? { candidates: [safe(options.mediaUrl)] }
    : await resolveRemoteMedia(options.url, options.kind, io);
  if (resolved.candidates.length !== 1)
    invalid(
      `Found ${resolved.candidates.length} media candidates. Resolve first, then select an original with --media-url; otherwise use a permitted export or media:fetch.`,
    );
  const response = await (io.request ?? request)(resolved.candidates[0], { timeoutMs: 60_000 }).catch(remoteError);
  if (response.statusCode !== 200) {
    response.destroy();
    invalid(`Original returned HTTP ${response.statusCode}; it may require login or have expired.`);
  }
  const mediaUrl = safe(responseUrl(response) ?? resolved.candidates[0]);
  const bytes = await readResponse(response, maxBytes).catch(remoteError),
    directory = mkdtempSync(path.join(tmpdir(), "hf-remote-"));
  try {
    const local = path.join(directory, "original");
    writeFileSync(local, bytes);
    const inspected = inspectAsset(local);
    if (!["video", "image", "audio"].includes(inspected.kind) || (options.kind && inspected.kind !== options.kind))
      invalid("Downloaded original does not match the requested media kind.");
    const acquiredAt = new Date().toISOString();
    const receiptInput = {
      schemaVersion: 1,
      projectId: options.projectId,
      id: options.id,
      sourceUrl: safe(options.url),
      mediaUrl,
      acquiredAt,
      ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
      assetId: `sha256:${hashFile(local)}`,
      sha256: hashFile(local),
      bytes: bytes.length,
      kind: inspected.kind,
      contentType: inspected.mime,
      media: inspected.media,
    };
    const receipt = RemoteMediaReceiptSchema.parse(receiptInput);
    const asset = importAsset({
      projectId: options.projectId,
      rootDir,
      sourceFile: local,
      provenance: { origin: "manual", tool: "hf:media" },
      rights: { sourceUrl: receipt.sourceUrl },
    }).asset;
    if (preparationDigest(asset.media) !== preparationDigest(receipt.media))
      invalid("Imported registry measurements differ from the inspected remote original.");
    immutablePreparationJson(file, receipt);
    return { receipt, binding: { id: receipt.id, sha256: preparationDigest(receipt) }, asset, file, reused: false };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
/** Rechecks exact bytes before a fresh provider operation. Polling a saved request needs no source URL. */
export async function verifyRemoteMedia(
  projectId: string,
  bindings: RemoteMediaBinding[],
  rootDir = process.cwd(),
  io: RemoteMediaIo = {},
) {
  for (const binding of bindings) {
    const { receipt } = readRemoteMedia(projectId, binding, rootDir);
    if (receipt.expiresAt && Date.parse(receipt.expiresAt) <= Date.now() + 60_000)
      invalid("Remote media URL expires too soon; acquire a fresh receipt and prepare a new request.");
    const response = await (io.request ?? request)(receipt.mediaUrl, { timeoutMs: 60_000 }).catch(remoteError);
    if (response.statusCode !== 200) {
      response.destroy();
      invalid("Remote media is unavailable; never silently change the URL of a durable operation.");
    }
    const bytes = await readResponse(response, receipt.bytes + 1).catch(remoteError);
    if (bytes.length !== receipt.bytes || createHash("sha256").update(bytes).digest("hex") !== receipt.sha256)
      invalid("Remote media bytes changed; acquire and approve a new revision.");
  }
}

export function remoteMediaAssetIds(
  projectId: string,
  bindings: RemoteMediaBinding[],
  input: Record<string, unknown>,
  rootDir = process.cwd(),
): string[] {
  const attached = new Map<string, Set<string>>();
  const visit = (value: unknown, key = ""): void => {
    if (typeof value === "string" && /(?:^|_)urls?$/.test(key)) {
      const kinds = attached.get(value) ?? new Set<string>();
      const kind = mediaKindForKey(key);
      if (kind) kinds.add(kind);
      attached.set(value, kinds);
    } else if (Array.isArray(value)) value.forEach((item) => visit(item, key));
    else if (value && typeof value === "object") Object.entries(value).forEach(([name, item]) => visit(item, name));
  };
  visit(input);
  const urls = new Set<string>();
  return bindings.map((binding) => {
    const { receipt } = readRemoteMedia(projectId, binding, rootDir);
    if (!attached.has(receipt.mediaUrl) || urls.has(receipt.mediaUrl))
      invalid("Remote receipt must bind one unique attached URL.");
    if ([...attached.get(receipt.mediaUrl)!].some((kind) => kind !== receipt.kind))
      invalid("Remote original kind does not match its attached media URL field.");
    urls.add(receipt.mediaUrl);
    return receipt.assetId;
  });
}
