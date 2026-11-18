import { classifyTrackLicence, type TrackLicence } from "./licence";
import type { MusicHttp } from "./http";
import { isAllowedHost } from "./http";
import { incompetechStillListed, INCOMPETECH_LICENCE, searchIncompetech } from "./incompetech";
import { openverseLicence, openverseParams } from "../resources/openverse";
import type { MusicBrief, MusicHit, ProviderStatus } from "./types";

export type StockQuery = {
  query: string;
  mood?: string;
  minDurationSec?: number;
  commercial: boolean;
  limit: number;
  brief?: MusicBrief;
};
export type Credentials = { freesound?: string; freesoundOAuth?: string; jamendo?: string };
export type ProviderResult = { status: ProviderStatus; hits: MusicHit[] };
type Json = Record<string, any>;

const terms = (query: StockQuery) =>
  `${query.query} ${query.mood ?? ""}`
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1);
const looksInstrumental = (words: string[]): MusicHit["instrumental"] => {
  const joined = words.join(" ").toLowerCase();
  if (/\binstrumentals?\b|\bno vocals?\b/.test(joined)) return "yes";
  if (/\bvocals?\b|\bsinger\b|\bsongwriter\b|\bfeat\b|\blyrics?\b|\brap\b/.test(joined)) return "no";
  return "unknown";
};
const seconds = (value: unknown): number | undefined => {
  const text = String(value ?? "").trim();
  if (/^\d+:\d{1,2}(:\d{1,2})?$/.test(text))
    return text.split(":").reduce((sum, part) => sum * 60 + Number(part), 0) || undefined;
  const number = Number(text);
  return Number.isFinite(number) && number > 0 ? number : undefined;
};
const only = (url: unknown) => (typeof url === "string" && url && isAllowedHost(url) ? url : undefined);
const present = <T>(value: T | undefined): value is T => value !== undefined;

const JAMENDO_NOTE =
  "Hosted on Jamendo, whose free API tier is non-commercial. Commercial use needs Jamendo Licensing or the artist's written confirmation, then --confirm-licence-url.";
const jamendoCommercial = (read: TrackLicence): TrackLicence => ({
  ...read,
  licence: { ...read.licence, commercial: read.licence.commercial === "yes" ? "unknown" : read.licence.commercial },
});

// --- Openverse: an aggregator, so its licence field never counts as verified at source ---

export function openverseHit(item: Json): MusicHit {
  const title = String(item.title ?? "Untitled"),
    creator = item.creator ? String(item.creator) : undefined;
  const sourceUrl = String(item.foreign_landing_url),
    origin = String(item.source ?? item.provider ?? "unknown");
  const tags: string[] = [
    ...(item.tags ?? []).map((tag: Json | string) => (typeof tag === "string" ? tag : String(tag.name))),
    ...(item.genres ?? []),
  ];
  const read = classifyTrackLicence({
    licence: openverseLicence(item),
    url: item.license_url,
    title,
    creator,
    sourceUrl,
  });
  // A Jamendo track is treated the same however it was reached; see jamendoHit.
  const viaJamendo = origin === "jamendo";
  const licence = viaJamendo ? jamendoCommercial(read) : read;
  const fileUrl = only(item.url),
    preview = origin === "freesound";
  return {
    id: `openverse:${item.id}`,
    route: "free-stock",
    provider: "openverse",
    title,
    ...(creator ? { creator } : {}),
    sourceUrl,
    ...(item.duration ? { durationSec: Number(item.duration) / 1000 } : {}),
    ...licence,
    ...(fileUrl ? { previewUrl: fileUrl } : {}),
    ...(fileUrl && !preview ? { originalUrl: fileUrl } : {}),
    acquisition: preview ? "oauth" : fileUrl ? "direct" : "manual",
    ...(viaJamendo
      ? { acquisitionNote: JAMENDO_NOTE }
      : fileUrl
        ? {}
        : { acquisitionNote: "Host is not on the allowlist; download from the source page." }),
    instrumental: looksInstrumental([title, ...tags]),
    tags,
    sourceVerified: false,
    origin,
  };
}

/** Openverse and Freesound require every word to match, so a long query falls back to fewer words. Ranking then judges the rest. */
const broadened = (query: string) => {
  const words = query.split(/\s+/).filter(Boolean);
  return [...new Set([query, words.slice(0, 2).join(" "), words[0] ?? query])];
};

async function openverse(http: MusicHttp, query: StockQuery): Promise<MusicHit[]> {
  for (const q of broadened(query.query)) {
    const params = openverseParams({
      query: q,
      kind: "audio",
      limit: Math.min(20, query.limit * 2),
      commercial: query.commercial,
      openverse: { category: "music" },
    });
    const data = await http.json<Json>(`https://api.openverse.org/v1/audio/?${params}`);
    if (data.results?.length) return data.results.map(openverseHit);
  }
  return [];
}

// --- ccMixter: per-upload licence. Its content host answers 403 to a request that does not
// come from its own pages, so listening and downloading stay on the track page. ---

export function ccmixterHit(item: Json, verifiedAt: string): MusicHit {
  const title = String(item.upload_name),
    creator = String(item.user_real_name ?? item.user_name ?? "") || undefined;
  const sourceUrl = String(item.file_page_url),
    tags = String(item.upload_tags ?? "")
      .split(",")
      .filter(Boolean);
  const duration = seconds(item.files?.[0]?.file_format_info?.ps);
  return {
    id: `ccmixter:${item.upload_id}`,
    route: "free-stock",
    provider: "ccmixter",
    title,
    ...(creator ? { creator } : {}),
    sourceUrl,
    ...(duration ? { durationSec: duration } : {}),
    ...classifyTrackLicence({
      licence: item.license_name,
      url: item.license_url,
      title,
      creator,
      sourceUrl,
      verifiedAt,
    }),
    acquisition: "manual",
    acquisitionNote:
      "ccMixter refuses direct downloads from outside its pages (403). Listen and download on the track page, then pass the file with --source-file.",
    instrumental: "yes",
    tags,
    sourceVerified: true,
  };
}

async function ccmixter(http: MusicHttp, query: StockQuery): Promise<MusicHit[]> {
  // ccMixter repeats the whole body in an x-json response header, and fetch refuses headers over
  // 16 KB. Four rows at a time stay under that; a page that still overflows ends the list.
  const rows: Json[] = [];
  const pageSize = 4,
    pages = Math.min(3, Math.ceil(query.limit / pageSize));
  for (let page = 0; page < pages; page++) {
    const params = new URLSearchParams({
      f: "json",
      search: terms(query).join(" "),
      search_type: "any",
      tags: "instrumental",
      sort: "rank",
      limit: String(pageSize),
      offset: String(page * pageSize),
    });
    try {
      const batch = await http.json<Json[]>(`https://ccmixter.org/api/query?${params}`);
      rows.push(...batch);
      if (batch.length < pageSize) break;
    } catch (error) {
      if (!rows.length) throw error;
      break;
    }
  }
  const now = http.now();
  return rows.map((item) => ccmixterHit(item, now));
}

// --- Internet Archive: licence is on each item's metadata, so every hit reads it ---

export function archiveItemHit(
  identifier: string,
  meta: Json,
  minDurationSec: number,
  verifiedAt: string,
): MusicHit | undefined {
  const info: Json = meta.metadata ?? {};
  const file = (meta.files ?? []).find(
    (entry: Json) =>
      /mp3/i.test(String(entry.format)) &&
      entry.source !== "metadata" &&
      (seconds(entry.length) ?? Infinity) >= minDurationSec,
  );
  if (!file || !meta.server || !meta.dir) return undefined;
  const album = String(info.title ?? identifier),
    track = String(file.title ?? String(file.name).replace(/\.[^.]+$/, ""));
  const creator = [info.creator].flat()[0] ? String([info.creator].flat()[0]) : undefined;
  const sourceUrl = `https://archive.org/details/${identifier}`;
  const tags = [info.subject]
    .flat()
    .filter(Boolean)
    .flatMap((subject) => String(subject).split(/[;/]/))
    .map((tag) => tag.trim())
    .filter(Boolean);
  const url = `https://${meta.server}${String(meta.dir).split("/").map(encodeURIComponent).join("/")}/${encodeURIComponent(String(file.name))}`;
  const allowed = isAllowedHost(url);
  const title = `${track} (${album})`;
  return {
    id: `internet-archive:${identifier}:${String(file.name)}`,
    route: "free-stock",
    provider: "internet-archive",
    title,
    ...(creator ? { creator } : {}),
    sourceUrl,
    ...(seconds(file.length) ? { durationSec: seconds(file.length) } : {}),
    ...classifyTrackLicence({ url: info.licenseurl, title, creator, sourceUrl, verifiedAt }),
    ...(allowed ? { previewUrl: url, originalUrl: url } : {}),
    acquisition: allowed ? "direct" : "manual",
    instrumental: looksInstrumental([title, ...tags]),
    tags,
    sourceVerified: true,
  };
}

async function internetArchive(http: MusicHttp, query: StockQuery): Promise<MusicHit[]> {
  const words = terms(query)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
  const excluded = query.commercial ? " AND NOT licenseurl:*-nc* AND NOT licenseurl:*-nd*" : "";
  const params = new URLSearchParams({
    q: `collection:netlabels AND (${words.join(" OR ")}) AND licenseurl:*creativecommons.org*${excluded}`,
    rows: String(Math.min(8, query.limit)),
    output: "json",
  });
  for (const field of ["identifier", "title", "licenseurl"]) params.append("fl[]", field);
  const search = await http.json<Json>(`https://archive.org/advancedsearch.php?${params}`);
  const now = http.now();
  const rows = await Promise.all(
    (search.response?.docs ?? []).map(async (doc: Json) =>
      archiveItemHit(
        String(doc.identifier),
        await http.json<Json>(`https://archive.org/metadata/${encodeURIComponent(String(doc.identifier))}`),
        query.minDurationSec ?? 0,
        now,
      ),
    ),
  );
  return (rows as (MusicHit | undefined)[]).filter(present);
}

// --- Freesound: per-sound licence. A preview needs only the key; the original needs OAuth ---

export function freesoundHit(item: Json, verifiedAt: string): MusicHit {
  const title = String(item.name),
    creator = item.username ? String(item.username) : undefined,
    sourceUrl = String(item.url);
  const tags: string[] = item.tags ?? [];
  return {
    id: `freesound:${item.id}`,
    route: "free-stock",
    provider: "freesound",
    title,
    ...(creator ? { creator } : {}),
    sourceUrl,
    ...(item.duration ? { durationSec: Number(item.duration) } : {}),
    ...classifyTrackLicence({ url: item.license, title, creator, sourceUrl, verifiedAt }),
    ...(only(item.previews?.["preview-hq-mp3"]) ? { previewUrl: item.previews["preview-hq-mp3"] } : {}),
    acquisition: "oauth",
    acquisitionNote:
      "The original needs FREESOUND_OAUTH_TOKEN, or a manual download from the page passed with --source-file. The preview is compressed and not for delivery.",
    instrumental: looksInstrumental([title, ...tags]),
    tags,
    sourceVerified: true,
    ...(Number(item.bpm) > 0 ? { metadataBpm: Number(item.bpm) } : {}),
  };
}

async function freesound(http: MusicHttp, query: StockQuery, key: string): Promise<MusicHit[]> {
  const filters = [`tag:music`, `duration:[${Math.max(query.minDurationSec ?? 20, 1)} TO *]`];
  if (query.commercial) filters.push('license:("Creative Commons 0" OR "Attribution")');
  const now = http.now();
  // Freesound's analysed tempo: a range filter first, then without it when nothing matches.
  const bpm = query.brief?.bpm,
    tolerance = query.brief?.bpmTolerance ?? 6;
  const tempoFilters = bpm
    ? [[...filters, `bpm:[${Math.floor(bpm - tolerance)} TO ${Math.ceil(bpm + tolerance)}]`], filters]
    : [filters];
  for (const filter of tempoFilters)
    for (const text of broadened(query.query)) {
      const params = new URLSearchParams({
        query: text,
        page_size: String(query.limit),
        fields: "id,name,username,duration,url,previews,license,tags,bpm",
        filter: filter.join(" "),
      });
      const data = await http.json<Json>(`https://freesound.org/apiv2/search/?${params}`, {
        Authorization: `Token ${key}`,
      });
      if (data.results?.length) return data.results.map((item: Json) => freesoundHit(item, now));
    }
  return [];
}

// --- Jamendo: needs the user's own client_id; the free API tier is non-commercial ---

export const JAMENDO_NOT_CONNECTED = {
  message: "Jamendo is not connected: JAMENDO_CLIENT_ID is not set.",
  howToConnect:
    "Create a free application at https://devportal.jamendo.com, then put its client ID in .env as JAMENDO_CLIENT_ID. The free API tier is for non-commercial use, so its tracks stay unknown for commercial films.",
};

export function jamendoHit(item: Json, verifiedAt: string): MusicHit {
  const title = String(item.name),
    creator = item.artist_name ? String(item.artist_name) : undefined;
  const sourceUrl = String(item.shareurl ?? `https://www.jamendo.com/track/${item.id}`);
  const tags: string[] = item.musicinfo?.tags?.genres ?? [];
  const download = item.audiodownload_allowed === false ? undefined : only(item.audiodownload);
  return {
    id: `jamendo:${item.id}`,
    route: "free-stock",
    provider: "jamendo",
    title,
    ...(creator ? { creator } : {}),
    sourceUrl,
    ...(item.duration ? { durationSec: Number(item.duration) } : {}),
    ...jamendoCommercial(classifyTrackLicence({ url: item.license_ccurl, title, creator, sourceUrl, verifiedAt })),
    ...(only(item.audio) ? { previewUrl: item.audio } : {}),
    ...(download ? { originalUrl: download } : {}),
    acquisition: download ? "direct" : "manual",
    acquisitionNote: JAMENDO_NOTE,
    instrumental:
      item.musicinfo?.vocalinstrumental === "instrumental"
        ? "yes"
        : item.musicinfo?.vocalinstrumental === "vocal"
          ? "no"
          : "unknown",
    tags,
    sourceVerified: true,
  };
}

async function jamendo(http: MusicHttp, query: StockQuery, clientId: string): Promise<MusicHit[]> {
  const params = new URLSearchParams({
    client_id: clientId,
    format: "json",
    limit: String(query.limit),
    search: terms(query).join(" "),
    include: "musicinfo licenses",
    audioformat: "mp32",
    order: "relevance",
    vocalinstrumental: "instrumental",
  });
  if (query.minDurationSec) params.set("durationbetween", `${Math.round(query.minDurationSec)}_3600`);
  // Jamendo has no BPM field; its speed bands are the only tempo filter.
  const bpm = query.brief?.bpm;
  if (bpm)
    params.set(
      "speed",
      bpm < 80 ? "verylow" : bpm < 105 ? "low" : bpm < 130 ? "medium" : bpm < 160 ? "high" : "veryhigh",
    );
  const data = await http.json<Json>(`https://api.jamendo.com/v3.0/tracks/?${params}`);
  const now = http.now();
  return (data.results ?? []).map((item: Json) => jamendoHit(item, now));
}

// --- Fan-out: one provider failing never hides the others ---

export async function searchProviders(
  http: MusicHttp,
  query: StockQuery,
  credentials: Credentials,
): Promise<ProviderResult[]> {
  const run = async (provider: string, work: () => Promise<MusicHit[]>): Promise<ProviderResult> => {
    try {
      const hits = await work();
      return { status: { provider, status: "ok", count: hits.length }, hits };
    } catch (error) {
      return {
        status: {
          provider,
          status: "failed",
          count: 0,
          message: error instanceof Error ? error.message : String(error),
        },
        hits: [],
      };
    }
  };
  const absent = (provider: string, message: string, howToConnect: string): ProviderResult => ({
    status: { provider, status: "not-connected", count: 0, message, howToConnect },
    hits: [],
  });
  return Promise.all([
    run("openverse", () => openverse(http, query)),
    run("ccmixter", () => ccmixter(http, query)),
    run("internet-archive", () => internetArchive(http, query)),
    run("incompetech", () =>
      searchIncompetech(
        http,
        terms(query).filter((word) => word.length > 2 && !/^\d+$/.test(word) && word !== "bpm"),
        query.brief,
        query.limit,
        query.minDurationSec,
      ),
    ),
    credentials.freesound
      ? run("freesound", () => freesound(http, query, credentials.freesound!))
      : Promise.resolve(
          absent(
            "freesound",
            "FREESOUND_API_KEY is not set.",
            "Create a key at https://freesound.org/apiv2/apply and put it in .env as FREESOUND_API_KEY.",
          ),
        ),
    credentials.jamendo
      ? run("jamendo", () => jamendo(http, query, credentials.jamendo!))
      : Promise.resolve(absent("jamendo", JAMENDO_NOT_CONNECTED.message, JAMENDO_NOT_CONNECTED.howToConnect)),
  ]);
}

// --- Re-read one track's licence from the host just before acquiring ---

export type LicenceRecheck = { verified: true; licence: TrackLicence } | { verified: false; reason: string };

export async function recheckLicence(
  http: MusicHttp,
  hit: MusicHit,
  credentials: Credentials,
): Promise<LicenceRecheck> {
  const originId = hit.id.slice(hit.id.indexOf(":") + 1);
  const common = { title: hit.title, creator: hit.creator, sourceUrl: hit.sourceUrl ?? "", verifiedAt: http.now() };
  const viaFreesound = async (id: string): Promise<LicenceRecheck> => {
    if (!credentials.freesound)
      return {
        verified: false,
        reason: "FREESOUND_API_KEY is not set, so the licence cannot be re-read at Freesound.",
      };
    const item = await http.json<Json>(`https://freesound.org/apiv2/sounds/${encodeURIComponent(id)}/?fields=license`, {
      Authorization: `Token ${credentials.freesound}`,
    });
    return { verified: true, licence: classifyTrackLicence({ ...common, url: item.license }) };
  };
  const viaJamendo = async (id: string): Promise<LicenceRecheck> => {
    if (!credentials.jamendo)
      return {
        verified: false,
        reason: `${JAMENDO_NOT_CONNECTED.message} ${JAMENDO_NOT_CONNECTED.howToConnect} Or check the licence on the track page and pass --confirm-licence-url.`,
      };
    const data = await http.json<Json>(
      `https://api.jamendo.com/v3.0/tracks/?${new URLSearchParams({ client_id: credentials.jamendo, format: "json", id })}`,
    );
    const item = data.results?.[0];
    if (!item) return { verified: false, reason: "Jamendo no longer lists this track." };
    return { verified: true, licence: jamendoCommercial(classifyTrackLicence({ ...common, url: item.license_ccurl })) };
  };
  if (hit.provider === "ccmixter") {
    const [item] = await http.json<Json[]>(
      `https://ccmixter.org/api/query?${new URLSearchParams({ f: "json", ids: originId })}`,
    );
    return item
      ? {
          verified: true,
          licence: classifyTrackLicence({ ...common, licence: item.license_name, url: item.license_url }),
        }
      : { verified: false, reason: "ccMixter no longer lists this upload." };
  }
  if (hit.provider === "internet-archive") {
    const meta = await http.json<Json>(
      `https://archive.org/metadata/${encodeURIComponent(originId.split(":")[0]!)}/metadata`,
    );
    return { verified: true, licence: classifyTrackLicence({ ...common, url: meta.result?.licenseurl }) };
  }
  if (hit.provider === "incompetech")
    return (await incompetechStillListed(http, originId))
      ? { verified: true, licence: classifyTrackLicence({ ...common, licence: "CC BY 4.0", url: INCOMPETECH_LICENCE }) }
      : { verified: false, reason: "Incompetech's catalogue no longer lists this piece." };
  if (hit.provider === "freesound") return viaFreesound(originId);
  if (hit.provider === "jamendo") return viaJamendo(originId);
  if (hit.provider === "openverse" && hit.origin === "freesound") {
    const id = hit.sourceUrl?.match(/\/sounds\/(\d+)/)?.[1];
    if (id) return viaFreesound(id);
  }
  if (hit.provider === "openverse" && hit.origin === "jamendo") {
    const id = hit.sourceUrl?.match(/\/track\/(\d+)/)?.[1];
    if (id) return viaJamendo(id);
  }
  return {
    verified: false,
    reason: `${hit.provider} is an aggregator and its source (${hit.origin ?? "unknown"}) has no adapter. Check the licence on the track page and pass --confirm-licence-url.`,
  };
}
