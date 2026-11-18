import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { bundle } from "@remotion/bundler";
import { selectComposition, renderStill, renderMedia } from "@remotion/renderer";
import { IconResources } from "../src/lib/icon-resources/service";
import { captureBespokeIdentity } from "../src/lib/delivery/bespoke";
import { captureRenderIdentity } from "../src/lib/delivery/identity";
import { captureDeliverySnapshot, checkDelivery } from "../src/lib/delivery/service";
import { publishRenderReceipt } from "../src/lib/delivery/render-receipt";
import { hashFile } from "../src/lib/assets/registry";
import { ProjectConfigSchema } from "../src/types/video";
import type { DeliveryRequest } from "../src/types/delivery";

test(
  "actual local icon render, template identity, bespoke receipt and strict delivery",
  { skip: process.env.RUN_RENDER_TESTS !== "1", timeout: 180000 },
  async (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "icons-browser-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const dir = path.join(root, "public/projects/demo");
    mkdirSync(path.join(dir, "pipeline"), { recursive: true });
    const config = ProjectConfigSchema.parse({
      name: "Icon proof",
      productName: "Fixture",
      formats: ["square"],
      colors: {},
      musicVolume: 0,
      scenes: [{ id: "icon", text: "", headline: "", visualType: "photo", durationInFrames: 30 }],
    });
    writeFileSync(path.join(dir, "project.json"), JSON.stringify(config));
    const service = new IconResources(root, "demo"),
      a = await service.acquire("lucide:shield", { offline: true }),
      d = await service.export(a.id, { size: 256, colour: "#ff0000" });
    config.scenes[0].imageUrl = d.file;
    writeFileSync(path.join(dir, "project.json"), JSON.stringify(config));
    const template = captureRenderIdentity("demo", "square", { rootDir: root });
    assert.ok(template.sources.some((s) => s.path === `public/${a.original}`));
    rmSync(path.join(dir, "project.json"));
    writeFileSync(path.join(dir, "pipeline/brief.json"), JSON.stringify({ renderMode: "bespoke", format: "square" }));
    writeFileSync(
      path.join(dir, "pipeline/motion-plan.json"),
      JSON.stringify({ fps: 30, shots: [{ id: "one", startFrame: 0, durationFrames: 30 }] }),
    );
    writeFileSync(path.join(dir, "pipeline/build.json"), JSON.stringify({ composition: "IconProof" }));
    assert.throws(() => captureBespokeIdentity("demo", "square", { rootDir: root }), /explicit iconUsages/);
    const usage = { ...d.usage, placementId: "proof" };
    writeFileSync(
      path.join(dir, "pipeline/build.json"),
      JSON.stringify({ composition: "IconProof", iconUsages: [usage] }),
    );
    const identity = captureBespokeIdentity("demo", "square", { rootDir: root });
    assert.ok(identity.sources.some((s) => s.path === `public/${d.file}`));
    assert.ok(!identity.sources.some((s) => s.path.includes("/assets/imported/")));
    const entry = path.join(root, "entry.tsx");
    writeFileSync(
      entry,
      `import React from 'react';import {registerRoot,Composition,AbsoluteFill} from 'remotion';import {IconVisual} from ${JSON.stringify(path.resolve("src/motion/library/data/IconVisual"))};const Video=()=> <AbsoluteFill style={{background:'white'}}><IconVisual {...${JSON.stringify({ ...usage, size: 400, label: "", colour: "#ff0000" })}}/></AbsoluteFill>;registerRoot(()=> <Composition id="IconProof" component={Video} width={1080} height={1080} fps={30} durationInFrames={30}/>);`,
    );
    const serveUrl = await bundle({
      outDir: path.join(root, "bundle"),
      entryPoint: entry,
      publicDir: path.join(root, "public"),
      webpackOverride: (c) => ({
        ...c,
        resolve: { ...c.resolve, modules: [path.resolve("node_modules"), "node_modules"] },
      }),
    });
    const composition = await selectComposition({ serveUrl, id: "IconProof" }),
      still = path.join(root, "still.png");
    await renderStill({ serveUrl, composition, output: still, imageFormat: "png" });
    const decoded = spawnSync("ffmpeg", ["-v", "error", "-i", still, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], {
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.equal(decoded.status, 0);
    const pixels = decoded.stdout;
    let red = 0,
      black = 0;
    for (let i = 0; i < pixels.length; i += 3) {
      if (pixels[i] > 180 && pixels[i + 1] < 80 && pixels[i + 2] < 80) red++;
      if (pixels[i] < 50 && pixels[i + 1] < 50 && pixels[i + 2] < 50) black++;
    }
    assert.ok(red > 1000, `red outline pixels ${red}`);
    assert.equal(black, 0, "root presentation attributes must retain red stroke and fill none");
    const muted = path.join(root, "muted.mp4");
    await renderMedia({ serveUrl, composition, outputLocation: muted, codec: "h264", concurrency: 1 });
    const output = path.join(root, "out/demo/film.mp4");
    mkdirSync(path.dirname(output), { recursive: true });
    const mux = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        muted,
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
        "-af",
        "loudnorm=I=-16:TP=-2:LRA=7",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-shortest",
        output,
      ],
      { encoding: "utf8" },
    );
    assert.equal(mux.status, 0, mux.stderr);
    const after = captureBespokeIdentity("demo", "square", { rootDir: root });
    assert.equal(after.sourceSnapshotHash, identity.sourceSnapshotHash);
    publishRenderReceipt(output, identity, after, root);
    const request = {
      version: 1,
      projectId: "demo",
      formats: ["square"],
      variants: ["captioned"],
      placements: ["youtube"],
      commercial: true,
      approvalMode: "manual",
      loudness: { targetLufs: -16, toleranceLu: 1, maxTruePeakDb: -1, audioRequired: true },
    } as DeliveryRequest;
    const { snapshot } = captureDeliverySnapshot(request, { rootDir: root }),
      human = {
        reviewedBy: "Fixture reviewer",
        reviewedAt: new Date().toISOString(),
        evidence: "Synthetic local fixture only",
      };
    request.manualApproval = { ...human, storyHash: snapshot.identities[0].storyHash, sourceSnapshotHash: snapshot.id };
    request.visualReview = {
      ...human,
      sourceSnapshotHash: snapshot.id,
      outputHashes: [hashFile(output)],
      approved: true,
    };
    const result = checkDelivery(request, snapshot, { rootDir: root });
    assert.equal(result.productionReady, true, JSON.stringify(result.blockers));
    writeFileSync(d.absolutePath, "changed");
    assert.throws(() => captureBespokeIdentity("demo", "square", { rootDir: root }), /changed/);
  },
);
