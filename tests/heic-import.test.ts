import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { heicPlan, isHeif, majorBrand } from "../src/lib/assets/heic";
import { importAsset, readAssetRegistry } from "../src/lib/assets/registry";

const ftyp = (brand: string) =>
  Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from(`ftyp${brand}`), Buffer.alloc(12)]);

function project(t: test.TestContext) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "heic-import-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const dir = path.join(rootDir, "public/projects/test-project");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "project.json"), "{}");
  return rootDir;
}

test("HEIF is recognised by its ftyp brand or extension, not by an MP4's brand", () => {
  assert.equal(majorBrand(ftyp("heic")), "heic");
  assert.equal(majorBrand(Buffer.from("not a media file")), null);
  assert.equal(isHeif("IMG_0001.JPG", "heic"), true);
  assert.equal(isHeif("photo.HEIC", null), true);
  assert.equal(isHeif("clip.mp4", "isom"), false);
  assert.equal(isHeif("clip.mov", "qt  "), false);
});

test("heicPlan: sips on macOS, ffmpeg where it decodes, otherwise a refusal naming the exact commands", () => {
  const base = { input: "/in/IMG_1.HEIC", output: "/out/IMG_1.jpg" };
  const sips = heicPlan({ ...base, platform: "darwin", hasSips: true, ffmpegDecodes: true });
  assert.equal(sips.action === "convert" && sips.tool, "sips");
  assert.deepEqual(sips.action === "convert" && sips.command.slice(0, 4), ["sips", "-s", "format", "jpeg"]);
  const ffmpeg = heicPlan({ ...base, platform: "linux", hasSips: false, ffmpegDecodes: true });
  assert.equal(ffmpeg.action === "convert" && ffmpeg.tool, "ffmpeg");
  assert.ok(ffmpeg.action === "convert" && ffmpeg.command.includes("/out/IMG_1.jpg"));
  const refused = heicPlan({ ...base, platform: "linux", hasSips: false, ffmpegDecodes: false });
  assert.equal(refused.action, "refuse");
  assert.match(
    refused.action === "refuse" ? refused.fix : "",
    /sips -s format jpeg "\/in\/IMG_1.HEIC" --out "\/out\/IMG_1.jpg"/,
  );
  assert.match(refused.action === "refuse" ? refused.fix : "", /heif-convert/);
});

test("importAsset refuses HEIC with the conversion command instead of an inspection error", (t) => {
  const rootDir = project(t);
  const file = path.join(rootDir, "IMG_0001.HEIC");
  writeFileSync(file, ftyp("heic"));
  assert.throws(
    () => importAsset({ rootDir, projectId: "test-project", sourceFile: file, provenance: { origin: "manual" } }),
    (error: unknown) => {
      const e = error as { code?: string; message: string; details?: { fix?: string } };
      return e.code === "VALIDATION" && /HEIC/.test(e.message) && /sips -s format jpeg/.test(e.details?.fix ?? "");
    },
  );
});

const hasSips = process.platform === "darwin" && spawnSync("sips", ["--help"]).status === 0;

test(
  "asset:import converts an iPhone-style HEIC to JPEG and keeps the original name",
  { skip: hasSips ? false : "needs macOS sips to make a HEIC fixture" },
  (t) => {
    const rootDir = project(t);
    const png = path.join(rootDir, "src.png"),
      heic = path.join(rootDir, "IMG_0002.HEIC");
    assert.equal(
      spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x480", "-frames:v", "1", png]).status,
      0,
    );
    assert.equal(spawnSync("sips", ["-s", "format", "heic", png, "--out", heic]).status, 0);
    const cli = path.resolve("scripts/import-asset.ts"),
      runner = path.resolve("node_modules/tsx/dist/cli.mjs");
    const result = spawnSync(process.execPath, [runner, cli, "--project", "test-project", "--input", heic], {
      cwd: rootDir,
      encoding: "utf8",
    });
    const envelope = JSON.parse(result.stdout.trim()) as {
      ok: boolean;
      metadata: {
        converted?: { tool: string };
        asset: {
          files: { mime: string };
          media: { width: number; height: number };
          provenance: { originalFilename: string; tool: string };
        };
      };
    };
    assert.equal(envelope.ok, true, result.stdout + result.stderr);
    assert.equal(envelope.metadata.converted?.tool, "sips");
    assert.equal(envelope.metadata.asset.files.mime, "image/jpeg");
    assert.deepEqual([envelope.metadata.asset.media.width, envelope.metadata.asset.media.height], [640, 480]);
    assert.equal(envelope.metadata.asset.provenance.originalFilename, "IMG_0002.HEIC");
    assert.equal(envelope.metadata.asset.provenance.tool, "heic-to-jpeg:sips");
    assert.equal(readAssetRegistry("test-project", rootDir).assets.length, 1);
  },
);
