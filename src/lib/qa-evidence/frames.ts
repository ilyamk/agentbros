import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { EvidenceEvent } from "./events";
export const artifactHash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
function command(binary: string, args: string[]) {
  const r = spawnSync(binary, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) throw new Error(`${binary} failed: ${r.error?.message || r.stderr}`);
  return r.stdout;
}
export function extractEvidenceFrames(
  input: string,
  directory: string,
  events: EvidenceEvent[],
  expectedFrames: number,
  fps: number,
  intentionalDarkFrames: number[] = [],
) {
  const probe = JSON.parse(
    command("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-count_frames",
      "-show_entries",
      "stream=nb_read_frames,avg_frame_rate,width,height",
      "-of",
      "json",
      input,
    ]),
  ).streams[0];
  if (!probe) throw new Error("No video stream");
  const [rateNum, rateDen] = String(probe.avg_frame_rate).split("/").map(Number);
  const actualFps = rateNum / rateDen;
  if (!Number.isFinite(actualFps) || Math.abs(actualFps - fps) > 0.001)
    throw new Error("QA extraction requires the planned output frame rate");
  const actualFrames = Number(probe.nb_read_frames);
  if (!Number.isSafeInteger(actualFrames) || actualFrames < 1) throw new Error("Cannot count decoded frames");
  const selected = [...events];
  if (actualFrames !== expectedFrames && !selected.some((e) => e.frame === actualFrames - 1))
    selected.push({ frame: actualFrames - 1, reasons: ["actual-file-last"] });
  mkdirSync(directory, { recursive: true });
  const extracted = selected
    .filter((e) => e.frame < actualFrames)
    .map((e) => {
      const file = path.join(directory, `frame-${String(e.frame).padStart(6, "0")}.png`);
      command("ffmpeg", [
        "-v",
        "error",
        "-i",
        input,
        "-vf",
        `select=eq(n\\,${e.frame})`,
        "-fps_mode",
        "passthrough",
        "-frames:v",
        "1",
        "-y",
        file,
      ]);
      const raw = spawnSync(
        "ffmpeg",
        ["-v", "error", "-i", file, "-vf", "scale=16:16,format=gray", "-f", "rawvideo", "-"],
        { maxBuffer: 1024 * 1024 },
      );
      if (raw.status !== 0) throw new Error("Cannot measure frame luminance");
      const pixels = raw.stdout;
      const mean = [...pixels].reduce((a, b) => a + b, 0) / pixels.length;
      return {
        ...e,
        file,
        sha256: artifactHash(file),
        meanLuma: mean,
        nearBlack: mean < 3,
        intentionalDark: intentionalDarkFrames.includes(e.frame),
      };
    });
  const tail = extracted.find((e) => e.frame === expectedFrames - 1);
  const findings = [];
  if (actualFrames !== expectedFrames) findings.push({ code: "DURATION_MISMATCH", expectedFrames, actualFrames });
  if (tail?.nearBlack && !tail.intentionalDark)
    findings.push({
      code: "UNEXPECTED_BLACK_TAIL",
      frame: tail.frame,
      meanLuma: tail.meanLuma,
      requiresManualReview: true,
    });
  for (const frame of extracted)
    if (frame.nearBlack && !frame.intentionalDark && frame !== tail)
      findings.push({
        code: "NEAR_BLACK_EVENT",
        frame: frame.frame,
        meanLuma: frame.meanLuma,
        requiresManualReview: true,
      });
  const esc = (v: unknown) =>
    String(v).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c]!,
    );
  writeFileSync(
    path.join(directory, "contact-sheet.html"),
    '<!doctype html><meta charset="utf-8"><title>Event QA</title><h1>Event evidence — manual review required</h1>' +
      extracted
        .map(
          (e) =>
            `<figure><img width="280" src="${path.basename(e.file)}"><figcaption>${e.frame} · ${esc(e.reasons.join(", "))} · luma ${e.meanLuma.toFixed(2)} · ${e.sha256}</figcaption></figure>`,
        )
        .join(""),
  );
  return {
    inputSha256: artifactHash(input),
    fps,
    actualFrames,
    expectedFrames,
    width: probe.width,
    height: probe.height,
    frames: extracted,
    findings,
    status: findings.length ? "findings" : "needs-manual-review",
  };
}
