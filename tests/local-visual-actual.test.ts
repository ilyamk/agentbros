import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { ingestLocalVisual } from "../src/lib/ingest/local-visual";
import { ingestMedia, readSourceIndex } from "../src/lib/ingest";
import { importAsset, hashFile } from "../src/lib/assets/registry";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import { planBroll, applyBroll } from "../src/lib/ingest/broll";
const enabled = process.env.RUN_LOCAL_VISUAL_TESTS === "1";
test(
  "actual deny-network reference image → all ranked sampled frames → pinned reviewed B-roll",
  { skip: !enabled },
  async () => {
    const cwd = process.cwd(),
      artifacts = process.env.LOCAL_VISUAL_ARTIFACTS!,
      images = process.env.LOCAL_VISUAL_IMAGES!,
      configFile = process.env.LOCAL_VISUAL_CONFIG!;
    assert.ok(
      artifacts && images && configFile,
      "Explicit installed runtime and input fixtures required; no preparation/download",
    );
    mkdirSync(artifacts, { recursive: true });
    const root = realpathSync(mkdtempSync(path.join(artifacts, "actual-"))),
      project = path.join(root, "public/projects/test");
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, "project.json"), "{}");
    const config = JSON.parse(readFileSync(configFile, "utf8")),
      english = path.join(images, "english.png"),
      russian = path.join(images, "russian.png"),
      source = path.join(root, "source.mp4");
    const ff = (args: string[]) => execFileSync("ffmpeg", ["-v", "error", ...args], { timeout: 20000 });
    ff([
      "-loop",
      "1",
      "-i",
      english,
      "-loop",
      "1",
      "-i",
      english,
      "-loop",
      "1",
      "-i",
      russian,
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=370:sample_rate=48000:duration=3",
      "-filter_complex",
      "[0:v]trim=duration=1,setpts=PTS-STARTPTS[a];[1:v]eq=brightness=0.05,trim=duration=1,setpts=PTS-STARTPTS[b];[2:v]trim=duration=1,setpts=PTS-STARTPTS[c];[a][b][c]concat=n=3:v=1:a=0[v]",
      "-map",
      "[v]",
      "-map",
      "3:a",
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-t",
      "3",
      source,
    ]);
    process.chdir(root);
    try {
      const query = importAsset({ projectId: "test", sourceFile: english, provenance: { origin: "manual" } }).asset;
      const video = importAsset({
        projectId: "test",
        sourceFile: source,
        provenance: { origin: "manual" },
        rights: {
          licence: "Synthetic fixture only; not production rights",
          checkedAsOf: "2026-10-11T00:00:00Z",
          attributionRequired: false,
          commercialAllowed: false,
        },
      }).asset;
      const transcript = path.join(root, "transcript.json");
      writeFileSync(
        transcript,
        JSON.stringify({ segments: [{ text: "Do not remove this protected explanation.", start: 0, end: 1.5 }] }),
      );
      const base = ingestMedia({
          projectId: "test",
          sourceFile: source,
          transcriptFile: transcript,
          options: {
            thumbnailEverySec: 1,
            protectedSpans: [{ startSec: 0, endSec: 1.5, reason: "Fixed negative statement" }],
          },
        }),
        baseBytes = readFileSync(base.file);
      const request = { projectId: "test", indexFile: base.file, queryAssetId: query.id, config };
      const started = Date.now();
      const result = await ingestLocalVisual(request),
        elapsedMs = Date.now() - started;
      assert.equal(result.hits.length, 3);
      const expectedLabels = ["reference-English", "brightness-English", "unlike-Russian"];
      const distances = Array.from(
        { length: 3 },
        (_, i) => result.hits.find((h) => h.segmentId === `visual-frame-${i}`)!.distance,
      );
      assert.ok(distances[0]! < distances[2]!, JSON.stringify(distances));
      assert.ok(distances[1]! < distances[2]!, JSON.stringify(distances));
      assert.deepEqual(readFileSync(base.file), baseBytes);
      assert.deepEqual(readSourceIndex("test", result.file), result.index);
      for (let i = 0; i < 3; i++) {
        const s = result.index.segments.find((s) => s.id === `visual-frame-${i}`)!;
        assert.equal(s.startSec, i);
        assert.equal(s.endSec, base.index!.source.timestamps[i * 30 + 1]);
      }
      const cached = await ingestLocalVisual(request);
      assert.equal(cached.workerCacheHit, true);
      assert.equal(cached.cacheHit, true);
      const store = new TimelineEditStore(path.join(project, "pipeline/timeline-edit.json"));
      store.initialize({
        version: 1,
        projectId: "test",
        timebase: { num: 30, den: 1 },
        tracks: [
          {
            id: "dialogue",
            kind: "visual",
            clips: [
              {
                id: "original",
                assetId: video.id,
                start: { num: 0, den: 1 },
                source: { start: { num: 0, den: 1 }, end: { num: 90, den: 1 }, timebase: { num: 30, den: 1 } },
                captions: [],
              },
            ],
          },
          {
            id: "original-audio",
            kind: "voiceover",
            clips: [
              {
                id: "original-sound",
                assetId: video.id,
                start: { num: 0, den: 1 },
                source: { start: { num: 0, den: 1 }, end: { num: 90, den: 1 }, timebase: { num: 30, den: 1 } },
                captions: [],
              },
            ],
          },
        ],
      });
      const before = store.read(),
        plan = planBroll(
          {
            version: 1,
            projectId: "test",
            indexFile: path.relative(project, result.file),
            retrieval: { method: "native-image-distance" },
            segmentId: result.hits[0]!.segmentId,
            contextSec: 0,
            trackId: "reference-cutaway",
            clipId: "reference-cutaway",
            outputStart: { num: 30, den: 1 },
            expectedRevision: 0,
          },
          { rootDir: root },
        );
      const review = {
        planHash: plan.planHash,
        assetHash: plan.assetHash,
        reviewedBy: "synthetic-test",
        evidence: "Explicit fixture declaration, no human/production approval",
      };
      applyBroll(plan, review, { rootDir: root, dryRun: true });
      assert.deepEqual(store.read(), before);
      const after = applyBroll(plan, review, { rootDir: root });
      assert.deepEqual(after.timeline.tracks.slice(0, -1), before.timeline.tracks);
      assert.equal(plan.sourceAudio, "muted-visual-track");
      assert.deepEqual(store.undo(after.revision).timeline, before.timeline);
      writeFileSync(
        path.join(root, "acceptance.json"),
        JSON.stringify(
          {
            sourceHash: video.hash,
            queryHash: query.hash,
            workerSourceHash: config.workerSourceHash,
            executableHash: config.executableHash,
            elapsedMs,
            labels: expectedLabels,
            distances,
            allRanks: result.hits,
            receiptFile: result.receiptFile,
            receiptHash: hashFile(result.receiptFile),
            indexFile: result.file,
            indexHash: hashFile(result.file),
            plan,
            before,
            after,
            originalTracksEqual: true,
            undoEqual: true,
            cacheHit: true,
            limits:
              "Tiny graphic/text corpus only; no persistence/semantic confidence/human quality claim. Render/PCM evidence separate.",
          },
          null,
          2,
        ) + "\n",
      );
    } finally {
      process.chdir(cwd);
    }
  },
);
test(
  "actual native feature prints honor all eight EXIF orientations; registered EXIF6 and unknown orientation fail closed",
  { skip: !enabled },
  async () => {
    const dir = process.env.LOCAL_VISUAL_ORIENTATION!;
    assert.ok(dir, "Explicit prebuilt orientation fixtures required");
    const config = JSON.parse(readFileSync(process.env.LOCAL_VISUAL_CONFIG!, "utf8")),
      all = [];
    const compare = (query: string, frames: string[]) =>
      execFileSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)(deny network*)", config.executable], {
        input:
          JSON.stringify({
            version: 1,
            operation: "compare",
            key: "a".repeat(64),
            revision: 2,
            query: { file: query, hash: hashFile(query) },
            frames: frames.map((file) => ({ file, hash: hashFile(file) })),
          }) + "\n",
        encoding: "utf8",
        timeout: 120000,
        env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
      });
    for (let n = 1; n <= 8; n++) {
      const query = path.join(dir, `exif${n}.jpg`),
        physical = path.join(dir, `display${n}.png`);
      const physicalCorpus = Array.from({ length: 8 }, (_, i) => path.join(dir, `display${i + 1}.png`));
      const output = JSON.parse(compare(query, [...physicalCorpus, path.join(dir, "exif1.jpg")]));
      assert.equal(output.runtime.orientationPolicy, "validated-jpeg-png-exif-1-through-8-v1");
      all.push({ orientation: n, queryHash: hashFile(query), physicalHash: hashFile(physical), ...output });
      writeFileSync(path.join(dir, "measured-ranks.json"), JSON.stringify(all, null, 2) + "\n");
      const matched = output.frames[n - 1].distance;
      assert.equal(
        output.frames
          .slice(0, 8)
          .findIndex((f: any) => f.distance === Math.min(...output.frames.slice(0, 8).map((f: any) => f.distance))),
        n - 1,
        JSON.stringify({ orientation: n, output }),
      );
      if (n !== 1)
        assert.ok(matched < output.frames[8].distance, "Displayed orientation must beat silently upright raw pixels");
    }
    // Only patch the declared EXIF orientation field, never image pixels. ImageIO's writer normalizes unknown values.
    const malformed = Buffer.from(readFileSync(path.join(dir, "exif1.jpg"))),
      exif = malformed.indexOf(Buffer.from("Exif\0\0")),
      tiff = exif + 6;
    assert.ok(exif >= 0);
    const little = malformed.toString("ascii", tiff, tiff + 2) === "II";
    const u16 = (p: number) => (little ? malformed.readUInt16LE(p) : malformed.readUInt16BE(p)),
      u32 = (p: number) => (little ? malformed.readUInt32LE(p) : malformed.readUInt32BE(p));
    const ifd = tiff + u32(tiff + 4);
    let found = false;
    for (let i = 0; i < u16(ifd); i++) {
      const entry = ifd + 2 + i * 12;
      if (u16(entry) === 0x112) {
        assert.equal(u16(entry + 2), 3);
        assert.equal(u32(entry + 4), 1);
        if (little) malformed.writeUInt16LE(9, entry + 8);
        else malformed.writeUInt16BE(9, entry + 8);
        found = true;
      }
    }
    assert.equal(found, true);
    const unknown = path.join(dir, "unknown9.jpg");
    writeFileSync(unknown, malformed);
    assert.throws(() => compare(unknown, [path.join(dir, "display1.png")]), /unsupported EXIF orientation/);
    assert.throws(() => compare(path.join(dir, "exif1.jpg"), [unknown]), /unsupported EXIF orientation/);
    // Registered image follows the same production import/index/cache path; its bytes retain EXIF6.
    const cwd = process.cwd(),
      root = realpathSync(mkdtempSync(path.join(process.env.LOCAL_VISUAL_ARTIFACTS!, "exif6-"))),
      project = path.join(root, "public/projects/test");
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, "project.json"), "{}");
    const video = path.join(root, "oriented.mp4");
    execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-loop",
        "1",
        "-i",
        path.join(dir, "display6.png"),
        "-t",
        "2",
        "-r",
        "30",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        video,
      ],
      { timeout: 20000 },
    );
    process.chdir(root);
    try {
      const asset = importAsset({
        projectId: "test",
        sourceFile: path.join(dir, "exif6.jpg"),
        provenance: { origin: "manual" },
      }).asset;
      const base = ingestMedia({
        projectId: "test",
        sourceFile: video,
        options: { thumbnailEverySec: 1, proxyWidth: 240 },
      });
      const result = await ingestLocalVisual({
        projectId: "test",
        indexFile: base.file,
        queryAssetId: asset.id,
        config,
      });
      assert.equal(result.index.visualAnalysis?.engine, "apple-vision-feature-print");
      assert.equal(result.identity.runtime.orientationPolicy, "validated-jpeg-png-exif-1-through-8-v1");
      assert.deepEqual(readSourceIndex("test", result.file), result.index);
      assert.equal(result.hits[0]!.query.hash, hashFile(path.join(dir, "exif6.jpg")));
      assert.notEqual(
        all[5].queryFeatureHash,
        all[0].queryFeatureHash,
        "EXIF6 must not silently retain upright feature print",
      );
      writeFileSync(
        path.join(dir, "acceptance.json"),
        JSON.stringify(
          {
            allOrientations: all,
            unknownOrientationRejected: true,
            registeredQueryAsset: asset,
            productionIndex: result.file,
            productionReceipt: result.receiptFile,
            productionHits: result.hits,
            workerSourceHash: config.workerSourceHash,
            executableHash: config.executableHash,
            limits:
              "Equivalence measured on this pinned OS only; no cross-machine pixel or natural-image quality claim.",
          },
          null,
          2,
        ) + "\n",
      );
    } finally {
      process.chdir(cwd);
    }
  },
);
