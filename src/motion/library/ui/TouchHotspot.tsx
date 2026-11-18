import React from "react";
import { z } from "zod";
import { AbsoluteFill, Freeze, useCurrentFrame } from "remotion";
import { SettingsList, type SettingsListProps } from "./SettingsList";
import { touchState, type Touch } from "./touch-math";

export { tapsFromCapture, touchCues } from "./touch-math";

const touchSchema = z.object({
  at: z.number().int().min(0),
  kind: z.enum(["tap", "long", "swipe"]),
  /** CSS pixels of the captured screen, as in capture.json. */
  x: z.number(),
  y: z.number(),
  /** Frames the finger stays down: about 5 for a tap, 20-30 for a long press, 10-16 for a swipe's travel. */
  hold: z.number().int().min(1),
  toX: z.number().optional(),
  toY: z.number().optional(),
});

export const touchHotspotSchema = z.object({
  touches: z.array(touchSchema),
  /** CSS pixels times this are stage pixels: `capture.json` `scale` inside `CameraRead` over the capture image; frame width over the capture's CSS width when the dots sit over a full-frame capture as an overlay. */
  scale: z.number().positive(),
  /** Dot diameter in CSS pixels; 44 matches the smallest comfortable touch target. */
  size: z.number().positive(),
  /** `light` draws a dark dot for light screens, `dark` a light dot for dark screens. */
  tone: z.enum(["light", "dark"]),
  /** "preview" draws a stand-in settings screen under the dots; "none" leaves them alone over the real capture (timeline overlays, scenes). */
  backdrop: z.enum(["preview", "none"]),
});

export type TouchHotspotProps = z.infer<typeof touchHotspotSchema>;

/** One flat tint per tone; the group carries the alpha, so a swipe's tail and the dot never double up where they meet. */
const DOT = {
  light: { fill: "#1C1C1E", alpha: 0.3 },
  dark: { fill: "#FFFFFF", alpha: 0.42 },
};

/**
 * Soft touch dots in the coordinates of their parent; put them inside `CameraRead` with the capture so zooms carry them.
 */
export const TouchHotspots: React.FC<TouchHotspotProps> = ({ touches, scale, size, tone }) => {
  const frame = useCurrentFrame();
  const d = size * scale;
  const { fill, alpha } = DOT[tone];
  return (
    <>
      {touches.map((touch, i) => {
        const s = touchState(frame, touch as Touch);
        if (!s) return null;
        const x = s.x * scale;
        const y = s.y * scale;
        const r = (d / 2) * s.scale;
        return (
          <svg
            key={i}
            width={1}
            height={1}
            style={{ position: "absolute", left: 0, top: 0, overflow: "visible", opacity: alpha * s.opacity }}
          >
            {s.tail ? (
              <>
                <defs>
                  <linearGradient
                    id={`touch-tail-${i}`}
                    gradientUnits="userSpaceOnUse"
                    x1={s.tail.x * scale}
                    y1={s.tail.y * scale}
                    x2={x}
                    y2={y}
                  >
                    <stop offset="0" stopColor={fill} stopOpacity={0} />
                    <stop offset="1" stopColor={fill} stopOpacity={1} />
                  </linearGradient>
                </defs>
                <line
                  x1={s.tail.x * scale}
                  y1={s.tail.y * scale}
                  x2={x}
                  y2={y}
                  stroke={`url(#touch-tail-${i})`}
                  strokeWidth={d * 0.55}
                  strokeLinecap="round"
                />
              </>
            ) : null}
            <circle cx={x} cy={y} r={r} fill={fill} />
          </svg>
        );
      })}
    </>
  );
};

const SCREEN: SettingsListProps = {
  tone: "light",
  accent: "#2F80ED",
  title: "Settings",
  sections: [
    {
      header: "Account",
      rows: [
        { icon: "users", title: "Profile", control: "chevron" },
        { icon: "lock", title: "Privacy", control: "chevron" },
        { icon: "bell", title: "Notifications", control: "toggle", on: true },
      ],
    },
    {
      header: "General",
      rows: [
        { icon: "home", title: "Language", value: "English", control: "chevron" },
        { icon: "calendar", title: "Week starts on", value: "Monday", control: "chevron" },
        { icon: "shield", title: "Two-step sign-in", control: "toggle", on: false },
      ],
    },
  ],
  start: 0,
  step: 0,
  flips: [],
};

/** The dots full-frame: over a stand-in settings screen (390 CSS px at 2.77x) with `backdrop: "preview"`, alone with "none". */
export const TouchHotspot: React.FC<TouchHotspotProps> = (props) => (
  <AbsoluteFill>
    {props.backdrop === "preview" ? (
      <Freeze frame={40}>
        <SettingsList {...SCREEN} />
      </Freeze>
    ) : null}
    <AbsoluteFill>
      <TouchHotspots {...props} />
    </AbsoluteFill>
  </AbsoluteFill>
);
