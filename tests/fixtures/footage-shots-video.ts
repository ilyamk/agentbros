import { execFileSync } from "node:child_process";
import path from "node:path";

const FPS = 30;
const SIZE = "320x180";
const DISSOLVE_OFFSET = 120;
const DISSOLVE_FRAMES = 12;
const FADE_OFFSET = 156;
const FADE_FRAMES = 24;

/**
 * Six moving shots with sensor grain: hard cuts at 45, 90 and 216, a 12-frame dissolve and a fade through black.
 * xfade at offset O over D frames blends frames O+1 to O+D-1; frame O+D is already the next shot.
 */
export const SHOTS_FIXTURE = {
  fps: FPS,
  frames: 261,
  cuts: [45, 90, 216],
  dissolve: { startFrame: DISSOLVE_OFFSET + 1, endFrame: DISSOLVE_OFFSET + DISSOLVE_FRAMES - 1 },
  fade: { startFrame: FADE_OFFSET + 1, endFrame: FADE_OFFSET + FADE_FRAMES - 1 },
} as const;

export function makeShotsFixture(directory: string): string {
  const output = path.join(directory, "shots-fixture.mp4");
  const sources = [
    `testsrc2=s=${SIZE}:r=${FPS}:d=1.5`,
    `mandelbrot=s=${SIZE}:r=${FPS},trim=end_frame=45`,
    `testsrc2=s=640x360:r=${FPS},crop=320:180:x='t*60':y=60,hue=h=140,trim=end_frame=60`,
    `gradients=s=${SIZE}:r=${FPS}:speed=0.1:c0=#e05030:c1=#2040a0:c2=#f0e070,trim=end_frame=60`,
    `zoneplate=s=${SIZE}:r=${FPS}:kx2=60:ky2=60:kt=2,trim=end_frame=60`,
    `testsrc2=s=${SIZE}:r=${FPS}:d=1.5,negate,hflip`,
  ];
  const cfr = (input: string, label: string) => `[${input}]format=yuv420p,settb=1/${FPS},setpts=N[${label}]`;
  const graph = [
    `[0][1][2]concat=n=3:v=1:a=0,format=yuv420p,settb=1/${FPS},setpts=N[a]`,
    cfr("3", "g"),
    cfr("4", "z"),
    cfr("5", "n"),
    `[a][g]xfade=transition=fade:duration=${DISSOLVE_FRAMES / FPS}:offset=${DISSOLVE_OFFSET / FPS}[ag]`,
    `[ag][z]xfade=transition=fadeblack:duration=${FADE_FRAMES / FPS}:offset=${FADE_OFFSET / FPS}[agz]`,
    `[agz][n]concat=n=2:v=1:a=0,noise=alls=6:allf=t:all_seed=7,settb=1/${FPS},setpts=N[out]`,
  ].join(";");
  execFileSync("ffmpeg", ["-v", "error", "-y", ...sources.flatMap((source) => ["-f", "lavfi", "-i", source]), "-filter_complex", graph, "-map", "[out]", "-r", String(FPS), "-c:v", "libx264", "-crf", "14", "-g", "30", "-pix_fmt", "yuv420p", output]);
  return output;
}

/** One second at 30 fps, then two at 15 fps: 60 decoded frames with uneven timestamps, about 90 once made constant at 30 fps. */
export function makeVariableRateFixture(directory: string): string {
  const output = path.join(directory, "vfr.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=s=${SIZE}:r=30:d=2`, "-vf", "setpts='if(lt(N,30),N/30,1+(N-30)/15)/TB'", "-fps_mode", "vfr", "-c:v", "libx264", "-pix_fmt", "yuv420p", output]);
  return output;
}

/** Red for 30 frames, then blue, in a video stream that starts 0.4 s after the audio: the cut is original-stream frame 30. */
export function makeLateStartFixture(directory: string): string {
  const inner = path.join(directory, "late-inner.mp4");
  const output = path.join(directory, "late.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=red:s=64x36:r=30:d=1", "-f", "lavfi", "-i", "color=blue:s=64x36:r=30:d=1", "-filter_complex", "[0][1]concat=n=2:v=1:a=0", "-c:v", "libx264", "-pix_fmt", "yuv420p", inner]);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-itsoffset", "0.4", "-i", inner, "-f", "lavfi", "-t", "2.4", "-i", "anullsrc=r=48000:cl=mono", "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", output]);
  return output;
}
