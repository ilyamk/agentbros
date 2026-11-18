import React from "react";
import { Sequence, staticFile } from "remotion";
import { Audio } from "@remotion/media";
import type { SoundEvent } from "../../lib/audio/cue-sounds";

/**
 * Plays planned cue sounds (from `planCueSounds` or `sfx:cues`) on the film's own frames, so sound
 * cannot drift from the picture. Put it once at the film root; `master` scales every gain.
 */
export const CueSounds: React.FC<{ events: readonly SoundEvent[]; master?: number }> = ({ events, master = 1 }) => (
  <>
    {events.map((event) => (
      <Sequence
        key={event.id}
        from={event.startFrame}
        durationInFrames={event.durationInFrames}
        layout="none"
        name={`sfx ${event.sfx} ${event.label ?? event.blockId}`}
      >
        <Audio src={staticFile(event.file)} volume={event.gain * master} />
      </Sequence>
    ))}
  </>
);
