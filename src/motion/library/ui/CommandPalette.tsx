import React from "react";
import { z } from "zod";
import { useCurrentFrame } from "remotion";
import { progress } from "../../timing";
import { Icon } from "./kit";
import { Caret, Ground, Kbd, surface, typingEnd, useTyping, useUnit, Window } from "./surface";

const itemSchema = z.object({ icon: z.string(), label: z.string(), group: z.string(), shortcut: z.string() });

export const commandPaletteSchema = z.object({
  tone: z.enum(["light", "dark"]),
  accent: z.string(),
  placeholder: z.string(),
  query: z.string(),
  items: z.array(itemSchema).min(2),
  /** Label of the item chosen with Enter; must contain the query to survive the filter. */
  choose: z.string(),
  /** Toast after Enter. */
  confirmation: z.string(),
  openAt: z.number().int().min(0),
  typeAt: z.number().int().min(0),
  pace: z.number().min(0.3),
});

export type CommandPaletteProps = z.infer<typeof commandPaletteSchema>;

const SEED = "command-palette";

export const commandPaletteTiming = (p: CommandPaletteProps) => {
  const typed = typingEnd(p.query, p.typeAt, p.pace, SEED);
  return { typed, enter: typed + 14 };
};

export const commandPaletteCues = (p: CommandPaletteProps) => {
  const t = commandPaletteTiming(p);
  return [
    {
      frame: p.openAt,
      kind: "reveal" as const,
      sfx: "pop" as const,
      weight: "support" as const,
      label: "palette opens",
    },
    { frame: p.typeAt, kind: "type" as const, sfx: "tick" as const, weight: "support" as const, label: "typing" },
    { frame: t.enter, kind: "click" as const, sfx: "click" as const, weight: "hero" as const, label: "enter" },
  ];
};

/** ⌘K palette over a dimmed app: it drops in, the query filters the list live, the chosen command runs and confirms. */
export const CommandPalette: React.FC<CommandPaletteProps> = (p) => {
  const frame = useCurrentFrame();
  const { width, height, portrait, u } = useUnit();
  const s = surface(p.tone, p.accent);
  const t = commandPaletteTiming(p);
  const typing = useTyping(p.query, p.typeAt, p.pace, SEED);
  const W = width / u;
  const H = height / u;
  const open = progress(frame, p.openAt, 12, "expoOut");
  const q = typing.shown.toLowerCase();
  const shown = p.items.filter((it) => it.label.toLowerCase().includes(q));
  const chosen = Math.max(
    0,
    shown.findIndex((it) => it.label === p.choose),
  );
  const sel = frame < p.typeAt ? 0 : chosen;
  const press = frame >= t.enter && frame < t.enter + 5;
  const closeP = progress(frame, t.enter + 6, 10, "expoIn");
  const toast = progress(frame, t.enter + 12, 14, "expoOut");
  const palW = portrait ? W - 80 : 1100;
  const groups = [...new Set(shown.map((it) => it.group))];
  let row = 0;

  return (
    <Ground s={s}>
      <div style={{ position: "absolute", inset: 0, transform: `scale(${u})`, transformOrigin: "0 0" }}>
        <Window
          s={s}
          width={W - 120}
          height={H - 100}
          title="Workspace"
          style={{ left: 60, top: 50, filter: `blur(${open * 3 * (1 - closeP)}px)` }}
        >
          <div style={{ padding: 48, display: "grid", gridTemplateColumns: portrait ? "1fr" : "1fr 1fr 1fr", gap: 24 }}>
            {Array.from({ length: portrait ? 4 : 6 }, (_, i) => (
              <div
                key={i}
                style={{
                  height: 220,
                  borderRadius: 18,
                  border: `1px solid ${s.border}`,
                  background: s.card,
                  padding: 28,
                }}
              >
                <div style={{ width: "40%", height: 18, borderRadius: 6, background: s.muted }} />
                <div style={{ width: "70%", height: 34, borderRadius: 8, background: s.muted, marginTop: 22 }} />
              </div>
            ))}
          </div>
        </Window>
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: s.tone === "light" ? "rgba(10,10,10,0.18)" : "rgba(0,0,0,0.5)",
            opacity: open * (1 - closeP),
          }}
        />
        {frame >= p.openAt && closeP < 1 ? (
          <div
            style={{
              position: "absolute",
              left: (W - palW) / 2,
              top: portrait ? 360 : 170,
              width: palW,
              borderRadius: 24,
              background: s.card,
              border: `1px solid ${s.border}`,
              boxShadow: s.shadow.lg,
              overflow: "hidden",
              opacity: open * (1 - closeP),
              transform: `scale(${0.96 + 0.04 * open - 0.02 * closeP})`,
            }}
          >
            <div
              style={{
                height: 96,
                display: "flex",
                alignItems: "center",
                gap: 20,
                padding: "0 32px",
                borderBottom: `1px solid ${s.border}`,
                fontSize: 36,
              }}
            >
              <Icon name="search" size={34} color={s.mutedText} stroke={2} />
              {typing.count ? <span>{typing.shown}</span> : <span style={{ color: s.faintText }}>{p.placeholder}</span>}
              <Caret frame={frame} lastKey={typing.lastKey} color={s.text} height={40} />
              <span style={{ marginLeft: "auto" }}>
                <Kbd s={s} size={20}>
                  esc
                </Kbd>
              </span>
            </div>
            <div style={{ padding: 12, minHeight: 200 }}>
              {groups.map((g) => (
                <div key={g}>
                  <div style={{ fontSize: 20, fontWeight: 500, color: s.mutedText, padding: "14px 20px 8px" }}>{g}</div>
                  {shown
                    .filter((it) => it.group === g)
                    .map((it) => {
                      const i = row++;
                      const active = i === sel;
                      return (
                        <div
                          key={it.label}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 20,
                            height: 72,
                            padding: "0 20px",
                            borderRadius: 14,
                            fontSize: 30,
                            background: active ? (press ? s.accentSoft : s.hover) : undefined,
                            color: active ? s.text : s.mutedText,
                            boxShadow: active && press ? `inset 0 0 0 2px ${p.accent}` : undefined,
                          }}
                        >
                          <Icon name={it.icon} size={30} color={active ? s.text : s.mutedText} stroke={1.9} />
                          {it.label}
                          <span style={{ marginLeft: "auto" }}>
                            <Kbd s={s} size={20}>
                              {it.shortcut}
                            </Kbd>
                          </span>
                        </div>
                      );
                    })}
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {toast > 0 ? (
          <div
            style={{
              position: "absolute",
              left: (W - 640) / 2,
              bottom: 110,
              width: 640,
              height: 92,
              borderRadius: 20,
              background: s.primary,
              color: s.primaryText,
              display: "flex",
              alignItems: "center",
              gap: 18,
              padding: "0 30px",
              fontSize: 30,
              fontWeight: 500,
              boxShadow: s.shadow.lg,
              opacity: toast,
              transform: `translateY(${(1 - toast) * 30}px)`,
            }}
          >
            <Icon name="check" size={30} color={s.primaryText} stroke={2.6} />
            {p.confirmation}
          </div>
        ) : null}
      </div>
    </Ground>
  );
};
