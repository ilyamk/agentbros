import { CliErrorObject } from "../cli";
import type { MusicHttp } from "./http";
import { isAllowedHost } from "./http";
import {
  MusicSearchFileSchema,
  TRENDING_NOTICE,
  type MusicHit,
  type MusicSearchFile,
  type ProviderStatus,
} from "./types";

type Json = Record<string, any>;

const NATIVE_LICENCE: MusicHit["licence"] = { code: "platform-native-only", commercial: "no" };
const NATIVE_NOTE = "Chart metadata and a 30 s preview. Not licensed for embedding; add the sound on the platform.";

function chartHit(input: {
  id: string;
  provider: string;
  title: string;
  creator?: string;
  sourceUrl?: string;
  durationSec?: number;
  previewUrl?: string;
  chart?: MusicHit["chart"];
}): MusicHit {
  const { chart, previewUrl, ...rest } = input;
  return {
    ...rest,
    route: "trending-native",
    licence: NATIVE_LICENCE,
    ...(previewUrl && isAllowedHost(previewUrl) ? { previewUrl } : {}),
    acquisition: "native-platform",
    acquisitionNote: NATIVE_NOTE,
    instrumental: "unknown",
    tags: [],
    sourceVerified: false,
    syncAllowed: false,
    shareAlike: false,
    ...(chart ? { chart, why: `No. ${chart.position} on ${chart.provider} (${chart.scope})` } : {}),
  };
}

export const deezerHit = (item: Json, chart?: MusicHit["chart"]) =>
  chartHit({
    id: `deezer:${item.id}`,
    provider: "deezer",
    title: String(item.title),
    creator: item.artist?.name,
    sourceUrl: item.link,
    durationSec: item.duration || undefined,
    previewUrl: item.preview || undefined,
    chart,
  });

export const itunesHit = (item: Json, chart?: MusicHit["chart"]) =>
  chartHit({
    id: `itunes:${item.trackId}`,
    provider: "itunes",
    title: String(item.trackName),
    creator: item.artistName,
    sourceUrl: item.trackViewUrl,
    durationSec: item.trackTimeMillis ? item.trackTimeMillis / 1000 : undefined,
    previewUrl: item.previewUrl,
    chart,
  });

/** Deezer's keyless chart is global: there is no per-country chart without an account. */
async function deezerChart(http: MusicHttp, limit: number): Promise<MusicHit[]> {
  const data = await http.json<Json>(`https://api.deezer.com/chart/0/tracks?limit=${limit}`);
  return (data.data ?? []).map((item: Json, index: number) =>
    deezerHit(item, { provider: "deezer", position: index + 1, scope: "global chart" }),
  );
}

async function appleChart(http: MusicHttp, market: string, limit: number): Promise<MusicHit[]> {
  const feed = await http.json<Json>(
    `https://rss.applemarketingtools.com/api/v2/${market}/music/most-played/${limit}/songs.json`,
  );
  const ids: string[] = (feed.feed?.results ?? []).map((item: Json) => String(item.id));
  if (!ids.length) return [];
  const lookup = await http.json<Json>(
    `https://itunes.apple.com/lookup?${new URLSearchParams({ id: ids.join(","), country: market, entity: "song" })}`,
  );
  const byId = new Map<string, Json>(
    (lookup.results ?? [])
      .filter((item: Json) => item.kind === "song")
      .map((item: Json) => [String(item.trackId), item]),
  );
  return ids.flatMap((id, index) => {
    const item = byId.get(id);
    return item ? [itunesHit(item, { provider: "itunes", position: index + 1, scope: `most played, ${market}` })] : [];
  });
}

const normal = (text: string) =>
  text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export function parseNames(raw: string): { artist?: string; title: string; raw: string }[] {
  return raw
    .split(/[;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const match = item.match(/^(.+?)\s+[-–—]\s+(.+)$/);
      return match ? { artist: match[1]!.trim(), title: match[2]!.trim(), raw: item } : { title: item, raw: item };
    });
}

function matches(wanted: { artist?: string; title: string }, title: unknown, artist: unknown): boolean {
  const titleHit =
    normal(String(title ?? "")).includes(normal(wanted.title)) ||
    normal(wanted.title).includes(normal(String(title ?? "")));
  const artistText = normal(String(artist ?? ""));
  const artistHit =
    !wanted.artist || artistText.includes(normal(wanted.artist)) || normal(wanted.artist).includes(artistText);
  return Boolean(titleHit && artistHit && normal(String(title ?? "")));
}

/** Names pasted from TikTok Creative Center or the app. A plain query, because Deezer's field syntax misses bracketed titles. */
async function findNamed(
  http: MusicHttp,
  name: ReturnType<typeof parseNames>[number],
  market: string,
): Promise<MusicHit | undefined> {
  const term = `${name.artist ?? ""} ${name.title}`.trim();
  try {
    const data = await http.json<Json>(
      `https://api.deezer.com/search?${new URLSearchParams({ q: term, limit: "10" })}`,
    );
    const item = (data.data ?? []).find((row: Json) => row.preview && matches(name, row.title, row.artist?.name));
    if (item) return deezerHit(item);
  } catch {
    /* iTunes below is the second chance. */
  }
  const data = await http.json<Json>(
    `https://itunes.apple.com/search?${new URLSearchParams({ term, entity: "song", limit: "10", country: market })}`,
  );
  const item = (data.results ?? []).find((row: Json) => row.previewUrl && matches(name, row.trackName, row.artistName));
  return item ? itunesHit(item) : undefined;
}

export async function searchTrending(
  http: MusicHttp,
  options: { market: string; limit: number; names?: string },
): Promise<MusicSearchFile> {
  const market = options.market.toLowerCase();
  if (!/^[a-z]{2}$/.test(market))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "--market must be a two-letter country code, e.g. gb.",
    });
  const providers: ProviderStatus[] = [];
  const attempt = async (provider: string, work: () => Promise<MusicHit[]>): Promise<MusicHit[]> => {
    try {
      const hits = await work();
      providers.push({ provider, status: "ok", count: hits.length });
      return hits;
    } catch (error) {
      providers.push({
        provider,
        status: "failed",
        count: 0,
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  };
  let candidates: MusicHit[] = [];
  const unmatched: string[] = [];
  if (options.names) {
    const names = parseNames(options.names);
    if (!names.length)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: '--names needs "Artist - Title; Artist - Title".' });
    candidates = await attempt("names", async () => {
      const found: MusicHit[] = [];
      for (const name of names) {
        const hit = await findNamed(http, name, market);
        if (hit) found.push({ ...hit, why: `Named by the user: ${name.raw}` });
        else unmatched.push(name.raw);
      }
      return found;
    });
  } else {
    const [deezer, apple] = await Promise.all([
      attempt("deezer", () => deezerChart(http, options.limit)),
      attempt("itunes", () => appleChart(http, market, options.limit)),
    ]);
    const seen = new Set<string>();
    // Interleaved, so the top of both charts reaches a short list.
    candidates = Array.from({ length: Math.max(deezer.length, apple.length) }, (_, index) => [
      deezer[index],
      apple[index],
    ])
      .flat()
      .filter((hit): hit is MusicHit => {
        if (!hit) return false;
        const key = `${normal(hit.creator ?? "").split(" ")[0]}|${normal(hit.title)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }
  return MusicSearchFileSchema.parse({
    schemaVersion: 1,
    kind: "trending",
    brief: options.names ? `named tracks: ${options.names}` : `charts, market ${market}`,
    notice: TRENDING_NOTICE,
    providers,
    unmatched,
    candidates,
  });
}
