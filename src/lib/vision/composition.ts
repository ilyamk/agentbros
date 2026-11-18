import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import {
  ensureBrowser,
  openBrowser,
  makeCancelSignal,
  renderMedia,
  renderStill,
  selectComposition,
  type ChromiumOptions,
  type Codec,
  type HeadlessBrowser,
} from "@remotion/renderer";
import type { VideoConfig } from "remotion";
import { enableTailwind } from "@remotion/tailwind-v4";
import { CliErrorObject, emitProgress } from "../cli";

export const DEFAULT_ENTRY = "src/index.ts";
export const GL_CHOICES = ["angle", "swangle", "swiftshader", "egl", "vulkan", "angle-egl"] as const;
export const CODEC_CHOICES = ["h264", "h265", "vp8", "vp9", "prores"] as const;
const invalid = (message: string) => new CliErrorObject({ code: "INVALID_INPUT", message });

export type CompositionSource = {
  entry: string;
  composition: string;
  publicDir: string;
  gl: string;
  propsFile?: string;
};
type Session = {
  serveUrl: string;
  browser: HeadlessBrowser;
  composition: VideoConfig;
  inputProps: Record<string, unknown>;
  chromiumOptions: ChromiumOptions;
};

function readProps(file?: string): Record<string, unknown> {
  if (!file) return {};
  if (!existsSync(file)) throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `Props file not found: ${file}` });
  const props: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!props || typeof props !== "object" || Array.isArray(props))
    throw new CliErrorObject({ code: "VALIDATION", message: "--props must contain a JSON object." });
  return props as Record<string, unknown>;
}

/** Bundles once and keeps one browser open for everything `work` renders. */
export async function withComposition<T>(
  source: CompositionSource,
  work: (session: Session) => Promise<T>,
): Promise<T> {
  const entryPoint = path.resolve(source.entry);
  if (!existsSync(entryPoint))
    throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `Remotion entry not found: ${entryPoint}` });
  const publicDir = path.resolve(source.publicDir);
  if (!existsSync(publicDir))
    throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `Public directory not found: ${publicDir}` });
  const inputProps = readProps(source.propsFile);
  const chromiumOptions: ChromiumOptions = { gl: source.gl as ChromiumOptions["gl"] };
  const outDir = mkdtempSync(path.join(tmpdir(), "motion-bundle-"));
  try {
    emitProgress(`Bundling ${source.entry}`);
    const serveUrl = await bundle({
      entryPoint,
      publicDir,
      outDir,
      symlinkPublicDir: true,
      webpackOverride: enableTailwind,
    });
    const installed =
      process.env.AGENTBROS_NO_SPEND === "1"
        ? await ensureBrowser({
            browserExecutable: process.env.AGENTBROS_WORKFLOW_BROWSER,
            logLevel: "error",
            onBrowserDownload: () => {
              throw new Error("Installed Chromium required; downloads are forbidden");
            },
          })
        : undefined;
    if (installed && !("path" in installed)) throw new Error("Installed Chromium required; downloads are forbidden");
    const browser = await openBrowser("chrome", {
      logLevel: "error",
      chromiumOptions,
      ...(installed ? { browserExecutable: installed.path } : {}),
    });
    try {
      const composition = await selectComposition({
        serveUrl,
        id: source.composition,
        inputProps,
        puppeteerInstance: browser,
        chromiumOptions,
        logLevel: "error",
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (/could not find composition/i.test(message)) throw invalid(message);
        throw error;
      });
      return await work({ serveUrl, browser, composition, inputProps, chromiumOptions });
    } finally {
      await browser.close({ silent: true });
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

export function parseFrameList(value: string): number[] {
  const frames = value.split(",").map((part) => Number(part.trim()));
  if (!value.trim() || frames.some((frame) => !Number.isSafeInteger(frame) || frame < 0))
    throw invalid(`--frames must list non-negative whole frames, such as "0,30,90"; got "${value}".`);
  return [...new Set(frames)];
}

export function parseFrameRange(value: string): [number, number] {
  const match = /^(\d+)-(\d+)$/.exec(value.trim());
  if (!match || Number(match[1]) > Number(match[2]))
    throw invalid(`--frames must be an inclusive range "a-b" with a <= b; got "${value}".`);
  return [Number(match[1]), Number(match[2])];
}

function assertInComposition(frames: number[], composition: VideoConfig): void {
  const outside = frames.filter((frame) => frame >= composition.durationInFrames);
  if (outside.length)
    throw invalid(
      `Frame(s) ${outside.join(", ")} are outside "${composition.id}", which has ${composition.durationInFrames} frames (0-${composition.durationInFrames - 1}).`,
    );
}

export async function renderStills(source: CompositionSource, frames: number[], outputDir: string) {
  mkdirSync(outputDir, { recursive: true });
  return withComposition(source, async ({ serveUrl, browser, composition, inputProps, chromiumOptions }) => {
    assertInComposition(frames, composition);
    const stills: Array<{ frame: number; timeSec: number; path: string }> = [];
    for (const frame of frames) {
      const output = path.resolve(outputDir, `frame-${String(frame).padStart(6, "0")}.png`);
      emitProgress(`Rendering frame ${frame}`);
      await renderStill({
        serveUrl,
        composition,
        inputProps,
        frame,
        output,
        imageFormat: "png",
        overwrite: true,
        puppeteerInstance: browser,
        chromiumOptions,
        logLevel: "error",
      });
      stills.push({ frame, timeSec: Number((frame / composition.fps).toFixed(3)), path: output });
    }
    return {
      stills,
      composition: {
        id: composition.id,
        width: composition.width,
        height: composition.height,
        fps: composition.fps,
        durationInFrames: composition.durationInFrames,
      },
    };
  });
}

export async function renderClip(
  source: CompositionSource,
  options: {
    output: string;
    range?: [number, number];
    codec: string;
    crf?: number;
    scale?: number;
    muted?: boolean;
    signal?: AbortSignal;
  },
) {
  const { output, range, codec, crf, scale, muted, signal } = options;
  signal?.throwIfAborted();
  if (codec === "prores" && crf !== undefined) throw invalid("--crf cannot be used with the prores codec.");
  mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  return withComposition(source, async ({ serveUrl, browser, composition, inputProps, chromiumOptions }) => {
    if (range) assertInComposition(range, composition);
    let lastPercent = -1;
    signal?.throwIfAborted();
    const cancellation = makeCancelSignal();
    const abort = () => cancellation.cancel();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await renderMedia({
        cancelSignal: cancellation.cancelSignal,
        serveUrl,
        composition,
        inputProps,
        codec: codec as Codec,
        crf,
        ...(scale === undefined ? {} : { scale }),
        ...(muted === undefined ? {} : { muted }),
        frameRange: range ?? null,
        outputLocation: path.resolve(output),
        overwrite: true,
        puppeteerInstance: browser,
        chromiumOptions,
        logLevel: "error",
        onProgress: ({ progress }) => {
          const percent = Math.floor(progress * 10) * 10;
          if (percent !== lastPercent) emitProgress(`Render ${percent}%`);
          lastPercent = percent;
        },
      });
    } finally {
      signal?.removeEventListener("abort", abort);
    }
    const [first, last] = range ?? [0, composition.durationInFrames - 1];
    return {
      id: composition.id,
      width: composition.width,
      height: composition.height,
      fps: composition.fps,
      durationInFrames: composition.durationInFrames,
      firstFrame: first,
      lastFrame: last,
      frameCount: last - first + 1,
    };
  });
}
