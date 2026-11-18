import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, Img } from "remotion";
import type { LeftPanel } from "../../types/video";
import { useEntranceStyle } from "./_entrance";
import { primaryFont } from "../../lib/fonts";

type Props = Extract<LeftPanel, { kind: "tweet" }>;

const PADDING = 60;

function VerifiedIcon() {
  return (
    <svg
      width={28}
      height={28}
      viewBox="0 0 24 24"
      fill="#1D9BF0"
      style={{ display: "inline-block", verticalAlign: "middle", marginLeft: 8 }}
    >
      <path d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.4-.46-2.91-.2-3.92.81s-1.26 2.52-.8 3.91C1.63 9.33.75 10.57.75 12s.88 2.67 2.19 3.34c-.46 1.39-.2 2.9.81 3.91s2.52 1.27 3.91.81c.66 1.31 1.91 2.19 3.34 2.19s2.67-.88 3.33-2.19c1.4.46 2.91.2 3.92-.81s1.26-2.52.8-3.91c1.32-.67 2.2-1.91 2.2-3.34zm-11.75 4.2-3.79-3.77 1.48-1.48 2.31 2.28 4.88-4.86 1.48 1.48-6.36 6.35z" />
    </svg>
  );
}

export const TweetCard: React.FC<Props> = ({
  author,
  handle,
  avatarUrl,
  text,
  verified,
  darkMode,
  entrance = "fade",
  kind: _kind,
  caption: _caption,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const entranceStyle = useEntranceStyle(frame, fps, entrance);

  const bg = darkMode ? "#000000" : "#FFFFFF";
  const textColor = darkMode ? "#FFFFFF" : "#0F1419";
  const secondaryColor = darkMode ? "#71767B" : "#536471";
  const borderColor = darkMode ? "#2F3336" : "#EFF3F4";

  const avatarBg = "#6C5CE7";
  const avatarLetter = author.charAt(0).toUpperCase();

  return (
    <AbsoluteFill
      style={{
        background: bg,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        ...entranceStyle,
      }}
    >
      <div
        style={{
          width: `calc(100% - ${PADDING * 2}px)`,
          padding: PADDING,
          background: bg,
          borderRadius: 16,
          border: `1px solid ${borderColor}`,
          fontFamily: primaryFont,
        }}
      >
        {/* Top row: avatar + name/handle column + subscribe pill */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
          {/* Avatar */}
          <div
            style={{
              width: 80,
              height: 80,
              borderRadius: "50%",
              flexShrink: 0,
              overflow: "hidden",
              background: avatarBg,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {avatarUrl ? (
              <Img src={avatarUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            ) : (
              <span
                style={{
                  color: "#FFFFFF",
                  fontSize: 36,
                  fontWeight: 700,
                  fontFamily: primaryFont,
                }}
              >
                {avatarLetter}
              </span>
            )}
          </div>

          {/* Name + handle column */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* Author row with verified badge */}
            <div style={{ display: "flex", alignItems: "center" }}>
              <span
                style={{
                  color: textColor,
                  fontSize: 32,
                  fontWeight: 700,
                  fontFamily: primaryFont,
                  lineHeight: 1.2,
                }}
              >
                {author}
              </span>
              {verified && <VerifiedIcon />}
            </div>
            {/* Handle */}
            <div
              style={{
                color: secondaryColor,
                fontSize: 26,
                fontFamily: primaryFont,
                lineHeight: 1.3,
                marginTop: 2,
              }}
            >
              @{handle}
            </div>
          </div>

          {/* Subscribe pill */}
          <div
            style={{
              border: `1px solid ${textColor}`,
              borderRadius: 9999,
              padding: "8px 16px",
              fontSize: 22,
              fontWeight: 600,
              color: textColor,
              fontFamily: primaryFont,
              flexShrink: 0,
              whiteSpace: "nowrap",
            }}
          >
            Subscribe
          </div>
        </div>

        {/* Tweet body */}
        <div
          style={{
            color: textColor,
            fontSize: 32,
            lineHeight: 1.4,
            fontFamily: primaryFont,
            marginTop: 16,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {text}
        </div>
      </div>
    </AbsoluteFill>
  );
};
