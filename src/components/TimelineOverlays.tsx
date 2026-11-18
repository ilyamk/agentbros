import React from "react";
import { AbsoluteFill, Sequence, useVideoConfig } from "remotion";
import { items as data } from "../motion/library/data";
import { items as kinetic } from "../motion/library/kinetic";
import { items as typography } from "../motion/library/typography";
import { items as ui } from "../motion/library/ui";
import type { LibraryItem } from "../motion/library/types";
import { overlayRenders } from "../lib/timeline-ir/overlays";
import type { Rational, TimelineOverlay } from "../types/timeline";

// The categories in OVERLAY_CATEGORIES; the full registry would pull 3D and effects into every timeline render.
const overlayBlocks: LibraryItem[] = [...typography, ...data, ...ui, ...kinetic];

const OverlayBlock: React.FC<{ block: string; props: Record<string, unknown> }> = ({ block, props }) => {
  const item = overlayBlocks.find((entry) => entry.id === block);
  if (!item) throw new Error(`Overlay block is not renderable over a picture: ${block}`);
  const Component = item.component;
  return <Component {...item.schema.parse({ ...item.defaultProps, ...props })} />;
};

/** One layer of library blocks over the picture; each block starts at its own frame 0, less any `offset` already played. */
export const TimelineOverlays: React.FC<{
  overlays: readonly TimelineOverlay[] | undefined;
  layer: TimelineOverlay["layer"];
  timebase: Rational;
}> = ({ overlays, layer, timebase }) => {
  const { fps } = useVideoConfig();
  const renders = overlayRenders(overlays, layer, timebase, fps);
  if (!renders.length) return null;
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {renders.map((overlay) => (
        <Sequence
          key={overlay.id}
          name={`overlay:${overlay.id}`}
          from={overlay.from}
          durationInFrames={overlay.durationInFrames}
        >
          <Sequence from={-overlay.offsetFrames}>
            <OverlayBlock block={overlay.block} props={overlay.props} />
          </Sequence>
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
