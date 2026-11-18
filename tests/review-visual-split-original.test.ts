import test from "node:test";
import assert from "node:assert/strict";
import fs, {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  openSync,
  ftruncateSync,
  closeSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { assertSplitOriginal } from "../src/lib/review-ui/split-original";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex"),
  crc32 = (bytes: Buffer) => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "static-split-")),
    png = path.join(root, "static.png"),
    jpg = path.join(root, "static.jpg");
  for (const file of [png, jpg])
    execFileSync(
      "ffmpeg",
      ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:size=64x64", "-frames:v", "1", "-threads", "1", file],
      { timeout: 10000 },
    );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, png, jpg };
}
test("bounded hash-checked static PNG and JPEG originals are read without mutation", (t) => {
  const f = fixture(t);
  for (const file of [f.png, f.jpg]) {
    const before = readFileSync(file);
    assert.doesNotThrow(() => assertSplitOriginal(file, sha(before), "image"));
    assert.deepEqual(readFileSync(file), before);
  }
  const video = path.join(f.root, "video.mp4");
  writeFileSync(video, "Descriptor format is checked by existing render decoder, not this SHA guard");
  assert.doesNotThrow(() => assertSplitOriginal(video, sha(readFileSync(video)), "video"));
});
test("coherent APNG/unknown/extension-spoof/malformed bytes reject without reinterpretation or source mutation", (t) => {
  const f = fixture(t),
    original = readFileSync(f.png),
    chunk = Buffer.alloc(20);
  chunk.writeUInt32BE(8, 0);
  chunk.write("acTL", 4);
  chunk.writeUInt32BE(2, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 16)), 16);
  const bad = [
    {
      file: "animated.png",
      bytes: Buffer.concat([original.subarray(0, 33), chunk, original.subarray(33)]),
      match: /Animated PNG/,
    },
    { file: "spoof.jpg", bytes: original, match: /JPEG signature/ },
    { file: "unknown.webp", bytes: original, match: /static PNG\/JPEG/ },
    { file: "unknown.gif", bytes: Buffer.from("GIF89a"), match: /static PNG\/JPEG/ },
    { file: "broken.png", bytes: original.subarray(0, -5), match: /Malformed/ },
    { file: "trailing.png", bytes: Buffer.concat([original, Buffer.from("extra")]), match: /Malformed/ },
    { file: "broken.jpg", bytes: Buffer.from([255, 216, 255]), match: /JPEG signature/ },
  ];
  const corrupt = Buffer.from(original);
  corrupt[45] ^= 1;
  bad.push({ file: "bad-crc.png", bytes: corrupt, match: /Malformed/ });
  for (const row of bad) {
    const file = path.join(f.root, row.file);
    writeFileSync(file, row.bytes);
    assert.throws(() => assertSplitOriginal(file, sha(row.bytes), "image"), row.match);
    assert.deepEqual(readFileSync(file), row.bytes);
  }
});
test("corrupt immutable original, final symlink and FIFO reject before blocking", (t) => {
  const f = fixture(t),
    bytes = readFileSync(f.png),
    corrupt = Buffer.from(bytes);
  corrupt[45] ^= 1;
  writeFileSync(f.png, corrupt);
  assert.throws(() => assertSplitOriginal(f.png, sha(bytes), "image"), /checksum mismatch/);
  const link = path.join(f.root, "link.jpg");
  symlinkSync(f.jpg, link);
  assert.throws(() => assertSplitOriginal(link, sha(readFileSync(f.jpg)), "image"), /symlink/);
  const fifo = path.join(f.root, "fifo.png");
  execFileSync("mkfifo", [fifo], { timeout: 5000 });
  const start = Date.now();
  assert.throws(() => assertSplitOriginal(fifo, "0".repeat(64), "image"), /regular file/);
  assert.ok(Date.now() - start < 1000);
});
test("sparse128MiB+1 original rejects before any read or allocation", (t) => {
  const f = fixture(t),
    file = path.join(f.root, "huge.png"),
    fd = openSync(file, "w");
  ftruncateSync(fd, 128 * 1024 * 1024 + 1);
  closeSync(fd);
  const original = fs.readSync;
  let reads = 0;
  fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
    reads++;
    return (original as Function)(...args);
  }) as typeof fs.readSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => assertSplitOriginal(file, "0".repeat(64), "image"), /within128MiB/);
    assert.equal(reads, 0);
  } finally {
    fs.readSync = original;
    syncBuiltinESMExports();
  }
});
