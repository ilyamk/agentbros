import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs, runScript } from "../../src/lib/cli";
import { RgbImage } from "../../src/lib/vision/image";
import { probeVideo, writeImage } from "../../src/lib/vision/media";
import { reviewHash, visionCommand, writeReviewPack } from "../../src/lib/vision/review-pack";
import type { EvaluationCase, VisionEvalResult } from "../../src/lib/vision/evaluation";

void runScript(async () => {
  const args = parseArgs([
    { name: "campaign", required: true, description: "Completed campaign report" },
    { name: "cases", required: true, description: "Frozen case key" },
    { name: "decisions", required: true, description: "Independent observed/action review decisions" },
    { name: "output", required: true, description: "New repair evidence directory" },
  ] as const);
  const campaign = JSON.parse(readFileSync(args.campaign!, "utf8")) as { passed: boolean; results: VisionEvalResult[] };
  if (!campaign.passed) throw new Error("Classification acceptance must pass before the repair gate.");
  const cases = JSON.parse(readFileSync(args.cases!, "utf8")) as EvaluationCase[];
  const decisions = JSON.parse(readFileSync(args.decisions!, "utf8")) as Array<{
    harness: string;
    caseId: string;
    observationAccepted: boolean;
    actionAccepted: boolean;
    note: string;
  }>;
  mkdirSync(args.output!);
  const results = [];
  for (const harness of ["codex", "claude"])
    for (const category of ["typography", "ui", "captions", "boundaries"]) {
      const task = cases.find((task) => task.category === category && task.expected === "defect")!;
      const judgement = campaign.results.find(
        (row) => row.harness === harness && row.caseId === task.id && row.variant === "candidate",
      );
      const decision = decisions.find((row) => row.harness === harness && row.caseId === task.id);
      if (
        !judgement?.citationsValid ||
        judgement.judgement?.status !== "defect" ||
        !decision?.observationAccepted ||
        !decision.actionAccepted ||
        !decision.note
      )
        throw new Error(`Independent observation/action review did not pass: ${harness}/${category}`);
      const source = path.join(path.dirname(path.dirname(task.packets.candidate)), "source.mp4"),
        sourceHash = reviewHash(source),
        info = probeVideo(source);
      const directory = path.resolve(args.output!, `${harness}-${category}`),
        frames = path.join(directory, "frames");
      mkdirSync(frames, { recursive: true });
      visionCommand("ffmpeg", [
        "-v",
        "error",
        "-i",
        source,
        "-fps_mode",
        "passthrough",
        "-start_number",
        "0",
        path.join(frames, "%03d.png"),
      ]);
      const before = path.join(directory, "before.png");
      const verifyFrame = category === "boundaries" ? 14 : 15;
      writeFileSync(before, readFileSync(path.join(frames, `${String(verifyFrame).padStart(3, "0")}.png`)));
      for (const [frame, name] of readdirSync(frames).sort().entries()) {
        const file = path.join(frames, name);
        if (category === "boundaries") {
          if (frame === 14) writeFileSync(file, readFileSync(path.join(frames, "013.png")));
          continue;
        }
        const data = visionCommand("ffmpeg", [
          "-v",
          "error",
          "-i",
          file,
          "-frames:v",
          "1",
          "-pix_fmt",
          "rgb24",
          "-f",
          "rawvideo",
          "pipe:1",
        ]);
        const image = new RgbImage(info.width, info.height, Buffer.from(data));
        if (category === "typography") {
          image.fillRect(0, 250, 1280, 120, [239, 237, 230]);
          image.drawText("READABLE TITLE", 80, 260, 8, [0, 0, 0]);
          if (frame < 10) image.fillRect(0, 300, 1280, 70, [239, 237, 230]);
        }
        if (category === "ui") {
          image.fillRect(110, 370, 300, 50, [250, 250, 250]);
          image.drawText("ROLE: VIEWER", 120, 380, 2, [10, 15, 20]);
        }
        if (category === "captions") {
          image.fillRect(0, 550, 1280, 120, [239, 237, 230]);
          image.drawText("DO NOT SHARE", 200, 560, 6, [10, 15, 20]);
        }
        const bounds =
          category === "typography"
            ? [0, 250, 1280, 120]
            : category === "ui"
              ? [110, 370, 300, 50]
              : [0, 550, 1280, 120];
        for (let y = 0; y < info.height; y++)
          for (let x = 0; x < info.width; x++)
            if (x < bounds[0]! || y < bounds[1]! || x >= bounds[0]! + bounds[2]! || y >= bounds[1]! + bounds[3]!) {
              const offset = (y * info.width + x) * 3;
              if (!image.data.subarray(offset, offset + 3).equals(data.subarray(offset, offset + 3)))
                throw new Error("Repair changed pixels outside its declared region.");
            }
        // Replace our disposable decoded frame only; supplied originals remain immutable.
        const patched = path.join(directory, `${name}.patched.png`);
        writeImage(image, patched);
        writeFileSync(file, readFileSync(patched));
      }
      const render = path.join(directory, "repaired.mp4");
      const encoded = spawnSync("ffmpeg", [
        "-v",
        "error",
        "-framerate",
        "30",
        "-i",
        path.join(frames, "%03d.png"),
        "-c:v",
        "libx264",
        "-qp",
        "0",
        "-pix_fmt",
        "yuv444p",
        "-threads",
        "2",
        render,
      ]);
      if (encoded.status !== 0) throw new Error(encoded.stderr.toString());
      const newInfo = probeVideo(render);
      if (newInfo.frameCount !== info.frameCount || newInfo.fps !== info.fps || reviewHash(source) !== sourceHash)
        throw new Error("Repair changed source or temporal coverage.");
      const pack = writeReviewPack(
        { input: render, count: 2, events: [{ frame: verifyFrame, reasons: ["repair verification"] }] },
        path.join(directory, "review"),
      );
      const actual = pack.data.frames.find((frame) => frame.frame === verifyFrame)!;
      const expectedPixels = visionCommand("ffmpeg", [
        "-v",
        "error",
        "-i",
        path.join(frames, `${String(verifyFrame).padStart(3, "0")}.png`),
        "-frames:v",
        "1",
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "pipe:1",
      ]);
      const actualPixels = visionCommand("ffmpeg", [
        "-v",
        "error",
        "-i",
        path.join(path.dirname(pack.manifest), actual.path),
        "-frames:v",
        "1",
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "pipe:1",
      ]);
      const mae =
        actualPixels.reduce((sum, value, i) => sum + Math.abs(value - expectedPixels[i]!), 0) / actualPixels.length;
      if (mae > 2) throw new Error("Repaired render does not reproduce patched pixels.");
      results.push({
        harness,
        category,
        caseId: task.id,
        sourceHash,
        renderHash: reviewHash(render),
        proposedAction: judgement.judgement.nextAction,
        independentReview: decision,
        before,
        after: path.join(path.dirname(pack.manifest), actual.path),
        review: pack.manifest,
        frameCount: newInfo.frameCount,
        fps: newInfo.fps,
        pixelMae: mae,
        status: "technical-repair-verified",
      });
    }
  const report = path.resolve(args.output!, "repairs.json");
  writeFileSync(
    report,
    JSON.stringify(
      {
        version: 1,
        campaignSha256: reviewHash(args.campaign!),
        decisionsSha256: reviewHash(args.decisions!),
        results,
        creativeApproval: "not-inferred",
      },
      null,
      2,
    ),
  );
  return { outputs: [report], metadata: { verified: results.length } };
});
