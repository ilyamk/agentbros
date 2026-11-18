import React from "react";
import { AbsoluteFill, Freeze, useCurrentFrame, useVideoConfig } from "remotion";
import { Video } from "@remotion/media";
import { z } from "zod";
import { plateSchema, plateSource, renderPlateFrame } from "./plate-plan";
import { PlateLayer } from "./PlateLayer";
import { resolveAsset } from "./shared";

export const renderPlateSchema = z.object({
  plate: plateSchema,
  sourceFps: z.number().positive(),
  background: z.string(),
});
/** Offline vector preview only; actual shots pass an imported render or RGBA sequence. */
export const renderPlatePreview =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080"><defs><linearGradient id="metal"><stop stop-color="#173e48"/><stop offset=".5" stop-color="#92d5ce"/><stop offset="1" stop-color="#97673e"/></linearGradient></defs><ellipse cx="540" cy="800" rx="275" ry="60" fill="#091118"/><path d="M330 740 420 300 Q540 230 660 300L750 740Q540 860 330 740Z" fill="url(#metal)"/><ellipse cx="540" cy="300" rx="120" ry="32" fill="#173e48"/></svg>',
  );
export const RenderPlate: React.FC<z.infer<typeof renderPlateSchema>> = ({ plate, sourceFps, background }) => {
  const frame = useCurrentFrame(),
    { fps } = useVideoConfig();
  const mapped = renderPlateFrame(frame, sourceFps, fps, plate.at),
    shifted = { ...plate, at: 0 },
    source = plateSource(mapped, shifted);
  if (source.kind === "video")
    return (
      <AbsoluteFill style={{ background }}>
        <Freeze frame={source.frame}>
          <Video
            src={resolveAsset(source.src)}
            playbackRate={fps / sourceFps}
            style={{ width: "100%", height: "100%", objectFit: plate.fit ?? "cover" }}
            muted
          />
        </Freeze>
      </AbsoluteFill>
    );
  return (
    <Freeze frame={mapped}>
      <PlateLayer plate={shifted} background={background} />
    </Freeze>
  );
};
