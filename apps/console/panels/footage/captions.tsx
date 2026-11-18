/**
 * Footage panel: the caption style. The style on the recut's timeline and the one asked for, whether the captions are
 * placed clear of faces and interface, and a sketch of each style footage:next offers (CSS only: the console bundles no
 * images; the render shows the real captions). The choice itself is answered in the chat (footage:next's own flag).
 */
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import type { PanelProps } from "../registry";
import { Block, Facts } from "../film/shared";
import { FootageStepHeader, NothingYet } from "./shared";
import { material } from "./steps";

/** One sketch per style id (src/lib/footage/next.ts CAPTION_CHOICES); unknown ids get the plain sketch. */
const SKETCH: Record<string, { box?: string; word?: string; key?: string; text?: string; upper?: boolean }> = {
  "outline-pop": { text: "font-black text-white [-webkit-text-stroke:1.5px_black] [paint-order:stroke_fill]" },
  "italic-shadow": { text: "font-bold italic text-[#ffd400] [text-shadow:2px_2px_0_#000]" },
  "keyword-colour": { text: "font-bold text-white", key: "text-[#ffd400]" },
  "word-box": { text: "font-bold text-white", key: "rounded bg-[#6c5ce7] px-1" },
  "line-box": { text: "font-semibold text-white", box: "rounded bg-black/75 px-2 py-0.5" },
  "chunky-stack": { text: "font-black leading-none text-white", upper: true },
  "editorial-mix": { text: "font-serif text-white", key: "text-xl font-bold italic" },
  "clean-sentence": { text: "font-medium text-white", box: "px-1" },
  "single-punch": { text: "text-xl font-black text-white", upper: true },
  typewriter: { text: "font-mono text-white", box: "bg-black/60 px-1" },
  karaoke: { text: "font-bold text-white/60", key: "text-white" },
};

export function CaptionSketch({ style, sample }: { style: string; sample: string }) {
  const { d, f } = useI18n();
  const sketch = SKETCH[style] ?? { text: "font-semibold text-white" };
  const words = style === "single-punch" ? [sample.split(" ").at(-1) ?? sample] : sample.split(" ");
  const key = words.length > 1 ? words.length - 1 : -1;
  return (
    <figure
      role="img"
      aria-label={f(d.footage.captions.preview, { style })}
      data-caption-style={style}
      className="flex aspect-video min-w-0 flex-col items-center justify-end rounded-md bg-gradient-to-b from-zinc-600 to-zinc-900 p-2"
    >
      <span
        className={cn(
          "max-w-full text-center text-sm break-words",
          sketch.box,
          sketch.text,
          sketch.upper && "uppercase",
        )}
      >
        {words.map((word, index) => (
          <span key={index}>
            <span className={cn(index === key && sketch.key)}>{word}</span>
            {index < words.length - 1 ? style === "chunky-stack" ? <br /> : " " : null}
          </span>
        ))}
      </span>
    </figure>
  );
}

export function CaptionsPanel({ view }: PanelProps) {
  const { d } = useI18n();
  const captions = material(view).captions;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <FootageStepHeader view={view} group="captions" />
      {captions ? (
        <>
          <Facts
            rows={[
              [d.footage.captions.current, captions.style ?? d.footage.captions.none],
              [d.footage.captions.wanted, captions.wanted ?? d.footage.captions.none],
              [d.footage.captions.placed, captions.placed ? d.footage.transcript.yes : d.footage.captions.notPlaced],
              ...(captions.uiZone ? ([[d.footage.captions.uiZone, captions.uiZone]] as [string, string][]) : []),
            ]}
          />
          <Block title={d.footage.captions.choices}>
            <p className="text-xs text-muted-foreground">{d.footage.captions.previewHint}</p>
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2">
              {captions.choices.map((style) => (
                <li
                  key={style}
                  aria-current={style === (captions.wanted ?? captions.style) ? "true" : undefined}
                  className={cn(
                    "flex min-w-0 flex-col gap-1 rounded-lg border p-1.5",
                    style === (captions.wanted ?? captions.style) && "border-primary ring-1 ring-primary",
                  )}
                >
                  <CaptionSketch style={style} sample={d.footage.captions.sample} />
                  <code className="truncate font-mono text-xs">{style}</code>
                </li>
              ))}
            </ul>
          </Block>
        </>
      ) : (
        <NothingYet />
      )}
    </div>
  );
}
