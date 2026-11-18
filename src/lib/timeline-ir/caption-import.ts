import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { TimelineIR } from "../../types/timeline";
import { add, fraction } from "./rational";

/** Import once at journal initialization; later edits own the caption document. */
export function importLegacyCaptions(ir: TimelineIR, projectDirectory: string): TimelineIR {
  const result = structuredClone(ir);
  const captionOwner = result.tracks.some((track) => track.kind === "voiceover") ? "voiceover" : "presenter";
  for (const track of result.tracks.filter((track) => track.kind === captionOwner))
    for (const clip of track.clips) {
      const base = path.join(projectDirectory, "voiceover", clip.id);
      const file = [base + ".words.edited.json", base + ".words.json"].find(existsSync);
      if (!file) continue;
      const raw = JSON.parse(readFileSync(file, "utf8")) as {
        words: {
          text: string;
          start: number;
          end: number;
          emphasis?: boolean;
        }[];
      };
      if (!Array.isArray(raw.words)) throw new Error(`Invalid caption file: ${file}`);
      clip.captions = raw.words.map((word, index) => {
        if (typeof word.text !== "string" || !Number.isFinite(word.start) || !Number.isFinite(word.end))
          throw new Error(`Invalid caption word: ${file}`);
        // Legacy timestamps are seconds. Convert to microsecond precision once,
        // then retain exact rational source-frame mapping through every edit.
        const toFrames = (seconds: number) =>
          fraction(
            BigInt(Math.round(seconds * 1_000_000)) * BigInt(clip.source.timebase.num),
            1_000_000n * BigInt(clip.source.timebase.den),
          );
        return {
          id: `${clip.id}:${index}`,
          text: word.text,
          start: add(clip.source.start, toFrames(word.start)),
          end: add(clip.source.start, toFrames(word.end)),
          emphasis: word.emphasis,
        };
      });
    }
  return result;
}
