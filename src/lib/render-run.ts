import { spawn } from "node:child_process";
import { CliErrorObject } from "./cli";

/** Remotion CLI progress: "Rendered 7091/18230", "Encoded 120/300", "Stitched …". */
const PROGRESS = /\b(Rendered|Encoded|Stitched|Encoding|Bundling)\b\s*(\d+)(?:\s*\/\s*(\d+)|%)/;

/** The progress a line reports, or null when it reports none. Repeating the same line is not progress. */
export const parseProgress = (line: string): { phase: string; done: number; total: number | null } | null => {
  const match = PROGRESS.exec(line);
  return match ? { phase: match[1]!, done: Number(match[2]), total: match[3] ? Number(match[3]) : null } : null;
};

export type WatchedRun =
  | { status: "ok" }
  | { status: "failed"; code: number | null; signal: string | null }
  | { status: "stalled"; rendered: number | null; total: number | null; stalledMs: number };

export type WatchOptions = {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  /** Kill the run when no progress counter advances for this long. */
  stallMs: number;
  /** How often to look at the clock. */
  pollMs?: number;
  /** Every output line, for the caller's log (stderr by default). */
  onLine?: (line: string) => void;
};

/**
 * Runs one render child in its own process group and kills the whole group when its progress counters stop
 * advancing for `stallMs`: Remotion can print the same "Rendered N/M" forever after Chromium dies.
 */
export const runWatched = (options: WatchOptions): Promise<WatchedRun> =>
  new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env: options.env,
      detached: true,
    });
    const seen = new Map<string, number>();
    let rendered: number | null = null;
    let total: number | null = null;
    let lastAdvance = Date.now();
    let stalled = false;
    const onLine = options.onLine ?? ((line: string) => process.stderr.write(line + "\n"));
    const feed = (stream: NodeJS.ReadableStream) => {
      let buffer = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        buffer += chunk;
        const parts = buffer.split(/\r\n|\r|\n/);
        buffer = parts.pop() ?? "";
        for (const line of parts) {
          onLine(line);
          const progress = parseProgress(line);
          if (!progress) continue;
          if (progress.phase === "Rendered") [rendered, total] = [progress.done, progress.total ?? total];
          if ((seen.get(progress.phase) ?? -1) < progress.done) {
            seen.set(progress.phase, progress.done);
            lastAdvance = Date.now();
          }
        }
      });
    };
    feed(child.stdout);
    feed(child.stderr);
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    // The group is detached, so it would outlive this process; take it down if we exit first.
    process.once("exit", killGroup);
    const timer = setInterval(() => {
      if (stalled || Date.now() - lastAdvance < options.stallMs) return;
      stalled = true;
      killGroup();
    }, options.pollMs ?? 5000);
    child.once("error", (error) => {
      clearInterval(timer);
      process.removeListener("exit", killGroup);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearInterval(timer);
      process.removeListener("exit", killGroup);
      if (stalled) resolve({ status: "stalled", rendered, total, stalledMs: Date.now() - lastAdvance });
      else if (code === 0) resolve({ status: "ok" });
      else resolve({ status: "failed", code, signal });
    });
  });

export type FrameRange = { start: number; end: number };

/** `--frames 300-449`: inclusive output frames, as Remotion's `--frames`. */
export const parseFrameRange = (value: string, durationInFrames: number): FrameRange => {
  const match = /^(\d+)-(\d+)$/.exec(value.trim());
  if (!match) throw new Error(`--frames takes start-end output frames, e.g. 300-449; got "${value}"`);
  const [start, end] = [Number(match[1]), Number(match[2])];
  if (start > end || end >= durationInFrames)
    throw new Error(`--frames ${value} must satisfy start <= end < ${durationInFrames} (the render's frame count)`);
  return { start, end };
};

/** An excerpt never takes the full render's name, so delivery cannot mistake it for the film. */
export const rangeOutputFile = (outputFile: string, range: FrameRange) =>
  outputFile.replace(/\.mp4$/, `-frames-${range.start}-${range.end}.mp4`);

/**
 * One render with the watchdog: a stall kills the process tree and retries once from scratch; a second stall fails
 * with `RENDER_STALLED` naming the frame it stopped at. A plain renderer failure is not retried.
 */
export const renderWithWatchdog = async (
  options: WatchOptions & { label: string; notify?: (message: string) => void },
): Promise<{ attempts: number }> => {
  for (let attempt = 1; ; attempt++) {
    let run: WatchedRun;
    try {
      run = await runWatched(options);
    } catch (error) {
      throw new CliErrorObject({
        code: "INTERNAL",
        message: `Cannot launch renderer: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    if (run.status === "ok") return { attempts: attempt };
    if (run.status === "failed")
      throw new CliErrorObject({
        code: "INTERNAL",
        message: `Renderer failed for ${options.label} (exit ${run.code}, signal ${run.signal ?? "none"}).`,
      });
    const where =
      run.rendered === null
        ? "before the first frame"
        : `at frame ${run.rendered}${run.total ? ` of ${run.total}` : ""}`;
    const minutes = (options.stallMs / 60000).toFixed(1);
    if (attempt === 1) {
      options.notify?.(
        `Render of ${options.label} stalled ${where} for ${minutes} min; killed its process tree, retrying once from scratch`,
      );
      continue;
    }
    throw new CliErrorObject({
      code: "RENDER_STALLED",
      message: `Render of ${options.label} stalled ${where} for ${minutes} min twice; the process tree was killed. Retry later, or render around the frame with --frames`,
      details: { stuckFrame: run.rendered, totalFrames: run.total, stallMinutes: Number(minutes), attempts: attempt },
    });
  }
};
