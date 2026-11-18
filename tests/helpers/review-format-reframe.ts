import { deflateSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { AssetRecordSchema } from "../../src/types/assets";
import { chapterFixture } from "./review-chapters";
/** Asymmetric RGB originals made from actual pixels, no native tool/inference. */
export function reframePng(width = 12, height = 8) {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length);
    body.copy(out, 4);
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      pixels[offset] = x < width / 3 ? 255 : 0;
      pixels[offset + 1] = x >= width / 3 && x < (2 * width) / 3 ? 255 : 0;
      pixels[offset + 2] = y < height / 2 ? 100 : 255;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
export function reframeFixture(video = false) {
  const f = chapterFixture(),
    data = video ? Buffer.from([0, 0, 0, 12, 102, 116, 121, 112, 105, 115, 111, 109]) : reframePng(),
    sha = createHash("sha256").update(data).digest("hex");
  const file = path.join(f.project, "assets/imported", sha + (video ? ".mp4" : ".png"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  const asset = AssetRecordSchema.parse({
    schemaVersion: 1,
    id: "sha256:" + sha,
    hash: sha,
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    kind: video ? "video" : "image",
    files: {
      original: "projects/demo/assets/imported/" + path.basename(file),
      bytes: data.length,
      mime: video ? "video/mp4" : "image/png",
    },
    media: {
      width: 12,
      height: 8,
      codec: video ? "h264" : "png",
      hasAudio: false,
      ...(video ? { durationSec: 3, frameRate: "30/1", timebase: "1/30" } : {}),
    },
    provenance: { origin: "manual" },
    rights: { licence: "synthetic-test" },
    status: "candidate",
  });
  const registryFile = path.join(f.project, "pipeline/asset-registry.json");
  fs.writeFileSync(registryFile, JSON.stringify({ schemaVersion: 1, revision: 1, assets: [asset] }));
  const document = f.store.read(),
    clip = document.timeline.tracks[0].clips[0];
  clip.assetId = asset.id;
  clip.payload = { originalHash: sha };
  fs.writeFileSync(f.store.file, JSON.stringify(document));
  return { ...f, file, asset, registryFile, ir: document.timeline };
}
