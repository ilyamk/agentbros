import { CliErrorObject } from "../../cli";
import { ResourceCandidateSchema, type ResourceCandidate } from "../../../types/resources";
import { rightsFromLicence } from "../rights";
import { quotaHeaders, type QuotaReader } from "./http";
import { downloadSize } from "./resolution";
import { pickRendition } from "./renditions";
import type { StockAdapter, StockColour, StockContext, StockQuery } from "./types";

export const PEXELS_API = "https://api.pexels.com/";
const LICENCE_URL = "https://www.pexels.com/license/";
const COLOURS: Partial<Record<StockColour, string>> = {
  black: "black",
  white: "white",
  gray: "gray",
  yellow: "yellow",
  orange: "orange",
  red: "red",
  purple: "violet",
  pink: "pink",
  green: "green",
  teal: "turquoise",
  blue: "blue",
  brown: "brown",
};

/** Pexels sends the reset as a UNIX timestamp (seconds). */
export const pexelsQuota: QuotaReader = (headers, now) => {
  const remaining = quotaHeaders.header(headers, "x-ratelimit-remaining");
  if (remaining === undefined) return undefined;
  const reset = quotaHeaders.header(headers, "x-ratelimit-reset");
  return {
    remaining,
    limit: quotaHeaders.header(headers, "x-ratelimit-limit"),
    resetAt: reset && reset * 1000 > now ? reset * 1000 : now + 60 * 60_000,
    observedAt: now,
  };
};

const auth = (ctx: StockContext) => ({ Authorization: ctx.key() });

export function normalisePexels(item: any, kind: "image" | "video", now: string): ResourceCandidate {
  const image = kind === "image";
  if (!item?.id || !item.url)
    throw new CliErrorObject({ code: "VALIDATION", message: "Pexels item is missing id or url." });
  const renditions = image
    ? []
    : [...(item.video_files ?? [])]
        .filter(
          (file: any) =>
            file.link && file.file_type !== "application/vnd.apple.mpegurl" && file.width > 0 && file.height > 0,
        )
        .map((file: any) => ({
          url: String(file.link),
          width: Number(file.width),
          height: Number(file.height),
          ...(file.quality ? { label: String(file.quality) } : {}),
        }))
        .sort((a, b) => b.width * b.height - a.width * a.height);
  const author = String(item.photographer ?? item.user?.name ?? "");
  const authorId = item.photographer_id ?? item.user?.id;
  const authorUrl = item.photographer_url ?? item.user?.url;
  // Videos carry no alt text; their page slug describes them ("close-up-of-coffee-being-poured-6950167").
  const slug = String(item.url)
    .match(/\/(?:photo|video)\/([a-z0-9-]+?)-\d+\/?$/i)?.[1]
    ?.replace(/-/g, " ");
  const title = String(item.alt || slug || `Pexels ${item.id}`).slice(0, 500);
  return ResourceCandidateSchema.parse({
    id: `pexels:${image ? "photo" : "video"}:${item.id}`,
    provider: "pexels",
    kind: image ? "image" : "video",
    title,
    sourceUrl: item.url,
    author,
    ...(authorId !== undefined && authorId !== null ? { authorId: String(authorId) } : {}),
    ...(authorUrl ? { authorUrl } : {}),
    previewUrl: image ? item.src?.medium : item.image,
    ...(image && item.src?.tiny ? { thumbnailUrl: item.src.tiny } : {}),
    downloadUrl: image ? item.src?.original : renditions[0]?.url,
    acquisition: "direct",
    media: { width: item.width, height: item.height, ...(item.duration ? { durationSec: item.duration } : {}) },
    ...(renditions.length ? { renditions } : {}),
    ...(/^#[0-9a-fA-F]{6}$/.test(item.avg_color ?? "") ? { visual: { dominantColor: item.avg_color } } : {}),
    tags: [],
    rights: rightsFromLicence({
      licence: "Pexels",
      licenceUrl: LICENCE_URL,
      title,
      author,
      sourceUrl: item.url,
      verifiedAtSource: true,
      checkedAsOf: now,
    }),
    cost: {
      status: "free",
      quotaNote:
        "Pexels API hourly and monthly quotas apply; remaining requests are in metadata.providers.pexels.quota.",
    },
  });
}

function params(query: StockQuery, notes: string[]) {
  const out = new URLSearchParams({
    query: query.query,
    per_page: String(Math.min(query.limit, 80)),
    page: String(query.page),
  });
  if (query.orientation) out.set("orientation", query.orientation);
  if (query.lang) out.set("locale", `${query.lang}-${query.lang.toUpperCase()}`);
  if (query.minWidth && query.minWidth >= 3000) out.set("size", "large");
  if (query.color) {
    const colour = COLOURS[query.color];
    if (colour && query.kind === "image") out.set("color", colour);
    else notes.push(`Pexels cannot filter colour "${query.color}"${query.kind === "video" ? " for video" : ""}.`);
  }
  if (query.safe) notes.push("Pexels has no safe-search switch; its library is moderated.");
  return out;
}

export const pexels: StockAdapter = {
  id: "pexels",
  kinds: ["image", "video"],
  keyEnv: "PEXELS_API_KEY",
  native: ["orientation", "color", "lang"],
  async search(query, ctx) {
    const notes: string[] = [];
    if (!query.query.trim())
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pexels search requires --query." });
    if (query.author) notes.push("Pexels has no author search; results are filtered to the author locally.");
    const image = query.kind === "image";
    const data = await ctx.http.json(`${PEXELS_API}${image ? "v1/search" : "videos/search"}?${params(query, notes)}`, {
      headers: auth(ctx),
    });
    let candidates = (image ? (data.photos ?? []) : (data.videos ?? [])).map((item: any) =>
      normalisePexels(item, query.kind, ctx.now()),
    );
    if (query.author) candidates = candidates.filter((item: ResourceCandidate) => item.authorId === query.author);
    return { candidates, notes };
  },
  async inspect(candidate, ctx) {
    const id = candidate.id.split(":").at(-1)!;
    const image = candidate.kind === "image";
    const data = await ctx.http.json(
      `${PEXELS_API}${image ? "v1/photos" : "videos/videos"}/${encodeURIComponent(id)}`,
      { headers: auth(ctx), fresh: true },
    );
    return normalisePexels(data, image ? "image" : "video", ctx.now());
  },
  resolveDownload(candidate, target) {
    if (candidate.kind === "video") {
      const rendition = pickRendition(candidate.renditions ?? [], target);
      if (rendition) return { url: rendition.url, media: { width: rendition.width, height: rendition.height } };
      if (!candidate.downloadUrl)
        throw new CliErrorObject({ code: "VALIDATION", message: "Pexels video has no file." });
      return { url: candidate.downloadUrl, media: candidate.media };
    }
    if (!candidate.downloadUrl) throw new CliErrorObject({ code: "VALIDATION", message: "Pexels photo has no file." });
    const { width, height } = candidate.media;
    if (!width || !height) return { url: candidate.downloadUrl, media: {} };
    const size = downloadSize({ width, height }, target?.format, target?.zoom, target ? undefined : Infinity);
    if (size.width >= width) return { url: candidate.downloadUrl, media: { width, height } };
    const url = new URL(candidate.downloadUrl);
    url.searchParams.set("auto", "compress");
    url.searchParams.set("cs", "tinysrgb");
    url.searchParams.set("w", String(size.width));
    return { url: url.toString(), media: size };
  },
};
