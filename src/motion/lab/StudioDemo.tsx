import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { cyrillicGroteskFont } from "../../lib/fonts-cyrillic";
import { RegionCamera } from "../camera";
import { regionTransform } from "../camera-math";
import { MaskedLine } from "../text";
import { progress } from "../timing";
import { Cursor, ScreenPlayback, WindowFrame } from "../ui";
import { ink, paper } from "./palette";

const TITLE_BAR = 44;
const SCREEN = { width: 1500, height: 848 };
const ORIGIN = { x: (1920 - SCREEN.width) / 2, y: 38 };
/** The capture is 1832 x 1036 CSS pixels; the Render button sits at (1762, 761) in them. */
const CAPTURE_SCALE = SCREEN.width / 1832;
const RENDER = { x: 1762 * CAPTURE_SCALE, y: 761 * CAPTURE_SCALE };
const POINTER = { x: RENDER.x - 28, y: RENDER.y + 2 };
const ZOOM = { x: SCREEN.width - 640, y: RENDER.y - 262, width: 640 };

const ZOOM_KEYS = [
  { at: 24, x: 0, y: 0, width: SCREEN.width },
  { at: 78, ...ZOOM, curve: "drift" as const },
];

export const STUDIO_CLICK_FRAME = 104;

const settled = regionTransform(ZOOM_KEYS[1]!.at, ZOOM_KEYS, SCREEN);
/** Where the click lands on the frame once the zoom has settled: the next wipe opens from exactly here. */
export const STUDIO_CLICK_POINT = {
  x: ORIGIN.x + settled.x + POINTER.x * settled.scale,
  y: ORIGIN.y + TITLE_BAR + settled.y + POINTER.y * settled.scale,
};

type StudioDemoProps = { source?: "recording" | "screenshot" };

/** A real Remotion Studio capture, not a mock-up: the camera moves to the action and the cursor presses the real button. */
export const StudioDemo: React.FC<StudioDemoProps> = ({ source = "recording" }) => {
  const frame = useCurrentFrame();
  const enter = progress(frame, 0, 18);
  const caption = progress(frame, 58, 20);
  return (
    <AbsoluteFill style={{ backgroundColor: paper, color: ink }}>
      <div
        style={{
          position: "absolute",
          left: ORIGIN.x,
          top: ORIGIN.y,
          transform: `scale(${0.97 + 0.03 * enter})`,
          transformOrigin: "50% 100%",
        }}
      >
        <WindowFrame
          width={SCREEN.width}
          height={SCREEN.height + TITLE_BAR}
          title="Remotion Studio"
          fontFamily={cyrillicGroteskFont}
        >
          <RegionCamera stage={SCREEN} frame={frame} keys={ZOOM_KEYS}>
            {source === "recording" ? (
              <ScreenPlayback kind="video" src="motion-lab/studio-recording.mp4" playbackRate={0.8} />
            ) : (
              <ScreenPlayback kind="image" src="motion-lab/studio.png" />
            )}
            <Cursor
              keys={[
                { at: 20, x: SCREEN.width * 0.62, y: SCREEN.height * 0.46 },
                { at: 96, ...POINTER, curve: "drift" },
              ]}
              clicks={[STUDIO_CLICK_FRAME]}
              size={24}
              pulseColor="#FFFFFF"
            />
          </RegionCamera>
        </WindowFrame>
      </div>
      <div
        style={{
          position: "absolute",
          left: ORIGIN.x,
          bottom: 40,
          fontFamily: cyrillicGroteskFont,
          fontWeight: 600,
          fontSize: 72,
          letterSpacing: "-0.03em",
        }}
      >
        <MaskedLine reveal={caption} lineHeight={1.02}>
          Настоящий интерфейс, не макет
        </MaskedLine>
      </div>
    </AbsoluteFill>
  );
};
