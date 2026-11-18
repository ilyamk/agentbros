import { CliErrorObject } from "../../cli";
import { ResourceCandidateSchema, type ResourceCandidate } from "../../../types/resources";
import { rightsFromLicence } from "../rights";
import { quotaHeaders, type QuotaReader } from "./http";
import { pickRendition } from "./renditions";
import type { StockAdapter, StockColour, StockContext, StockQuery } from "./types";

export const PIXABAY_API = "https://pixabay.com/api/";
const LICENCE_URL = "https://pixabay.com/service/license-summary/";
/** Pixabay's free tier caps stills at 1280 px on the long side (largeImageURL); originals need full API access. */
export const PIXABAY_LARGE_IMAGE = 1280;
const COLOURS: Partial<Record<StockColour, string>> = {
  black_and_white: "grayscale",
  black: "black",
  white: "white",
  gray: "gray",
  yellow: "yellow",
  orange: "orange",
  red: "red",
  purple: "lilac",
  pink: "pink",
  green: "green",
  teal: "turquoise",
  blue: "blue",
  brown: "brown",
};

/** Pixabay sends the seconds left in its 60-second window. */
export const pixabayQuota: QuotaReader = (headers, now) => {
  const remaining = quotaHeaders.header(headers, "x-ratelimit-remaining");
  if (remaining === undefined) return undefined;
  const reset = quotaHeaders.header(headers, "x-ratelimit-reset") ?? 60;
  return {
    remaining,
    limit: quotaHeaders.header(headers, "x-ratelimit-limit"),
    resetAt: now + reset * 1000,
    observedAt: now,
  };
};

const trusted = (url: unknown) => {
  if (typeof url !== "string" || !url) return undefined;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !/(^|\.)pixabay\.com$/.test(parsed.hostname))
    throw new CliErrorObject({ code: "VALIDATION", message: "Pixabay returned an unexpected media host." });
  return parsed.toString();
};

function scaled(width: number, height: number, longSide: number) {
  const scale = Math.min(1, longSide / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

function normalise(item: any, kind: "image" | "video", now: string): ResourceCandidate {
  if (!item?.id || !item.pageURL)
    throw new CliErrorObject({ code: "VALIDATION", message: "Pixabay hit is missing id or pageURL." });
  const author = String(item.user ?? "");
  const sourceUrl = trusted(item.pageURL)!;
  const authorUrl =
    item.user && item.user_id
      ? `https://pixabay.com/users/${encodeURIComponent(String(item.user))}-${Number(item.user_id)}/`
      : undefined;
  const tags = String(item.tags ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  const title = tags.length ? tags.join(", ") : `Pixabay ${kind} ${item.id}`;
  const rights = rightsFromLicence({
    licence: "Pixabay",
    licenceUrl: LICENCE_URL,
    title,
    author,
    sourceUrl,
    verifiedAtSource: true,
    checkedAsOf: now,
  });
  rights.attributionText = `${kind === "video" ? "Video" : "Image"} by ${author || "unknown"}${authorUrl ? ` (${authorUrl})` : ""} via Pixabay. ${sourceUrl}`;
  let renditions: { url: string; width: number; height: number; bytes?: number; label: string }[] = [];
  let media: { width?: number; height?: number; durationSec?: number };
  let previewUrl: string | undefined;
  let quotaNote = "Pixabay API: 100 requests/minute; responses are cached for 24 hours as Pixabay requires.";
  if (kind === "video") {
    renditions = (["large", "medium", "small", "tiny"] as const)
      .map((label) => ({ label, file: item.videos?.[label] }))
      .filter(({ file }) => file?.url && file.width > 0 && file.height > 0)
      .map(({ label, file }) => ({
        url: trusted(file.url)!,
        width: file.width,
        height: file.height,
        ...(file.size ? { bytes: file.size } : {}),
        label,
      }));
    const largest = renditions[0];
    media = {
      ...(largest ? { width: largest.width, height: largest.height } : {}),
      ...(item.duration ? { durationSec: item.duration } : {}),
    };
    previewUrl = trusted(item.videos?.tiny?.thumbnail ?? item.videos?.small?.thumbnail);
  } else {
    const original = trusted(item.imageURL);
    const full = trusted(item.fullHDURL);
    const large = trusted(item.largeImageURL);
    const w = Number(item.imageWidth),
      h = Number(item.imageHeight);
    if (original && w && h) renditions.push({ url: original, width: w, height: h, label: "original" });
    if (full && w && h) renditions.push({ url: full, ...scaled(w, h, 1920), label: "fullhd" });
    if (large && w && h) renditions.push({ url: large, ...scaled(w, h, PIXABAY_LARGE_IMAGE), label: "large" });
    // The honest size is what can be downloaded, not the photographer's original.
    media = renditions[0] ? { width: renditions[0].width, height: renditions[0].height } : {};
    previewUrl = trusted(item.webformatURL) ?? large;
    if (!original)
      quotaNote += ` Stills are limited to ${PIXABAY_LARGE_IMAGE}px without approved full API access (original ${w}x${h}).`;
  }
  return ResourceCandidateSchema.parse({
    id: `pixabay:${kind === "video" ? "video" : "photo"}:${item.id}`,
    provider: "pixabay",
    kind,
    title: title.slice(0, 500),
    sourceUrl,
    author,
    ...(item.user_id ? { authorId: String(item.user_id) } : {}),
    ...(authorUrl ? { authorUrl } : {}),
    ...(previewUrl ? { previewUrl, thumbnailUrl: trusted(item.previewURL) ?? previewUrl } : {}),
    ...(renditions[0] ? { downloadUrl: renditions[0].url } : {}),
    acquisition: "direct",
    media,
    ...(renditions.length ? { renditions } : {}),
    tags,
    rights,
    cost: { status: "free", quotaNote },
  });
}

const validQuery = (query: string) => {
  if (query.length > 100)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pixabay queries are limited to 100 characters." });
  return query;
};

function params(query: StockQuery, ctx: StockContext, notes: string[]) {
  const video = query.kind === "video";
  // Pixabay accepts 3..200 per page; smaller requests ask for 3 and are trimmed.
  const out = new URLSearchParams({
    key: ctx.key(),
    page: String(query.page),
    per_page: String(Math.max(3, query.limit)),
  });
  if (query.query.trim()) out.set("q", validQuery(query.query.trim()));
  if (query.lang) out.set("lang", query.lang);
  if (query.category) out.set("category", query.category);
  if (query.minWidth) out.set("min_width", String(query.minWidth));
  if (query.minHeight) out.set("min_height", String(query.minHeight));
  if (query.editorsChoice) out.set("editors_choice", "true");
  if (query.safe) out.set("safesearch", "true");
  if (query.order && query.order !== "relevant") out.set("order", query.order);
  if (video) {
    if (query.videoType) out.set("video_type", query.videoType);
    if (query.orientation) notes.push("Pixabay video search has no orientation filter; ranked by aspect instead.");
    if (query.color) notes.push("Pixabay video search has no colour filter.");
  } else {
    out.set("image_type", query.imageType ?? "photo");
    if (query.orientation === "portrait") out.set("orientation", "vertical");
    else if (query.orientation === "landscape") out.set("orientation", "horizontal");
    else if (query.orientation === "square") notes.push("Pixabay has no square filter; ranked by aspect instead.");
    if (query.color) {
      const colour = COLOURS[query.color];
      if (colour) out.set("colors", colour);
      else notes.push(`Pixabay cannot filter colour "${query.color}".`);
    }
  }
  return out;
}

export const pixabay: StockAdapter = {
  id: "pixabay",
  kinds: ["image", "video"],
  keyEnv: "PIXABAY_API_KEY",
  native: [
    "orientation",
    "color",
    "safe",
    "minWidth",
    "minHeight",
    "imageType",
    "videoType",
    "category",
    "editorsChoice",
    "order",
    "lang",
  ],
  async search(query, ctx) {
    const notes: string[] = [];
    if (query.author) notes.push("Pixabay has no author search; results are filtered to the author locally.");
    if (query.collections?.length || query.topic) notes.push("Collections and topics are Unsplash filters; ignored.");
    const search = params(query, ctx, notes);
    const data = await ctx.http.json(`${PIXABAY_API}${query.kind === "video" ? "videos/" : ""}?${search}`);
    let candidates = (Array.isArray(data.hits) ? data.hits : []).map((item: any) =>
      normalise(item, query.kind, ctx.now()),
    );
    if (query.author) candidates = candidates.filter((item: ResourceCandidate) => item.authorId === query.author);
    return { candidates: candidates.slice(0, query.limit), notes };
  },
  async inspect(candidate, ctx) {
    const kind = candidate.kind === "video" ? "video" : "image";
    const id = candidate.id.split(":").at(-1)!;
    if (!/^\d+$/.test(id)) throw new CliErrorObject({ code: "INVALID_INPUT", message: "Invalid Pixabay id." });
    const search = new URLSearchParams({ key: ctx.key(), id });
    const data = await ctx.http.json(`${PIXABAY_API}${kind === "video" ? "videos/" : ""}?${search}`, { fresh: true });
    const hit = Array.isArray(data.hits) ? data.hits[0] : undefined;
    if (!hit) throw new CliErrorObject({ code: "VALIDATION", message: "Pixabay item was not found." });
    return normalise(hit, kind, ctx.now());
  },
  resolveDownload(candidate, target) {
    const rendition = pickRendition(candidate.renditions ?? [], target);
    if (!rendition) throw new CliErrorObject({ code: "VALIDATION", message: "Pixabay item has no downloadable file." });
    return { url: rendition.url, media: { width: rendition.width, height: rendition.height } };
  },
};
