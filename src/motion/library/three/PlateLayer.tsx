import React from "react";
import { Video } from "@remotion/media";
import { AbsoluteFill, Freeze, Img, useCurrentFrame } from "remotion";
import { plateSource, type Plate } from "./plate-plan";
import { resolveAsset } from "./shared";

/**
 * A Blender plate as a full-frame layer: a frame pattern or a video, frozen on the file for the block frame
 * (`plateSource`), so it stays frame-exact in any render order. Blocks with a Blender route render this instead of their
 * browser drawing when they get a `plate`; anything they lay on top (type, overlays) stays theirs.
 */
export const PlateLayer: React.FC<{ plate: Plate; background?: string; children?: React.ReactNode }> = ({
  plate,
  background,
  children,
}) => {
  const frame = useCurrentFrame();
  const source = plateSource(frame, plate);
  const style: React.CSSProperties = { width: "100%", height: "100%", objectFit: plate.fit ?? "cover" };
  return (
    <AbsoluteFill style={{ background }}>
      {source.kind === "video" ? (
        <Freeze frame={source.frame}>
          <Video src={resolveAsset(source.src)} style={style} muted />
        </Freeze>
      ) : (
        <Img src={resolveAsset(source.src)} style={style} />
      )}
      {children}
    </AbsoluteFill>
  );
};
