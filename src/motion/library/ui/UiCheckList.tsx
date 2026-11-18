import React from "react";
import { z } from "zod";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { progress } from "../../timing";
import { geist, Ground, surface, useUnit } from "./surface";
import { CHECK_SETTLE, checkSchedule, clockSweep, easeWindow, tickDraw } from "./ui-plan";

export const uiCheckListSchema = z.object({
  tone: z.enum(["light", "dark"]),
  accent: z.string(),
  /** Small grey line over the rows; empty hides it. */
  heading: z.string(),
  rows: z
    .array(z.object({ title: z.string(), body: z.string().optional() }))
    .min(1)
    .max(12),
  /** Frame the card starts to settle (8 f at 30 fps). */
  start: z.number().int().min(0),
  /** Frame the first circle starts to fill. */
  checkAt: z.number().int().min(0),
  /** Frames between successive rows' fills; the last repeats (nexaa: 9, then 7 at 24 fps, so 11 and 9 at 30). */
  gaps: z.array(z.number().int().min(1)).min(1),
  /** Frames a circle takes to fill with the clock wipe (3-4). */
  fill: z.number().int().min(1),
  /** Rows left unchecked at the end, counted from the bottom (motionfly: the last two stay grey). */
  leaveOpen: z.number().int().min(0).optional(),
  /** `empty` circles (nexaa) or `spinner` rings that turn until they fill (motionfly). */
  pending: z.enum(["empty", "spinner"]),
  /** `all` rows are there when the card lands; `append` adds each row a few frames before its fill. */
  arrival: z.enum(["all", "append"]),
  /** Rows the card shows at once; more scroll up so the newest stays in view. */
  visibleRows: z.number().int().min(1).optional(),
  /** Fill of the checked circle; absent uses the tone's primary (black on light). */
  checkColour: z.string().optional(),
  /** `preview` paints the tone's ground; `transparent` lays the card over any layer. */
  ground: z.enum(["preview", "transparent"]),
});

export type UiCheckListProps = z.infer<typeof uiCheckListSchema>;

export const checkListTiming = (p: Pick<UiCheckListProps, "rows" | "checkAt" | "gaps" | "leaveOpen">) => {
  const fills = checkSchedule(p.rows.length, p.checkAt, p.gaps);
  const open = p.leaveOpen ?? 0;
  return {
    fills: fills.map((f, i) => (i >= p.rows.length - open ? Number.POSITIVE_INFINITY : f)),
    appear: fills.map((f) => f - 8),
  };
};

export const uiCheckListCues = (p: UiCheckListProps) => {
  const t = checkListTiming(p);
  return [
    {
      frame: p.start,
      kind: "land" as const,
      sfx: "whoosh" as const,
      weight: "support" as const,
      label: "card settles",
    },
    ...t.fills.flatMap((f, i) =>
      Number.isFinite(f)
        ? [
            {
              frame: f + p.fill - 1,
              kind: "hit" as const,
              sfx: "tick" as const,
              weight: (i === 0 ? "hero" : "support") as "hero" | "support",
              label: `row ${i + 1} ticked`,
            },
          ]
        : [],
    ),
  ];
};

const ROW_H = 118;

const CheckCircle: React.FC<{
  frame: number;
  fillAt: number;
  fill: number;
  size: number;
  ink: string;
  ring: string;
  pending: "empty" | "spinner";
}> = ({ frame, fillAt, fill, size, ink, ring, pending }) => {
  const sweep = clockSweep(frame, fillAt, fill);
  const tick = tickDraw(frame, fillAt, fill);
  const stroke = Math.max(2, size * 0.08);
  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      {sweep < 360 ? (
        pending === "spinner" && sweep <= 0 ? (
          <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            style={{ position: "absolute", inset: 0, transform: `rotate(${frame * 18}deg)` }}
          >
            <circle cx={12} cy={12} r={10} fill="none" stroke={ring} strokeWidth={2} />
            <path d="M12 2a10 10 0 0 1 10 10" fill="none" stroke={ink} strokeWidth={2} strokeLinecap="round" />
          </svg>
        ) : (
          <div
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: size,
              border: `${stroke}px solid ${ring}`,
              boxSizing: "border-box",
            }}
          />
        )
      ) : null}
      {sweep > 0 ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: size,
            background: `conic-gradient(${ink} ${sweep}deg, transparent ${sweep}deg)`,
          }}
        />
      ) : null}
      {tick > 0 ? (
        <svg width={size} height={size} viewBox="0 0 24 24" style={{ position: "absolute", inset: 0 }}>
          <path
            d="M7 12.5l3.2 3.2L17 9"
            fill="none"
            stroke="#FFFFFF"
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
            pathLength={1}
            strokeDasharray={1}
            strokeDashoffset={1 - tick}
          />
        </svg>
      ) : null}
    </div>
  );
};

/** A card of rows whose check circles fill with a clock wipe and draw a tick on a staggered schedule. */
export const UiCheckList: React.FC<UiCheckListProps> = (p) => {
  const frame = useCurrentFrame();
  const { width, height, portrait, u } = useUnit();
  const s = surface(p.tone, p.accent);
  const t = checkListTiming(p);
  const W = width / u;
  const H = height / u;
  const cardW = portrait ? W - 100 : Math.min(W * 0.6, 1300);
  const visible = Math.min(p.rows.length, p.visibleRows ?? p.rows.length);
  const headH = p.heading ? 70 : 0;
  const cardH = 56 + headH + visible * ROW_H + 40;
  const settle = easeWindow(frame, p.start, CHECK_SETTLE, "power2.out");
  const ink = p.checkColour ?? s.primary;
  // The list scrolls one row at a time, over 8 f, each time a row past the fold arrives (append) or fills, so the newest stays in the card.
  const fillsAll = checkSchedule(p.rows.length, p.checkAt, p.gaps);
  const scroll = p.rows.reduce(
    (sum, _, i) =>
      i < visible ? sum : sum + progress(frame, p.arrival === "append" ? t.appear[i]! : fillsAll[i]! - 8, 8, "expoOut"),
    0,
  );
  const card = (
    <div
      style={{
        position: "absolute",
        left: (W - cardW) / 2,
        top: (H - cardH) / 2 + (1 - settle) * 60,
        width: cardW,
        height: cardH,
        opacity: settle,
        borderRadius: 32,
        background: s.card,
        boxShadow: s.shadow.lg,
        border: `1px solid ${s.border}`,
        overflow: "hidden",
      }}
    >
      {p.heading ? (
        <div style={{ position: "absolute", left: 56, top: 44, fontSize: 24, color: s.mutedText }}>{p.heading}</div>
      ) : null}
      <div style={{ position: "absolute", left: 56, right: 56, top: 40 + headH, bottom: 40, overflow: "hidden" }}>
        {p.rows.map((row, i) => {
          const appear = p.arrival === "append" ? progress(frame, t.appear[i]!, 6, "expoOut") : 1;
          if (appear <= 0) return null;
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: (i - scroll) * ROW_H,
                height: ROW_H,
                display: "flex",
                alignItems: "center",
                gap: 32,
                opacity: appear,
                transform: `translateY(${(1 - appear) * 16}px)`,
              }}
            >
              <CheckCircle
                frame={frame}
                fillAt={t.fills[i]!}
                fill={p.fill}
                size={46}
                ink={ink}
                ring={s.faintText}
                pending={p.pending}
              />
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 34,
                    fontWeight: 500,
                    letterSpacing: "-0.01em",
                    color: s.text,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {row.title}
                </div>
                {row.body ? (
                  <div
                    style={{
                      fontSize: 24,
                      color: s.mutedText,
                      marginTop: 4,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {row.body}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
  const scaled = (
    <div style={{ position: "absolute", inset: 0, transform: `scale(${u})`, transformOrigin: "0 0" }}>{card}</div>
  );
  return p.ground === "transparent" ? (
    <AbsoluteFill style={{ fontFamily: geist, color: s.text }}>{scaled}</AbsoluteFill>
  ) : (
    <Ground s={s}>{scaled}</Ground>
  );
};
