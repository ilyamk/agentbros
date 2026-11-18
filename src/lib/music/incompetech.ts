import { bpmFit } from "./fit";
import type { MusicHttp } from "./http";
import { classifyTrackLicence } from "./licence";
import type { MusicBrief, MusicHit } from "./types";

// Kevin MacLeod's catalogue: one JSON file with tempo, feel, genre and length for every piece, CC BY 4.0.
export const INCOMPETECH_CATALOGUE = "https://incompetech.com/music/royalty-free/pieces.json";
export const INCOMPETECH_GENRES = "https://incompetech.com/music/royalty-free/genre.json";
export const INCOMPETECH_LICENCE = "https://creativecommons.org/licenses/by/4.0/";
const MP3_BASE = "https://incompetech.com/music/royalty-free/mp3-royaltyfree/";

type Piece = {
  title?: string;
  filename?: string;
  length?: string;
  instruments?: string;
  genre?: string;
  bpm?: string | null;
  description?: string;
  feel?: string;
  isrc?: string;
};

const seconds = (text: string | undefined) =>
  text && /^\d+(:\d+){1,2}$/.test(text) ? text.split(":").reduce((sum, part) => sum * 60 + Number(part), 0) : undefined;
const list = (text: string | undefined) =>
  (text ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

export function incompetechHit(piece: Piece, genres: Record<string, string>, verifiedAt: string): MusicHit | undefined {
  if (!piece.filename || !piece.title) return undefined;
  const title = piece.title,
    creator = "Kevin MacLeod";
  const sourceUrl = piece.isrc
    ? `https://incompetech.com/music/royalty-free/index.html?isrc=${encodeURIComponent(piece.isrc)}`
    : `${MP3_BASE}${encodeURIComponent(piece.filename)}`;
  const url = `${MP3_BASE}${encodeURIComponent(piece.filename)}`;
  const bpm = Number(piece.bpm);
  const durationSec = seconds(piece.length);
  const genre = piece.genre ? genres[piece.genre] : undefined;
  const instruments = list(piece.instruments);
  return {
    id: `incompetech:${piece.isrc ?? piece.filename}`,
    route: "free-stock",
    provider: "incompetech",
    title,
    creator,
    sourceUrl,
    ...(durationSec ? { durationSec } : {}),
    ...classifyTrackLicence({ licence: "CC BY 4.0", url: INCOMPETECH_LICENCE, title, creator, sourceUrl, verifiedAt }),
    previewUrl: url,
    originalUrl: url,
    acquisition: "direct",
    instrumental: instruments.some((item) => /vocal|voice|choir/i.test(item)) ? "unknown" : "yes",
    tags: [
      ...(genre ? [genre] : []),
      ...list(piece.feel),
      ...instruments,
      ...(piece.description ? [piece.description] : []),
    ],
    sourceVerified: true,
    ...(Number.isFinite(bpm) && bpm > 0 ? { metadataBpm: bpm } : {}),
  };
}

/** The whole catalogue is one file, so filtering is local: tempo first when the brief has one, then words. */
export function filterIncompetech(
  hits: MusicHit[],
  words: string[],
  brief: MusicBrief | undefined,
  limit: number,
  minDurationSec = 0,
): MusicHit[] {
  const scored = hits
    .filter((hit) => (hit.durationSec ?? 0) >= Math.max(minDurationSec, brief?.durationSec ?? 0))
    .map((hit) => {
      const haystack = `${hit.title} ${hit.tags.join(" ")}`.toLowerCase();
      const matched = words.filter((word) => haystack.includes(word)).length;
      const tempo = brief?.bpm ? bpmFit(hit.metadataBpm, brief).score : 0;
      return { hit, matched, tempo };
    })
    .filter((row) => (brief?.bpm ? row.tempo > 0 : row.matched > 0));
  return scored
    .sort((a, b) => b.tempo * 3 + b.matched - (a.tempo * 3 + a.matched))
    .slice(0, limit)
    .map((row) => row.hit);
}

export async function searchIncompetech(
  http: MusicHttp,
  words: string[],
  brief: MusicBrief | undefined,
  limit: number,
  minDurationSec?: number,
): Promise<MusicHit[]> {
  const [pieces, genreRows] = await Promise.all([
    http.json<Piece[]>(INCOMPETECH_CATALOGUE),
    http.json<{ id: number; genre: string }[]>(INCOMPETECH_GENRES).catch(() => []),
  ]);
  const genres = Object.fromEntries(genreRows.map((row) => [String(row.id), row.genre]));
  const now = http.now();
  const hits = pieces
    .map((piece) => incompetechHit(piece, genres, now))
    .filter((hit): hit is MusicHit => hit !== undefined);
  return filterIncompetech(hits, words, brief, limit, minDurationSec);
}

/** The catalogue states one licence for every piece; the piece must still be listed. */
export async function incompetechStillListed(http: MusicHttp, id: string): Promise<boolean> {
  const pieces = await http.json<Piece[]>(INCOMPETECH_CATALOGUE);
  return pieces.some((piece) => piece.isrc === id || piece.filename === id);
}
