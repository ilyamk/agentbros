/**
 * The music decision carries the excerpt the film uses. record cuts it to music/cue.wav from the chosen candidate,
 * with start and duration from the flags or, failing those, from the shortlist's fit or the listening file's name (with
 * none of them, the whole file),
 * and ends it on the nearest downbeat of the candidate's map. Only 5 ms ramps at the edges: a longer fade reads as a drop.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject } from "../cli";
import { AudioMapSchema, MusicShortlistSchema, type MusicCut } from "../../types/film";
import { findMusicCandidate } from "../music/rights-guard";
import { MUSIC_PATHS } from "../music/types";

export const CUE_FILE = "music/cue.wav";
const RAMP_SEC = 0.005;
const SNAP_WINDOW_SEC = 1;

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};
const fileSha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const round3 = (value: number) => Math.round(value * 1000) / 1000;

type Candidate = {
  id: string;
  originalPath?: string | undefined;
  previewPath?: string | undefined;
  audioMapPath?: string | undefined;
};

function candidateFor(projectDir: string, candidateId: string): { candidate: Candidate; index: number } | undefined {
  const shortlist = MusicShortlistSchema.safeParse(readJson(path.join(projectDir, MUSIC_PATHS.shortlist)));
  const index = shortlist.success ? shortlist.data.candidates.findIndex((item) => item.id === candidateId) : -1;
  if (shortlist.success && index >= 0) return { candidate: shortlist.data.candidates[index]!, index };
  const found = findMusicCandidate(projectDir, candidateId);
  return found ? { candidate: found, index: -1 } : undefined;
}

const inProject = (projectDir: string, file: string) => (path.isAbsolute(file) ? file : path.join(projectDir, file));

/** Start and duration the shortlist already chose for this candidate: its fit's offset, or its listening file's name. */
export function cueDefaults(
  projectDir: string,
  candidateId: string,
): { startSec?: number; durationSec?: number; from?: "fit" | "listen" } {
  const fit = readJson(path.join(projectDir, MUSIC_PATHS.shortlistFit)) as
    { musicBrief?: { durationSec?: number }; candidates?: { id: string; fit?: { offsetSec?: number } }[] } | undefined;
  const entry = fit?.candidates?.find((item) => item.id === candidateId);
  if (entry?.fit?.offsetSec !== undefined)
    return {
      startSec: entry.fit.offsetSec,
      ...(fit?.musicBrief?.durationSec ? { durationSec: fit.musicBrief.durationSec } : {}),
      from: "fit",
    };
  const found = candidateFor(projectDir, candidateId);
  const listenDir = path.join(projectDir, "pipeline/music/listen");
  if (found && found.index >= 0 && existsSync(listenDir)) {
    for (const name of readdirSync(listenDir)) {
      const match = /^(\d+)-cue([\d.]+)s-from-([\d.]+)s\.\w+$/.exec(name);
      if (match && Number(match[1]) === found.index + 1)
        return { startSec: Number(match[3]), durationSec: Number(match[2]), from: "listen" };
    }
  }
  return {};
}

function probeDuration(file: string): number {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
    { encoding: "utf8" },
  );
  if (result.error && /ENOENT/.test(result.error.message))
    throw new CliErrorObject({
      code: "FFMPEG_MISSING",
      message: "ffprobe not found. Install it with: brew install ffmpeg",
    });
  const value = Number(result.stdout.trim());
  if (!Number.isFinite(value) || value <= 0)
    throw new CliErrorObject({ code: "VALIDATION", message: `ffprobe could not read the duration of ${file}.` });
  return value;
}

/** The end moved onto the nearest downbeat within a second, when the candidate's map reads this very recording. */
function snapEnd(
  projectDir: string,
  candidate: Candidate,
  sourceDurationSec: number,
  startSec: number,
  endSec: number,
): { endSec: number; endsOn: "downbeat" | "requested"; gridTrust?: string } {
  const map = candidate.audioMapPath
    ? AudioMapSchema.safeParse(readJson(inProject(projectDir, candidate.audioMapPath)))
    : undefined;
  // A shortlist map may read only the preview's first stretch of the same recording: it serves when it covers the end.
  if (!map?.success || map.data.source.durationSec + 0.05 < endSec) return { endSec, endsOn: "requested" };
  const near = map.data.downbeatsSec.filter(
    (time) => time > startSec + 1 && time <= sourceDurationSec && Math.abs(time - endSec) <= SNAP_WINDOW_SEC,
  );
  const best = near.sort((a, b) => Math.abs(a - endSec) - Math.abs(b - endSec))[0];
  return best === undefined
    ? { endSec, endsOn: "requested", gridTrust: map.data.tempo.gridTrust }
    : { endSec: best, endsOn: "downbeat", gridTrust: map.data.tempo.gridTrust };
}

/** Cuts the decision's excerpt to music/cue.wav, deterministically, and describes it. */
export function cutMusic(
  projectDir: string,
  input: { candidateId: string; startSec?: number; durationSec?: number; cutFile?: string },
): MusicCut {
  if (input.cutFile) {
    const file = path.resolve(input.cutFile);
    if (!existsSync(file))
      throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `--cut-file ${input.cutFile} does not exist.` });
    const relative = path.relative(projectDir, file);
    if (relative.startsWith(".."))
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "--cut-file must be inside the project, e.g. music/stitched-<id>.mp3.",
      });
    const sha256 = fileSha(file),
      durationSec = round3(probeDuration(file));
    return {
      file: relative,
      sha256,
      source: { path: relative, sha256 },
      startSec: input.startSec ?? 0,
      durationSec,
      requestedDurationSec: durationSec,
      endsOn: "requested",
      from: "file",
    };
  }
  const found = candidateFor(projectDir, input.candidateId);
  if (!found)
    throw new CliErrorObject({
      code: "FILE_NOT_FOUND",
      message: `Candidate ${input.candidateId} is not on the shortlist or in any search file.`,
    });
  const sourceRelative = found.candidate.originalPath ?? found.candidate.previewPath;
  if (!sourceRelative || !existsSync(inProject(projectDir, sourceRelative)))
    throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `${input.candidateId} has no file on disk to cut.` });
  const source = inProject(projectDir, sourceRelative);
  const defaults = cueDefaults(projectDir, input.candidateId);
  const startSec = input.startSec ?? defaults.startSec ?? 0;
  const sourceDurationSec = probeDuration(source);
  // No offset anywhere (a generated, supplied or synth track): the whole file is the cut.
  const whole = input.startSec === undefined && input.durationSec === undefined && defaults.from === undefined;
  const requested = input.durationSec ?? defaults.durationSec ?? round3(sourceDurationSec - startSec);
  if (startSec >= sourceDurationSec)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `--start ${startSec} is past the end of the track (${round3(sourceDurationSec)} s).`,
    });
  const snapped = snapEnd(
    projectDir,
    found.candidate,
    sourceDurationSec,
    startSec,
    Math.min(startSec + requested, sourceDurationSec),
  );
  const durationSec = round3(snapped.endSec - startSec);
  const output = path.join(projectDir, CUE_FILE);
  mkdirSync(path.dirname(output), { recursive: true });
  const filter = `afade=t=in:d=${RAMP_SEC},afade=t=out:st=${Math.max(0, durationSec - RAMP_SEC).toFixed(4)}:d=${RAMP_SEC}`;
  const args = [
    "-v",
    "error",
    "-nostdin",
    "-y",
    "-ss",
    startSec.toFixed(4),
    "-i",
    source,
    "-t",
    durationSec.toFixed(4),
    "-af",
    filter,
    "-ar",
    "48000",
    "-ac",
    "2",
    "-c:a",
    "pcm_s16le",
    "-map_metadata",
    "-1",
    "-fflags",
    "+bitexact",
    "-flags:a",
    "+bitexact",
    output,
  ];
  const result = spawnSync("ffmpeg", args, { encoding: "utf8", timeout: 120_000 });
  if (result.error && /ENOENT/.test(result.error.message))
    throw new CliErrorObject({
      code: "FFMPEG_MISSING",
      message: "ffmpeg not found. Install it with: brew install ffmpeg",
    });
  if (result.status !== 0)
    throw new CliErrorObject({
      code: "FFMPEG_FAILED",
      message: `ffmpeg could not cut the music: ${result.stderr.trim().slice(-300)}`,
    });
  return {
    file: CUE_FILE,
    sha256: fileSha(output),
    source: { path: path.relative(projectDir, source), sha256: fileSha(source) },
    startSec: round3(startSec),
    durationSec,
    requestedDurationSec: requested,
    endsOn: snapped.endsOn,
    ...(snapped.gridTrust ? { gridTrust: snapped.gridTrust } : {}),
    from: whole
      ? "whole"
      : input.startSec !== undefined || input.durationSec !== undefined
        ? "flags"
        : (defaults.from ?? "flags"),
  };
}
