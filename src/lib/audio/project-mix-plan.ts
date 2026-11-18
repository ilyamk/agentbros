import path from "node:path";
import { existsSync } from "node:fs";
import { attenuateAudio } from "./clip-gain";
import { compileTimelineIR } from "../timeline-ir/compiler";
import { numeric } from "../timeline-ir/rational";
import { AudioMixSchema, type AudioMix } from "../../types/pipeline";
import { LocalAudioMixSchema } from "../../types/audio-master";
import type { ProjectVideoProps } from "../project-props";
import { readLocalJson } from "./local-input";
import { assertPathWithin } from "../cli";

export function readProjectAudioAutomation(projectId: string, rootDir: string) {
  const file = path.join(rootDir, "public/projects", projectId, "pipeline/audio-mix.json");
  return existsSync(file) ? AudioMixSchema.parse(readLocalJson(file)) : undefined;
}
/** Pure plan from resolved inputs; no render planning or source file reads. */
export function buildProjectAudioMix(
  props: ProjectVideoProps,
  durationInFrames: number,
  rootDir: string,
  automation?: AudioMix,
) {
  if (!props.timeline) throw new Error("Project mixer requires an initialized timeline journal");
  const ir = props.timeline,
    snapshot = compileTimelineIR(ir);
  const tracks = snapshot.tracks.flatMap((track) => {
    if (!["voiceover", "music", "sfx", "presenter"].includes(track.kind)) return [];
    if (track.kind === "presenter" && props.talkingHead?.audioSource !== "embedded") return [];
    const role = track.kind === "presenter" || track.kind === "voiceover" ? "speech" : (track.kind as "music" | "sfx");
    const direction = automation?.tracks.find((t) => t.track === (role === "speech" ? "voiceover" : role));
    return track.clips
      .filter((clip) => clip.payload?.speechMuted !== true)
      .map((clip) => {
        const asset = props.timelineAssets?.[clip.assetId];
        if (!asset) throw new Error(`Unresolved mixer asset: ${clip.assetId}`);
        if (/^https?:\/\//.test(asset.source)) throw new Error("Local mixer requires downloaded local media");
        const publicDir = path.resolve(rootDir, "public"),
          source = path.resolve(publicDir, asset.source);
        // Timeline assets are editable project data: keep the mixer input under public/.
        assertPathWithin(publicDir, source);
        return {
          source,
          role,
          startSec: numeric(clip.start) / numeric(ir.timebase),
          sourceStartSec: numeric(clip.source.start) / numeric(clip.source.timebase),
          sourceEndSec: numeric(clip.source.end) / numeric(clip.source.timebase),
          rate: numeric(clip.rate),
          volume: attenuateAudio(
            clip.payload,
            typeof clip.payload?.volume === "number"
              ? clip.payload.volume
              : (direction?.baseVolume ?? (role === "music" ? props.musicVolume : 1)),
          ),
          keyframes: (direction?.keyframes ?? []).map((k) => ({
            ...k,
            volume: attenuateAudio(clip.payload, k.volume),
          })),
          loop: clip.payload?.loop === true,
          allowSpeechTrim: track.kind === "presenter" || clip.payload?.allowSpeechTrim === true,
        };
      });
  });
  return LocalAudioMixSchema.parse({
    version: 1,
    durationSec: durationInFrames / 30,
    tracks,
  });
}
