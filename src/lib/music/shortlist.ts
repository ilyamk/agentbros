import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MusicShortlistSchema, type MusicCandidate } from "../../types/film";
import { emitProgress } from "../cli";
import { BACKGROUND, MUTED, RgbImage, TEXT } from "../vision/image";
import { renderWaveform, writeImage } from "../vision/media";
import type { MusicHttp } from "./http";
import { CANNOT_HEAR_NOTICE, MUSIC_PATHS, MusicSearchFileSchema, TRENDING_NOTICE, type MusicHit } from "./types";

/** Routes a search file produces; anything else on the shortlist came from elsewhere. */
const SEARCH_ROUTES = new Set(["free-stock", "trending-native", "reference-track"]);

export type AudioMapResult = { available: true; path: string } | { available: false; reason: string };

/** A1 builds scripts/audio-map.ts. Called as a process so this works before and after that merges. */
export function runAudioMap(input: string, output: string, root = process.cwd()): AudioMapResult {
  const script = path.join(root, "scripts/audio-map.ts");
  if (!existsSync(script))
    return { available: false, reason: "not available: scripts/audio-map.ts is not in this checkout" };
  const tsx = path.join(root, "node_modules/.bin/tsx");
  const result = spawnSync(tsx, [script, "--input", input, "--output", output], {
    cwd: root,
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0 || !existsSync(output))
    return {
      available: false,
      reason: `audio-map failed: ${(result.stdout || result.stderr || "no output").slice(-300)}`,
    };
  return { available: true, path: output };
}

const fileName = (hit: MusicHit) => hit.id.replace(/[^a-zA-Z0-9-]+/g, "_").slice(0, 80);
const EXTENSIONS: Record<string, string> = {
  mp3: "mp3",
  aac: "m4a",
  vorbis: "ogg",
  opus: "ogg",
  flac: "flac",
  pcm_s16le: "wav",
};

function probeAudio(file: string): { codec: string; durationSec: number } | undefined {
  const result = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=codec_name:format=duration",
      "-of",
      "json",
      file,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  if (result.status !== 0) return undefined;
  const data = JSON.parse(result.stdout) as { streams?: { codec_name?: string }[]; format?: { duration?: string } };
  const codec = data.streams?.[0]?.codec_name,
    durationSec = Number(data.format?.duration);
  return codec && durationSec > 0 ? { codec, durationSec } : undefined;
}

/** Deezer signs its preview links, so a stale one is resolved again from the track id. */
async function fetchPreview(http: MusicHttp, hit: MusicHit): Promise<Buffer> {
  try {
    return await http.bytes(hit.previewUrl!);
  } catch (error) {
    if (hit.provider !== "deezer") throw error;
    const fresh = await http.json<{ preview?: string }>(`https://api.deezer.com/track/${hit.id.split(":")[1]}`);
    if (!fresh.preview) throw error;
    return http.bytes(fresh.preview);
  }
}

export async function downloadPreview(
  http: MusicHttp,
  projectDir: string,
  hit: MusicHit,
): Promise<{ relative: string; durationSec: number }> {
  const directory = path.join(projectDir, MUSIC_PATHS.candidates);
  mkdirSync(directory, { recursive: true });
  const partial = path.join(directory, `${fileName(hit)}.part`);
  writeFileSync(partial, await fetchPreview(http, hit));
  const probe = probeAudio(partial);
  if (!probe) {
    rmSync(partial, { force: true });
    throw new Error("the download is not readable audio");
  }
  const relative = path.join(MUSIC_PATHS.candidates, `${fileName(hit)}.${EXTENSIONS[probe.codec] ?? "bin"}`);
  renameSync(partial, path.join(projectDir, relative));
  return { relative, durationSec: probe.durationSec };
}

function energyBars(file: string, width: number): number[] {
  const rate = 8000;
  const result = spawnSync(
    "ffmpeg",
    ["-v", "error", "-nostdin", "-i", file, "-ac", "1", "-ar", String(rate), "-f", "f32le", "pipe:1"],
    { maxBuffer: 256 * 1024 * 1024, timeout: 120_000 },
  );
  if (result.status !== 0 || !result.stdout?.length) return Array.from({ length: width }, () => 0);
  const samples = new Float32Array(
    result.stdout.buffer,
    result.stdout.byteOffset,
    Math.floor(result.stdout.byteLength / 4),
  );
  return Array.from({ length: width }, (_, column) => {
    const start = Math.floor((column / width) * samples.length),
      end = Math.max(start + 1, Math.floor(((column + 1) / width) * samples.length));
    let sum = 0;
    for (let index = start; index < end; index++) sum += samples[index]! * samples[index]!;
    return Math.sqrt(sum / (end - start));
  });
}

/** One PNG: for each candidate its label, waveform and loudness over time, on a shared energy scale. */
export function drawContactSheet(
  projectDir: string,
  rows: { candidate: MusicCandidate; durationSec: number; audioMap: string }[],
  output: string,
): string {
  const width = 1400,
    gutter = 20,
    inner = width - gutter * 2,
    waveHeight = 70,
    energyHeight = 44,
    header = 42,
    rowHeight = 18 + 16 + waveHeight + 4 + energyHeight + 22;
  const sheet = new RgbImage(width, header + rowHeight * rows.length);
  sheet.fillRect(0, 0, sheet.width, sheet.height, BACKGROUND);
  sheet.drawText(
    "MUSIC SHORTLIST: WAVEFORM ABOVE, ENERGY BELOW. AGENTS CANNOT HEAR: CHOOSE BY EAR",
    gutter,
    14,
    2,
    TEXT,
  );
  const bars = rows.map((row) => energyBars(path.join(projectDir, row.candidate.previewPath!), inner));
  const peak = Math.max(1e-6, ...bars.flat());
  rows.forEach((row, index) => {
    const top = header + rowHeight * index,
      { candidate } = row;
    sheet.drawText(
      `${index + 1}. ${candidate.title} - ${candidate.creator ?? "UNKNOWN"}`.slice(0, 110),
      gutter,
      top,
      2,
      TEXT,
    );
    sheet.drawText(
      [
        candidate.provider,
        candidate.route,
        candidate.licence.code,
        `COMMERCIAL ${candidate.licence.commercial}`,
        `${row.durationSec.toFixed(1)} S`,
        row.audioMap,
      ]
        .join(" - ")
        .slice(0, 170),
      gutter,
      top + 18,
      1,
      MUTED,
    );
    sheet.blit(
      renderWaveform(path.join(projectDir, candidate.previewPath!), row.durationSec, inner, waveHeight),
      gutter,
      top + 34,
    );
    const base = top + 34 + waveHeight + 4 + energyHeight;
    bars[index]!.forEach((value, column) => {
      const height = Math.round((value / peak) * energyHeight);
      if (height)
        sheet.fillRect(gutter + column, base - height, 1, height, [
          120 + Math.round((value / peak) * 135),
          170,
          90,
        ] as const);
    });
  });
  return writeImage(sheet, output);
}

export async function buildShortlist(
  http: MusicHttp,
  projectDir: string,
  options: { from: string[]; top: number; brief?: string; repositoryRoot?: string },
) {
  const chosen: { candidate: MusicCandidate; durationSec: number; audioMap: string }[] = [];
  const skipped: { id: string; title: string; reason: string; listenAt?: string }[] = [];
  const audioMaps: { id: string; status: string }[] = [];
  const briefs: string[] = [];
  const fits: Record<string, unknown>[] = [];
  let musicBrief: unknown;
  let trending = false;
  for (const fromFile of options.from) {
    const file = MusicSearchFileSchema.parse(JSON.parse(readFileSync(fromFile, "utf8")));
    briefs.push(file.brief);
    musicBrief ??= file.musicBrief;
    let taken = 0;
    for (const hit of file.candidates) {
      if (taken >= options.top) break;
      let previewPath = hit.previewPath,
        durationSec = hit.durationSec ?? 0;
      if (previewPath && existsSync(path.join(projectDir, previewPath))) {
        durationSec = probeAudio(path.join(projectDir, previewPath))?.durationSec ?? durationSec;
      } else if (hit.previewUrl) {
        try {
          emitProgress(`Preview: ${hit.title}`);
          const download = await downloadPreview(http, projectDir, hit);
          previewPath = download.relative;
          durationSec = download.durationSec;
        } catch (error) {
          skipped.push({
            id: hit.id,
            title: hit.title,
            reason: error instanceof Error ? error.message : String(error),
            ...(hit.sourceUrl ? { listenAt: hit.sourceUrl } : {}),
          });
          continue;
        }
      } else {
        skipped.push({
          id: hit.id,
          title: hit.title,
          reason: hit.acquisitionNote ?? "no preview available",
          ...(hit.sourceUrl ? { listenAt: hit.sourceUrl } : {}),
        });
        continue;
      }
      const absolute = path.join(projectDir, previewPath);
      if (statSync(absolute).size === 0) continue;
      // A search with --analyse has already mapped this preview.
      const mapRelative =
        hit.audioMapPath && existsSync(path.join(projectDir, hit.audioMapPath))
          ? hit.audioMapPath
          : `${previewPath.replace(/\.[^.]+$/, "")}.audio-map.json`;
      const map: AudioMapResult =
        mapRelative === hit.audioMapPath
          ? { available: true, path: path.join(projectDir, mapRelative) }
          : runAudioMap(absolute, path.join(projectDir, mapRelative), options.repositoryRoot);
      audioMaps.push({ id: hit.id, status: map.available ? mapRelative : map.reason });
      const candidate: MusicCandidate = {
        id: hit.id,
        route: hit.route,
        provider: hit.provider,
        title: hit.title,
        previewPath,
        licence: hit.licence,
        ...(hit.creator ? { creator: hit.creator } : {}),
        ...(hit.sourceUrl ? { sourceUrl: hit.sourceUrl } : {}),
        ...(hit.durationSec ? { durationSec: hit.durationSec } : {}),
        ...(hit.originalPath ? { originalPath: hit.originalPath } : {}),
        ...(hit.why ? { why: hit.why } : {}),
        ...(map.available ? { audioMapPath: mapRelative } : {}),
      };
      chosen.push({ candidate, durationSec, audioMap: map.available ? "AUDIO MAP READY" : "AUDIO MAP NOT AVAILABLE" });
      if (hit.fit)
        fits.push({
          id: hit.id,
          title: hit.title,
          provider: hit.provider,
          licence: hit.licence.code,
          score: hit.score,
          previewPath,
          ...(map.available ? { audioMapPath: mapRelative } : {}),
          fit: hit.fit,
        });
      trending ||= hit.route === "trending-native";
      taken++;
    }
  }
  const target = path.join(projectDir, MUSIC_PATHS.shortlist);
  const fitTarget = path.join(projectDir, MUSIC_PATHS.shortlistFit);
  // Entries that no search produces (generated, user-supplied, synth) were added by hand or by another tool: keep them.
  const chosenIds = new Set(chosen.map((row) => row.candidate.id));
  const kept = existsSync(target)
    ? MusicShortlistSchema.parse(JSON.parse(readFileSync(target, "utf8"))).candidates.filter(
        (item) => !SEARCH_ROUTES.has(item.route) && !chosenIds.has(item.id),
      )
    : [];
  const keptIds = new Set(kept.map((item) => item.id));
  const keptFits = existsSync(fitTarget)
    ? ((JSON.parse(readFileSync(fitTarget, "utf8")) as { candidates?: { id: string }[] }).candidates ?? []).filter(
        (item) => keptIds.has(item.id),
      )
    : [];
  const shortlist = MusicShortlistSchema.parse({
    schemaVersion: 1,
    brief: options.brief ?? briefs.join(" | "),
    candidates: [...chosen.map((row) => row.candidate), ...kept],
  });
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(shortlist, null, 2)}\n`);
  const allFits = [...fits, ...keptFits];
  const fitPath = allFits.length ? fitTarget : undefined;
  if (fitPath)
    writeFileSync(
      fitPath,
      `${JSON.stringify({ schemaVersion: 1, brief: shortlist.brief, ...(musicBrief ? { musicBrief } : {}), notice: CANNOT_HEAR_NOTICE, candidates: allFits }, null, 2)}\n`,
    );
  const contactSheet = chosen.length
    ? drawContactSheet(projectDir, chosen, path.join(projectDir, MUSIC_PATHS.contactSheet))
    : undefined;
  return {
    shortlist,
    target,
    contactSheet,
    skipped,
    audioMaps,
    fits,
    kept: kept.map((item) => item.id),
    ...(fitPath ? { fitPath } : {}),
    notice: `${CANNOT_HEAR_NOTICE}${trending ? ` ${TRENDING_NOTICE}` : ""}`,
    listen: chosen.map(({ candidate }, index) => ({
      number: index + 1,
      id: candidate.id,
      title: candidate.title,
      creator: candidate.creator,
      licence: candidate.licence.code,
      commercial: candidate.licence.commercial,
      route: candidate.route,
      file: path.join(projectDir, candidate.previewPath!),
      previewOnly: candidate.route === "trending-native",
    })),
  };
}
