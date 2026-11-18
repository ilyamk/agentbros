import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CliErrorObject } from "../cli";
import { launchChrome } from "./cdp";
import { pageClockSource } from "./page-clock";
import { planFrames, type CaptureStep, type FrameAction } from "./steps";

export { captureScriptSchema, captureStepSchema, planFrames, type CaptureStep, type FrameAction } from "./steps";

export type CaptureAppOptions = {
  url: string;
  steps: CaptureStep[];
  fps: number;
  durationSec: number;
  output: string;
  width: number;
  height: number;
  scale: number;
  format: "png" | "mp4" | "both";
  chrome?: string;
  /** Virtual milliseconds the first page may load before frame 0 is taken. */
  settleMs: number;
  /** Seed for the page's Math.random. */
  seed: number;
  /** The text caret blinks on the wall clock, so it is hidden unless asked for; draw your own in the edit. */
  showCaret?: boolean;
};

export type CaptureEvent = { frame: number; action: FrameAction["kind"]; x?: number; y?: number; text?: string };

export type CaptureManifest = {
  url: string;
  fps: number;
  frames: number;
  width: number;
  height: number;
  scale: number;
  route: "injected-clock";
  chrome: string;
  events: CaptureEvent[];
  frameHashes: string[];
  outputs: string[];
  steps: CaptureStep[];
};

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Space: { code: "Space", keyCode: 32, text: " " },
};

export const defaultChromePath = async (): Promise<string> => {
  const { ensureBrowser } = await import("@remotion/renderer");
  const status = await ensureBrowser({
    logLevel: "error",
    onBrowserDownload: () => {
      throw new Error("Installed Chromium required; run `pnpm exec remotion browser ensure` first");
    },
  });
  if (!("path" in status) || typeof status.path !== "string")
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Remotion did not report a headless Chromium path; pass --chrome",
    });
  return status.path;
};

export const toUrl = (input: string) =>
  /^[a-z][a-z0-9+.-]*:/i.test(input) ? input : pathToFileURL(path.resolve(input)).href;

/** Captures a real page frame by frame on an injected page clock, with scripted input on exact frames. */
export const captureApp = async (
  options: CaptureAppOptions,
  progress: (line: string) => void = () => {},
): Promise<CaptureManifest> => {
  const wantsMp4 = options.format !== "png";
  if (wantsMp4 && spawnSync("ffmpeg", ["-version"]).status !== 0)
    throw new CliErrorObject({
      code: "FFMPEG_MISSING",
      message: "ffmpeg not found; install it with `brew install ffmpeg`",
    });
  const frames = Math.round(options.durationSec * options.fps);
  if (frames < 1) throw new CliErrorObject({ code: "INVALID_INPUT", message: "Duration gives no frames" });
  const chrome = options.chrome ?? (await defaultChromePath());
  if (!existsSync(chrome))
    throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `Chromium not found at ${chrome}` });

  mkdirSync(options.output, { recursive: true });
  if (readdirSync(options.output).some((name) => /^f\d{5}\.png$|^capture\.(mp4|json)$/.test(name)))
    throw new CliErrorObject({
      code: "FILE_EXISTS",
      message: `${options.output} already holds a capture; choose an empty directory`,
    });
  const framesDir = options.format === "mp4" ? mkdtempSync(path.join(tmpdir(), "capture-app-frames-")) : options.output;
  const profile = mkdtempSync(path.join(tmpdir(), "capture-app-profile-"));
  const plan = planFrames(options.steps, options.fps, frames);
  const events: CaptureEvent[] = [];
  const frameHashes: string[] = [];
  const cdp = await launchChrome(chrome, profile);

  try {
    const { targetId } = (await cdp.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
    const { sessionId } = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })) as {
      sessionId: string;
    };
    const page = (method: string, params: Record<string, unknown> = {}) => cdp.send(method, params, sessionId);
    const evaluate = async <T>(expression: string): Promise<T> => {
      const result = (await page("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })) as {
        result: { value: T };
        exceptionDetails?: { text: string };
      };
      if (result.exceptionDetails) throw new Error(`Page script failed: ${result.exceptionDetails.text}`);
      return result.result.value;
    };
    const open = async (url: string) => {
      const load = cdp.once("Page.loadEventFired", 60_000);
      const { errorText } = (await page("Page.navigate", { url: toUrl(url) })) as { errorText?: string };
      if (errorText) throw new CliErrorObject({ code: "NETWORK", message: `Cannot open ${url}: ${errorText}` });
      await load;
      await evaluate("document.fonts.ready.then(() => true)");
    };
    const advance = (ms: number) => evaluate<number>(`window.__captureAdvance(${ms})`);
    const centre = async (selector: string, frame: number) => {
      const box = await evaluate<{ x: number; y: number } | null>(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      );
      if (!box)
        throw new CliErrorObject({ code: "VALIDATION", message: `Frame ${frame}: no element matches ${selector}` });
      return box;
    };
    const key = async (name: string, text?: string) => {
      const known = KEYS[name];
      const typed = text ?? known?.text;
      await page("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: name,
        code: known?.code,
        windowsVirtualKeyCode: known?.keyCode,
        ...(typed ? { text: typed, unmodifiedText: typed } : {}),
      });
      await page("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: name,
        code: known?.code,
        windowsVirtualKeyCode: known?.keyCode,
      });
    };
    const run = async (frame: number, action: FrameAction) => {
      switch (action.kind) {
        case "navigate":
          await open(action.url);
          events.push({ frame, action: "navigate", text: action.url });
          return;
        case "click":
        case "hover": {
          const { x, y } = await centre(action.selector, frame);
          await page("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
          if (action.kind === "click") {
            await page("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
            await page("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
          }
          events.push({ frame, action: action.kind, x, y });
          return;
        }
        case "focus":
          await centre(action.selector, frame);
          await evaluate(`document.querySelector(${JSON.stringify(action.selector)}).focus()`);
          return;
        case "char":
          await key(action.text, action.text);
          events.push({ frame, action: "char", text: action.text });
          return;
        case "key":
          await key(action.key);
          events.push({ frame, action: "key", text: action.key });
          return;
        case "scroll":
          await evaluate(
            `(${action.selector ? `document.querySelector(${JSON.stringify(action.selector)})` : "window"}).scrollBy({ top: ${action.dy}, behavior: "instant" })`,
          );
          events.push({ frame, action: "scroll", text: String(action.dy) });
          return;
      }
    };

    await page("Page.enable");
    await page("Emulation.setDeviceMetricsOverride", {
      width: options.width,
      height: options.height,
      deviceScaleFactor: options.scale,
      mobile: false,
    });
    await page("Page.addScriptToEvaluateOnNewDocument", {
      source: pageClockSource(options.seed, 1_767_225_600_000, !options.showCaret),
    });
    await open(options.url);
    await advance(options.settleMs);
    progress(`Loaded ${options.url}; capturing ${frames} frames at ${options.fps} fps`);

    const step = 1000 / options.fps;
    for (let frame = 0; frame < frames; frame++) {
      for (const action of plan.get(frame) ?? []) await run(frame, action);
      await evaluate("window.__captureSeek && window.__captureSeek()");
      // Frame n shows the page at settle + (n + 1) frame steps; rounding keeps the clock on whole milliseconds.
      await advance(Math.round(step * (frame + 1)) - Math.round(step * frame));
      const { data } = (await page("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })) as {
        data: string;
      };
      const png = Buffer.from(data, "base64");
      writeFileSync(path.join(framesDir, `f${String(frame).padStart(5, "0")}.png`), png);
      frameHashes.push(createHash("sha256").update(png).digest("hex"));
      if (process.env.CAPTURE_DEBUG || frame % 30 === 29) progress(`frame ${frame + 1}/${frames}`);
    }

    const outputs: string[] = [];
    if (options.format !== "mp4") outputs.push(path.join(options.output, "f%05d.png"));
    if (wantsMp4) {
      const mp4 = path.join(options.output, "capture.mp4");
      const encode = spawnSync(
        "ffmpeg",
        [
          "-y",
          "-loglevel",
          "error",
          "-framerate",
          String(options.fps),
          "-i",
          path.join(framesDir, "f%05d.png"),
          "-vf",
          "pad=ceil(iw/2)*2:ceil(ih/2)*2",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-crf",
          "16",
          "-preset",
          "slow",
          "-movflags",
          "+faststart",
          mp4,
        ],
        { encoding: "utf8" },
      );
      if (encode.status !== 0)
        throw new CliErrorObject({ code: "FFMPEG_FAILED", message: encode.stderr.trim() || "ffmpeg failed" });
      outputs.push(mp4);
    }
    const manifestPath = path.join(options.output, "capture.json");
    outputs.push(manifestPath);
    const manifest: CaptureManifest = {
      url: options.url,
      fps: options.fps,
      frames,
      width: options.width,
      height: options.height,
      scale: options.scale,
      route: "injected-clock",
      chrome: cdp.version,
      events,
      frameHashes,
      outputs,
      steps: options.steps,
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } finally {
    cdp.close();
    rmSync(profile, { recursive: true, force: true });
    if (framesDir !== options.output) rmSync(framesDir, { recursive: true, force: true });
  }
};
