import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { RgbImage } from "./image";
import { writeImage, probeVideo } from "./media";
import { buildStrip } from "./sheets";
import { reviewHash, writeReviewPack } from "./review-pack";
import type { EvaluationCase } from "./evaluation";

const categories = ["typography", "ui", "captions", "motion", "boundaries", "integrity"] as const;
export function prepareVisionEvaluation(output: string) {
  if (existsSync(output)) throw new Error("Fixture output already exists; retain it and choose a new directory.");
  mkdirSync(output, { recursive: true });
  const cases: EvaluationCase[] = [];
  for (const category of categories)
    for (let variation = 0; variation < 4; variation++) {
      const id = "q" + createHash("sha256").update(`vision-v1:${category}:${variation}`).digest("hex").slice(0, 12),
        root = path.resolve(output, id);
      mkdirSync(root);
      const source = path.join(root, "source.mp4");
      const initial = RgbImage.filled(1280, 720, [239, 237, 230]);
      initial.drawText("DIAGNOSTIC TEST STAGE", 60, 50, 5, [15, 20, 26]);
      let brief = "",
        missing = "";
      const plate = (frame: number) => {
        const image = new RgbImage(initial.width, initial.height, Buffer.from(initial.data));
        if (category === "typography") {
          brief =
            "Check whether the title is fully within the stage and whether independent title and subtitle overlap in the settled state. All text should be visible by F10; the early reveal is intentionally masked.";
          image.drawText("READABLE TITLE", variation === 0 ? 1100 : 80, 260, 8, [0, 0, 0]);
          image.drawText("SUPPORTING TEXT", 80, variation === 1 ? 270 : 400, 5, [20, 25, 30]);
          if (frame < 10) image.fillRect(0, 300, 1280, 100, [239, 237, 230]);
          if (variation === 3) missing = "Only F0 is supplied; no settled frame is available.";
        } else if (category === "ui") {
          brief =
            "Read the access role on this synthetic test interface. The intended role is VIEWER. Check role correctness, without judging design taste.";
          image.fillRect(80, 200, 1120, 300, [250, 250, 250]);
          image.drawText("ACCOUNT ACCESS", 120, 240, 5, [10, 15, 20]);
          image.drawText(
            `ROLE: ${variation < 2 ? (variation === 0 ? "ADMIN" : "EDITOR") : "VIEWER"}`,
            120,
            380,
            2,
            [10, 15, 20],
          );
          if (variation === 3) {
            image.fillRect(115, 370, 300, 50, [200, 200, 200]);
            missing = "Role text is occluded; no alternate view or DOM measurement is available.";
          }
        } else if (category === "captions") {
          brief =
            "Check the visible caption against the supplied transcript, which says DO NOT SHARE. The caption should preserve that meaning and remain visible at F15.";
          image.drawText(variation === 0 ? "DO SHARE" : "DO NOT SHARE", 200, 560, 6, [10, 15, 20]);
          if (variation === 1) image.fillRect(0, 550, 1280, 150, [239, 237, 230]);
          if (variation === 3) {
            brief =
              "Check whether the visible caption preserves the spoken meaning. No transcript, speech alignment or audio evidence is available.";
            missing = "Transcript and sound evidence unavailable.";
          }
        } else if (category === "motion") {
          brief =
            "The square is intended to move smoothly to the right at constant speed, without holds or backwards jumps. Inspect consecutive frame positions; sparse samples cannot establish smoothness.";
          const position =
            variation === 0 ? Math.floor(frame / 3) * 30 : variation === 1 && frame === 11 ? 10 : frame * 10;
          image.fillRect(100 + position, 300, 100, 100, [30, 90, 210]);
          if (variation === 3) missing = "Only F15 is available. There is no motion sequence.";
        } else if (category === "boundaries") {
          brief =
            "The intended cut is from a red plate to a blue plate at F15, with a held blue final frame F29. Identify an unintended black flash or black final frame if visible.";
          image.fillRect(
            0,
            0,
            1280,
            720,
            (variation === 0 && frame === 14) || (variation === 1 && frame === 29)
              ? [0, 0, 0]
              : frame < 15
                ? [190, 45, 45]
                : [40, 70, 190],
          );
          if (variation === 3) missing = "Only F15 is supplied; no cut neighbourhood or final frame is available.";
        } else {
          brief =
            "Determine whether these review images are valid current-source evidence. Use the supplied binding and image-integrity checks; pixels alone do not establish source identity.";
          image.drawText("SOURCE-BOUND REVIEW", 80, 300, 5, [10, 15, 20]);
          if (variation === 3) missing = "Source binding is unavailable; current revision cannot be verified.";
        }
        return image;
      };
      // PNG sequences make the fixture independent of drawtext availability.
      const sequence = path.join(root, "sequence");
      mkdirSync(sequence);
      for (let frame = 0; frame < 30; frame++)
        writeImage(plate(frame), path.join(sequence, `${String(frame).padStart(3, "0")}.png`));
      const encoded = spawnSync("ffmpeg", [
        "-v",
        "error",
        "-nostdin",
        "-framerate",
        "30",
        "-i",
        path.join(sequence, "%03d.png"),
        "-c:v",
        "libx264",
        "-crf",
        "10",
        "-threads",
        "2",
        "-pix_fmt",
        "yuv420p",
        source,
      ]);
      if (encoded.status !== 0) throw new Error(encoded.stderr.toString());
      const media = probeVideo(source),
        baseline = path.join(root, "baseline"),
        candidate = path.join(root, "candidate");
      mkdirSync(baseline);
      mkdirSync(candidate);
      const limited = variation === 3;
      const only = category === "typography" ? 0 : 15;
      const pack = writeReviewPack(
        {
          input: source,
          profile:
            category === "motion" || category === "boundaries" ? "motion" : category === "ui" ? "ui" : "typography",
          ...(limited
            ? { startFrame: only, endFrame: only, count: 2 }
            : {
                count: 3,
                ...(category === "motion" || category === "boundaries" ? { startFrame: 0, endFrame: 29 } : {}),
              }),
          events: limited
            ? []
            : [0, 10, 15, 29].map((frame) => ({ frame, reasons: ["review anchor"], basis: "declared" })),
        },
        path.join(candidate, "pack"),
      );
      const old = buildStrip(source, media, {
        startFrame: limited ? only : 0,
        endFrame: limited ? only : 29,
        step: limited ? 1 : 6,
        width: 186,
        columns: 5,
      });
      writeImage(old.image, path.join(baseline, "sheet.png"));
      const metadata = {
        sourceBinding:
          category === "integrity"
            ? variation === 0
              ? "stale: render source hash changed"
              : variation === 3
                ? "unavailable"
                : "current: hash checked"
            : "current: hash checked",
        coverage: missing || "F0 through F29, 30 fps; request original images when details are too small.",
        audio: "not supplied",
        measurements: "not supplied; do not invent values",
      };
      for (const [variant, directory] of [
        ["baseline", baseline],
        ["candidate", candidate],
      ] as const) {
        const assets: Array<{ id: string; path: string; sha256: string }> =
          variant === "baseline"
            ? [{ id: "sheet", path: "sheet.png", sha256: reviewHash(path.join(directory, "sheet.png")) }]
            : pack.data.pages
                .filter((p) => p.kind === "frames")
                .map((p, i) => ({ id: `page-${i + 1}`, path: `pack/${p.path}`, sha256: p.sha256 }));
        if (variant === "candidate")
          for (const frame of pack.data.frames)
            assets.push({ id: frame.id, path: `pack/${frame.path}`, sha256: frame.sha256 });
        if (category === "integrity" && variation === 1) {
          const bad = path.join(directory, assets[0]!.path);
          copyFileSync(path.join(sequence, "000.png"), bad);
          assets[0]!.sha256 = "0".repeat(64);
        }
        writeFileSync(path.join(directory, "packet.json"), JSON.stringify({ brief, metadata, assets }, null, 2));
      }
      cases.push({
        id,
        category,
        expected: variation < 2 ? "defect" : variation === 2 ? "clear" : "insufficient",
        packets: { baseline: path.join(baseline, "packet.json"), candidate: path.join(candidate, "packet.json") },
      });
    }
  const file = path.resolve(output, "cases.json");
  writeFileSync(file, JSON.stringify(cases, null, 2));
  return file;
}
