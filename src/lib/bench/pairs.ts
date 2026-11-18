import { spawnSync } from "node:child_process";
import { BenchPacketSchema, type BenchPacket } from "../../types/bench";
import { digest, fail, seeded } from "./io";

export interface Candidate {
  id: string;
  task: string;
  stills: Buffer[];
  technical: BenchPacket["left"]["technical"];
}
/** Decode/re-encode locally: no embedded metadata, audio, filename or candidate labels. */
export function cleanStill(bytes: Buffer): string {
  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "pipe",
      "-f",
      "image2pipe",
      "-i",
      "pipe:0",
      "-frames:v",
      "1",
      "-map_metadata",
      "-1",
      "-vf",
      "scale=960:960:force_original_aspect_ratio=decrease",
      "-f",
      "image2pipe",
      "-c:v",
      "png",
      "pipe:1",
    ],
    { input: bytes, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.status !== 0 || !result.stdout.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    fail("Could not sanitise picture still");
  return `data:image/png;base64,${result.stdout.toString("base64")}`;
}
export function makePackets(candidates: Candidate[], seed: number) {
  if (!Number.isInteger(seed)) fail("Packet seed must be an integer");
  if (
    candidates.length < 2 ||
    new Set(candidates.map((item) => item.task)).size !== 1 ||
    new Set(candidates.map((item) => item.id)).size !== candidates.length
  )
    fail("Pairs require distinct candidates within exactly one task");
  const rng = seeded(seed),
    mapping: Record<string, string> = {};
  const pictures = candidates.map((candidate) => {
    const key = digest(`${rng()}:${candidate.id}`).slice(0, 16);
    mapping[key] = candidate.id;
    return { key, stills: candidate.stills.map(cleanStill), technical: candidate.technical };
  });
  const packets: BenchPacket[] = [];
  pictures.forEach((left, i) =>
    pictures.slice(i + 1).forEach((right) => {
      const id = `pair-${packets.length / 2 + 1}`;
      packets.push(
        BenchPacketSchema.parse({
          version: 1,
          protocolVersion: 1,
          task: candidates[0]!.task,
          id: `${id}-ab`,
          modality: "picture",
          left,
          right,
        }),
        BenchPacketSchema.parse({
          version: 1,
          protocolVersion: 1,
          task: candidates[0]!.task,
          id: `${id}-ba`,
          modality: "picture",
          left: right,
          right: left,
        }),
      );
    }),
  );
  for (let i = packets.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [packets[i], packets[j]] = [packets[j]!, packets[i]!];
  }
  return { packets, mapping };
}
