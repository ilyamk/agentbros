import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { readAudioMap } from "../audio-map/analyse";
import { emitProgress } from "../cli";
import { fitFromAudioMap } from "./fit";
import type { MusicHttp } from "./http";
import { downloadPreview } from "./shortlist";
import type { MusicBrief, MusicHit } from "./types";

/** Seconds of each track that are measured. A drop later than this is not found, which keeps a search to minutes. */
export const ANALYSE_SECONDS = 90;

function runAudioMapAsync(input: string, output: string, root: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      path.join(root, "node_modules/.bin/tsx"),
      [path.join(root, "scripts/audio-map.ts"), "--input", input, "--output", output, "--no-image"],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    let text = "";
    child.stdout.on("data", (chunk) => (text += chunk));
    child.stderr.on("data", (chunk) => (text += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 600_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && existsSync(output), detail: text.slice(-300) });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: error.message });
    });
  });
}

/** The first ANALYSE_SECONDS of a long file, copied without re-encoding. */
function head(file: string): string {
  const target = file.replace(/\.[^.]+$/, `.head${ANALYSE_SECONDS}$&`);
  if (existsSync(target)) return target;
  const result = spawnSync(
    "ffmpeg",
    ["-v", "error", "-nostdin", "-y", "-i", file, "-t", String(ANALYSE_SECONDS), "-map", "0:a:0", "-c", "copy", target],
    { encoding: "utf8", timeout: 120_000 },
  );
  return result.status === 0 && existsSync(target) ? target : file;
}

async function pool<T>(items: T[], size: number, work: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item);
    }),
  );
}

/**
 * Downloads each hit's preview into the project, maps its first ANALYSE_SECONDS with the audio-map worker and
 * measures its fit to the brief. A hit that cannot be read keeps its metadata fit and says why.
 */
export async function analyseHits(
  http: MusicHttp,
  projectDir: string,
  hits: MusicHit[],
  brief: MusicBrief,
  options: { concurrency?: number; root?: string } = {},
): Promise<{ hits: MusicHit[]; failures: { id: string; reason: string }[] }> {
  const root = options.root ?? process.cwd();
  const failures: { id: string; reason: string }[] = [];
  const results = new Map<string, MusicHit>();
  await pool(
    hits.filter((hit) => hit.previewUrl || hit.previewPath),
    options.concurrency ?? 3,
    async (hit) => {
      try {
        let previewPath = hit.previewPath,
          lengthSec = hit.durationSec;
        if (!previewPath || !existsSync(path.join(projectDir, previewPath))) {
          emitProgress(`Preview: ${hit.title}`);
          const download = await downloadPreview(http, projectDir, hit);
          previewPath = download.relative;
          lengthSec = download.durationSec;
        }
        const absolute = path.join(projectDir, previewPath);
        const input = (lengthSec ?? 0) > ANALYSE_SECONDS + 5 ? head(absolute) : absolute;
        const mapRelative = `${previewPath.replace(/\.[^.]+$/, "")}.audio-map.json`;
        const mapAbsolute = path.join(projectDir, mapRelative);
        if (!existsSync(mapAbsolute)) {
          emitProgress(`Measuring: ${hit.title}`);
          const run = await runAudioMapAsync(input, mapAbsolute, root);
          if (!run.ok) throw new Error(`audio-map failed: ${run.detail}`);
        }
        const map = readAudioMap(mapAbsolute);
        const wholeTrack = input === absolute;
        // A preview can be shorter than the track (Freesound, Jamendo): the stated length decides whether it loops.
        const fit = fitFromAudioMap(map, brief, {
          wholeTrack: wholeTrack && hit.provider !== "jamendo",
          trackLengthSec: Math.max(hit.durationSec ?? 0, lengthSec ?? 0) || map.source.durationSec,
        });
        results.set(hit.id, { ...hit, previewPath, audioMapPath: mapRelative, fit });
      } catch (error) {
        failures.push({ id: hit.id, reason: error instanceof Error ? error.message : String(error) });
      }
    },
  );
  return { hits: hits.map((hit) => results.get(hit.id) ?? hit), failures };
}
