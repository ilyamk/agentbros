/**
 * Derivation steps (RFC 0003 §6.4): the media-kind state machine shared by `plan` and `run`, and the ffmpeg
 * argument compiler for the local deterministic ops. Pure: no process is spawned here.
 */
import { CliErrorObject } from "../../cli";
import type { DerivationStep } from "../../../types/references";

/** json: a data output (a Blender camera path); no further step takes it. */
export type MediaKind = "image" | "video" | "audio" | "json";
/** What a step's input or output is, as measured (run) or predicted (plan). */
export type MediaState = {
  kind: MediaKind;
  width?: number;
  height?: number;
  fps?: number;
  frameCount?: number;
  durationSec?: number;
  hasAudio: boolean;
  hasAlpha: boolean;
};
/** ready: runs locally. paid: a fal step, run only through the durable paid path (RFC 0003 D7). not-implemented: no engine yet. */
export type StepStatus = "ready" | "paid" | "not-implemented";
export type StepEngine = "ffmpeg" | "matte-onnx" | "fal" | "blender" | "local-model";
export type PlannedStep = {
  index: number;
  op: DerivationStep["op"];
  engine: StepEngine;
  status: StepStatus;
  inputKind: MediaKind;
  outputKind: MediaKind;
  reason?: string;
};

/** Fixed loudnorm parameters (single pass, dynamic mode); the target integrated loudness comes from the step. */
export const LOUDNORM = { truePeakDb: -1.5, lra: 11, sampleRate: 48000 } as const;
/** libx264 parameters every video step encodes with; `-threads 1` keeps the bitstream reproducible. */
export const X264 = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-threads", "1"];
const AAC = ["-c:a", "aac", "-b:a", "192k"];
const WAV = ["-c:a", "pcm_s16le"];
/** Output options that strip encoder and creation metadata, so equal inputs give equal bytes. */
export const BITEXACT = [
  "-map_metadata",
  "-1",
  "-map_chapters",
  "-1",
  "-fflags",
  "+bitexact",
  "-flags:v",
  "+bitexact",
  "-flags:a",
  "+bitexact",
];
/** Contact sheets sample at most columns × columns frames, evenly spaced, each tile at most this wide. */
export const CONTACT_TILE_WIDTH = 320;

const refuse = (index: number, op: string, message: string): never => {
  throw new CliErrorObject({ code: "INVALID_INPUT", message: `Step ${index + 1} (${op}): ${message}` });
};
const extensionFor = (kind: MediaKind) =>
  kind === "image" ? "png" : kind === "video" ? "mp4" : kind === "json" ? "json" : "wav";
export const outputExtension = extensionFor;

/** Engine and readiness of a step, independent of the media it receives. */
export function stepEngine(step: DerivationStep): { engine: StepEngine; status: StepStatus; reason?: string } {
  const paid = {
    engine: "fal" as const,
    status: "paid" as const,
    reason: "paid: runs through the durable fal job path",
  };
  switch (step.op) {
    case "cutout":
      return { engine: "matte-onnx", status: "ready" };
    case "depth-video":
    case "pose-video":
      return step.engine === "fal"
        ? paid
        : {
            engine: "local-model",
            status: "not-implemented",
            reason: `no pinned local ${step.op === "depth-video" ? "depth" : "pose"} model yet; use engine fal`,
          };
    case "mask-video":
      return step.engine === "fal"
        ? paid
        : {
            engine: "matte-onnx",
            status: "not-implemented",
            reason: "video masks are not built yet; cut out an extracted frame or use engine fal",
          };
    case "audio-clean":
      return step.engine === "fal"
        ? paid
        : {
            engine: "ffmpeg",
            status: "not-implemented",
            reason: "local audio cleaning is not built yet; use engine fal",
          };
    case "blender-pass":
      return { engine: "blender", status: "ready" };
    case "edge-video":
      return step.kind === "canny"
        ? { engine: "ffmpeg", status: "ready" }
        : { engine: "local-model", status: "not-implemented", reason: "lineart needs a local model" };
    default:
      return { engine: "ffmpeg", status: "ready" };
  }
}

/** A step that replaces the media with a paid or rendered result: it must come first, so its input is a registered asset. */
export const leadingOnly = (step: DerivationStep): boolean =>
  step.op === "blender-pass" || ("engine" in step && step.engine === "fal");

const EPS = 0.001;
const needs = (index: number, step: DerivationStep, state: MediaState, kinds: MediaKind[]) => {
  if (!kinds.includes(state.kind)) refuse(index, step.op, `takes ${kinds.join(" or ")}, not ${state.kind}`);
};
const evenVideo = (index: number, op: string, state: MediaState) => {
  if (state.kind === "video" && ((state.width ?? 0) % 2 || (state.height ?? 0) % 2))
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Step ${index + 1} (${op}) gives ${state.width}x${state.height}; H.264 needs even dimensions. Add a snap step (multipleOf 2 or more) or choose even sizes.`,
    });
};

/**
 * The state after a step, or a refusal naming the step. Plan and run share it, so a chain that plans also
 * runs. Durations and frame counts are predictions; run replaces them with measurements after each step.
 */
export function nextState(index: number, step: DerivationStep, state: MediaState): MediaState {
  const visual = ["image", "video"] as MediaKind[];
  if (index > 0 && leadingOnly(step))
    refuse(
      index,
      step.op,
      "a fal or Blender step must be the first step, so its input is a registered asset; put the steps before it in an upstream derivative and chain it with input.derivativeId",
    );
  if (state.kind === "json") refuse(index, step.op, "takes media; a camera path is data and ends the chain");
  let next: MediaState;
  switch (step.op) {
    case "trim":
    case "audio-trim": {
      needs(index, step, state, ["video", "audio"]);
      if (step.op === "audio-trim" && !state.hasAudio && state.kind === "video")
        refuse(index, step.op, "the video has no audio stream");
      if (state.durationSec !== undefined && step.startSec + step.durationSec > state.durationSec + EPS)
        refuse(
          index,
          step.op,
          `${step.startSec}+${step.durationSec} s runs past the ${state.durationSec.toFixed(3)} s input`,
        );
      next =
        step.op === "audio-trim"
          ? { kind: "audio", durationSec: step.durationSec, hasAudio: true, hasAlpha: false }
          : {
              ...state,
              durationSec: step.durationSec,
              ...(state.fps ? { frameCount: Math.max(1, Math.round(step.durationSec * state.fps)) } : {}),
            };
      break;
    }
    case "crop":
      needs(index, step, state, visual);
      if (step.x + step.width > state.width! || step.y + step.height > state.height!)
        refuse(
          index,
          step.op,
          `${step.width}x${step.height}+${step.x}+${step.y} leaves the ${state.width}x${state.height} frame`,
        );
      next = { ...state, width: step.width, height: step.height };
      break;
    case "scale":
      needs(index, step, state, visual);
      next = { ...state, width: step.width, height: step.height };
      break;
    case "fps":
      needs(index, step, state, ["video"]);
      next = {
        ...state,
        fps: step.fps,
        ...(state.durationSec ? { frameCount: Math.max(1, Math.round(state.durationSec * step.fps)) } : {}),
      };
      break;
    case "snap": {
      needs(index, step, state, visual);
      const width = Math.floor(state.width! / step.multipleOf) * step.multipleOf,
        height = Math.floor(state.height! / step.multipleOf) * step.multipleOf;
      if (!width || !height)
        refuse(index, step.op, `${state.width}x${state.height} is smaller than ${step.multipleOf}`);
      next = { ...state, width, height };
      break;
    }
    case "extract-frame":
      needs(index, step, state, ["video"]);
      if (typeof step.at === "number" && state.durationSec !== undefined && step.at > state.durationSec + EPS)
        refuse(index, step.op, `${step.at} s is past the ${state.durationSec.toFixed(3)} s input`);
      next = { kind: "image", width: state.width, height: state.height, hasAudio: false, hasAlpha: false };
      break;
    case "flatten":
      needs(index, step, state, visual);
      next = { ...state, hasAlpha: false };
      break;
    case "cutout":
      needs(index, step, state, ["image"]);
      next = { ...state, hasAlpha: true };
      break;
    case "strip-audio":
      needs(index, step, state, ["video"]);
      if (!state.hasAudio) refuse(index, step.op, "the video has no audio stream to strip");
      next = { ...state, hasAudio: false };
      break;
    case "loudness":
      needs(index, step, state, ["video", "audio"]);
      if (!state.hasAudio) refuse(index, step.op, "the input has no audio stream");
      if (step.lufs < -70 || step.lufs > -5) refuse(index, step.op, "loudnorm takes a target between -70 and -5 LUFS");
      next = { ...state };
      break;
    case "contact-sheet": {
      needs(index, step, state, ["video"]);
      const tileWidth = Math.min(CONTACT_TILE_WIDTH, state.width!);
      const tileHeight = 2 * Math.round((tileWidth * state.height!) / state.width! / 2);
      const rows = Math.ceil(contactSheetCount(state, step.columns) / step.columns);
      next = {
        kind: "image",
        width: step.columns * tileWidth + (step.columns + 1) * 4,
        height: rows * tileHeight + (rows + 1) * 4,
        hasAudio: false,
        hasAlpha: false,
      };
      break;
    }
    case "edge-video":
      needs(index, step, state, visual);
      next = { ...state, hasAlpha: false };
      break;
    case "depth-video":
    case "pose-video":
      if (step.engine === "fal") needs(index, step, state, ["video"]);
      next = { ...state, hasAudio: false, hasAlpha: false };
      break;
    case "mask-video":
      if (step.engine === "fal") {
        needs(index, step, state, visual);
        if (!step.prompt) refuse(index, step.op, "a fal mask needs a prompt naming the subject to segment");
      }
      next = { ...state, hasAudio: false, hasAlpha: false };
      break;
    case "audio-clean":
      if (step.engine === "fal") needs(index, step, state, ["audio"]);
      next = { ...state };
      break;
    case "blender-pass":
      // The input is the target the pass matches: its size and frame count; a still renders the scene's first frame.
      needs(index, step, state, visual);
      next =
        step.pass === "camera-path"
          ? { kind: "json", hasAudio: false, hasAlpha: false }
          : { ...state, hasAudio: false, hasAlpha: false };
      break;
    default: {
      // Unbuilt ops: plan reports them; their output is the same kind of media.
      next = { ...state };
    }
  }
  evenVideo(index, step.op, next);
  return next;
}

/** The ffmpeg arguments (after the global flags) that turn `input` into `output` for one ready ffmpeg step. */
export function compileStep(
  index: number,
  step: DerivationStep,
  state: MediaState,
  input: string,
  output: string,
): string[] {
  const src = ["-protocol_whitelist", "file", "-i", input];
  const keepAudio = state.kind === "video" && state.hasAudio ? ["-map", "0:a:0", "-c:a", "copy"] : [];
  const video = (filter: string) => [...src, "-map", "0:v:0", ...keepAudio, "-vf", filter, ...X264];
  const image = (filter: string, alpha: boolean) => [
    ...src,
    "-map",
    "0:v:0",
    "-vf",
    `${filter},format=${alpha ? "rgba" : "rgb24"}`,
    "-frames:v",
    "1",
    "-c:v",
    "png",
  ];
  const visual = (filter: string) => (state.kind === "image" ? image(filter, state.hasAlpha) : video(filter));
  const pad = state.kind === "image" && state.hasAlpha ? "0x000000@0" : "0x000000";
  let args: string[];
  switch (step.op) {
    case "trim":
      args =
        state.kind === "video"
          ? [
              ...src,
              "-ss",
              String(step.startSec),
              "-t",
              String(step.durationSec),
              "-map",
              "0:v:0",
              ...(state.hasAudio ? ["-map", "0:a:0", ...AAC] : []),
              ...X264,
            ]
          : [...src, "-ss", String(step.startSec), "-t", String(step.durationSec), "-map", "0:a:0", ...WAV];
      break;
    case "audio-trim":
      args = [...src, "-ss", String(step.startSec), "-t", String(step.durationSec), "-vn", "-map", "0:a:0", ...WAV];
      break;
    case "crop":
      args = visual(`crop=${step.width}:${step.height}:${step.x}:${step.y},setsar=1`);
      break;
    case "scale": {
      const { width: w, height: h } = step;
      const filter =
        step.fit === "exact"
          ? `scale=${w}:${h}:flags=bicubic`
          : step.fit === "pad"
            ? `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=bicubic,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${pad}`
            : `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=bicubic,crop=${w}:${h}`;
      args = visual(`${filter},setsar=1`);
      break;
    }
    case "snap": {
      const next = nextState(index, step, state);
      args = visual(`scale=${next.width}:${next.height}:flags=bicubic,setsar=1`);
      break;
    }
    case "fps":
      args = video(`fps=fps=${step.fps}`);
      break;
    case "extract-frame": {
      const frames = state.frameCount ?? 1;
      const frame =
        step.at === "first"
          ? 0
          : step.at === "last"
            ? frames - 1
            : Math.min(frames - 1, Math.floor(step.at * (state.fps ?? 1) + 1e-6));
      args = [...src, "-map", "0:v:0", "-vf", `select=eq(n\\,${frame}),format=rgb24`, "-fps_mode", "passthrough"];
      args.push("-frames:v", "1", "-c:v", "png");
      break;
    }
    case "flatten": {
      const colour = `0x${step.background.slice(1).toLowerCase()}`;
      const size = `${state.width}x${state.height}`;
      const background =
        state.kind === "image" ? `color=c=${colour}:s=${size}` : `color=c=${colour}:s=${size}:r=${state.fps}`;
      const graph = `[1:v][0:v]overlay=shortest=1:format=auto,format=${state.kind === "image" ? "rgb24" : "yuv420p"}[v]`;
      args = [...src, "-f", "lavfi", "-i", background, "-filter_complex", graph, "-map", "[v]"];
      args.push(...(state.kind === "image" ? ["-frames:v", "1", "-c:v", "png"] : [...keepAudio, ...X264]));
      break;
    }
    case "strip-audio":
      args = [...src, "-map", "0:v:0", "-c:v", "copy", "-an"];
      break;
    case "loudness": {
      const filter = `loudnorm=I=${step.lufs}:TP=${LOUDNORM.truePeakDb}:LRA=${LOUDNORM.lra}`;
      args =
        state.kind === "audio"
          ? [...src, "-map", "0:a:0", "-af", filter, "-ar", String(LOUDNORM.sampleRate), ...WAV]
          : [...src, "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy", "-af", filter];
      if (state.kind === "video") args.push("-ar", String(LOUDNORM.sampleRate), ...AAC);
      break;
    }
    case "contact-sheet": {
      const frames = state.frameCount ?? 1;
      const count = Math.min(frames, step.columns * step.columns);
      const picks = [
        ...new Set(
          Array.from({ length: count }, (_, i) => (count > 1 ? Math.floor((i * (frames - 1)) / (count - 1)) : 0)),
        ),
      ];
      const rows = Math.ceil(picks.length / step.columns);
      const tileWidth = Math.min(CONTACT_TILE_WIDTH, state.width!);
      const tileHeight = 2 * Math.round((tileWidth * state.height!) / state.width! / 2);
      const select = picks.map((n) => `eq(n\\,${n})`).join("+");
      args = [
        ...src,
        "-map",
        "0:v:0",
        "-vf",
        `select=${select},scale=${tileWidth}:${tileHeight}:flags=bicubic,setsar=1,tile=${step.columns}x${rows}:padding=4:margin=4:color=0x000000,format=rgb24`,
        "-fps_mode",
        "passthrough",
        "-frames:v",
        "1",
        "-c:v",
        "png",
      ];
      break;
    }
    case "edge-video": {
      const edges = "format=gray,edgedetect=low=0.1:high=0.4:mode=wires";
      args = state.kind === "image" ? image(edges, false) : video(edges);
      break;
    }
    default:
      return refuse(index, step.op, "has no ffmpeg form");
  }
  return [...args, ...BITEXACT, output];
}

/** Sampled frame indices for a contact sheet, exposed for the receipt's measurements. */
export function contactSheetCount(state: MediaState, columns: number): number {
  const frames = state.frameCount ?? 1;
  const count = Math.min(frames, columns * columns);
  return new Set(
    Array.from({ length: count }, (_, i) => (count > 1 ? Math.floor((i * (frames - 1)) / (count - 1)) : 0)),
  ).size;
}
