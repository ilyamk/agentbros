import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { VisionEvent, VisionRequest } from "../../types/vision-review";
import { reviewHash, writeReviewPack } from "./review-pack";
import type { VideoInfo } from "./media";

export function attachVideoReview(
  input: string,
  parent: string,
  events: VisionEvent[] = [],
  settings: Partial<VisionRequest> = {},
  measurementOrigin?: "qa-evidence",
) {
  try {
    const result = writeReviewPack({ input, events, ...settings }, path.join(parent, `review-${randomUUID()}`), {
      measurementOrigin,
    });
    return { outputs: result.outputs, reviewPack: result.manifest, reviewWarnings: result.data.warnings };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      !/zero-origin CFR|Missing frame timestamps|Decoded frame count differs|whitelist|exceeds the bounded|aspect ratio cannot fit|Chromium missing/.test(
        message,
      )
    )
      throw error;
    return {
      outputs: [] as string[],
      reviewPack: undefined,
      reviewWarnings: [`Detailed review unavailable: ${message}`],
    };
  }
}

export function attachStillReview(
  stills: Array<{ frame: number; path: string }>,
  info: VideoInfo,
  parent: string,
  events: VisionEvent[] = [],
  identity: unknown = {},
) {
  const root = path.join(parent, `review-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const input = path.join(root, "composition-identity.json");
  writeFileSync(
    input,
    JSON.stringify({
      kind: "composition-stills",
      info,
      identity,
      events,
      frames: stills.map((f) => ({ frame: f.frame, sha256: reviewHash(f.path) })),
    }),
  );
  const numbers = stills.map((f) => f.frame).sort((a, b) => a - b);
  const result = writeReviewPack(
    {
      input,
      profile: "typography",
      count: 2,
      maxFrames: 300,
      startFrame: numbers[0],
      endFrame: numbers.at(-1),
      events: stills.map((f) => {
        const reasons = [
          ...new Set([
            "rendered composition still",
            ...events.filter((e) => e.frame === f.frame).flatMap((e) => e.reasons),
          ]),
        ];
        return {
          frame: f.frame,
          reasons:
            reasons.length <= 20
              ? reasons
              : [...reasons.slice(0, 19), `${reasons.length - 19} more reasons in the hash-bound source identity`],
          basis: "declared",
        };
      }),
    },
    path.join(root, "pack"),
    { stills: { info, identityFile: input, frames: stills } },
  );
  return { outputs: result.outputs, reviewPack: result.manifest };
}
