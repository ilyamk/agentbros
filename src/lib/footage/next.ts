/**
 * `footage:next`: what to do next when editing a user's own recording. State comes from files only (the source, its
 * transcripts, speech mask, shots, recut request and plan, the created recut, its timeline, renders and shorts);
 * the user's goals live in the source project's `pipeline/footage-goals.json`. Reads only, except saving goals.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { assertPathWithin, validateProjectId } from "../cli";
import { FileMemo } from "../file-memo";
import { quote } from "../pricing";
import { FootageGoalsSchema, type FootageFormat, type FootageGoals } from "../../types/footage-goals";
import { TranscriptSchema } from "../../types/transcript";
import { inferLanguage } from "../speech/transcript";
import {
  captureFields,
  footageRead,
  memoryFields,
  withPlaybook,
  type CaptureFields,
  type MemoryFields,
  type PlaybookAnswer,
} from "../pipeline/route";
import type { CaptureMoment } from "../pipeline/memory";
import { isConsolePipelineEntry } from "../pipeline/paths";
import { readProjectPlaybook, writeProjectPlaybook } from "../playbooks/project";
import { uiZoneOf } from "../captions/readability";
import { captionStyleUnderPolicy, readFootagePolicy, shortsUnderPolicy, type FootagePolicyView } from "./policy";
import { footageFeedbackNext } from "../feedback/footage";

export const GOALS_FILE = "pipeline/footage-goals.json";
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi"]);
const FOOTAGE_DIRS = ["assets/footage", "assets/videos"];
const CLOSED_JOB_STATES = new Set(["published", "failed", "cancelled"]);
const MAX_SOURCE_SEC = 30 * 60;
const MP4_VIDEO_CODECS = new Set(["h264", "hevc", "vp9", "av1", "mpeg4"]);

// --- Commands ---

export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
export type Command = string[];
const line = (argv: Command) => argv.map(shellQuote).join(" ");

// --- State ---

export type SourceProblem = {
  code: "unreadable" | "streams" | "no-duration" | "start-offset" | "audio-longer" | "too-long" | "too-large";
  message: string;
  fix?: Command;
  fixedFile?: string;
};
export type SourceInfo = {
  file: string;
  exists: boolean;
  width: number | null;
  height: number | null;
  fps: string | null;
  durationSec: number | null;
  problems: SourceProblem[];
};
export type TranscriptInfo = {
  file: string;
  provider: "elevenlabs" | "local" | "fal";
  model: string;
  verbatim: boolean;
  diarized: boolean;
  speakers: string[];
  language: string;
  valid: boolean;
  mtimeMs: number;
  firstWords: { speaker: string; startSec: number; endSec: number }[];
  gluedWords: GluedWord[];
  textLanguage?: string;
};
export type GluedWord = { text: string; atSec: number; why: string };
export type RawInfo = { file: string; sha256: string | null; durationSec: number | null };
export type RequestInfo = {
  file: string;
  projectId: string;
  formats: string[];
  mtimeMs: number;
  planFile: string | null;
  planHash: string | null;
  approvedEditHash: string | null;
  cuts: { id: string; kind: string }[];
};
export type RenderState = "fresh" | "stale" | "missing";
export type RecutInfo = {
  projectId: string;
  editHash: string;
  mtimeMs: number;
  revision: number;
  captionStyle: string | null;
  /** The caption style carries measured positions and legibility levels (`captions:place` was applied). */
  captionsPlaced: boolean;
  /** The interface the placed captions keep clear of (`options.uiZone`); absent means organic. */
  captionUiZone?: string;
  pictureTrackId: string;
  reframed: FootageFormat[];
  /** Keyed by format, and `<format>-clean` for a render with captions off. */
  renders: Record<string, { state: RenderState; file: string }>;
  chapters: boolean;
};
export type ShortsInfo = {
  dir: string;
  prepared: boolean;
  candidates: string | null;
  proposals: { file: string; projectId: string | null; fresh: boolean; proposed: string[]; others: string[] } | null;
};
export type SeriesInfo = {
  file: string;
  seriesId: string;
  episodes: number;
  created: { projectId: string; rendered: boolean }[];
};

export type FootageState = {
  rootDir: string;
  projectId: string;
  projectExists: boolean;
  redirectedFrom: { projectId: string; kind: "recut" | "shorts" } | null;
  goalsFile: string;
  /** The playbook the source project is bound to (pipeline/playbook.json), or the one this call binds. */
  playbook?: string;
  goals: FootageGoals | null;
  goalsSaved: boolean;
  candidates: SourceInfo[];
  source: SourceInfo | null;
  sha256: string | null;
  cameras: string[];
  workDir: string;
  transcripts: TranscriptInfo[];
  raws: RawInfo[];
  speechMasks: string[];
  shots: string | null;
  speakerMap: string | null;
  multicam: { sync: string | null; angles: string | null };
  request: RequestInfo | null;
  recut: RecutInfo | null;
  otherRecuts: string[];
  takenProjectIds: string[];
  budget: boolean;
  openScribe: { operationId: string; state: string }[];
  shorts: ShortsInfo | null;
  series: SeriesInfo | null;
  /** Only with an autonomous policy (pipeline/policy.json): its caption style and shorts pre-answers, and revocations. */
  policy?: FootagePolicyView;
};

const readJson = (file: string): any => JSON.parse(readFileSync(file, "utf8"));
const tryJson = (file: string): any => {
  try {
    return readJson(file);
  } catch {
    return null;
  }
};
const mtime = (file: string) => statSync(file).mtimeMs;

const hashMemo = new FileMemo<string>();
const probeMemo = new FileMemo<SourceInfo>(128);

/** sha256 of a file, memoised by path, size, mtime and inode (a recording is hashed once per process, not per read). */
export const sha256File = (file: string): string => hashMemo.get(file, hashFileBytes);

function hashFileBytes(file: string): string {
  const hash = createHash("sha256");
  const fd = openSync(file, "r");
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    for (let read = readSync(fd, buffer); read > 0; read = readSync(fd, buffer)) hash.update(buffer.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function head(file: string, bytes = 8192): string {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    return buffer.subarray(0, readSync(fd, buffer)).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** JSON files under pipeline/ (five levels), without the console's and the lease's own entries (isConsolePipelineEntry). */
export function walkJson(dir: string, depth = 5, root = dir): string[] {
  if (!existsSync(dir) || depth < 0) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (isConsolePipelineEntry(path.relative(root, full))) continue;
    if (entry.isDirectory()) out.push(...walkJson(full, depth - 1, root));
    else if (entry.name.endsWith(".json") && (entry.isFile() || entry.isSymbolicLink())) out.push(full);
  }
  return out;
}

const seconds = (value: unknown): number | null => {
  if (typeof value === "string" && /^\d+:\d+:\d+(\.\d+)?$/.test(value)) {
    const [h, m, s] = value.split(":").map(Number);
    return h! * 3600 + m! * 60 + s!;
  }
  const n = Number(value);
  return value !== undefined && value !== null && value !== "" && Number.isFinite(n) ? n : null;
};

/** Stream-level checks that mirror recut:plan's refusals without decoding frames. */
export function probeSource(file: string, rootDir: string): SourceInfo {
  const shown = displayPath(file, rootDir);
  const info: SourceInfo = {
    file: shown,
    exists: existsSync(file),
    width: null,
    height: null,
    fps: null,
    durationSec: null,
    problems: [],
  };
  if (!info.exists) return { ...info, problems: [{ code: "unreadable", message: `${shown} does not exist` }] };
  let probe: any;
  try {
    probe = JSON.parse(
      execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout: 30000,
      }),
    );
  } catch (error) {
    return {
      ...info,
      problems: [
        {
          code: "unreadable",
          message: `ffprobe cannot read ${shown}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
        },
      ],
    };
  }
  const videos = (probe.streams ?? []).filter(
    (s: any) => s.codec_type === "video" && s.disposition?.attached_pic !== 1,
  );
  const audios = (probe.streams ?? []).filter((s: any) => s.codec_type === "audio");
  const video = videos[0],
    audio = audios[0];
  const parsed = path.parse(shown);
  const fixedFile = path.join(parsed.dir, `${parsed.name}${parsed.ext.toLowerCase() === ".mp4" ? "-fixed" : ""}.mp4`);
  if (video) {
    info.width = video.width ?? null;
    info.height = video.height ?? null;
    info.fps = video.r_frame_rate ?? null;
  }
  const tick = (() => {
    const m = /^(\d+)\/(\d+)$/.exec(video?.time_base ?? "");
    return m ? Number(m[1]) / Number(m[2]) : null;
  })();
  const videoSec = video
    ? Number.isSafeInteger(Number(video.duration_ts)) && tick
      ? Number(video.duration_ts) * tick
      : (seconds(video.duration) ?? seconds(video.tags?.DURATION) ?? seconds(probe.format?.duration))
    : null;
  const audioSec = audio ? (seconds(audio.duration) ?? seconds(audio.tags?.DURATION)) : null;
  info.durationSec = videoSec;
  const end = videoSec !== null ? String(Math.floor(videoSec * 1000) / 1000) : "<video seconds>";
  if (!video || !audio)
    return {
      ...info,
      problems: [
        {
          code: "streams",
          message: `${shown} has ${videos.length} video and ${audios.length} audio streams; a recut needs one of each${audio ? "" : " (no sound to transcribe)"}`,
        },
      ],
    };
  const offset = [video, audio].some(
    (s: any) => !Number.isFinite(Number(s.start_time)) || Math.abs(Number(s.start_time)) > 1 / 48000,
  );
  const noDuration = !Number.isSafeInteger(Number(video.duration_ts)) || Number(video.duration_ts) <= 0;
  const fps = (() => {
    const m = /^(\d+)\/(\d+)$/.exec(video.r_frame_rate ?? "");
    return m ? Number(m[1]) / Number(m[2]) : 30;
  })();
  const audioLonger = videoSec !== null && audioSec !== null && fps !== 30 && audioSec > videoSec + 1 / 30 + 1e-6;
  const reencode: Command = [
    "ffmpeg",
    "-i",
    shown,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-vf",
    "setpts=PTS-STARTPTS",
    "-af",
    `asetpts=PTS-STARTPTS,atrim=end=${end}`,
    "-c:v",
    "libx264",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    fixedFile,
  ];
  const remux: Command = [
    "ffmpeg",
    "-i",
    shown,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-c:v",
    "copy",
    "-af",
    `atrim=end=${end}`,
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    fixedFile,
  ];
  const fix = offset || !MP4_VIDEO_CODECS.has(String(video.codec_name)) ? reencode : remux;
  if (videos.length !== 1 || audios.length !== 1)
    info.problems.push({
      code: "streams",
      message: `${shown} has ${videos.length} video and ${audios.length} audio streams; a recut takes exactly one of each (the first of each is kept)`,
      fix,
      fixedFile,
    });
  if (offset)
    info.problems.push({
      code: "start-offset",
      message: `Video starts at ${video.start_time}s and audio at ${audio.start_time}s; both must start at 0, so the picture is re-encoded from zero`,
      fix,
      fixedFile,
    });
  if (noDuration)
    info.problems.push({
      code: "no-duration",
      message: `${shown} stores no video stream duration (WebM/Matroska); remux it to MP4, then transcribe the MP4 (a transcript is bound to its file's SHA-256)`,
      fix,
      fixedFile,
    });
  if (audioLonger)
    info.problems.push({
      code: "audio-longer",
      message: `Audio runs ${(audioSec! - videoSec!).toFixed(3)}s past the end of the video (more than one frame); trim it to the picture`,
      fix,
      fixedFile,
    });
  if (videoSec !== null && videoSec > MAX_SOURCE_SEC)
    info.problems.push({
      code: "too-long",
      message: `${shown} is ${(videoSec / 60).toFixed(1)} min; a recut takes at most 30 minutes, so split it into parts first`,
    });
  if ((info.width ?? 0) > 4096 || (info.height ?? 0) > 4096 || (info.width ?? 0) * (info.height ?? 0) > 3840 * 2160)
    info.problems.push({
      code: "too-large",
      message: `${shown} is ${info.width}x${info.height}; a recut takes at most a 4K frame, so scale it down first`,
      fix: [
        "ffmpeg",
        "-i",
        shown,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0",
        "-vf",
        "scale=-2:2160",
        "-c:v",
        "libx264",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "copy",
        "-movflags",
        "+faststart",
        fixedFile,
      ],
      fixedFile,
    });
  return info;
}

export function displayPath(file: string, rootDir: string): string {
  const relative = path.relative(rootDir, path.resolve(rootDir, file));
  return relative.startsWith("..") || path.isAbsolute(relative) ? path.resolve(rootDir, file) : relative;
}

function projectOfFile(file: string): string | null {
  return /(?:^|\/)public\/projects\/([a-z0-9]+(?:-[a-z0-9]+)*)\//.exec(file)?.[1] ?? null;
}

type RecutScan = {
  projectId: string;
  dir: string;
  sourceSha: string;
  sourceFile: string;
  editHash: string;
  mtimeMs: number;
};

function scanRecuts(projectsRoot: string): RecutScan[] {
  if (!existsSync(projectsRoot)) return [];
  const out: RecutScan[] = [];
  for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(projectsRoot, entry.name, "pipeline/recording-edit.json");
    if (!existsSync(file)) continue;
    const text = head(file, 16384);
    const sha = /"sha256"\s*:\s*"([a-f0-9]{64})"/.exec(text)?.[1];
    const source = /"file"\s*:\s*"([^"]+)"/.exec(text)?.[1];
    if (!sha) continue;
    out.push({
      projectId: entry.name,
      dir: path.join(projectsRoot, entry.name),
      sourceSha: sha,
      sourceFile: source ?? "",
      editHash: "",
      mtimeMs: mtime(file),
    });
  }
  return out;
}

function editHashOf(recut: RecutScan): string {
  if (!recut.editHash)
    recut.editHash = String(tryJson(path.join(recut.dir, "pipeline/recording-edit.json"))?.editHash ?? "");
  return recut.editHash;
}

function firstPicturePayload(projectDir: string): any {
  const journal = tryJson(path.join(projectDir, "pipeline/timeline-edit.json"));
  const track = journal?.timeline?.tracks?.find((t: any) => t.kind === "visual" && t.clips?.[0]?.payload?.editHash);
  return track?.clips?.[0]?.payload ?? null;
}

export type ResolveResult = { projectId: string; redirectedFrom: FootageState["redirectedFrom"] };

/** A recut or a shorts episode resolves to the source project that holds the recording. */
export function resolveSourceProject(projectId: string, rootDir: string): ResolveResult {
  const projectsRoot = path.join(rootDir, "public/projects");
  const checkedId = (id: string): string => {
    validateProjectId(id);
    const directory = path.join(projectsRoot, id);
    assertPathWithin(projectsRoot, directory);
    assertPathWithin(directory, path.join(directory, "pipeline"));
    return id;
  };
  checkedId(projectId);
  const dir = path.join(projectsRoot, projectId);
  const editFile = path.join(dir, "pipeline/recording-edit.json");
  if (existsSync(editFile)) {
    const source = /"file"\s*:\s*"([^"]+)"/.exec(head(editFile, 16384))?.[1] ?? "";
    const parent = projectOfFile(source);
    if (parent && parent !== projectId && existsSync(path.join(projectsRoot, parent)))
      return { projectId: checkedId(parent), redirectedFrom: { projectId, kind: "recut" } };
  }
  if (existsSync(path.join(dir, "pipeline/shorts-series-binding.json"))) {
    const payload = firstPicturePayload(dir);
    const recut = payload
      ? scanRecuts(projectsRoot).find((r) => r.sourceSha === payload.sourceHash && editHashOf(r) === payload.editHash)
      : undefined;
    if (recut) {
      const parent = projectOfFile(recut.sourceFile);
      return {
        projectId: checkedId(parent && existsSync(path.join(projectsRoot, parent)) ? parent : recut.projectId),
        redirectedFrom: { projectId, kind: "shorts" },
      };
    }
  }
  return { projectId, redirectedFrom: null };
}

export type GoalOverrides = Partial<Omit<FootageGoals, "version">>;

export function mergeGoals(current: FootageGoals | null, overrides: GoalOverrides): FootageGoals | null {
  const defined = Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined));
  if (!current && !defined.goals) return null;
  return FootageGoalsSchema.parse({ ...(current ?? { version: 1 }), ...defined });
}

/** `playbook` binds the source project to it (pipeline/playbook.json) once the project exists, unless `save` is false. */
export type ReadOptions = { rootDir?: string; overrides?: GoalOverrides; save?: boolean; playbook?: string };

export function readFootageState(requestedId: string, options: ReadOptions = {}): FootageState {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const projectsRoot = path.join(rootDir, "public/projects");
  const { projectId, redirectedFrom } = resolveSourceProject(requestedId, rootDir);
  const projectDir = path.join(projectsRoot, projectId);
  const pipeline = path.join(projectDir, "pipeline");
  const goalsPath = path.join(projectDir, GOALS_FILE);
  assertPathWithin(projectDir, goalsPath);
  if (options.playbook) assertPathWithin(projectDir, path.join(pipeline, "playbook.json"));
  if (options.playbook && options.save !== false && existsSync(projectDir))
    writeProjectPlaybook(projectDir, options.playbook, "agent");
  const stored = existsSync(goalsPath) ? FootageGoalsSchema.parse(readJson(goalsPath)) : null;
  const overrides = options.overrides ?? {};
  const pending = Object.values(overrides).some((value) => value !== undefined);
  const goals = pending ? mergeGoals(stored, overrides) : stored;
  let goalsSaved = false;
  if (pending && goals && options.save !== false && existsSync(projectDir)) {
    mkdirSync(path.dirname(goalsPath), { recursive: true });
    writeFileSync(goalsPath, `${JSON.stringify(goals, null, 2)}\n`);
    goalsSaved = true;
  }
  const state: FootageState = {
    rootDir,
    projectId,
    projectExists: existsSync(projectDir),
    redirectedFrom,
    goalsFile: displayPath(goalsPath, rootDir),
    playbook: options.playbook ?? (existsSync(projectDir) ? readProjectPlaybook(projectDir)?.id : undefined),
    goals,
    goalsSaved,
    candidates: [],
    source: null,
    sha256: null,
    cameras: goals?.cameras ?? [],
    workDir: "",
    transcripts: [],
    raws: [],
    speechMasks: [],
    shots: null,
    speakerMap: null,
    multicam: { sync: null, angles: null },
    request: null,
    recut: null,
    otherRecuts: [],
    takenProjectIds: existsSync(projectsRoot) ? readdirSync(projectsRoot) : [],
    budget: false,
    openScribe: [],
    shorts: null,
    series: null,
  };
  if (!state.projectExists) return state;

  const found = FOOTAGE_DIRS.flatMap((sub) => {
    const dir = path.join(projectDir, sub);
    return existsSync(dir)
      ? readdirSync(dir)
          .filter((name) => VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase()))
          .sort()
          .map((name) => path.join(dir, name))
      : [];
  });
  const pinned = goals?.source ? path.resolve(rootDir, goals.source) : null;
  // ffprobe is memoised by the file's identity: the console rebuilds this state on every change.
  const probe = (file: string) => structuredClone(probeMemo.get(file, (f) => probeSource(f, rootDir), rootDir));
  if (!pinned) state.candidates = found.map(probe);
  const usable = state.candidates.filter((c) => c.problems.length === 0);
  const chosen =
    pinned ??
    (found.length === 1
      ? found[0]!
      : usable.length === 1 && found.length === usable.length
        ? path.resolve(rootDir, usable[0]!.file)
        : null);
  if (!chosen) return state;
  state.source = state.candidates.find((c) => path.resolve(rootDir, c.file) === chosen) ?? probe(chosen);
  if (state.source.problems.length) return state;
  const sha = sha256File(chosen);
  state.sha256 = sha;
  state.workDir = displayPath(path.join(pipeline, "footage", path.parse(chosen).name), rootDir);

  const operations = tryJson(path.join(pipeline, "operations.json"));
  state.budget = Boolean(operations?.policy?.ceilingUsd);
  state.openScribe = Object.values<any>(operations?.jobs ?? {})
    .filter(
      (job) =>
        String(job.endpoint ?? "").includes("speech-to-text") &&
        path.resolve(rootDir, String(job.assetId ?? "")) === chosen &&
        !CLOSED_JOB_STATES.has(job.state),
    )
    .map((job) => ({ operationId: String(job.operationId), state: String(job.state) }));

  const seen = new Set<string>();
  const requests: RequestInfo[] = [];
  const shortsDirs: string[] = [];
  const seriesFiles: string[] = [];
  const maps: string[] = [];
  for (const file of walkJson(pipeline)) {
    let real: string;
    try {
      real = realpathSync(file);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    const name = path.basename(file);
    if (name === "footage-goals.json" || name === "operations.json") continue;
    if (name.endsWith(".scribe.json")) {
      const sibling = tryJson(file.replace(/\.scribe\.json$/, ".json"));
      state.raws.push({
        file: displayPath(file, rootDir),
        sha256: sibling?.source?.sha256 ?? null,
        durationSec: typeof sibling?.source?.durationSec === "number" ? sibling.source.durationSec : null,
      });
      continue;
    }
    if (name === "prepared.json") {
      shortsDirs.push(path.dirname(file));
      continue;
    }
    if (statSync(real).size > 40 * 1024 * 1024) continue;
    const obj = tryJson(file);
    if (!obj || typeof obj !== "object") continue;
    if (
      obj.version === 1 &&
      obj.source?.sha256 === sha &&
      Array.isArray(obj.words) &&
      (obj.engine?.provider === "elevenlabs" || obj.engine?.provider === "local" || obj.engine?.provider === "fal")
    ) {
      if (existsSync(path.join(path.dirname(file), "prepared.json"))) continue;
      const valid = TranscriptSchema.safeParse(obj).success;
      const first = new Map<string, { speaker: string; startSec: number; endSec: number }>();
      for (const sentence of obj.sentences ?? [])
        if (sentence.speaker && !first.has(sentence.speaker) && sentence.endSec - sentence.startSec >= 1.5)
          first.set(sentence.speaker, {
            speaker: sentence.speaker,
            startSec: sentence.startSec,
            endSec: sentence.endSec,
          });
      state.transcripts.push({
        file: displayPath(file, rootDir),
        provider: obj.engine.provider,
        model: String(obj.engine.model),
        verbatim: Boolean(obj.engine.verbatim),
        diarized: Boolean(obj.engine.diarized),
        speakers: (obj.speakers ?? []).map((s: any) => String(s.id)),
        language: String(obj.language ?? ""),
        valid,
        mtimeMs: mtime(file),
        firstWords: [...first.values()],
        gluedWords: obj.engine.provider === "local" ? gluedWords(obj.words) : [],
        ...(obj.language === "und" ? { textLanguage: inferLanguage(obj.words) } : {}),
      });
    } else if (obj.engine?.provider === "silero-vad" && obj.source?.sha256 === sha) {
      state.speechMasks.push(displayPath(file, rootDir));
    } else if (obj.workflow === "recording-edit" && obj.source?.sha256 === sha && typeof obj.projectId === "string") {
      const planFile = path.join(path.dirname(file), name.replace(/request/, "plan").replace(/\.json$/, ".md"));
      const planText = existsSync(planFile) ? readFileSync(planFile, "utf8") : null;
      requests.push({
        file: displayPath(file, rootDir),
        projectId: obj.projectId,
        formats: obj.formats ?? [],
        mtimeMs: mtime(file),
        planFile: planText !== null ? displayPath(planFile, rootDir) : null,
        planHash: planText ? (/Edit hash to approve: `([a-f0-9]{64})`/.exec(planText)?.[1] ?? null) : null,
        approvedEditHash: obj.review?.approvedEditHash ?? null,
        cuts: planText
          ? [...planText.matchAll(/^- \[ \] \*\*(C\d+)\*\* (\w+)/gm)].map((m) => ({ id: m[1]!, kind: m[2]! }))
          : [],
      });
    } else if (
      obj.schemaVersion === 1 &&
      obj.detector &&
      obj.source?.path &&
      path.resolve(rootDir, obj.source.path) === chosen
    ) {
      state.shots = displayPath(file, rootDir);
    } else if (
      Array.isArray(obj.speakers) &&
      obj.speakers.length &&
      obj.speakers.every((s: any) => typeof s.speaker === "string" && typeof s.angle === "string")
    ) {
      maps.push(file);
    } else if (typeof obj.seriesId === "string" && Array.isArray(obj.episodes)) {
      seriesFiles.push(file);
    }
  }
  const work = path.resolve(rootDir, state.workDir);
  const preferWork = (files: string[]) =>
    files.sort((a, b) => Number(path.dirname(b) === work) - Number(path.dirname(a) === work) || mtime(b) - mtime(a))[0];
  const map = preferWork(maps);
  state.speakerMap = map ? displayPath(map, rootDir) : null;
  for (const [key, name] of [
    ["sync", "sync.json"],
    ["angles", "angles.json"],
  ] as const)
    if (existsSync(path.join(work, name))) state.multicam[key] = displayPath(path.join(work, name), rootDir);
  state.transcripts.sort((a, b) => b.mtimeMs - a.mtimeMs);
  requests.sort((a, b) => b.mtimeMs - a.mtimeMs);
  state.request = requests[0] ?? null;

  const recuts = scanRecuts(projectsRoot).filter((r) => r.sourceSha === sha);
  const newest = [...recuts].sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  const forRequest = state.request
    ? recuts.find((r) => r.projectId === state.request!.projectId && editHashOf(r) === state.request!.approvedEditHash)
    : undefined;
  const picked =
    forRequest ?? (newest && (!state.request || newest.mtimeMs > state.request.mtimeMs) ? newest : undefined);
  state.otherRecuts = recuts.filter((r) => r !== picked).map((r) => r.projectId);
  if (picked) state.recut = readRecut(picked, sha, rootDir);

  const chosenShorts = preferWork(shortsDirs);
  if (chosenShorts) {
    const candidates = path.join(chosenShorts, "candidates.json");
    const proposalsFile = path.join(chosenShorts, "proposals.json");
    const proposals = tryJson(proposalsFile);
    const candidatesSha = existsSync(candidates) ? sha256File(candidates) : null;
    state.shorts = {
      dir: displayPath(chosenShorts, rootDir),
      prepared: true,
      candidates: candidatesSha ? displayPath(candidates, rootDir) : null,
      proposals: proposals
        ? {
            file: displayPath(proposalsFile, rootDir),
            projectId: proposals.timeline?.projectId ?? null,
            fresh: proposals.candidatesSha256 === candidatesSha,
            proposed: (proposals.proposals ?? []).map((p: any) => p.id),
            others: (proposals.others ?? []).map((p: any) => p.id),
          }
        : null,
    };
  }
  if (state.recut) {
    const own = path.join(projectsRoot, state.recut.projectId, "pipeline/shorts-series-request.json");
    const series = [own, ...seriesFiles]
      .filter((file) => existsSync(file))
      .map((file) => ({ file, obj: tryJson(file) }))
      .filter(({ obj }) => obj?.source?.projectId === state.recut!.projectId)
      .sort((a, b) => mtime(b.file) - mtime(a.file))[0];
    if (series) {
      const created = readdirSync(projectsRoot).filter(
        (id) =>
          tryJson(path.join(projectsRoot, id, "pipeline/shorts-series-binding.json"))?.seriesId === series.obj.seriesId,
      );
      state.series = {
        file: displayPath(series.file, rootDir),
        seriesId: series.obj.seriesId,
        episodes: series.obj.episodes.length,
        created: created.map((id) => ({
          projectId: id,
          rendered: renderOf(rootDir, id, "vertical").state === "fresh",
        })),
      };
    }
  }
  const policy = readFootagePolicy(projectDir, rootDir, {
    goals: goalsPath,
    proposals: state.shorts?.proposals?.file ?? null,
    series: state.series?.file ?? null,
  });
  if (policy) state.policy = policy;
  return state;
}

function renderOf(rootDir: string, projectId: string, name: string): { state: RenderState; file: string } {
  const file = path.join(rootDir, "out", projectId, `${name}.mp4`);
  const receipt = tryJson(`${file}.receipt.json`);
  const shown = displayPath(file, rootDir);
  if (!existsSync(file) || !receipt || receipt.partial) return { state: "missing", file: shown };
  const journal = path.join(rootDir, "public/projects", projectId, "pipeline/timeline-edit.json");
  if (!existsSync(journal)) return { state: "fresh", file: shown };
  const entry = (receipt.sources ?? []).find((s: any) =>
    String(s.path).endsWith(`${projectId}/pipeline/timeline-edit.json`),
  );
  const fresh = entry ? entry.sha256 === sha256File(journal) : mtime(`${file}.receipt.json`) >= mtime(journal);
  return { state: fresh ? "fresh" : "stale", file: shown };
}

function readRecut(scan: RecutScan, sha: string, rootDir: string): RecutInfo {
  const journal = tryJson(path.join(scan.dir, "pipeline/timeline-edit.json"));
  const timeline = journal?.timeline ?? { tracks: [] };
  const track =
    timeline.tracks.find((t: any) => t.kind === "visual" && t.clips?.some((c: any) => c.payload?.sourceHash === sha)) ??
    timeline.tracks.find((t: any) => t.id === "recording-picture");
  const clips: any[] = track?.clips ?? [];
  const formats: FootageFormat[] = ["landscape", "vertical", "square"];
  return {
    projectId: scan.projectId,
    editHash: editHashOf(scan),
    mtimeMs: scan.mtimeMs,
    revision: Number(journal?.revision ?? 0),
    captionStyle: timeline.captionStyle?.profile ?? null,
    captionsPlaced: Array.isArray(timeline.captionStyle?.options?.legibility),
    ...(typeof timeline.captionStyle?.options?.uiZone === "string"
      ? { captionUiZone: timeline.captionStyle.options.uiZone }
      : {}),
    pictureTrackId: track?.id ?? "recording-picture",
    reframed: formats.filter((format) => clips.length > 0 && clips.every((c) => c.payload?.reframe?.[format])),
    renders: Object.fromEntries(
      formats
        .flatMap((format) => [format, `${format}-clean`])
        .map((name) => [name, renderOf(rootDir, scan.projectId, name)]),
    ),
    chapters: existsSync(path.join(scan.dir, "pipeline/chapters.json")),
  };
}

/**
 * Words a local recogniser glued together ("оченьрядом", "правозащитнойжурналистикой"). A token (hyphenated parts
 * judged separately) is suspect when it has 18 or more letters in Cyrillic or 20 or more in another script, or, in
 * Cyrillic only, when it has 9+ letters and splits into a first part of 4+ letters and a rest of 5+ where both occur
 * on their own in the transcript, or the first part occurs on its own at least three times. English compounds
 * ("something", "worldwide") would trip the split rules, so they apply to Cyrillic only. A pointer, not a correction.
 */
export function gluedWords(words: readonly { text: string; startSec: number; kind?: string }[]): GluedWord[] {
  const bareWord = (text: string) =>
    text
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/ё/g, "е")
      .replace(/[^\p{L}-]/gu, "");
  const tokens = words
    .filter((w) => w.kind !== "event")
    .map((w) => ({ w, parts: bareWord(w.text).split("-").filter(Boolean) }));
  const count = new Map<string, number>();
  for (const { parts } of tokens) for (const part of parts) count.set(part, (count.get(part) ?? 0) + 1);
  const out = new Map<string, GluedWord>();
  for (const { w, parts } of tokens)
    for (const part of parts) {
      if (out.has(part)) continue;
      const cyrillic = /\p{Script=Cyrillic}/u.test(part);
      const long = part.length >= (cyrillic ? 18 : 20);
      let split: string | null = null;
      if (cyrillic && !long && part.length >= 9) {
        for (let i = 4; i <= part.length - 5 && !split; i++) {
          const [head, rest] = [part.slice(0, i), part.slice(i)];
          if ((count.has(head) && count.has(rest)) || (count.get(head) ?? 0) >= 3) split = `${head} + ${rest}`;
        }
      }
      if (long || split)
        out.set(part, {
          text: w.text,
          atSec: w.startSec,
          why: split ? `splits into ${split}` : `${part.length} letters`,
        });
    }
  return [...out.values()].sort((a, b) => a.atSec - b.atSec);
}

const OUTPUT_SIZE: Record<FootageFormat, [number, number]> = {
  landscape: [1920, 1080],
  vertical: [1080, 1920],
  square: [1080, 1080],
};

/** How much a cover crop of the source is enlarged for each format; 1 or less means no upscaling. */
export function upscaleFactors(
  width: number,
  height: number,
  formats: readonly FootageFormat[],
): { format: FootageFormat; factor: number }[] {
  return formats.map((format) => ({
    format,
    factor: Math.round(Math.max(OUTPUT_SIZE[format][0] / width, OUTPUT_SIZE[format][1] / height) * 10) / 10,
  }));
}

const clockSec = (sec: number) =>
  `${String(Math.floor(sec / 60)).padStart(2, "0")}:${(sec % 60).toFixed(1).padStart(4, "0")}`;

// --- Decision ---

export type FootageNext = {
  action: "run" | "ask" | "agent-task" | "stop";
  step: string;
  title: string;
  why: string;
  commands?: string[];
  argv?: Command[];
  question?: string;
  answers?: string[];
  show?: string[];
  thenRun?: string[];
  task?: string;
  cost?: {
    model: string;
    minutes: number;
    expectedUsd: number | null;
    highUsd: number | null;
    source: string;
    asOf: string;
  };
  userDecides?: string[];
  optional?: string[];
  advisories?: string[];
  /** Guides and skills for this step (src/lib/pipeline/route.ts), the bound playbook's first. */
  read?: string[];
  /** Autonomous projects: the policy decision this run records (pipeline/decisions.jsonl), revocable with film:revert. */
  policy?: { basis: string; evidence: Record<string, string> };
  playbook?: PlaybookAnswer["playbook"];
  playbookHint?: string;
  state: Record<string, unknown>;
} & MemoryFields &
  CaptureFields;

export const STEP = {
  setup: ["setup", "Project and goals"],
  source: ["0-source", "Source check"],
  transcript: ["1-transcript", "Transcript"],
  mask: ["1-speech-mask", "Speech mask"],
  shots: ["2-shots", "Shots"],
  plan: ["3-recut-plan", "Recut plan"],
  approve: ["4-approve", "Approval of the edit hash"],
  create: ["4-create", "Create the recut project"],
  captions: ["5-captions", "Caption style"],
  shorts: ["6-shorts", "Shorts"],
  cameras: ["7-cameras", "Several cameras"],
  vertical: ["8-reframe", "Reframe"],
  render: ["9-render", "Render"],
  done: ["done", "Done"],
} as const;

const aspectOf = (width: number | null, height: number | null): FootageFormat =>
  !width || !height || width > height ? "landscape" : width === height ? "square" : "vertical";

export function wantedFormats(state: FootageState): FootageFormat[] {
  const goals = state.goals!;
  const own = aspectOf(state.source?.width ?? null, state.source?.height ?? null);
  const formats = goals.formats ?? [
    own,
    ...(goals.goals.includes("vertical") && own !== "vertical" ? ["vertical" as const] : []),
  ];
  return [...new Set(formats)];
}

/** The ten presets, then karaoke. The legacy ids (word-highlight, bold-upper, boxed-word, keyword-emphasis) are still accepted. */
export const CAPTION_CHOICES = [
  "outline-pop",
  "italic-shadow",
  "keyword-colour",
  "word-box",
  "line-box",
  "chunky-stack",
  "editorial-mix",
  "clean-sentence",
  "single-punch",
  "typewriter",
  "karaoke",
];

export function decideNext(state: FootageState, playbook?: string): FootageNext {
  const pnpm = (script: string, ...args: (string | false | null | undefined)[]): Command => [
    "pnpm",
    script,
    ...args.filter((a): a is string => typeof a === "string"),
  ];
  const next = (projectFlag = state.projectId, ...args: string[]) =>
    pnpm("footage:next", "--project", projectFlag, ...args);
  const advisories: string[] = [];
  if (state.redirectedFrom)
    advisories.push(
      `${state.redirectedFrom.projectId} is a ${state.redirectedFrom.kind === "recut" ? "recut" : "shorts episode"} of the recording in ${state.projectId}; goals and working files live in the source project.`,
    );
  if (state.otherRecuts.length) advisories.push(`Other recuts of this recording: ${state.otherRecuts.join(", ")}.`);
  const summary = summarise(state);
  const finish = (base: Omit<FootageNext, "state" | "commands" | "argv"> & { run?: Command[] }): FootageNext => {
    const { run, ...rest } = base;
    const all = [...advisories, ...(rest.advisories ?? [])];
    return {
      ...rest,
      ...(run ? { commands: run.map(line), argv: run } : {}),
      ...(all.length ? { advisories: all } : {}),
      state: summary,
    };
  };
  const step = (key: keyof typeof STEP) => ({ step: STEP[key][0], title: STEP[key][1] });

  if (!state.projectExists) {
    return finish({
      ...step("setup"),
      action: "ask",
      why: `No project ${state.projectId} exists. A source project holds the recording, its goals, transcripts and plans; each recut becomes a new project.`,
      question:
        "Where is the recording (path), and what should come out of it: a recut, captions, vertical, shorts, several cameras?",
      answers: ["recut,captions", "recut,captions,vertical", "captions,vertical", "recut,shorts"],
      thenRun: [
        line(pnpm("project:new", "--project", state.projectId)),
        `mkdir -p public/projects/${state.projectId}/assets/footage && cp <recording> public/projects/${state.projectId}/assets/footage/`,
        line(
          next(
            state.projectId,
            ...(playbook ? ["--playbook", playbook] : []),
            "--goal",
            "<goals>",
            "--source",
            `public/projects/${state.projectId}/assets/footage/<file>`,
          ),
        ),
      ],
    });
  }
  if (!state.goals) {
    const durationSec = state.source?.durationSec ?? null;
    const priced = durationSec ? quote({ model: "elevenlabs:scribe-v3", units: durationSec / 60 }) : null;
    const scribeCost =
      priced?.expectedUsd != null
        ? `about $${priced.expectedUsd.toFixed(3)} for ${(durationSec! / 60).toFixed(1)} min at list price`
        : "$0.20 per hour of audio at list price";
    const cost = priced
      ? {
          model: "elevenlabs:scribe-v3",
          minutes: Math.round((durationSec! / 60) * 100) / 100,
          expectedUsd: priced.expectedUsd,
          highUsd: priced.highUsd,
          source: priced.source,
          asOf: priced.asOf,
        }
      : undefined;
    const question = [
      "Ask the user these in one message:",
      "1. What should come out: cut silences, fillers and false starts (recut); subtitles (captions); a vertical or square version; shorts; several cameras of one event (multicam)?",
      "2. Formats: landscape, vertical, square (default: the recording's own shape, plus vertical for the vertical goal).",
      `3. Caption style, if captions: ${CAPTION_CHOICES.slice(0, 10).join(", ")}.`,
      "4. Which language is spoken (e.g. ru, en)?",
      `5. Transcription: ElevenLabs Scribe (paid, ${scribeCost}; verbatim, so fillers can be cut) or the free local engine (marks few fillers)?`,
    ].join("\n");
    return finish({
      ...step("setup"),
      action: "ask",
      why: `No goals in ${state.goalsFile}. They decide which steps run, the formats, the caption style, the language and the transcriber; one call records them all.`,
      question,
      answers: [
        "--goal recut,captions --caption-style outline-pop --language ru --transcriber scribe",
        "--goal recut,captions,vertical --formats landscape,vertical --caption-style clean-sentence --language en --transcriber local",
        "--goal captions --caption-style word-box --language ru --transcriber local",
      ],
      ...(cost ? { cost } : {}),
      thenRun: [
        line(
          next(
            state.projectId,
            "--goal",
            "<goals>",
            "--formats",
            "<formats>",
            "--caption-style",
            "<style>",
            "--language",
            "<code>",
            "--transcriber",
            "<scribe|local>",
          ),
        ),
      ],
      userDecides: ["Paid or free transcription"],
    });
  }
  const goals = state.goals;
  const wants = (goal: FootageGoals["goals"][number]) => goals.goals.includes(goal);

  if (!state.source) {
    if (!state.candidates.length)
      return finish({
        ...step("source"),
        action: "ask",
        why: `No video in public/projects/${state.projectId}/assets/footage and no --source in the goals.`,
        question: "Which file is the recording?",
        thenRun: [
          `mkdir -p public/projects/${state.projectId}/assets/footage && cp <recording> public/projects/${state.projectId}/assets/footage/`,
          line(next(state.projectId, "--source", `public/projects/${state.projectId}/assets/footage/<file>`)),
        ],
      });
    return finish({
      ...step("source"),
      action: "ask",
      why: `${state.candidates.length} videos are in the project and none is pinned as the source.${wants("multicam") ? " With several cameras, pin the main one (its sound is transcribed) and list the others with --cameras." : ""}`,
      question: "Which recording should be edited?",
      answers: state.candidates.map(
        (c) =>
          `${c.file}${c.problems.length ? ` (needs a fix first: ${c.problems.map((p) => p.code).join(", ")})` : ""}`,
      ),
      thenRun: [
        line(next(state.projectId, "--source", "<file>", ...(wants("multicam") ? ["--cameras", "<other files>"] : []))),
      ],
    });
  }
  const source = state.source;
  if (source.problems.length) {
    const problem = source.problems[0]!;
    const all = source.problems.map((p) => p.message).join(" ");
    if (!problem.fix)
      return finish({ ...step("source"), action: "stop", why: `${all} The original is never modified.` });
    if (problem.fixedFile && existsSync(path.resolve(state.rootDir, problem.fixedFile)))
      return finish({
        ...step("source"),
        action: "run",
        why: `${all} ${problem.fixedFile} already exists, so pin it as the source; it is probed the same way.`,
        run: [next(state.projectId, "--source", problem.fixedFile)],
      });
    return finish({
      ...step("source"),
      action: "run",
      why: `${all} Fix the file before transcribing: a transcript is bound to the file's SHA-256, so transcribing first means paying twice. The original stays as it is.`,
      run: [problem.fix, next(state.projectId, "--source", problem.fixedFile!)],
      optional: [
        "A variable frame rate is not a problem: recut:plan applies the version 2 normalisation itself, so do not re-encode to a fixed rate.",
      ],
    });
  }
  const src = source.file;
  const work = state.workDir;
  const own = aspectOf(source.width, source.height);
  const formats = wantedFormats(state);
  const reframeFormats = formats.filter((f) => f !== own);
  const needsTimeline = goals.goals.some((g) => g !== "multicam");
  const minutes = (source.durationSec ?? 0) / 60;
  if (source.width && source.height) {
    const enlarged = upscaleFactors(source.width, source.height, formats).filter((f) => f.factor >= 2);
    if (enlarged.length)
      advisories.push(
        `The source is ${source.width}x${source.height}: ${enlarged.map((f) => `${f.format} enlarges the crop about ${f.factor.toFixed(1)}x`).join(", ")}, so the picture will look soft. Tell the user before rendering.`,
      );
  }
  const language =
    goals.language ?? state.transcripts.find((t) => t.valid && t.language && t.language !== "und")?.language;
  const languageFlag = language ?? "<code>";

  const transcript = (() => {
    const valid = state.transcripts.filter((t) => t.valid);
    const order = (t: TranscriptInfo) =>
      goals.transcriber === "local"
        ? Number(t.provider === "local")
        : Number(t.provider === "elevenlabs" || t.provider === "fal");
    return [...valid].sort((a, b) => order(b) - order(a) || b.mtimeMs - a.mtimeMs)[0] ?? null;
  })();
  const scribeWanted = goals.transcriber === "scribe" || (!goals.transcriber && wants("recut"));
  if (!transcript || (goals.transcriber === "scribe" && transcript.provider !== "elevenlabs")) {
    const output = `${work}/transcript.json`;
    const invalid = state.transcripts.find((t) => !t.valid);
    const raw = state.raws.find((r) => r.sha256 === state.sha256);
    const scribeArgs = (...extra: string[]) =>
      pnpm(
        "transcribe",
        "--project",
        state.projectId,
        "--input",
        src,
        "--output",
        raw ? (invalid?.file ?? output) : output,
        "--diarize",
        ...(goals.speakers ? ["--speakers", String(goals.speakers)] : []),
        ...(extra.includes("--from-raw") && !language ? [] : ["--language", languageFlag]),
        ...extra,
      );
    if (raw && goals.transcriber !== "local")
      return finish({
        ...step("transcript"),
        action: "run",
        why: `A saved Scribe response for this file (${raw.file}) exists${invalid ? ` but ${invalid.file} no longer passes TranscriptSchema` : ""}; rebuild the transcript from it with no API call and no cost.`,
        run: [scribeArgs("--from-raw", raw.file, "--force")],
      });
    const local: Command = pnpm(
      "speech:local",
      "--input",
      src,
      "--output",
      `${work}/transcript-local.json`,
      "--vad-output",
      `${work}/speech-mask.json`,
      "--language",
      languageFlag,
      "--require-word-timing",
      ...(goals.speakers ? ["--speakers", String(goals.speakers)] : []),
    );
    if (goals.transcriber === "local" && !language)
      return finish({
        ...step("transcript"),
        action: "ask",
        why: "The goals choose the free local engine, but the spoken language is unknown: the recogniser does not report it, and it decides which fillers are marked.",
        question: "Which language is spoken (e.g. ru, en)?",
        answers: ["ru", "en"],
        thenRun: [line(next(state.projectId, "--language", "<code>")), line(local)],
      });
    if (goals.transcriber === "local")
      return finish({
        ...step("transcript"),
        action: "run",
        why: "No transcript of this file yet; the goals choose the free local engine (Parakeet, Silero VAD, pyannote speakers when HF_TOKEN is set).",
        run: [local],
      });
    const priced = quote({ model: "elevenlabs:scribe-v3", units: minutes });
    const cost = {
      model: "elevenlabs:scribe-v3",
      minutes: Math.round(minutes * 100) / 100,
      expectedUsd: priced.expectedUsd,
      highUsd: priced.highUsd,
      source: priced.source,
      asOf: priced.asOf,
    };
    const usd = priced.expectedUsd === null ? "an unknown amount" : `about $${priced.expectedUsd.toFixed(3)}`;
    const ceiling = Math.max(0.1, Math.ceil((priced.highUsd ?? 0.5) * 200) / 100);
    const operationId =
      state.openScribe[0]?.operationId ??
      `scribe-${path.parse(src).name}-v3`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
    const paid = [
      ...(state.budget
        ? []
        : [
            line(
              pnpm(
                "budget",
                "--project",
                state.projectId,
                "--ceiling-usd",
                String(ceiling),
                "--answer",
                "<the user's words>",
              ),
            ),
          ]),
      line(scribeArgs("--operation-id", operationId)),
      line(next()),
    ];
    if (state.openScribe.length)
      return finish({
        ...step("transcript"),
        action: "ask",
        why: `A Scribe operation for this file is open (${state.openScribe.map((o) => `${o.operationId}: ${o.state}`).join(", ")}). Resume it with the same --operation-id; a new id could pay twice.`,
        question: `Resume the interrupted paid transcription (${usd} at list price, already reserved)?`,
        answers: ["yes, resume", "no"],
        cost,
        thenRun: paid,
        userDecides: ["Resuming the paid operation"],
      });
    const localFillers =
      language === "ru"
        ? 'speech:local seldom writes Russian fillers ("э", "эм") and never marks a standalone "ну"'
        : language === "en"
          ? 'speech:local writes out only English "um"/"uh"'
          : "speech:local is not verbatim: its recogniser drops most fillers";
    const fillers = wants("recut")
      ? ` Filler removal needs Scribe: ${localFillers}, and its word times run back to back, so recut:plan finds few pauses in it.`
      : "";
    const askLanguage = language ? "" : " Which language is spoken (e.g. ru, en)? It goes into --language.";
    const saveLanguage = language && goals.language ? [] : ["--language", languageFlag];
    return finish({
      ...step("transcript"),
      action: "ask",
      why: `No transcript of ${src} (sha256 ${state.sha256!.slice(0, 12)}) yet.${fillers}`,
      question: `Transcribe with ElevenLabs Scribe v3 (paid: ${cost.minutes} min, ${usd} at list price, verbatim with fillers and speakers) or with the free local engine?${askLanguage}`,
      answers: [`Scribe (${usd})`, "local (free)"],
      cost,
      thenRun: [
        `Scribe: ${[...(saveLanguage.length ? [line(next(state.projectId, ...saveLanguage))] : []), ...paid].join(" && ")}`,
        `local: ${line(next(state.projectId, "--transcriber", "local", ...saveLanguage))}`,
      ],
      userDecides: ["Paid transcription and its budget"],
      ...(scribeWanted ? {} : { optional: ["Without fillers to cut, the local engine is usually enough."] }),
    });
  }
  if (transcript.provider === "local" && wants("captions") && transcript.gluedWords.length) {
    const shown = transcript.gluedWords
      .slice(0, 12)
      .map((g) => `"${g.text}" ${clockSec(g.atSec)} (${g.why})`)
      .join("; ");
    advisories.push(
      `The local transcript has ${transcript.gluedWords.length} word(s) that look glued together, and captions would show them as written: ${shown}${transcript.gluedWords.length > 12 ? "; …" : ""}. Fix those words' text in ${transcript.file} (keep the times; then re-plan, as the transcript is part of the edit hash) or transcribe with Scribe (paid). Heuristic: 18+ letters (Cyrillic) or 20+ (other), or a Cyrillic word that splits into words used on their own elsewhere.`,
    );
  }
  if (transcript.language === "und" && !goals.language)
    advisories.push(
      `The transcript's language is "und"${transcript.textLanguage && transcript.textLanguage !== "und" ? ` (its text looks like ${transcript.textLanguage})` : ""}: run footage:next with --language <code> and pass --language to speech:local next time, so language-specific fillers are marked.`,
    );
  if (transcript.provider === "local" && wants("recut") && !goals.transcriber)
    advisories.push(
      `The transcript (${transcript.file}) is from the local engine: few fillers are marked. Scribe (paid) finds fillers; run footage:next with --transcriber scribe to be asked.`,
    );

  const planDir = path.dirname(transcript.file);
  const speechMask = state.speechMasks.find((m) => path.dirname(m) === planDir) ?? state.speechMasks[0] ?? null;
  if (!speechMask && needsTimeline) {
    return finish({
      ...step("mask"),
      action: "run",
      why: "No speech mask (Silero VAD) for this file. It is free and keeps cuts and short edges out of speech; speech:local writes it with a local transcript beside the main one.",
      run: [
        pnpm(
          "speech:local",
          "--input",
          src,
          "--output",
          `${planDir}/transcript-local.json`,
          "--vad-output",
          `${planDir}/speech-mask.json`,
          ...(language ? ["--language", language] : []),
        ),
      ],
    });
  }

  if (wants("multicam")) {
    if (!state.cameras.length)
      return finish({
        ...step("cameras"),
        action: "ask",
        why: "The goals include multicam but no other camera files are listed.",
        question: "Which other recordings of the same event are there (paths)?",
        thenRun: [line(next(state.projectId, "--cameras", "<file1,file2>"))],
      });
    if (!state.multicam.sync)
      return finish({
        ...step("cameras"),
        action: "run",
        why: "The cameras are not on one clock yet.",
        run: [pnpm("multicam:sync", "--inputs", src, ...state.cameras, "--output", `${work}/sync.json`)],
      });
    if (!state.multicam.angles) {
      if (!state.speakerMap)
        return finish({
          ...step("cameras"),
          action: "agent-task",
          why: "multicam:angles needs a map of which camera (and mic) shows each speaker.",
          task: speakerMapTask(state, transcript, `${work}/angles-map.json`, true),
          run: stills(state, transcript, work),
        });
      return finish({
        ...step("cameras"),
        action: "run",
        why: "Synced; propose the angle for each moment.",
        run: [
          pnpm(
            "multicam:angles",
            "--sync",
            state.multicam.sync,
            "--map",
            state.speakerMap,
            "--transcript",
            transcript.file,
            "--output",
            `${work}/angles.json`,
            "--command-output",
            `${work}/angles-edit.json`,
          ),
        ],
      });
    }
    advisories.push(
      `Angles are in ${state.multicam.angles} on the uncut reference clock. A recut timeline cannot take them; apply ${work}/angles-edit.json to an uncut timeline by hand (docs/multicam-reframe.md, "Into the timeline").`,
    );
  }
  if (!needsTimeline)
    return finish({
      ...step("done"),
      action: "stop",
      why: "The multicam angles are proposed; nothing else is in the goals.",
    });

  if (reframeFormats.length && !state.shots && !state.recut?.reframed.length) {
    return finish({
      ...step("shots"),
      action: "run",
      why: `The ${reframeFormats.join(" and ")} crop path resets at every shot, so find the shots first (local, free).`,
      run: [pnpm("footage:shots", "--input", src, "--output-dir", `${work}/shots`)],
    });
  }

  const recutId =
    state.request?.projectId ?? freeId(goals.recutId ?? `${state.projectId}-recut`, state.takenProjectIds);
  const pace = [
    ...(goals.midPauseMs !== undefined ? ["--mid-pause-ms", String(goals.midPauseMs)] : []),
    ...(goals.sentencePauseMs !== undefined ? ["--sentence-pause-ms", String(goals.sentencePauseMs)] : []),
    ...(goals.punchIn !== undefined ? ["--punch-in", String(goals.punchIn)] : []),
  ];
  const planArgs = (id: string, ...extra: string[]): Command =>
    pnpm(
      "recut:plan",
      "--transcript",
      transcript.file,
      "--project-id",
      id,
      "--speech-mask",
      speechMask!,
      "--formats",
      formats.join(","),
      ...(wants("recut") ? [] : ["--no-fillers", "--no-retakes", "--long-pause-ms", "60000"]),
      ...pace,
      ...extra,
    );
  const keepAll = wants("recut")
    ? ""
    : " The goals have no recut, so the plan keeps every pause, filler and retake and trims only leading and trailing silence: captions and reframing need a timeline project.";
  if (!state.recut) {
    const request = state.request;
    if (!request)
      return finish({
        ...step("plan"),
        action: "run",
        why: `No recut plan for this transcript yet.${keepAll} It writes recut-request.json and recut-plan.md next to the transcript and prints the edit hash a person approves.`,
        run: [planArgs(recutId)],
      });
    const missingFormats = formats.filter((f) => !request.formats.includes(f));
    const approvedNow = request.approvedEditHash !== null && request.approvedEditHash === request.planHash;
    if (missingFormats.length && !approvedNow)
      return finish({
        ...step("plan"),
        action: "run",
        why: `The plan in ${request.file} lacks the format(s) ${missingFormats.join(", ")}. Plan again with every format (--force rewrites the request; it has no matching approval yet). Pass the cut ids the user rejected before with --reject.`,
        run: [planArgs(request.projectId, "--force")],
      });
    if (!request.planHash)
      return finish({
        ...step("plan"),
        action: "run",
        why: `${request.file} has no recut-plan.md with an edit hash beside it; the workflow's plan prints the hash (no files written).`,
        run: [pnpm("video:workflow", "--scenario", "recording-edit", "--request", request.file, "--action", "plan")],
      });
    if (!approvedNow) {
      const stale = request.approvedEditHash
        ? ` The review in it approves ${request.approvedEditHash.slice(0, 12)}…, but the plan now has ${request.planHash.slice(0, 12)}…, so that approval no longer applies.`
        : "";
      return finish({
        ...step("approve"),
        action: "ask",
        why: `The recut plan waits for a person's approval.${stale}`,
        show: [request.planFile!, request.file],
        question: `Watch the whole source (${src}) and read ${request.planFile}. Reject any cut that changes meaning (${idRange(request.cuts)}). When you are satisfied, add to ${request.file} yourself: "review": {"reviewer": "<your name>", "reviewedAt": "<ISO date-time>", "approvedEditHash": "${request.planHash}", "meaningPreserved": true}. An agent never writes this.`,
        answers: ["approved as is (I added the review)", "reject <ids from the plan>"],
        thenRun: [
          `If cuts were rejected: ${line(planArgs(request.projectId, "--reject", "<ids, including earlier rejections>", "--force"))}`,
          line(next()),
        ],
        userDecides: ["Which cuts to reject", "The review with the edit hash"],
        ...(request.cuts.some((c) => c.kind === "retake")
          ? {
              optional: [
                `Retakes ${request.cuts
                  .filter((c) => c.kind === "retake")
                  .map((c) => c.id)
                  .join(
                    ", ",
                  )}: a \"retake\" can be a deliberate parallel (\"sometimes more frequent, sometimes more intense\"); check before approving.`,
              ],
            }
          : {}),
      });
    }
    if (state.takenProjectIds.includes(request.projectId)) {
      const fresh = freeId(request.projectId, state.takenProjectIds);
      return finish({
        ...step("plan"),
        action: "ask",
        why: `Project ${request.projectId} already exists and is not this approved recut. A recut is always a new project, and the project id is part of the edit hash, so a new id needs a new plan and a new approval.`,
        question: `Plan again as ${fresh}? The approval has to be given again for the new hash.`,
        answers: ["yes"],
        thenRun: [line(planArgs(fresh, "--force")), line(next())],
        userDecides: ["Re-approval under a new project id"],
      });
    }
    return finish({
      ...step("create"),
      action: "run",
      why: `The plan is approved (edit hash ${request.planHash.slice(0, 12)}…). Create the recut as project ${request.projectId}; the original stays untouched.`,
      run: [pnpm("video:workflow", "--scenario", "recording-edit", "--request", request.file, "--action", "create")],
    });
  }
  const recut = state.recut;
  if (state.request && state.request.projectId !== recut.projectId && state.request.mtimeMs > recut.mtimeMs)
    advisories.push(`${state.request.file} plans a newer recut (${state.request.projectId}) that is not created yet.`);
  const unplanned =
    state.request?.projectId === recut.projectId ? formats.filter((f) => !state.request!.formats.includes(f)) : [];
  if (unplanned.length)
    advisories.push(
      `The recut's request did not list ${unplanned.join(", ")}; check that format's crop before delivering it.`,
    );
  const timelineFile = `public/projects/${recut.projectId}/pipeline/timeline-edit.json`;
  const editFile = `public/projects/${recut.projectId}/pipeline/recording-edit.json`;
  const edit = (command: string, ...flag: string[]) =>
    pnpm(
      "timeline:edit",
      "--project",
      recut.projectId,
      "--revision",
      String(recut.revision),
      command.startsWith("{") ? "--command" : "--command-file",
      command,
      ...flag,
    );

  if (wants("captions")) {
    const captionPolicy = goals.captionStyle ? {} : captionStyleUnderPolicy(state.policy);
    if (captionPolicy.style)
      return finish({
        ...step("captions"),
        action: "run",
        why: `Captions are a goal and the user pre-answered the style in their policy: ${captionPolicy.style}. The decision goes to pipeline/decisions.jsonl; the user can revoke it with film:revert.`,
        run: [
          pnpm(
            "footage:policy-apply",
            "--project",
            state.projectId,
            "--apply",
            "captionStyle",
            "--expect",
            state.policy!.goalsSha256 ?? "none",
          ),
          next(),
        ],
        policy: { basis: "preAnswer", evidence: { preAnswer: `captionStyle=${captionPolicy.style}` } },
      });
    if (!goals.captionStyle)
      return finish({
        ...step("captions"),
        action: "ask",
        why: "Captions are a goal but no style is chosen.",
        ...(captionPolicy.warning ? { advisories: [captionPolicy.warning] } : {}),
        question:
          "Which caption style: outline pop, yellow italic shadow, key-word colour, sliding word box, line box, chunky stack, editorial mixed scale, clean sentence, single-word punch or typewriter?",
        answers: CAPTION_CHOICES,
        thenRun: [line(next(state.projectId, "--caption-style", "<style>"))],
        show: [".agents/skills/captions-and-localization/references/caption-styles.md"],
      });
    if (recut.captionStyle !== goals.captionStyle) {
      const command = JSON.stringify({ type: "caption-style", style: { profile: goals.captionStyle } });
      const rendered = formats.filter((f) => recut.renders[f] && recut.renders[f].state !== "missing");
      return finish({
        ...step("captions"),
        action: "run",
        why: `The timeline's caption style is ${recut.captionStyle ?? "karaoke (unset)"}; the goals want ${goals.captionStyle}. Dry-run, then apply at revision ${recut.revision}.`,
        run: [edit(command, "--dry-run"), edit(command)],
        ...(rendered.length
          ? {
              optional: [
                `The next render archives the previous versions of ${rendered.map((f) => recut.renders[f]!.file).join(", ")} by checksum.`,
              ],
            }
          : {}),
      });
    }
  }

  for (const format of reframeFormats) {
    if (recut.reframed.includes(format)) continue;
    const multiSpeaker = transcript.diarized && transcript.speakers.length >= 2;
    if (multiSpeaker && !state.speakerMap)
      return finish({
        ...step("vertical"),
        action: "agent-task",
        why: `${transcript.speakers.length} speakers share the frame, so the ${format} crop should follow whoever speaks; that needs a map of where each sits.`,
        task: speakerMapTask(state, transcript, `${work}/angles-map.json`, false),
        run: stills(state, transcript, work),
      });
    const cropPath = `${work}/crop-path-${format}.json`;
    const commandFile = `${work}/reframe-${format}-edit.json`;
    const commandPath = path.resolve(state.rootDir, commandFile);
    const current = existsSync(commandPath) && mtime(commandPath) >= mtime(path.resolve(state.rootDir, editFile));
    const track = pnpm(
      "reframe:track",
      "--input",
      src,
      "--format",
      format,
      "--output",
      cropPath,
      ...(state.shots ? ["--shots", state.shots] : []),
      ...(multiSpeaker ? ["--transcript", transcript.file, "--map", state.speakerMap!] : []),
      "--recording-edit",
      editFile,
      "--timeline",
      timelineFile,
      "--track-id",
      recut.pictureTrackId,
      "--clip-id",
      "all",
      "--command-output",
      commandFile,
    );
    return finish({
      ...step("vertical"),
      action: "run",
      why: `The recut has no ${format} crop path, so it would render a centred cover crop.${current ? ` ${commandFile} is already written; dry-run and apply it.` : ""} Look at the crop on a few stills before rendering.`,
      run: [...(current ? [] : [track]), edit(commandFile, "--dry-run"), edit(commandFile)],
    });
  }

  // Placement and legibility are measured on the picture as it will render, so after any crop; vertical first, as its
  // platform interface leaves the least room.
  const placeable = goals.captionStyle && !["karaoke", "phrase", "keyword", "bilingual"].includes(goals.captionStyle);
  const wantedZone = goals.placement ? uiZoneOf(goals.placement, goals.platform ?? "all") : undefined;
  const zoneChanged =
    recut.captionsPlaced && wantedZone !== undefined && (recut.captionUiZone ?? "organic") !== wantedZone;
  if (wants("captions") && placeable && (!recut.captionsPlaced || zoneChanged)) {
    const format = formats.includes("vertical") ? "vertical" : formats[0]!;
    const commandFile = `public/projects/${recut.projectId}/pipeline/caption-place.json`;
    const ad = goals.placement
      ? [
          "--placement",
          goals.placement,
          ...(goals.placement === "ad" && goals.platform ? ["--platform", goals.platform] : []),
        ]
      : [];
    const interfaceName =
      goals.placement === "ad" ? `${goals.platform ?? "TikTok, Reels and Shorts"} ad` : `${format} platform`;
    const adOffer =
      !goals.placement && (playbook ?? state.playbook) === "ugc-ad"
        ? [
            `The project's playbook is ugc-ad: if this cut runs as a paid ad, record it (${line(next(state.projectId, "--placement", "ad"))}) so captions clear the larger ad interface (TikTok in-feed covers the bottom 660 px).`,
          ]
        : [];
    return finish({
      ...step("captions"),
      action: "run",
      why: `${zoneChanged ? `The captions were placed for the ${recut.captionUiZone ?? "organic"} interface; the goals now want ${wantedZone}.` : `The ${goals.captionStyle} captions are not placed yet.`} captions:place renders a clean still of every page (about a second each), keeps each page clear of faces, printed text and the ${interfaceName} interface, picks the legibility level, and writes ${commandFile}; dry-run, then apply it. Its report names any page that still covers a face or fails contrast.`,
      run: [
        pnpm("captions:place", "--project", recut.projectId, "--format", format, ...ad),
        edit(commandFile, "--dry-run"),
        edit(commandFile),
      ],
      optional: [
        ...adOffer,
        "An explicit position in the caption-style options (lower, middle, upper) wins: captions:place then only measures legibility.",
      ],
    });
  }

  const captions = wants("captions") ? "on" : "off";
  const fullRender = (format: FootageFormat) => {
    const name = captions === "off" ? `${format}-clean` : format;
    return recut.renders[name] ?? { state: "missing" as const, file: `out/${recut.projectId}/${name}.mp4` };
  };

  if (wants("shorts")) {
    const shortsDir = state.shorts?.dir ?? `${work}/shorts`;
    if (!recut.chapters)
      return finish({
        ...step("shorts"),
        action: "run",
        why: `${recut.projectId} has no pipeline/chapters.json; shorts:rank checks protected spans against it, so write it first (chapters only, no approval).`,
        run: [pnpm("shorts:request", "--project", recut.projectId)],
      });
    if (!state.shorts)
      return finish({
        ...step("shorts"),
        action: "run",
        why: "Number the transcript's sentences for choosing shorts.",
        run: [
          pnpm(
            "shorts:prepare",
            "--transcript",
            transcript.file,
            "--output-dir",
            shortsDir,
            ...(goals.shortsBrief ? ["--brief", goals.shortsBrief] : []),
          ),
        ],
        optional: ['--brief "who the shorts are for" (or footage:next --shorts-brief) sharpens the relevance score.'],
      });
    if (!state.shorts.candidates)
      return finish({
        ...step("shorts"),
        action: "agent-task",
        why: "Shorts candidates are the agent's judgement, scored on quoted evidence; code then checks and ranks them.",
        task: `Read ${shortsDir}/brief.md and every ${shortsDir}/chunk-NN.md, then write ${shortsDir}/candidates.json in the schema brief.md gives: whole sentences in order, six axes 0–10 each with a verbatim quote, vetoes, no total. Then run footage:next again.`,
        show: [`${shortsDir}/brief.md`],
      });
    const proposals = state.shorts.proposals;
    if (!proposals || !proposals.fresh || proposals.projectId !== recut.projectId)
      return finish({
        ...step("shorts"),
        action: "run",
        why: !proposals
          ? "Rank the candidates against the recut's timeline."
          : proposals.projectId !== recut.projectId
            ? `The proposals were ranked against ${proposals.projectId ?? "no project"}, not ${recut.projectId}; rank again for ShortSelection drafts on the recut.`
            : "candidates.json changed since the last rank.",
        run: [
          pnpm(
            "shorts:rank",
            "--prepared",
            shortsDir,
            "--candidates",
            state.shorts.candidates,
            "--project",
            recut.projectId,
            "--speech-mask",
            speechMask!,
          ),
        ],
      });
    const seriesRevokedBy = state.series ? (state.policy?.seriesRevokedBy ?? null) : null;
    if (!state.series || seriesRevokedBy) {
      if (proposals.proposed.length + proposals.others.length < 2)
        return finish({
          ...step("shorts"),
          action: "stop",
          why: `Fewer than two clips survived ranking (${proposals.file}); a series needs at least two. Write more candidates or adjust them, then rank again.`,
          show: [proposals.file.replace(/\.json$/, ".md")],
        });
      const shortsPolicy = shortsUnderPolicy(state.policy, proposals.proposed);
      if (shortsPolicy.ids)
        return finish({
          ...step("shorts"),
          action: "run",
          why: `The user's policy approves ${shortsPolicy.basis === "preAnswer" ? `the top ${shortsPolicy.ids.length} ranked clips (pre-answer shorts=${shortsPolicy.ids.length})` : "every proposed clip (auto-pass shorts)"}: ${shortsPolicy.ids.join(", ")}. footage:policy-apply writes the series request with the policy's approval and the decision to pipeline/decisions.jsonl; the user can revoke it with film:revert.`,
          run: [
            pnpm(
              "footage:policy-apply",
              "--project",
              state.projectId,
              "--apply",
              "shorts",
              "--expect",
              state.policy!.proposalsSha256 ?? "none",
            ),
            next(),
          ],
          show: [proposals.file.replace(/\.json$/, ".md")],
          policy: {
            basis: shortsPolicy.basis!,
            evidence: {
              [shortsPolicy.basis === "preAnswer" ? "preAnswer" : "autoPass"]:
                shortsPolicy.basis === "preAnswer" ? `shorts=${shortsPolicy.ids.length}` : "shorts",
            },
          },
        });
      const shortsNotes = [
        ...(seriesRevokedBy
          ? [
              `The user revoked the policy's approval of ${state.series!.file} (${seriesRevokedBy}): ask them which clips; episode projects already created stay until removed (pnpm project:remove).`,
            ]
          : []),
        ...(shortsPolicy.warning ? [shortsPolicy.warning] : []),
      ];
      return finish({
        ...step("shorts"),
        action: "ask",
        why: "The shorts wait for the user's own approval, clip by clip.",
        ...(shortsNotes.length ? { advisories: shortsNotes } : {}),
        show: [proposals.file.replace(/\.json$/, ".md")],
        question: `Watch each proposed range (${proposals.proposed.join(", ") || "none above the threshold"}${proposals.others.length ? `; others: ${proposals.others.join(", ")}` : ""}). Which clips (at least two) do you approve?`,
        answers: [proposals.proposed.slice(0, 3).join(",") || proposals.others.slice(0, 2).join(",")],
        thenRun: [
          line(
            pnpm(
              "shorts:request",
              "--project",
              recut.projectId,
              "--selections",
              proposals.file,
              "--ids",
              "<ids the user approved>",
              "--approved-by",
              "<the user's own words>",
            ),
          ),
          line(next()),
        ],
        userDecides: ["Which shorts to approve (recorded with --approved-by in the user's own words, never inferred)"],
      });
    }
    const series = state.series;
    if (series.created.length < series.episodes)
      return finish({
        ...step("shorts"),
        action: "run",
        why: `The ${series.seriesId} request is approved; create its ${series.episodes} episode projects (the plan checks it first, without writing).`,
        run: [
          pnpm("video:workflow", "--scenario", "shorts-series", "--action", "plan", "--request", series.file),
          pnpm("video:workflow", "--scenario", "shorts-series", "--action", "create", "--request", series.file),
        ],
      });
    const unrendered = series.created.filter((e) => !e.rendered);
    if (unrendered.length)
      return finish({
        ...step("shorts"),
        action: "run",
        why: `${unrendered.length} short(s) not rendered yet.`,
        run: unrendered.map((e) => pnpm("render", "--project", e.projectId, "--format", "vertical", "--timeline")),
      });
  }

  // With shorts as a goal the shorts are the deliverable: the full recut's renders become optional at the end.
  for (const format of wants("shorts") ? [] : formats) {
    const render = fullRender(format);
    if (render.state === "fresh") continue;
    const why =
      render.state === "stale"
        ? `${render.file} is older than the timeline (an edit was applied after it). Rendering archives the previous master and rebuilds the changed picture where supported.`
        : `No full ${format} render${captions === "off" ? " without captions" : ""} of ${recut.projectId} yet.`;
    return finish({
      ...step("render"),
      action: "run",
      why: `${why} The render is refused if an input changes while it runs; a stalled render is retried once.`,
      run: [
        pnpm(
          "render",
          "--project",
          recut.projectId,
          "--format",
          format,
          "--timeline",
          ...(captions === "off" ? ["--captions", "off"] : []),
        ),
      ],
      optional: [
        `Preview a part first: ${line(pnpm("render", "--project", recut.projectId, "--format", format, "--timeline", "--frames", "0-299"))} (an excerpt with a partial receipt; delivery never accepts it).`,
      ],
    });
  }

  return finish({
    ...step("done"),
    action: "stop",
    why: `Every goal is done: ${goals.goals.join(", ")} for ${formats.join(", ")}. Quality and meaning are the user's judgement: they watch the renders.`,
    optional: [
      `Delivery check: ${line(["pnpm", "exec", "tsx", "scripts/delivery.ts", "--project", recut.projectId, "--action", "snapshot"])} then --action check (docs/delivery.md).`,
      ...(wants("shorts")
        ? formats
            .filter((format) => fullRender(format).state !== "fresh")
            .map(
              (format) =>
                `The whole recut is not needed for the shorts; if the user also wants it in ${format}: ${line(pnpm("render", "--project", recut.projectId, "--format", format, "--timeline", ...(captions === "off" ? ["--captions", "off"] : [])))}`,
            )
        : []),
      ...(wants("shorts")
        ? [
            `After the user rates ten clips 1–5: ${line(pnpm("shorts:calibrate", "--proposals", state.shorts?.proposals?.file ?? "<proposals.json>", "--ratings", "<ratings.json>", "--project", recut.projectId))}`,
          ]
        : []),
    ],
  });
}

function idRange(cuts: { id: string }[]): string {
  if (!cuts.length) return "the plan lists each cut's id";
  return cuts.length === 1
    ? `the plan's only cut is ${cuts[0]!.id}`
    : `the plan's cut ids are ${cuts[0]!.id}–${cuts.at(-1)!.id}`;
}

function freeId(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  const stem = base.replace(/\d+$/, "");
  for (let n = 2; ; n++) if (!taken.includes(`${stem}${n}`)) return `${stem}${n}`;
}

function stills(state: FootageState, transcript: TranscriptInfo, work: string): Command[] {
  return [
    ["mkdir", "-p", `${work}/stills`],
    ...transcript.firstWords.map((w): Command => [
      "ffmpeg",
      "-v",
      "error",
      "-y",
      "-ss",
      ((w.startSec + w.endSec) / 2).toFixed(2),
      "-i",
      state.source!.file,
      "-frames:v",
      "1",
      `${work}/stills/${w.speaker}.jpg`,
    ]),
  ];
}

function speakerMapTask(state: FootageState, transcript: TranscriptInfo, mapFile: string, multicam: boolean): string {
  const speakers = transcript.speakers.length ? transcript.speakers : ["speaker_0", "speaker_1"];
  const example = {
    version: 1,
    speakers: speakers.map((speaker, i) => ({
      speaker,
      angle: "wide",
      position: Number(((i + 0.5) / speakers.length).toFixed(2)),
    })),
    wide: "wide",
  };
  return [
    `Make the speaker map yourself; it is an agent task, not a user decision. Run the still commands: one frame in the middle of each speaker's first long sentence${state.shots ? `; if a still is a close-up, pick a time in a wide shot from ${state.shots}` : ""}.`,
    `Match each transcript speaker id (${speakers.join(", ")}) to a face by who speaks in that still, read each face's horizontal centre as a fraction of the width (0 left, 1 right) and write ${mapFile}:`,
    JSON.stringify(example),
    multicam
      ? "With several cameras, set each speaker's `angle` to the camera (sync id) that frames them, `wide` to the wide camera, and `mic` when each has their own microphone."
      : "`angle` stays the single camera's name, `wide` the same.",
    "Then run footage:next again.",
  ].join("\n");
}

export function summarise(state: FootageState): Record<string, unknown> {
  return {
    project: state.projectId,
    ...(state.redirectedFrom ? { requested: state.redirectedFrom.projectId } : {}),
    goals: state.goals ? { ...state.goals, version: undefined } : null,
    ...(state.goalsSaved ? { goalsSaved: state.goalsFile } : {}),
    source: state.source
      ? {
          file: state.source.file,
          sha256: state.sha256,
          size: state.source.width ? `${state.source.width}x${state.source.height}` : null,
          fps: state.source.fps,
          durationSec: state.source.durationSec,
          problems: state.source.problems.map((p) => p.code),
        }
      : null,
    transcripts: state.transcripts.map(
      (t) =>
        `${t.file} (${t.provider} ${t.model}${t.diarized ? `, ${t.speakers.length} speakers` : ""}${t.valid ? "" : ", invalid"})`,
    ),
    speechMasks: state.speechMasks,
    shots: state.shots,
    speakerMap: state.speakerMap,
    request: state.request
      ? {
          file: state.request.file,
          projectId: state.request.projectId,
          planHash: state.request.planHash,
          approved:
            state.request.approvedEditHash !== null && state.request.approvedEditHash === state.request.planHash,
        }
      : null,
    recut: state.recut
      ? {
          projectId: state.recut.projectId,
          revision: state.recut.revision,
          captionStyle: state.recut.captionStyle,
          reframed: state.recut.reframed,
          renders: Object.fromEntries(
            Object.entries(state.recut.renders)
              .filter(([, r]) => r!.state !== "missing")
              .map(([f, r]) => [f, r!.state]),
          ),
        }
      : null,
    ...(state.shorts
      ? {
          shorts: {
            dir: state.shorts.dir,
            candidates: Boolean(state.shorts.candidates),
            proposals: state.shorts.proposals
              ? {
                  rankedAgainst: state.shorts.proposals.projectId,
                  fresh: state.shorts.proposals.fresh,
                  proposed: state.shorts.proposals.proposed,
                }
              : null,
          },
        }
      : {}),
    ...(state.series
      ? {
          series: {
            seriesId: state.series.seriesId,
            episodes: state.series.episodes,
            created: state.series.created.map((e) => `${e.projectId}${e.rendered ? " (rendered)" : ""}`),
          },
        }
      : {}),
  };
}

/**
 * Where the answer waits on the user or follows a delivery: the plan and shorts approvals are verdicts (a plan changed
 * after its approval, a rejection); caption style and asks the user decides are choices; done is a delivery.
 */
export function footageCaptureMoment(
  next: Pick<FootageNext, "action" | "step" | "userDecides">,
  state: Pick<FootageState, "request">,
): CaptureMoment | undefined {
  if (next.action === "stop") return next.step === STEP.done[0] ? "delivery" : undefined;
  if (next.action !== "ask") return undefined;
  if (next.step === STEP.approve[0]) return state.request?.approvedEditHash ? "rejection" : "verdict";
  if (next.step === STEP.shorts[0]) return "verdict";
  return next.step === STEP.captions[0] || next.userDecides?.length ? "choice" : undefined;
}

export function footageNext(projectId: string, options: ReadOptions = {}): FootageNext {
  return footageNextWithState(projectId, options).next;
}

/** {@link footageNext} with the state it decided from (the studio console reads the material from it, one walk). */
export function footageNextWithState(
  projectId: string,
  options: ReadOptions = {},
): { next: FootageNext; state: FootageState } {
  const state = readFootageState(projectId, options);
  // The user's open feedback first (pnpm feedback): its step until its output moves, then settled.
  const reopened = footageFeedbackNext(state);
  const next: FootageNext = reopened ? { ...reopened, state: summarise(state) } : decideNext(state, options.playbook);
  const projectDir = path.join(state.rootDir, "public/projects", state.projectId);
  const moment = footageCaptureMoment(next, state);
  const delivered = moment === "delivery" && state.request ? { project: state.request.projectId } : {};
  return {
    state,
    next: {
      ...next,
      ...withPlaybook(projectDir, footageRead(next.step), next.step),
      ...memoryFields(projectDir, next.step, state.playbook),
      ...captureFields(projectDir, moment, next.step, {
        ...(state.playbook ? { playbook: state.playbook } : {}),
        ...delivered,
      }),
    },
  };
}
