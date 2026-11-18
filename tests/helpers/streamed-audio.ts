import { spawn } from "node:child_process";

/** Decode every sample while retaining only explicitly requested bounded windows. */
export async function decodeAudioWindows(file: string, ranges: Array<{ startSample: number; samples: number }>) {
  if (
    ranges.length > 128 ||
    ranges.some(
      (r) =>
        !Number.isSafeInteger(r.startSample) ||
        r.startSample < 0 ||
        !Number.isSafeInteger(r.samples) ||
        r.samples < 1 ||
        r.samples > 48000,
    )
  )
    throw new Error("Invalid bounded audio windows");
  const windows = ranges.map((r) => ({ ...r, data: Buffer.alloc(r.samples * 4), received: 0 }));
  const process = spawn(
    "ffmpeg",
    ["-v", "error", "-nostdin", "-i", file, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let bytes = 0,
    error = "";
  const timeout = setTimeout(() => process.kill("SIGKILL"), 600000);
  process.stderr.on("data", (chunk) => {
    error = (error + chunk.toString()).slice(-4096);
  });
  process.stdout.on("data", (chunk: Buffer) => {
    for (const window of windows) {
      const start = window.startSample * 4,
        end = start + window.data.length;
      const from = Math.max(bytes, start),
        to = Math.min(bytes + chunk.length, end);
      if (to > from) {
        chunk.copy(window.data, from - start, from - bytes, to - bytes);
        window.received += to - from;
      }
    }
    bytes += chunk.length;
  });
  try {
    await new Promise<void>((resolve, reject) => {
      process.on("error", reject);
      process.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`Full audio decode failed (${code}): ${error}`)),
      );
    });
    if (bytes % 4 || windows.some((w) => w.received !== w.data.length))
      throw new Error("Audio decode has incomplete samples/windows");
    return { totalSamples: bytes / 4, windows, retainedBytes: windows.reduce((n, w) => n + w.data.length, 0) };
  } finally {
    clearTimeout(timeout);
  }
}
