import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

/**
 * Install check for `pnpm bootstrap --smoke`: one second, no media, no fonts to
 * fetch, so a fresh clone can prove Chromium, the bundler and the encoder work.
 * Not a creative template.
 */
export function SetupSmoke() {
  const frame = useCurrentFrame();
  const { durationInFrames, width } = useVideoConfig();
  const progress = interpolate(frame, [0, durationInFrames - 1], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{ backgroundColor: "#0F0F0F", alignItems: "center", justifyContent: "center" }}>
      <div style={{ color: "#FFFFFF", fontFamily: "sans-serif", fontSize: 64, fontWeight: 700 }}>
        Agent Bros. Pictures
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          bottom: 120,
          height: 12,
          width: width * progress,
          backgroundColor: "#6C5CE7",
        }}
      />
    </AbsoluteFill>
  );
}
