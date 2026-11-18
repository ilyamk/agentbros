/**
 * The recording's material for the console's footage panels (RFC 0004 US19, §5.2, A15; WP12): the source, a transcript
 * excerpt with word times, the recut plan's cuts (pause, filler, retake, head, tail) with before/after timing, the
 * caption style, the shorts candidates with their scores, the camera angles, the reframe paths and the renders per
 * format. Built from footage:next's own state (one walk of `pipeline/`), reading only the files that state names.
 *
 * Read-only and advisory: each section is read on its own; a missing file leaves the section out, a malformed one
 * leaves it out with an advisory. Never throws. Cheap (§4.4): what is derived from a file is memoised by (path, size,
 * mtime), so a long transcript is parsed once per change, and nothing is hashed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  FOOTAGE_CUT_KINDS,
  FOOTAGE_CUTS_MAX,
  FOOTAGE_WORDS_MAX,
  FILM_LIST_MAX,
  FootageMaterialSchema,
  ProjectIdSchema,
  Sha256Schema,
  type FootageMaterial,
  type MediaRef,
} from "../../../types/console";
import { CAPTION_CHOICES, type FootageState } from "../../footage/next";
import { statOf, text, type ProjectPaths } from "./files";
import { fileRef } from "./film-material";

type Format = "vertical" | "square" | "landscape";
const FORMATS: readonly Format[] = ["landscape", "vertical", "square"];
/** Largest file the reader parses (footage:next skips larger JSON too). */
const MAX_JSON_BYTES = 40 * 1024 * 1024;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_POINTS = 120;
const MAX_SEGMENTS = 400;

// --- Memoised derivations ---

const MEMO_MAX = 256;
const memo = new Map<string, { key: string; value: unknown }>();
const CORRUPT = Symbol("corrupt");
type Derived<T> = T | undefined | typeof CORRUPT;

/** `derive(content)` of a file, memoised by path, size and mtime; undefined when absent, CORRUPT when unreadable. */
function derived<T>(file: string, tag: string, limit: number, derive: (raw: string) => T | undefined): Derived<T> {
  const info = statOf(file);
  if (!info?.isFile()) return undefined;
  const key = `${tag}:${info.size}:${info.mtimeMs}`;
  const id = `${tag}:${file}`;
  const known = memo.get(id);
  if (known?.key === key) return known.value as Derived<T>;
  let value: Derived<T>;
  try {
    value = info.size > limit ? CORRUPT : (derive(readFileSync(file, "utf8")) ?? CORRUPT);
  } catch {
    value = CORRUPT;
  }
  if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value!);
  memo.set(id, { key, value });
  return value;
}

const json = <T>(file: string, tag: string, pick: (value: any) => T | undefined): Derived<T> =>
  derived(file, tag, MAX_JSON_BYTES, (raw) => pick(JSON.parse(raw)));

type Reader = { paths: ProjectPaths; state: FootageState; advisories: string[] };

/** A footage:next display path (repository-relative or absolute) as an absolute file. */
const absolute = (reader: Reader, file: string) => path.resolve(reader.paths.rootDir, file);

function settle<T>(reader: Reader, value: Derived<T>, label: string): T | undefined {
  if (value === CORRUPT) {
    reader.advisories.push(`footage material: ${label} is not readable; its panel shows less.`);
    return undefined;
  }
  return value;
}

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const cut = (value: unknown, max: number): string | undefined => {
  const found = text(value, max + 1);
  if (!found) return undefined;
  return found.length > max ? `${found.slice(0, max - 1)}…` : found;
};
const round = (value: number) => Math.round(value * 1000) / 1000;
/** Frames per second of a `{ num, den }` rational or a number. */
function fpsOf(value: unknown): number | undefined {
  if (typeof value === "number" && value > 0) return value;
  const rational = value as { num?: unknown; den?: unknown } | undefined;
  const n = num(rational?.num);
  const d = num(rational?.den);
  return n && d ? n / d : undefined;
}

// --- Sections ---

function readSource(reader: Reader): FootageMaterial["source"] {
  const source = reader.state.source;
  if (!source) return undefined;
  const media = fileRef(reader.paths, absolute(reader, source.file), {
    ...(source.durationSec !== null ? { durationSec: source.durationSec } : {}),
    ...(source.width ? { width: source.width } : {}),
    ...(source.height ? { height: source.height } : {}),
  });
  const fps = fpsOf(
    /^(\d+)\/(\d+)$/.test(source.fps ?? "")
      ? { num: Number(source.fps!.split("/")[0]), den: Number(source.fps!.split("/")[1]) }
      : undefined,
  );
  return {
    ...(media?.kind === "video" ? { media: fps ? { ...media, fps } : media } : {}),
    file: source.file.slice(0, 1024),
    ...(source.durationSec !== null ? { durationSec: source.durationSec } : {}),
    ...(source.width ? { width: source.width } : {}),
    ...(source.height ? { height: source.height } : {}),
    ...(source.fps ? { fps: source.fps.slice(0, 32) } : {}),
    problems: source.problems.map((problem) => problem.message.slice(0, 500)).slice(0, 16),
  };
}

type TranscriptExcerpt = Pick<
  NonNullable<FootageMaterial["transcript"]>,
  "speakers" | "wordCount" | "words" | "truncated"
> & { durationSec?: number };

function transcriptExcerpt(value: any): TranscriptExcerpt | undefined {
  if (!value || !Array.isArray(value.words)) return undefined;
  const counts = new Map<string, number>();
  for (const word of value.words)
    if (typeof word?.speaker === "string") counts.set(word.speaker, (counts.get(word.speaker) ?? 0) + 1);
  const labels = new Map<string, string>(
    (Array.isArray(value.speakers) ? value.speakers : [])
      .filter((s: any) => typeof s?.id === "string")
      .map((s: any) => [s.id, typeof s.label === "string" ? s.label : ""]),
  );
  const ids = [...new Set([...labels.keys(), ...counts.keys()])].slice(0, 16);
  const words = (value.words as any[])
    .filter((word) => typeof word?.text === "string" && word.text.trim() && num(word.startSec) !== undefined)
    .slice(0, FOOTAGE_WORDS_MAX)
    .map((word) => {
      const start = num(word.startSec)!;
      return {
        text: word.text.trim().slice(0, 64),
        start,
        end: Math.max(start, num(word.endSec) ?? start),
        ...(typeof word.speaker === "string" && word.speaker ? { speaker: word.speaker.slice(0, 64) } : {}),
        ...(word.kind === "word" || word.kind === "filler" || word.kind === "event" ? { kind: word.kind } : {}),
      };
    });
  const duration = num(value.source?.durationSec);
  return {
    speakers: ids.map((id) => ({
      id: id.slice(0, 64),
      ...(labels.get(id) ? { label: labels.get(id)!.slice(0, 120) } : {}),
      words: counts.get(id) ?? 0,
    })),
    wordCount: value.words.length,
    words,
    truncated: value.words.length > words.length,
    ...(duration !== undefined ? { durationSec: duration } : {}),
  };
}

function readTranscript(reader: Reader): FootageMaterial["transcript"] {
  const info = reader.state.transcripts[0];
  if (!info) return undefined;
  const excerpt = settle(
    reader,
    json(absolute(reader, info.file), "transcript", transcriptExcerpt),
    path.basename(info.file),
  );
  if (!excerpt) return undefined;
  return {
    provider: info.provider,
    model: (cut(info.model, 64) ?? "unknown").slice(0, 64),
    language: (cut(info.textLanguage ?? info.language, 32) ?? "und").slice(0, 32),
    verbatim: info.verbatim,
    diarized: info.diarized,
    ...excerpt,
    glued: info.gluedWords.slice(0, 24).map((word) => ({
      text: word.text.slice(0, 64) || "?",
      atSec: Math.max(0, word.atSec),
      why: word.why.slice(0, 160) || "?",
    })),
  };
}

type PlanText = {
  cuts: NonNullable<FootageMaterial["plan"]>["cuts"];
  sourceSec?: number;
  outputSec?: number;
  removedSec?: number;
  protectedCount: number;
};

const CUT_LINE = /^- \[[ x]\] \*\*(C\d+)\*\* (\w+) · (\d+):(\d+(?:\.\d+)?)–(\d+):(\d+(?:\.\d+)?)/;
const DURATION_LINE = /^- Duration: ([\d.]+)s → ([\d.]+)s \(([\d.]+)s removed\)/m;
const KINDS = new Set<string>(FOOTAGE_CUT_KINDS);

/** The cuts of recut-plan.md (renderRecutMarkdown): id, kind, span, the words around the cut and the reason. */
export function parseRecutPlan(markdown: string): PlanText {
  const lines = markdown.split("\n");
  const cuts: PlanText["cuts"] = [];
  let protectedCount = 0;
  let section = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("## ")) section = line;
    if (section.startsWith("## Protected") && /^- \w[\w-]* · frames \d+–\d+/.test(line)) protectedCount++;
    const match = CUT_LINE.exec(line);
    if (!match || !KINDS.has(match[2]!) || cuts.length >= FOOTAGE_CUTS_MAX) continue;
    const startSec = Number(match[3]) * 60 + Number(match[4]);
    const endSec = Number(match[5]) * 60 + Number(match[6]);
    const detail = (offset: number) => {
      const next = lines[i + offset];
      return next?.startsWith("  - ") ? next.slice(4).trim() : undefined;
    };
    const words = detail(1);
    const reason = detail(2);
    cuts.push({
      id: match[1]!,
      kind: match[2] as (typeof FOOTAGE_CUT_KINDS)[number],
      startSec: round(startSec),
      endSec: round(Math.max(startSec, endSec)),
      ...(words ? { text: cut(words, 500) } : {}),
      ...(reason && !reason.startsWith("Evidence:") ? { reason: cut(reason, 500) } : {}),
    });
  }
  const duration = DURATION_LINE.exec(markdown);
  return {
    cuts,
    protectedCount,
    ...(duration
      ? { sourceSec: Number(duration[1]), outputSec: Number(duration[2]), removedSec: Number(duration[3]) }
      : {}),
  };
}

/** The request's kept spans in source seconds (frames over the request's source fps). */
function keptSpans(value: any): { startSec: number; endSec: number }[] | undefined {
  const fps = fpsOf(value?.source?.fps);
  if (!fps || !Array.isArray(value?.keepSpans)) return undefined;
  return (value.keepSpans as any[])
    .filter((span) => num(span?.startFrame) !== undefined && num(span?.endFrame) !== undefined)
    .slice(0, FOOTAGE_CUTS_MAX)
    .map((span) => ({
      startSec: round(span.startFrame / fps),
      endSec: round(Math.max(span.startFrame, span.endFrame) / fps),
    }));
}

function readPlan(reader: Reader): FootageMaterial["plan"] {
  const request = reader.state.request;
  if (!request || !ProjectIdSchema.safeParse(request.projectId).success) return undefined;
  const planText = request.planFile
    ? settle(
        reader,
        derived(absolute(reader, request.planFile), "plan", MAX_TEXT_BYTES, parseRecutPlan),
        path.basename(request.planFile),
      )
    : undefined;
  const keep = settle(reader, json(absolute(reader, request.file), "keep", keptSpans), path.basename(request.file));
  const doc = request.planFile ? fileRef(reader.paths, absolute(reader, request.planFile), {}, "document") : undefined;
  const hash = (value: string | null) => (value && Sha256Schema.safeParse(value).success ? value : undefined);
  const editHash = hash(request.planHash);
  const approved = hash(request.approvedEditHash);
  return {
    ...(doc ? { doc: { ...doc, label: "recut-plan.md" } } : {}),
    recutProject: request.projectId,
    ...(editHash ? { editHash } : {}),
    ...(approved ? { approvedEditHash: approved } : {}),
    formats: request.formats.filter((format): format is Format => FORMATS.includes(format as Format)).slice(0, 3),
    ...(planText?.sourceSec !== undefined ? { sourceSec: planText.sourceSec } : {}),
    ...(planText?.outputSec !== undefined ? { outputSec: planText.outputSec } : {}),
    ...(planText?.removedSec !== undefined ? { removedSec: planText.removedSec } : {}),
    cuts: planText?.cuts ?? [],
    keep: keep ?? [],
    ...(planText ? { protectedCount: planText.protectedCount } : {}),
  };
}

function readCaptions(reader: Reader): FootageMaterial["captions"] {
  const { goals, recut } = reader.state;
  if (!goals?.goals.includes("captions") && !recut?.captionStyle && !goals?.captionStyle) return undefined;
  return {
    ...(recut?.captionStyle ? { style: recut.captionStyle.slice(0, 64) } : {}),
    ...(goals?.captionStyle ? { wanted: goals.captionStyle.slice(0, 64) } : {}),
    placed: recut?.captionsPlaced ?? false,
    ...(recut?.captionUiZone ? { uiZone: recut.captionUiZone.slice(0, 64) } : {}),
    choices: CAPTION_CHOICES.slice(0, 24),
  };
}

type ShortItem = NonNullable<FootageMaterial["shorts"]>["items"][number];

function shortItem(value: any, proposed: boolean): ShortItem | undefined {
  const id = cut(value?.id, 64);
  const start = num(value?.startSec);
  const end = num(value?.endSec);
  const score = num(value?.score);
  if (!id || start === undefined || end === undefined || score === undefined) return undefined;
  const axes: Record<string, number> = {};
  for (const [axis, entry] of Object.entries((value.axes ?? {}) as Record<string, any>).slice(0, 12)) {
    const value = num(entry?.score);
    if (value !== undefined && value <= 10) axes[axis.slice(0, 32)] = value;
  }
  return {
    id,
    title: cut(value.title, 200) ?? id,
    score: Math.min(100, score),
    ...(Number.isInteger(value.rank) && value.rank > 0 ? { rank: value.rank } : {}),
    proposed,
    startSec: start,
    endSec: Math.max(start, end),
    text: (typeof value.text === "string" ? value.text : "").slice(0, 1000),
    axes,
    warnings: (Array.isArray(value.warnings) ? value.warnings : [])
      .flatMap((warning: unknown) => cut(warning, 500) ?? [])
      .slice(0, 8),
    ...(cut(value.reason, 64) ? { reason: cut(value.reason, 64) } : {}),
  };
}

function readShorts(reader: Reader): FootageMaterial["shorts"] {
  const { shorts, series } = reader.state;
  if (!shorts?.proposals && !series) return undefined;
  const ranked = shorts?.proposals
    ? settle(
        reader,
        json(absolute(reader, shorts.proposals.file), "shorts", (value) =>
          value && Array.isArray(value.proposals)
            ? {
                threshold: num(value.threshold),
                items: [
                  ...(value.proposals as unknown[]).map((item) => shortItem(item, true)),
                  ...(Array.isArray(value.others) ? (value.others as unknown[]) : []).map((item) =>
                    shortItem(item, false),
                  ),
                ]
                  .filter((item): item is ShortItem => !!item)
                  .slice(0, FILM_LIST_MAX),
              }
            : undefined,
        ),
        "shorts proposals.json",
      )
    : undefined;
  return {
    fresh: shorts?.proposals?.fresh ?? false,
    ...(ranked?.threshold !== undefined && ranked.threshold <= 100 ? { threshold: ranked.threshold } : {}),
    items: ranked?.items ?? [],
    ...(series
      ? {
          series: {
            episodes: series.episodes,
            created: series.created
              .filter((episode) => ProjectIdSchema.safeParse(episode.projectId).success)
              .slice(0, FILM_LIST_MAX)
              .map((episode) => ({
                project: episode.projectId,
                rendered: episode.rendered,
                ...(episode.rendered
                  ? { media: { root: "out" as const, path: "vertical.mp4", kind: "video" as const } }
                  : {}),
              })),
          },
        }
      : {}),
  };
}

function readCameras(reader: Reader): FootageMaterial["cameras"] {
  const { multicam, cameras } = reader.state;
  if (!multicam.sync && !multicam.angles && cameras.length < 2) return undefined;
  const plan = multicam.angles
    ? settle(
        reader,
        json(absolute(reader, multicam.angles), "angles", (value) => {
          const fps = fpsOf(value?.fps);
          if (!fps || !Array.isArray(value?.segments)) return undefined;
          return {
            method: cut(value.method, 32),
            segments: (value.segments as any[])
              .filter((s) => num(s?.startFrame) !== undefined && num(s?.endFrame) !== undefined && cut(s?.angle, 64))
              .slice(0, MAX_SEGMENTS)
              .map((s) => ({
                startSec: round(s.startFrame / fps),
                endSec: round(Math.max(s.startFrame, s.endFrame) / fps),
                angle: cut(s.angle, 64)!,
                ...(cut(s.speaker, 64) ? { speaker: cut(s.speaker, 64) } : {}),
                reason: cut(s.reason, 32) ?? "speaker",
              })),
          };
        }),
        "angles.json",
      )
    : undefined;
  const angles = [
    ...new Set([...cameras.map((camera) => path.parse(camera).name), ...(plan?.segments ?? []).map((s) => s.angle)]),
  ]
    .map((angle) => angle.slice(0, 64))
    .filter(Boolean)
    .slice(0, 16);
  return {
    synced: !!multicam.sync,
    ...(plan?.method ? { method: plan.method } : {}),
    angles,
    segments: plan?.segments ?? [],
  };
}

type ReframeRow = NonNullable<FootageMaterial["reframe"]>["formats"][number];

function readReframe(reader: Reader): FootageMaterial["reframe"] {
  const recut = reader.state.recut;
  if (!recut || !ProjectIdSchema.safeParse(recut.projectId).success) return undefined;
  const file = path.join(reader.paths.rootDir, "public/projects", recut.projectId, "pipeline/timeline-edit.json");
  const rows = settle(
    reader,
    json(file, `reframe:${recut.pictureTrackId}`, (value) => {
      const tracks: any[] = Array.isArray(value?.timeline?.tracks) ? value.timeline.tracks : [];
      const track = tracks.find((t) => t?.id === recut.pictureTrackId) ?? tracks.find((t) => t?.kind === "visual");
      const clips: any[] = Array.isArray(track?.clips) ? track.clips : [];
      return FORMATS.map((format): ReframeRow => {
        let fixed = 0;
        let tracked = 0;
        let points: ReframeRow["points"] = [];
        for (const clip of clips) {
          const setting = clip?.payload?.reframe?.[format];
          if (!setting) continue;
          if (Array.isArray(setting.keyframes)) {
            tracked++;
            if (!points.length) {
              const keys = (setting.keyframes as any[]).filter(
                (k) => num(k?.frame) !== undefined && num(k?.x) !== undefined && num(k?.y) !== undefined,
              );
              const step = Math.max(1, Math.ceil(keys.length / MAX_POINTS));
              points = keys
                .filter((_, index) => index % step === 0)
                .slice(0, MAX_POINTS)
                .map((k) => ({ frame: Math.floor(k.frame), x: Math.min(1, k.x), y: Math.min(1, k.y) }));
            }
          } else if (num(setting.x) !== undefined) fixed++;
        }
        return { format, reframed: recut.reframed.includes(format), fixed, tracked, points };
      }).filter((row) => row.reframed || row.fixed || row.tracked);
    }),
    "the recut's timeline-edit.json",
  );
  return rows?.length ? { formats: rows } : undefined;
}

function readRenders(reader: Reader): FootageMaterial["renders"] {
  const recut = reader.state.recut;
  if (!recut || !ProjectIdSchema.safeParse(recut.projectId).success) return undefined;
  const rows: NonNullable<FootageMaterial["renders"]> = [];
  for (const [name, render] of Object.entries(recut.renders)) {
    const format = FORMATS.find((f) => name === f || name === `${f}-clean`);
    if (!format || (render.state === "missing" && name.endsWith("-clean"))) continue;
    const media: MediaRef | undefined =
      render.state === "missing"
        ? undefined
        : {
            root: "out",
            path: `${name}.mp4`,
            kind: "video",
            label: name,
            ...(render.state === "stale" ? { stale: true } : {}),
          };
    rows.push({ name, format, state: render.state, project: recut.projectId, ...(media ? { media } : {}) });
  }
  const wanted = new Set<string>([...(reader.state.request?.formats ?? []), ...(reader.state.goals?.formats ?? [])]);
  return rows
    .filter((row) => row.state !== "missing" || wanted.size === 0 || wanted.has(row.format))
    .sort((a, b) => FORMATS.indexOf(a.format) - FORMATS.indexOf(b.format) || a.name.localeCompare(b.name))
    .slice(0, 6);
}

function guarded<T>(reader: Reader, name: string, work: () => T): T | undefined {
  try {
    return work();
  } catch (error) {
    reader.advisories.push(`footage material: ${name}: ${(error as Error)?.message ?? String(error)}`.slice(0, 2000));
    return undefined;
  }
}

/** The footage panels' material from footage:next's state; undefined when there is nothing to show yet. */
export function readFootageMaterial(
  paths: ProjectPaths,
  state: FootageState,
  advisories: string[],
): FootageMaterial | undefined {
  const reader: Reader = { paths, state, advisories };
  const recut = state.recut;
  const material: FootageMaterial = {
    source: guarded(reader, "source", () => readSource(reader)),
    transcript: guarded(reader, "transcript", () => readTranscript(reader)),
    plan: guarded(reader, "plan", () => readPlan(reader)),
    ...(recut && ProjectIdSchema.safeParse(recut.projectId).success
      ? {
          recut: {
            project: recut.projectId,
            revision: Math.max(0, Math.floor(recut.revision)),
            ...(Sha256Schema.safeParse(recut.editHash).success ? { editHash: recut.editHash } : {}),
            chapters: recut.chapters,
          },
        }
      : {}),
    captions: guarded(reader, "captions", () => readCaptions(reader)),
    shorts: guarded(reader, "shorts", () => readShorts(reader)),
    cameras: guarded(reader, "cameras", () => readCameras(reader)),
    reframe: guarded(reader, "reframe", () => readReframe(reader)),
    renders: guarded(reader, "renders", () => readRenders(reader)),
  };
  for (const key of Object.keys(material) as (keyof FootageMaterial)[])
    if (material[key] === undefined) delete material[key];
  if (!Object.keys(material).length) return undefined;
  // Each section on its own: one that does not validate is dropped with an advisory, the rest stay.
  const parsed = FootageMaterialSchema.safeParse(material);
  if (parsed.success) return parsed.data;
  const broken = new Set(parsed.error.issues.map((issue) => String(issue.path[0])));
  for (const key of broken) {
    delete material[key as keyof FootageMaterial];
    advisories.push(`footage material: the ${key} section did not validate and is not shown.`);
  }
  const second = FootageMaterialSchema.safeParse(material);
  return second.success && Object.keys(second.data).length ? second.data : undefined;
}
