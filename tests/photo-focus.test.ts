import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { modelRoot } from "../src/lib/multicam/models";
import { sha256File } from "../src/lib/multicam/media";
import { buildFocus, CANVAS, listPhotos, staticName, unpad } from "../src/lib/photo/focus";

const repo = path.resolve(import.meta.dirname, "..");
const runner = path.join(repo, "node_modules/tsx/dist/cli.mjs");

function temp(t: test.TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), "photo-focus-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const ffmpeg = (args: string[]) => {
  const result = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
};

/** A JPEG with an EXIF APP1 segment saying "rotate 90° clockwise to display" (orientation 6), as phones write. */
function withOrientation6(jpeg: Buffer): Buffer {
  const tiff = Buffer.from([
    0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

test("listPhotos: a folder in name order, HEIC set aside with the fix, a missing file refused", (t) => {
  const dir = temp(t);
  writeFileSync(path.join(dir, "b.jpg"), "x");
  writeFileSync(path.join(dir, "a.png"), "x");
  writeFileSync(path.join(dir, "notes.txt"), "x");
  writeFileSync(
    path.join(dir, "IMG_1.HEIC"),
    Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(12)]),
  );
  const listed = listPhotos(dir);
  assert.deepEqual(
    listed.photos.map((p) => path.basename(p)),
    ["a.png", "b.jpg"],
  );
  assert.equal(listed.skipped.length, 1);
  assert.match(listed.skipped[0]!.reason, /asset:import/);
  assert.throws(
    () => listPhotos(`${path.join(dir, "a.png")},${path.join(dir, "gone.jpg")}`),
    (e: { code?: string }) => e.code === "FILE_NOT_FOUND",
  );
});

test("buildFocus: neighbours alternate in and out, src is the staticFile name, subjects are classified", () => {
  const root = "/repo";
  const face = { x: 0.45, y: 0.3, w: 0.1, h: 0.12, score: 0.9 };
  const photos = buildFocus(
    [
      { file: "/repo/public/projects/p/assets/a.jpg", width: 4000, height: 3000, faces: [face], people: [] },
      {
        file: "/elsewhere/b.jpg",
        width: 3000,
        height: 4000,
        faces: [],
        people: [{ x: 0.2, y: 0.2, w: 0.3, h: 0.6, score: 0.7 }],
      },
      { file: "/repo/public/c.jpg", width: 2000, height: 2000, faces: [], people: [] },
    ],
    { formats: ["vertical", "landscape"], durationSec: 4, easing: "linear", minSpeed: 0.02, root, alternate: true },
  );
  assert.equal(photos[0]!.src, "projects/p/assets/a.jpg");
  assert.equal(photos[1]!.src, undefined);
  assert.deepEqual(
    photos.map((p) => p.subject),
    ["faces", "people", "none"],
  );
  assert.deepEqual(
    photos.map((p) => p.orientation),
    ["landscape", "portrait", "square"],
  );
  assert.deepEqual(
    photos.map((p) => p.formats.vertical!.direction),
    ["in", "out", "in"],
  );
  assert.ok(photos[0]!.formats.vertical!.to.w < photos[0]!.formats.vertical!.from.w);
  assert.ok(photos[1]!.formats.vertical!.to.w > photos[1]!.formats.vertical!.from.w);
  assert.equal(staticName("/repo/public", root), undefined);
});

test("unpad: canvas boxes return to the photo; slivers from the padding are dropped", () => {
  const [box, ...rest] = unpad(
    [
      { x: 0.25, y: 0.25, w: 0.1, h: 0.1, score: 0.91234 },
      { x: 0.1, y: 0.6, w: 0.1, h: 0.1, score: 0.6 },
    ],
    CANVAS,
    640,
  );
  assert.deepEqual(box, { x: 0.25, y: 0.5, w: 0.1, h: 0.2, score: 0.912 });
  assert.equal(rest.length, 0);
});

test("photo:focus --detect off: displayed size honours EXIF orientation and each format gets a moving crop", (t) => {
  const dir = temp(t);
  const plain = path.join(dir, "plain.jpg"),
    wide = path.join(dir, "wide.jpg");
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=1600x1200", "-frames:v", "1", "-update", "1", plain]);
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=2400x1000", "-frames:v", "1", "-update", "1", wide]);
  writeFileSync(path.join(dir, "turned.jpg"), withOrientation6(readFileSync(plain)));
  const output = path.join(dir, "focus.json");
  const result = spawnSync(
    process.execPath,
    [
      runner,
      path.join(repo, "scripts/photo-focus.ts"),
      "--input",
      dir,
      "--output",
      output,
      "--detect",
      "off",
      "--formats",
      "vertical,landscape",
    ],
    { encoding: "utf8", cwd: repo, timeout: 120000 },
  );
  const envelope = JSON.parse(result.stdout.trim()) as { ok: boolean; metadata: { photos: number } };
  assert.equal(envelope.ok, true, result.stdout + result.stderr);
  const focus = JSON.parse(readFileSync(output, "utf8")) as {
    detector: string;
    photos: {
      file: string;
      width: number;
      height: number;
      orientation: string;
      formats: Record<string, { ratePerSec: number; fill: string; from: { w: number } }>;
    }[];
  };
  assert.equal(focus.detector, "off");
  const byName = Object.fromEntries(focus.photos.map((p) => [path.basename(p.file), p]));
  assert.deepEqual([byName["plain.jpg"]!.width, byName["plain.jpg"]!.height], [1600, 1200]);
  assert.deepEqual(
    [byName["turned.jpg"]!.width, byName["turned.jpg"]!.height, byName["turned.jpg"]!.orientation],
    [1200, 1600, "portrait"],
  );
  for (const photo of focus.photos)
    for (const [format, s] of Object.entries(photo.formats))
      assert.ok(s.ratePerSec >= 0.02 && s.fill === "cover", `${photo.file} ${format}`);
});

test("photo:focus refuses an unknown format", (t) => {
  const dir = temp(t);
  ffmpeg(["-f", "lavfi", "-i", "color=c=gray:s=64x48", "-frames:v", "1", "-update", "1", path.join(dir, "a.jpg")]);
  const result = spawnSync(
    process.execPath,
    [
      runner,
      path.join(repo, "scripts/photo-focus.ts"),
      "--input",
      dir,
      "--output",
      path.join(dir, "f.json"),
      "--detect",
      "off",
      "--formats",
      "portrait",
    ],
    { encoding: "utf8", cwd: repo },
  );
  const envelope = JSON.parse(result.stdout.trim()) as { ok: boolean; error?: { code?: string } | string };
  assert.equal(envelope.ok, false);
  assert.notEqual(result.status, 0);
});

const PORTRAIT_SHA = "f5e79a35f74b54e0435dfc87f5956d6917725e2f5b8c17932ecf5bad704e29b2";
const modelGate = {
  skip:
    process.env.RUN_REFRAME_MODEL_TESTS === "1"
      ? false
      : "set RUN_REFRAME_MODEL_TESTS=1 (YuNet and the public-domain portrait cached by tests/reframe-track.test.ts)",
  timeout: 900000,
} as const;

test(
  "real detector: photo:focus finds the face in a portrait and in the same portrait set off-centre in a wide photo",
  modelGate,
  (t) => {
    const portrait = path.join(modelRoot(), "reframe", "portrait-lincoln-o77.jpg");
    if (!existsSync(portrait))
      return t.skip("run tests/reframe-track.test.ts with RUN_REFRAME_MODEL_TESTS=1 first; it downloads the portrait");
    assert.equal(sha256File(portrait), PORTRAIT_SHA);
    const dir = temp(t);
    mkdirSync(path.join(dir, "in"));
    ffmpeg(["-i", portrait, "-vf", "scale=-2:900", "-update", "1", path.join(dir, "in", "a-portrait.jpg")]);
    ffmpeg([
      "-i",
      portrait,
      "-vf",
      "scale=-2:900,pad=iw*3:ih:iw*2:0:0x808080",
      "-update",
      "1",
      path.join(dir, "in", "b-wide.jpg"),
    ]);
    const output = path.join(dir, "focus.json");
    const result = spawnSync(
      process.execPath,
      [runner, path.join(repo, "scripts/photo-focus.ts"), "--input", path.join(dir, "in"), "--output", output],
      { encoding: "utf8", cwd: repo, timeout: 900000 },
    );
    assert.equal((JSON.parse(result.stdout.trim()) as { ok: boolean }).ok, true, result.stdout + result.stderr);
    const focus = JSON.parse(readFileSync(output, "utf8")) as {
      photos: {
        faces: { x: number; y: number; w: number; h: number }[];
        formats: Record<
          string,
          { from: { x: number; y: number; w: number; h: number }; to: { x: number; y: number; w: number; h: number } }
        >;
      }[];
    };
    const [single, wide] = focus.photos;
    assert.equal(single!.faces.length, 1);
    assert.equal(wide!.faces.length, 1);
    assert.ok(wide!.faces[0]!.x > 2 / 3, `face sits in the right third: ${JSON.stringify(wide!.faces[0])}`);
    for (const photo of focus.photos) {
      const face = photo.faces[0]!;
      for (const s of Object.values(photo.formats))
        for (const crop of [s.from, s.to])
          assert.ok(
            face.x >= crop.x - 1e-3 &&
              face.x + face.w <= crop.x + crop.w + 1e-3 &&
              face.y >= crop.y - 1e-3 &&
              face.y + face.h <= crop.y + crop.h + 1e-3,
            JSON.stringify({ face, crop }),
          );
    }
  },
);
