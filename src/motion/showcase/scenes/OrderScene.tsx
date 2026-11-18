import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { cyrillicGroteskFont } from "../../../lib/fonts-cyrillic";
import { RegionCamera } from "../../camera";
import { regionTransform } from "../../camera-math";
import { Cursor, ScreenPlayback, WindowFrame } from "../../ui";
import { BUY_BUTTON, BUY_CLICK, ORDER_CURSOR_KEYS, ORDER_STAGE, PLUS_CLICKS } from "../capture/order-script";
import { roast } from "../palette";

const TITLE_BAR = 44;
const ORIGIN = { x: (1920 - ORDER_STAGE.width) / 2, y: (1080 - ORDER_STAGE.height - TITLE_BAR) / 2 };

const ZOOM_KEYS = [
  { at: 0, x: 0, y: 0, width: 1600 },
  { at: 34, x: 0, y: 30, width: 1480, curve: "linear" as const },
  { at: 62, x: 700, y: 195, width: 900, curve: "drift" as const },
  { at: 126, x: 700, y: 195, width: 900 },
  { at: 150, x: 700, y: 350, width: 900, curve: "drift" as const },
];

const settled = regionTransform(ZOOM_KEYS.at(-1)!.at, ZOOM_KEYS, ORDER_STAGE);
/** Where the buy button sits on the frame once the camera has settled: the next wipe opens from there. */
export const ORDER_WIPE_POINT = {
  x: ORIGIN.x + settled.x + BUY_BUTTON.x * settled.scale,
  y: ORIGIN.y + TITLE_BAR + settled.y + BUY_BUTTON.y * settled.scale,
};

/** A real page recorded with a real mouse, so the state changes are its own; the camera takes the viewer to what must be read. */
export const OrderScene: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ backgroundColor: roast }}>
      <div style={{ position: "absolute", left: ORIGIN.x, top: ORIGIN.y }}>
        <WindowFrame
          width={ORDER_STAGE.width}
          height={ORDER_STAGE.height + TITLE_BAR}
          title="Четверг: заказ"
          fontFamily={cyrillicGroteskFont}
          tone="light"
        >
          <RegionCamera stage={ORDER_STAGE} frame={frame} keys={ZOOM_KEYS}>
            <ScreenPlayback kind="video" src="motion-lab/showcase/order-capture.mp4" />
            <Cursor keys={ORDER_CURSOR_KEYS} clicks={[...PLUS_CLICKS, BUY_CLICK]} size={30} pulseColor="#17110B" />
          </RegionCamera>
        </WindowFrame>
      </div>
    </AbsoluteFill>
  );
};
