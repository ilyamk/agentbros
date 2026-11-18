import React from "react";
import { z } from "zod";
import { useCurrentFrame } from "remotion";
import { WindowFrame } from "../../ui";
import { typedCount, typingSchedule } from "../../kinetic-math";
import { progress } from "../../timing";
import { Icon, Stage, uiFont, useFormat } from "./kit";
import { geistMono } from "./fonts";

export const codeEditorSchema = z.object({
  fileName: z.string(),
  /** Code already on screen when the shot opens. */
  prefix: z.string(),
  /** Code typed live after the prefix. */
  typed: z.string(),
  /** Frame typing starts. */
  typeAt: z.number().int().min(0),
  /** Mean frames per character; 0.6 reads as a fast, confident typist. */
  pace: z.number().min(0.1),
  accent: z.string(),
  /** Status line shown once typing has finished; empty hides it. */
  doneMessage: z.string(),
  /** Light (GitHub light syntax) or dark editor; defaults to dark. */
  tone: z.enum(["light", "dark"]).optional(),
});

export type CodeEditorProps = z.infer<typeof codeEditorSchema>;

const PALETTE = {
  keyword: "#C792EA",
  string: "#A5E07A",
  comment: "#5C6478",
  number: "#F7A76C",
  fn: "#82AAFF",
  type: "#FFCB6B",
  punct: "#89DDFF",
  plain: "#D6DAE4",
};
const LIGHT_PALETTE: typeof PALETTE = {
  keyword: "#CF222E",
  string: "#0A3069",
  comment: "#6E7781",
  number: "#0550AE",
  fn: "#8250DF",
  type: "#953800",
  punct: "#57606A",
  plain: "#1F2328",
};
type Kind = keyof typeof PALETTE;

const EDITOR = {
  dark: {
    ground: "#0A0A0A",
    bg: "#0E0E10",
    side: "#0B0B0D",
    line: "rgba(255,255,255,0.07)",
    text: "#E8EBF2",
    muted: "rgba(214,218,228,0.55)",
    faint: "rgba(214,218,228,0.3)",
    active: "rgba(255,255,255,0.06)",
    current: "rgba(255,255,255,0.035)",
    ok: "#4ADE9B",
  },
  light: {
    ground: "#EEF0F3",
    bg: "#FFFFFF",
    side: "#F6F8FA",
    line: "#E5E7EB",
    text: "#1F2328",
    muted: "#57606A",
    faint: "#A0A7B0",
    active: "rgba(10,10,10,0.06)",
    current: "rgba(10,10,10,0.03)",
    ok: "#16A34A",
  },
};

const KEYWORDS = new Set(
  "const let var function return if else for while await async import from export default new type interface extends class of in true false null undefined try catch throw".split(
    " ",
  ),
);

/** Splits code into coloured tokens; enough grammar for TypeScript, Python and shell snippets. */
export const tokenise = (code: string): { text: string; kind: Kind }[] => {
  const re =
    /(\/\/[^\n]*|#[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`]*`)|(\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)|([{}()[\];,.:=<>+\-*/!?&|]+)|(\s+|.)/g;
  const out: { text: string; kind: Kind }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const [text, comment, str, num, word, punct] = m;
    let kind: Kind = "plain";
    if (comment) kind = "comment";
    else if (str) kind = "string";
    else if (num) kind = "number";
    else if (word)
      kind = KEYWORDS.has(word)
        ? "keyword"
        : code[re.lastIndex] === "("
          ? "fn"
          : /^[A-Z]/.test(word)
            ? "type"
            : "plain";
    else if (punct) kind = "punct";
    out.push({ text, kind });
  }
  return out;
};

/** An editor window with tabs, gutter and file tree; code types in with syntax colour, a blinking caret and a status line. */
export const CodeEditor: React.FC<CodeEditorProps> = ({
  fileName,
  prefix,
  typed,
  typeAt,
  pace,
  accent,
  doneMessage,
  tone = "dark",
}) => {
  const e = EDITOR[tone];
  const palette = tone === "light" ? LIGHT_PALETTE : PALETTE;
  const frame = useCurrentFrame();
  const { width, height, portrait } = useFormat();
  const schedule = typingSchedule(typed, { at: typeAt, seed: fileName, pace });
  const count = typedCount(frame, schedule);
  const full = prefix + typed;
  const visible = prefix.length + count;
  const doneAt = (schedule.at(-1) ?? typeAt) + 6;
  const done = progress(frame, doneAt, 16);
  const typing = count > 0 && count < typed.length && frame - (schedule[count - 1] ?? 0) < 8;
  const caretOn = typing || Math.floor(frame / 16) % 2 === 0;

  const winW = width + 4;
  const winH = portrait ? 1200 : height + 4;
  const fontSize = portrait ? 26 : 30;
  const lineH = fontSize * 1.65;
  const sidebar = portrait ? 0 : winW * 0.18;

  const tokens = tokenise(full);
  let used = 0;
  const spans: React.ReactNode[] = [];
  for (let i = 0; i < tokens.length && used < visible; i++) {
    const t = tokens[i]!;
    const take = Math.min(t.text.length, visible - used);
    spans.push(
      <span key={i} style={{ color: palette[t.kind], fontStyle: t.kind === "comment" ? "italic" : undefined }}>
        {t.text.slice(0, take)}
      </span>,
    );
    used += take;
  }
  const shown = full.slice(0, visible);
  const lines = shown.split("\n").length;
  const caretLine = lines - 1;
  const totalLines = Math.max(lines, full.split("\n").length);
  const visibleRows = Math.floor((winH - 44 - 46 - 40) / lineH);
  const scroll = Math.max(0, caretLine - visibleRows + 3) * lineH;

  const mono = geistMono;
  const files = ["app", "api", "billing.ts", "invoices.ts", "payouts.ts", "lib", "db.ts", "queue.ts", "package.json"];

  return (
    <Stage ground={e.ground}>
      <div style={{ position: "absolute", left: -2, top: portrait ? 150 : -2 }}>
        <div>
          <WindowFrame
            width={winW}
            height={winH}
            title={`${fileName} — lumen`}
            tone={tone}
            fontFamily={uiFont}
            style={{ backgroundColor: e.bg, borderRadius: 0, boxShadow: `0 0 0 1px ${e.line}` }}
          >
            <div style={{ position: "absolute", inset: 0, display: "flex", fontFamily: uiFont }}>
              {sidebar > 0 ? (
                <div
                  style={{
                    width: sidebar,
                    borderRight: `1px solid ${e.line}`,
                    background: e.side,
                    padding: "14px 10px",
                    fontSize: fontSize * 0.78,
                    color: e.muted,
                  }}
                >
                  <div
                    style={{
                      fontSize: fontSize * 0.62,
                      letterSpacing: 1,
                      textTransform: "uppercase",
                      padding: "0 8px 12px",
                      color: e.faint,
                    }}
                  >
                    Explorer
                  </div>
                  {files.map((f) => {
                    const folder = !f.includes(".");
                    const active = f === fileName;
                    return (
                      <div
                        key={f}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          padding: `${fontSize * 0.28}px 8px`,
                          paddingLeft: folder ? 8 : 26,
                          borderRadius: 6,
                          background: active ? e.active : undefined,
                          color: active ? e.text : undefined,
                        }}
                      >
                        <Icon
                          name={folder ? "folder" : "layers"}
                          size={fontSize * 0.8}
                          color={folder ? e.muted : active ? e.text : e.faint}
                        />
                        {f}
                      </div>
                    );
                  })}
                </div>
              ) : null}
              <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
                <div
                  style={{
                    height: 46,
                    display: "flex",
                    alignItems: "flex-end",
                    borderBottom: `1px solid ${e.line}`,
                    background: e.side,
                    fontSize: fontSize * 0.75,
                  }}
                >
                  {[fileName, "payouts.ts"]
                    .filter((v, i, a) => a.indexOf(v) === i)
                    .map((tab, i) => (
                      <div
                        key={tab}
                        style={{
                          padding: "0 18px",
                          height: 40,
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          color: i === 0 ? e.text : e.muted,
                          background: i === 0 ? e.bg : undefined,
                          borderTop: i === 0 ? `2px solid ${accent}` : "2px solid transparent",
                        }}
                      >
                        {tab}
                        {i === 0 && count > 0 && done < 1 ? (
                          <span style={{ width: 8, height: 8, borderRadius: 4, background: e.muted }} />
                        ) : null}
                      </div>
                    ))}
                </div>
                <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      right: 0,
                      top: 16 - scroll,
                      display: "flex",
                      fontFamily: mono,
                      fontSize,
                      lineHeight: `${lineH}px`,
                    }}
                  >
                    <div
                      style={{
                        width: fontSize * 3.2,
                        textAlign: "right",
                        paddingRight: fontSize * 1.1,
                        color: e.faint,
                        userSelect: "none",
                      }}
                    >
                      {Array.from({ length: totalLines }, (_, i) => (
                        <div key={i} style={{ color: i === caretLine ? e.muted : undefined }}>
                          {i + 1}
                        </div>
                      ))}
                    </div>
                    <div style={{ position: "relative", flex: 1 }}>
                      <div
                        style={{
                          position: "absolute",
                          left: -fontSize * 4.3,
                          right: 0,
                          top: caretLine * lineH,
                          height: lineH,
                          background: e.current,
                        }}
                      />
                      <pre style={{ margin: 0, fontFamily: mono, whiteSpace: "pre", position: "relative" }}>
                        {spans}
                        <span
                          style={{
                            display: "inline-block",
                            width: 0,
                            height: lineH,
                            verticalAlign: "top",
                            position: "relative",
                          }}
                        >
                          <span
                            style={{
                              position: "absolute",
                              left: 0,
                              top: lineH * 0.14,
                              width: Math.max(2, fontSize * 0.1),
                              height: lineH * 0.72,
                              background: accent,
                              opacity: caretOn ? 1 : 0,
                            }}
                          />
                        </span>
                      </pre>
                    </div>
                  </div>
                </div>
                <div
                  style={{
                    height: 40,
                    display: "flex",
                    alignItems: "center",
                    gap: 18,
                    padding: "0 16px",
                    borderTop: `1px solid ${e.line}`,
                    background: e.side,
                    fontSize: fontSize * 0.68,
                    color: e.muted,
                  }}
                >
                  <span>TypeScript</span>
                  <span>
                    Ln {caretLine + 1}, Col {(shown.split("\n").at(-1)?.length ?? 0) + 1}
                  </span>
                  {doneMessage ? (
                    <span
                      style={{
                        marginLeft: "auto",
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        color: e.ok,
                        opacity: done,
                        transform: `translateY(${(1 - done) * 8}px)`,
                      }}
                    >
                      <Icon name="check" size={fontSize * 0.75} color={e.ok} stroke={2.4} />
                      {doneMessage}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
          </WindowFrame>
        </div>
      </div>
    </Stage>
  );
};
