import { CliErrorObject } from "../../cli";
import { ResourceCandidateSchema, type ResourceCandidate } from "../../../types/resources";
import { rightsFromLicence } from "../rights";
import { downloadSize } from "./resolution";
import { quotaHeaders, type QuotaReader } from "./http";
import type { StockAdapter, StockColour, StockContext, StockQuery } from "./types";

export const UNSPLASH_API = "https://api.unsplash.com/";
/** Referral tag Unsplash asks for on every link back; the app name may not contain "Unsplash". */
export const UNSPLASH_UTM_SOURCE = "agent_bros_pictures";
const LICENCE_URL = "https://unsplash.com/license";
const COLOURS: Partial<Record<StockColour, string>> = {
  black_and_white: "black_and_white",
  black: "black",
  white: "white",
  yellow: "yellow",
  orange: "orange",
  red: "red",
  purple: "purple",
  pink: "magenta",
  green: "green",
  teal: "teal",
  blue: "blue",
};

export function withReferral(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("utm_source", UNSPLASH_UTM_SOURCE);
  parsed.searchParams.set("utm_medium", "referral");
  return parsed.toString();
}

/** Unsplash reports a rolling hourly window without a reset time; assume the full hour. */
export const unsplashQuota: QuotaReader = (headers, now) => {
  const remaining = quotaHeaders.header(headers, "x-ratelimit-remaining");
  if (remaining === undefined) return undefined;
  return {
    remaining,
    limit: quotaHeaders.header(headers, "x-ratelimit-limit"),
    resetAt: now + 60 * 60_000,
    observedAt: now,
  };
};

const headers = (ctx: StockContext) => ({ Authorization: `Client-ID ${ctx.key()}`, "Accept-Version": "v1" });
const trustedImage = (url: string) => {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !/(^|\.)unsplash\.com$/.test(parsed.hostname))
    throw new CliErrorObject({ code: "VALIDATION", message: "Unsplash returned an unexpected image host." });
  return parsed;
};

function normalise(item: any, now: string): ResourceCandidate {
  if (!item?.id || !item.urls?.raw || !item.links?.html)
    throw new CliErrorObject({ code: "VALIDATION", message: "Unsplash photo is missing id, urls or links." });
  const user = item.user ?? {};
  const author = String(user.name ?? user.username ?? "");
  const sourceUrl = withReferral(item.links.html);
  const authorUrl = user.links?.html ? withReferral(user.links.html) : undefined;
  const title = String(item.alt_description ?? item.description ?? `Unsplash photo ${item.id}`).slice(0, 500);
  const rights = rightsFromLicence({
    licence: "Unsplash",
    licenceUrl: LICENCE_URL,
    title,
    author,
    sourceUrl,
    verifiedAtSource: true,
    checkedAsOf: now,
  });
  rights.attributionText = `Photo by ${author || "unknown"} (${authorUrl ?? sourceUrl}) on Unsplash (${withReferral("https://unsplash.com/")}). ${sourceUrl}`;
  const location = item.location
    ? [item.location.name, item.location.city, item.location.country].filter(Boolean).join(", ")
    : "";
  const exif = item.exif ?? {};
  const model = String(exif.model ?? "");
  // Unsplash often repeats the make inside the model ("Canon" + "Canon EOS R5").
  const make = exif.make && !model.toLowerCase().startsWith(String(exif.make).toLowerCase()) ? exif.make : "";
  const camera = [make, model, exif.focal_length && `${exif.focal_length}mm`, exif.aperture && `f/${exif.aperture}`]
    .filter(Boolean)
    .join(" ");
  return ResourceCandidateSchema.parse({
    id: `unsplash:photo:${item.id}`,
    provider: "unsplash",
    kind: "image",
    title,
    sourceUrl,
    author,
    ...(user.username ? { authorId: String(user.username) } : {}),
    ...(authorUrl ? { authorUrl } : {}),
    previewUrl: item.urls.small ?? item.urls.regular,
    thumbnailUrl: item.urls.thumb,
    originalDownloadUrl: trustedImage(item.urls.raw).toString(),
    acquisition: "direct",
    media: { width: item.width, height: item.height },
    ...(/^#[0-9a-fA-F]{6}$/.test(item.color ?? "") || item.blur_hash
      ? {
          visual: {
            ...(/^#[0-9a-fA-F]{6}$/.test(item.color ?? "") ? { dominantColor: item.color } : {}),
            ...(item.blur_hash ? { blurHash: String(item.blur_hash).slice(0, 200) } : {}),
          },
        }
      : {}),
    ...(item.description || location || camera
      ? {
          details: {
            ...(item.description ? { description: String(item.description).slice(0, 5000) } : {}),
            ...(location ? { location: location.slice(0, 500) } : {}),
            ...(camera ? { camera: camera.slice(0, 500) } : {}),
          },
        }
      : {}),
    ...(item.links?.download_location ? { tracking: { downloadLocation: item.links.download_location } } : {}),
    tags: (item.tags ?? []).map((tag: any) => String(tag?.title ?? tag)).filter(Boolean),
    rights,
    cost: {
      status: "free",
      quotaNote: "Unsplash API: 50 requests/hour in demo, 1000 in production; image files do not count.",
    },
  });
}

export const unsplash: StockAdapter = {
  id: "unsplash",
  kinds: ["image"],
  keyEnv: "UNSPLASH_ACCESS_KEY",
  native: ["orientation", "color", "safe", "author", "collections", "topic", "order", "lang"],
  async search(query: StockQuery, ctx) {
    if (query.kind !== "image")
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "Unsplash covers photos only; use Pexels or Pixabay for video.",
      });
    const notes: string[] = [];
    const perPage = Math.min(query.limit, 30);
    if (query.limit > 30) notes.push("Unsplash returns at most 30 results per page.");
    const params = new URLSearchParams({ page: String(query.page), per_page: String(perPage) });
    if (query.orientation) params.set("orientation", query.orientation === "square" ? "squarish" : query.orientation);
    let route: string;
    if (query.author) {
      route = `users/${encodeURIComponent(query.author)}/photos`;
      params.set("order_by", query.order === "latest" ? "latest" : "popular");
      if (query.query.trim())
        notes.push("Author photos are ranked against the query locally; Unsplash does not search within an author.");
    } else if (query.topic) {
      route = `topics/${encodeURIComponent(query.topic)}/photos`;
      params.set("order_by", query.order === "latest" ? "latest" : "popular");
    } else {
      if (!query.query.trim())
        throw new CliErrorObject({
          code: "INVALID_INPUT",
          message: "Unsplash search requires --query, --author or --topic.",
        });
      route = "search/photos";
      params.set("query", query.query);
      params.set("order_by", query.order === "latest" ? "latest" : "relevant");
      params.set("content_filter", query.safe ? "high" : "low");
      if (query.collections?.length) params.set("collections", query.collections.join(","));
      if (query.lang && query.lang !== "en") params.set("lang", query.lang);
    }
    if (query.color) {
      const colour = COLOURS[query.color];
      if (colour && route === "search/photos") params.set("color", colour);
      else notes.push(`Unsplash cannot filter colour "${query.color}" here; ranked by dominant colour instead.`);
    }
    if (query.safe && route !== "search/photos")
      notes.push("Unsplash applies its safe content filter only to keyword search.");
    const data = await ctx.http.json(`${UNSPLASH_API}${route}?${params}`, { headers: headers(ctx) });
    const items: any[] = Array.isArray(data.results) ? data.results : Array.isArray(data.items) ? data.items : [];
    return { candidates: items.map((item) => normalise(item, ctx.now())), notes };
  },
  async inspect(candidate, ctx) {
    const id = candidate.id.split(":").at(-1)!;
    return normalise(
      await ctx.http.json(`${UNSPLASH_API}photos/${encodeURIComponent(id)}`, { headers: headers(ctx), fresh: true }),
      ctx.now(),
    );
  },
  resolveDownload(candidate, target) {
    if (!candidate.originalDownloadUrl || !candidate.media.width || !candidate.media.height)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Unsplash candidate lacks its raw URL or size; inspect it again.",
      });
    const size = downloadSize(
      { width: candidate.media.width, height: candidate.media.height },
      target?.format,
      target?.zoom,
    );
    // Dynamic resizing keeps ixid (required for Unsplash reporting) and never enlarges the original.
    const url = trustedImage(candidate.originalDownloadUrl);
    url.searchParams.set("w", String(size.width));
    url.searchParams.set("fit", "max");
    url.searchParams.set("q", "85");
    url.searchParams.set("fm", "jpg");
    return { url: url.toString(), media: size };
  },
  async onAcquire(candidate, ctx) {
    const location = candidate.tracking?.downloadLocation;
    if (!location)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Unsplash candidate lacks its download tracking link; inspect it again.",
      });
    const parsed = new URL(location);
    if (parsed.protocol !== "https:" || parsed.hostname !== "api.unsplash.com")
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Unsplash download tracking must call api.unsplash.com.",
      });
    await ctx.http.json(parsed.toString(), { headers: headers(ctx), fresh: true });
    parsed.search = "";
    return { endpoint: parsed.toString(), trackedAt: ctx.now(), status: "reported" };
  },
};
