import React from "react";
import { z } from "zod";
import { random, useCurrentFrame } from "remotion";
import { VelocityBlur } from "../../fx";
import { progress } from "../../timing";
import { Icon } from "./kit";
import { sheenAt } from "./ui-plan";
import {
  Badge,
  Ground,
  pushSchema,
  pushStyle,
  SCROLL_EASES,
  scrollEaseSchema,
  surface,
  useUnit,
  Window,
} from "./surface";

const rowSchema = z.object({ name: z.string(), title: z.string(), company: z.string(), email: z.string() });

export const dataTableSchema = z.object({
  tone: z.enum(["light", "dark"]),
  accent: z.string(),
  /** Small grey line over the summary, e.g. "Worked for 18s". */
  label: z.string(),
  summary: z.string(),
  columns: z.tuple([z.string(), z.string(), z.string(), z.string()]),
  /** Rows shown first; the scroll continues through seeded rows built from the same companies. */
  rows: z.array(rowSchema).min(3),
  /** Total rows in the scrolled list, including `rows`. */
  total: z.number().int().min(10),
  /** Row the scroll lands on and highlights (index into the full list). */
  target: z.number().int().min(0),
  /** The landed row's name, shown instead of a seeded one. */
  targetName: z.string(),
  start: z.number().int().min(0),
  /** Frames between row arrivals. */
  rowStep: z.number().min(0.5),
  scrollAt: z.number().int().min(0),
  scrollFrames: z.number().int().min(6),
  /** "people" (default) seeds the rows past `rows` with names and titles; "rows" shows only `rows`, so give the whole list. */
  fill: z.enum(["people", "rows"]).optional(),
  /** Window tabs; absent or empty shows `title` (or nothing). */
  tabs: z.array(z.string()).optional(),
  title: z.string().optional(),
  /** Easing of the scroll; "inOut" by default. */
  scrollEase: scrollEaseSchema.optional(),
  /** Optional camera push into the window, e.g. ending on `scrollAt` so the scroll reads closer. */
  push: pushSchema.optional(),
  /** Badge on the landed row; absent shows "Match", empty hides it. */
  badge: z.string().optional(),
  /**
   * One row (index into the full list) that stays still in the landing slot, a little wider, raised and outlined in the
   * accent, while the rest of the list streams under it (polymarket's ranking). Absent: no pinned row.
   */
  pinnedRow: z.number().int().min(0).optional(),
  /** A soft light band that moves along one row (index into the full list; the pinned row if pinned) from `at` over `frames`, power2.out. */
  rowSheen: z
    .object({ row: z.number().int().min(0), at: z.number().int().min(0), frames: z.number().int().min(4) })
    .optional(),
});

export type DataTableProps = z.infer<typeof dataTableSchema>;

const FIRST = [
  "Amara",
  "Luis",
  "Priya",
  "Jonas",
  "Mei",
  "Tomás",
  "Elena",
  "Kofi",
  "Sara",
  "Noah",
  "Ines",
  "Ravi",
  "Hana",
  "Owen",
  "Lea",
  "Marco",
  "Yuki",
  "Dara",
  "Felix",
  "Nadia",
];
const LAST = [
  "Okafor",
  "Ortega",
  "Raman",
  "Weber",
  "Chen",
  "Silva",
  "Novak",
  "Mensah",
  "Lund",
  "Fischer",
  "Costa",
  "Iyer",
  "Sato",
  "Byrne",
  "Moreau",
  "Rossi",
  "Kato",
  "Walsh",
  "Berg",
  "Haddad",
];
const TITLES = ["Product designer", "Engineer", "Editor", "Researcher", "Producer", "Analyst"];

export const tableRow = (p: DataTableProps, i: number) => {
  if (p.fill === "rows")
    return i === p.target && p.targetName
      ? { ...p.rows[i % p.rows.length]!, name: p.targetName }
      : p.rows[i % p.rows.length]!;
  if (i < p.rows.length) return p.rows[i]!;
  const first = FIRST[Math.floor(random(`dt-f-${i}`) * FIRST.length)]!;
  const last = i === p.target ? "" : LAST[Math.floor(random(`dt-l-${i}`) * LAST.length)]!;
  const base = p.rows[i % p.rows.length]!;
  const name = i === p.target ? p.targetName : `${first} ${last}`;
  const domain = base.email.split("@")[1] ?? "example.com";
  return {
    name,
    title: TITLES[Math.floor(random(`dt-t-${i}`) * TITLES.length)]!,
    company: base.company,
    email: `${name.split(" ")[0]!.toLowerCase()}@${domain}`,
  };
};

export const dataTableCues = (p: DataTableProps) => {
  const land = p.scrollAt + p.scrollFrames;
  return [
    ...(p.push
      ? [
          {
            frame: p.push.at,
            kind: "hit" as const,
            sfx: "none" as const,
            weight: "support" as const,
            label: "camera push",
          },
        ]
      : []),
    { frame: p.start, kind: "reveal" as const, sfx: "tick" as const, weight: "support" as const, label: "rows fill" },
    {
      frame: p.scrollAt,
      kind: "hit" as const,
      sfx: "whoosh" as const,
      weight: "support" as const,
      label: "fast scroll",
    },
    { frame: land, kind: "stop" as const, sfx: "tick" as const, weight: "support" as const, label: "scroll lands" },
    {
      frame: land + 6,
      kind: "reveal" as const,
      sfx: "pop" as const,
      weight: "hero" as const,
      label: "row highlighted",
    },
    ...(p.rowSheen
      ? [
          {
            frame: p.rowSheen.at,
            kind: "reveal" as const,
            sfx: "glass" as const,
            weight: "support" as const,
            label: "sheen along the row",
          },
        ]
      : []),
  ];
};

const ROW = 84;

/** A real results table at reading scale: rows fill in, a fast scroll smears vertically, it lands and one row lights up. */
export const DataTable: React.FC<DataTableProps> = (p) => {
  const frame = useCurrentFrame();
  const { width, height, portrait, u } = useUnit();
  const s = surface(p.tone, p.accent);
  const W = width / u;
  const H = height / u;
  const winW = portrait ? W - 60 : W - 160;
  const winH = portrait ? H - 260 : H - 100;
  const bodyTop = portrait ? 300 : 236;
  const bodyH = winH - 64 - bodyTop;
  const landSlot = Math.max(1, Math.floor(bodyH / ROW / 2) - 1);
  const maxOffset = Math.max(0, (p.target - landSlot) * ROW);
  const total = p.fill === "rows" ? p.rows.length : p.total;
  const offsetAt = (f: number) =>
    maxOffset * progress(f, p.scrollAt, p.scrollFrames, SCROLL_EASES[p.scrollEase ?? "inOut"]);
  const offset = offsetAt(frame);
  const speed = offsetAt(frame + 1) - offset;
  const land = p.scrollAt + p.scrollFrames;
  const lit = progress(frame, land + 6, 10, "expoOut");
  const rise = progress(frame, 0, 20, "expoOut");
  const first = Math.max(0, Math.floor(offset / ROW) - 1);
  const count = Math.ceil(bodyH / ROW) + 3;
  const cols = portrait ? [0.62, 0.38] : [0.24, 0.24, 0.2, 0.32];
  const pad = 40;
  const header = portrait ? [p.columns[0], p.columns[2]] : p.columns;

  return (
    <Ground s={s}>
      <div style={{ position: "absolute", inset: 0, ...pushStyle(frame, p.push) }}>
        <div style={{ position: "absolute", inset: 0, transform: `scale(${u})`, transformOrigin: "0 0" }}>
          <Window
            s={s}
            width={winW}
            height={winH}
            tabs={p.tabs?.length ? p.tabs : undefined}
            title={p.title}
            style={{ left: (W - winW) / 2, top: (H - winH) / 2 + (1 - rise) * 40, opacity: rise }}
          >
            <div style={{ position: "absolute", left: pad, right: pad, top: 34 }}>
              <div style={{ fontSize: 24, color: s.mutedText, marginBottom: 12 }}>{p.label}</div>
              <div
                style={{
                  fontSize: portrait ? 34 : 34,
                  fontWeight: 500,
                  lineHeight: 1.35,
                  letterSpacing: "-0.015em",
                  maxWidth: 1400,
                }}
              >
                {p.summary}
              </div>
            </div>
            <div
              style={{
                position: "absolute",
                left: pad,
                right: pad,
                top: bodyTop - 58,
                height: 58,
                display: "flex",
                alignItems: "center",
                fontSize: 24,
                fontWeight: 600,
                color: s.mutedText,
                borderBottom: `1px solid ${s.border}`,
              }}
            >
              {header.map((c, i) => (
                <div key={c} style={{ width: `${cols[i]! * 100}%` }}>
                  {c}
                </div>
              ))}
            </div>
            <div style={{ position: "absolute", left: 0, right: 0, top: bodyTop, height: bodyH, overflow: "hidden" }}>
              <VelocityBlur axis="y" speed={speed} shutter={0.22} maxBlur={60}>
                {Array.from({ length: count }, (_, k) => {
                  const i = first + k;
                  if (i >= total || i === p.pinnedRow) return null;
                  const r = tableRow(p, i);
                  const arrive = progress(frame, p.start + Math.min(i, 14) * p.rowStep, 12, "expoOut");
                  const isTarget = i === p.target;
                  const glow = isTarget ? lit : 0;
                  const cells = portrait ? [r.name, r.company] : [r.name, r.title, r.company, r.email];
                  return (
                    <div
                      key={i}
                      style={{
                        position: "absolute",
                        left: pad - 16,
                        right: pad - 16,
                        top: i * ROW - offset,
                        height: ROW,
                        padding: "0 16px",
                        display: "flex",
                        alignItems: "center",
                        fontSize: 28,
                        borderBottom: `1px solid ${s.border}`,
                        opacity: arrive,
                        transform: `translateY(${(1 - arrive) * 14}px)`,
                        background: glow > 0 ? s.accentSoft : undefined,
                        borderRadius: glow > 0 ? 12 : 0,
                        boxShadow: glow > 0 ? `inset 4px 0 0 ${p.accent}` : undefined,
                      }}
                    >
                      {cells.map((c, ci) => (
                        <div
                          key={ci}
                          style={{
                            width: `${cols[ci]! * 100}%`,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            paddingRight: 16,
                            color: ci === 0 ? s.text : ci === cells.length - 1 && !portrait ? p.accent : s.mutedText,
                            fontWeight: ci === 0 ? 500 : 400,
                            display: "flex",
                            alignItems: "center",
                            gap: 12,
                          }}
                        >
                          {c}
                          {ci === 0 && glow > 0.05 && p.badge !== "" ? (
                            <span
                              style={{ opacity: glow, transform: `scale(${0.8 + 0.2 * glow})`, display: "inline-flex" }}
                            >
                              <Badge s={s} tone="accent" size={20}>
                                <Icon name="check" size={18} color={p.accent} stroke={2.6} />
                                {p.badge ?? "Match"}
                              </Badge>
                            </span>
                          ) : null}
                        </div>
                      ))}
                      {p.rowSheen && p.rowSheen.row === i && p.pinnedRow === undefined ? (
                        <Sheen frame={frame} sheen={p.rowSheen} colour={s.accentSoft.replace(/[\d.]+\)$/, "0.22)")} />
                      ) : null}
                    </div>
                  );
                })}
              </VelocityBlur>
              {p.pinnedRow !== undefined && p.pinnedRow < total ? (
                <PinnedRow
                  p={p}
                  s={s}
                  index={p.pinnedRow}
                  top={landSlot * ROW}
                  pad={pad}
                  cols={cols}
                  portrait={portrait}
                  frame={frame}
                  arrive={progress(frame, p.start, 12, "expoOut")}
                />
              ) : null}
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: 90,
                  background: `linear-gradient(transparent, ${s.background})`,
                }}
              />
            </div>
          </Window>
        </div>
      </div>
    </Ground>
  );
};

const Sheen: React.FC<{ frame: number; sheen: { at: number; frames: number }; colour: string }> = ({
  frame,
  sheen,
  colour,
}) => {
  const st = sheenAt(frame, sheen.at, sheen.frames);
  if (!st.visible) return null;
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", borderRadius: 12, pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          width: "28%",
          left: `${-28 + st.x * 128}%`,
          background: `linear-gradient(90deg, transparent, ${colour}, transparent)`,
        }}
      />
    </div>
  );
};

/** The pinned row: still in its slot, 12 px wider each side, raised and outlined, above the streaming list. */
const PinnedRow: React.FC<{
  p: DataTableProps;
  s: ReturnType<typeof surface>;
  index: number;
  top: number;
  pad: number;
  cols: number[];
  portrait: boolean;
  frame: number;
  arrive: number;
}> = ({ p, s, index, top, pad, cols, portrait, frame, arrive }) => {
  const r = tableRow(p, index);
  const cells = portrait ? [r.name, r.company] : [r.name, r.title, r.company, r.email];
  return (
    <div
      style={{
        position: "absolute",
        left: pad - 28,
        right: pad - 28,
        top,
        height: ROW,
        padding: "0 28px",
        display: "flex",
        alignItems: "center",
        fontSize: 28,
        borderRadius: 14,
        background: s.card,
        border: `1.5px solid ${p.accent}`,
        boxShadow: s.shadow.lg,
        opacity: arrive,
        zIndex: 2,
        overflow: "hidden",
      }}
    >
      {cells.map((c, ci) => (
        <div
          key={ci}
          style={{
            width: `${cols[ci]! * 100}%`,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            paddingRight: 16,
            color: ci === 0 ? s.text : ci === cells.length - 1 && !portrait ? p.accent : s.mutedText,
            fontWeight: ci === 0 ? 600 : 400,
          }}
        >
          {c}
        </div>
      ))}
      {p.rowSheen && p.rowSheen.row === index ? (
        <Sheen frame={frame} sheen={p.rowSheen} colour={s.accentSoft.replace(/[\d.]+\)$/, "0.22)")} />
      ) : null}
    </div>
  );
};
