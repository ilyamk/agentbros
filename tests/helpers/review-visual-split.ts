import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { audioProject } from "./review-audio";
import { importAsset } from "../../src/lib/assets/registry";
export const r = (num: number, den = 1) => ({ num, den });
/** Owned local diagnostic sources; no downloaded media, accounts or inference. */
export function splitProject(root: string, withVideo = false) {
  const f = audioProject(root),
    image = path.join(f.project, "blue.png");
  execFileSync(
    "ffmpeg",
    ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:size=480x270", "-frames:v", "1", "-threads", "1", image],
    { timeout: 10000 },
  );
  const register = (sourceFile: string) =>
    importAsset({
      rootDir: root,
      projectId: "demo",
      sourceFile,
      rights: { licence: "synthetic-test" },
      provenance: { origin: "manual" },
    }).asset;
  const bg = register(image);
  let media = bg;
  if (withVideo) {
    const file = path.join(f.project, "original.mp4");
    execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=size=480x270:rate=30:duration=3",
        "-vf",
        "geq=r=mod(N*17\\,240):g=mod(N*29\\,240):b=mod(N*43\\,240),scale=out_color_matrix=bt709",
        "-an",
        "-c:v",
        "libx264",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-colorspace",
        "bt709",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-color_range",
        "tv",
        "-threads",
        "1",
        file,
      ],
      { timeout: 10000 },
    );
    media = register(file);
  }
  const ir = f.store.read().timeline;
  ir.tracks[0].clips[0].assetId = bg.id;
  ir.tracks.splice(1, 0, {
    id: "cutaways",
    kind: "visual",
    clips: [
      {
        id: "cutaway",
        assetId: media.id,
        start: r(15),
        source: { start: r(7), end: r(withVideo ? 52 : 37), timebase: r(30) },
        rate: r(withVideo ? 3 : 1, withVideo ? 2 : 1),
        transition: { kind: "cut" },
        captions: [],
        payload: { originalHash: media.hash },
      },
    ],
  });
  if (withVideo) {
    const jpeg = path.join(f.project, "red.jpg");
    execFileSync(
      "ffmpeg",
      ["-v", "error", "-f", "lavfi", "-i", "color=c=red:size=480x270", "-frames:v", "1", "-threads", "1", jpeg],
      { timeout: 10000 },
    );
    const still = register(jpeg);
    ir.tracks.splice(1, 0, {
      id: "jpeg",
      kind: "visual",
      clips: [
        {
          id: "jpeg",
          assetId: still.id,
          start: r(45),
          source: { start: r(0), end: r(45), timebase: r(30) },
          rate: r(1),
          transition: { kind: "cut" },
          captions: [],
          payload: { originalHash: still.hash },
        },
      ],
    });
  }
  rmSync(f.store.file);
  f.store.initialize(ir);
  return { ...f, ir, media, bg };
}
