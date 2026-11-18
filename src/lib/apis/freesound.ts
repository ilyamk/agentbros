/**
 * Freesound API — sound effects & ambient audio
 * Docs: https://freesound.org/docs/api/
 * Rate limit: 2,000 req/day, 60 req/min
 * License: per-sound (filter by CC0 for commercial use)
 */

const BASE_URL = "https://freesound.org/apiv2";

function getKey(): string {
  const key = process.env.FREESOUND_API_KEY;
  if (!key) throw new Error("FREESOUND_API_KEY is not set in .env");
  return key;
}

// --- Types ---

export type FreesoundResult = {
  id: number;
  name: string;
  duration: number; // seconds
  url: string; // page URL
  previews: {
    "preview-hq-mp3": string; // high quality preview (~128kbps)
    "preview-lq-mp3": string; // low quality preview
    "preview-hq-ogg": string;
    "preview-lq-ogg": string;
  };
  license: string; // e.g. "http://creativecommons.org/publicdomain/zero/1.0/"
  tags: string[];
};

type SearchResponse = {
  count: number;
  results: FreesoundResult[];
};

// --- Search ---

/**
 * Search sounds. Use `license:"Creative Commons 0"` in filter for commercial-safe results.
 */
export async function searchSounds(
  query: string,
  options: {
    perPage?: number;
    page?: number;
    commercialOnly?: boolean;
    minDuration?: number;
    maxDuration?: number;
  } = {},
): Promise<SearchResponse> {
  const params = new URLSearchParams({
    query,
    token: getKey(),
    page_size: String(options.perPage ?? 10),
    page: String(options.page ?? 1),
    fields: "id,name,duration,url,previews,license,tags",
  });

  const filters: string[] = [];
  if (options.commercialOnly) {
    filters.push('license:"Creative Commons 0"');
  }
  if (options.minDuration) {
    filters.push(`duration:[${options.minDuration} TO *]`);
  }
  if (options.maxDuration) {
    filters.push(`duration:[* TO ${options.maxDuration}]`);
  }
  if (filters.length > 0) {
    params.set("filter", filters.join(" "));
  }

  const res = await fetch(`${BASE_URL}/search/text/?${params}`);
  if (!res.ok) throw new Error(`Freesound search failed (${res.status}): ${await res.text()}`);
  return res.json();
}

/** Download a preview MP3 (no OAuth needed for previews) */
export async function downloadPreview(sound: FreesoundResult, outputPath: string): Promise<void> {
  const { writeFileSync, mkdirSync, existsSync } = await import("fs");
  const { dirname } = await import("path");

  const dir = dirname(outputPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const url = sound.previews["preview-hq-mp3"];
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  writeFileSync(outputPath, buffer);
}
