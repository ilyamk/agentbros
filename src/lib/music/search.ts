import { resourceCatalogue } from "../resources/catalogues";
import { analyseHits } from "./analyse";
import { briefIsMeasurable, fitFromMetadata } from "./fit";
import type { MusicHttp } from "./http";
import { commerciallyUsable } from "./licence";
import { searchProviders, type Credentials, type StockQuery } from "./providers";
import { MusicSearchFileSchema, type MusicBrief, type MusicHit, type MusicSearchFile } from "./types";

const landing = (hit: MusicHit) =>
  decodeURIComponent(hit.sourceUrl ?? hit.id)
    .replace(/^https?:\/\/(www\.)?/, "")
    .replace(/\/$/, "")
    .toLowerCase();

/** The same track reached twice: keep the host's own record over the aggregator's copy. */
export function dedupe(hits: MusicHit[]): MusicHit[] {
  const seen = new Map<string, MusicHit>();
  for (const hit of hits) {
    const key = landing(hit),
      prior = seen.get(key);
    if (!prior || (hit.sourceVerified && !prior.sourceVerified)) seen.set(key, hit);
  }
  return [...seen.values()];
}

export function scoreHit(hit: MusicHit, query: StockQuery): { score: number; why: string } {
  const why: string[] = [];
  let score = 0;
  const instrumental = { yes: 3, unknown: 0, no: -4 }[hit.instrumental];
  score += instrumental;
  why.push(`instrumental: ${hit.instrumental}`);
  const haystack = `${hit.title} ${hit.tags.join(" ")}`.toLowerCase();
  const wanted = `${query.query} ${query.mood ?? ""}`
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 2);
  const matched = [...new Set(wanted)].filter((word) => haystack.includes(word));
  score += Math.min(4, matched.length);
  if (matched.length) why.push(`matches ${matched.join(", ")}`);
  if (hit.previewUrl) score += 2;
  else why.push("no automatic preview, listen on the page");
  if (hit.originalUrl && hit.sourceVerified) {
    score += 2;
    why.push("original downloads directly");
  }
  if (hit.sourceVerified) score += 1;
  else why.push("licence read from an aggregator, confirm at source");
  if (hit.licence.code.startsWith("CC0") || hit.licence.code.startsWith("PDM")) score += 2;
  else if (/^CC BY \d/.test(hit.licence.code)) score += 1.5;
  else if (hit.shareAlike) why.push("ShareAlike reaches the film");
  if (!commerciallyUsable(hit)) score -= 3;
  if ((hit.durationSec ?? 0) > 900) {
    score -= 2;
    why.push("long mix or radio show");
  }
  return { score, why: why.join("; ") };
}

/** With a measurable brief the fit leads and the licence and access score breaks ties. */
export function rankHit(hit: MusicHit, query: StockQuery): MusicHit {
  const base = scoreHit(hit, query);
  if (!query.brief || !briefIsMeasurable(query.brief)) return { ...hit, score: base.score, why: base.why };
  const fit = hit.fit?.analysed ? hit.fit : fitFromMetadata(hit, query.brief);
  const score = Math.round((base.score * 0.4 + fit.score) * 100) / 100;
  return { ...hit, fit, score, why: [...fit.notes, base.why].filter(Boolean).join("; ") };
}

const byScore = (a: MusicHit, b: MusicHit) => (b.score ?? 0) - (a.score ?? 0);

/** Measures the top `top` candidates that have a preview, then ranks the whole list again. */
export async function analyseSearch(
  http: MusicHttp,
  projectDir: string,
  file: MusicSearchFile,
  query: StockQuery & { brief: MusicBrief },
  top: number,
  root?: string,
) {
  const measurable = file.candidates.filter((hit) => hit.previewUrl || hit.previewPath).slice(0, top);
  const { hits, failures } = await analyseHits(http, projectDir, measurable, query.brief, {
    ...(root ? { root } : {}),
  });
  const measured = new Map(hits.map((hit) => [hit.id, hit]));
  const candidates = file.candidates
    .map((hit) => rankHit(measured.get(hit.id) ?? hit, query))
    .sort((a, b) => Number(Boolean(b.fit?.analysed)) - Number(Boolean(a.fit?.analysed)) || byScore(a, b));
  return {
    file: MusicSearchFileSchema.parse({ ...file, candidates }),
    failures,
    analysed: hits.filter((hit) => hit.fit?.analysed).length,
  };
}

const MUSIC_MANUAL_ROUTES = ["pixabay-music", "youtube-audio-library", "ncs", "ende-app"];

/** Never trust a filename: this filters on licence fields only, and `unknown` is never allowed. */
export async function searchFreeStock(
  http: MusicHttp,
  query: StockQuery,
  credentials: Credentials,
): Promise<MusicSearchFile & { manualRoutes: unknown[] }> {
  const results = await searchProviders(http, query, credentials);
  const excluded = { licenceUnknown: 0, nonCommercial: 0, noDerivatives: 0, tooShort: 0 };
  const kept = dedupe(results.flatMap((result) => result.hits)).filter((hit) => {
    if (query.minDurationSec && hit.durationSec !== undefined && hit.durationSec < query.minDurationSec)
      return (void excluded.tooShort++, false);
    if (!query.commercial) return true;
    if (hit.licence.commercial === "unknown") return (void excluded.licenceUnknown++, false);
    if (hit.licence.commercial === "no") return (void excluded.nonCommercial++, false);
    if (!hit.syncAllowed) return (void excluded.noDerivatives++, false);
    return true;
  });
  const ranked = kept.map((hit) => rankHit(hit, query)).sort(byScore);
  // No single provider takes more than about a third of the list.
  const cap = Math.max(1, Math.ceil(query.limit / 3)),
    counts = new Map<string, number>(),
    chosen: MusicHit[] = [],
    rest: MusicHit[] = [];
  for (const hit of ranked) {
    const used = counts.get(hit.provider) ?? 0;
    if (chosen.length < query.limit && used < cap) {
      chosen.push(hit);
      counts.set(hit.provider, used + 1);
    } else rest.push(hit);
  }
  chosen.push(...rest.slice(0, Math.max(0, query.limit - chosen.length)));
  const file = MusicSearchFileSchema.parse({
    schemaVersion: 1,
    kind: "free-stock",
    brief: `${query.query}${query.mood ? `; mood: ${query.mood}` : ""}${query.commercial ? "; commercial" : ""}`,
    ...(query.brief ? { musicBrief: query.brief } : {}),
    providers: results.map((result) => result.status),
    excluded,
    candidates: chosen,
  });
  return {
    ...file,
    manualRoutes: MUSIC_MANUAL_ROUTES.map((id) => {
      const { id: provider, catalogUrl, terms, note, instructions } = resourceCatalogue(id, query.query);
      return { provider, catalogUrl, terms, note, instructions };
    }),
  };
}
