import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { labelFont, numberFont } from "./kit";
import { unitTrayCount, type UnitTrayProps } from "./unit-tray-plan";

export function UnitTray(props: UnitTrayProps) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const { from, to, firstFrame, stepFrames, headline, unitLabel, shape, text, ground, accent } = props;
  const count = unitTrayCount(frame, props);
  const portrait = height > width;
  const capacity = Math.max(1, from, to);
  const columns = Math.min(portrait ? 6 : 8, Math.ceil(Math.sqrt(capacity * (portrait ? 1 : 1.5))));
  const rows = Math.ceil(capacity / columns);
  const pitch = Math.min((width * (portrait ? 0.76 : 0.46)) / columns, (height * 0.43) / rows);
  const unit = pitch * 0.72;
  const corner = shape === "disc" ? "50%" : Math.round(unit * 0.15);
  const pad = width * 0.075;
  return (
    <AbsoluteFill
      style={{
        backgroundColor: ground,
        color: text,
        fontFamily: labelFont,
        boxSizing: "border-box",
        display: "flex",
        flexDirection: portrait ? "column" : "row",
        justifyContent: "center",
        alignItems: portrait ? "stretch" : "center",
        // Vertical keeps the platform safe area (200 px top, 300 px bottom at 1920), as the shared template wrapper does.
        padding: portrait ? `${height * 0.105}px ${pad}px ${height * 0.157}px` : `${height * 0.075}px ${pad}px`,
        gap: portrait ? height * 0.045 : width * 0.06,
      }}
    >
      <div style={{ width: portrait ? "100%" : width * 0.29 }}>
        <div
          style={{
            fontSize: width * (portrait ? 0.057 : 0.037),
            fontWeight: 650,
            lineHeight: 1.04,
            textWrap: "balance",
          }}
        >
          {headline}
        </div>
        <div
          style={{
            marginTop: height * 0.02,
            fontSize: width * (portrait ? 0.145 : 0.092),
            fontFamily: numberFont,
            fontWeight: 720,
            fontVariantNumeric: "tabular-nums",
            lineHeight: 1,
            color: accent,
          }}
          aria-label={String(count)}
        >
          {count}
        </div>
        <div style={{ marginTop: height * 0.015, fontSize: width * (portrait ? 0.034 : 0.019), lineHeight: 1.2 }}>
          {unitLabel}
        </div>
      </div>
      <div style={{ position: "relative", alignSelf: "center", width: columns * pitch, height: rows * pitch }}>
        {Array.from({ length: count }, (_, i) => {
          const elapsed = i < from ? stepFrames : frame - (firstFrame + (i - from) * stepFrames);
          const offset = interpolate(elapsed, [0, stepFrames - 1], [-unit * 0.18, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.out(Easing.cubic),
          });
          return (
            <div
              key={i}
              data-counted-unit
              style={{
                position: "absolute",
                width: unit,
                height: unit,
                left: (i % columns) * pitch + (pitch - unit) / 2,
                top: Math.floor(i / columns) * pitch + (pitch - unit) / 2,
                transform: `translateY(${offset}px)`,
                borderRadius: corner,
                backgroundColor: accent,
                backgroundImage: "linear-gradient(155deg, #ffffff48, #00000010 49%, #00000030)",
                boxShadow: `inset 0 2px 1px #ffffff50, 0 ${unit * 0.06}px 0 #00000030, 0 ${unit * 0.1}px ${unit * 0.17}px #00000035`,
              }}
            />
          );
        })}
      </div>
    </AbsoluteFill>
  );
}
